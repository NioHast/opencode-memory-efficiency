// tool-output-spill.js
// ---------------------------------------------------------------------------
// Keeps oversized `tool.execute.after` results out of the stored session.
//
// When a tool returns an `output.output` string whose UTF-8 size exceeds
// MAX_OUTPUT_BYTES (default 200000), the FULL text is written to
//   ~/.local/share/opencode/tool-spill/<callID>.txt
// and `output.output` is replaced with a bounded preview (first 200 lines AND
// at most 8000 bytes, never splitting a multibyte character) plus a pointer
// line naming the spill file. Results under/at the cap are left byte-identical,
// so the model still sees `read` output verbatim.
//
// Excluded tools (task/batch/compress) are never touched. Every path is wrapped
// so this plugin can NEVER throw — a throw would abort the rest of the hook
// chain (hooks run sequentially).
//
// Env overrides (resolved lazily, per call):
//   SPILL_MAX_BYTES  -> MAX_OUTPUT_BYTES (default 200000)
//   SPILL_DIR        -> spill directory (default ~/.local/share/opencode/tool-spill)
//
// Pure helpers are exported so tests can exercise the logic deterministically
// without the opencode runtime. Importing this module has NO side effects
// (constants only; nothing is created or written at import time).
// ---------------------------------------------------------------------------

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_MAX_OUTPUT_BYTES = 200000;
export const DEFAULT_PREVIEW_BYTES = 8000;
export const DEFAULT_PREVIEW_LINES = 200;
export const EXCLUDED_TOOLS = new Set(["task", "batch", "compress"]);
export const DEFAULT_SPILL_DIR = path.join(
  os.homedir(),
  ".local",
  "share",
  "opencode",
  "tool-spill",
);

// Floor a finite number > 0; undefined for anything else (option validation).
function positiveInt(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

// Effective spill cap: opts.maxBytes > SPILL_MAX_BYTES > 200000 default.
export function resolveMaxBytes(opts) {
  const fromOpts = positiveInt(opts && opts.maxBytes);
  if (fromOpts !== undefined) return fromOpts;
  const fromEnv = positiveInt(Number(process.env.SPILL_MAX_BYTES));
  if (fromEnv !== undefined) return fromEnv;
  return DEFAULT_MAX_OUTPUT_BYTES;
}

// Effective spill dir: opts.spillDir > SPILL_DIR > module default.
export function resolveSpillDir(opts) {
  if (opts && typeof opts.spillDir === "string" && opts.spillDir) return opts.spillDir;
  const fromEnv = process.env.SPILL_DIR;
  if (typeof fromEnv === "string" && fromEnv.trim()) return fromEnv;
  return DEFAULT_SPILL_DIR;
}

// Effective preview byte cap: opts.previewBytes > 8000 default.
export function resolvePreviewBytes(opts) {
  return positiveInt(opts && opts.previewBytes) ?? DEFAULT_PREVIEW_BYTES;
}

// Effective preview line cap: opts.previewLines > 200 default.
export function resolvePreviewLines(opts) {
  return positiveInt(opts && opts.previewLines) ?? DEFAULT_PREVIEW_LINES;
}

// Slice a string to at most `maxBytes` UTF-8 bytes without ever splitting a
// multibyte character. The returned string always encodes to <= maxBytes bytes.
export function safeByteSlice(str, maxBytes) {
  if (typeof str !== "string" || str.length === 0) return "";
  const limit = Math.max(0, Math.floor(maxBytes) || 0);
  if (limit === 0) return "";
  const buf = Buffer.from(str, "utf8");
  if (buf.length <= limit) return str;
  let end = limit;
  // A UTF-8 continuation byte is 10xxxxxx; walk back until `end` points at the
  // start of a character (or byte 0), so subarray(0, end) is a char boundary.
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString("utf8");
}

// First `previewLines` lines, then safely capped to `previewBytes` UTF-8 bytes.
export function buildPreview(text, opts) {
  const lines = resolvePreviewLines(opts);
  const bytes = resolvePreviewBytes(opts);
  let out = typeof text === "string" ? text : String(text ?? "");
  const split = out.split("\n");
  if (split.length > lines) out = split.slice(0, lines).join("\n");
  return safeByteSlice(out, bytes);
}

// One-line notice naming the spill file that holds the untruncated output.
export function buildPointer(filePath) {
  return `[... output truncated: full text at ${filePath} ...]`;
}

// Filesystem-safe, non-empty filename stem. Missing/blank/invalid callID ->
// a unique fallback so a spill is still written without throwing.
export function sanitizeName(name) {
  const raw = typeof name === "string" && name.trim() ? name.trim() : "";
  const safe = raw.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 200);
  if (safe && safe !== "." && safe !== "..") return safe;
  return `spill-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Spill `output.output` if it exceeds the cap.
 *
 * @param {object} output  the `output` arg of `tool.execute.after`
 * @param {object} [opts]  { tool, callID, maxBytes, spillDir, previewBytes, previewLines }
 * @returns {{spilled:boolean, reason:string, path?:string, bytesIn?:number,
 *            bytesOut?:number, error?:string}}
 *
 * Never throws. On any failure the output object is left unchanged.
 */
export function spillIfNeeded(output, opts) {
  const result = { spilled: false, reason: "not-modified" };
  try {
    if (!output || typeof output !== "object") {
      result.reason = "invalid-output";
      return result;
    }
    if (typeof output.output !== "string") {
      result.reason = "non-string-output";
      return result;
    }

    const tool = (opts && opts.tool) || "";
    if (EXCLUDED_TOOLS.has(tool)) {
      result.reason = "excluded";
      return result;
    }

    const text = output.output;
    const bytesIn = Buffer.byteLength(text, "utf8");
    const maxBytes = resolveMaxBytes(opts);
    if (bytesIn <= maxBytes) {
      result.reason = "under-cap";
      result.bytesIn = bytesIn;
      return result;
    }

    const spillDir = resolveSpillDir(opts);
    const filePath = path.join(spillDir, `${sanitizeName(opts && opts.callID)}.txt`);
    const pointer = buildPointer(filePath);

    // Leave room for the pointer line + 2 separator/newline bytes so the final
    // output stays strictly below the preview cap (8000 bytes by default).
    const previewBytes = resolvePreviewBytes(opts);
    const pointerBytes = Buffer.byteLength(pointer, "utf8");
    const contentBudget = Math.max(0, previewBytes - pointerBytes - 2);
    const preview = buildPreview(text, {
      previewBytes: contentBudget,
      previewLines: resolvePreviewLines(opts),
    });

    try {
      fs.mkdirSync(spillDir, { recursive: true });
      fs.writeFileSync(filePath, text, "utf8");
    } catch (err) {
      result.reason = "write-failed";
      result.error = err && err.message ? err.message : String(err);
      return result;
    }

    output.output = `${pointer}\n${preview}`;
    result.spilled = true;
    result.reason = "spilled";
    result.path = filePath;
    result.bytesIn = bytesIn;
    result.bytesOut = Buffer.byteLength(output.output, "utf8");
    return result;
  } catch (err) {
    result.reason = "error";
    result.error = err && err.message ? err.message : String(err);
    return result;
  }
}

// Factory matching the existing plugin style (tool-concurrency.js).
export const ToolOutputSpill = async () => ({
  "tool.execute.after": async (input, output) => {
    try {
      spillIfNeeded(output, {
        tool: input && input.tool,
        callID: input && input.callID,
      });
    } catch {
      // Swallow: this plugin must never break the hook chain.
    }
  },
});
