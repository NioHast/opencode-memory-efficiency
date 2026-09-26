# Hook Contract

This document is the shared contract for every plugin in `plugins/`. It explains
what a hook is, the ordering guarantee the runtime gives us, the one rule that
matters most (never throw), how the three plugins that share
`experimental.chat.messages.transform` stay out of each other's way, and the safe
procedure for adding a new hook.

For the per-plugin reference (env knobs, failure modes, tests), see
[PLUGINS.md](PLUGINS.md).

---

## 1. What a hook is

An opencode plugin is a module that exports an async factory. Calling the factory
returns an object that maps a **hook name** to an async handler:

```js
export const Example = async () => ({
  "tool.execute.after": async (input, output) => { /* ... */ },
});
```

opencode discovers the factory, calls it, and invokes the handler whenever the
matching lifecycle event fires. Handlers may read `input`, and may mutate
`output` when the hook contract marks it as mutable. The hook object is the only
surface a plugin gets.

Every plugin here exports both a named factory and a `default` export, so either
import style works.

---

## 2. Ordering guarantee

The runtime runs plugin hooks **sequentially**, one plugin after another. It does
not fan them out in parallel, and it does not isolate one plugin's exception from
the rest.

That gives two guarantees that this document builds on:

1. **Deterministic order.** If two plugins touch the same hook, the first one in
   load order sees the payload first, and the second one sees the first plugin's
   mutations.
2. **A throw aborts the chain.** If any handler throws, the remaining plugins for
   that hook never run. This is why rule 3 below exists.

Both of these are stated in the source headers of the plugins that depend on
them, for example `plugins/compaction-handoff.js` ("a throw here would abort the
remaining plugin hook chain") and `plugins/tool-output-spill.js` ("a throw would
abort the rest of the hook chain (hooks run sequentially)").

### Load order

Load order is the file order opencode picks up from `plugins/`. This repository
does not rely on a particular order between plugins because the three handlers
that share a hook mutate **disjoint fields** (see section 4). Order only changes
which plugin observes an already-mutated payload, not the final result.

---

## 3. The must-never-throw rule

**Every hook handler and every hook-facing helper is wrapped in a hard
`try/catch` that swallows the error and returns.**

The rationale is the ordering guarantee: a single uncaught exception would
disable all plugins that come after it, turning a bug in one memory helper into a
session-wide failure. A silently skipped optimization is always preferable to a
broken session.

How the rule is implemented across the suite:

- Every exported factory wraps each hook body in `try/catch`. See
  [../plugins/context-governor.js](../plugins/context-governor.js),
  [../plugins/summary-diff-cap.js](../plugins/summary-diff-cap.js),
  [../plugins/attachment-bound.js](../plugins/attachment-bound.js),
  [../plugins/tool-output-spill.js](../plugins/tool-output-spill.js),
  [../plugins/compaction-handoff.js](../plugins/compaction-handoff.js), and
  [../plugins/milestone-note.js](../plugins/milestone-note.js).
- The pure helpers do not throw either. Where a value could be malformed,
  resolvers return a documented fallback (`undefined`, `0`, `""`, or the input
  unchanged) instead of raising. `plugins/summary-diff-cap.js` isolates each
  message in its own `try/catch` so one malformed entry cannot skip the rest.
- Importing any module has **no side effects**. Nothing is created, written, or
  read at import time, so a failed import cannot break the runtime either.

A plugin is allowed to be a no-op. It is not allowed to throw. When a handler
cannot do its job (missing field, non-string payload, refused boundary), it
returns quietly and leaves the payload byte-identical.

---

## 4. The three `experimental.chat.messages.transform` registrants

Three plugins register this hook. Verified by source grep:

| Plugin | Factory | What it mutates |
|---|---|---|
| [../plugins/context-governor.js](../plugins/context-governor.js) | `ContextGovernor` | `part.state.output`, `part.state.input`, `part.state.metadata`, and explicitly superseded `text`/`tool` parts |
| [../plugins/summary-diff-cap.js](../plugins/summary-diff-cap.js) | `SummaryDiffCap` | only `message.info.summary.diffs` |
| [../plugins/attachment-bound.js](../plugins/attachment-bound.js) | `AttachmentBound` | `part.url` / `part.mime` on `type:"file"` parts, and `part.state.attachments[].url` on tool parts |

(The fourth mention of the hook name in `attachment-bound.js` is a header comment,
not a registration. A grep for `messages.transform` in `plugins/` returns exactly
these three registrations plus comments.)

### How they avoid conflict

1. **Disjoint fields.** The intersection of the three mutation sets is empty.
   The governor never reads or writes `summary.diffs`; the diff cap never touches
   tool output or file attachments; the attachment bounder only rewrites
   attachment `url`/`mime` fields. No handler can corrupt another's work.

2. **Shared invariants.** None of the three reorders or removes entries from the
   `messages` array. `summary-diff-cap.js` replaces `summary.diffs` in place with
   a filtered copy but never reorders the outer array; the governor edits parts
   in place and explicitly never removes or reorders messages; the attachment
   bounder mutates known objects in place. Sequential composition therefore stays
   stable regardless of order.

3. **Independent failure domains.** Each handler is wrapped separately. Even if
   one plugin's body hit a defect, the other two still run. The diff cap adds a
   per-message inner `try/catch` on top of that.

4. **Transient-only scope.** All three run against a transient `structuredClone`
   of the conversation. They reduce the next provider call only; none of them
   changes stored DB bytes. The stored bounds happen in the stored hooks
   (`tool.execute.after`, `chat.message`) instead. See the scope column in
   section 5.

### Prefix-cache constraint

Because the transform output feeds a provider prompt, the transform must be
**prefix-stable**: the same earlier messages must serialize to the same bytes as
new turns are appended. The governor enforces this with a monotonic per-session
watermark (`observeWatermark` in `../plugins/context-governor.js`) that only
advances when a new compaction marker appears; it never follows the tail. A
sliding window would change earlier bytes on every turn and defeat prompt
prefix caching. The diff cap and attachment bounder are already prefix-stable
because they depend only on each message's own content.

Any new `messages.transform` plugin must preserve that property.

---

## 5. Hook inventory

Every hook name below exists in source. "Stored" means the mutation can be
persisted by the runtime; "transient" means it only affects the next prompt.

| Hook | Registered by | Scope |
|---|---|---|
| `tool.execute.before` | `ToolConcurrency` | transient (scheduling) |
| `tool.execute.after` | `ToolOutputSpill`, `AttachmentBound`, `ToolConcurrency` | stored (spill and attachments) |
| `chat.message` | `AttachmentBound` | stored (user-message file parts) |
| `experimental.chat.messages.transform` | `ContextGovernor`, `SummaryDiffCap`, `AttachmentBound` | transient |
| `experimental.chat.system.transform` | `MilestoneNote` | transient |
| `experimental.session.compacting` | `CompactionHandoff` | transient (prompt replacement) |
| `event` | `MilestoneNote` | side effect (append-only note file) |

Note that `tool.execute.after` is shared by three plugins. Its handlers also
touch disjoint fields: spill rewrites `output.output`, the attachment bounder
rewrites `output.attachments[].url` and appends a pointer line, and concurrency
only reads `input.callID` to release a slot.

---

## 6. How to add a new hook safely

1. **Confirm the hook name and its exact payload shape** from
   `@opencode-ai/plugin`'s `dist/index.d.ts` (pinned to `1.18.32` in
   `package.json`). Do not guess a name. A wrong name means the handler silently
   never runs.
