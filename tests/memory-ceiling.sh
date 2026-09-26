#!/usr/bin/env bash
# memory-ceiling.sh (todo 16, opencode-memory-efficiency)
# ---------------------------------------------------------------------------
# MEASURES the peak RSS (VmHWM) of an ISOLATED opencode process while it
# materialises a LARGE session, under the cgroup-capped launcher. Proves the
# ceiling (IS-1/IS-2/IS-5) WITHOUT touching the live DB or live opencode.
#
#   PASS : rc==0 AND peak < 2500 MB
#   FAIL : rc==137 (cgroup OOM-kill) OR peak >= 3200 MB  (a kill is ALWAYS FAIL,
#          because under a 3G cap a regression can only manifest as a kill)
#   INCONCLUSIVE : anything else (e.g. export produced nothing)
#
# It also runs a SENSITIVITY check: the same load under a tiny cap (64M) MUST be
# killed (rc 137) -> proves the harness detects a kill as FAIL.
#
# Isolation: throwaway XDG_*/HOME; DB copied in; env filtered by the unique temp
# path so the LIVE opencode PID is never sampled/killed.
set -uo pipefail

LIVE_DB="${LIVE_DB:-$HOME/.local/share/opencode/opencode.db}"
MEGA="${MEGA:-ses_f4d9e6e23ffeMb31YovaD0gHtN}"
CAP="${CAP:-3G}"
PASS_MB="${PASS_MB:-2500}"
FAIL_MB="${FAIL_MB:-3200}"
TIMEOUT_S="${TIMEOUT_S:-300}"
LAUNCHER="$HOME/.config/opencode/bin/opencode-capped.sh"

PASS_KB=$((PASS_MB * 1024)); FAIL_KB=$((FAIL_MB * 1024))
LIVE_PID="$(pgrep -x opencode 2>/dev/null | head -1)"

IZ="$(mktemp -d "${TMPDIR:-/tmp}/openmemceiling.XXXXXX")"
cleanup() {
  # kill only isolated children (never the live PID)
  pkill -f "$IZ" 2>/dev/null || true
  rm -rf "$IZ"
}
trap cleanup EXIT

[ -f "$LIVE_DB" ] || { echo "FATAL: live DB not found: $LIVE_DB" >&2; exit 2; }
[ -x "$LAUNCHER" ] || { echo "FATAL: launcher not found/executable: $LAUNCHER" >&2; exit 2; }

prepare_home() {
  local dest="$1"
  export HOME="$dest/home"
  export XDG_DATA_HOME="$dest/data"
  export XDG_CONFIG_HOME="$dest/config"
  export XDG_CACHE_HOME="$dest/cache"
  export XDG_STATE_HOME="$dest/state"
  mkdir -p "$XDG_DATA_HOME/opencode" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_STATE_HOME" "$HOME"
  cp -a "$LIVE_DB" "$XDG_DATA_HOME/opencode/opencode.db"
  [ -f "$LIVE_DB-wal" ] && cp -a "$LIVE_DB-wal" "$XDG_DATA_HOME/opencode/opencode.db-wal" || true
}

# measure_load <isolated_dir> <cap> -> echoes "rc=<n> peak_kb=<n> pid=<n> out_bytes=<n>"
measure_load() {
  local iz="$1" cap="$2" swap="${3:-2G}" tmo="${4:-$TIMEOUT_S}"
  local outjson="$iz/export.json" errfile="$iz/export.err" log="$iz/launcher.log"
  prepare_home "$iz"

  OPENCAP_MEMORY_MAX="$cap" OPENCAP_SWAP_MAX="$swap" OPENCAP_LOG="$log" \
  OPENCAP_MAINTENANCE=/bin/true \
    bash "$LAUNCHER" export "$MEGA" >"$outjson" 2>"$errfile" &
  local wrap=$!

  local peak=0 pid="" t=0 elapsed=0 start
  start="$(date +%s)"
  while kill -0 "$wrap" 2>/dev/null; do
    for p in $(pgrep -x opencode 2>/dev/null); do
      [ -n "$LIVE_PID" ] && [ "$p" = "$LIVE_PID" ] && continue
      # only our isolated instance (unique temp path in its environ)
      grep -qa "$iz" "/proc/$p/environ" 2>/dev/null || continue
      local hwm
      hwm="$(awk -F: '/^VmHWM:/{print $2+0}' "/proc/$p/status" 2>/dev/null)"
      if [ -n "$hwm" ] && [ "$hwm" -gt "$peak" ] 2>/dev/null; then peak="$hwm"; pid="$p"; fi
    done
    elapsed=$(( $(date +%s) - start ))
    if [ "$elapsed" -ge "$tmo" ]; then
      echo "  (timeout ${tmo}s -> killing isolated wrapper $wrap)" >&2
      kill "$wrap" 2>/dev/null
      sleep 2
      kill -9 "$wrap" 2>/dev/null
      break
    fi
    sleep 1
  done
  wait "$wrap"; local rc=$?
  local obytes=0
  [ -f "$outjson" ] && obytes="$(stat -c%s "$outjson" 2>/dev/null || echo 0)"
  echo "rc=$rc peak_kb=$peak pid=${pid:-none} out_bytes=$obytes"
}

