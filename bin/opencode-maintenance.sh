#!/usr/bin/env bash
# opencode-maintenance.sh — maintenance orchestrator for opencode.
#
# Modes:
#   --mode=safe   (DEFAULT, for cron) metering + backup ONLY. Never applies a
#                 destructive step and never vacuums, even while opencode runs.
#   --mode=full   metering + backup, then — ONLY when `pgrep -x opencode` is
#                 empty AND free disk is sufficient — the destructive sequence:
#                   1. db-retention.sh --apply
#                        (single owner of wal_checkpoint(TRUNCATE) + VACUUM;
#                         also writes its own verified pre-delete backup)
#                   2. summary-diff-prune.sh --apply --no-vacuum --skip-backup
#                   3. storage-prune.sh --apply
#                   4. mega-session-export-delete.sh --apply --no-vacuum --skip-backup
#                 then exactly ONE summary line appended to $LOG_FILE.
#                 step 1 is first so it is still the only VACUUM owner; steps
#                 2 and 4 mutate data and intentionally do NOT checkpoint/vacuum.
#   --dry-run     Print the exact planned sequence and apply NOTHING. For
#                 --mode=full it also runs each destuctive script's read-only
#                 dry-run to list the exact rows/paths that would be removed.
#
# Running gate: the destructive sequence never starts while `pgrep -x opencode`
# is non-empty; it logs reason=opencode_running and exits 0. Children are also
# invoked with ALLOW_WHILE_RUNNING=0 as defense in depth.
#
# Disk guard: before the destructive sequence, free space on $OPENCODE_HOME must
# be >= 3x the DB size + $DISK_MARGIN_KB (the orchestrator backup, the retention
# backup, and VACUUM scratch). Otherwise the sequence is skipped with
# reason=insufficient_disk.
#
# Backup is best-effort: `sqlite3` CLI is not installed, so backup-rollback.sh
# copies the DB (+WAL/SHM) with `cp`. While opencode is writing this copy is
# non-atomic; a backup failure is logged but never fails the run. In --mode=full
# db-retention.sh additionally writes (and integrity-checks) its own backup
# before deleting, so the destructive path always has a verified snapshot.
#
# Env overrides (tests point these at temp paths so live state is never touched):
#   OPENCODE_HOME      default ${HOME}/.local/share/opencode
#   OPENCODE_DB        default $OPENCODE_HOME/opencode.db
#   BACKUP_ROOT        default $OPENCODE_HOME/backups
#   CONFIG_DIR         default ${HOME}/.config/opencode (also passed to backup-rollback)
#   OMO_JSONC          passed through to backup-rollback.sh when set
#   LOG_FILE           default $CONFIG_DIR/logs/maintenance.log
#   EXPORT_DIR         default $OPENCODE_HOME/exports (passed to mega-* when set)
#   RETENTION_DAYS     default 2 (passed to db-retention.sh)
#   DISK_MARGIN_KB     default 262144 (256MB slack on top of 3x DB size)
#   BIN_DIR            dir of the sibling scripts; default = this script's directory
#
# Safety invariants:
#   * No `--apply` runs while `pgrep -x opencode` is alive.
#   * Exactly ONE script (db-retention.sh) owns checkpoint/VACUUM; the other
#     destructive scripts are passed --no-vacuum.
#   * No independent VACUUM ever runs.
set -uo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="${BIN_DIR:-$SCRIPT_DIR}"

CONFIG_DIR="${CONFIG_DIR:-$HOME/.config/opencode}"
OPENCODE_HOME="${OPENCODE_HOME:-$HOME/.local/share/opencode}"
OPENCODE_DB="${OPENCODE_DB:-$OPENCODE_HOME/opencode.db}"
BACKUP_ROOT="${BACKUP_ROOT:-$OPENCODE_HOME/backups}"
LOG_FILE="${LOG_FILE:-$CONFIG_DIR/logs/maintenance.log}"
EXPORT_DIR="${EXPORT_DIR:-$OPENCODE_HOME/exports}"
RETENTION_DAYS="${RETENTION_DAYS:-2}"
DISK_MARGIN_KB="${DISK_MARGIN_KB:-262144}"

METER_SH="$BIN_DIR/memory-ledger.sh"
BACKUP_SH="$BIN_DIR/backup-rollback.sh"
RETENTION_SH="$BIN_DIR/db-retention.sh"
SUMMARY_SH="$BIN_DIR/summary-diff-prune.sh"
STORAGE_SH="$BIN_DIR/storage-prune.sh"
MEGA_SH="$BIN_DIR/mega-session-export-delete.sh"

