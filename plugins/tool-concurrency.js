// tool-concurrency.js
// ---------------------------------------------------------------------------
// Caps how many non-task tool calls may run at once in this opencode process.
//
// `tool.execute.before` acquires a slot (waiting in a FIFO queue when full) and
// `tool.execute.after` releases it. Each held slot also has a TTL timer that
// force-releases it if the matching `after` hook never fires (e.g. an aborted
// run), so one stuck call can never exhaust the limit permanently. `task` and
// `batch` are excluded: subagent concurrency is delegated to oh-my-openagent's
// `task.*` config instead of being counted here.
//
// Change MAX_CONCURRENCY to set how many tool calls may run at once (1 = one at
// a time), then restart opencode.
// ---------------------------------------------------------------------------
const MAX_CONCURRENCY = 2;
const EXCLUDE = new Set(["task", "batch"]);
const TTL_MS = 10 * 60 * 1000;

let active = 0;
const waiters = [];
const held = new Map();

// Reserve a concurrency slot. Returns immediately when one is free, otherwise a
// promise that resolves when the next release() hands the slot over.
function acquire() {
  if (active < MAX_CONCURRENCY) {
    active++;
    return undefined;
  }
  return new Promise((resolve) => waiters.push(resolve));
}

// Hand the slot to the next waiter if any, else decrement the active count.
function release() {
  const next = waiters.shift();
  if (next) next();
  else if (active > 0) active--;
}

// opencode plugin factory: registers the before/after hooks that gate slots.
export const ToolConcurrency = async () => ({
  "tool.execute.before": async (input) => {
    if (EXCLUDE.has(input.tool)) return;
    await acquire();
    const timer = setTimeout(() => {
      if (held.delete(input.callID)) release();
    }, TTL_MS);
    if (timer.unref) timer.unref();
    held.set(input.callID, timer);
  },
  "tool.execute.after": async (input) => {
    if (EXCLUDE.has(input.tool)) return;
    const timer = held.get(input.callID);
    if (timer) clearTimeout(timer);
    if (held.delete(input.callID)) release();
  },
});
