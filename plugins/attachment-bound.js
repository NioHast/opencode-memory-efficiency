// attachment-bound.js
// ---------------------------------------------------------------------------
// Bounds oversized `type:'file'` / attachment payloads (the measured
// 19MB / 8.5MB / 4.3MB `read`-on-PDF parts) so future multi-MB attachments are
// spilled to disk and replaced with a bounded preview + pointer.
//
// WHICH TOOLS PRODUCE ATTACHMENTS (verified in the compiled opencode binary,
// not guessed):
//   * built-in `read` on a PDF/image returns
//       { title, output:"PDF read successfully", metadata, attachments:[
//           { type:"file", mime:"application/pdf",
//             url:"data:application/pdf;base64,<whole file>" } ] }
//   * built-in `webfetch` on an image returns the same `attachments` shape.
//   * `look_at` / MCP tools return raw content; their images become
//     `{type:"file", mime, url:"data:...;base64,..."}` attachments too.
//   * pasted images / dragged files arrive as `type:'file'` user-message parts
//     (`{type:"file", mime, filename, url:"data:...;base64,...", source}`).
//
// WHERE THE PAYLOAD IS MUTABLE (the honest hook-surface audit):
//
//   1) "tool.execute.after"  <-- REAL + STORED BOUND
//      The runtime object passed as `output` for built-in tools is the tool
//      result V itself, built in the binary as
//        V = { ...a, attachments: a.attachments?.map(...) }
//      and then, after the hook runs, `completeToolCall(callID, V)` persists
//      `state.attachments = V.attachments` (the very same array). Mutating the
//      attachment objects in place therefore shrinks BOTH the stored tool part
//      AND the synthetic user file part later materialized from
//      `state.attachments`. NOTE: the TypeScript type for this hook's `output`
//      is `{title, output, metadata}` and OMITS `attachments`; the property is
//      still present at runtime for built-in tools. We only act when present,
//      so a future/other build that omits it degrades to a no-op (never a
//      fake bound).
//
//   2) "chat.message"  <-- REAL + STORED BOUND (user-message file parts)
//      The hook receives `{ message, parts }`; opencode then builds the parts
//      to persist from the SAME `parts` array and calls `updatePart` on them.
//      Mutating a `type:'file'` part object in place is therefore persisted.
//
//   3) "experimental.chat.messages.transform"  <-- REACHABLE but PROMPT-ONLY
//      `parts` (and `part.state.attachments`) are mutable in a transient
//      structuredClone: it reduces the next prompt only and NEVER the stored
//      DB bytes. Included as defense-in-depth for message parts that bypass the
//      two stored hooks.
//
// Bound policy: gate on the UTF-8 byte length of the attachment `url`, which
// is exactly what bloats storage for a data URI (the 19,981,034-byte stored
// part has a 19,980,884-byte url). When over MAX_ATTACHMENT_BYTES (default
// 1MB) the whole payload is written to disk (decoded when the data URI is
// base64), and the attachment is replaced IN PLACE by a small
// `data:text/plain;base64,...` note holding a pointer plus a bounded preview of
// the first ATTACHMENT_PREVIEW_BYTES bytes. `mime` becomes `text/plain` so
// opencode elides the placeholder from media prompts. Small attachments are
// left byte-identical, so image paste and normal files are unaffected.
//
// Env overrides (resolved lazily, per call):
//   MAX_ATTACHMENT_BYTES     -> cap in bytes (default 1048576)
//   ATTACHMENT_SPILL_DIR     -> spill directory
//                               (default ~/.local/share/opencode/tool-spill/attachments)
//   ATTACHMENT_PREVIEW_BYTES -> preview bytes (default 4096)
//
// Never throws. Importing this module has NO side effects (nothing is created
// or written at import time). Pure helpers are exported for deterministic
// tests without the opencode runtime.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_MAX_ATTACHMENT_BYTES = 1024 * 1024; // 1MB
export const DEFAULT_ATTACHMENT_PREVIEW_BYTES = 4096;
export const DEFAULT_ATTACHMENT_SPILL_DIR = path.join(
  os.homedir(),
  ".local",
  "share",
  "opencode",
  "tool-spill",
  "attachments",
);

