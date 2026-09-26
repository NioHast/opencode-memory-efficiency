#!/usr/bin/env bash
# storage-prune.sh — prune orphaned opencode filesystem bloat with a quarantine archive.
#
# Targets:
#   (a) storage/session_diff/*.json whose <session-id> (= basename without .json)
#       no longer exists in the DB `session` table.
#   (b) snapshot/<project_id>/ trees whose <project_id> no longer exists in the
#       DB `project` table. NOTE: snapshot dirs are keyed by PROJECT id.
#
# Modes (exactly one; default --dry-run):
#   --dry-run       Read-only. List orphans and estimated reclaim. Frees 0.
#   --apply         Quarantine every target (timestamped trash dir + MANIFEST.txt),
#                   THEN delete ONLY the manifest-listed paths.
#   --purge-trash   Remove $TRASH_ROOT/trash-* dirs older than PURGE_AFTER_DAYS.
#
# Safety:
#   * --apply REFUSES (exit 3, zero writes) while `pgrep -x opencode` is alive,
#     unless ALLOW_WHILE_RUNNING=1 (tests only).
#   * No deletion happens before a verified quarantine archive of the exact files.
#   * If the quarantine root is unwritable -> abort non-zero, delete NOTHING.
#   * Re-running --apply after a prune is a no-op.
#   * trash-*/ is excluded from every prune scan.
#
# Env overrides:
#   OPENCODE_HOME        default $HOME/.local/share/opencode
#   OPENCODE_DB          default $OPENCODE_HOME/opencode.db
#   TRASH_ROOT           default $OPENCODE_HOME   (quarantine lives at $TRASH_ROOT/trash-<ts>/)
#   PURGE_AFTER_DAYS     default 7
#   ALLOW_WHILE_RUNNING  default 0 (set 1 to override the running gate; tests only)
set -euo pipefail
export LC_ALL=C

OPENCODE_HOME="${OPENCODE_HOME:-$HOME/.local/share/opencode}"
OPENCODE_DB="${OPENCODE_DB:-$OPENCODE_HOME/opencode.db}"
TRASH_ROOT="${TRASH_ROOT:-$OPENCODE_HOME}"
PURGE_AFTER_DAYS="${PURGE_AFTER_DAYS:-7}"
ALLOW_WHILE_RUNNING="${ALLOW_WHILE_RUNNING:-0}"

SESSION_DIFF_DIR="$OPENCODE_HOME/storage/session_diff"
SNAPSHOT_DIR="$OPENCODE_HOME/snapshot"

MODE="dry-run"
TMPDIR_WORK=""
TRASH_DIR=""

