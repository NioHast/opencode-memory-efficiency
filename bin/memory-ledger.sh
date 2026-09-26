#!/usr/bin/env bash
# Read-only memory metering harness for opencode.
# Prints DB/WAL size, per-table bytes, top sessions, summary.diffs bytes,
# storage dir sizes, child/total session counts, and live process RSS/swap.
#
# Env overrides:
#   OPENCODE_DB    (default: $OPENCODE_HOME/opencode.db)
#   OPENCODE_HOME  (default: $HOME/.local/share/opencode)
#
# This script NEVER writes to the DB (read-only URI + PRAGMA query_only).
set -uo pipefail

OPENCODE_HOME="${OPENCODE_HOME:-$HOME/.local/share/opencode}"
DB="${OPENCODE_DB:-$OPENCODE_HOME/opencode.db}"

if [ ! -f "$DB" ]; then
  echo "memory-ledger: ERROR: DB file not found: $DB" >&2
  echo "memory-ledger: set OPENCODE_DB to a valid opencode SQLite database." >&2
  exit 1
fi

hr() { printf '==================== %s ====================\n' "$1"; }
human() { awk -v b="$1" 'BEGIN{ if(b>=1048576) printf "%.1f MB", b/1048576; else if(b>=1024) printf "%.1f KB", b/1024; else printf "%d B", b }'; }

echo "memory-ledger: db=$DB"
echo "memory-ledger: home=$OPENCODE_HOME"
echo

# ---------------- (a) DB file size + WAL size ----------------
hr "(a) DB FILE + WAL SIZE"
for f in "$DB" "$DB-wal" "$DB-shm"; do
  if [ -e "$f" ]; then
    sz=$(stat -c %s "$f" 2>/dev/null || echo 0)
    printf '  %-14s %12s bytes  (%s)\n' "$(basename "$f")" "$sz" "$(human "$sz")"
  else
    printf '  %-14s %12s\n' "$(basename "$f")" "(absent)"
  fi
done

# ---------------- (b,c,d,f) DB metrics ----------------
hr "(b) PER-TABLE ROWS + SUM(length(data))"
hr "(c) TOP 10 SESSIONS BY part+message BYTES"
hr "(d) summary.diffs UTF-8 BYTES"
hr "(f) CHILD / TOTAL SESSIONS"

python3 - "$DB" <<'PY'
import json, sqlite3, sys

path = sys.argv[1]
try:
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    cur = con.cursor()
    cur.execute("PRAGMA query_only=ON")
except Exception as e:
    print(f"memory-ledger: ERROR: cannot open DB read-only: {e}", file=sys.stderr)
    sys.exit(1)

def mb(n):
    return f"{n/1048576:.1f} MB"

# ---- (b) per-table ----
try:
    for t in ("part", "message", "event"):
        try:
            n, tot = cur.execute(
                f"SELECT COUNT(*), COALESCE(SUM(length(data)),0) FROM {t}"
            ).fetchone()
            print(f"  {t:10} rows={n:>9}  sum(length(data))={tot:>12} bytes  ({mb(tot)})")
        except Exception as e:
            print(f"  {t:10} (skip: {e})")
except Exception as e:
    print(f"  (table section error: {e})", file=sys.stderr)

print()

# ---- (c) top 10 sessions ----
try:
    q = """
    WITH pc AS (SELECT session_id, COUNT(*) c, COALESCE(SUM(length(data)),0) b
                FROM part GROUP BY session_id),
         mc AS (SELECT session_id, COUNT(*) c, COALESCE(SUM(length(data)),0) b
                FROM message GROUP BY session_id)
    SELECT s.id, COALESCE(s.title,''),
           COALESCE(pc.c,0) AS pcount, COALESCE(pc.b,0) AS pbytes,
           COALESCE(mc.c,0) AS mcount, COALESCE(mc.b,0) AS mbytes,
           COALESCE(pc.b,0)+COALESCE(mc.b,0) AS total
    FROM session s
    LEFT JOIN pc ON pc.session_id = s.id
    LEFT JOIN mc ON mc.session_id = s.id
    ORDER BY total DESC
    LIMIT 10
    """
    rows = cur.execute(q).fetchall()
    print(f"  {'total':>10} {'partB':>10} {'msgB':>10} {'part#':>7} {'msg#':>7}  session_id  title")
    for sid, title, pcount, pbytes, mcount, mbytes, total in rows:
        print(f"  {total:>10} {pbytes:>10} {mbytes:>10} {pcount:>7} {mcount:>7}  {sid[:30]}  {title[:40]}")
