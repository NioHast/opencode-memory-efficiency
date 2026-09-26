#!/usr/bin/env bash
#
# opencode-capped.sh — launch `opencode` under a cgroup memory cap, bracketed
# by the maintenance orchestrator (todo 12).
#
# Defaults (override via env):
#   OPENCAP_MEMORY_MAX=3G   -> systemd MemoryMax    (hard memory limit)
#   OPENCAP_SWAP_MAX=2G     -> systemd MemorySwapMax (hard swap limit)
#
# Escape hatch:
#   OPENCAP_DISABLE=1       -> run opencode directly, no cgroup at all.
#                              (maintenance still runs around the session)
#
# Maintenance wiring:
#   * `opencode-maintenance.sh --mode=full` runs BEFORE opencode starts and
#     AFTER it exits. Both windows have opencode stopped, so full mode is
#     allowed there; the orchestrator still re-checks `pgrep -x opencode`
#     itself and skips the destructive steps if anything is somehow alive.
#   * A maintenance failure (missing or non-zero) is logged but NEVER blocks
#     the launch: opencode's own exit status is always propagated (the script
#     no longer `exec`s, so the post-exit hook can run).
#   * Env:
#       OPENCAP_MAINTENANCE  path to the orchestrator (default: dir of this script)
#       OPENCAP_LOG          launcher log (default: $HOME/.config/opencode/logs/launcher.log)
#
# Preference order:
#   1. `systemd-run --user --scope`  (per-user cgroup) if a user manager is reachable
#   2. `systemd-run --scope`         (system cgroup) if a system manager is reachable
#   3. plain opencode                (last-resort graceful fallback)
#
set -uo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

OPENCAP_MEMORY_MAX="${OPENCAP_MEMORY_MAX:-3G}"
OPENCAP_SWAP_MAX="${OPENCAP_SWAP_MAX:-2G}"
OPENCAP_LOG="${OPENCAP_LOG:-$HOME/.config/opencode/logs/launcher.log}"
MAINTENANCE_SH="${OPENCAP_MAINTENANCE:-$SCRIPT_DIR/opencode-maintenance.sh}"

# Resolve the real opencode executable once. `command -v` also resolves shell
# builtins/functions, so prefer `type -P` (PATH-only) and fall back.
_opencode_bin() {
  if [ -n "${OPENCODE_BIN:-}" ]; then
    printf '%s\n' "$OPENCODE_BIN"
    return 0
  fi
  local bin
  bin="$(type -P opencode 2>/dev/null || true)"
  if [ -z "$bin" ]; then
    bin="$(command -v opencode 2>/dev/null || true)"
  fi
  printf '%s\n' "$bin"
}

# ---------------------------------------------------------------------------
# maintenance hooks — ALWAYS non-fatal (a failure must never block the launch)
# ---------------------------------------------------------------------------
_log_writable() {
  local d
  d="$(dirname -- "$OPENCAP_LOG")"
  mkdir -p -- "$d" 2>/dev/null || return 1
  [ -w "$d" ]
}

_log() {
  _log_writable || return 0
  printf '%s\n' "$*" >>"$OPENCAP_LOG" 2>/dev/null || true
}

_run_maintenance() {
  local phase="$1" ts rc
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if [ ! -x "$MAINTENANCE_SH" ]; then
    _log "ts=$ts phase=$phase maintenance=missing path=$MAINTENANCE_SH (launch not blocked)"
    return 0
  fi
  _log "ts=$ts phase=$phase maintenance=start mode=full"
  if _log_writable; then
    if "$MAINTENANCE_SH" --mode=full >>"$OPENCAP_LOG" 2>&1; then
      rc=0
    else
      rc=$?
    fi
  else
    # Log is unwritable: still RUN maintenance (never block), just discard output.
    if "$MAINTENANCE_SH" --mode=full >/dev/null 2>&1; then
      rc=0
    else
      rc=$?
    fi
  fi
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  _log "ts=$ts phase=$phase maintenance=done rc=$rc (launch not blocked)"
  return 0
}

_launched=0
_post_done=0
_post_maintenance() {
  if [ "$_launched" -eq 1 ] && [ "$_post_done" -eq 0 ]; then
    _post_done=1
    _run_maintenance post
  fi
}
trap _post_maintenance EXIT

OPENCODE_BIN="$(_opencode_bin)"
if [ -z "$OPENCODE_BIN" ]; then
  printf 'opencode-capped: opencode executable not found in PATH\n' >&2
  exit 127
fi

# Real availability probe: actually create a tiny scope with systemd-run.
# `command -v` alone would succeed even when no manager/bus is reachable.
_has_user_manager() {
  command -v systemd-run >/dev/null 2>&1 || return 1
  systemd-run --user --scope -p MemoryMax=1G true >/dev/null 2>&1
}

_has_system_manager() {
  command -v systemd-run >/dev/null 2>&1 || return 1
  systemd-run --scope -p MemoryMax=1G true >/dev/null 2>&1
}

# ---------------------------------------------------------------------------
# pre-launch maintenance (non-fatal)
# ---------------------------------------------------------------------------
_run_maintenance pre

# ---------------------------------------------------------------------------
# launch opencode in the FOREGROUND (no exec) so the EXIT trap can run the
# post-exit maintenance, then propagate opencode's exit status unchanged.
# ---------------------------------------------------------------------------
rc=0
_launched=1
if [ "${OPENCAP_DISABLE:-0}" = "1" ]; then
  "$OPENCODE_BIN" "$@" || rc=$?
elif _has_user_manager; then
  systemd-run --user --scope \
    -p "MemoryMax=${OPENCAP_MEMORY_MAX}" \
    -p "MemorySwapMax=${OPENCAP_SWAP_MAX}" \
    -- "$OPENCODE_BIN" "$@" || rc=$?
elif _has_system_manager; then
  systemd-run --scope \
    -p "MemoryMax=${OPENCAP_MEMORY_MAX}" \
    -p "MemorySwapMax=${OPENCAP_SWAP_MAX}" \
    -- "$OPENCODE_BIN" "$@" || rc=$?
else
  # Graceful fallback: no cgroup available, just run opencode.
  "$OPENCODE_BIN" "$@" || rc=$?
fi

exit "$rc"
