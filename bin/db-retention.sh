#!/usr/bin/env bash
# db-retention.sh — TTL retention + VACUUM for the opencode SQLite DB.
#
# Deletes only OLD completed child/subagent sessions (parent_id IS NOT NULL and
# time_updated older than RETENTION_DAYS) plus the `event` rows that belong to
# those deleted sessions. Top-level sessions and the message/part rows of kept
# sessions are NEVER touched.
#
# Modes:
#   --dry-run   (DEFAULT) print exact delete counts, change NOTHING.
#   --apply     refuse while opencode runs, write a timestamped backup, delete,
#               wal_checkpoint(TRUNCATE) + VACUUM, then integrity_check and
#               foreign_key_check.
#
# Env overrides:
#   OPENCODE_DB          default $HOME/.local/share/opencode/opencode.db
#   RETENTION_DAYS       default 2 (child sessions older than this are removed)
#   ALLOW_WHILE_RUNNING  default 0; set to 1 to let --apply run while
#                        `pgrep -x opencode` is alive (TESTS ONLY — never on the
#                        live DB; documented here and in the runbook).
#   BOULDER_JSON         path to .omo/boulder.json; its session_ids are never
#                        deleted. Defaults to $PWD/.omo/boulder.json then
#                        $HOME/.omo/boulder.json.
#
# SQLite note: `sqlite3` CLI is not installed in this environment, so all DB
# work happens in an embedded python3 stdlib sqlite3 heredoc. PRAGMA
# foreign_keys is OFF per connection by default, so this script opens every
# write connection with `PRAGMA foreign_keys=ON` and verifies with
# `PRAGMA foreign_key_check` afterwards.
set -euo pipefail

OPENCODE_DB="${OPENCODE_DB:-$HOME/.local/share/opencode/opencode.db}"
RETENTION_DAYS="${RETENTION_DAYS:-2}"
ALLOW_WHILE_RUNNING="${ALLOW_WHILE_RUNNING:-0}"
NO_DELETE_SESSION="ses_f4d9e6e23ffeMb31YovaD0gHtN"   # active boulder session — NEVER delete

log()  { printf '%s\n' "$*"; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: db-retention.sh [--dry-run | --apply]

  --dry-run   Print exact delete counts and change NOTHING (DEFAULT).
  --apply     Backup, delete old child sessions + their events, VACUUM.
              Refuses while `pgrep -x opencode` is alive unless
              ALLOW_WHILE_RUNNING=1 (tests only).

Env: OPENCODE_DB, RETENTION_DAYS (default 2), ALLOW_WHILE_RUNNING (default 0),
     BOULDER_JSON (default $PWD/.omo/boulder.json then $HOME/.omo/boulder.json)
EOF
}

MODE="dry-run"
for arg in "$@"; do
  case "$arg" in
    --dry-run) MODE="dry-run" ;;
    --apply)   MODE="apply" ;;
    -h|--help|help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument: $arg" ;;
  esac
done

[ -f "$OPENCODE_DB" ] || die "DB not found: $OPENCODE_DB"

# --- locate .omo/boulder.json (protected session ids) ------------------------
if [ -z "${BOULDER_JSON:-}" ]; then
  for cand in "$PWD/.omo/boulder.json" "$HOME/.omo/boulder.json"; do
    if [ -f "$cand" ]; then BOULDER_JSON="$cand"; break; fi
  done
fi
export BOULDER_JSON="${BOULDER_JSON:-}"

# --- running gate ------------------------------------------------------------
# Dry-run is read-only, so it is always allowed. Apply refuses a live opencode.
RUNNING_PIDS="$(pgrep -x opencode || true)"
if [ "$MODE" = "apply" ] && [ -n "$RUNNING_PIDS" ]; then
  if [ "$ALLOW_WHILE_RUNNING" != "1" ]; then
    log "ERROR: opencode is running (pgrep -x opencode: $RUNNING_PIDS); refusing --apply." >&2
    log "No writes performed. Stop opencode, or set ALLOW_WHILE_RUNNING=1 (tests only)." >&2
    exit 3
  fi
  log "WARN: opencode is running ($RUNNING_PIDS); ALLOW_WHILE_RUNNING=1 -> proceeding (tests only)"
fi

export OPENCODE_DB RETENTION_DAYS NO_DELETE_SESSION MODE

