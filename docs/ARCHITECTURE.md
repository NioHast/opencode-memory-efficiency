# Architecture

System-level view of the opencode memory-efficiency plugins. This document explains
what the pieces are, how a hook call flows through them, and which invariants keep the
whole thing safe. It does not replace the runbook. For day-to-day operation, scheduling,
measurement, crash recovery, threshold tuning, and rollback, read [OPERATIONS.md](OPERATIONS.md).

## Purpose

A single long-running opencode session can grow without bound: tool output, base64
attachments, stored `summary.diffs`, and the conversation prompt itself all accumulate.
This repo keeps that growth inside a budget without forcing the user to switch sessions
or remember maintenance. It does so at two layers:

- **Prompt layer (transient).** The next provider call is made smaller, cache-friendly,
  and bounded. Nothing here changes the database.
- **Storage layer (durable).** Oversized tool output and attachments are moved to disk
  before they are persisted, and legacy bytes are pruned under a destructive policy that
  only runs when opencode is closed.

A system-level document exists because the interesting behavior is not in any single
file. It is in how the seven plugins share a small hook surface, and how that cooperation
interacts with the runtime's prefix cache and with the subagent lifecycle owned by
`oh-my-openagent`.

## Component map

```
~/.config/opencode/
├── plugins/                     # 7 local plugins, auto-discovered by opencode
│   ├── tool-concurrency.js       # in-memory tool-call gate
│   ├── tool-output-spill.js      # storage bound for tool output
│   ├── attachment-bound.js       # storage + prompt bound for file/attachment parts
│   ├── context-governor.js       # 4-rule prompt shrinker (prefix-stable)
│   ├── summary-diff-cap.js       # prompt bound for summary.diffs
│   ├── compaction-handoff.js     # high-fidelity compaction prompt
│   └── milestone-note.js         # session continuity note (write + inject)
├── bin/                         # operational scripts (metering, backup, prune, launcher)
├── tests/                       # node:test suites + shell retention/context tests
├── docs/                        # this document and its siblings
└── opencode.json                # runtime config (models, tool_output, compaction)

~/.omo/omo.jsonc                 # agent config; legacy background_task under "[opencode]"
~/.local/share/opencode/         # opencode.db, tool-spill/, backups/, logs/
```

`oh-my-openagent` is a separate npm plugin pinned in `opencode.json`. It owns the agent
roster and the `task` tool family. The local plugins do not reimplement agents, and they
deliberately do not gate `task` calls, so subagent concurrency is delegated to it.

## Data flow

All seven local plugins and every hook they register appear below. Arrows show which
runtime event reaches which plugin. `(T)` marks a transient, prompt-only mutation.
`(S)` marks a stored, durable write.

```
                          opencode runtime 1.18.32
                                    |
   +--------------------------------+-------------------------------------+
   |                                |                                     |
   v                                v                                     v
[tool.execute.before]        [chat.message]            [experimental.chat.messages.transform]
   |                                |                                     |
   v                                v                                     |
tool-concurrency.js          attachment-bound.js                          |
(acquire slot, (T))          (bound type:'file' parts, (S))               |
   |                                |                                     |
   v                                |                    +----------------+----------------+
[tool runs]                         |                    |                |                |
   |                                |                    v                v                v
   v                                |            context-governor.js  summary-diff-cap.js  attachment-bound.js
[tool.execute.after]                |            (4 rules, (T))        (cap diffs, (T))     (bound again, (T))
   |                                |                    |                |                |
   +-- tool-output-spill.js <-------+--------------------+----------------+----------------+
   |   (spill >200KB, preview+pointer, (S))                                     |
   |                                                                            v
   +-- attachment-bound.js                                            provider call uses the
   |   (spill oversized attachments, (S))                             shrunk prompt (prefix
   |                                                                  cache keys on these bytes)
   +-- tool-concurrency.js
       (release slot, (T))

[experimental.session.compacting]         [event: session.compacted | session.idle]
   |                                          |
   v                                          v
compaction-handoff.js                    milestone-note.js
(8-section handoff prompt, (T),          (append bounded 4KB block to
 shapes the stored summary)               .omo/notepads/.../current-state.md, (S))
                                              |
[experimental.chat.system.transform] <--------+
   |
   v
milestone-note.js
(prepend latest block for a fresh session, (T))
```