log() { printf '%s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

cleanup() { [ -n "$TMPDIR_WORK" ] && rm -rf -- "$TMPDIR_WORK" || true; }
trap cleanup EXIT

usage() {
  cat <<'EOF'
Usage: storage-prune.sh [--dry-run | --apply | --purge-trash]

  --dry-run       (DEFAULT) list orphan session_diff files / snapshot project trees
  --apply         quarantine orphans then delete only manifest-listed paths
  --purge-trash   delete quarantine dirs older than PURGE_AFTER_DAYS

Env: OPENCODE_HOME, OPENCODE_DB, TRASH_ROOT, PURGE_AFTER_DAYS,
     ALLOW_WHILE_RUNNING=1 (permit --apply while opencode runs; tests only)
EOF
}

hash_file() { sha256sum -- "$1" | cut -d' ' -f1; }

# valid_ids <session|project> — print the id column from the read-only DB.
valid_ids() {
  local table="$1"
  python3 - "$OPENCODE_DB" "$table" <<'PY'
import sqlite3, sys
db, table = sys.argv[1], sys.argv[2]
if table not in ("session", "project"):
    raise SystemExit("invalid table: %r" % (table,))
con = sqlite3.connect("file:%s?mode=ro" % db, uri=True)
con.execute("PRAGMA query_only=ON")
try:
    for row in con.execute("SELECT id FROM " + table):
        if row[0] is not None:
            print(row[0])
finally:
    con.close()
PY
}

path_bytes() {
  local p="$1"
  if [ -d "$p" ]; then
    find "$p" -type f -printf '%s\n' 2>/dev/null | awk '{s+=$1} END{printf "%d", s+0}'
  elif [ -f "$p" ]; then
    stat -c %s -- "$p" 2>/dev/null || printf '0'
  else
    printf '0'
  fi
}

refuse_if_running() {
  if pgrep -x opencode >/dev/null 2>&1; then
    if [ "$ALLOW_WHILE_RUNNING" != "1" ]; then
      printf 'ERROR: opencode is running (pgrep -x opencode); refusing --apply.\n' >&2
      printf 'Set ALLOW_WHILE_RUNNING=1 to override (destructive; tests only).\n' >&2
      exit 3
    fi
    log "WARN: opencode running, ALLOW_WHILE_RUNNING=1 -> proceeding (tests only)"
  fi
}

# --- orphan collection ------------------------------------------------------
collect_orphans() {
  [ -f "$OPENCODE_DB" ] || die "DB not found: $OPENCODE_DB"
  [ -r "$OPENCODE_DB" ] || die "DB not readable: $OPENCODE_DB"

  TMPDIR_WORK="$(mktemp -d)"
  valid_ids session >"$TMPDIR_WORK/sessions" || die "failed reading session ids"
  valid_ids project >"$TMPDIR_WORK/projects" || die "failed reading project ids"

  local -a sids=()
  mapfile -t sids <"$TMPDIR_WORK/sessions"
  [ "${#sids[@]}" -gt 0 ] || die "no session ids in DB ($OPENCODE_DB) — refusing to treat all files as orphans"
  local -a pids=()
  mapfile -t pids <"$TMPDIR_WORK/projects"
  [ "${#pids[@]}" -gt 0 ] || die "no project ids in DB ($OPENCODE_DB) — refusing to treat all snapshots as orphans"

  declare -gA VALID_SESSIONS=()
  local id
  for id in "${sids[@]}"; do VALID_SESSIONS["$id"]=1; done
  declare -gA VALID_PROJECTS=()
  for id in "${pids[@]}"; do VALID_PROJECTS["$id"]=1; done

  SESSION_ORPHANS=()
  SNAPSHOT_ORPHANS=()
  SESSION_ORPHAN_BYTES=0
  SNAPSHOT_ORPHAN_BYTES=0

  shopt -s nullglob
  local f base
  for f in "$SESSION_DIFF_DIR"/*.json; do
    [ -f "$f" ] || continue
    base="$(basename "$f" .json)"
    case "$base" in trash-*) continue ;; esac
    if [ -z "${VALID_SESSIONS[$base]+x}" ]; then
      SESSION_ORPHANS+=("$f")
      SESSION_ORPHAN_BYTES=$((SESSION_ORPHAN_BYTES + $(path_bytes "$f")))
    fi
  done

  local d pbase
  for d in "$SNAPSHOT_DIR"/*/; do
    [ -d "$d" ] || continue
    pbase="$(basename "$d")"
    case "$pbase" in trash-*) continue ;; esac
    if [ -z "${VALID_PROJECTS[$pbase]+x}" ]; then
      SNAPSHOT_ORPHANS+=("$d")
      SNAPSHOT_ORPHAN_BYTES=$((SNAPSHOT_ORPHAN_BYTES + $(path_bytes "$d")))
    fi
  done
}

snapshot_file_count() {
  local d="$1"
  find "$d" -type f -printf '.' 2>/dev/null | wc -c
}