except Exception as e:
    print(f"  (top-session query error: {e})", file=sys.stderr)

print()

# ---- (d) summary.diffs utf-8 bytes ----
try:
    total_patch = total_ba = 0
    per_session = {}
    for sid, data in cur.execute("SELECT session_id, data FROM message"):
        if not data or "summary" not in data:
            continue
        try:
            obj = json.loads(data)
        except Exception:
            continue
        if not isinstance(obj, dict):
            continue
        summary = obj.get("summary")
        if not isinstance(summary, dict):
            continue
        diffs = summary.get("diffs")
        if not isinstance(diffs, list):
            continue
        pbytes = babytes = 0
        for d in diffs:
            if not isinstance(d, dict):
                continue
            patch = d.get("patch")
            if isinstance(patch, str):
                pbytes += len(patch.encode("utf-8"))
            for key in ("before", "after"):
                v = d.get(key)
                if isinstance(v, str):
                    babytes += len(v.encode("utf-8"))
        if pbytes or babytes:
            total_patch += pbytes
            total_ba += babytes
            rec = per_session.setdefault(sid, [0, 0])
            rec[0] += pbytes
            rec[1] += babytes

    print(f"  TOTAL patch bytes              = {total_patch} ({mb(total_patch)})")
    print(f"  TOTAL before+after bytes       = {total_ba} ({mb(total_ba)})")
    print(f"  GRAND TOTAL (patch+ba)         = {total_patch+total_ba} ({mb(total_patch+total_ba)})")
    print("  Per-session (descending):")
    ordered = sorted(per_session.items(), key=lambda kv: (kv[1][0] + kv[1][1]), reverse=True)
    if not ordered:
        print("    (none)")
    for sid, (pbytes, babytes) in ordered:
        print(f"    {sid[:34]:34} patch={pbytes:>10}  before+after={babytes:>10}  total={pbytes+babytes:>10}")
except Exception as e:
    print(f"  (summary.diffs scan error: {e})", file=sys.stderr)

print()

# ---- (f) child / total sessions ----
try:
    child = cur.execute("SELECT COUNT(*) FROM session WHERE parent_id IS NOT NULL").fetchone()[0]
    total = cur.execute("SELECT COUNT(*) FROM session").fetchone()[0]
    print(f"  child sessions (parent_id IS NOT NULL) = {child}")
    print(f"  total sessions                         = {total}")
except Exception as e:
    print(f"  (session count error: {e})", file=sys.stderr)

con.close()
PY
db_rc=$?
if [ "$db_rc" -ne 0 ]; then
  exit "$db_rc"
fi

echo

# ---------------- (e) directory sizes ----------------
hr "(e) STORAGE DIRECTORY SIZES (du -sb)"
for d in storage/session_diff snapshot tool-output; do
  p="$OPENCODE_HOME/$d"
  if [ -e "$p" ]; then
    sz=$(du -sb "$p" 2>/dev/null | awk '{print $1}')
    printf '  %-28s %12s bytes  (%s)\n' "$d" "$sz" "$(human "$sz")"
  else
    printf '  %-28s %12s\n' "$d" "(absent)"
  fi
done

echo

# ---------------- (g) live processes ----------------
hr "(g) LIVE OPENCODE PROCESS MEMORY"
found=0
for pid in $(pgrep -x opencode 2>/dev/null); do
  found=1
  echo "  PID $pid:"
  if [ -r "/proc/$pid/status" ]; then
    grep -E '^(VmRSS|VmHWM|VmSwap):' "/proc/$pid/status" 2>/dev/null | sed 's/^/    /'
  fi
  if [ -r "/proc/$pid/statm" ]; then
    printf '    statm: %s\n' "$(cat "/proc/$pid/statm" 2>/dev/null)"
  fi
done
if [ "$found" = 0 ]; then
  echo "  opencode not running"
fi

echo
echo "memory-ledger: done (read-only)"
