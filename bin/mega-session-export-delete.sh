#!/usr/bin/env bash
# mega-session-export-delete.sh — export the two "mega" opencode sessions, then
# (optionally) delete ONLY the one that is safe to delete.
#
# Sessions handled:
#   ses_f4d9e6e23ffeMb31YovaD0gHtN  ACTIVE BOULDER -> export/archive only, NEVER delete
#   ses_1ab2557afffejPo4Twz3iKrusR  mega session    -> export then delete
#
# Modes:
#   --export-only   Export the sessions + verify JSON. NO delete, no DB writes.
#   --dry-run       (DEFAULT) Export + verify, then print the exact delete plan
#                   (read-only on the DB). NO DB writes.
#   --plan-only     Print the exact delete plan read-only. NO export, NO writes.
#   --apply         Export + verify, write a timestamped DB backup, then delete
#                   ONLY the delete-target session(s) (messages/parts cascade),
#                   then wal_checkpoint(TRUNCATE) + VACUUM + integrity_check +
#                   foreign_key_check.
#
# Opt-in modifiers (default OFF -> unchanged behavior; used by the maintenance
# orchestrator so that exactly ONE script owns checkpoint/VACUUM):
#   --skip-backup  Do NOT write the timestamped DB backup before the delete.
#                  Caller must already hold a verified backup.
#   --no-vacuum    Do NOT run wal_checkpoint(TRUNCATE)/VACUUM after the delete.
#                  integrity_check + foreign_key_check still run.
#
# Safety:
#   * The active boulder session (hardcoded) and every id found in .omo/boulder.json
#     are PROTECTED: an --apply whose delete target intersects that set is REFUSED
#     (exit 2) BEFORE any export/backup/write.
#   * --apply refuses while `pgrep -x opencode` is alive (exit 3, ZERO writes)
#     unless ALLOW_WHILE_RUNNING=1 (TESTS ONLY — never on the live DB).
#   * Deletion never happens without a verified export + a verified DB backup.
#
# Env overrides:
#   OPENCODE_DB          default $HOME/.local/share/opencode/opencode.db
#   EXPORT_DIR           default $HOME/.local/share/opencode/exports
#   OPENCODE_BIN         default opencode
#   MEGA_SESSIONS        default "<protected> <delete-target>" (both exported)
#   EXPORT_SESSIONS      default $MEGA_SESSIONS
#   DELETE_SESSIONS      default ses_1ab2557afffejPo4Twz3iKrusR
#   PROTECTED_SESSIONS   default ses_f4d9e6e23ffeMb31YovaD0gHtN
#   BOULDER_JSON         default $PWD/.omo/boulder.json then $HOME/.omo/boulder.json
#   ALLOW_WHILE_RUNNING  default 0; 1 bypasses the running gate (TESTS ONLY)
#   SKIP_EXPORT          default 0; 1 skips re-export but STILL verifies existing
#                        export files (TESTS ONLY; deletion still export-gated)
#
# SQLite note: `sqlite3` CLI is not installed here, so all DB work uses the
# python3 stdlib sqlite3 module. PRAGMA foreign_keys is OFF per connection by
# default, so every write connection opens with `PRAGMA foreign_keys=ON` and
# verifies with `PRAGMA foreign_key_check` afterwards.
set -euo pipefail

OPENCODE_DB="${OPENCODE_DB:-$HOME/.local/share/opencode/opencode.db}"
EXPORT_DIR="${EXPORT_DIR:-$HOME/.local/share/opencode/exports}"
OPENCODE_BIN="${OPENCODE_BIN:-opencode}"
PROTECTED_SESSIONS="${PROTECTED_SESSIONS:-ses_f4d9e6e23ffeMb31YovaD0gHtN}"
DELETE_SESSIONS="${DELETE_SESSIONS:-ses_1ab2557afffejPo4Twz3iKrusR}"
MEGA_SESSIONS="${MEGA_SESSIONS:-${PROTECTED_SESSIONS} ${DELETE_SESSIONS}}"
EXPORT_SESSIONS="${EXPORT_SESSIONS:-$MEGA_SESSIONS}"
ALLOW_WHILE_RUNNING="${ALLOW_WHILE_RUNNING:-0}"
SKIP_EXPORT="${SKIP_EXPORT:-0}"
SKIP_BACKUP="${SKIP_BACKUP:-0}"
NO_VACUUM="${NO_VACUUM:-0}"

