# Plugin Reference

One section per plugin in `plugins/`. Each section states the problem it solves,
the hooks it registers, its environment knobs with defaults, how it fails, and
the test file that covers it.

For the shared contract (ordering, never-throw, the three
`messages.transform` registrants, adding a hook safely), see
[HOOKS.md](HOOKS.md).

All seven plugins are independent. Importing any of them has no side effects.

---

## attachment-bound

**What / problem.** Bounds oversized attachments so multi-MB payloads (a
`read` on a PDF, a `webfetch` image, a pasted image) do not bloat stored session
bytes or the next prompt. When an attachment's `url` exceeds the cap, the full
payload is written to a spill file and the attachment is replaced in place by a
small `data:text/plain` note carrying a pointer plus a bounded preview. Small
attachments are left byte-identical, so normal image paste and file reads are
unaffected. Stored bytes are handled by `tool.execute.after` and `chat.message`
(the transform registration is prompt-only defense in depth).

**Hooks.**

| Hook | Effect |
|---|---|
| `tool.execute.after` | Bound `output.attachments[].url` for built-in tools; append a pointer line to `output.output` |
| `chat.message` | Bound `type:"file"` user-message parts in place |
| `experimental.chat.messages.transform` | Bound file parts and `part.state.attachments` in a transient clone (prompt only) |

**Env knobs.**

| Env var | Default | Meaning |
|---|---|---|
| `MAX_ATTACHMENT_BYTES` | `1048576` (1 MiB) | `url` byte length above which an attachment is spilled |
| `ATTACHMENT_SPILL_DIR` | `<home>/.local/share/opencode/tool-spill/attachments` | directory the full payload is written to |
| `ATTACHMENT_PREVIEW_BYTES` | `4096` | preview bytes embedded in the pointer note |

Resolution order is explicit option, then env, then default; env is read per
call.

**Failure modes.** Never throws. Skips and leaves the object unchanged on:
`invalid-part`, `missing-url`, `non-string-url`, and `under-cap`. On a spill
write failure (`write-failed`) or any unexpected error (`error`) the object is
left unchanged, so no fake bound is produced. A non-data-URI `url` is spilled as
raw UTF-8 rather than decoded.

**Test file.** [../tests/attachment.test.mjs](../tests/attachment.test.mjs)
(also section 5 of [../tests/plugins.unit.test.mjs](../tests/plugins.unit.test.mjs),
and the `boundAttachment` mutation check in
[../tests/mutation.test.mjs](../tests/mutation.test.mjs)).

---

## compaction-handoff

**What / problem.** Replaces the lossy default compaction summary with a
structured handoff prompt that preserves goal, verbatim user constraints and
preferences, decisions, debugging state, active files, open errors, next steps,
and the last user message verbatim. It exists because the default compaction
drops decisions and constraints, and later compactions can discard earlier
handoff content.

**Hooks.**

| Hook | Effect |
|---|---|
| `experimental.session.compacting` | Build the handoff prompt and set `output.prompt`; empty `output.context` in place so nothing is appended alongside the prompt |

**Env knobs.** None. The bounds are module constants (`MAX_TEMPLATE_BYTES`,
`MAX_CONTEXT_CHARS`, `MAX_CONTEXT_ENTRY_CHARS`), not env-tunable.

**Failure modes.** Never throws. If `output` is missing it substitutes an empty
object. It never sets `output.context` when that key was absent, and when the
key is present it clears the array in place so it can never be appended next to
the replacement prompt. If no last user message can be extracted from the input
shapes, it emits an instruction telling the compactor to copy the most recent
user turn verbatim.

**Test file.** [../tests/compaction.test.mjs](../tests/compaction.test.mjs)
(also section 4 of [../tests/plugins.unit.test.mjs](../tests/plugins.unit.test.mjs)).

---

## context-governor

**What / problem.** Shrinks the transient prompt for a single session without a
sliding window, so prompt prefix caching stays valid. Four rules run in order on
every `messages.transform`:

1. `applyPlaceholders`: replace completed, non-protected tool outputs with a
   one-line placeholder when the message is below the monotonic compaction
   watermark or the output exceeds `PLACEHOLDER_BYTES` (a spill pointer is
   appended when a spill file exists).
