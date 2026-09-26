#!/usr/bin/env bash
# retention.test.sh — integration test for `bin/db-retention.sh` on a DB COPY.
#
# What it proves (todo 15):
#   1. A real `opencode.db` is copied to a temp path (consistent sqlite3 backup);
#      the retention script is ALWAYS invoked with OPENCODE_DB=<that copy>.
#   2. Seeded OLD child session + OLD event are deleted by `--apply`.
#   3. A real TOP-LEVEL session (picked from the copy) survives intact.
#   4. `PRAGMA integrity_check` = ok and `PRAGMA foreign_key_check` is empty.
#   5. Negative TTL gate: RETENTION_DAYS=99999 -> --apply deletes NOTHING.
#   6. Safety guard: refuses to run when the copy path equals the LIVE DB path.
#   7. Trap removes the temp DB copy + every backup on exit.
#
# It NEVER touches the live DB. `ALLOW_WHILE_RUNNING=1` is used only because the
# target is the temp copy and opencode is alive in this environment.
#
# Env overrides (test-only):
#   OPENCODE_LIVE_DB   live DB to copy (default: the standard opencode.db)
#   RETENTION_BIN      path to db-retention.sh
#   RETENTION_DB_COPY  override the copy path (used by the guard self-test)
#   RETENTION_GUARD_ONLY=1  exit right after the safety guard (guard self-test)
#   RETENTION_SEED_DAYS     age of the seeded child (default 30)
#   RETENTION_DAYS_OK       positive TTL (default 2)
#   RETENTION_DAYS_NOOP     negative TTL (default 99999)
set -uo pipefail

RETENTION_BIN="${RETENTION_BIN:-$HOME/.config/opencode/bin/db-retention.sh}"
LIVE_DB="${OPENCODE_LIVE_DB:-$HOME/.local/share/opencode/opencode.db}"
RETENTION_SEED_DAYS="${RETENTION_SEED_DAYS:-30}"
RETENTION_DAYS_OK="${RETENTION_DAYS_OK:-2}"
RETENTION_DAYS_NOOP="${RETENTION_DAYS_NOOP:-99999}"
# Hardcoded never-delete id in db-retention.sh; never pick it as our "known top-level".
HARDCODED_PROTECTED="ses_f4d9e6e23ffeMb31YovaD0gHtN"

WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/opencode-retention-test.XXXXXX")"
DB_COPY="${RETENTION_DB_COPY:-$WORKDIR/opencode.db}"
BOULDER_JSON="$WORKDIR/boulder.json"

cleanup() { rm -rf -- "$WORKDIR"; }
trap cleanup EXIT

PASS=0
FAIL=0
ok()  { PASS=$((PASS + 1)); printf 'PASS: %s\n' "$*"; }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL: %s\n' "$*"; }
check() { # $1=label $2=got $3=want
  if [ "$2" = "$3" ]; then ok "$1 (= $3)"; else bad "$1 (want $3, got $2)"; fi
}
check_ne() { # $1=label $2=got $3=notwant
  if [ "$2" != "$3" ]; then ok "$1 ($2 != $3)"; else bad "$1 (got forbidden value $3)"; fi
}
contains() { # $1=label $2=needle $3=file
  if grep -qF -- "$2" "$3"; then ok "$1"; else bad "$1 (missing: $2)"; fi
}
val() { # $1=counts-file $2=key
  grep -m1 "^$2=" "$1" | cut -d= -f2
}
field() { # $1=file $2=KEY
  grep -m1 -E "^$2:" "$1" | sed -E "s/^$2:[[:space:]]*//"
}

printf '=== retention integration test (todo 15) ===\n'
printf 'live DB:        %s\n' "$LIVE_DB"
printf 'retention bin:  %s\n' "$RETENTION_BIN"
printf 'workdir:        %s\n' "$WORKDIR"
printf 'copy:           %s\n' "$DB_COPY"
printf 'opencode pids:  %s\n' "$(pgrep -x opencode | tr '\n' ' ')"

