// summary-diff-cap.js
//
// Bounds the transient prompt-side size of `summary.diffs` carried on chat
// messages before they are sent to the provider.
//
// Hook: "experimental.chat.messages.transform" (input:{}, output:{ messages }[])
// Contract ref: @opencode-ai/plugin@1.18.32 dist/index.d.ts:259-264
//
// This hook receives a TRANSIENT clone of the conversation (structuredClone),
// so it only reduces the per-call prompt payload — it NEVER touches the stored
// DB bytes. Stored-byte pruning is a separate concern (todo 25).
//
// Mutation contract: `capDiffs(message)` MUTATES `message.info.summary.diffs`
// in place (safe — the hook object is a transient clone) and RETURNS the same
// `message` for chaining/tests. The `messages` array itself is never reordered
// or removed. The plugin never throws: every entry point is wrapped in
// try/catch so a malformed payload cannot abort the shared hook chain.

const DEFAULT_MAX_PATCH_BYTES = 64 * 1024; // 64KB per file patch
const DEFAULT_MAX_TOTAL_BYTES = 512 * 1024; // 512KB total patches across a message
const TRUNCATION_MARKER = "\n[... truncated ...]";

// Vendor / generated / cache path segments that are dropped outright.
const VENDOR_SEGMENTS = new Set([
  "node_modules",
  ".node-runtime",
  "dist",
  "build",
  ".venv",
  ".cache",
  "__pycache__",
  ".next",
  ".turbo",
]);

/**
 * Vendor/generated-path predicate.
 * Matches whole path segments (so `redistribute.js` is NOT a `dist` match).
 * @param {unknown} file
 * @returns {boolean}
 */
export function isVendorPath(file) {
  if (typeof file !== "string" || file.length === 0) return false;
  const normalized = file.replace(/\\/g, "/");
  for (const segment of normalized.split("/")) {
    if (VENDOR_SEGMENTS.has(segment)) return true;
  }
  return false;
}

// Positive integer from env `name`, else `fallback` (unset/blank/invalid).
function envPositiveInt(name, fallback) {
  try {
    const raw = process.env[name];
    if (raw === undefined || raw === null || raw === "") return fallback;
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  } catch {
    /* ignore */
  }
  return fallback;
}

// Precedence for a cap: explicit non-negative value > env `envName` > fallback.
function resolveLimit(explicit, envName, fallback) {
  if (Number.isFinite(explicit) && explicit >= 0) return Math.floor(explicit);
  return envPositiveInt(envName, fallback);
}

// UTF-8 byte length of a string (0 for non-strings).
function byteLength(value) {
  if (typeof value === "string") return Buffer.byteLength(value, "utf8");
  return 0;
}

/**
 * Byte-safe UTF-8 slice: never splits a multi-byte code point, so the result
 * re-encodes to <= maxBytes bytes.
 */
function safeSliceBytes(str, maxBytes) {
  if (maxBytes <= 0) return "";
  const buf = Buffer.from(str, "utf8");
  if (buf.length <= maxBytes) return str;
  let end = maxBytes;
  // Back off to the previous code-point boundary (skip UTF-8 continuation bytes).
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.toString("utf8", 0, end);
}

/**
 * Truncate a patch to <= maxBytes, appending a trailing marker. The marker is
 * counted inside the budget so the returned string never exceeds maxBytes.
 */
function truncatePatch(patch, maxBytes) {
  if (byteLength(patch) <= maxBytes) return patch;
  const markerBytes = byteLength(TRUNCATION_MARKER);
  if (maxBytes <= markerBytes) return safeSliceBytes(patch, maxBytes);
  return safeSliceBytes(patch, maxBytes - markerBytes) + TRUNCATION_MARKER;
}

// Object that is neither null nor an array (summary/metadata shape guard).
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Cap `message.info.summary.diffs` in place.
 *
 * Order of operations:
 *   1. Vendor/generated entries are dropped.
 *   2. Each retained `patch` is truncated to `maxPatchBytes` (marker appended).
 *   3. If the sum of retained patch bytes exceeds `maxTotalBytes`, the
 *      lowest-priority entries are dropped. Lowest priority = largest patch
 *      bytes first, then latest index (ties) — this frees the most budget and
 *      keeps the earliest entries stable.
 *
 * Malformed entries (non-object, non-string `file`, non-string `patch`) are
 * left completely untouched: never dropped, never truncated, not counted.
 *
 * @param {{info?: {summary?: {diffs?: unknown}}}} message
 * @param {{maxPatchBytes?: number, maxTotalBytes?: number}} [opts]
 * @returns the same `message` object
 */
export function capDiffs(message, opts = {}) {
  try {
    if (!isPlainObject(message)) return message;
    const info = message.info;
    if (!isPlainObject(info)) return message;
    const summary = info.summary;
    if (!isPlainObject(summary)) return message;

    const diffs = summary.diffs;
    if (!Array.isArray(diffs) || diffs.length === 0) return message;

    const maxPatchBytes = resolveLimit(
      opts.maxPatchBytes,
      "DIFF_MAX_PATCH_BYTES",
      DEFAULT_MAX_PATCH_BYTES,
    );
    const maxTotalBytes = resolveLimit(
      opts.maxTotalBytes,
      "DIFF_MAX_TOTAL_BYTES",
      DEFAULT_MAX_TOTAL_BYTES,
    );

    // Classify. `keep` holds retained (well-formed, non-vendor) entries.
    const kept = [];
    let total = 0;

    for (let index = 0; index < diffs.length; index++) {
      const entry = diffs[index];

      if (!isPlainObject(entry)) {
        kept.push({ entry, index, bytes: 0, malformed: true });
        continue;
      }
      const file = entry.file;
      const patch = entry.patch;

      // Malformed entry -> leave entirely untouched.
      if (typeof file !== "string" || typeof patch !== "string") {
        kept.push({ entry, index, bytes: 0, malformed: true });
        continue;
      }

      // Vendor/generated -> drop entirely.
      if (isVendorPath(file)) continue;

      if (byteLength(patch) > maxPatchBytes) {
        entry.patch = truncatePatch(patch, maxPatchBytes);
      }
      const bytes = byteLength(entry.patch);
      total += bytes;
      kept.push({ entry, index, bytes, malformed: false });
    }

    // Total cap: drop lowest-priority well-formed entries.
    const dropped = new Set();
    if (total > maxTotalBytes) {
      const droppable = kept
        .filter((k) => !k.malformed)
        .slice()
        .sort((a, b) => b.bytes - a.bytes || b.index - a.index);
      let over = total - maxTotalBytes;
      for (const candidate of droppable) {
        if (over <= 0) break;
        dropped.add(candidate.index);
        over -= candidate.bytes;
      }
    }

    const retained = [];
    for (const k of kept) {
      if (dropped.has(k.index)) continue;
      retained.push(k.entry);
    }

    // Vendor-only arrays legitimately become []; the array itself is always preserved.
    summary.diffs = retained;
    return message;
  } catch {
    // Never throw into the shared hook chain.
    return message;
  }
}

/**
 * opencode plugin factory.
 * @returns {Promise<{"experimental.chat.messages.transform": (input: {}, output: {messages: unknown[]}) => Promise<void>}>}
 */
export const SummaryDiffCap = async () => ({
  "experimental.chat.messages.transform": async (_input, output) => {
    try {
      const messages = output && output.messages;
      if (!Array.isArray(messages)) return;
      for (const message of messages) {
        try {
          capDiffs(message);
        } catch {
          // per-message isolation
        }
      }
    } catch {
      // never abort the hook chain
    }
  },
});

export default SummaryDiffCap;
