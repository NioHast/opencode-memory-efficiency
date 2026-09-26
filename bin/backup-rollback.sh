#!/usr/bin/env bash
# backup-rollback.sh — backup/rollback opencode DB (+WAL/SHM) and config/plugins.
#
# Subcommands:
#   backup            Copy DB and config/plugins into $BACKUP_ROOT/<timestamp>/
#   rollback <ts>     Restore files from $BACKUP_ROOT/<ts>/ (refuses while opencode runs)
#   list              List available backups (sorted)
#
# Env overrides:
#   BACKUP_ROOT  (default $HOME/.local/share/opencode/backups)
#   OPENCODE_DB  (default $HOME/.local/share/opencode/opencode.db)
#   CONFIG_DIR   (default $HOME/.config/opencode)
#   OMO_JSONC    (default $HOME/.omo/omo.jsonc)
#   ALLOW_WHILE_RUNNING=1  allow rollback even when opencode is running (tests only)
set -euo pipefail

BACKUP_ROOT="${BACKUP_ROOT:-$HOME/.local/share/opencode/backups}"
OPENCODE_DB="${OPENCODE_DB:-$HOME/.local/share/opencode/opencode.db}"
CONFIG_DIR="${CONFIG_DIR:-$HOME/.config/opencode}"
OMO_JSONC="${OMO_JSONC:-$HOME/.omo/omo.jsonc}"

log() { printf '%s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: backup-rollback.sh <command> [args]

Commands:
  backup             Copy DB (+WAL/SHM) and opencode config/plugins into
                     $BACKUP_ROOT/<timestamp>/
  rollback <ts>      Restore files from $BACKUP_ROOT/<ts>/
  list               List available backups (newest last)

Env overrides:
  BACKUP_ROOT  (default $HOME/.local/share/opencode/backups)
  OPENCODE_DB  (default $HOME/.local/share/opencode/opencode.db)
  CONFIG_DIR   (default $HOME/.config/opencode)
  OMO_JSONC    (default $HOME/.omo/omo.jsonc)
  ALLOW_WHILE_RUNNING=1  Permit rollback even if opencode is running
EOF
}

timestamp() { date -u +%Y-%m-%dT%H-%M-%S-%N; }
hash_file() { sha256sum -- "$1" | cut -d' ' -f1; }

# --- backup -----------------------------------------------------------------
cmd_backup() {
  [ -n "$OPENCODE_DB" ] || die "OPENCODE_DB is empty"
  [ -f "$OPENCODE_DB" ] || die "DB not found: $OPENCODE_DB"
  mkdir -p "$BACKUP_ROOT"

  # Collision-safe timestamped dir; never overwrite an existing one.
  local ts base n=0
  ts="$(timestamp)"
  base="$BACKUP_ROOT/$ts"
  while [ -e "$base" ]; do
    n=$((n + 1))
    base="$BACKUP_ROOT/$ts-$n"
  done
  local dest="$base"
  mkdir -p "$dest/db" "$dest/config" "$dest/omo"

  {
    printf '# opencode backup manifest\n'
    printf '# created=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf '# opencode_db=%s\n' "$OPENCODE_DB"
    printf '# config_dir=%s\n' "$CONFIG_DIR"
    printf '# omo_jsonc=%s\n' "$OMO_JSONC"
    printf '# format: sha256<TAB>stored_relpath<TAB>original_path\n'
  } >"$dest/MANIFEST.txt"

  # copy_one <src_abs> <stored_relpath>; returns 1 when src is absent.
  copy_one() {
    local src="$1" rel="$2"
    [ -f "$src" ] || return 1
    mkdir -p "$dest/$(dirname "$rel")"
    cp -a -- "$src" "$dest/$rel"
    printf '%s\t%s\t%s\n' "$(hash_file "$src")" "$rel" "$src" >>"$dest/MANIFEST.txt"
  }

  copy_one "$OPENCODE_DB" "db/opencode.db" || die "failed to copy DB: $OPENCODE_DB"
  [ -f "$OPENCODE_DB-wal" ] && copy_one "$OPENCODE_DB-wal" "db/opencode.db-wal" || true
  [ -f "$OPENCODE_DB-shm" ] && copy_one "$OPENCODE_DB-shm" "db/opencode.db-shm" || true

  copy_one "$CONFIG_DIR/opencode.json" "config/opencode.json" \
    || log "WARN: missing $CONFIG_DIR/opencode.json"
  if [ -d "$CONFIG_DIR/plugins" ]; then
    while IFS= read -r -d '' f; do
      rel="${f#"$CONFIG_DIR"/}"
      copy_one "$f" "config/$rel" || true
    done < <(find "$CONFIG_DIR/plugins" -type f -print0)
  else
    log "WARN: missing plugins dir $CONFIG_DIR/plugins"
  fi
  copy_one "$OMO_JSONC" "omo/omo.jsonc" || log "WARN: missing $OMO_JSONC"

  # Verify every recorded copy matches its source hash.
  local hash rel orig src actual
  while IFS=$'\t' read -r hash rel orig; do
    [ "${#hash}" -eq 64 ] || continue
    src="$dest/$rel"
    [ -f "$src" ] || die "copy vanished: $src"
    actual="$(hash_file "$src")"
    [ "$actual" = "$hash" ] || die "copy hash mismatch: $src"
  done <"$dest/MANIFEST.txt"

  log "backup OK -> $dest"
  log "files: $(grep -c $'\t' "$dest/MANIFEST.txt" || true)"
  log "db sha256: $(hash_file "$dest/db/opencode.db")"
}

