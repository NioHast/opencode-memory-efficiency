// ~/.config/opencode/plugins/context-governor.js
//
// Single-session context governor for opencode v1 (plan todo 8).
//
// Hook: "experimental.chat.messages.transform"
//   (input: {}, output: { messages: { info: Message, parts: Part[] }[] })
//
// NOTE: this hook receives a TRANSIENT structuredClone. It only shrinks the
// prompt for the next provider call; it never changes stored DB bytes. The hook
// input carries NO sessionID, so the session is read from messages[*].info.sessionID.
//
// Rules, applied strictly in this order:
//   1. applyPlaceholders  — elide completed tool outputs that are (a) below the
//                           per-session MONOTONIC compaction watermark, or
//                           (b) larger than PLACEHOLDER_BYTES. A spill pointer is
//                           appended when a spill file exists for the callID.
//   2. dedupeCalls        — collapse earlier identical (session,tool,args) calls
//                           into the LATEST one, but only when the later result is
//                           a superset of the earlier one OR the tool is stateless.
//   3. purgeErrorInputs   — for errored tool calls that are resolved and at least
//                           PURGE_ERROR_TURNS positions below the watermark, drop
//                           the input but KEEP the error text.
//   4. applySupersession  — collapse ONLY entries EXPLICITLY tagged as superseded
//                           by a newer decision in the SAME session. Contradictions
//                           are never auto-inferred.
//
// Prefix stability: the watermark is `index of the last observed compaction marker`
// and is stored monotonically per session in a module-level Map. It only advances
// when a compaction marker is observed, so between compactions the same earlier
// messages transform to the same bytes as turns are appended (no sliding window).
//
// Safety: PROTECTED tools and every unresolved (running/pending) call are never
// touched. Messages are never removed or reordered. The hook body is wrapped in
// try/catch and returns without mutation on any error.
//
// Config (env overridable):
//   PLACEHOLDER_BYTES=8000   PURGE_ERROR_TURNS=4   SPILL_DIR=<tool-spill dir>

import { existsSync } from "node:fs";
import { join } from "node:path";

// Read a non-negative integer from env `name`; fall back when unset/invalid.
function intFromEnv(name, fallback) {
  const raw = process.env[name];
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export const PLACEHOLDER_BYTES = intFromEnv("PLACEHOLDER_BYTES", 8000);
export const PURGE_ERROR_TURNS = intFromEnv("PURGE_ERROR_TURNS", 4);

const DEFAULT_SPILL_DIR =
  process.env.SPILL_DIR ||
  join(process.env.HOME || process.env.USERPROFILE || "", ".local/share/opencode/tool-spill");

// Never placeholderized, deduped, purged or superseded.
export const PROTECTED_TOOLS = new Set([
  "task",
  "skill",
  "todowrite",
  "todoread",
  "write",
  "edit",
  "compress",
]);

// Tools with no persistent side effects: repeated identical calls are redundant,
// so the latest result may always stand in for the earlier ones.
export const STATELESS_TOOLS = new Set([
  "read",
  "glob",
  "grep",
  "webfetch",
  "websearch",
  "list",
  "look_at",
  "codesearch",
]);

// ---------------------------------------------------------------------------
// Monotonic watermark (module-level, per session)
// ---------------------------------------------------------------------------

const watermarks = new Map(); // sessionID -> index of last observed compaction marker

/** Clear all watermarks (tests). */
export function resetWatermarks() {
  watermarks.clear();
}

/** Current monotonic watermark for a session (0 when none observed). */
export function getWatermark(sessionID) {
  return watermarks.get(sessionID) ?? 0;
}

/**
 * A compaction marker is either:
 *   - a Part of type "compaction" (opencode inserts this), or
 *   - an assistant message with info.summary === true (the compaction summary).
 * Returns the index of the LAST such marker, or -1 when none is present.
 */
export function detectCompactionMarkerIndex(messages) {
  if (!Array.isArray(messages)) return -1;
  let last = -1;
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (!message || typeof message !== "object" || !Array.isArray(message.parts)) continue;
    const hasCompactionPart = message.parts.some(
      (part) => part && typeof part === "object" && part.type === "compaction",
    );
    const info = message.info;
    const isSummary =
      !!info && typeof info === "object" && info.role === "assistant" && info.summary === true;
    if (hasCompactionPart || isSummary) last = index;
  }
  return last;
}

