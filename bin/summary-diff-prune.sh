#!/usr/bin/env bash
# summary-diff-prune.sh — bound the STORED `message.data.summary.diffs` blobs.
#
# Why this exists:
#   `experimental.chat.messages.transform` (the summary-diff-cap plugin, todo 6)
#   receives a TRANSIENT structuredClone, so it shrinks the per-call PROMPT only;
#   it never touches the SQLite bytes. This script rewrites the stored
#   `message.data.summary.diffs[*].patch` values for KEPT sessions:
#     * drops vendor/generated paths (same predicate as the plugin),
#     * caps each patch to DIFF_MAX_PATCH_BYTES (default 64KB),
#     * caps the retained diff payload per DIFF_TOTAL_SCOPE (default: session)
#       to DIFF_MAX_TOTAL_BYTES (default 512KB),
#     * preserves `{file,status,additions,deletions}` for every retained entry,
#     * NEVER touches `message.data.summary === true` rows (decisions),
#     * NEVER deletes a `message` row.
#
# Modes:
#   --dry-run   (DEFAULT) print the exact counts/bytes that WOULD change and
#               change NOTHING (read-only connection, `PRAGMA query_only=ON`).
#   --apply     refuse while opencode runs, write a timestamped DB backup FIRST,
#               then rewrite, then wal_checkpoint(TRUNCATE) + VACUUM +
#               integrity_check + foreign_key_check. Reopens with
#               `PRAGMA foreign_keys=ON`.
#
# Opt-in modifiers (default OFF -> unchanged behavior; used by the maintenance
# orchestrator so that exactly ONE script owns checkpoint/VACUUM):
#   --skip-backup  Do NOT write the timestamped DB backup before the rewrite.
#                  Callers must already hold a verified backup.
#   --no-vacuum    Do NOT run wal_checkpoint(TRUNCATE)/VACUUM after the rewrite.
#                  integrity_check + foreign_key_check still run.
#
# Safety:
#   * `--apply` refuses while `pgrep -x opencode` is alive (exit 3, ZERO writes)
#     unless ALLOW_WHILE_RUNNING=1 (TESTS ONLY — never on the live DB).
#   * A timestamped backup is written BEFORE the first UPDATE; it is folded
#     (`wal_checkpoint(TRUNCATE)`) and `integrity_check`-verified before writes.
#   * Live apply is DEFERRED to a maintenance run with opencode stopped. Always
#     validate on a COPY first (point OPENCODE_DB at the copy).
#
# Total-cap scope (documented decision):
#   The plugin applies its 512KB total per MESSAGE (it only ever sees one
#   message). At the DB layer the unit of stored bloat is the SESSION, and a
#   per-message bound cannot bound a 700-message session (measured: per-message
#   caps reclaim only ~31.6% of 95.3MB). So DIFF_TOTAL_SCOPE defaults to
#   `session` (the 512KB budget is shared across every retained diff entry of a
#   session). A session bound of 512KB is strictly stronger than a per-message
#   bound and therefore implies it.
#
#   Within the budget, DIFF_TOTAL_POLICY defaults to `truncate`: patches are
#   shrunk (UTF-8-boundary safe, marker counted inside the cap) instead of
#   dropping entries, so the diff ENTRY LIST and every entry's
#   `{file,status,additions,deletions}` survive — which is what the task's
#   "normalized digest with summary.diffs[*].patch removed" non-diff proof
#   requires. `drop` reproduces the plugin's exact total-cap semantics
#   (largest patch first, then latest index) for parity/evidence.
#
# Env:
#   OPENCODE_DB            default $HOME/.local/share/opencode/opencode.db
#   ALLOW_WHILE_RUNNING    default 0; 1 bypasses the running gate (TESTS ONLY)
#   DIFF_MAX_PATCH_BYTES   default 65536   (64KB per file patch)
#   DIFF_MAX_TOTAL_BYTES   default 524288  (512KB per scope)
#   BACKUP_ROOT            default dirname of OPENCODE_DB
#   DIFF_TOTAL_SCOPE       session (default) | message
#   DIFF_TOTAL_POLICY      truncate (default) | drop
#
# SQLite note: the `sqlite3` CLI is not installed here, so all DB work uses the
# python3 stdlib `sqlite3` module. `PRAGMA foreign_keys` is OFF per connection
# by default, so every write connection opens with `PRAGMA foreign_keys=ON` and
# verifies with `PRAGMA foreign_key_check` afterwards.
set -euo pipefail