log() { printf '%s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: mega-session-export-delete.sh [--export-only | --dry-run | --apply]

  --export-only  Export mega sessions + verify JSON. No delete, no DB writes.
  --dry-run      (DEFAULT) Export + verify, print the delete plan read-only.
  --plan-only    Print the delete plan read-only. No export, no DB writes.
  --apply        Export + verify, back up the DB, delete ONLY the delete-target
                 session(s) (cascade), then checkpoint + VACUUM + integrity_check.
                 Refuses while opencode is running (exit 3, zero writes) unless
                 ALLOW_WHILE_RUNNING=1 (TESTS ONLY).
  --skip-backup  Opt-in: skip the pre-delete DB backup (caller holds one).
  --no-vacuum    Opt-in: skip wal_checkpoint(TRUNCATE)/VACUUM (caller owns it).

Env: OPENCODE_DB, EXPORT_DIR, OPENCODE_BIN, MEGA_SESSIONS, EXPORT_SESSIONS,
     DELETE_SESSIONS, PROTECTED_SESSIONS, BOULDER_JSON, ALLOW_WHILE_RUNNING,
     SKIP_EXPORT, SKIP_BACKUP, NO_VACUUM
EOF
}

MODE="dry-run"
for arg in "$@"; do
  case "$arg" in
    --export-only) MODE="export-only" ;;
    --dry-run)     MODE="dry-run" ;;
    --plan-only)   MODE="plan-only" ;;
    --apply)       MODE="apply" ;;
    --skip-backup) SKIP_BACKUP=1 ;;
    --no-vacuum)   NO_VACUUM=1 ;;
    -h|--help|help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument: $arg" ;;
  esac
done

# --- locate .omo/boulder.json (protected session ids) ------------------------
if [ -z "${BOULDER_JSON:-}" ]; then
  for cand in "$PWD/.omo/boulder.json" "$HOME/.omo/boulder.json"; do
    if [ -f "$cand" ]; then BOULDER_JSON="$cand"; break; fi
  done
fi
export BOULDER_JSON="${BOULDER_JSON:-}"

# Protected id set = PROTECTED_SESSIONS + every id in boulder.json.
PROTECTED_IDS="$(python3 - "$PROTECTED_SESSIONS" "$BOULDER_JSON" <<'PY'
import json, os, sys
out = [x for x in sys.argv[1].split() if x]
bj = sys.argv[2]
if bj and os.path.isfile(bj):
    try:
        data = json.load(open(bj))
        ids = data.get("session_ids", [])
        if isinstance(ids, str):
            ids = [ids]
        out.extend(i for i in ids if i)
        print(f"BOULDER_JSON: {bj}", file=sys.stderr)
    except Exception as exc:  # never fail the run over a malformed note
        print(f"WARN: could not parse {bj}: {exc}", file=sys.stderr)
seen, uniq = set(), []
for i in out:
    if i not in seen:
        seen.add(i)
        uniq.append(i)
print(" ".join(uniq))
PY
)"

export PROTECTED_IDS OPENCODE_DB DELETE_SESSIONS EXPORT_SESSIONS

is_protected() {
  local id="$1" p
  for p in $PROTECTED_IDS; do
    [ "$id" = "$p" ] && return 0
  done
  return 1
}

# Refuse a protected delete target BEFORE any export/backup/DB write.
validate_targets() {
  local t
  for t in $DELETE_SESSIONS; do
    if is_protected "$t"; then
      log "REFUSED: delete target '$t' is PROTECTED (active boulder / never-delete)." >&2
      log "No export, no backup, no DB write performed." >&2
      exit 2
    fi
  done
}