/**
 * Advance the stored watermark ONLY when a higher compaction marker is observed.
 * Never decreases and never follows the tail, so the transform is prefix-stable
 * between compactions.
 */
export function observeWatermark(sessionID, messages) {
  const previous = watermarks.get(sessionID) ?? 0;
  const marker = detectCompactionMarkerIndex(messages);
  if (marker > previous) {
    watermarks.set(sessionID, marker);
    return marker;
  }
  return previous;
}

/** First sessionID found in info.sessionID, or undefined. */
export function findSessionID(messages) {
  if (!Array.isArray(messages)) return undefined;
  for (const message of messages) {
    const id = message && message.info && typeof message.info === "object"
      ? message.info.sessionID
      : undefined;
    if (typeof id === "string" && id) return id;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function byteLen(value) {
  try {
    const text = typeof value === "string" ? value : String(value ?? "");
    return Buffer.byteLength(text, "utf8");
  } catch {
    return 0;
  }
}

// Deterministic JSON with keys sorted at every level, so an identical call
// inputs object always hashes to the same key regardless of property order;
// circular refs collapse to "[circular]" instead of throwing.
function stableStringify(value) {
  const seen = new WeakSet();
  const walk = (node) => {
    if (node === null || typeof node !== "object") return node;
    if (seen.has(node)) return "[circular]";
    seen.add(node);
    if (Array.isArray(node)) return node.map(walk);
    const out = {};
    for (const key of Object.keys(node).sort()) out[key] = walk(node[key]);
    return out;
  };
  try {
    return JSON.stringify(walk(value));
  } catch {
    return String(value);
  }
}

// Identity of one tool call for dedupe/purge: session + tool + stable args JSON.
function callKey(part, sessionID) {
  const input = part.state && typeof part.state === "object" ? part.state.input : undefined;
  return `${sessionID}|${part.tool}|${stableStringify(input)}`;
}

// True while a call is still active; such calls must never be elided/deduped.
function isRunningOrPending(state) {
  return !!state && (state.status === "running" || state.status === "pending");
}

// Merge `patch` into `state.metadata.governor` in place (audit trail of edits).
function markStateMetadata(state, patch) {
  const metadata = state.metadata && typeof state.metadata === "object" ? state.metadata : {};
  const governor =
    metadata.governor && typeof metadata.governor === "object" ? metadata.governor : {};
  state.metadata = { ...metadata, governor: { ...governor, ...patch } };
}

// Merge `patch` into `part.metadata` in place.
function markPartMetadata(part, patch) {
  const metadata = part.metadata && typeof part.metadata === "object" ? part.metadata : {};
  part.metadata = { ...metadata, ...patch };
}

// Path of the spill file for `callID` when it exists, else null; never throws.
function findSpillFile(callID, spillDir, fileExists) {
  if (!callID || !spillDir) return null;
  let candidate;
  try {
    candidate = join(spillDir, `${callID}.txt`);
    return fileExists(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

// Visit every `type:"tool"` part in message order as (part, index, sessionID).
function forEachToolPart(messages, callback) {
  if (!Array.isArray(messages)) return;
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (!message || typeof message !== "object" || !Array.isArray(message.parts)) continue;
    const sessionID =
      message.info && typeof message.info === "object" ? message.info.sessionID : undefined;
    for (const part of message.parts) {
      if (!part || typeof part !== "object" || part.type !== "tool") continue;
      callback(part, index, sessionID);
    }
  }
}

// ---------------------------------------------------------------------------
// Rule 1 — placeholders
// ---------------------------------------------------------------------------

export function makePlaceholder(tool, bytes, spillPath) {
  const base = `[governor] ${tool} output elided (${bytes} bytes)`;
  return spillPath ? `${base} | full: ${spillPath}` : base;
}

/**
 * Replace completed (non-protected) tool outputs with a 1-line placeholder when
 * the message sits below the watermark OR the output exceeds PLACEHOLDER_BYTES.
 */
export function applyPlaceholders(messages, watermark, options = {}) {
  const protectedTools = options.protectedTools || PROTECTED_TOOLS;
  const limit = Number.isFinite(options.placeholderBytes)
    ? options.placeholderBytes
    : PLACEHOLDER_BYTES;
  const spillDir = options.spillDir || DEFAULT_SPILL_DIR;
  const fileExists = options.fileExists || existsSync;
  const level = Number.isFinite(watermark) ? watermark : 0;

  forEachToolPart(messages, (part, index) => {
    if (protectedTools.has(part.tool)) return;
    const state = part.state;
    if (!state || typeof state !== "object" || state.status !== "completed") return;
    const original = typeof state.output === "string" ? state.output : "";
    const size = byteLen(original);
    const belowWatermark = index < level;
    if (!belowWatermark && size <= limit) return;
    const spillPath = findSpillFile(part.callID, spillDir, fileExists);
    state.output = makePlaceholder(part.tool, size, spillPath);
    markStateMetadata(state, { elided: true, originalBytes: size });
  });
}

// ---------------------------------------------------------------------------
// Rule 2 — dedupe identical calls (keep the latest)
// ---------------------------------------------------------------------------

export function dedupeCalls(messages, _watermark, options = {}) {
  const protectedTools = options.protectedTools || PROTECTED_TOOLS;
  const statelessTools = options.statelessTools || STATELESS_TOOLS;

  const groups = new Map();
  forEachToolPart(messages, (part, index, sessionID) => {
    if (protectedTools.has(part.tool)) return;
    if (!part.state || part.state.status !== "completed") return;
    const key = callKey(part, sessionID || part.sessionID || "");
    let bucket = groups.get(key);
    if (!bucket) {
      bucket = [];
      groups.set(key, bucket);
    }
    bucket.push({ part, index });
  });

  for (const bucket of groups.values()) {
    if (bucket.length < 2) continue;
    bucket.sort((a, b) => a.index - b.index);
    const latest = bucket[bucket.length - 1];
    const latestOutput =
      typeof latest.part.state.output === "string" ? latest.part.state.output : "";
    for (let i = 0; i < bucket.length - 1; i++) {
      const earlier = bucket[i];
      const earlierOutput =
        typeof earlier.part.state.output === "string" ? earlier.part.state.output : "";
      const superset = latestOutput.includes(earlierOutput);
      const statelessSafe = statelessTools.has(earlier.part.tool);
      if (!superset && !statelessSafe) continue;
      earlier.part.state.output = `[governor] duplicate ${earlier.part.tool} call elided (latest kept)`;
      markStateMetadata(earlier.part.state, { deduped: true });
    }
  }
}

// ---------------------------------------------------------------------------
// Rule 3 — purge resolved error inputs (keep the error text)
// ---------------------------------------------------------------------------

export function purgeErrorInputs(messages, watermark, options = {}) {
  const protectedTools = options.protectedTools || PROTECTED_TOOLS;
  const purgeTurns = Number.isFinite(options.purgeErrorTurns)
    ? options.purgeErrorTurns
    : PURGE_ERROR_TURNS;
  const level = Number.isFinite(watermark) ? watermark : 0;
  if (level <= 0) return; // nothing can be "below" a watermark that never happened

  // Which (session,tool,args) calls completed successfully and where?
  const completed = new Map();
  forEachToolPart(messages, (part, index, sessionID) => {
    if (!part.state || part.state.status !== "completed") return;
    const key = callKey(part, sessionID || part.sessionID || "");
    const list = completed.get(key) || [];
    list.push(index);
    completed.set(key, list);
  });

  forEachToolPart(messages, (part, index, sessionID) => {
    if (protectedTools.has(part.tool)) return;
    const state = part.state;
    if (!state || state.status !== "error") return;
    // Must be at least PURGE_ERROR_TURNS positions below the (monotonic) watermark,
    // so eligibility cannot drift with a sliding tail.
    if (!(index < level - purgeTurns)) return;
    const key = callKey(part, sessionID || part.sessionID || "");
    const resolvedLater = (completed.get(key) || []).some((doneIndex) => doneIndex > index);
    const explicitlyResolved =
      !!(state.metadata && typeof state.metadata === "object" && state.metadata.resolved === true);
    if (!resolvedLater && !explicitlyResolved) return;
    state.input = {};
    markStateMetadata(state, { inputPurged: true });
  });
}

// ---------------------------------------------------------------------------
// Rule 4 — conservative explicit supersession
// ---------------------------------------------------------------------------

function collapseSupersededPart(part, referenceID) {
  const note = `[governor] superseded by ${referenceID} (current state kept)`;
  if (part.type === "text" && typeof part.text === "string") {
    part.text = note;
    markPartMetadata(part, { superseded: true, by: referenceID });
    return;
  }
  if (part.type === "tool" && part.state && part.state.status === "completed") {
    part.state.output = note;
    markStateMetadata(part.state, { superseded: true, by: referenceID });
  }
}

/**
 * Collapse ONLY parts explicitly tagged as superseded by a newer part in the SAME
 * session. Two explicit forms are honoured:
 *   - part.metadata.supersededBy = "<newer part id>"
 *   - part.metadata.superseded = true AND a newer part has
 *     part.metadata.supersedes === "<this part id>"
 * Contradictions are never inferred.
 */
export function applySupersession(messages, _watermark, options = {}) {
  const protectedTools = options.protectedTools || PROTECTED_TOOLS;
  if (!Array.isArray(messages)) return;

  const byID = new Map();
  const entries = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (!message || typeof message !== "object" || !Array.isArray(message.parts)) continue;
    const sessionID =
      message.info && typeof message.info === "object" ? message.info.sessionID : undefined;
    for (const part of message.parts) {
      if (!part || typeof part !== "object") continue;
      const metadata = part.metadata && typeof part.metadata === "object" ? part.metadata : {};
      const record = { part, index, sessionID, metadata };
      entries.push(record);
      if (typeof part.id === "string" && part.id) byID.set(part.id, record);
    }
  }

  for (const record of entries) {
    const { part, metadata } = record;
    if (part.type === "tool") {
      if (protectedTools.has(part.tool)) continue;
      if (!part.state || part.state.status !== "completed") continue; // never collapse active/error
    }

    let referenceID =
      typeof metadata.supersededBy === "string" ? metadata.supersededBy : undefined;
    if (!referenceID && metadata.superseded === true) {
      const newer = entries.find(
        (other) =>
          other.sessionID === record.sessionID &&
          other.index > record.index &&
          typeof other.metadata.supersedes === "string" &&
          other.metadata.supersedes === part.id,
      );
      if (newer) referenceID = newer.part.id;
    }
    if (!referenceID) continue;

    const reference = byID.get(referenceID);
    if (!reference) continue;
    if (reference.sessionID !== record.sessionID) continue; // same session only
    if (reference.index <= record.index) continue; // must be newer
    collapseSupersededPart(part, referenceID);
  }
}

// ---------------------------------------------------------------------------
// Pipeline + factory
// ---------------------------------------------------------------------------

/**
 * Apply the four rules in order. Mutates `messages` in place. Returns the same
 * reference for convenience. Malformed input (no sessionID / not an array) is
 * returned untouched.
 */
export function transformMessages(messages, options = {}) {
  if (!Array.isArray(messages)) return messages;
  const sessionID = findSessionID(messages);
  if (!sessionID) return messages;
  const watermark = observeWatermark(sessionID, messages);
  applyPlaceholders(messages, watermark, options);
  dedupeCalls(messages, watermark, options);
  purgeErrorInputs(messages, watermark, options);
  applySupersession(messages, watermark, options);
  return messages;
}

// opencode plugin factory: returns the transform hook, which never throws.
export const ContextGovernor = async () => ({
  "experimental.chat.messages.transform": async (_input, output) => {
    try {
      if (!output || typeof output !== "object") return;
      transformMessages(output.messages);
    } catch {
      // Never throw: a throw would abort the remaining plugin hook chain.
    }
  },
});
