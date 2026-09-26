# opencode Memory Efficiency: Operations Guide

This is the sanitized, public operations guide for the opencode memory-efficiency
plugins and maintenance scripts. It is the single source of truth; the original
authoring-machine runbook it was derived from has been archived. Every
machine-specific path here uses `$HOME` (or a Windows `<you>` placeholder), so the
commands are copy-pasteable on any machine — the one exception is the installed cron entry
in section 3, deliberately written with this host's absolute paths and marked as a
machine-specific example (with a portable template beside it).

Nothing here is owner-specific. If you need the original authoring machine's exact
measurements, they were recorded while this work was being built; they are listed only
as reference numbers and are not required to operate the system.

## How to read the command tags

| Tag | Meaning |
| --- | --- |
| `[read-only]` | Changes nothing. Safe while opencode runs. |
| `[refuses-while-running]` | `--apply` gate: exits 3 and writes nothing unless opencode is stopped. `ALLOW_WHILE_RUNNING=1` is tests-only and must never be used on a live DB. |
| `[apply/deferred]` | Writes to the DB or filesystem. Requires opencode stopped. |
| `[launch]` | Starts opencode. |
| `[windows]` | Must be run on the Windows host, outside WSL. Marked as a user action; the agent cannot run these. |

> **Implemented:** `bin/opencode-maintenance.sh` accepts `--mode=safe|full` (safe is the
> default) and `--dry-run`; confirm on your checkout with
> `grep -n "mode=" bin/opencode-maintenance.sh`. The launcher `bin/opencode-capped.sh`
> passes `--mode=full` at both windows where opencode is stopped (pre-launch and
> post-exit) — see section 4.

> **Implemented:** the daily non-destructive cron entry is installed (see section 3).
> `crontab -l` shows exactly one `opencode-maintenance` line on this machine, running
> `--mode=safe`; the cron daemon is active and enabled. No destructive mode is scheduled.

## 0. Artifact map

Everything lives under the opencode config directory (referred to below as `$CONFIG`,
default `$HOME/.config/opencode`).

| Artifact | Tag | Purpose |
| --- | --- | --- |
| [bin/memory-ledger.sh](../bin/memory-ledger.sh) | `[read-only]` | Metering harness (DB/WAL sizes, per-table bytes, top sessions, `summary.diffs`, storage dirs, live RSS). |
| [bin/opencode-capped.sh](../bin/opencode-capped.sh) | `[launch]` | Launches opencode under a cgroup cap, bracketed by maintenance. |
| [bin/opencode-maintenance.sh](../bin/opencode-maintenance.sh) | mixed | Orchestrates metering, backup, retention, and one log line. |
| [bin/backup-rollback.sh](../bin/backup-rollback.sh) | mixed | `backup`, `list`, `rollback <ts>` for DB + config + plugins. |
| [bin/db-retention.sh](../bin/db-retention.sh) | `[refuses-while-running]` | Deletes old child sessions plus their events, then VACUUM. |
| [bin/summary-diff-prune.sh](../bin/summary-diff-prune.sh) | `[refuses-while-running]` | Rewrites stored `message.data.summary.diffs` patches. |
| [bin/storage-prune.sh](../bin/storage-prune.sh) | `[refuses-while-running]` | Quarantines then deletes orphan `session_diff`/`snapshot` files. |
| [bin/mega-session-export-delete.sh](../bin/mega-session-export-delete.sh) | `[refuses-while-running]` | Exports the two mega sessions, deletes only the non-active one. |
| [bin/pin-audit.sh](../bin/pin-audit.sh) | `[read-only]` | Flags unpinned or `@latest` plugin specs. |
| [bin/windows-owner-checklist.md](../bin/windows-owner-checklist.md) | `[windows]` | Human steps for `.wslconfig` and the host budget. |
| [bin/wslconfig-snippet.txt](../bin/wslconfig-snippet.txt) | `[windows]` | Exact `.wslconfig` content to paste. |
| [plugins/tool-output-spill.js](../plugins/tool-output-spill.js) | runtime | Spills oversized tool output to disk, keeps a preview. |
| [plugins/summary-diff-cap.js](../plugins/summary-diff-cap.js) | runtime | Caps `summary.diffs` in the transient prompt clone. |
| [plugins/context-governor.js](../plugins/context-governor.js) | runtime | Prunes active-context rot (placeholders, dedupe, purge, supersede). |
| [plugins/compaction-handoff.js](../plugins/compaction-handoff.js) | runtime | High-fidelity compaction handoff prompt. |
| [plugins/milestone-note.js](../plugins/milestone-note.js) | runtime | Appends a bounded current-state note and injects it into fresh sessions. |
| [plugins/attachment-bound.js](../plugins/attachment-bound.js) | runtime | Spills oversized attachments (PDF/image base64) with a preview. |
| [plugins/tool-concurrency.js](../plugins/tool-concurrency.js) | runtime | Pre-existing tool limiter. Not part of this plugin set. |
| [tests/spill.test.mjs](../tests/spill.test.mjs) | `[read-only]` | Unit tests for the spill plugin. |
| [tests/diffcap.test.mjs](../tests/diffcap.test.mjs) | `[read-only]` | Unit tests for the diff cap plugin. |
| [tests/governor.test.mjs](../tests/governor.test.mjs) | `[read-only]` | Unit tests for the context governor. |
| [tests/compaction.test.mjs](../tests/compaction.test.mjs) | `[read-only]` | Unit tests for the compaction handoff. |
| [tests/milestone.test.mjs](../tests/milestone.test.mjs) | `[read-only]` | Unit tests for the milestone note. |
| [tests/attachment.test.mjs](../tests/attachment.test.mjs) | `[read-only]` | Unit tests for attachment bounding. |
| [tests/plugins.unit.test.mjs](../tests/plugins.unit.test.mjs) | `[read-only]` | Cross-plugin unit suite. |
| [tests/retention.test.sh](../tests/retention.test.sh) | `[read-only]` | Integration test on a DB copy (never the live DB). |

