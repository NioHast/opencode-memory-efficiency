# opencode-memory-efficiency

Plugins, retention scripts, and tests that keep a single long-running
[opencode](https://opencode.ai) session inside a bounded memory and context
budget, so you don't have to restart the session to reclaim RAM.

## What this is

A set of seven opencode plugins plus the shell tooling around them. The plugins
hook into the opencode lifecycle and shrink the parts of a session that grow
without bound:

- **tool output** that is huge gets spilled to disk and replaced with a preview
- **context messages** get compacted under a prefix-stable policy that never
  drops a running or pending tool call
- **attachments** (images, files) over a byte cap get previewed and spilled
- **oversized diffs and transcripts** get capped before they reach the model
- **compaction** gets a handoff prompt that carries the last user message verbatim
- **milestone notes** survive compaction and are re-injected into a fresh session
- **tool concurrency** is capped so parallel tool calls can't balloon RSS

The shell side (`bin/`) handles daily non-destructive maintenance, retention on
a database copy, backups/rollback, and a cgroup-capped launcher.

## Why: single-session memory efficiency

Left alone, one opencode session accumulates tool output, diffs, file
attachments, and compacted transcripts in memory and in the prompt. The usual
workaround is to start a new session. This repo removes that workaround: the
plugins bound each growing layer at the moment it would grow, and the
maintenance scripts trim what has already been persisted. A session can run for
a long time without a forced switch, while RAM stays inside the documented
ceiling.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the data flow, the hook
map, the prefix-cache constraint, and the subagent concurrency model.

## Repository layout

```
opencode-memory-efficiency/
├── README.md
├── CONTRIBUTING.md
├── LICENSE                       # MIT, NioHast
├── package.json                  # pins @opencode-ai/plugin (runtime dependency)
├── .gitignore
├── .gitattributes
├── plugins/                      # the seven plugins
│   ├── attachment-bound.js
│   ├── compaction-handoff.js
│   ├── context-governor.js
│   ├── milestone-note.js
│   ├── summary-diff-cap.js
│   ├── tool-concurrency.js
│   └── tool-output-spill.js
├── tests/
│   ├── attachment.test.mjs
│   ├── compaction.test.mjs
│   ├── diffcap.test.mjs
│   ├── governor.test.mjs
│   ├── milestone.test.mjs
│   ├── mutation.test.mjs
│   ├── plugins.unit.test.mjs
│   ├── spill.test.mjs
│   ├── context-retention.sh      # integration: retention across compaction
│   ├── memory-ceiling.sh         # integration: peak RSS under the capped launcher
│   └── retention.test.sh         # integration: db-retention.sh on a DB copy
├── bin/                          # maintenance / retention / backup scripts
│   ├── backup-rollback.sh
│   ├── db-retention.sh
│   ├── mega-session-export-delete.sh
│   ├── memory-ledger.sh
│   ├── opencode-capped.sh
│   ├── opencode-maintenance.sh
│   ├── pin-audit.sh
│   ├── storage-prune.sh
│   ├── summary-diff-prune.sh
│   ├── windows-owner-checklist.md
│   └── wslconfig-snippet.txt
└── docs/
    ├── ARCHITECTURE.md
    ├── DECISIONS.md
    ├── HOOKS.md
    ├── OPERATIONS.md
    └── PLUGINS.md
```

## Install

opencode loads every `*.js` file under `~/.config/opencode/plugins/` at startup.
The plugins import `@opencode-ai/plugin`, so that package must be pinned in the
config directory's `package.json`.

Drop-in install (keeps whatever opencode config you already have):

```bash
git clone https://github.com/NioHast/opencode-memory-efficiency.git /tmp/opencode-memory-efficiency
mkdir -p "$HOME/.config/opencode/plugins"
cp /tmp/opencode-memory-efficiency/plugins/*.js "$HOME/.config/opencode/plugins/"

# pin the runtime dependency the plugins import
cd "$HOME/.config/opencode"
npm install --save-exact @opencode-ai/plugin@1.18.32
# or, with bun installed: bun add --exact @opencode-ai/plugin@1.18.32
```

Full-config install (use the repo as your config directory, only if you don't
have a config yet). With bun, which opencode bundles:

```bash
git clone https://github.com/NioHast/opencode-memory-efficiency.git "$HOME/.config/opencode"
cd "$HOME/.config/opencode" && bun install
# without bun: npm install
```

Restart opencode after installing so the plugins load. The plugins are
env-overridable; see [`docs/PLUGINS.md`](docs/PLUGINS.md) for the full knob list.

## Run the tests

Unit and mutation tests run on Node's built-in test runner (Node 24; no test
framework dependency). Run from the repo root:

```bash
node --test --no-warnings tests/*.test.mjs
```

Or from anywhere, against an installed config:

```bash
node --test --no-warnings "$HOME"/.config/opencode/tests/*.test.mjs
```

Expected summary: `tests 127`, `pass 127`, `fail 0`.

The shell suites under `bin/` and the integration tests under `tests/` are
checked for syntax with:

```bash
bash -n bin/*.sh
bash -n tests/*.sh
```

The integration tests (`tests/context-retention.sh`, `tests/retention.test.sh`,
`tests/memory-ceiling.sh`) run against temp copies and isolated HOME dirs; they
never touch a live database. `memory-ceiling.sh` needs the cgroup-capable
launcher and is best run on a Linux host with `systemd-run`. See
[`CONTRIBUTING.md`](CONTRIBUTING.md) for the exact commands and their
requirements.

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): system-level data flow, hook map, load order, prefix-cache constraint, subagent concurrency and memory model
- [`docs/HOOKS.md`](docs/HOOKS.md): the shared-hook contract, ordering guarantees, the must-never-throw rule, and how to add a hook safely
- [`docs/PLUGINS.md`](docs/PLUGINS.md): one section per plugin with its problem, hooks, env knobs, failure modes, and test file
- [`docs/OPERATIONS.md`](docs/OPERATIONS.md): the sanitized runbook for maintenance modes, cron, measurement, tuning, crash recovery, and rollback

## License

MIT. See [`LICENSE`](LICENSE). Copyright (c) 2026 NioHast.
