// milestone-note.js (todo 10, opencode-memory-efficiency)
// ---------------------------------------------------------------------------
// Two cooperating behaviors that make session continuity survive compaction
// without manual session switching (IS-3 / GAP-3):
//
//   1. WRITE — on the `event` hook for `session.compacted` and `session.idle`,
//      APPEND a bounded current-state block (<= MAX_BLOCK_BYTES = 4096 bytes)
//      to:
//        <worktree>/.omo/notepads/opencode-memory-efficiency/current-state.md
//      The block records Goal / Decisions / Active files / Next. It is
//      APPEND-ONLY: prior content is never overwritten. Every block is
//      self-delimited with START/END HTML-comment markers so a later reader can
//      extract the most recent state even after truncation.
//
//   2. READ/INJECT — on `experimental.chat.system.transform`, read the note file
//      and PREPEND a bounded copy of the latest block to `output.system` so a
//      FRESH session actually sees the milestone state (not write-only).
//
// Hook contracts (verbatim from @opencode-ai/plugin@1.18.32 index.d.ts):
//   "event"                            (input:{event:Event}) => Promise<void>
//   "experimental.chat.system.transform"(input:{sessionID?,model},
//                                        output:{system:string[]}) => Promise<void>
//   `session.compacted` / `session.idle` events carry
//      properties:{sessionID:string}  (sdk gen/types.gen.d.ts:413-424).
//
// Safety:
//   - Every hook body and every helper is wrapped in try/catch: a throw would
//     abort the remaining plugin hook chain (plugins run sequentially).
//   - The default writer is hard-bounded to `<worktree>/.omo/` and refuses to
//     write anywhere outside it. Tests may override the path via
//     `MILESTONE_NOTE_PATH` (or the factory option `notePath`).
//   - Importing this module has NO side effects (no file is touched at import).
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const HOOK_EVENT = "event";
export const HOOK_SYSTEM_TRANSFORM = "experimental.chat.system.transform";

// A block is always <= 4KB (bytes), including markers/marker text.
export const MAX_BLOCK_BYTES = 4096;
// A block injected into a system prompt is also bounded (same 4KB policy).
export const MAX_INJECT_BYTES = 4096;

export const PLAN_DIR_NAME = "opencode-memory-efficiency";
export const NOTE_FILENAME = "current-state.md";
// Relative to the worktree root; guarantees the default write stays under .omo/.
export const NOTE_RELATIVE_PATH = path.join(
  ".omo",
  "notepads",
  PLAN_DIR_NAME,
  NOTE_FILENAME,
);
export const OMO_DIR_NAME = ".omo";

export const STATE_MARKER_START = "<!-- milestone-note:start -->";
export const STATE_MARKER_END = "<!-- milestone-note:end -->";
export const TRUNCATION_MARKER = "\n...[block truncated]...\n";

// The two events that produce a milestone note.
export const TRIGGER_EVENTS = Object.freeze([
  "session.compacted",
  "session.idle",
]);

// ---------------------------------------------------------------------------
// Small pure utilities
// ---------------------------------------------------------------------------

// Slice a string to at most `maxBytes` UTF-8 bytes without splitting a
// multibyte character. Returned string always encodes to <= maxBytes bytes.
export function safeByteSlice(str, maxBytes) {
  if (typeof str !== "string" || str.length === 0) return "";
  const limit = Math.max(0, Math.floor(maxBytes) || 0);
  if (limit === 0) return "";
  const buf = Buffer.from(str, "utf8");
  if (buf.length <= limit) return str;
  let end = limit;
  // UTF-8 continuation byte = 10xxxxxx; walk back to a char boundary.
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString("utf8");
}

// UTF-8 byte length of `str` (non-strings stringified; nullish -> "").
function byteLength(str) {
  return Buffer.byteLength(typeof str === "string" ? str : String(str ?? ""), "utf8");
}