Paths that are created on first use (absent until then): the backups root
(`$HOME/.local/share/opencode/backups/`), the spill dir
(`$HOME/.local/share/opencode/tool-spill/`), the exports dir
(`$HOME/.local/share/opencode/exports/`), the launcher log
(`$HOME/.config/opencode/logs/launcher.log`), and the daily cron logs
(`logs/cron-maintenance.log` one record per run, `logs/cron-maintenance.stdout.log`
transcript).

Sibling documents in this directory are referenced by filename: `ARCHITECTURE.md`,
`HOOKS.md`, `PLUGINS.md`, `DECISIONS.md`, plus the repo-level `README.md` and
`CONTRIBUTING.md`. They are authored separately from this guide.

## 1. Measure

The single measurement entry point is the read-only harness.

```bash
bash "$HOME/.config/opencode/bin/memory-ledger.sh"
```

Env overrides: `OPENCODE_DB` (default `$OPENCODE_HOME/opencode.db`), `OPENCODE_HOME`
(default `$HOME/.local/share/opencode`).

It opens the DB with `mode=ro` plus `PRAGMA query_only=ON`, so it never writes. It prints
seven sections:

| Section | Shows |
| --- | --- |
| (a) | DB, `-wal`, `-shm` file sizes |
| (b) | Row count and `SUM(length(data))` for `part`, `message`, `event` |
| (c) | Top 10 sessions by part + message bytes |
| (d) | `summary.diffs` patch and before/after UTF-8 bytes, total and per session |
| (e) | `du -sb` for `storage/session_diff`, `snapshot`, `tool-output` |
| (f) | Child sessions (`parent_id IS NOT NULL`) vs total sessions |
| (g) | Per opencode PID `VmRSS`, `VmHWM`, `VmSwap` from `/proc/<pid>/status` plus `statm` |

A missing DB gives a clear stderr error and exit 1, with no write to the DB path. Reading a
WAL-mode DB read-only still creates `-shm`/`-wal` next to it on first open; that is normal.

Cross-check a value with a direct read-only query. The `sqlite3` CLI is not assumed to be
installed, so these use `python3` (the shell expands `$HOME` inside the double-quoted
argument):

```bash
python3 -c "import sqlite3;c=sqlite3.connect('file:$HOME/.local/share/opencode/opencode.db?mode=ro',uri=True);print(c.execute(\"SELECT COUNT(*) FROM session WHERE parent_id IS NOT NULL\").fetchone()[0])"
```

Reference numbers measured on the authoring machine (expect different values on yours):
child 262 / total 270; `storage/session_diff` 90,871,168 B; `snapshot` 29,861,630 B;
`tool-output` 4,355,697 B; live `VmHWM` about 1,969,592 kB.

Run the plugin unit suites (all read-only):

```bash
node --test --no-warnings "$HOME/.config/opencode/tests/spill.test.mjs"
node --test --no-warnings "$HOME/.config/opencode/tests/diffcap.test.mjs"
node --test --no-warnings "$HOME/.config/opencode/tests/governor.test.mjs"
node --test --no-warnings "$HOME/.config/opencode/tests/compaction.test.mjs"
node --test --no-warnings "$HOME/.config/opencode/tests/milestone.test.mjs"
node --test --no-warnings "$HOME/.config/opencode/tests/attachment.test.mjs"
node --test --no-warnings "$HOME/.config/opencode/tests/plugins.unit.test.mjs"
```

Measured on the authoring machine: spill 11/11, diffcap 15/15, governor 10/10,
compaction 14/14, milestone 18/18, attachment 16/16, all exit 0.

Run the retention integration test (copies the DB, never touches the live one; 42 checks):

```bash
bash "$HOME/.config/opencode/tests/retention.test.sh"
```

## 2. Maintenance modes

`bin/opencode-maintenance.sh` is the one orchestration entry point. It provides a `--mode`
selector plus a `--dry-run` switch.

| Mode | Destructive? | Runs |
| --- | --- | --- |
| `--mode=safe` (default) | No | metering + backup only |
| `--mode=full` | Yes, only when opencode is stopped | everything safe mode does, plus the four `--apply` prune scripts |
| `--dry-run` | No | prints the exact sequence per mode, applies nothing |