# --- export helpers ----------------------------------------------------------
export_session() {
  local sid="$1" out="$EXPORT_DIR/$sid.json" tmp="$EXPORT_DIR/$sid.json.tmp.$$"
  mkdir -p "$EXPORT_DIR"
  log "EXPORT: $sid -> $out"
  if ! "$OPENCODE_BIN" export "$sid" >"$tmp" 2>"$EXPORT_DIR/$sid.export.err"; then
    rm -f -- "$tmp"
    die "opencode export failed for $sid (see $EXPORT_DIR/$sid.export.err)"
  fi
  if [ ! -s "$tmp" ]; then
    rm -f -- "$tmp"
    die "opencode export produced an empty file for $sid"
  fi
  # Must be non-empty and parse as a JSON object with messages.
  if ! python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert isinstance(d,dict) and d and len(d.get("messages",[]))>0' "$tmp"; then
    rm -f -- "$tmp"
    die "opencode export JSON invalid/empty for $sid"
  fi
  mv -f -- "$tmp" "$out"
  local bytes sha
  bytes="$(wc -c < "$out" | tr -d ' ')"
  sha="$(sha256sum "$out" | awk '{print $1}')"
  log "EXPORT_OK: $sid bytes=$bytes sha256=$sha"
}

verify_exports() {
  local sid out bytes ok=1
  for sid in $EXPORT_SESSIONS; do
    out="$EXPORT_DIR/$sid.json"
    if [ ! -s "$out" ]; then
      log "ERROR: missing/empty export: $out" >&2
      ok=0
      continue
    fi
    if ! python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d' "$out"; then
      log "ERROR: export JSON does not parse: $out" >&2
      ok=0
      continue
    fi
    bytes="$(wc -c < "$out" | tr -d ' ')"
    log "EXPORT_VERIFIED: $sid bytes=$bytes"
  done
  [ "$ok" -eq 1 ] || die "export verification failed; refusing to proceed"
}

export_all() {
  local sid
  for sid in $EXPORT_SESSIONS; do
    export_session "$sid"
  done
  verify_exports
}

ensure_exports() {
  if [ "$SKIP_EXPORT" = "1" ]; then
    log "SKIP_EXPORT=1 -> verifying existing exports (TEST MODE)"
    verify_exports
  else
    export_all
  fi
}

# --- backup (apply only, BEFORE any delete) ----------------------------------
backup_db() {
  local ts bak n=0
  ts="$(date -u +%Y%m%d-%H%M%S)"
  bak="${OPENCODE_DB}.mega-bak-${ts}"
  while [ -e "$bak" ]; do
    n=$((n + 1))
    bak="${OPENCODE_DB}.mega-bak-${ts}-${n}"
  done
  cp -a -- "$OPENCODE_DB" "$bak"
  [ -f "${OPENCODE_DB}-wal" ] && cp -a -- "${OPENCODE_DB}-wal" "${bak}-wal" || true
  [ -f "${OPENCODE_DB}-shm" ] && cp -a -- "${OPENCODE_DB}-shm" "${bak}-shm" || true
  log "BACKUP: $bak"
  [ -f "${bak}-wal" ] && log "BACKUP_WAL: ${bak}-wal"

  # Fold the copied WAL into the backup and prove the backup is readable.
  if ! python3 - "$bak" <<'PY'
import sqlite3, sys
bak = sys.argv[1]
c = sqlite3.connect(bak, timeout=60)
c.execute("PRAGMA foreign_keys=ON")
c.execute("PRAGMA wal_checkpoint(TRUNCATE)")
row = c.execute("PRAGMA integrity_check").fetchone()[0]
c.close()
print("BACKUP_INTEGRITY_CHECK:", row)
sys.exit(0 if row == "ok" else 1)
PY
  then
    die "backup failed integrity_check; aborting BEFORE any delete"
  fi
}

# --- read-only delete plan (dry-run) -----------------------------------------
report_plan() {
  python3 - <<'PY'
import os, sqlite3
db = os.environ["OPENCODE_DB"]
targets = [x for x in os.environ["DELETE_SESSIONS"].split() if x]
conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=60)
conn.execute("PRAGMA query_only=ON")
cur = conn.cursor()
def scalar(sql, args=()):
    r = cur.execute(sql, args).fetchone()
    return r[0] if r else 0