# --- rollback ---------------------------------------------------------------
cmd_rollback() {
  local ts="${1:-}"
  [ -n "$ts" ] || die "rollback requires <ts>"
  local src="$BACKUP_ROOT/$ts"
  [ -d "$src" ] || die "backup not found: $src"
  [ -f "$src/MANIFEST.txt" ] || die "manifest missing: $src/MANIFEST.txt"

  if pgrep -x opencode >/dev/null 2>&1; then
    if [ "${ALLOW_WHILE_RUNNING:-0}" != "1" ]; then
      printf 'ERROR: opencode is running (pgrep -x opencode); refusing rollback.\n' >&2
      printf 'Set ALLOW_WHILE_RUNNING=1 to override (destructive; tests only).\n' >&2
      exit 3
    fi
    log "WARN: opencode running, ALLOW_WHILE_RUNNING=1 set -> proceeding"
  fi

  local hash rel orig stored
  # Pre-flight: all stored files exist and match manifest hashes.
  while IFS=$'\t' read -r hash rel orig; do
    [ "${#hash}" -eq 64 ] || continue
    stored="$src/$rel"
    [ -f "$stored" ] || die "missing stored file: $stored"
    [ "$(hash_file "$stored")" = "$hash" ] || die "backup corrupted: $stored"
  done <"$src/MANIFEST.txt"

  # Restore: copy to sibling temp file, then atomically move over destination.
  local dest tmp
  while IFS=$'\t' read -r hash rel orig; do
    [ "${#hash}" -eq 64 ] || continue
    stored="$src/$rel"
    case "$rel" in
      db/opencode.db) dest="$OPENCODE_DB" ;;
      db/opencode.db-wal) dest="$OPENCODE_DB-wal" ;;
      db/opencode.db-shm) dest="$OPENCODE_DB-shm" ;;
      config/*) dest="$CONFIG_DIR/${rel#config/}" ;;
      omo/*) dest="$OMO_JSONC" ;;
      *) die "unknown stored path: $rel" ;;
    esac
    mkdir -p "$(dirname "$dest")"
    tmp="$dest.rollback.tmp.$$"
    cp -a -- "$stored" "$tmp"
    mv -f -- "$tmp" "$dest"
    printf 'restored %s -> %s\n' "$rel" "$dest"
  done <"$src/MANIFEST.txt"

  log "rollback OK from $src"
}

# --- list -------------------------------------------------------------------
cmd_list() {
  [ -d "$BACKUP_ROOT" ] || { log "no backups at $BACKUP_ROOT"; return 0; }
  find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort
}

main() {
  local cmd="${1:-}"
  case "$cmd" in
    backup) shift; cmd_backup "$@" ;;
    rollback) shift; cmd_rollback "$@" ;;
    list) shift; cmd_list "$@" ;;
    ""|-h|--help|help) usage ;;
    *) usage >&2; die "unknown command: $cmd" ;;
  esac
}

main "$@"