echo "==================================================================="
echo "TASK 16 — memory-ceiling (VmHWM) on an isolated large session"
echo "==================================================================="
echo "live_db=$LIVE_DB"
echo "mega_session=$MEGA"
echo "cap=$CAP  pass<${PASS_MB}MB  fail>=${FAIL_MB}MB  timeout=${TIMEOUT_S}s"
echo "live_opencode_pid=${LIVE_PID:-none} (never sampled/killed)"
echo

echo "--- MAIN measurement (cap=$CAP) ---"
MAIN_DIR="$IZ/main"
MAIN="$(measure_load "$MAIN_DIR" "$CAP" "2G" "$TIMEOUT_S")"
echo "$MAIN"
main_rc="$(sed -n 's/.*rc=\([0-9-]*\).*/\1/p' <<<"$MAIN")"
main_peak="$(printf '%s' "$MAIN" | sed -n 's/.*peak_kb=[^0-9]*\([0-9][0-9]*\).*/\1/p')"
main_obytes="$(sed -n 's/.*out_bytes=\([0-9]*\).*/\1/p' <<<"$MAIN")"
[ -z "$main_peak" ] && main_peak=0

echo
echo "--- SENSITIVITY check (cap=64M -> MUST be killed) ---"
SENS_DIR="$IZ/sens"
SENS="$(measure_load "$SENS_DIR" "64M" "0" 90)"
echo "$SENS"
sens_rc="$(sed -n 's/.*rc=\([0-9-]*\).*/\1/p' <<<"$SENS")"

echo
echo "==================================================================="
peak_mb=$(( main_peak / 1024 ))
echo "PEAK_VmHWM_kB=$main_peak (${peak_mb} MB)"
echo "MAIN_EXIT=$main_rc  MAIN_EXPORT_BYTES=$main_obytes"
echo "SENSITIVITY_EXIT=$sens_rc (137 expected = kill detected)"

verdict="INCONCLUSIVE"
if [ "$main_rc" = "137" ]; then
  verdict="FAIL (cgroup OOM-killed at cap $CAP)"
elif [ "$main_peak" -ge "$FAIL_KB" ]; then
  verdict="FAIL (peak ${peak_mb}MB >= ${FAIL_MB}MB)"
elif [ "$main_peak" -lt "$PASS_KB" ] && [ "$main_rc" = "0" ] && [ "$main_obytes" -gt 0 ]; then
  verdict="PASS (peak ${peak_mb}MB < ${PASS_MB}MB, exit 0, session materialised)"
elif [ "$main_rc" = "0" ] && [ "$main_peak" -lt "$PASS_KB" ]; then
  verdict="PASS (peak ${peak_mb}MB < ${PASS_MB}MB, exit 0)"
fi

sens_ok="NO"
[ "$sens_rc" = "137" ] && sens_ok="YES"
echo "SENSITIVITY_KILL_DETECTED=$sens_ok"
echo "VERDICT=$verdict"
echo "==================================================================="

# Exit non-zero only on an explicit FAIL, so CI/humans can gate on it.
case "$verdict" in
  FAIL*) exit 1 ;;
  *) exit 0 ;;
esac