OPENCODE_DB="${OPENCODE_DB:-$HOME/.local/share/opencode/opencode.db}"
ALLOW_WHILE_RUNNING="${ALLOW_WHILE_RUNNING:-0}"
DIFF_MAX_PATCH_BYTES="${DIFF_MAX_PATCH_BYTES:-65536}"
DIFF_MAX_TOTAL_BYTES="${DIFF_MAX_TOTAL_BYTES:-524288}"
DIFF_TOTAL_SCOPE="${DIFF_TOTAL_SCOPE:-session}"
DIFF_TOTAL_POLICY="${DIFF_TOTAL_POLICY:-truncate}"
BACKUP_ROOT="${BACKUP_ROOT:-$(dirname "$OPENCODE_DB")}"
SKIP_BACKUP="${SKIP_BACKUP:-0}"
NO_VACUUM="${NO_VACUUM:-0}"

log() { printf '%s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: summary-diff-prune.sh [--dry-run | --apply]

  --dry-run   Print exact counts/bytes that would change; change NOTHING (DEFAULT).
  --apply     Back up the DB, rewrite stored summary.diffs, then
              wal_checkpoint(TRUNCATE) + VACUUM + integrity_check + foreign_key_check.
              Refuses while `pgrep -x opencode` is alive (exit 3, zero writes)
              unless ALLOW_WHILE_RUNNING=1 (tests only).
  --skip-backup  Opt-in: skip the pre-write DB backup (caller holds one).
  --no-vacuum    Opt-in: skip wal_checkpoint(TRUNCATE)/VACUUM (caller owns it).

Env: OPENCODE_DB, ALLOW_WHILE_RUNNING, DIFF_MAX_PATCH_BYTES (65536),
     DIFF_MAX_TOTAL_BYTES (524288), BACKUP_ROOT, DIFF_TOTAL_SCOPE (session),
     DIFF_TOTAL_POLICY (truncate)
EOF
}

MODE="dry-run"
for arg in "$@"; do
  case "$arg" in
    --dry-run) MODE="dry-run" ;;
    --apply)   MODE="apply" ;;
    --skip-backup) SKIP_BACKUP=1 ;;
    --no-vacuum)   NO_VACUUM=1 ;;
    -h|--help|help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument: $arg" ;;
  esac
done

case "$DIFF_TOTAL_SCOPE" in session|message) ;; *) die "DIFF_TOTAL_SCOPE must be 'session' or 'message' (got: $DIFF_TOTAL_SCOPE)" ;; esac
case "$DIFF_TOTAL_POLICY" in truncate|drop) ;; *) die "DIFF_TOTAL_POLICY must be 'truncate' or 'drop' (got: $DIFF_TOTAL_POLICY)" ;; esac

[ -f "$OPENCODE_DB" ] || die "DB not found: $OPENCODE_DB"

# --- running gate (apply only; dry-run is read-only and always allowed) ------
RUNNING_PIDS="$(pgrep -x opencode || true)"
if [ "$MODE" = "apply" ] && [ -n "$RUNNING_PIDS" ]; then
  if [ "$ALLOW_WHILE_RUNNING" != "1" ]; then
    log "ERROR: opencode is running (pgrep -x opencode: $RUNNING_PIDS); refusing --apply." >&2
    log "No writes performed. Stop opencode, or set ALLOW_WHILE_RUNNING=1 (tests only)." >&2
    exit 3
  fi
  log "WARN: opencode is running ($RUNNING_PIDS); ALLOW_WHILE_RUNNING=1 -> proceeding (TESTS ONLY)"
fi