If `--mode` is omitted, `safe` is the default. That is what the daily cron uses.

### `--mode=safe`

Runs metering (`memory-ledger.sh`, read-only) and a verified backup
(`backup-rollback.sh backup`). It never deletes sessions, rewrites diffs, or VACUUMs.
This is the cron mode.

```bash
bash "$HOME/.config/opencode/bin/opencode-maintenance.sh" --mode=safe
```

### `--mode=full`

Everything safe mode does, plus the destructive steps, and only when
`pgrep -x opencode` is empty:

1. `mega-session-export-delete.sh --apply` exports the mega sessions and deletes only the
   non-active one. This runs before the diff rewrite so the export captures original
   patches.
2. `db-retention.sh --apply` deletes old child sessions and their events, then VACUUMs.
3. `summary-diff-prune.sh --apply` rewrites stored `summary.diffs` patches for kept sessions.
4. `storage-prune.sh --apply` quarantines then deletes orphan `session_diff`/`snapshot` files.
5. One summary line is appended to the maintenance log.

Safety gates that must hold:

- No `--apply` and no VACUUM while opencode is alive. If it is alive, the full run skips all
  destructive steps, logs `reason=opencode_running`, and exits 0.
- Retention owns the only VACUUM, so the live DB is never double-vacuumed.
- Each `--apply` script writes its own internal DB backup before mutating, then checks
  `PRAGMA integrity_check` and `foreign_key_check` after.

```bash
# opencode MUST be stopped for the destructive steps
bash "$HOME/.config/opencode/bin/opencode-maintenance.sh" --mode=full
```

### `--dry-run`

Prints the exact command sequence the selected mode would run, and applies nothing.

```bash
bash "$HOME/.config/opencode/bin/opencode-maintenance.sh" --mode=full --dry-run
bash "$HOME/.config/opencode/bin/opencode-maintenance.sh" --mode=safe --dry-run
```

For `--mode=full`, `--dry-run` also invokes each destructive script's own read-only
`--dry-run` so the exact rows/paths to be removed are listed. Nothing is applied.

## 3. Daily cron entry

The daily job is non-destructive: it runs safe mode and records one line per run. It is
installed in the **root** crontab and runs at 03:30 every day.

> **EXAMPLE (machine-specific).** The line below is the authoring machine's installed
> crontab entry, with the account name replaced by `/home/<you>`. It uses an **absolute path**
> on purpose: cron executes through
> `/bin/sh -c`, `dash` does **not** expand `~`, and root's default cron `HOME` is `/root`
> (per `/etc/passwd`), not the opencode user's home. `HOME=` is therefore set explicitly so
> the script resolves its own defaults against the right home. On another machine,
> substitute that machine's real absolute paths (never `~`).

```cron
30 3 * * * HOME=/home/<you> LOG_FILE=/home/<you>/.config/opencode/logs/cron-maintenance.log /home/<you>/.config/opencode/bin/opencode-maintenance.sh --mode=safe >> /home/<you>/.config/opencode/logs/cron-maintenance.stdout.log 2>&1
```

Portable template (fill in your own absolute paths):

```cron
30 3 * * * HOME=<abs-home> LOG_FILE=<abs-config>/logs/cron-maintenance.log <abs-config>/bin/opencode-maintenance.sh --mode=safe >> <abs-config>/logs/cron-maintenance.stdout.log 2>&1
```

Why two files: `opencode-maintenance.sh` appends exactly **one** authoritative
`ts=... maintenance=run mode=safe ... rc=0` record to `LOG_FILE`
(`logs/cron-maintenance.log`). The cron `>>` redirect captures the human-readable
stdout/stderr transcript to `logs/cron-maintenance.stdout.log`, so a cron run never mails
output and never pollutes `logs/maintenance.log` (which the launcher's `--mode=full`
windows own).

Install and verify:

```bash
crontab /path/to/entry.cron                  # or: crontab -e, then paste the line
crontab -l | grep -c opencode-maintenance    # expect: 1
crontab -l | grep opencode-maintenance
tail -1 "$HOME/.config/opencode/logs/cron-maintenance.log"
pgrep -x cron || pgrep -x crond              # the daemon must be alive
systemctl is-active cron                     # expect: active
```

> **Implemented and verified:** `crontab -l` shows exactly one entry with the absolute path
> and `--mode=safe`. A manual run of the exact command exits 0 and appends exactly one line
> to `logs/cron-maintenance.log`. The cron daemon is active and enabled
> (`systemctl is-active cron` -> `active`, `is-enabled` -> `enabled`), so a scheduled run
> can fire. A controlled run against a DB snapshot left all row counts identical, confirming
> safe mode never deletes.

Systemd timer alternative: the per-user systemd manager was unreachable on the authoring
host (`systemctl --user` fails), so **cron is the active path here**. On a host where
`systemctl --user` works, the same non-destructive command can run from a user timer
instead; systemd captures stdout/stderr to the journal, so only `LOG_FILE` matters:

```ini
# ~/.config/systemd/user/opencode-maintenance.service
[Unit]
Description=opencode daily safe maintenance

[Service]
Type=oneshot
Environment=HOME=%h
Environment=LOG_FILE=%h/.config/opencode/logs/cron-maintenance.log
ExecStart=%h/.config/opencode/bin/opencode-maintenance.sh --mode=safe
```

```ini
# ~/.config/systemd/user/opencode-maintenance.timer
[Unit]
Description=Run opencode safe maintenance daily

[Timer]
OnCalendar=*-*-* 03:30:00
Persistent=true

[Install]
WantedBy=timers.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now opencode-maintenance.timer
systemctl --user list-timers opencode-maintenance.timer
```

Only `--mode=safe` is ever scheduled. No destructive command (`--mode=full`, any
`--apply`, or `VACUUM`) is ever put in cron or a timer.

## 4. At-close windows

The launcher [bin/opencode-capped.sh](../bin/opencode-capped.sh) brackets each session with
maintenance at two moments where opencode is stopped:

- **pre-launch:** before opencode starts.
- **post-exit:** after opencode exits, via an EXIT trap.

Both windows run `--mode=full`. Both must remain non-fatal: a missing or failing maintenance
script is logged but never blocks the launch, and opencode's own exit status is always
propagated.

```bash
bash "$HOME/.config/opencode/bin/opencode-capped.sh"
```

The launcher itself runs `--mode=full` at both windows; the orchestrator re-checks
`pgrep -x opencode` and skips the destructive steps (logging `reason=opencode_running`) if
opencode is somehow alive, so a stray process can never trigger a destructive apply here.
The pre-launch run does not block launch on failure, and the post-exit run is best-effort
after opencode's exit status has already been captured.

## 5. Recover from a crash

The failure mode this work targets is opencode being OOM-killed (exit 137) while the rest
of the WSL VM stays alive. The cgroup cap from the launcher (`MemoryMax=3G`,
`MemorySwapMax=2G`) is what confines the kill to opencode.

1. Confirm the kind of death. A cgroup kill shows as SIGKILL (exit 137) and the surrounding
   VM stays up:

   ```bash
   dmesg | tail -n 30
   ```

2. Check the logs. The maintenance orchestrator writes one line per run; the launcher only
   creates its log after the first capped launch.

   ```bash
   cat "$HOME/.config/opencode/logs/maintenance.log"
   cat "$HOME/.config/opencode/logs/launcher.log"
   ```

3. Measure current state. With opencode dead, section (g) reports "opencode not running":

   ```bash
   bash "$HOME/.config/opencode/bin/memory-ledger.sh"
   ```

4. Check DB integrity read-only before trusting it:

   ```bash
   python3 -c "import sqlite3;c=sqlite3.connect('file:$HOME/.local/share/opencode/opencode.db?mode=ro',uri=True);print(c.execute('PRAGMA integrity_check').fetchone()[0])"
   ```

   Expect `ok`. If it is not `ok`, or the DB will not open, restore from a backup (section 7).

5. Restart under the cap. Maintenance runs before launch and after exit, and a maintenance
   failure never blocks the launch:

   ```bash
   bash "$HOME/.config/opencode/bin/opencode-capped.sh"
   ```

6. If you suspect the crash came from a bad config or plugin, disable that layer
   (section 6) and relaunch.

Never run `session.revert` while a worktree is live. See the gotcha in section 10.

## 6. Disable each layer

Every layer can be turned off without uninstalling anything.

| Layer | Disable | Re-enable |
| --- | --- | --- |
| Cgroup cap | `OPENCAP_DISABLE=1 bash "$HOME/.config/opencode/bin/opencode-capped.sh"` (maintenance still runs) | run without the env var |
| Maintenance wiring in launcher | `OPENCAP_MAINTENANCE=/nonexistent bash "$HOME/.config/opencode/bin/opencode-capped.sh"` | run without the env var |
| Maintenance orchestrator | `chmod -x "$HOME/.config/opencode/bin/opencode-maintenance.sh"` | `chmod +x "$HOME/.config/opencode/bin/opencode-maintenance.sh"` |
| Built-in caps | remove or edit `tool_output`, `snapshot`, `compaction` keys in `opencode.json`, then restart | restore the keys, then restart |
| Any plugin | rename it so opencode stops loading it, then restart | rename back and restart |
| Retention | `RETENTION_DAYS=99999 bash "$HOME/.config/opencode/bin/db-retention.sh" --apply` | lower the value |
| Stored diff prune | do not run `summary-diff-prune.sh --apply` | run it |
| Filesystem prune | do not run `storage-prune.sh --apply`; to stop quarantine cleanup use `PURGE_AFTER_DAYS=99999 bash "$HOME/.config/opencode/bin/storage-prune.sh" --purge-trash` | run with a normal `PURGE_AFTER_DAYS` |
| Mega-session delete | skip `mega-session-export-delete.sh --apply`; `--export-only` still archives | run `--apply` |
| Windows swap plan | `[windows]` user reverts `%USERPROFILE%\.wslconfig` to the old `[wsl2]` block and runs `wsl --shutdown` | re-apply the snippet |