export OPENCODE_HOME OPENCODE_DB BACKUP_ROOT CONFIG_DIR EXPORT_DIR RETENTION_DAYS
[ -n "${OMO_JSONC:-}" ] && export OMO_JSONC

MODE="safe"
DRY_RUN=0

usage() {
  cat <<'EOF'
Usage: opencode-maintenance.sh [--mode=safe|full] [--dry-run]

  --mode=safe   (DEFAULT) metering + backup only; safe for cron.
  --mode=full   metering + backup, then the destructive sequence ONLY when
                opencode is stopped and disk is sufficient.
  --dry-run     Print the planned sequence; apply nothing.

Env: OPENCODE_HOME, OPENCODE_DB, BACKUP_ROOT, CONFIG_DIR, OMO_JSONC, LOG_FILE,
     EXPORT_DIR, RETENTION_DAYS, DISK_MARGIN_KB, BIN_DIR
EOF
}

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --mode=safe) MODE="safe"; shift ;;
    --mode=full) MODE="full"; shift ;;
    --mode)
      shift
      [ $# -gt 0 ] || die "--mode requires 'safe' or 'full'"
      case "$1" in
        safe|full) MODE="$1" ;;
        *) die "--mode must be 'safe' or 'full' (got: $1)" ;;
      esac
      shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help|help) usage; exit 0 ;;
    *) usage >&2; die "unknown argument: $1" ;;
  esac
done

TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
TMPD="$(mktemp -d "${TMPDIR:-/tmp}/opencode-maint.XXXXXX")"
cleanup() { rm -rf -- "$TMPD"; }
trap cleanup EXIT

say() { printf '%s\n' "$*"; }

running_pids="$(pgrep -x opencode 2>/dev/null || true)"
running_pid="${running_pids%%$'\n'*}"
opencode_running=0
[ -n "$running_pids" ] && opencode_running=1

db_bytes=0
avail_kb=0
need_kb=0
disk_ok=1
eval_disk() {
  db_bytes="$(stat -c %s -- "$OPENCODE_DB" 2>/dev/null || echo 0)"
  need_kb=$(( db_bytes / 1024 * 3 + DISK_MARGIN_KB ))
  avail_kb="$(df -Pk -- "$OPENCODE_HOME" 2>/dev/null | awk 'NR==2{print $4}')"
  [ -n "$avail_kb" ] || avail_kb=0
  if [ "$avail_kb" -ge "$need_kb" ]; then disk_ok=1; else disk_ok=0; fi
}

# ---------------------------------------------------------------------------
# dry-run — print the plan; for full also list the exact read-only deletes
# ---------------------------------------------------------------------------
if [ "$DRY_RUN" -eq 1 ]; then
  say "maintenance: DRY-RUN mode=$MODE (nothing will be applied)"
  say "plan: metering -> $METER_SH"
  say "plan: backup   -> $BACKUP_SH backup   (best-effort; non-atomic while opencode runs)"
  if [ "$MODE" = "full" ]; then
    eval_disk
    say "plan: full-gate opencode_running=$opencode_running pid=${running_pid:-none}"
    say "plan: disk_guard avail_kb=$avail_kb need_kb=$need_kb ok=$disk_ok"
    if [ "$opencode_running" -eq 1 ]; then
      say "plan: destructive steps SKIPPED reason=opencode_running"
    elif [ "$disk_ok" -eq 0 ]; then
      say "plan: destructive steps SKIPPED reason=insufficient_disk"
    else
      say "plan: db-retention.sh --apply"
      say "plan: summary-diff-prune.sh --apply --no-vacuum --skip-backup"
      say "plan: storage-prune.sh --apply"
      say "plan: mega-session-export-delete.sh --apply --no-vacuum --skip-backup"
    fi
    say "plan: exactly ONE summary log line -> $LOG_FILE"
    say "--- exact delete plan (read-only dry-runs) ---"
    if [ "$opencode_running" -eq 1 ]; then
      say "note: opencode running -> a real --mode=full would skip these steps;"
      say "      read-only plans are shown anyway to document the exact deletes."
    fi
    if [ -x "$RETENTION_SH" ]; then
      say "== db-retention.sh --dry-run =="
      "$RETENTION_SH" --dry-run || true
    fi
    if [ -x "$SUMMARY_SH" ]; then
      say "== summary-diff-prune.sh --dry-run =="
      "$SUMMARY_SH" --dry-run || true
    fi
    if [ -x "$STORAGE_SH" ]; then
      say "== storage-prune.sh --dry-run =="
      "$STORAGE_SH" --dry-run || true
    fi
    if [ -x "$MEGA_SH" ]; then
      say "== mega-session-export-delete.sh --plan-only =="
      "$MEGA_SH" --plan-only || true
    fi
  fi
  say "maintenance: dry-run done rc=0"
  exit 0