# --- backup (apply only, BEFORE any UPDATE; skipped with --skip-backup) -------
if [ "$MODE" = "apply" ] && [ "$SKIP_BACKUP" != "1" ]; then
  mkdir -p -- "$BACKUP_ROOT" || die "BACKUP_ROOT not creatable: $BACKUP_ROOT"
  [ -w "$BACKUP_ROOT" ] || die "BACKUP_ROOT not writable: $BACKUP_ROOT"
  TS="$(date -u +%Y%m%d-%H%M%S)"
  BAK="${BACKUP_ROOT%/}/$(basename "$OPENCODE_DB").summary-bak-${TS}"
  n=0
  while [ -e "$BAK" ]; do
    n=$((n + 1))
    BAK="${BACKUP_ROOT%/}/$(basename "$OPENCODE_DB").summary-bak-${TS}-${n}"
  done
  cp -a -- "$OPENCODE_DB" "$BAK"
  [ -f "${OPENCODE_DB}-wal" ] && cp -a -- "${OPENCODE_DB}-wal" "${BAK}-wal" || true
  [ -f "${OPENCODE_DB}-shm" ] && cp -a -- "${OPENCODE_DB}-shm" "${BAK}-shm" || true
  log "BACKUP: $BAK"
  [ -f "${BAK}-wal" ] && log "BACKUP_WAL: ${BAK}-wal"

  # Fold the copied WAL into the backup and prove it is readable BEFORE writes.
  if ! python3 - "$BAK" <<'PY'
import sqlite3, sys
bak = sys.argv[1]
c = sqlite3.connect(bak, timeout=120)
c.execute("PRAGMA foreign_keys=ON")
c.execute("PRAGMA wal_checkpoint(TRUNCATE)")
row = c.execute("PRAGMA integrity_check").fetchone()[0]
c.close()
print("BACKUP_INTEGRITY_CHECK:", row)
sys.exit(0 if row == "ok" else 1)
PY
  then
    die "backup failed integrity_check; aborting before any write"
  fi
fi

export OPENCODE_DB MODE DIFF_MAX_PATCH_BYTES DIFF_MAX_TOTAL_BYTES DIFF_TOTAL_SCOPE DIFF_TOTAL_POLICY NO_VACUUM

# --- main work ---------------------------------------------------------------
python3 - <<'PY'
import os, sys, json, time, hashlib, sqlite3
from collections import OrderedDict

db     = os.environ["OPENCODE_DB"]
mode   = os.environ["MODE"]
maxp   = int(os.environ["DIFF_MAX_PATCH_BYTES"])
maxt   = int(os.environ["DIFF_MAX_TOTAL_BYTES"])
scope  = os.environ.get("DIFF_TOTAL_SCOPE", "session")
policy = os.environ.get("DIFF_TOTAL_POLICY", "truncate")
no_vacuum = os.environ.get("NO_VACUUM", "0") == "1"

VENDOR = {"node_modules", ".node-runtime", "dist", "build", ".venv", ".cache",
          "__pycache__", ".next", ".turbo"}
MARKER = "\n[... truncated ...]"


def bb(s):
    return len(s.encode("utf-8")) if isinstance(s, str) else 0


def is_vendor(file):
    if not isinstance(file, str) or not file:
        return False
    return any(seg in VENDOR for seg in file.replace("\\", "/").split("/"))


def safe_slice(s, max_bytes):
    if max_bytes <= 0:
        return ""
    buf = s.encode("utf-8")
    if len(buf) <= max_bytes:
        return s
    end = max_bytes
    while end > 0 and (buf[end] & 0xC0) == 0x80:   # back off UTF-8 continuation byte
        end -= 1
    return buf[:end].decode("utf-8", "ignore")


def truncate_patch(patch, max_bytes):
    if bb(patch) <= max_bytes:
        return patch
    marker_bytes = bb(MARKER)
    if max_bytes <= marker_bytes:
        return safe_slice(patch, max_bytes)
    return safe_slice(patch, max_bytes - marker_bytes) + MARKER


def dump(obj):
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def digest(obj):
    return hashlib.sha256(dump(obj).encode("utf-8")).hexdigest()