Important: plugins and config load only on opencode restart. Renaming a plugin or editing
`opencode.json` does nothing to the session that is already running.

The exact commands to disable the six custom plugins:

```bash
mv "$HOME/.config/opencode/plugins/tool-output-spill.js" "$HOME/.config/opencode/plugins/tool-output-spill.js.disabled"
mv "$HOME/.config/opencode/plugins/summary-diff-cap.js" "$HOME/.config/opencode/plugins/summary-diff-cap.js.disabled"
mv "$HOME/.config/opencode/plugins/context-governor.js" "$HOME/.config/opencode/plugins/context-governor.js.disabled"
mv "$HOME/.config/opencode/plugins/compaction-handoff.js" "$HOME/.config/opencode/plugins/compaction-handoff.js.disabled"
mv "$HOME/.config/opencode/plugins/milestone-note.js" "$HOME/.config/opencode/plugins/milestone-note.js.disabled"
mv "$HOME/.config/opencode/plugins/attachment-bound.js" "$HOME/.config/opencode/plugins/attachment-bound.js.disabled"
```

Reverse each with `mv ...js.disabled ...js`. Restart opencode after either direction.

## 7. Rollback

The rollback anchor is [bin/backup-rollback.sh](../bin/backup-rollback.sh). It copies the DB
(plus WAL/SHM), the opencode config, the plugins, and `$HOME/.omo/omo.jsonc` into a
timestamped directory and self-verifies every copy against its source hash.

List available backups (read-only):

```bash
bash "$HOME/.config/opencode/bin/backup-rollback.sh" list
```

Take a fresh backup before any risky change:

```bash
bash "$HOME/.config/opencode/bin/backup-rollback.sh" backup
```

Restore a backup. This refuses while opencode runs (exit 3, no writes); stop opencode first:

```bash
bash "$HOME/.config/opencode/bin/backup-rollback.sh" rollback <ts>
```

Manual restore pieces, if you prefer:

- Config and plugins: copy `<backup>/config/opencode.json` back to
  `$HOME/.config/opencode/opencode.json` and `<backup>/config/plugins/` back to
  `$HOME/.config/opencode/plugins/`.
- `omo.jsonc`: copy `<backup>/omo/omo.jsonc` back to `$HOME/.omo/omo.jsonc`.
- Remove any plugins you added by deleting the corresponding files in
  `$HOME/.config/opencode/plugins/`.
- DB: restore `<backup>/db/opencode.db` (and `-wal`/`-shm` if present) to
  `$HOME/.local/share/opencode/opencode.db`.

Individual destructive scripts also leave their own DB backups next to the DB, which you
can restore with `cp` (opencode stopped):

| Pattern | Written by |
| --- | --- |
| `opencode.db.bak-<ts>` | `db-retention.sh --apply` |
| `opencode.db.mega-bak-<ts>` | `mega-session-export-delete.sh --apply` |
| `opencode.db.summary-bak-<ts>` | `summary-diff-prune.sh --apply` |
| `trash-<ts>/` plus `MANIFEST.txt` | `storage-prune.sh --apply` (quarantine, not deleted) |

Config edits and plugin changes take effect only on the next opencode start, so after a
rollback you must restart opencode.

## 8. Deferred live maintenance sequence

A live destructive apply requires opencode STOPPED. While it runs, each of these exits 3
and writes nothing. Run them in this order during a maintenance session.

0. Stop opencode and prove it:

   ```bash
   pgrep -x opencode
   ```

   Expect no output. Do not continue if it prints a PID.

1. Take the rollback anchor `[read-only while running; writes a backup]`:

   ```bash
   bash "$HOME/.config/opencode/bin/backup-rollback.sh" backup
   ```

2. Export the two mega sessions, then delete only the non-active one. Run this BEFORE the
   diff rewrite so the export captures original patches `[apply/deferred]`:

   ```bash
   bash "$HOME/.config/opencode/bin/mega-session-export-delete.sh" --apply
   ```

3. Delete old child sessions and their events, then VACUUM `[apply/deferred]`:

   ```bash
   bash "$HOME/.config/opencode/bin/db-retention.sh" --apply
   ```

4. Rewrite stored `summary.diffs` patches for kept sessions `[apply/deferred]`:

   ```bash
   bash "$HOME/.config/opencode/bin/summary-diff-prune.sh" --apply
   ```

5. Quarantine then delete orphan `session_diff`/`snapshot` files `[apply/deferred]`. Once
   you have verified the prune, reclaim disk with `--purge-trash`:

   ```bash
   bash "$HOME/.config/opencode/bin/storage-prune.sh" --apply
   bash "$HOME/.config/opencode/bin/storage-prune.sh" --purge-trash
   ```

6. Final metering plus one log line. This is idempotent and safe to run daily; it skips
   retention if opencode is somehow alive `[writes a backup + log]`:

   ```bash
   bash "$HOME/.config/opencode/bin/opencode-maintenance.sh" --mode=safe
   ```