# --- dry run ----------------------------------------------------------------
cmd_dry_run() {
  collect_orphans
  log "mode=dry-run"
  log "opencode_home=$OPENCODE_HOME"
  log "opencode_db=$OPENCODE_DB"
  log "session_diff_orphans=${#SESSION_ORPHANS[@]} bytes=$SESSION_ORPHAN_BYTES"
  log "snapshot_orphans=${#SNAPSHOT_ORPHANS[@]} bytes=$SNAPSHOT_ORPHAN_BYTES"
  local f d
  for f in "${SESSION_ORPHANS[@]}"; do log "ORPHAN_FILE $f"; done
  for d in "${SNAPSHOT_ORPHANS[@]}"; do log "ORPHAN_DIR $d"; done
  log "total_orphans=$(( ${#SESSION_ORPHANS[@]} + ${#SNAPSHOT_ORPHANS[@]} ))"
  log "would_reclaim_bytes=$((SESSION_ORPHAN_BYTES + SNAPSHOT_ORPHAN_BYTES))"
  log "freed_bytes=0"
}

# --- apply ------------------------------------------------------------------
preflight_trash() {
  mkdir -p "$TRASH_ROOT" 2>/dev/null || die "quarantine root not creatable: $TRASH_ROOT (nothing deleted)"
  [ -d "$TRASH_ROOT" ] || die "quarantine root is not a directory: $TRASH_ROOT (nothing deleted)"
  local probe="$TRASH_ROOT/.storage-prune.write-probe.$$"
  if ! ( : >"$probe" ) 2>/dev/null; then
    die "quarantine root unwritable: $TRASH_ROOT (nothing deleted)"
  fi
  rm -f -- "$probe"
}

create_trash_dir() {
  local ts base n=0
  ts="$(date -u +%Y-%m-%dT%H-%M-%S)"
  base="$TRASH_ROOT/trash-$ts"
  while [ -e "$base" ]; do
    n=$((n + 1))
    base="$base-$n"
  done
  TRASH_DIR="$base"
  mkdir -p "$TRASH_DIR/data" || die "cannot create quarantine dir: $TRASH_DIR (nothing deleted)"
  chmod 700 "$TRASH_DIR" 2>/dev/null || true
}

# archive_file <src_abs> <relpath-under-OPENCODE_HOME>; appends a FILE line on success.
archive_file() {
  local src="$1" rel="$2"
  local dst="$TRASH_DIR/data/$rel"
  mkdir -p -- "$(dirname "$dst")" || return 1
  cp -a -- "$src" "$dst" || return 1
  local a b
  a="$(hash_file "$src")"
  b="$(hash_file "$dst")"
  [ "$a" = "$b" ] || return 1
  printf 'FILE\t%s\t%s\t%s\n' "$src" "$rel" "$a" >>"$MANIFEST_TMP"
}

build_archive() {
  MANIFEST_TMP="$TRASH_DIR/MANIFEST.txt.tmp"
  {
    printf '# opencode storage-prune quarantine manifest\n'
    printf '# created=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf '# opencode_home=%s\n' "$OPENCODE_HOME"
    printf '# opencode_db=%s\n' "$OPENCODE_DB"
    printf '# format: TYPE<TAB>original_path<TAB>stored_relpath<TAB>sha256\n'
  } >"$MANIFEST_TMP"

  local f rel d
  for f in "${SESSION_ORPHANS[@]}"; do
    rel="${f#"$OPENCODE_HOME"/}"
    archive_file "$f" "$rel" || die "archive failed for: $f (nothing deleted)"
  done
  for d in "${SNAPSHOT_ORPHANS[@]}"; do
    while IFS= read -r -d '' f; do
      rel="${f#"$OPENCODE_HOME"/}"
      archive_file "$f" "$rel" || die "archive failed for: $f (nothing deleted)"
    done < <(find "$d" -type f -print0)
    # Record directories deepest-first (-depth) so rmdir succeeds, top dir last.
    while IFS= read -r dd; do
      printf 'DIR\t%s\t-\t-\n' "$dd" >>"$MANIFEST_TMP"
    done < <(find "$d" -depth -type d)
  done
  mv -f -- "$MANIFEST_TMP" "$TRASH_DIR/MANIFEST.txt"
}