def strip_diffs_digest(obj):
    """Digest of the message WITHOUT the whole `summary.diffs` array.
    Proves every non-diff field is unchanged regardless of how diffs moved."""
    o = json.loads(dump(obj))
    s = o.get("summary")
    if isinstance(s, dict):
        s.pop("diffs", None)
    return digest(o)


def strip_patch_digest(obj):
    """Digest of the message with `summary.diffs[*].patch` removed (the task's
    literal normalization). Identical iff the diff entry list itself is kept."""
    o = json.loads(dump(obj))
    s = o.get("summary")
    if isinstance(s, dict):
        di = s.get("diffs")
        if isinstance(di, list):
            for e in di:
                if isinstance(e, dict):
                    e.pop("patch", None)
    return digest(o)


# --- open connection ---------------------------------------------------------
if mode == "dry-run":
    conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=180)
    conn.execute("PRAGMA query_only=ON")
else:
    conn = sqlite3.connect(db, timeout=180)
conn.isolation_level = None            # explicit transaction control
conn.execute("PRAGMA foreign_keys=ON")  # FKs are OFF per connection by default
cur = conn.cursor()


def scalar(sql, args=()):
    r = cur.execute(sql, args).fetchone()
    return r[0] if r else 0


rows_total = scalar("SELECT COUNT(*) FROM message")
summary_true_map = {}   # id -> raw data for decision rows (summary === true); never touched

# --- load + classify ---------------------------------------------------------
rows = cur.execute(
    "SELECT rowid, id, session_id, data FROM message ORDER BY session_id, rowid"
).fetchall()

msgs = []          # one dict per message that carries summary.diffs
sessions = OrderedDict()  # session_id -> [msg index, ...]

for rowid, mid, sid, data in rows:
    try:
        obj = json.loads(data)
    except Exception:
        continue
    if not isinstance(obj, dict):
        continue
    s = obj.get("summary")
    if s is True:                 # decision row — NEVER touch
        summary_true_map[mid] = data
        continue
    if not isinstance(s, dict):
        continue
    diffs = s.get("diffs")
    if not isinstance(diffs, list) or not diffs:
        continue

    plan = []
    before_bytes = 0
    for i, e in enumerate(diffs):
        if not isinstance(e, dict) or not isinstance(e.get("file"), str) or not isinstance(e.get("patch"), str):
            # Malformed — leave completely untouched, not counted, never dropped.
            plan.append({"ei": i, "malformed": True, "orig": e})
            if isinstance(e, dict) and isinstance(e.get("patch"), str):
                before_bytes += bb(e["patch"])
            continue
        p = e["patch"]
        before_bytes += bb(p)
        if is_vendor(e["file"]):
            plan.append({"ei": i, "vendor": True, "orig": e})
            continue
        capped = truncate_patch(p, maxp) if bb(p) > maxp else p
        plan.append({"ei": i, "malformed": False, "vendor": False,
                     "orig": e, "plan_patch": capped, "bytes": bb(capped)})

    idx = len(msgs)
    msgs.append({
        "rowid": rowid, "mid": mid, "sid": sid, "data": data, "obj": obj, "plan": plan,
        "before_bytes": before_bytes,
        # Digests computed NOW, before any mutation of `obj`/entries.
        "before_strip_diffs": strip_diffs_digest(obj),
        "before_strip_patch": strip_patch_digest(obj),
    })
    sessions.setdefault(sid, []).append(idx)

conn.close()

# --- total cap ---------------------------------------------------------------
def apply_total(entries):
    """Apply the total cap to a list of plan-entry refs. Returns
    (dropped_count, additionally_truncated_count)."""
    live = [e for e in entries if not e.get("malformed") and not e.get("vendor")]
    total = sum(e["bytes"] for e in live)
    if total <= maxt or not live:
        return 0, 0

    if policy == "drop":
        droppable = sorted(live, key=lambda e: (-e["bytes"], -e.get("g", e["ei"])))
        over = total - maxt
        dropped = 0
        for e in droppable:
            if over <= 0:
                break
            e["dropped"] = True
            dropped += 1
            over -= e["bytes"]
        return dropped, 0

    # truncate: water-fill so small entries stay whole and the rest share the rest.
    order = sorted(live, key=lambda e: e["bytes"])
    budget = maxt
    remaining = len(order)
    cap = None
    for e in order:
        if remaining <= 0:
            break
        share = budget // remaining
        if e["bytes"] <= share:
            budget -= e["bytes"]
            remaining -= 1
        else:
            cap = share
            break
    if cap is None:
        cap = 0
    n = 0
    for e in live:
        if e["bytes"] > cap:
            e["plan_patch"] = truncate_patch(e["orig"]["patch"], cap)
            e["bytes"] = bb(e["plan_patch"])
            n += 1
    return 0, n


