# Design Decisions

Short, append-only record of non-obvious design choices in this repository.
Each entry states the decision, the evidence behind it, and when to revisit it.

---

## D-001 — Keep `tool-concurrency.js`

**Status:** Accepted
**Date:** 2026-09-26
**File:** `~/.config/opencode/plugins/tool-concurrency.js`

### Decision

Keep the `tool-concurrency` plugin. It caps how many **non-task** tool calls run
at once in a single opencode process (default `MAX_CONCURRENCY = 2`). It must
not be removed or have its behavior changed as part of documentation/repo
cleanup.

### Rationale

1. **It is proven active.** A timing observation drove three concurrent `bash`
   tools, each sleeping 3000 ms, through the plugin's real
   `tool.execute.before` / `tool.execute.after` hooks:

   | Run | Setting | Peak concurrent | Wall time |
   |---|---|---|---|
   | Live plugin | `MAX_CONCURRENCY = 2` | **2** | 6006 ms (two 3 s waves) |
   | Sensitivity mutant | `MAX_CONCURRENCY = 3` | **3** | 3004 ms (one 3 s wave) |

   The live plugin admitted only 2 calls at a time (the third waited for a slot,
   so total time doubled), and the deliberately-changed copy admitted all 3 —
   proving the measurement actually exercises the limiter rather than passing
   vacuously.

2. **It is the only non-task tool limiter.** The concurrency gate excludes
   `task` and `batch` explicitly (`EXCLUDE = new Set(["task", "batch"])`), so it
   is the sole mechanism bounding parallel execution of ordinary tools
   (`bash`, `read`, `grep`, …). Removing it would let parallel tool calls balloon
   process RSS, which is exactly the failure the memory-efficiency work aims to
   prevent.

3. **Subagent concurrency is delegated, not duplicated.** Concurrency for `task`
   subagents is owned by oh-my-openagent's `task.*` configuration (and the
   `background_task` / `defaultConcurrency` knobs), not by this plugin. Keeping
   the plugin's `task`/`batch` exclusion preserves a single owner for subagent
   limits and avoids double-throttling.

### Consequences

- Two ordinary tool calls may run at once by default; the rest queue FIFO.
- A held slot has a TTL (`TTL_MS = 10 * 60 * 1000`) that force-releases it if
  the matching `after` hook never fires, so an aborted call cannot permanently
  exhaust the limit.
- Subagent fan-out is tuned in the oh-my-openagent `task.*` config, not here.

### Revisit when

- oh-my-openagent gains a general (non-`task`) tool concurrency limiter, making
  this plugin redundant; or
- the default parallelism needs tuning beyond `MAX_CONCURRENCY`.