The spill directory is shared: tool output goes to `~/.local/share/opencode/tool-spill/`,
attachments go to its `attachments/` subdirectory.

## Hook map

Every hook name below is present verbatim in the plugin sources. `stored` means the
mutation survives a restart; `transient` means it only affects the next provider call or
in-memory state.

| Plugin | Hook | Effect | Stored vs transient |
|---|---|---|---|
| `tool-concurrency.js` | `tool.execute.before` | Acquire one of `MAX_CONCURRENCY=2` slots for non-excluded tools. A `TTL_MS=10min` timer releases a leaked slot. | Transient (in-memory) |
| `tool-concurrency.js` | `tool.execute.after` | Release the slot for that `callID`. | Transient (in-memory) |
| `tool-output-spill.js` | `tool.execute.after` | When `output.output` exceeds `MAX_OUTPUT_BYTES` (200000), write the full text to `<callID>.txt` and replace it with a pointer plus a bounded preview. Excludes `task`, `batch`, `compress`. | Stored (tool part is persisted after the hook) |
| `attachment-bound.js` | `tool.execute.after` | When an attachment `url` exceeds `MAX_ATTACHMENT_BYTES` (1MB), spill the decoded payload and replace the attachment in place with a `text/plain` pointer plus preview. Covers built-in `read` on PDF/image and `webfetch` images. | Stored (attachments array is persisted) |
| `attachment-bound.js` | `chat.message` | Bound `type:'file'` user-message parts in place before opencode persists them. Covers pasted images and dragged files. | Stored (same `parts` array is persisted) |
| `attachment-bound.js` | `experimental.chat.messages.transform` | Defense-in-depth: bound `type:'file'` parts and `part.state.attachments` inside the cloned messages. | Transient (prompt only) |
| `context-governor.js` | `experimental.chat.messages.transform` | Apply four rules in order: placeholders, dedupe identical calls, purge resolved error inputs, explicit supersession. Never touches protected tools or running calls. | Transient (prompt only) |
| `summary-diff-cap.js` | `experimental.chat.messages.transform` | Drop vendor paths, truncate each patch to `DIFF_MAX_PATCH_BYTES`, and cap the total to `DIFF_MAX_TOTAL_BYTES`. Malformed entries stay byte-identical. | Transient (prompt only) |
| `compaction-handoff.js` | `experimental.session.compacting` | Replace the lossy default compaction prompt with an 8-section handoff. Never sets `output.context` while `output.prompt` is set. | Transient hook output; it shapes the summary opencode then stores |
| `milestone-note.js` | `event` | On `session.compacted` and `session.idle`, append a bounded 4KB state block to the milestone note. Append-only, boundary-checked. | Stored (file on disk) |
| `milestone-note.js` | `experimental.chat.system.transform` | Prepend the latest note block to `output.system`, once per fresh session. | Transient (prompt only) |

The three plugins that share `experimental.chat.messages.transform`
(`context-governor.js`, `summary-diff-cap.js`, `attachment-bound.js`) touch disjoint
fields, so their order on that hook does not change the result. The contract and the
ordering guarantees are detailed in [HOOKS.md](HOOKS.md).

## Plugin load order

opencode resolves and runs plugins in a fixed order. Local plugin files are discovered
from `plugins/`, and the operational entrypoint for scheduled work is
`bin/opencode-maintenance.sh`. On 1.18.32 the resolved order is:

```
1. oh-my-openagent@5.0.0-beta.90
2. plugins/compaction-handoff.js
3. plugins/attachment-bound.js
4. plugins/milestone-note.js
5. plugins/tool-output-spill.js
6. plugins/context-governor.js
7. plugins/tool-concurrency.js
8. plugins/summary-diff-cap.js
```