# --- backup (apply only, BEFORE any delete) ----------------------------------
if [ "$MODE" = "apply" ]; then
  TS="$(date -u +%Y%m%d-%H%M%S)"
  BAK="${OPENCODE_DB}.bak-${TS}"
  n=0
  while [ -e "$BAK" ]; do
    n=$((n + 1))
    BAK="${OPENCODE_DB}.bak-${TS}-${n}"
  done
  cp -a -- "$OPENCODE_DB" "$BAK"
  [ -f "${OPENCODE_DB}-wal" ] && cp -a -- "${OPENCODE_DB}-wal" "${BAK}-wal" || true
  [ -f "${OPENCODE_DB}-shm" ] && cp -a -- "${OPENCODE_DB}-shm" "${BAK}-shm" || true
  log "BACKUP: $BAK"
  [ -f "${BAK}-wal" ] && log "BACKUP_WAL: ${BAK}-wal"

  # Fold the copied WAL into the backup and prove the backup is readable.
  if ! python3 - "$BAK" <<'PY'
import sqlite3, sys
bak = sys.argv[1]
c = sqlite3.connect(bak, timeout=60)
c.execute("PRAGMA foreign_keys=ON")
c.execute("PRAGMA wal_checkpoint(TRUNCATE)")
row = c.execute("PRAGMA integrity_check").fetchone()[0]
c.close()
print("BACKUP_INTEGRITY_CHECK:", row)
if row != "ok":
    sys.exit(1)
PY
  then
    die "backup failed integrity_check; aborting before any delete"
  fi
fi

# --- main work (dry-run read-only / apply read-write) ------------------------
python3 - <<'PY'
import os, re, sys, json, time, sqlite3, datetime

db            = os.environ["OPENCODE_DB"]
mode          = os.environ["MODE"]
days          = float(os.environ.get("RETENTION_DAYS", "2"))
never_delete  = {x for x in os.environ.get("NO_DELETE_SESSION", "").split() if x}
boulder_json  = os.environ.get("BOULDER_JSON", "")

# Protected set: hardcoded active boulder session + every id in boulder.json.
protected = set(never_delete)
if boulder_json and os.path.isfile(boulder_json):
    try:
        with open(boulder_json) as fh:
            data = json.load(fh)
        ids = data.get("session_ids", [])
        if isinstance(ids, str):
            ids = [ids]
        protected |= {i for i in ids if i}
        print(f"BOULDER_JSON: {boulder_json}")
    except Exception as exc:  # never fail the run over a malformed note
        print(f"WARN: could not parse {boulder_json}: {exc}", file=sys.stderr)
protected.discard("")

now_ms = int(time.time() * 1000)
cutoff = now_ms - int(days * 86400 * 1000)

if mode == "dry-run":
    conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=60)
else:
    conn = sqlite3.connect(db, timeout=60)
conn.isolation_level = None          # explicit transaction control
conn.execute("PRAGMA foreign_keys=ON")
if mode == "dry-run":
    conn.execute("PRAGMA query_only=ON")
cur = conn.cursor()

def scalar(sql, args=()):
    r = cur.execute(sql, args).fetchone()
    return r[0] if r else 0

counts = {t: scalar(f"SELECT COUNT(*) FROM {t}") for t in ("session", "message", "part", "event")}
top_before = scalar("SELECT COUNT(*) FROM session WHERE parent_id IS NULL")

rows = cur.execute(
    "SELECT id, parent_id, time_updated FROM session "
    "WHERE parent_id IS NOT NULL AND time_updated < ?",
    (cutoff,),
).fetchall()
candidates = [r for r in rows if r[0] not in protected]
skipped    = [r for r in rows if r[0] in protected]
delete_ids = {r[0] for r in candidates}

n_msg  = n_part = n_evt = 0
if delete_ids:
    ph = ",".join("?" * len(delete_ids))
    args = tuple(delete_ids)
    n_msg  = scalar(f"SELECT COUNT(*) FROM message WHERE session_id IN ({ph})", args)
    n_part = scalar(f"SELECT COUNT(*) FROM part    WHERE session_id IN ({ph})", args)
    n_evt  = scalar(f"SELECT COUNT(*) FROM event   WHERE aggregate_id IN ({ph})", args)