print(f"MODE: dry-run")
print(f"DB: {db}")
print(f"PROTECTED_IDS: {os.environ.get('PROTECTED_IDS','') or '(none)'}")
print(f"DELETE_TARGETS: {' '.join(targets) or '(none)'}")
for t in targets:
    row = cur.execute("SELECT id, parent_id, title FROM session WHERE id=?", (t,)).fetchone()
    print(f"TARGET {t}: exists={bool(row)} title={row[2] if row else '-'}")
if targets:
    ph = ",".join("?" * len(targets))
    args = tuple(targets)
    print(f"WOULD_DELETE_SESSIONS: {scalar(f'SELECT COUNT(*) FROM session WHERE id IN ({ph})', args)}")
    print(f"WOULD_CASCADE_MESSAGES: {scalar(f'SELECT COUNT(*) FROM message WHERE session_id IN ({ph})', args)}")
    print(f"WOULD_CASCADE_PARTS: {scalar(f'SELECT COUNT(*) FROM part WHERE session_id IN ({ph})', args)}")
    print(f"WOULD_DELETE_EVENTS: {scalar(f'SELECT COUNT(*) FROM event WHERE aggregate_id IN ({ph})', args)}")
for t in ("session", "message", "part", "event"):
    print(f"ROWS_NOW {t}: {scalar(f'SELECT COUNT(*) FROM {t}')}")
conn.close()
PY
}

# --- apply (delete + compact) ------------------------------------------------
do_apply() {
  export OPENCODE_DB DELETE_SESSIONS PROTECTED_IDS NO_VACUUM
  python3 - <<'PY'
import os, sys, time, sqlite3

db = os.environ["OPENCODE_DB"]
targets = [x for x in os.environ["DELETE_SESSIONS"].split() if x]
protected = {x for x in os.environ["PROTECTED_IDS"].split() if x}
no_vacuum = os.environ.get("NO_VACUUM", "0") == "1"

if not targets:
    print("No DELETE_SESSIONS configured; nothing to delete.")
    sys.exit(0)
for t in targets:
    if t in protected:
        print(f"REFUSED: {t} is protected", file=sys.stderr)
        sys.exit(2)

conn = sqlite3.connect(db, timeout=60)
conn.isolation_level = None          # explicit transaction control
conn.execute("PRAGMA foreign_keys=ON")
cur = conn.cursor()

def scalar(sql, args=()):
    r = cur.execute(sql, args).fetchone()
    return r[0] if r else 0

before = {t: scalar(f"SELECT COUNT(*) FROM {t}") for t in ("session", "message", "part", "event")}
for p in sorted(protected):
    print(f"PROTECTED_BEFORE {p}: {scalar('SELECT COUNT(*) FROM session WHERE id=?', (p,))}")

ph = ",".join("?" * len(targets))
args = tuple(targets)
n_msg = scalar(f"SELECT COUNT(*) FROM message WHERE session_id IN ({ph})", args)
n_part = scalar(f"SELECT COUNT(*) FROM part WHERE session_id IN ({ph})", args)
n_evt = scalar(f"SELECT COUNT(*) FROM event WHERE aggregate_id IN ({ph})", args)

print(f"MODE: apply")
print(f"DB: {db}")
print(f"DELETE_TARGETS: {' '.join(targets)}")
print(f"TARGET_MESSAGES: {n_msg}")
print(f"TARGET_PARTS: {n_part}")
print(f"TARGET_EVENTS: {n_evt}")
print(f"ROWS_BEFORE: session={before['session']} message={before['message']} part={before['part']} event={before['event']}")

size_before = os.path.getsize(db)
deleted_evt = deleted_parts = deleted_msg = deleted_sess = 0
cur.execute("BEGIN")
try:
    deleted_evt = cur.execute(f"DELETE FROM event WHERE aggregate_id IN ({ph})", args).rowcount
    deleted_parts = cur.execute(f"DELETE FROM part WHERE session_id IN ({ph})", args).rowcount
    deleted_msg = cur.execute(f"DELETE FROM message WHERE session_id IN ({ph})", args).rowcount
    # FK ON -> remaining message/part/todo/session_* rows cascade with the session.
    deleted_sess = cur.execute(f"DELETE FROM session WHERE id IN ({ph})", args).rowcount
    cur.execute("COMMIT")
except Exception:
    cur.execute("ROLLBACK")
    raise

print(f"DELETED_SESSIONS: {deleted_sess}")
print(f"DELETED_MESSAGES: {deleted_msg}")
print(f"DELETED_PARTS: {deleted_parts}")
print(f"DELETED_EVENTS: {deleted_evt}")

t0 = time.time()
if no_vacuum:
    print("WAL_CHECKPOINT: skipped (--no-vacuum)")
    print("VACUUM: skipped (--no-vacuum)")
else:
    cur.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    print(f"WAL_CHECKPOINT: truncate ({time.time() - t0:.1f}s)")
    t0 = time.time()
    cur.execute("VACUUM")
    print(f"VACUUM: done ({time.time() - t0:.1f}s)")
integrity = cur.execute("PRAGMA integrity_check").fetchone()[0]
fk_rows = cur.execute("PRAGMA foreign_key_check").fetchall()
conn.close()

after = {}
c2 = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
for t in ("session", "message", "part", "event"):
    after[t] = c2.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
protected_after = {p: c2.execute("SELECT COUNT(*) FROM session WHERE id=?", (p,)).fetchone()[0]
                   for p in sorted(protected)}
c2.close()
size_after = os.path.getsize(db)

print(f"PROTECTED_AFTER: {protected_after}")
print(f"ROWS_AFTER: session={after['session']} message={after['message']} part={after['part']} event={after['event']}")
print(f"INTEGRITY_CHECK: {integrity}")
print(f"FOREIGN_KEY_CHECK: {'empty' if not fk_rows else fk_rows}")
print(f"DB_SIZE: {size_before} -> {size_after} bytes")

rc = 0
if integrity != "ok":
    print("ERROR: integrity_check failed", file=sys.stderr)
    rc = 4
if fk_rows:
    print("ERROR: foreign_key_check returned rows", file=sys.stderr)
    rc = 5
for p, cnt in protected_after.items():
    if cnt != 1:
        print(f"ERROR: protected session {p} missing (count={cnt})", file=sys.stderr)
        rc = 6
if before["session"] - after["session"] != deleted_sess:
    print("ERROR: session count delta mismatch", file=sys.stderr)
    rc = 7
if rc:
    sys.exit(rc)
PY
}