7. If any step looks wrong, restore the step-1 backup `[apply/deferred]`:

   ```bash
   bash "$HOME/.config/opencode/bin/backup-rollback.sh" rollback <ts>
   ```

Notes:

- Step 2 (mega export) intentionally runs before step 4 (diff rewrite) to preserve export
  fidelity, and step 1 is the explicit rollback anchor. Both apply scripts also back up
  internally, so a full stopped run produces more than one backup by design.
- Every `--apply` script verifies `PRAGMA integrity_check` and `foreign_key_check` after
  writing, and opens write connections with `PRAGMA foreign_keys=ON`.
- `ALLOW_WHILE_RUNNING=1` exists for the tests only. Do not set it on a live DB.
- `--mode=full` runs steps 2 through 5 as one gated orchestrator call; the hand-run
  sequence above is only for manual recovery or debugging.

## 9. Plugin inventory

Per-plugin details live in `PLUGINS.md`. This is the short map.

| Plugin | Hooks | What it does | Env knobs |
| --- | --- | --- | --- |
| `tool-output-spill.js` | `tool.execute.after` | If a tool result exceeds `SPILL_MAX_BYTES` (default 200000), writes the full text to `SPILL_DIR`, then replaces the output with a pointer plus a first-200-lines / 8000-byte preview. Excludes `task`, `batch`, `compress`. Never throws. | `SPILL_MAX_BYTES`, `SPILL_DIR` |
| `summary-diff-cap.js` | `experimental.chat.messages.transform` | Caps each `summary.diffs[*].patch` to 64KB and the total to 512KB per message, and drops vendor/generated paths. Prompt-only, transient clone; stored bytes are handled by `summary-diff-prune.sh`. Never throws. | `DIFF_MAX_PATCH_BYTES`, `DIFF_MAX_TOTAL_BYTES` |
| `context-governor.js` | `experimental.chat.messages.transform` | Single-session context rot pruning: placeholder old or oversized tool outputs, dedupe identical stateless calls keeping the latest, purge resolved error inputs, and collapse only explicitly superseded entries. Protected tools and running calls are never touched. Prefix-stable between compactions. | `PLACEHOLDER_BYTES`, `PURGE_ERROR_TURNS`, `SPILL_DIR` (read at module load) |
| `compaction-handoff.js` | `experimental.session.compacting` | Replaces the lossy default summary with a structured handoff: goal, verbatim user constraints, decisions, debugging state, active files, open errors, next steps, and the last user message verbatim. Never sets `context` when it sets `prompt`. Never throws. | none |
| `milestone-note.js` | `event`, `experimental.chat.system.transform` | On `session.compacted` / `session.idle`, appends a bounded (4KB) current-state block to the note file, and injects the latest block into a fresh session's system prompt. Append-only, refuses paths outside `<worktree>/.omo/`. | `MILESTONE_NOTE_PATH` |
| `attachment-bound.js` | `tool.execute.after`, `chat.message`, `experimental.chat.messages.transform` | Spills any attachment URL over `MAX_ATTACHMENT_BYTES` (default 1MB) to disk and replaces it with a small text preview plus pointer. Bounds built-in `read` on PDF/image and pasted or dragged files at stored hooks. MCP/custom tool payloads are prompt-only. Never throws. | `MAX_ATTACHMENT_BYTES`, `ATTACHMENT_SPILL_DIR`, `ATTACHMENT_PREVIEW_BYTES` |

Attachment rules:

1. Prefer text extraction over `read` on a whole PDF. `read` on a PDF base64-encodes the
   entire file; one measured PDF stored 19,981,034 bytes twice.
2. Do not `read` whole PDFs or large binaries. Use `pdftotext`, `python3` (pypdf), `grep`,
   or read only the pages you need.
3. Rely on attachment spill when a large attachment is unavoidable.
4. Avoid pasting multi-MB images. They are bounded at `chat.message`, but small is better.

`tool-concurrency.js` is pre-existing and not part of this plugin set.

## 10. Threshold tuning

Config levers live in `$HOME/.config/opencode/opencode.json` (changes apply on the next
opencode start):

| Key | Reference value | Effect |
| --- | --- | --- |
| `tool_output.max_lines` | `800` | Truncates tool text output to this many lines. |
| `tool_output.max_bytes` | `24576` | Truncates tool text output to this many bytes. |
| `snapshot` | `false` | Disables file snapshots (removes undo/revert of file changes). |
| `compaction.auto` | `true` | Automatic compaction stays on. |
| `compaction.prune` | `true` | Prunes stale entries during compaction (marks `time.compacted`, does not delete bytes). |
| `compaction.preserve_recent_tokens` | `6000` | Recent tokens kept during compaction. |
| `compaction.tail_turns` | `3` | Recent turns kept during compaction. |

Plugin env knobs are read differently per plugin. The spill, diffcap, and attachment
plugins read env at call time; the context governor reads env at module load, so changing
its knobs needs a restart.