2. **Create a plugin module** that exports an async factory returning a hook map,
   plus a `default` export. Keep the module side-effect free at import time.
3. **Wrap the hook body in `try/catch`** and swallow. Never rethrow. This is
   non-negotiable (section 3).
4. **Mutate the smallest possible field set** and document the exact fields.
   If you share a hook with an existing plugin, make sure your field set is
   disjoint, and do not reorder or remove array entries.
5. **Honor the transient/stored boundary.** If you need a persisted change, use a
   stored hook (`tool.execute.after`, `chat.message`). If you only shrink the
   prompt, a `*.transform` hook is correct and safer.
6. **Preserve prefix stability** for any `messages.transform` handler. Anchor on
   monotonic state (like the governor watermark), never on the moving tail.
7. **Bound every payload you write.** Reuse the byte-safe slice pattern (walk
   back over UTF-8 continuation bytes) rather than `slice`, so a multibyte
   character is never split.
8. **Make it idempotent and a no-op on missing data.** A missing field must
   leave the payload byte-identical, not produce an error or a fake bound.
9. **Add deterministic tests** under `tests/` that drive the factory directly,
   with no network, DB, or model. Follow the existing naming
   (`<feature>.test.mjs`) and register a mutation check in
   [../tests/mutation.test.mjs](../tests/mutation.test.mjs) when the invariant is
   subtle.
10. **Document it** in [PLUGINS.md](PLUGINS.md) (what, hooks, env knobs with
    defaults, failure modes, test file) and add a row to the inventory above.

A new hook is only "safe" when it is provably unable to throw, unable to change
another plugin's fields, and covered by a test that fails if the behavior
regresses.