2. `dedupeCalls`: collapse earlier identical `(session, tool, args)` calls into
   the latest one, but only when the later output is a superset or the tool is
   stateless.
3. `purgeErrorInputs`: for errored calls resolved later and at least
   `PURGE_ERROR_TURNS` positions below the watermark, drop the input and keep the
   error text.
4. `applySupersession`: collapse only entries explicitly tagged as superseded by
   a newer part in the same session.

Protected tools (`task`, `skill`, `todowrite`, `todoread`, `write`, `edit`,
`compress`) and every running or pending call are never touched. Messages are
never removed or reordered.

**Hooks.**

| Hook | Effect |
|---|---|
| `experimental.chat.messages.transform` | Apply all four rules in order; transient clone only |

**Env knobs.**

| Env var | Default | Meaning |
|---|---|---|
| `PLACEHOLDER_BYTES` | `8000` | output byte size above which a completed non-protected output is placeholderized |
| `PURGE_ERROR_TURNS` | `4` | positions below the watermark required before an errored call's input may be purged |
| `SPILL_DIR` | `<home>/.local/share/opencode/tool-spill` | directory probed for `<callID>.txt` spill pointers; also used by `tool-output-spill` |

`PLACEHOLDER_BYTES`, `PURGE_ERROR_TURNS`, and the default `SPILL_DIR` are read at
import time; per-call options can still override them. The default spill dir
derives from `HOME` (or `USERPROFILE`), which are fallback path components, not
plugin knobs.

**Failure modes.** Never throws. A payload with no array or no `sessionID` is
returned untouched. Malformed state metadata is tolerated. The watermark only
advances on a new compaction marker and never decreases, so earlier messages
transform identically between compactions.

**Test file.** [../tests/governor.test.mjs](../tests/governor.test.mjs)
(also section 3 of [../tests/plugins.unit.test.mjs](../tests/plugins.unit.test.mjs),
and the `transformMessages` mutation check in
[../tests/mutation.test.mjs](../tests/mutation.test.mjs)).

---

## milestone-note

**What / problem.** Makes session continuity survive compaction without manual
session switching. On `session.compacted` and `session.idle` it appends a bounded
(<= 4096 bytes) current-state block (reason, time, session, goal, decisions,
active files, next) to
`<worktree>/.omo/notepads/opencode-memory-efficiency/current-state.md`. On the
next fresh session's `experimental.chat.system.transform` it reads the newest
block and prepends it to `output.system`, so a fresh session actually sees the
milestone state. Writes are append-only and self-delimited with HTML-comment
markers. Default writes are refused outside `<worktree>/.omo`.

**Hooks.**

| Hook | Effect |
|---|---|
| `event` | On `session.compacted` / `session.idle`, append a bounded state block |
| `experimental.chat.system.transform` | Prepend the newest note block for a fresh session only |

**Env knobs.**

| Env var | Default | Meaning |
|---|---|---|
| `MILESTONE_NOTE_PATH` | unset; falls back to `<worktree>/.omo/notepads/opencode-memory-efficiency/current-state.md` | override for the note path |

**Failure modes.** Never throws. Missing or empty note file makes injection a
no-op. A path outside the boundary is refused (`outside-boundary`). Write errors
are swallowed. Injection happens only for a session id not seen before, so a
session is not re-injected on every turn.

**Test file.** [../tests/milestone.test.mjs](../tests/milestone.test.mjs)
(also section 6 of [../tests/plugins.unit.test.mjs](../tests/plugins.unit.test.mjs)).

---

## summary-diff-cap

**What / problem.** Bounds the transient prompt-side size of
`message.info.summary.diffs` before a message is sent to the provider. Vendor and
generated path segments are dropped outright; each retained patch is truncated to
the per-patch cap; and if the total still exceeds the total cap, the
lowest-priority entries are dropped (largest patch first, then latest index) to
free the most budget. The `messages` array itself is never reordered or removed.

**Hooks.**

| Hook | Effect |
|---|---|
| `experimental.chat.messages.transform` | Cap `summary.diffs` on each message; transient clone only |

**Env knobs.**

| Env var | Default | Meaning |
|---|---|---|
| `DIFF_MAX_PATCH_BYTES` | `65536` (64 KiB) | maximum bytes retained per file patch |
| `DIFF_MAX_TOTAL_BYTES` | `524288` (512 KiB) | maximum total patch bytes retained per message |