# Affected parents: kept sessions whose `task` tool parts reference a deleted child.
affected = set()
if delete_ids:
    pat = re.compile(r"ses_[A-Za-z0-9]+")
    for sid, data in cur.execute(
        "SELECT session_id, data FROM part WHERE data LIKE '%\"task\"%'"
    ):
        if sid in delete_ids:
            continue
        for ref in pat.findall(data or ""):
            if ref in delete_ids:
                affected.add(sid)
                break

print(f"MODE: {mode}")
print(f"DB: {db}")
print(f"RETENTION_DAYS: {days}")
print(f"CUTOFF_MS: {cutoff}")
print(f"PROTECTED_IDS: {','.join(sorted(protected)) or '(none)'}")
print(f"CHILD_OLD_TOTAL: {len(rows)}")
print(f"SKIPPED_PROTECTED_CHILD: {len(skipped)}")
print(f"AFFECTED_PARENT_IDS: {','.join(sorted(affected)) or '(none)'}")
print(f"ROWS_BEFORE: session={counts['session']} message={counts['message']} "
      f"part={counts['part']} event={counts['event']}")
print(f"TOP_LEVEL_BEFORE: {top_before}")

if mode == "dry-run":
    print(f"WOULD_DELETE_SESSIONS: {len(delete_ids)}")
    print(f"WOULD_DELETE_EVENTS: {n_evt}")
    print(f"WOULD_CASCADE_MESSAGE: {n_msg}")
    print(f"WOULD_CASCADE_PART: {n_part}")
    print("DRY-RUN: no changes made")
    conn.close()
    sys.exit(0)

# ---- apply -----------------------------------------------------------------
size_before = os.path.getsize(db)

deleted_sessions = deleted_events = 0
if delete_ids:
    cur.execute("CREATE TEMP TABLE del_ids(id TEXT PRIMARY KEY)")
    cur.executemany("INSERT OR IGNORE INTO del_ids(id) VALUES (?)",
                    [(i,) for i in delete_ids])
    cur.execute("BEGIN")
    try:
        deleted_events = cur.execute(
            "DELETE FROM event WHERE aggregate_id IN (SELECT id FROM del_ids)"
        ).rowcount
        # FK ON -> message/part/todo/... cascade with their session.
        deleted_sessions = cur.execute(
            "DELETE FROM session WHERE id IN (SELECT id FROM del_ids)"
        ).rowcount
        cur.execute("COMMIT")
    except Exception:
        cur.execute("ROLLBACK")
        raise
    cur.execute("DROP TABLE del_ids")

print(f"DELETED_SESSIONS: {deleted_sessions}")
print(f"DELETED_EVENTS: {deleted_events}")

t0 = time.time()
cur.execute("PRAGMA wal_checkpoint(TRUNCATE)")
print(f"WAL_CHECKPOINT: truncate ({time.time()-t0:.1f}s)")
t0 = time.time()
cur.execute("VACUUM")
print(f"VACUUM: done ({time.time()-t0:.1f}s)")

integrity = cur.execute("PRAGMA integrity_check").fetchone()[0]
fk_rows = cur.execute("PRAGMA foreign_key_check").fetchall()
conn.close()

counts_after = {}
c2 = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
for t in ("session", "message", "part", "event"):
    counts_after[t] = c2.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
top_after = c2.execute("SELECT COUNT(*) FROM session WHERE parent_id IS NULL").fetchone()[0]
c2.close()

size_after = os.path.getsize(db)
print(f"ROWS_AFTER: session={counts_after['session']} message={counts_after['message']} "
      f"part={counts_after['part']} event={counts_after['event']}")
print(f"TOP_LEVEL_AFTER: {top_after}")
print(f"INTEGRITY_CHECK: {integrity}")
print(f"FOREIGN_KEY_CHECK: {'empty' if not fk_rows else fk_rows}")
print(f"DB_SIZE: {size_before} -> {size_after} bytes")

if integrity != "ok":
    print("ERROR: integrity_check failed", file=sys.stderr)
    sys.exit(4)
if fk_rows:
    print("ERROR: foreign_key_check returned rows", file=sys.stderr)
    sys.exit(5)
if top_after != top_before:
    print("ERROR: top-level session count changed", file=sys.stderr)
    sys.exit(6)
PY