fi

db_before="$(stat -c %s -- "$OPENCODE_DB" 2>/dev/null || echo 0)"

say "maintenance: mode=$MODE dry_run=0"

# ---------------------------------------------------------------------------
# step 1 — metering (always, read-only)
# ---------------------------------------------------------------------------
meter_status="ok"
meter_out=""
child="n/a"
total="n/a"
if [ ! -x "$METER_SH" ]; then
  meter_status="missing"
else
  meter_out="$TMPD/metering.txt"
  if "$METER_SH" >"$meter_out" 2>&1; then
    meter_status="ok"
    child="$(awk '/child sessions \(parent_id IS NOT NULL\)/ {print $NF; exit}' "$meter_out")"
    total="$(awk '/total sessions/ {print $NF; exit}' "$meter_out")"
    [ -n "$child" ] || child="n/a"
    [ -n "$total" ] || total="n/a"
  else
    meter_status="fail:rc=$?"
  fi
fi
say "metering: $meter_status (child=$child total=$total)"

# ---------------------------------------------------------------------------
# step 2 — backup (always, best-effort; never fails the run)
# ---------------------------------------------------------------------------
backup_status="skipped"
if [ ! -x "$BACKUP_SH" ]; then
  backup_status="missing"
else
  if "$BACKUP_SH" backup >"$TMPD/backup.txt" 2>&1; then
    backup_status="ok"
  else
    backup_status="fail:rc=$?"
  fi
fi
say "backup: $backup_status (best-effort; non-atomic while opencode runs)"

# ---------------------------------------------------------------------------
# steps 3+ — destructive sequence (full mode only, gated)
# ---------------------------------------------------------------------------
full_status="not_requested"
skip_reason="-"
ret_status="not_run"
ret_deleted_sessions="n/a"
ret_deleted_events="n/a"
summary_status="not_run"
summary_changed="n/a"
summary_reduction="n/a"
storage_status="not_run"
storage_freed="n/a"
mega_status="not_run"
mega_deleted="n/a"

if [ "$MODE" = "full" ]; then
  eval_disk
  if [ "$opencode_running" -eq 1 ]; then
    full_status="skipped"
    skip_reason="opencode_running"
    say "full: SKIPPED (opencode running, pid=$running_pid)"
    say "reason=opencode_running"
  elif [ "$disk_ok" -eq 0 ]; then
    full_status="skipped"
    skip_reason="insufficient_disk"
    say "full: SKIPPED (insufficient disk: avail_kb=$avail_kb need_kb=$need_kb)"
    say "reason=insufficient_disk"
  else
    full_status="applied"

    # step 3 — db-retention.sh --apply: the ONLY checkpoint/VACUUM owner
    if [ ! -x "$RETENTION_SH" ]; then
      ret_status="missing"
      full_status="fail"
    elif ALLOW_WHILE_RUNNING=0 RETENTION_DAYS="$RETENTION_DAYS" \
         "$RETENTION_SH" --apply >"$TMPD/retention.txt" 2>&1; then
      ret_status="applied"
      ret_deleted_sessions="$(awk -F': ' '/^DELETED_SESSIONS:/ {print $2; exit}' "$TMPD/retention.txt")"
      ret_deleted_events="$(awk -F': ' '/^DELETED_EVENTS:/ {print $2; exit}' "$TMPD/retention.txt")"
      [ -n "$ret_deleted_sessions" ] || ret_deleted_sessions="n/a"
      [ -n "$ret_deleted_events" ] || ret_deleted_events="n/a"
    else
      ret_status="fail:rc=$?"
      full_status="fail"
    fi
    say "retention: $ret_status (deleted_sessions=$ret_deleted_sessions deleted_events=$ret_deleted_events)"

    if [ "$ret_status" = "applied" ]; then
      # step 4 — summary-diff-prune.sh --apply (no vacuum, no backup)
      if [ ! -x "$SUMMARY_SH" ]; then
        summary_status="missing"
        full_status="fail"
      elif "$SUMMARY_SH" --apply --no-vacuum --skip-backup >"$TMPD/summary.txt" 2>&1; then
        summary_status="applied"
        summary_changed="$(awk -F': ' '/^CHANGED_MESSAGES:/ {print $2; exit}' "$TMPD/summary.txt")"
        summary_reduction="$(awk -F': ' '/^REDUCTION_PCT:/ {print $2; exit}' "$TMPD/summary.txt")"
        [ -n "$summary_changed" ] || summary_changed="n/a"
        [ -n "$summary_reduction" ] || summary_reduction="n/a"
      else
        summary_status="fail:rc=$?"
        full_status="fail"
      fi
      say "summary: $summary_status (changed_messages=$summary_changed reduction_pct=$summary_reduction)"
    else
      say "summary: SKIPPED (retention did not succeed)"
    fi

    if [ "$summary_status" = "applied" ]; then
      # step 5 — storage-prune.sh --apply (filesystem quarantine; no DB vacuum)
      if [ ! -x "$STORAGE_SH" ]; then
        storage_status="missing"
        full_status="fail"
      elif "$STORAGE_SH" --apply >"$TMPD/storage.txt" 2>&1; then
        storage_status="applied"
        storage_freed="$(awk -F= '/^freed_bytes=/ {print $2; exit}' "$TMPD/storage.txt")"
        [ -n "$storage_freed" ] || storage_freed="n/a"
      else
        storage_status="fail:rc=$?"
        full_status="fail"
      fi
      say "storage: $storage_status (freed_bytes=$storage_freed)"
    else
      say "storage: SKIPPED (summary did not succeed)"
    fi

    if [ "$storage_status" = "applied" ]; then
      # step 6 — mega-session-export-delete.sh --apply (no vacuum, no backup)
      if [ ! -x "$MEGA_SH" ]; then
        mega_status="missing"
        full_status="fail"
      elif "$MEGA_SH" --apply --no-vacuum --skip-backup >"$TMPD/mega.txt" 2>&1; then
        mega_status="applied"
        mega_deleted="$(awk -F': ' '/^DELETED_SESSIONS:/ {print $2; exit}' "$TMPD/mega.txt")"
        [ -n "$mega_deleted" ] || mega_deleted="n/a"
      else
        mega_status="fail:rc=$?"
        full_status="fail"
      fi
      say "mega: $mega_status (deleted_sessions=$mega_deleted)"
    else
      say "mega: SKIPPED (storage did not succeed)"
    fi
  fi