# ---------------------------------------------------------------------------
# Safety guard: the copy must NEVER be the live DB.
# ---------------------------------------------------------------------------
LIVE_REAL="$(readlink -f -- "$LIVE_DB" 2>/dev/null || printf '%s' "$LIVE_DB")"
COPY_REAL="$(readlink -f -- "$DB_COPY" 2>/dev/null || printf '%s' "$DB_COPY")"
if [ "$COPY_REAL" = "$LIVE_REAL" ]; then
  printf 'REFUSING: copy path equals the LIVE DB path (%s); aborting before any write.\n' "$DB_COPY" >&2
  exit 1
fi
if [ "${RETENTION_GUARD_ONLY:-0}" = "1" ]; then
  printf 'GUARD_OK: copy path is not the live DB: %s\n' "$DB_COPY"
  exit 0
fi
case "$COPY_REAL" in
  "$WORKDIR"/*) : ;;
  *) printf 'REFUSING: copy %s is not under the temp workdir %s.\n' "$DB_COPY" "$WORKDIR" >&2; exit 1 ;;
esac
[ -f "$RETENTION_BIN" ] || { printf 'ERROR: db-retention.sh not found: %s\n' "$RETENTION_BIN" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Phase 0 — prove the safety guard itself refuses on the live path.
# ---------------------------------------------------------------------------
printf '\n=== phase 0: safety guard self-test ===\n'
GUARD_BAD_OUT="$WORKDIR/guard_bad.out"
RETENTION_GUARD_ONLY=1 RETENTION_DB_COPY="$LIVE_DB" bash "$0" >"$GUARD_BAD_OUT" 2>&1
grc=$?
check_ne "guard refuses when copy == live" "$grc" "0"
contains "guard refusal message" "REFUSING" "$GUARD_BAD_OUT"
GUARD_OK_OUT="$WORKDIR/guard_ok.out"
RETENTION_GUARD_ONLY=1 RETENTION_DB_COPY="${LIVE_DB}.not-live" bash "$0" >"$GUARD_OK_OUT" 2>&1
gok=$?
check "guard allows a non-live path" "$gok" "0"
contains "guard-ok message" "GUARD_OK" "$GUARD_OK_OUT"

# ---------------------------------------------------------------------------
# Phase 1 — consistent copy of the real DB (never the live file).
# ---------------------------------------------------------------------------
printf '\n=== phase 1: copy the real DB to a temp path ===\n'
python3 - "$LIVE_DB" "$DB_COPY" <<'PY'
import sqlite3, sys
src, dst = sys.argv[1], sys.argv[2]
s = sqlite3.connect(f"file:{src}?mode=ro", uri=True, timeout=60)
d = sqlite3.connect(dst, timeout=60)
s.backup(d)
d.close(); s.close()
print(f"COPIED {src} -> {dst}")
PY
[ -f "$DB_COPY" ] || { printf 'ERROR: copy failed: %s\n' "$DB_COPY" >&2; exit 1; }
check_ne "copied path is not the live DB" "$(readlink -f -- "$DB_COPY")" "$(readlink -f -- "$LIVE_DB")"
CP_INTEG="$(python3 - "$DB_COPY" <<'PY'
import sqlite3, sys
c = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
print(c.execute("PRAGMA integrity_check").fetchone()[0]); c.close()
PY
)"
check "pristine copy integrity_check" "$CP_INTEG" "ok"
printf 'copy size: %s bytes\n' "$(stat -c %s "$DB_COPY")"

printf '{"session_ids":[]}\n' > "$BOULDER_JSON"

# ---------------------------------------------------------------------------
# Phase 2 — pick a real top-level session from the COPY, then seed an old child.
# ---------------------------------------------------------------------------
printf '\n=== phase 2: pick top-level + seed old child session/event ===\n'
TOP_ID="$(python3 - "$DB_COPY" "$HARDCODED_PROTECTED" <<'PY'
import sqlite3, sys
db, protected = sys.argv[1], sys.argv[2]
c = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
c.execute("PRAGMA query_only=ON")
row = c.execute(
    "SELECT id FROM session WHERE parent_id IS NULL AND id != ? "
    "ORDER BY time_updated DESC, id DESC LIMIT 1", (protected,)
).fetchone()
print(row[0] if row else ""); c.close()
PY
)"
[ -n "$TOP_ID" ] || { printf 'ERROR: no top-level session found in copy\n' >&2; exit 1; }
check_ne "known top-level is real" "$TOP_ID" "$HARDCODED_PROTECTED"

CHILD_ID="ses_retentiontestchild000000000000"
CHILD_MSG="msg_retentiontestchild000000000000"
CHILD_PART="prt_retentiontestchild000000000000"
CHILD_EVT="evt_retentiontestchild000000000000"
NOW_MS="$(python3 -c 'import time;print(int(time.time()*1000))')"
OLD_MS="$((NOW_MS - RETENTION_SEED_DAYS * 86400 * 1000))"
printf 'known top-level: %s\n' "$TOP_ID"
printf 'seed child:      %s (time_updated=%s)\n' "$CHILD_ID" "$OLD_MS"

python3 - "$DB_COPY" "$CHILD_ID" "$CHILD_MSG" "$CHILD_PART" "$CHILD_EVT" "$TOP_ID" "$OLD_MS" <<'PY'
import sqlite3, sys, json
db, child, msg, part, evt, parent, old_ms = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5], sys.argv[6], int(sys.argv[7])
c = sqlite3.connect(db, timeout=60)
c.execute("PRAGMA foreign_keys=ON")
project_id, directory = c.execute(
    "SELECT project_id, directory FROM session WHERE id=?", (parent,)
).fetchone()
c.execute("BEGIN")
c.execute(
    "INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, "
    "time_created, time_updated, cost, tokens_input, tokens_output, tokens_reasoning, "
    "tokens_cache_read, tokens_cache_write) VALUES (?,?,?,?,?,?,?,?,?,0,0,0,0,0,0)",
    (child, project_id, parent, "retention-test-child", directory,
     "retention test seed child", "1.18.32", old_ms, old_ms),
)
c.execute(
    "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)",
    (msg, child, old_ms, old_ms, json.dumps({"role": "user", "seed": True})),
)
c.execute(
    "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)",
    (part, msg, child, old_ms, old_ms, json.dumps({"type": "text", "text": "retention seed"})),
)
# event.aggregate_id has an FK -> event_sequence(aggregate_id): seed it so
# foreign_key_check stays empty.
c.execute("INSERT OR REPLACE INTO event_sequence (aggregate_id, seq) VALUES (?,?)", (child, 1))
c.execute(
    "INSERT INTO event (id, aggregate_id, seq, type, data) VALUES (?,?,?,?,?)",
    (evt, child, 1, "retention.test", json.dumps({"seed": True})),
)
c.execute("COMMIT")
c.close()
print(f"SEEDED child={child} msg={msg} part={part} event={evt} parent={parent}")
PY

counts() { # $1=outfile
  python3 - "$DB_COPY" "$CHILD_ID" "$CHILD_EVT" "$TOP_ID" > "$1" <<'PY'
import sqlite3, sys, json
db, child, evt, top = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
c = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
c.execute("PRAGMA query_only=ON")
def one(sql, a=()):
    r = c.execute(sql, a).fetchone()
    return r[0] if r else 0
res = {
    "sessions": one("SELECT COUNT(*) FROM session"),
    "messages": one("SELECT COUNT(*) FROM message"),
    "parts": one("SELECT COUNT(*) FROM part"),
    "events": one("SELECT COUNT(*) FROM event"),
    "toplevel": one("SELECT COUNT(*) FROM session WHERE parent_id IS NULL"),
    "child_exists": one("SELECT COUNT(*) FROM session WHERE id=?", (child,)),
    "child_msgs": one("SELECT COUNT(*) FROM message WHERE session_id=?", (child,)),
    "child_parts": one("SELECT COUNT(*) FROM part WHERE session_id=?", (child,)),
    "child_evt": one("SELECT COUNT(*) FROM event WHERE id=?", (evt,)),
    "top_exists": one("SELECT COUNT(*) FROM session WHERE id=?", (top,)),
    "top_msgs": one("SELECT COUNT(*) FROM message WHERE session_id=?", (top,)),
    "top_parts": one("SELECT COUNT(*) FROM part WHERE session_id=?", (top,)),
}
c.close()
print("JSON " + json.dumps(res, sort_keys=True))
for k in sorted(res):
    print(f"{k}={res[k]}")
PY
}

run_apply() { # $1=RETENTION_DAYS $2=outfile ; returns db-retention exit code
  env OPENCODE_DB="$DB_COPY" RETENTION_DAYS="$1" ALLOW_WHILE_RUNNING=1 \
      BOULDER_JSON="$BOULDER_JSON" bash "$RETENTION_BIN" --apply > "$2" 2>&1
}

BEFORE="$WORKDIR/before.counts"
counts "$BEFORE"
printf 'BEFORE: %s\n' "$(grep -m1 '^JSON ' "$BEFORE" | cut -d' ' -f2-)"
check "seed child exists before"  "$(val "$BEFORE" child_exists)" "1"
check "seed msg exists before"    "$(val "$BEFORE" child_msgs)"   "1"
check "seed part exists before"   "$(val "$BEFORE" child_parts)"  "1"
check "seed event exists before"  "$(val "$BEFORE" child_evt)"    "1"
check "known top-level exists before" "$(val "$BEFORE" top_exists)" "1"

# ---------------------------------------------------------------------------
# Phase 3 — NEGATIVE: huge TTL -> --apply deletes NOTHING (proves the gate).
# ---------------------------------------------------------------------------
printf '\n=== phase 3: negative TTL gate (RETENTION_DAYS=%s) -> delete nothing ===\n' "$RETENTION_DAYS_NOOP"
NOOP_OUT="$WORKDIR/noop.out"
run_apply "$RETENTION_DAYS_NOOP" "$NOOP_OUT"; nrc=$?
printf -- '--- noop apply output ---\n'
cat "$NOOP_OUT"
check "noop apply exit code" "$nrc" "0"
contains "noop deleted 0 sessions" "DELETED_SESSIONS: 0" "$NOOP_OUT"
contains "noop deleted 0 events"   "DELETED_EVENTS: 0"   "$NOOP_OUT"
MID="$WORKDIR/mid.counts"
counts "$MID"
printf 'AFTER_NOOP: %s\n' "$(grep -m1 '^JSON ' "$MID" | cut -d' ' -f2-)"
check "noop sessions unchanged" "$(val "$MID" sessions)" "$(val "$BEFORE" sessions)"
check "noop events unchanged"   "$(val "$MID" events)"   "$(val "$BEFORE" events)"
check "noop seed child survives" "$(val "$MID" child_exists)" "1"
check "noop seed event survives" "$(val "$MID" child_evt)"    "1"
check "noop top-level survives"  "$(val "$MID" top_exists)"   "1"

# ---------------------------------------------------------------------------
# Phase 4 — POSITIVE: TTL=RETENTION_DAYS_OK -> seed child + event deleted.
# ---------------------------------------------------------------------------
printf '\n=== phase 4: positive TTL (RETENTION_DAYS=%s) on the COPY ===\n' "$RETENTION_DAYS_OK"
APPLY_OUT="$WORKDIR/apply.out"
run_apply "$RETENTION_DAYS_OK" "$APPLY_OUT"; arc=$?
printf -- '--- apply output ---\n'
cat "$APPLY_OUT"
check "apply exit code" "$arc" "0"
contains "apply reports DB is the copy" "DB: $DB_COPY" "$APPLY_OUT"
contains "apply wrote a backup" "BACKUP:" "$APPLY_OUT"
contains "apply integrity ok" "INTEGRITY_CHECK: ok" "$APPLY_OUT"
contains "apply foreign_key_check empty" "FOREIGN_KEY_CHECK: empty" "$APPLY_OUT"

DEL_SESS="$(field "$APPLY_OUT" DELETED_SESSIONS)"
DEL_EVT="$(field "$APPLY_OUT" DELETED_EVENTS)"
TOP_BEFORE="$(field "$APPLY_OUT" TOP_LEVEL_BEFORE)"
TOP_AFTER="$(field "$APPLY_OUT" TOP_LEVEL_AFTER)"
printf 'reported DELETED_SESSIONS=%s DELETED_EVENTS=%s TOP_LEVEL %s -> %s\n' "$DEL_SESS" "$DEL_EVT" "$TOP_BEFORE" "$TOP_AFTER"
[ "${DEL_SESS:-0}" -ge 1 ] 2>/dev/null && ok "at least one child session deleted ($DEL_SESS)" || bad "no child session deleted (got '$DEL_SESS')"
[ "${DEL_EVT:-0}" -ge 1 ] 2>/dev/null && ok "at least one event deleted ($DEL_EVT)" || bad "no event deleted (got '$DEL_EVT')"
check "apply top-level count unchanged" "$TOP_AFTER" "$TOP_BEFORE"

AFTER="$WORKDIR/after.counts"
counts "$AFTER"
printf 'AFTER_APPLY: %s\n' "$(grep -m1 '^JSON ' "$AFTER" | cut -d' ' -f2-)"
check "seed child gone"      "$(val "$AFTER" child_exists)" "0"
check "seed msgs cascaded"   "$(val "$AFTER" child_msgs)"   "0"
check "seed parts cascaded"  "$(val "$AFTER" child_parts)"  "0"
check "seed event gone"      "$(val "$AFTER" child_evt)"    "0"
check "known top-level survives" "$(val "$AFTER" top_exists)" "1"
check "known top-level msgs intact"  "$(val "$AFTER" top_msgs)"  "$(val "$BEFORE" top_msgs)"
check "known top-level parts intact" "$(val "$AFTER" top_parts)" "$(val "$BEFORE" top_parts)"

# exact before/after deltas match what the script reported.
SESS_DELTA=$(( $(val "$BEFORE" sessions) - $(val "$AFTER" sessions) ))
EVT_DELTA=$(( $(val "$BEFORE" events) - $(val "$AFTER" events) ))
check "exact session delta == DELETED_SESSIONS" "$SESS_DELTA" "$DEL_SESS"
check "exact event delta == DELETED_EVENTS" "$EVT_DELTA" "$DEL_EVT"
printf 'COUNTS before=%s after=%s\n' "$(grep -m1 '^JSON ' "$BEFORE" | cut -d' ' -f2-)" "$(grep -m1 '^JSON ' "$AFTER" | cut -d' ' -f2-)"

# ---------------------------------------------------------------------------
# Phase 5 — independent integrity + foreign_key_check on the final copy.
# ---------------------------------------------------------------------------
printf '\n=== phase 5: independent integrity + foreign_key_check on the copy ===\n'
FINAL="$(python3 - "$DB_COPY" <<'PY'
import sqlite3, sys
c = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
c.execute("PRAGMA query_only=ON")
integ = c.execute("PRAGMA integrity_check").fetchone()[0]
fk = c.execute("PRAGMA foreign_key_check").fetchall()
c.close()
print(f"integrity_check={integ}")
print(f"foreign_key_check={'empty' if not fk else fk}")
PY
)"
printf '%s\n' "$FINAL"
check "final integrity_check" "$(printf '%s\n' "$FINAL" | grep -m1 '^integrity_check=' | cut -d= -f2)" "ok"
check "final foreign_key_check" "$(printf '%s\n' "$FINAL" | grep -m1 '^foreign_key_check=' | cut -d= -f2)" "empty"

# ---------------------------------------------------------------------------
# Phase 6 — trap cleanup removes the copy + every backup.
# ---------------------------------------------------------------------------
printf '\n=== phase 6: temp cleanup ===\n'
BAK_COUNT="$(find "$WORKDIR" -maxdepth 1 -name 'opencode.db.bak-*' | wc -l | tr -d ' ')"
printf 'backups created in workdir: %s\n' "$BAK_COUNT"
[ "$BAK_COUNT" -ge 1 ] 2>/dev/null && ok "timestamped backup(s) existed ($BAK_COUNT)" || bad "no backup was created"
[ -f "$DB_COPY" ] && ok "copy exists before cleanup" || bad "copy missing before cleanup"
cleanup
if [ ! -e "$WORKDIR" ]; then ok "trap/cleanup removed workdir + copy + backups"; else bad "workdir still exists: $WORKDIR"; fi

printf '\n=== SUMMARY: %s passed, %s failed ===\n' "$PASS" "$FAIL"
if [ "$FAIL" -ne 0 ]; then
  printf '=== %s CHECK(S) FAILED ===\n' "$FAIL"
  exit 1
fi
printf '=== ALL CHECKS PASSED ===\n'
exit 0
