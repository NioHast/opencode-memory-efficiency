#!/usr/bin/env bash
# pin-audit.sh — audit opencode plugin specs for unpinned / @latest entries.
#
# Flags BOTH:
#   - literal "@latest" in any plugin spec
#   - unversioned specs (e.g. "foo", "@scope/name") or non-exact dist-tags
#     (e.g. "foo@beta") — these resolve to @latest at load time.
#
# Scans ~/.config/opencode/opencode.json (strict JSON) and ~/.omo/omo.jsonc
# (JSONC; comments stripped safely). Walks the WHOLE parsed document for any
# key named "plugin" (top-level or nested).
#
# Exit codes:
#   0 = no findings
#   1 = one or more unpinned plugin specs found
#   2 = usage/io/parse error (missing file, unparseable config)
#
# Env overrides (for testing on copies):
#   OPENCODE_JSON   default ~/.config/opencode/opencode.json
#   OMO_JSONC       default ~/.omo/omo.jsonc
#
set -uo pipefail

OPENCODE_JSON="${OPENCODE_JSON:-$HOME/.config/opencode/opencode.json}"
OMO_JSONC="${OMO_JSONC:-$HOME/.omo/omo.jsonc}"

exec python3 - "$OPENCODE_JSON" "$OMO_JSONC" <<'PY'
import json
import os
import re
import sys


def strip_jsonc(text):
    """Remove // and /* */ comments while respecting string literals."""
    out = []
    i = 0
    n = len(text)
    in_str = False
    esc = False
    while i < n:
        c = text[i]
        if in_str:
            out.append(c)
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
            i += 1
            continue
        if c == '"':
            in_str = True
            out.append(c)
            i += 1
            continue
        if c == "/" and i + 1 < n and text[i + 1] == "/":
            i += 2
            while i < n and text[i] != "\n":
                i += 1
            continue
        if c == "/" and i + 1 < n and text[i + 1] == "*":
            i += 2
            while i + 1 < n and not (text[i] == "*" and text[i + 1] == "/"):
                i += 1
            i += 2
            continue
        out.append(c)
        i += 1
    return "".join(out)


def parse_config(path):
    with open(path, "r", encoding="utf-8") as fh:
        raw = fh.read()
    try:
        return json.loads(raw)
    except Exception:
        pass
    try:
        return json.loads(strip_jsonc(raw))
    except Exception as exc:
        sys.stderr.write("ERROR: cannot parse %s as JSON/JSONC: %s\n" % (path, exc))
        sys.exit(2)


def collect_plugins(obj, path="$"):
    """Recursively find every value stored under a key named 'plugin'."""
    found = []
    if isinstance(obj, dict):
        for key, val in obj.items():
            child = "%s.%s" % (path, key)
            if key == "plugin":
                found.append((child, val))
            found.extend(collect_plugins(val, child))
    elif isinstance(obj, list):
        for idx, val in enumerate(obj):
            found.extend(collect_plugins(val, "%s[%d]" % (path, idx)))
    return found


def spec_entries(value):
    """Yield (index, spec_string) for each plugin spec. Non-strings -> (i, None)."""
    items = value if isinstance(value, list) else [value]
    for idx, item in enumerate(items):
        if isinstance(item, str):
            yield idx, item
        elif isinstance(item, (list, tuple)) and len(item) >= 1 and isinstance(item[0], str):
            # tuple form: ["pkg@1.2.3", { options }]
            yield idx, item[0]
        else:
            yield idx, None


VER_RE = re.compile(r"^v?\d")


def classify(spec):
    """Return a finding reason, or None if the spec is pinned exactly."""
    if "@latest" in spec:
        return "literal @latest"
    at = spec.rfind("@")
    if at <= 0:
        return "unversioned (no @version; resolves to @latest)"
    ver = spec[at + 1:]
    if not ver:
        return "unversioned (empty version after @; resolves to @latest)"
    if not VER_RE.match(ver):
        return "non-exact version '%s' (dist-tag; not an exact version)" % ver
    return None


def main():
    targets = sys.argv[1:]
    findings = 0
    scanned = 0

    print("=== pin-audit: opencode plugin spec audit ===")
    for path in targets:
        expanded = os.path.expanduser(path)
        print("\n-- config: %s" % expanded)
        if not os.path.isfile(expanded):
            print("   MISSING (cannot audit)")
            sys.stderr.write("ERROR: config not found: %s\n" % expanded)
            sys.exit(2)

        data = parse_config(expanded)
        plugin_values = collect_plugins(data)

        if not plugin_values:
            print("   plugin key: (none) -> no plugin specs to audit")
            continue

        for key_path, value in plugin_values:
            for idx, spec in spec_entries(value):
                scanned += 1
                loc = "%s[%d]" % (key_path, idx)
                if spec is None:
                    findings += 1
                    print("   [FINDING] %s = <non-string %s> -> cannot verify pin" % (loc, type(value).__name__))
                    continue
                reason = classify(spec)
                if reason is None:
                    print("   [ok]      %s = %r (pinned)" % (loc, spec))
                else:
                    findings += 1
                    print("   [FINDING] %s = %r -> %s" % (loc, spec, reason))

    print("\nplugin specs scanned : %d" % scanned)
    print("TOTAL FINDINGS       : %d" % findings)
    if findings:
        print("VERDICT: FAIL — unpinned plugin spec(s) must be replaced with an exact version")
        sys.exit(1)
    print("VERDICT: PASS — every plugin spec is pinned exactly")
    sys.exit(0)


main()
PY