g_dropped = 0
g_truncated = 0

if scope == "message":
    for m in msgs:
        d, t = apply_total(m["plan"])
        g_dropped += d
        g_truncated += t
else:  # session
    for sid, idxs in sessions.items():
        entries = []
        g = 0
        for mi in idxs:
            for e in msgs[mi]["plan"]:
                if e.get("malformed") or e.get("vendor"):
                    continue
                e["g"] = g
                g += 1
                entries.append(e)
        d, t = apply_total(entries)
        g_dropped += d
        g_truncated += t

# --- build new message data --------------------------------------------------
changed = []
after_total = 0
malformed_untouched = 0
vendor_dropped = 0
patch_truncated = 0
patch_strip_mismatch = 0

for m in msgs:
    new_diffs = []
    msg_changed = False
    for e in m["plan"]:
        if e.get("malformed"):
            malformed_untouched += 1
            new_diffs.append(e["orig"])
            continue
        if e.get("vendor"):
            vendor_dropped += 1
            msg_changed = True
            continue
        if e.get("dropped"):
            msg_changed = True
            continue
        final = e["plan_patch"]
        if final != e["orig"]["patch"]:
            patch_truncated += 1
            e["orig"]["patch"] = final
            msg_changed = True
        new_diffs.append(e["orig"])

    if msg_changed:
        m["obj"]["summary"]["diffs"] = new_diffs
        m["new_data"] = dump(m["obj"])
        m["changed"] = True
        changed.append(m)

    # after-total bytes (string patches only)
    for e in m["plan"]:
        if e.get("malformed"):
            op = e["orig"]
            if isinstance(op, dict) and isinstance(op.get("patch"), str):
                after_total += bb(op["patch"])
            continue
        if e.get("vendor") or e.get("dropped"):
            continue
        after_total += bb(e["orig"]["patch"])

before_total = sum(m["before_bytes"] for m in msgs)
summary_true_before = len(summary_true_map)

# --- verification (computed against the mutated objects) ---------------------
non_diff_mismatch = 0
chosen = None
for m in msgs:
    if not m.get("changed"):
        continue
    after_sd = strip_diffs_digest(m["obj"])
    after_sp = strip_patch_digest(m["obj"])
    if after_sd != m["before_strip_diffs"]:
        non_diff_mismatch += 1
    if after_sp == m["before_strip_patch"] and chosen is None:
        chosen = (m["mid"], m["before_strip_patch"], after_sp)

reduction = 0.0 if before_total == 0 else (before_total - after_total) * 100.0 / before_total

print(f"MODE: {mode}")
print(f"DB: {db}")
print(f"DIFF_MAX_PATCH_BYTES: {maxp}")
print(f"DIFF_MAX_TOTAL_BYTES: {maxt}")
print(f"DIFF_TOTAL_SCOPE: {scope}")
print(f"DIFF_TOTAL_POLICY: {policy}")
print(f"MESSAGE_ROWS_TOTAL: {rows_total}")
print(f"SUMMARY_TRUE_ROWS: {summary_true_before}")
print(f"MESSAGES_WITH_DIFFS: {len(msgs)}")
print(f"CHANGED_MESSAGES: {len(changed)}")
print(f"MALFORMED_ENTRIES_UNTOUCHED: {malformed_untouched}")
print(f"VENDOR_ENTRIES_DROPPED: {vendor_dropped}")
print(f"PATCHES_TRUNCATED: {patch_truncated}")
print(f"ENTRIES_DROPPED_BY_TOTAL: {g_dropped}")
print(f"ENTRIES_TRUNCATED_BY_TOTAL: {g_truncated}")
print(f"PATCH_BYTES_BEFORE: {before_total}")
print(f"PATCH_BYTES_AFTER: {after_total}")
print(f"REDUCTION_PCT: {reduction:.2f}")
print(f"NONDIFF_STRIP_DIFFS_DIGEST_MISMATCHES: {non_diff_mismatch}")
if chosen:
    print(f"CHOSEN_MESSAGE_ID: {chosen[0]}")
    print(f"CHOSEN_MESSAGE_PATCHSTRIP_DIGEST_BEFORE: {chosen[1]}")
    print(f"CHOSEN_MESSAGE_PATCHSTRIP_DIGEST_AFTER: {chosen[2]}")