| Plugin | Env knob | Default | Meaning |
| --- | --- | --- | --- |
| tool-output-spill | `SPILL_MAX_BYTES` | `200000` | Spill above this many bytes. |
| tool-output-spill | `SPILL_DIR` | `$HOME/.local/share/opencode/tool-spill` | Where spilled output is written. |
| summary-diff-cap | `DIFF_MAX_PATCH_BYTES` | `65536` | Per-file patch cap. |
| summary-diff-cap | `DIFF_MAX_TOTAL_BYTES` | `524288` | Total patch cap per message. |
| context-governor | `PLACEHOLDER_BYTES` | `8000` | Replace an output larger than this with a placeholder. |
| context-governor | `PURGE_ERROR_TURNS` | `4` | Purge resolved error inputs this many turns below the watermark. |
| context-governor | `SPILL_DIR` | `$HOME/.local/share/opencode/tool-spill` | Spill pointer lookup dir. |
| attachment-bound | `MAX_ATTACHMENT_BYTES` | `1048576` | Spill attachments above this many URL bytes. |
| attachment-bound | `ATTACHMENT_SPILL_DIR` | `$HOME/.local/share/opencode/tool-spill/attachments` | Where full attachment payloads are written. |
| attachment-bound | `ATTACHMENT_PREVIEW_BYTES` | `4096` | Preview bytes in the placeholder. |
| milestone-note | `MILESTONE_NOTE_PATH` | `<worktree>/.omo/notepads/.../current-state.md` | Note file. Default is hard-bounded to `<worktree>/.omo/`. |

Script env knobs:

| Script | Env knob | Default |
| --- | --- | --- |
| memory-ledger | `OPENCODE_DB`, `OPENCODE_HOME` | live DB, `$HOME/.local/share/opencode` |
| opencode-capped | `OPENCAP_MEMORY_MAX`, `OPENCAP_SWAP_MAX` | `3G`, `2G` |
| opencode-capped | `OPENCAP_DISABLE` | `0` |
| opencode-capped | `OPENCAP_MAINTENANCE`, `OPENCAP_LOG`, `OPENCODE_BIN` | sibling orchestrator, `logs/launcher.log`, PATH `opencode` |
| opencode-maintenance | `OPENCODE_DB`, `OPENCODE_HOME`, `BACKUP_ROOT`, `LOG_FILE`, `RETENTION_DAYS`, `BIN_DIR`, `CONFIG_DIR`, `OMO_JSONC` | live values, `logs/maintenance.log`, `2` |
| backup-rollback | `BACKUP_ROOT`, `OPENCODE_DB`, `CONFIG_DIR`, `OMO_JSONC`, `ALLOW_WHILE_RUNNING` | `$HOME/.local/share/opencode/backups`, live values |
| db-retention | `OPENCODE_DB`, `RETENTION_DAYS`, `ALLOW_WHILE_RUNNING`, `BOULDER_JSON` | live DB, `2`, `0`, auto-located |
| summary-diff-prune | `OPENCODE_DB`, `ALLOW_WHILE_RUNNING`, `DIFF_MAX_PATCH_BYTES`, `DIFF_MAX_TOTAL_BYTES`, `BACKUP_ROOT`, `DIFF_TOTAL_SCOPE`, `DIFF_TOTAL_POLICY` | live DB, `0`, `65536`, `524288`, DB dir, `session`, `truncate` |
| storage-prune | `OPENCODE_HOME`, `OPENCODE_DB`, `TRASH_ROOT`, `PURGE_AFTER_DAYS`, `ALLOW_WHILE_RUNNING` | `$HOME/.local/share/opencode`, live DB, same, `7`, `0` |
| mega-session-export-delete | `OPENCODE_DB`, `EXPORT_DIR`, `OPENCODE_BIN`, `MEGA_SESSIONS`, `EXPORT_SESSIONS`, `DELETE_SESSIONS`, `PROTECTED_SESSIONS`, `BOULDER_JSON`, `ALLOW_WHILE_RUNNING`, `SKIP_EXPORT` | live DB, `$HOME/.local/share/opencode/exports`, `opencode`, the two mega ids |
| pin-audit | `OPENCODE_JSON`, `OMO_JSONC` | `$HOME/.config/opencode/opencode.json`, `$HOME/.omo/omo.jsonc` |

Set a knob for one run without editing anything:

```bash
RETENTION_DAYS=14 bash "$HOME/.config/opencode/bin/db-retention.sh" --dry-run
```

If export fidelity of patches matters, tune (lower) `summary-diff-prune` only AFTER the
mega-session export has run. See section 8.

## 11. Known gotchas

- opencode must be stopped for any destructive `--apply`. While it runs, `db-retention`,
  `summary-diff-prune`, `storage-prune`, and `mega-session-export-delete` exit 3 and write
  nothing. `ALLOW_WHILE_RUNNING=1` is for tests only; never use it on a live DB.
- Never run `session.revert` against a session that references a live worktree. A spike
  proved that v1 revert replays file ops using absolute paths recorded in the session, so
  it modified the live worktree even when the copy's `session.directory` and
  `project.worktree` were redirected. It deleted 31 tracked files twice, both restored
  byte-for-byte. A hermetic revert test on a DB copy is not possible without rewriting
  absolute paths in every file-mutating tool part.