Resolution order is explicit option, then env, then default; env is read per
call.

**Failure modes.** Never throws. Malformed messages or entries (non-object, or
non-string `file`/`patch`) are left completely untouched. Each message is
processed inside its own `try/catch`, so one bad entry cannot skip the rest. A
vendor-only diff array legitimately becomes empty (`[]`); the array is preserved.

**Test file.** [../tests/diffcap.test.mjs](../tests/diffcap.test.mjs)
(also section 2 of [../tests/plugins.unit.test.mjs](../tests/plugins.unit.test.mjs),
and the `capDiffs` mutation check in
[../tests/mutation.test.mjs](../tests/mutation.test.mjs)).

---

## tool-concurrency

**What / problem.** Limits how many tool calls may run at once, so a burst of
parallel tool calls does not multiply memory. `task` and `batch` are excluded
because subagent fan-out is governed elsewhere. Slots are acquired in
`tool.execute.before` and released in `tool.execute.after`. A timer (10 minutes,
unref'd) releases a slot if the matching after hook never fires.

**Hooks.**

| Hook | Effect |
|---|---|
| `tool.execute.before` | Acquire a concurrency slot for a non-excluded tool |
| `tool.execute.after` | Release the slot held for `input.callID` |

**Env knobs.** None. The caps are module constants (`MAX_CONCURRENCY = 2`,
`TTL_MS = 10 * 60 * 1000`), changed by editing the file and restarting opencode.

**Failure modes.** Never throws. Excluded tools bypass both hooks. A stale slot
is reclaimed by the TTL timer, and `unref()` keeps the timer from holding the
process open.

**Test file.** None. This module has no dedicated test file in `tests/`, and it
lives outside the memory-efficiency plugin suite (pre-existing module).

---

## tool-output-spill

**What / problem.** Keeps oversized `tool.execute.after` results out of the
stored session. When `output.output` exceeds the cap, the full text is written to
a spill file and `output.output` is replaced by a bounded preview (first 200
lines and at most 8000 bytes, never splitting a multibyte character) plus a
pointer line naming the spill file. Results under or at the cap are left
byte-identical, so the model still sees `read` output verbatim. `task`, `batch`,
and `compress` are excluded.

**Hooks.**

| Hook | Effect |
|---|---|
| `tool.execute.after` | Spill `output.output` when oversized; rewrite it to pointer plus preview |

**Env knobs.**

| Env var | Default | Meaning |
|---|---|---|
| `SPILL_MAX_BYTES` | `200000` | output byte size above which the text is spilled |
| `SPILL_DIR` | `<home>/.local/share/opencode/tool-spill` | directory the full text is written to |

Resolution order is explicit option, then env, then default; env is read per
call. The preview byte and line caps (`8000`, `200`) are module constants, not
env-tunable.

**Failure modes.** Never throws. Skips and leaves the output unchanged on
`invalid-output`, `non-string-output`, `excluded`, and `under-cap`. On a spill
write failure (`write-failed`) or any unexpected error (`error`) the output is
left unchanged.

**Test file.** [../tests/spill.test.mjs](../tests/spill.test.mjs)
(also section 1 of [../tests/plugins.unit.test.mjs](../tests/plugins.unit.test.mjs),
and the `spillIfNeeded` mutation check in
[../tests/mutation.test.mjs](../tests/mutation.test.mjs)).

---

## Env knob index

Canonical, machine-checkable list of every environment knob across all plugins,
one `NAME=default` per line. This is the source of truth for the knob
cross-check; if the code and this block disagree, one of them is wrong.

```text
PLACEHOLDER_BYTES=8000
PURGE_ERROR_TURNS=4
SPILL_DIR=<home>/.local/share/opencode/tool-spill
DIFF_MAX_PATCH_BYTES=65536
DIFF_MAX_TOTAL_BYTES=524288
SPILL_MAX_BYTES=200000
MAX_ATTACHMENT_BYTES=1048576
ATTACHMENT_SPILL_DIR=<home>/.local/share/opencode/tool-spill/attachments
ATTACHMENT_PREVIEW_BYTES=4096
MILESTONE_NOTE_PATH=<worktree>/.omo/notepads/opencode-memory-efficiency/current-state.md
```