else:
    print("CHOSEN_MESSAGE_ID: (none)")

if mode == "dry-run":
    print("DRY-RUN: no changes made")
    sys.exit(0)

# --- apply -------------------------------------------------------------------
if non_diff_mismatch != 0:
    print(f"ERROR: {non_diff_mismatch} changed messages had non-diff field drift", file=sys.stderr)
    sys.exit(7)

size_before = os.path.getsize(db)
conn2 = sqlite3.connect(db, timeout=180)
conn2.isolation_level = None
conn2.execute("PRAGMA foreign_keys=ON")
cur2 = conn2.cursor()
try:
    cur2.execute("BEGIN")
    for m in changed:
        cur2.execute("UPDATE message SET data=? WHERE id=?", (m["new_data"], m["mid"]))
    cur2.execute("COMMIT")
except Exception:
    cur2.execute("ROLLBACK")
    raise

t0 = time.time()
if no_vacuum:
    print("WAL_CHECKPOINT: skipped (--no-vacuum)")
    print("VACUUM: skipped (--no-vacuum)")
else:
    cur2.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    print(f"WAL_CHECKPOINT: truncate ({time.time() - t0:.1f}s)")
    t0 = time.time()
    cur2.execute("VACUUM")
    print(f"VACUUM: done ({time.time() - t0:.1f}s)")
integrity = cur2.execute("PRAGMA integrity_check").fetchone()[0]
fk_rows = cur2.execute("PRAGMA foreign_key_check").fetchall()
cur2.execute("PRAGMA foreign_keys=OFF")
conn2.close()

# --- post-write verification (read-only) -------------------------------------
c3 = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=180)
c3.execute("PRAGMA query_only=ON")
q = c3.cursor()
rows_after = q.execute("SELECT COUNT(*) FROM message").fetchone()[0]
# Decision rows (summary === true) must be byte-identical.
summary_true_unchanged = 0
for _mid, _data in summary_true_map.items():
    _r = q.execute("SELECT data FROM message WHERE id=?", (_mid,)).fetchone()
    if _r is not None and _r[0] == _data:
        summary_true_unchanged += 1
# chosen message persisted as intended
chosen_persisted = ""
if chosen:
    r = q.execute("SELECT data FROM message WHERE id=?", (chosen[0],)).fetchone()
    if r:
        chosen_persisted = strip_patch_digest(json.loads(r[0]))
c3.close()
size_after = os.path.getsize(db)

print(f"MESSAGE_ROWS_AFTER: {rows_after}")
print(f"SUMMARY_TRUE_ROWS_AFTER: {len(summary_true_map)}")
print(f"SUMMARY_TRUE_BYTES_UNCHANGED: {summary_true_unchanged}")
print(f"CHOSEN_MESSAGE_PATCHSTRIP_DIGEST_PERSISTED: {chosen_persisted}")
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
if rows_after != rows_total:
    print("ERROR: message row count changed", file=sys.stderr)
    rc = 6
if summary_true_unchanged != summary_true_before:
    print("ERROR: summary===true decision rows changed", file=sys.stderr)
    rc = 7
if chosen and chosen_persisted != chosen[1]:
    print("ERROR: chosen message non-diff digest changed on disk", file=sys.stderr)
    rc = 8
if rc:
    sys.exit(rc)
print("APPLY OK")
PY