export const ENV_MAX_ATTACHMENT_BYTES = "MAX_ATTACHMENT_BYTES";
export const ENV_ATTACHMENT_SPILL_DIR = "ATTACHMENT_SPILL_DIR";
export const ENV_ATTACHMENT_PREVIEW_BYTES = "ATTACHMENT_PREVIEW_BYTES";

const POINTER_TAG = "[attachment-bound]";

// ---------------------------------------------------------------------------
// Resolvers (opts > env > default; env read at call time so tests can flip it)
// ---------------------------------------------------------------------------

function positiveInt(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

// Positive integer from env var `name`, or undefined when unset/blank/invalid.
function envPositiveInt(name) {
  try {
    const raw = process.env[name];
    if (raw === undefined || raw === null || raw === "") return undefined;
    return positiveInt(Number(raw));
  } catch {
    return undefined;
  }
}

// Effective cap: opts.maxAttachmentBytes > MAX_ATTACHMENT_BYTES > 1MB default.
export function resolveMaxAttachmentBytes(opts) {
  const fromOpts = positiveInt(opts && opts.maxAttachmentBytes);
  if (fromOpts !== undefined) return fromOpts;
  const fromEnv = envPositiveInt(ENV_MAX_ATTACHMENT_BYTES);
  if (fromEnv !== undefined) return fromEnv;
  return DEFAULT_MAX_ATTACHMENT_BYTES;
}

// Effective preview: opts.previewBytes > ATTACHMENT_PREVIEW_BYTES > 4096 default.
export function resolveAttachmentPreviewBytes(opts) {
  const fromOpts = positiveInt(opts && opts.previewBytes);
  if (fromOpts !== undefined) return fromOpts;
  const fromEnv = envPositiveInt(ENV_ATTACHMENT_PREVIEW_BYTES);
  if (fromEnv !== undefined) return fromEnv;
  return DEFAULT_ATTACHMENT_PREVIEW_BYTES;
}

// Effective spill dir: opts.spillDir > ATTACHMENT_SPILL_DIR > module default.
export function resolveAttachmentSpillDir(opts) {
  if (opts && typeof opts.spillDir === "string" && opts.spillDir) return opts.spillDir;
  const fromEnv = process.env[ENV_ATTACHMENT_SPILL_DIR];
  if (typeof fromEnv === "string" && fromEnv.trim()) return fromEnv;
  return DEFAULT_ATTACHMENT_SPILL_DIR;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

// Slice a string to at most `maxBytes` UTF-8 bytes without splitting a
// multibyte character. The returned string always encodes to <= maxBytes.
export function safeByteSlice(str, maxBytes) {
  if (typeof str !== "string" || str.length === 0) return "";
  const limit = Math.max(0, Math.floor(maxBytes) || 0);
  if (limit === 0) return "";
  const buf = Buffer.from(str, "utf8");
  if (buf.length <= limit) return str;
  let end = limit;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString("utf8");
}

// Filesystem-safe, non-empty filename stem. Missing/blank/invalid name ->
// unique fallback so a spill is still written without throwing.
export function sanitizeName(name) {
  const raw = typeof name === "string" && name.trim() ? name.trim() : "";
  const safe = raw.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 180);
  if (safe && safe !== "." && safe !== "..") return safe;
  return `attachment-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

const MIME_EXT = {
  "application/pdf": "pdf",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "text/plain": "txt",
  "text/markdown": "md",
  "application/json": "json",
  "text/csv": "csv",
};

// Spill-file extension for a mime type (text/* -> txt, image/* -> img, else bin).
export function extensionForMime(mime) {
  if (typeof mime !== "string") return "bin";
  const base = mime.split(";")[0].trim().toLowerCase();
  if (MIME_EXT[base]) return MIME_EXT[base];
  if (base.startsWith("text/")) return "txt";
  if (base.startsWith("image/")) return "img";
  return "bin";
}

// True when `url` is a `data:` URI (case-insensitive prefix check).
export function isDataUri(url) {
  return typeof url === "string" && url.slice(0, 5).toLowerCase() === "data:";
}

// Parse a data URI without decoding its payload.
// @returns {{mime:string, base64:boolean, payload:string} | null}
export function parseDataUri(url) {
  if (!isDataUri(url)) return null;
  const comma = url.indexOf(",");
  if (comma === -1) return null;
  const header = url.slice(5, comma); // after "data:"
  const payload = url.slice(comma + 1);
  const segments = header.split(";");
  const base64 = segments.some((s) => s.trim().toLowerCase() === "base64");
  const mime = (segments[0] || "").trim() || "text/plain";
  return { mime, base64, payload };
}

// The stored bytes an attachment contributes: the UTF-8 length of its `url`
// (for a data URI that is the whole base64 payload). 0 for non-string urls.
export function attachmentByteLength(part) {
  if (!part || typeof part !== "object") return 0;
  return typeof part.url === "string" ? Buffer.byteLength(part.url, "utf8") : 0;
}

// Decode a parsed data URI's payload to a Buffer.
export function decodeDataUriPayload(parsed) {
  if (!parsed || typeof parsed.payload !== "string") return Buffer.alloc(0);
  if (parsed.base64) {
    // Tolerate whitespace/newlines inside base64 (Node ignores them).
    return Buffer.from(parsed.payload.replace(/\s+/g, ""), "base64");
  }
  try {
    return Buffer.from(decodeURIComponent(parsed.payload), "utf8");
  } catch {
    return Buffer.from(parsed.payload, "utf8");
  }
}

// Human pointer line naming the mime, original byte size and spill file.
export function buildAttachmentPointer(spillPath, part, bytesIn) {
  const mime = (part && part.mime) || "application/octet-stream";
  const name = part && part.filename ? ` "${part.filename}"` : "";
  return `[attachment elided${name}: ${mime}, ${bytesIn} bytes; full payload at ${spillPath}]`;
}

// ---------------------------------------------------------------------------
// boundAttachment: bound one attachment/file part IN PLACE.
//
// @param {object} part  a `{type:'file', mime, url, filename?}` attachment
// @param {object} [opts] { maxAttachmentBytes, previewBytes, spillDir, callID }
// @returns {{bounded:boolean, reason:string, path?:string, bytesIn?:number,
//            bytesOut?:number, error?:string}}
//
// Never throws. Under/at the cap (or a non-string url) the object is left
// byte-identical. On spill-write failure the object is left unchanged.
// ---------------------------------------------------------------------------
export function boundAttachment(part, opts) {
  const result = { bounded: false, reason: "not-modified" };
  try {
    if (!part || typeof part !== "object") {
      result.reason = "invalid-part";
      return result;
    }
    if (typeof part.url !== "string") {
      result.reason = part.url === undefined ? "missing-url" : "non-string-url";
      return result;
    }

    const bytesIn = Buffer.byteLength(part.url, "utf8");
    const maxBytes = resolveMaxAttachmentBytes(opts);
    if (bytesIn <= maxBytes) {
      result.reason = "under-cap";
      result.bytesIn = bytesIn;
      return result;
    }

    const parsed = parseDataUri(part.url);
    const raw = parsed ? decodeDataUriPayload(parsed) : Buffer.from(part.url, "utf8");

    const spillDir = resolveAttachmentSpillDir(opts);
    const stem = sanitizeName(
      (part.filename || part.id || (opts && opts.callID) || "attachment"),
    );
    const ext = extensionForMime((parsed && parsed.mime) || part.mime);
    const spillPath = path.join(spillDir, `${stem}.${ext}`);

    const previewBytes = resolveAttachmentPreviewBytes(opts);
    const previewBuf = raw.subarray(0, Math.max(0, previewBytes));
    const previewText = previewBuf.toString("utf8");
    const pointer = buildAttachmentPointer(spillPath, part, bytesIn);
    const note =
      `${pointer}\n` +
      `[... preview (${previewBuf.length}/${raw.length} bytes) ...]\n` +
      previewText;

    try {
      fs.mkdirSync(spillDir, { recursive: true });
      // Write the DECODED payload bytes verbatim (byte-accurate for binary).
      fs.writeFileSync(spillPath, raw);
    } catch (err) {
      result.reason = "write-failed";
      result.error = err && err.message ? err.message : String(err);
      return result;
    }

    // Mutate the attachment in place so callers holding the SAME object
    // (tool result array / message part array) see the bound.
    part.url = `data:text/plain;base64,${Buffer.from(note, "utf8").toString("base64")}`;
    part.mime = "text/plain";

    result.bounded = true;
    result.reason = "bounded";
    result.path = spillPath;
    result.bytesIn = bytesIn;
    result.bytesOut = Buffer.byteLength(part.url, "utf8");
    return result;
  } catch (err) {
    result.reason = "error";
    result.error = err && err.message ? err.message : String(err);
    return result;
  }
}

// ---------------------------------------------------------------------------
// boundToolOutput: bound `output.attachments` (built-in read/webfetch) and add
// a pointer note to `output.output`. Mutates `output` in place.
// ---------------------------------------------------------------------------
export function boundToolOutput(output, opts) {
  const summary = { bounded: 0, results: [] };
  try {
    if (!output || typeof output !== "object") return summary;
    const attachments = output.attachments;
    if (!Array.isArray(attachments) || attachments.length === 0) return summary;

    const baseOpts = opts && typeof opts === "object" ? opts : {};
    for (const attachment of attachments) {
      const res = boundAttachment(attachment, baseOpts);
      if (res.bounded) {
        summary.bounded += 1;
        summary.results.push(res);
      }
    }

    if (summary.bounded > 0 && typeof output.output === "string") {
      const paths = summary.results.map((r) => r.path).filter(Boolean);
      if (!output.output.includes(POINTER_TAG)) {
        output.output += `\n${POINTER_TAG} ${summary.bounded} oversized attachment(s) spilled: ${paths.join(", ")}`;
      }
    }
    return summary;
  } catch {
    return summary;
  }
}

// ---------------------------------------------------------------------------
// boundMessageParts: bound `type:'file'` message parts AND tool-part
// `state.attachments` inside a `{messages:[{info,parts}]}` payload. Mutates
// the part objects in place. Returns the number of bounded attachments.
// ---------------------------------------------------------------------------
export function boundMessageParts(messages, opts) {
  let bounded = 0;
  try {
    if (!Array.isArray(messages)) return 0;
    const baseOpts = opts && typeof opts === "object" ? opts : {};
    for (const message of messages) {
      const parts = message && message.parts;
      if (!Array.isArray(parts)) continue;
      for (const part of parts) {
        if (!part || typeof part !== "object") continue;
        if (part.type === "file") {
          const res = boundAttachment(part, { ...baseOpts, callID: part.id });
          if (res.bounded) bounded += 1;
        } else if (
          part.type === "tool" &&
          part.state &&
          Array.isArray(part.state.attachments)
        ) {
          for (const attachment of part.state.attachments) {
            const res = boundAttachment(attachment, {
              ...baseOpts,
              callID: part.callID,
            });
            if (res.bounded) bounded += 1;
          }
        }
      }
    }
    return bounded;
  } catch {
    return bounded;
  }
}

// ---------------------------------------------------------------------------
// Plugin factory (matches tool-concurrency.js / tool-output-spill.js style).
// Every hook body is wrapped so this plugin can never abort the shared chain.
// ---------------------------------------------------------------------------
export const AttachmentBound = async () => ({
  // (1) REAL + STORED: tool result attachments (read-on-PDF, webfetch image).
  "tool.execute.after": async (input, output) => {
    try {
      boundToolOutput(output, {
        tool: input && input.tool,
        callID: input && input.callID,
      });
    } catch {
      // never break the hook chain
    }
  },

  // (2) REAL + STORED: user-message file parts (image paste / dragged files).
  // Mutate part objects in place: opencode persists the SAME objects after the
  // hook (it iterates the original `parts` array, not a copy).
  "chat.message": async (_input, output) => {
    try {
      const parts = output && output.parts;
      if (!Array.isArray(parts)) return;
      for (const part of parts) {
        if (!part || typeof part !== "object") continue;
        if (part.type === "file") {
          boundAttachment(part, { callID: part.id });
        }
      }
    } catch {
      // never break the hook chain
    }
  },

  // (3) PROMPT-ONLY defense-in-depth for message file parts / tool attachments.
  "experimental.chat.messages.transform": async (_input, output) => {
    try {
      boundMessageParts(output && output.messages);
    } catch {
      // never break the hook chain
    }
  },
});

export default AttachmentBound;
