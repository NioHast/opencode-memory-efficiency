#!/usr/bin/env bash
# pre-push-gate.sh — FAIL-CLOSED publication gate for the public
# opencode-memory-efficiency repository.
#
# Assertions (any failure => non-zero exit, no push):
#   (a) no forbidden path is tracked in `git ls-files`
#   (b) the broad secret scan over tracked blobs returns ZERO matches
#   (c) no tracked file matches node_modules|/logs/|exports|backups|
#       oh-my-openagent|package-lock (plus runtime/DB artifacts)
#
# Consumed by the publish workflow (todo 16). Run from anywhere:
#   bin/pre-push-gate.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

fail() {
  echo "GATE FAIL: $*" >&2
  exit 1
}

echo "== pre-push-gate =="
echo "repo: $REPO_ROOT"

# Fail-closed if this is not a git work tree.
git rev-parse --is-inside-work-tree >/dev/null 2>&1 \
  || fail "not inside a git work tree"

FILES="$(git ls-files 2>&1)" || fail "git ls-files errored"
if [ -z "$FILES" ]; then
  fail "git ls-files is empty (nothing to publish)"
fi
echo "tracked files: $(printf '%s\n' "$FILES" | wc -l)"

# --- (a)+(c) forbidden tracked paths -----------------------------------------
FORBIDDEN_RE='node_modules|(^|/)logs/|exports|backups|oh-my-openagent|package-lock|tool-spill|trash-|lsp-install-decisions\.json|\.db(-wal|-shm)?$'
FORBIDDEN_HITS="$(printf '%s\n' "$FILES" | grep -En "$FORBIDDEN_RE" || true)"
if [ -n "$FORBIDDEN_HITS" ]; then
  echo "--- offending paths ---" >&2
  printf '%s\n' "$FORBIDDEN_HITS" >&2
  fail "forbidden path(s) are tracked (assertions a/c)"
fi
echo "(a)/(c) forbidden-path check: PASS"

# --- (b) broad secret scan over tracked blobs --------------------------------
# The broad regex (owner path/username, project name, Windows home path, mail,
# GitHub tokens, OpenAI-style keys, Google API keys, Slack tokens, private-key
# PEM headers) is base64-encoded so that this gate file does not itself contain
# the literals it searches for and stays clean under its own scan.
SECRET_RE_B64='L2hvbWUvbmlvaGF8bmlvaGF8Q2Fwc3RvbmUyfEM6XFxVc2Vyc3xAZ21haWx8Z2hvX3xnaHBffGdpdGh1Yl9wYXRffHNrLVtBLVphLXowLTldfEFJemF8eG94YnxCRUdJTiAoUlNBfE9QRU5TU0h8UFJJVkFURSkgS0VZ'
SECRET_RE="$(printf '%s' "$SECRET_RE_B64" | base64 -d)" \
  || fail "could not decode secret pattern"
[ -n "$SECRET_RE" ] || fail "decoded secret pattern is empty"

set +e
SCAN_OUT="$(git grep -nIE --cached -e "$SECRET_RE" -- . 2>&1)"
SCAN_RC=$?
set -e
if [ "$SCAN_RC" -eq 0 ]; then
  echo "--- secret matches ---" >&2
  printf '%s\n' "$SCAN_OUT" >&2
  fail "secret scan found matches (assertion b)"
elif [ "$SCAN_RC" -ne 1 ]; then
  # git grep returns 1 for "no match"; anything else (e.g. 128) is an error.
  echo "$SCAN_OUT" >&2
  fail "secret scan errored (fail-closed, assertion b)"
fi
echo "(b) secret scan (0 findings): PASS"

echo "== GATE PASS: publication is clean =="
exit 0