- Plugins and config load only on restart. The running opencode uses the config and plugins
  it started with; renaming a plugin or editing `opencode.json` changes nothing until the
  next start.
- The `sqlite3` CLI is not assumed to be installed. Scripts use `python3` with the stdlib
  `sqlite3` module. Use `python3` for ad hoc queries too.
- Config validation: unknown keys are silently dropped by `opencode debug config` (no
  warning), but invalid values are hard-rejected with exit 1. `opencode debug config` is
  not a reliable warning surface for unknown keys.
- `tool_output` does not cover attachment/`file` parts. That is why `attachment-bound.js`
  exists.
- The `summary-diff-cap` plugin is prompt-only (transient clone). Stored bytes are only
  changed by `summary-diff-prune.sh --apply`.
- The context governor reads its env at module load, so knob changes need a restart.
- `storage-prune.sh` refuses to run if the `session` or `project` id set is empty, so a
  wrong or empty DB cannot make it treat everything as orphans.
- The active boulder session, and every id listed in `.omo/boulder.json`, is protected and
  never deleted by retention or the mega delete.
- Reading the WAL-mode DB read-only still creates `-shm`/`-wal` next to it.
- Node 24 auto-detects ESM in the `.js` plugins and prints a typeless-package warning, so
  use `node --test --no-warnings`.

## 12. Windows-only steps (user actions)

These cannot be run by the agent. Each is marked `[windows]` and all are user-run steps on
the Windows host.

1. `[windows]` Edit `%USERPROFILE%\.wslconfig` to the block in
   [bin/wslconfig-snippet.txt](../bin/wslconfig-snippet.txt):

   ```
   [wsl2]
   memory=4GB
   swap=8GB
   pageReporting=true
   ```

2. `[windows]` Run `wsl --shutdown` in Windows PowerShell, then reopen WSL.

3. `[windows]` Verify inside WSL with `free -h` (Swap near 8.0Gi) and
   `cat /proc/meminfo | head` (MemTotal near 4GiB).

Full checklist and host budget:
[bin/windows-owner-checklist.md](../bin/windows-owner-checklist.md).

## 13. Quick command index

```bash
# Measure [read-only]
bash "$HOME/.config/opencode/bin/memory-ledger.sh"
node --test --no-warnings "$HOME/.config/opencode/tests/spill.test.mjs"
node --test --no-warnings "$HOME/.config/opencode/tests/diffcap.test.mjs"
node --test --no-warnings "$HOME/.config/opencode/tests/governor.test.mjs"
node --test --no-warnings "$HOME/.config/opencode/tests/compaction.test.mjs"
node --test --no-warnings "$HOME/.config/opencode/tests/milestone.test.mjs"
node --test --no-warnings "$HOME/.config/opencode/tests/attachment.test.mjs"
node --test --no-warnings "$HOME/.config/opencode/tests/plugins.unit.test.mjs"
bash "$HOME/.config/opencode/tests/retention.test.sh"

# Audit pins [read-only]
bash "$HOME/.config/opencode/bin/pin-audit.sh"

# Maintenance modes (see section 2; safe is the default)
bash "$HOME/.config/opencode/bin/opencode-maintenance.sh" --mode=safe
bash "$HOME/.config/opencode/bin/opencode-maintenance.sh" --mode=full
bash "$HOME/.config/opencode/bin/opencode-maintenance.sh" --mode=full --dry-run

# Read-only dry-runs [read-only]
bash "$HOME/.config/opencode/bin/db-retention.sh" --dry-run
bash "$HOME/.config/opencode/bin/summary-diff-prune.sh" --dry-run
bash "$HOME/.config/opencode/bin/storage-prune.sh" --dry-run

# Rollback [read-only list; rollback needs opencode stopped]
bash "$HOME/.config/opencode/bin/backup-rollback.sh" list
bash "$HOME/.config/opencode/bin/backup-rollback.sh" backup
bash "$HOME/.config/opencode/bin/backup-rollback.sh" rollback <ts>

# Daily / safe while running [writes log]
bash "$HOME/.config/opencode/bin/opencode-maintenance.sh" --mode=safe

# Launch [launch]
bash "$HOME/.config/opencode/bin/opencode-capped.sh"

# Deferred destructive apply (opencode MUST be stopped)
bash "$HOME/.config/opencode/bin/backup-rollback.sh" backup
bash "$HOME/.config/opencode/bin/mega-session-export-delete.sh" --apply
bash "$HOME/.config/opencode/bin/db-retention.sh" --apply
bash "$HOME/.config/opencode/bin/summary-diff-prune.sh" --apply
bash "$HOME/.config/opencode/bin/storage-prune.sh" --apply
bash "$HOME/.config/opencode/bin/storage-prune.sh" --purge-trash
bash "$HOME/.config/opencode/bin/opencode-maintenance.sh" --mode=safe
bash "$HOME/.config/opencode/bin/backup-rollback.sh" rollback <ts>
```