verify_archive() {
  local f rel d rel_d src_c dst_c
  for f in "${SESSION_ORPHANS[@]}"; do
    rel="${f#"$OPENCODE_HOME"/}"
    [ -f "$TRASH_DIR/data/$rel" ] || die "missing archived copy: $rel (nothing deleted)"
    [ "$(hash_file "$TRASH_DIR/data/$rel")" = "$(hash_file "$f")" ] \
      || die "archived hash mismatch: $rel (nothing deleted)"
  done
  for d in "${SNAPSHOT_ORPHANS[@]}"; do
    rel_d="${d#"$OPENCODE_HOME"/}"
    src_c="$(snapshot_file_count "$d")"
    dst_c="$(snapshot_file_count "$TRASH_DIR/data/$rel_d")"
    [ "$src_c" = "$dst_c" ] || die "archive incomplete for $d ($dst_c/$src_c) (nothing deleted)"
  done
}

delete_from_manifest() {
  local type orig rel h
  while IFS=$'\t' read -r type orig rel h; do
    case "$type" in
      '#'*|'') continue ;;
      FILE)
        case "$orig" in
          "$OPENCODE_HOME"/*) ;;
          *) die "refusing to delete outside OPENCODE_HOME: $orig" ;;
        esac
        rm -f -- "$orig"
        ;;
      DIR)
        case "$orig" in
          "$OPENCODE_HOME"/*) ;;
          *) die "refusing to remove outside OPENCODE_HOME: $orig" ;;
        esac
        rmdir -- "$orig" 2>/dev/null || true
        ;;
      *) ;;
    esac
  done <"$TRASH_DIR/MANIFEST.txt"
}

cmd_apply() {
  refuse_if_running
  collect_orphans

  local total_orphans=$(( ${#SESSION_ORPHANS[@]} + ${#SNAPSHOT_ORPHANS[@]} ))
  if [ "$total_orphans" -eq 0 ]; then
    log "mode=apply"
    log "no-op: no orphan files found"
    log "freed_bytes=0"
    return 0
  fi

  preflight_trash
  create_trash_dir
  build_archive
  verify_archive
  delete_from_manifest

  log "mode=apply"
  log "quarantine=$TRASH_DIR"
  log "manifest=$TRASH_DIR/MANIFEST.txt"
  log "deleted_files=$(grep -c $'^FILE\t' "$TRASH_DIR/MANIFEST.txt" || true)"
  log "deleted_dirs=$(grep -c $'^DIR\t' "$TRASH_DIR/MANIFEST.txt" || true)"
  log "freed_bytes=$((SESSION_ORPHAN_BYTES + SNAPSHOT_ORPHAN_BYTES))"
}

# --- purge trash ------------------------------------------------------------
cmd_purge_trash() {
  [ -d "$TRASH_ROOT" ] || { log "no quarantine root at $TRASH_ROOT"; return 0; }
  local now threshold removed=0 d m age
  now="$(date +%s)"
  threshold=$((PURGE_AFTER_DAYS * 86400))
  shopt -s nullglob
  for d in "$TRASH_ROOT"/trash-*; do
    [ -d "$d" ] || continue
    m="$(stat -c %Y -- "$d")"
    age=$((now - m))
    if [ "$age" -ge "$threshold" ]; then
      rm -rf -- "$d"
      log "purged $d (age_days=$((age / 86400)))"
      removed=$((removed + 1))
    fi
  done
  log "purged_count=$removed (threshold_days=$PURGE_AFTER_DAYS)"
}

main() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run) MODE="dry-run" ;;
      --apply) MODE="apply" ;;
      --purge-trash) MODE="purge" ;;
      -h|--help|help) usage; exit 0 ;;
      *) usage >&2; die "unknown argument: $1" ;;
    esac
    shift
  done

  case "$MODE" in
    dry-run) cmd_dry_run ;;
    apply) cmd_apply ;;
    purge) cmd_purge_trash ;;
    *) die "unknown mode: $MODE" ;;
  esac
}

main "$@"