# --- dispatch ----------------------------------------------------------------
if [ "$MODE" = "export-only" ]; then
  export_all
  log "EXPORT-ONLY: archived: $EXPORT_SESSIONS"
  log "EXPORT-ONLY: no delete performed"
  exit 0
fi

# Refuse a protected target before touching anything (no writes).
validate_targets

# Running gate: --apply only. Dry-run is read-only and always allowed.
RUNNING_PIDS="$(pgrep -x opencode || true)"
if [ "$MODE" = "apply" ] && [ -n "$RUNNING_PIDS" ]; then
  if [ "$ALLOW_WHILE_RUNNING" != "1" ]; then
    log "ERROR: opencode is running (pgrep -x opencode: $RUNNING_PIDS); refusing --apply." >&2
    log "No writes performed. Stop opencode, or set ALLOW_WHILE_RUNNING=1 (tests only)." >&2
    exit 3
  fi
  log "WARN: opencode is running ($RUNNING_PIDS); ALLOW_WHILE_RUNNING=1 -> proceeding (TESTS ONLY)"
fi

if [ "$MODE" = "plan-only" ]; then
  report_plan
  log "PLAN-ONLY: no export, no DB changes made"
  exit 0
fi

if [ "$MODE" = "apply" ]; then
  ensure_exports
  if [ "$SKIP_BACKUP" = "1" ]; then
    log "SKIP_BACKUP=1 -> skipping pre-delete DB backup (caller holds one)"
  else
    backup_db
  fi
  do_apply
  log "APPLY COMPLETE: deleted ONLY: $DELETE_SESSIONS"
else
  export_all
  report_plan
  log "DRY-RUN: no DB changes made"
fi