For a shared hook, handlers run **sequentially** in that order. The critical property is
failure isolation: **a throw aborts the remaining plugin chain**. A single uncaught error
in one plugin would silently disable every later plugin on the same hook. That is why
every hook body in every plugin is wrapped in `try/catch`, and why the plugins are
written to no-op rather than fail when their payload shape is unexpected. A spill write
failure, for example, leaves the tool output byte-identical.

## Prefix-cache constraint

Providers cache the conversation prefix by exact bytes. When a prompt transform rewrites
bytes that were already sent, the cache misses, and both latency and cost rise on every
turn. A naive "always shrink the oldest messages" policy breaks this: as the window
slides, the prefix changes on each call.

The governor avoids that with a **monotonic watermark**. A compaction marker is a
`Part` with `type === "compaction"`, or an assistant message with `info.summary === true`.
The watermark is the index of the last such marker ever observed for a session, stored in
a module-level map. It only advances when a higher marker appears. It never follows the
tail.

Every rule therefore keys on a frozen property:

- Rule 1 (placeholders) fires for a message whose index is below the watermark, or whose
  own output exceeds `PLACEHOLDER_BYTES`. Both conditions are stable across turns.
- Rule 2 (dedupe) groups by `(session, tool, stableStringify(input))` and keeps the
  latest. Earlier duplicates are inherently in the already-frozen region.
- Rule 3 (purge error inputs) requires `index < watermark - PURGE_ERROR_TURNS`, measured
  from the monotonic watermark, not from a sliding tail.
- Rule 4 (supersession) only acts on parts explicitly tagged with
  `metadata.supersededBy`, or `metadata.superseded === true` plus a newer part carrying
  `metadata.supersedes`.

Because none of these depends on the tail, appending new turns leaves the earlier prefix
byte-identical between compactions. The governor uses generic placeholder text for the
same reason. This is asserted by the prefix-stability test in the plugin suite.

## Relationship with oh-my-openagent

`oh-my-openagent@5.0.0-beta.90` supplies the agent roster and the `task` tool family
(`task`, `background_output`, `background_cancel`). It is configured through
`~/.omo/omo.jsonc`. Three of its behaviors matter to this repo:

- **Agents.** Named agents (plan, build, explore, oracle, librarian, and so on) run inside
  subagent sessions that opencode manages. The local plugins only see the resulting tool
  calls; they do not define agents.
- **Descendant cap.** `background_task.maxLiveDescendantsPerRoot` (default **24**) limits
  live descendant sessions per root session. `background_task.maxDepth` (default **3**)
  bounds nesting. The two spawn paths settle the reservation differently: a background
  task calls `unregisterRootDescendant(rootSessionId)` on completion or error (releasing
  its slot), while a foreground/sync task that spawns successfully calls only
  `spawnReservation.commit()` and never decrements, so foreground-heavy work can reach the
  cap and block further spawns. Setting `maxLiveDescendantsPerRoot` to `0` disables the cap
  (the check is `maxDescendants !== 0 && count >= maxDescendants`); that is the recommended
  value for long sessions. **Placement matters:** in `~/.omo/omo.jsonc` these legacy
  settings must live under the `"[opencode]"` harness block (e.g.
  `"[opencode]": { "background_task": { ... } }`). A *top-level* `background_task` key is
  rejected by the strict core `OmoConfigSchema` and silently ignored at runtime, while
  emitting `[config-migration] ... Unrecognized key: "background_task"` at startup. The
  live config therefore carries **only** the `"[opencode]"` block: the redundant top-level
  duplicate has been removed, so no such warning is emitted.
- **`task.*` concurrency.** A `ConcurrencyManager` bounds simultaneous background tasks by
  model, provider, or `background_task.defaultConcurrency` (with a code fallback of 5).
  `tool-concurrency.js` excludes `task` and `batch`, so it never gates subagents. Subagent
  concurrency is delegated to oh-my-openagent entirely. This split is recorded in
  `DECISIONS.md`.

## Subagent lifecycle & concurrency

`oh-my-openagent` tracks one counter per **root** session in
`rootDescendantCounts` (root sessions are resolved by walking the parent chain; a root has
no parent). The lifecycle differs by spawn path, and the difference is the whole reason
this convention exists:

- **Background spawn (`run_in_background=true`).** Reserving a spawn calls
  `reserveSubagentSpawn(parentSessionID)`, which throws the descendant-cap error at
  `maxLiveDescendantsPerRoot`, then calls `registerRootDescendant(rootSessionID)`. When the
  task later completes *or* errors, the manager calls
  `unregisterRootDescendant(task.rootSessionId)`, so the slot is returned to the pool and
  the counter can fall back to `0`.
- **Foreground/sync spawn (`run_in_background=false`).** The same
  `reserveSubagentSpawn` is used, but on a successful session create the path calls only
  `spawnReservation.commit()` (`settled = true; return descendantCount`). `commit()` never
  decrements. Only a *failed* create calls `spawnReservation.rollback()`, which is the
  single place the sync path calls `unregisterRootDescendant`. Net effect: every
  **successful** sync subagent permanently occupies one slot for the life of the server
  process, so a sync fan-out leaks slots until it reaches the cap and blocks.

Because of that asymmetry, **fan-out should use `run_in_background=true`**: background work
stays within the concurrency and descendant budgets, while a foreground burst of more than
`maxLiveDescendantsPerRoot` successful spawns self-blocks even though each child has already
finished.

RAM peaks during fan-out are easy to misattribute. The measured picture:

- **Monitoring overhead is metadata and timers, not the bottleneck.** Tracking live
  tasks, notification queues, deferral timers, and the completed-task archive costs
  kilobytes. It does not scale with task *size*.
- **The real peak driver is concurrency.** Each concurrently running subagent holds its
  own context and tool state, so peak memory scales with the number of sessions in flight
  at once. That is bounded by `background_task.defaultConcurrency`. Keep it small (for
  example 2) and do not set it to `0`, which removes the bound.
- **Live-task TTL.** A live task expires after `taskTtlMs`, default **1800000 ms (30 min)**.
- **The completed-task archive is bounded.** `MAX_COMPLETED_TASK_ARCHIVE_SIZE = 100`.
  When a task completes and the archive exceeds 100 entries, the oldest entry is evicted,
  so a long fan-out cannot grow memory without limit.

## Cleanup and retention model

Retention follows **Option 1**: destructive work is only allowed when opencode is closed,
and a daily check stays non-destructive.

- **Daily safe mode (non-destructive).** A cron entry runs maintenance in safe mode:
  metering plus a backup. It never deletes, vacuums, or checkpoints the live database.
- **Full mode (at-close).** The launcher runs the full sweep in its pre/post windows.
  Destructive steps (`db-retention`, `summary-diff-prune`, `storage-prune`,
  `mega-session-export-delete`) run **only when `pgrep -x opencode` is empty**. If
  opencode is alive, they are skipped and the run still exits cleanly.
- **Safety rails.** Every destructive script defaults to dry-run, archives or backs up
  before deleting, refuses `--apply` while opencode runs, and appends exactly one summary
  log line per run.

This section states the policy, not the procedure. The exact commands, the cron entry,
the launch windows, per-layer disable switches, and rollback steps live in [OPERATIONS.md](OPERATIONS.md).

## Configuration and environment reference

Plugin environment knobs, all resolved at call time unless noted. Defaults come from the
plugin sources.