// Flatten string | array | scalar into one trimmed, ";"-joined line.
function asText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value
      .map((v) => (typeof v === "string" ? v.trim() : String(v ?? "").trim()))
      .filter(Boolean)
      .join("; ");
  }
  return String(value).trim();
}

// True when `child` resolves to `parent` or is nested inside it.
export function isWithin(child, parent) {
  if (typeof child !== "string" || typeof parent !== "string") return false;
  if (!child || !parent) return false;
  const c = path.resolve(child);
  const p = path.resolve(parent);
  if (c === p) return true;
  const rel = path.relative(p, c);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

// ---------------------------------------------------------------------------
// buildStateBlock — pure, deterministic, bounded
// ---------------------------------------------------------------------------

/**
 * Build the current-state markdown block. Bounded to MAX_BLOCK_BYTES; if it
 * would exceed the cap it is truncated safely (UTF-8 boundary safe) with an
 * explicit marker while KEEPING both START and END delimiters.
 *
 * @param {object} [state]
 * @param {string}   [state.goal]
 * @param {string[]|string} [state.decisions]
 * @param {string[]|string} [state.activeFiles]
 * @param {string[]|string} [state.next]
 * @param {string}   [state.reason]     "session.compacted" | "session.idle" | ...
 * @param {string}   [state.sessionID]
 * @param {string}   [state.timestamp]  ISO string; default now.
 * @param {number}   [maxBytes]         override cap (default MAX_BLOCK_BYTES).
 * @returns {string}
 */
export function buildStateBlock(state = {}, maxBytes = MAX_BLOCK_BYTES) {
  const cap =
    Number.isFinite(maxBytes) && maxBytes > 0
      ? Math.floor(maxBytes)
      : MAX_BLOCK_BYTES;
  try {
    const s = state && typeof state === "object" ? state : {};
    const goal = asText(s.goal) || "(not provided)";
    const decisions = asText(s.decisions) || "(none)";
    const activeFiles = asText(s.activeFiles) || "(none)";
    const next = asText(s.next) || "(none)";
    const reason = asText(s.reason) || "milestone";
    const sessionID = asText(s.sessionID);
    const timestamp =
      asText(s.timestamp) ||
      (typeof s.now === "string" && s.now) ||
      new Date().toISOString();

    const lines = [STATE_MARKER_START, "## Milestone Current State"];
    lines.push(`- Reason: ${reason}`);
    lines.push(`- Time: ${timestamp}`);
    if (sessionID) lines.push(`- Session: ${sessionID}`);
    lines.push(`- Goal: ${goal}`);
    lines.push(`- Decisions: ${decisions}`);
    lines.push(`- Active files: ${activeFiles}`);
    lines.push(`- Next: ${next}`);
    lines.push(STATE_MARKER_END);
    return boundBlock(lines.join("\n"), cap);
  } catch {
    // Never throw; emit a minimal marker-delimited block instead.
    return boundBlock(
      [STATE_MARKER_START, "## Milestone Current State", STATE_MARKER_END].join("\n"),
      cap,
    );
  }
}

// Enforce an upper byte bound while ALWAYS keeping START/END markers when the
// text already contains them (truncates the body, not the delimiters).
export function boundBlock(text, maxBytes = MAX_BLOCK_BYTES) {
  const cap =
    Number.isFinite(maxBytes) && maxBytes > 0
      ? Math.floor(maxBytes)
      : MAX_BLOCK_BYTES;
  const str = typeof text === "string" ? text : String(text ?? "");
  if (byteLength(str) <= cap) return str;

  const hasMarkers =
    str.indexOf(STATE_MARKER_START) !== -1 && str.lastIndexOf(STATE_MARKER_END) !== -1;

  if (hasMarkers) {
    const endIdx = str.lastIndexOf(STATE_MARKER_END);
    const head = str.slice(0, endIdx);
    const tail = STATE_MARKER_END;
    const budget = cap - byteLength(tail) - byteLength(TRUNCATION_MARKER);
    if (budget > 0) {
      return safeByteSlice(head, budget) + TRUNCATION_MARKER + tail;
    }
  }
  // No markers (or cap too small): plain safe slice + marker.
  const markerBudget = Math.max(0, cap - byteLength(TRUNCATION_MARKER));
  return safeByteSlice(str, markerBudget) + TRUNCATION_MARKER;
}

// ---------------------------------------------------------------------------
// appendNote — append-only writer, never throws, boundary-checked
// ---------------------------------------------------------------------------

/**
 * APPEND `block` to `filePath`. Never overwrites; never throws.
 *
 * @param {string} filePath
 * @param {string} block
 * @param {object} [opts]
 * @param {string} [opts.boundary]   if set, refuse paths outside this dir.
 * @param {number} [opts.maxBytes]   per-block cap (default MAX_BLOCK_BYTES).
 * @returns {{ok:boolean, reason:string, path?:string, bytes?:number, error?:string}}
 */
export function appendNote(filePath, block, opts = {}) {
  const result = { ok: false, reason: "not-appended" };
  try {
    if (typeof filePath !== "string" || !filePath) {
      result.reason = "invalid-path";
      return result;
    }
    if (typeof block !== "string" || block.length === 0) {
      result.reason = "empty-block";
      return result;
    }
    const boundary = opts && opts.boundary;
    if (boundary && !isWithin(filePath, boundary)) {
      result.reason = "outside-boundary";
      return result;
    }

    const bounded = boundBlock(block, opts && opts.maxBytes);

    let existed = false;
    try {
      const st = fs.statSync(filePath);
      existed = st.isFile() && st.size > 0;
    } catch {
      existed = false;
    }

    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${existed ? "\n" : ""}${bounded}\n`, "utf8");

    result.ok = true;
    result.reason = "appended";
    result.path = filePath;
    result.bytes = byteLength(bounded);
    return result;
  } catch (err) {
    result.reason = "write-failed";
    result.error = err && err.message ? err.message : String(err);
    return result;
  }
}

// ---------------------------------------------------------------------------
// readNoteBlock — read the most recent block, bounded, never throws
// ---------------------------------------------------------------------------

/**
 * Read the newest note block from `filePath`. Returns "" when the file is
 * missing/empty/unreadable (so callers can treat it as a no-op).
 *
 * @param {string} filePath
 * @param {object} [opts]
 * @param {number} [opts.maxBytes] default MAX_INJECT_BYTES
 * @returns {string}
 */
export function readNoteBlock(filePath, opts = {}) {
  try {
    if (typeof filePath !== "string" || !filePath) return "";
    let content;
    try {
      content = fs.readFileSync(filePath, "utf8");
    } catch {
      return "";
    }
    if (typeof content !== "string" || content.trim() === "") return "";

    const startIdx = content.lastIndexOf(STATE_MARKER_START);
    let block = startIdx >= 0 ? content.slice(startIdx) : content;
    block = block.trim();
    if (!block) return "";

    const cap =
      Number.isFinite(opts && opts.maxBytes) && opts.maxBytes > 0
        ? Math.floor(opts.maxBytes)
        : MAX_INJECT_BYTES;
    if (byteLength(block) > cap) block = boundBlock(block, cap);
    return block;
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Path resolution + freshness
// ---------------------------------------------------------------------------

// Resolve the worktree root from the plugin input (directory/worktree),
// falling back to process.cwd().
export function resolveBaseRoot(input) {
  const candidates = [input && input.worktree, input && input.directory, process.cwd()];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  return process.cwd();
}

// Resolve the effective note path. Precedence: env MILESTONE_NOTE_PATH >
// factory option notePath > <baseRoot>/.omo/notepads/<plan>/current-state.md.
export function resolveNotePath(options, baseRoot) {
  const envPath = process.env.MILESTONE_NOTE_PATH;
  if (typeof envPath === "string" && envPath.trim()) {
    return { path: envPath.trim(), override: true };
  }
  if (options && typeof options.notePath === "string" && options.notePath.trim()) {
    return { path: options.notePath.trim(), override: true };
  }
  return {
    path: path.join(baseRoot, NOTE_RELATIVE_PATH),
    override: false,
  };
}

// Default writes must stay under `<baseRoot>/.omo`; explicit test overrides are
// confined to their own directory.
function boundaryFor(notePath, baseRoot, isOverride) {
  if (isOverride) return path.dirname(notePath);
  return path.join(baseRoot, OMO_DIR_NAME);
}

// Track sessions already injected into, so we only PREPEND for a FRESH session
// (first system.transform seen for that session id).
const seenSessions = new Set();

// True when `sessionID` has not been injected yet (blank/unknown => fresh).
export function isFreshSession(sessionID) {
  if (typeof sessionID !== "string" || !sessionID) return true;
  return !seenSessions.has(sessionID);
}

// Record a session id as already injected so we inject at most once per session.
export function markSessionSeen(sessionID) {
  if (typeof sessionID === "string" && sessionID) seenSessions.add(sessionID);
}

// Clear the injected-session set (tests / long-lived hosts).
export function resetSeenSessions() {
  seenSessions.clear();
}

// ---------------------------------------------------------------------------
// Event → state
// ---------------------------------------------------------------------------

// Normalize the `event` hook input ({event:Event} or a bare Event) and derive
// the current-state object. Optional plugin `state` / `stateProvider` supply
// richer content; otherwise a bounded placeholder block is produced.
export function buildStateFromEvent(event, options) {
  const ev =
    event && typeof event === "object" && event.event && typeof event.event === "object"
      ? event.event
      : event;
  const type = asText(ev && ev.type);
  const sessionID = asText(ev && ev.properties && ev.properties.sessionID);

  let provided = {};
  try {
    if (options && typeof options.stateProvider === "function") {
      provided = options.stateProvider(ev) || {};
    } else if (options && options.state && typeof options.state === "object") {
      provided = options.state;
    }
  } catch {
    provided = {};
  }

  return { ...provided, reason: type || asText(provided.reason), sessionID };
}

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

export const MilestoneNote = async (input, options = {}) => {
  const opts = options && typeof options === "object" ? options : {};
  const baseRoot = resolveBaseRoot(input || {});

  const resolveTarget = () => {
    const resolved = resolveNotePath(opts, baseRoot);
    return {
      path: resolved.path,
      boundary: boundaryFor(resolved.path, baseRoot, resolved.override),
    };
  };

  return {
    [HOOK_EVENT]: async (hookInput) => {
      try {
        const ev =
          hookInput && typeof hookInput === "object" ? hookInput.event : undefined;
        const type = ev && typeof ev === "object" ? ev.type : undefined;
        if (!TRIGGER_EVENTS.includes(type)) return;

        const state = buildStateFromEvent(hookInput, opts);
        const block = buildStateBlock(state, opts.maxBlockBytes || MAX_BLOCK_BYTES);
        const target = resolveTarget();
        appendNote(target.path, block, {
          boundary: target.boundary,
          maxBytes: opts.maxBlockBytes || MAX_BLOCK_BYTES,
        });
      } catch {
        // Swallow: never abort the hook chain.
      }
    },

    [HOOK_SYSTEM_TRANSFORM]: async (hookInput, output) => {
      try {
        const sessionID =
          hookInput && typeof hookInput === "object" ? hookInput.sessionID : undefined;
        if (!isFreshSession(sessionID)) return;

        const target = resolveTarget();
        const block = readNoteBlock(target.path, {
          maxBytes: opts.maxInjectBytes || MAX_INJECT_BYTES,
        });
        if (!block) return; // missing/empty note -> no-op

        const out = output && typeof output === "object" ? output : {};
        const existing = Array.isArray(out.system) ? out.system : [];
        out.system = [block, ...existing];
        markSessionSeen(sessionID);
      } catch {
        // Swallow: never abort the hook chain.
      }
    },
  };
};

export default MilestoneNote;