else
  say "safe: metering + backup only (no destructive steps)"
fi

db_after="$(stat -c %s -- "$OPENCODE_DB" 2>/dev/null || echo 0)"

final_integrity="n/a"
if [ "$full_status" = "applied" ] && [ -f "$OPENCODE_DB" ]; then
  final_integrity="$(python3 - "$OPENCODE_DB" 2>/dev/null <<'PY'
import sqlite3, sys
try:
    c = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True, timeout=60)
    print(c.execute("PRAGMA integrity_check").fetchone()[0])
    c.close()
except Exception:
    print("n/a")
PY
)" || final_integrity="n/a"
  [ -n "$final_integrity" ] || final_integrity="n/a"
fi

# ---------------------------------------------------------------------------
# exit code — metering failure and destructive failure are non-zero; a skip is OK
# ---------------------------------------------------------------------------
rc=0
case "$meter_status" in ok) ;; *) rc=1 ;; esac
if [ "$MODE" = "full" ]; then
  case "$full_status" in applied|skipped) ;; *) rc=1 ;; esac
fi

# ---------------------------------------------------------------------------
# final step — append exactly ONE line to the log
# ---------------------------------------------------------------------------
mkdir -p -- "$(dirname -- "$LOG_FILE")"
line="ts=$TS maintenance=run mode=$MODE meter=$meter_status child=$child total=$total"
line="$line backup=$backup_status"
if [ "$MODE" = "full" ]; then
  if [ "$full_status" = "skipped" ]; then
    line="$line destructive=skipped reason=$skip_reason"
    [ "$opencode_running" -eq 1 ] && line="$line pid=$running_pid"
  else
    line="$line destructive=$full_status"
    line="$line retention=$ret_status deleted_sessions=$ret_deleted_sessions deleted_events=$ret_deleted_events"
    line="$line summary=$summary_status changed_messages=$summary_changed summary_reduction_pct=$summary_reduction"
    line="$line storage=$storage_status freed_bytes=$storage_freed"
    line="$line mega=$mega_status mega_deleted_sessions=$mega_deleted"
    line="$line integrity=$final_integrity"
  fi
fi
line="$line db=$db_before->$db_after rc=$rc"
line="$(printf '%s' "$line" | tr '\n' ' ')"
printf '%s\n' "$line" >>"$LOG_FILE"
say "log: $line"
say "maintenance: done rc=$rc"
exit "$rc"