| Plugin | Env var | Default | Meaning |
|---|---|---|---|
| `tool-output-spill.js` | `SPILL_MAX_BYTES` | `200000` | Spill threshold for `output.output`, in bytes. |
| `tool-output-spill.js` | `SPILL_DIR` | `~/.local/share/opencode/tool-spill` | Spill directory for tool output. |
| `context-governor.js` | `PLACEHOLDER_BYTES` | `8000` | Outputs larger than this are placeholderized even above the watermark. |
| `context-governor.js` | `PURGE_ERROR_TURNS` | `4` | Turns below the watermark before an error input may be purged. |
| `context-governor.js` | `SPILL_DIR` | `~/.local/share/opencode/tool-spill` | Directory searched for a callID spill pointer. |
| `attachment-bound.js` | `MAX_ATTACHMENT_BYTES` | `1048576` | Attachment `url` size cap, in bytes. |
| `attachment-bound.js` | `ATTACHMENT_PREVIEW_BYTES` | `4096` | Preview bytes kept in the replacement note. |
| `attachment-bound.js` | `ATTACHMENT_SPILL_DIR` | `~/.local/share/opencode/tool-spill/attachments` | Spill directory for decoded attachments. |
| `summary-diff-cap.js` | `DIFF_MAX_PATCH_BYTES` | `65536` | Per-file patch cap. |
| `summary-diff-cap.js` | `DIFF_MAX_TOTAL_BYTES` | `524288` | Total retained patch bytes per message. |
| `milestone-note.js` | `MILESTONE_NOTE_PATH` | `<worktree>/.omo/notepads/opencode-memory-efficiency/current-state.md` | Override for the note path (used by tests). |
| `tool-concurrency.js` | none | `MAX_CONCURRENCY = 2` | Source constant; edit the file and restart to change. |
| `compaction-handoff.js` | none | `MAX_TEMPLATE_BYTES = 8192` | Source constants only. |

Runtime config knobs, in `opencode.json`:

| Key | Current value | Meaning |
|---|---|---|
| `tool_output.max_lines` | `800` | Built-in tool-output line cap. |
| `tool_output.max_bytes` | `24576` | Built-in tool-output byte cap. |
| `snapshot` | `false` | Disables snapshot storage. |
| `compaction.auto` | `true` | Enables automatic compaction. |
| `compaction.prune` | `true` | Enables compaction pruning. |
| `compaction.preserve_recent_tokens` | `6000` | Recent-token floor kept intact. |
| `compaction.tail_turns` | `3` | Recent turns kept verbatim. |

Agent and subagent knobs, in `~/.omo/omo.jsonc` under `"[opencode]".background_task`
(the top-level `background_task` key is inert — see the descendant-cap note above):
`defaultConcurrency`, `providerConcurrency`, `modelConcurrency`, `maxDepth`,
`maxLiveDescendantsPerRoot`, `taskTtlMs`, `staleTimeoutMs`, `messageStalenessTimeoutMs`,
`sessionGoneTimeoutMs`, `taskCleanupDelayMs`, `syncPollTimeoutMs`, `maxToolCalls`, and
`circuitBreaker`. Operational script knobs (`OPENCODE_DB`, `BACKUP_ROOT`,
`RETENTION_DAYS`, `ALLOW_WHILE_RUNNING`, and friends) are documented in [OPERATIONS.md](OPERATIONS.md).

## Related documentation

- [OPERATIONS.md](OPERATIONS.md): sanitized runbook. Scheduling, maintenance modes,
  measurement, crash recovery, threshold tuning, per-layer disable, and rollback.
- [HOOKS.md](HOOKS.md): the shared-hook contract, ordering guarantees, and how to add a
  hook safely.
- [PLUGINS.md](PLUGINS.md): one reference section per plugin. Hooks, env knobs, failure
  modes, tests.
- [README.md](../README.md): what this is, repo layout, install, and how to run the tests.
- `DECISIONS.md`: design rationale, including why `tool-concurrency.js` is kept and why
  subagent concurrency is delegated.

Start at [the README](../README.md) for install and test commands. The suites live under
`tests/`, including the shared pure-function entrypoint suite.

## Source of truth

The behavior described here comes from these files. Read them directly when this document
and the code disagree; the code wins.

- [tool-concurrency.js](../plugins/tool-concurrency.js)
- [tool-output-spill.js](../plugins/tool-output-spill.js)
- [attachment-bound.js](../plugins/attachment-bound.js)
- [context-governor.js](../plugins/context-governor.js)
- [summary-diff-cap.js](../plugins/summary-diff-cap.js)
- [compaction-handoff.js](../plugins/compaction-handoff.js)
- [milestone-note.js](../plugins/milestone-note.js)
- [opencode-maintenance.sh](../bin/opencode-maintenance.sh)
- [the test suites](../tests/)
