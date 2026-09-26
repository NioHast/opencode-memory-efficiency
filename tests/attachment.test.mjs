// Unit tests for the attachment-bound plugin (todo 22).
//
// Run:
//   node --test --no-warnings ~/.config/opencode/tests/attachment.test.mjs
//
// Node 24 auto-detects ESM in the plugin's `.js` (no package.json "type"), so
// `--no-warnings` suppresses the MODULE_TYPELESS_PACKAGE_JSON notice.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  AttachmentBound,
  boundAttachment,
  boundToolOutput,
  boundMessageParts,
  resolveMaxAttachmentBytes,
  resolveAttachmentPreviewBytes,
  resolveAttachmentSpillDir,
  attachmentByteLength,
  parseDataUri,
  isDataUri,
  decodeDataUriPayload,
  extensionForMime,
  safeByteSlice,
  sanitizeName,
  DEFAULT_MAX_ATTACHMENT_BYTES,
  DEFAULT_ATTACHMENT_PREVIEW_BYTES,
  DEFAULT_ATTACHMENT_SPILL_DIR,
  ENV_MAX_ATTACHMENT_BYTES,
  ENV_ATTACHMENT_SPILL_DIR,
  ENV_ATTACHMENT_PREVIEW_BYTES,
} from "../plugins/attachment-bound.js";

const PLUGIN_URL = pathToFileURL(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "plugins",
    "attachment-bound.js",
  ),
).href;

function tmpDir(prefix = "attachment-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// A data URI whose decoded payload is exactly `bytes` bytes.
function dataUri(mime, bytes, fill = 0x41) {
  return `data:${mime};base64,${Buffer.alloc(bytes, fill).toString("base64")}`;
}

// A raw data URI whose *url string* is exactly `n` bytes (not a real payload).
function urlOfLength(n) {
  return "x".repeat(n);
}

// Env helper that also supports async callbacks (restores after resolution).
function withEnv(vars, fn) {
  const saved = {};
  for (const key of Object.keys(vars)) {
    saved[key] = Object.prototype.hasOwnProperty.call(process.env, key)
      ? process.env[key]
      : undefined;
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  }
  const restore = () => {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  };
  let out;
  try {
    out = fn();
  } catch (err) {
    restore();
    throw err;
  }
  if (out && typeof out.then === "function") return out.finally(restore);
  restore();
  return out;
}

// ---------------------------------------------------------------------------
test("oversized (>1MB) attachment is previewed + spilled and replaced in place", () => {
  const dir = tmpDir();
  // ~1.5MB decoded -> ~2MB base64 url, clearly over the 1MB default cap.
  const payload = Buffer.alloc(1_500_000, 0x41);
  const part = {
    type: "file",
    mime: "application/pdf",
    filename: "big-laporan.pdf",
    url: `data:application/pdf;base64,${payload.toString("base64")}`,
  };
  const urlBefore = part.url;

  const res = boundAttachment(part, { spillDir: dir });

  assert.equal(res.bounded, true, "should bound");
  assert.equal(res.reason, "bounded");
  assert.ok(res.bytesIn > DEFAULT_MAX_ATTACHMENT_BYTES, "bytesIn over cap");
  assert.ok(res.path && fs.existsSync(res.path), "spill file created");
  assert.ok(res.path.endsWith(".pdf"), "spill uses the mime extension");
  // Byte-accurate: the decoded payload is persisted verbatim.
  assert.equal(
    Buffer.compare(fs.readFileSync(res.path), payload),
    0,
    "spill content equals decoded payload bytes",
  );

  // Replaced by a small text/plain data URI holding a pointer + bounded preview.
  assert.equal(part.mime, "text/plain", "placeholder mime is text/plain");
  assert.notEqual(part.url, urlBefore, "url replaced");
  assert.ok(part.url.startsWith("data:text/plain;base64,"), "placeholder is a small data URI");
  assert.ok(
    Buffer.byteLength(part.url, "utf8") < (DEFAULT_ATTACHMENT_PREVIEW_BYTES + 4096) * 2,
    `placeholder bytes are bounded (got ${Buffer.byteLength(part.url, "utf8")})`,
  );

  const note = decodeDataUriPayload(parseDataUri(part.url)).toString("utf8");
  assert.ok(note.includes("[attachment elided"), "pointer present");
  assert.ok(note.includes(res.path), "pointer names the spill file");
  assert.ok(note.includes("preview"), "preview marker present");
  assert.equal(res.bytesOut, Buffer.byteLength(part.url, "utf8"), "bytesOut matches");
});

// ---------------------------------------------------------------------------
test("small (<1MB) image passes unchanged (byte-identical) and writes nothing", () => {
  const dir = tmpDir();
  const part = {
    type: "file",
    mime: "image/png",
    filename: "clipboard",
    url: dataUri("image/png", 100_000, 0x89),
  };
  const before = JSON.stringify(part);

  const res = boundAttachment(part, { spillDir: dir });

  assert.equal(res.bounded, false, "under-cap not bounded");
  assert.equal(res.reason, "under-cap");
  assert.equal(JSON.stringify(part), before, "part byte-identical");
  assert.deepEqual(fs.readdirSync(dir), [], "no spill file written");
});

// ---------------------------------------------------------------------------
test("url exactly at the cap is unchanged", () => {
  const dir = tmpDir();
  const max = 1000;
  const part = { type: "file", mime: "text/plain", url: urlOfLength(max) };

  const res = boundAttachment(part, { spillDir: dir, maxAttachmentBytes: max });

  assert.equal(res.bounded, false, "at-cap is not over-cap");
  assert.equal(res.reason, "under-cap");
  assert.equal(part.url.length, max, "unchanged");
  assert.deepEqual(fs.readdirSync(dir), [], "nothing written");
});

// ---------------------------------------------------------------------------
test("missing/non-string url and non-object parts: no throw, unchanged", () => {
  const dir = tmpDir();
  for (const part of [null, undefined, "string", 42, { type: "file" }, { type: "file", url: 123 }]) {
    assert.doesNotThrow(() => boundAttachment(part, { spillDir: dir }), `no throw for ${String(part)}`);
  }
  const missing = { type: "file" };
  assert.equal(boundAttachment(missing, { spillDir: dir }).reason, "missing-url");
  const numeric = { type: "file", url: 123 };
  assert.equal(boundAttachment(numeric, { spillDir: dir }).reason, "non-string-url");
  assert.equal(numeric.url, 123, "numeric url untouched");
  assert.deepEqual(fs.readdirSync(dir), [], "nothing written");
});

// ---------------------------------------------------------------------------
test("env override MAX_ATTACHMENT_BYTES is honored (both directions)", () => {
  const dir = tmpDir();
  // 5KB payload -> ~6.7KB url; a 1000-byte cap must catch it...
  const smallish = { type: "file", mime: "image/png", filename: "s", url: dataUri("image/png", 5000) };
  withEnv({ [ENV_MAX_ATTACHMENT_BYTES]: "1000", [ENV_ATTACHMENT_SPILL_DIR]: dir }, () => {
    const res = boundAttachment(smallish);
    assert.equal(res.bounded, true, "tiny env cap bounds a 5KB payload");
    assert.ok(fs.existsSync(res.path), "spill written under env cap");
  });

  // ...while a huge env cap lets a 1.5MB payload pass unchanged.
  const dir2 = tmpDir();
  const big = { type: "file", mime: "application/pdf", filename: "b", url: dataUri("application/pdf", 1_500_000) };
  const before = JSON.stringify(big);
  withEnv({ [ENV_MAX_ATTACHMENT_BYTES]: "100000000", [ENV_ATTACHMENT_SPILL_DIR]: dir2 }, () => {
    const res = boundAttachment(big);
    assert.equal(res.bounded, false, "huge env cap leaves 1.5MB unchanged");
    assert.equal(JSON.stringify(big), before, "byte-identical");
  });
  assert.deepEqual(fs.readdirSync(dir2), [], "no spill under huge cap");
});

// ---------------------------------------------------------------------------
test("resolvers honour opts over env over default", () => {
  assert.equal(DEFAULT_MAX_ATTACHMENT_BYTES, 1048576);
  assert.equal(DEFAULT_ATTACHMENT_PREVIEW_BYTES, 4096);
  assert.ok(DEFAULT_ATTACHMENT_SPILL_DIR.endsWith(path.join("tool-spill", "attachments")));

  assert.equal(resolveMaxAttachmentBytes({ maxAttachmentBytes: 7 }), 7);
  assert.equal(resolveAttachmentPreviewBytes({ previewBytes: 9 }), 9);
  withEnv({ [ENV_MAX_ATTACHMENT_BYTES]: "123" }, () => {
    assert.equal(resolveMaxAttachmentBytes(), 123, "env used when no opts");
    assert.equal(resolveMaxAttachmentBytes({ maxAttachmentBytes: 7 }), 7, "opts beat env");
  });
  assert.equal(resolveMaxAttachmentBytes(), DEFAULT_MAX_ATTACHMENT_BYTES, "default when unset");

  const dir = tmpDir();
  assert.equal(resolveAttachmentSpillDir({ spillDir: dir }), dir);
  withEnv({ [ENV_ATTACHMENT_SPILL_DIR]: "/tmp/env-spill" }, () => {
    assert.equal(resolveAttachmentSpillDir(), "/tmp/env-spill");
    assert.equal(resolveAttachmentSpillDir({ spillDir: dir }), dir, "opts beat env");
  });
  assert.equal(sanitizeName("../../etc/passwd").indexOf("/"), -1, "path separators sanitized");
});

// ---------------------------------------------------------------------------
test("parseDataUri / isDataUri / attachmentByteLength / extensionForMime", () => {
  const uri = dataUri("image/png", 12);
  assert.equal(isDataUri(uri), true);
  assert.equal(isDataUri("file:///tmp/x.png"), false);
  const parsed = parseDataUri(uri);
  assert.equal(parsed.mime, "image/png");
  assert.equal(parsed.base64, true);
  assert.equal(Buffer.from(parsed.payload, "base64").length, 12);
  assert.equal(parseDataUri("not a data uri"), null);

  const plain = parseDataUri("data:text/plain,hello%20world");
  assert.equal(plain.base64, false);
  assert.equal(decodeDataUriPayload(plain).toString("utf8"), "hello world");

  assert.equal(attachmentByteLength({ url: uri }), Buffer.byteLength(uri, "utf8"));
  assert.equal(attachmentByteLength({ url: 5 }), 0);
  assert.equal(attachmentByteLength(null), 0);
  assert.equal(extensionForMime("application/pdf"), "pdf");
  assert.equal(extensionForMime("image/jpeg; charset=binary"), "jpg");
  assert.equal(extensionForMime("weird/thing"), "bin");
});

// ---------------------------------------------------------------------------
test("safeByteSlice is multibyte-safe and respects the byte cap", () => {
  const accented = "é".repeat(5000); // 2 bytes each
  const sliced = safeByteSlice(accented, 8000);
  assert.ok(Buffer.byteLength(sliced, "utf8") <= 8000, "byte cap respected");
  assert.ok(!sliced.includes("\uFFFD"), "no split multibyte char");
  assert.equal(sliced, "é".repeat(4000), "whole chars only");

  const emoji = "😀".repeat(3000);
  const es = safeByteSlice(emoji, 8001);
  assert.equal(es, "😀".repeat(2000), "whole surrogate pairs only");
  assert.equal(safeByteSlice("abc", 0), "", "zero budget -> empty");
  assert.equal(safeByteSlice("abc", 10), "abc", "under cap -> unchanged");
});

// ---------------------------------------------------------------------------
test("boundToolOutput mutates output.attachments and notes output.output", () => {
  const dir = tmpDir();
  const big = { type: "file", mime: "application/pdf", filename: "a.pdf", url: dataUri("application/pdf", 1_500_000) };
  const small = { type: "file", mime: "image/png", filename: "b.png", url: dataUri("image/png", 100_000) };
  const smallBefore = JSON.stringify(small);
  const output = {
    title: "read",
    output: "PDF read successfully",
    metadata: { preview: "PDF read successfully" },
    attachments: [big, small],
  };

  const summary = boundToolOutput(output, { tool: "read", callID: "c1", spillDir: dir });

  assert.equal(summary.bounded, 1, "only the oversized one is bounded");
  assert.equal(big.mime, "text/plain", "big attachment replaced");
  assert.equal(JSON.stringify(small), smallBefore, "small attachment byte-identical");
  assert.equal(output.attachments.length, 2, "array length preserved");
  assert.ok(output.output.includes("[attachment-bound]"), "pointer note appended to output");
  assert.ok(output.output.includes(summary.results[0].path), "note names the spill file");
  assert.ok(fs.existsSync(summary.results[0].path), "spill written by tool-output path");
});

// ---------------------------------------------------------------------------
test("boundToolOutput is a no-op without an attachments array", () => {
  assert.equal(boundToolOutput(undefined, {}).bounded, 0);
  assert.equal(boundToolOutput({ output: "x", metadata: {} }, {}).bounded, 0);
  assert.equal(boundToolOutput({ attachments: [] }, {}).bounded, 0);
  assert.doesNotThrow(() => boundToolOutput({ attachments: [null, 5, "s"] }, { spillDir: tmpDir() }));
});

// ---------------------------------------------------------------------------
test("boundMessageParts bounds file parts and tool state.attachments, leaves others", () => {
  const dir = tmpDir();
  const filePart = { type: "file", mime: "image/png", filename: "clip", url: dataUri("image/png", 1_400_000) };
  const textPart = { type: "text", text: "hello" };
  const toolAttachment = { type: "file", mime: "application/pdf", filename: "p.pdf", url: dataUri("application/pdf", 1_600_000) };
  const messages = [
    { info: {}, parts: [filePart, textPart] },
    { info: {}, parts: [{ type: "tool", callID: "c9", state: { status: "completed", attachments: [toolAttachment] } }] },
  ];
  const textBefore = JSON.stringify(textPart);

  const n = boundMessageParts(messages, { spillDir: dir });

  assert.equal(n, 2, "two attachments bounded");
  assert.equal(filePart.mime, "text/plain", "file part replaced");
  assert.equal(toolAttachment.mime, "text/plain", "tool state attachment replaced");
  assert.equal(JSON.stringify(textPart), textBefore, "text part untouched");
  assert.equal(boundMessageParts(null, {}), 0);
  assert.equal(boundMessageParts({}, {}), 0);
});

// ---------------------------------------------------------------------------
test("unwritable spill dir: no throw and part left unchanged", () => {
  const base = tmpDir();
  const blocker = path.join(base, "not-a-dir");
  fs.writeFileSync(blocker, "x");
  const badDir = path.join(blocker, "sub"); // mkdir -> ENOTDIR
  const part = { type: "file", mime: "application/pdf", filename: "z.pdf", url: dataUri("application/pdf", 1_500_000) };
  const before = JSON.stringify(part);

  const res = boundAttachment(part, { spillDir: badDir });

  assert.equal(res.bounded, false, "no bound on write failure");
  assert.equal(res.reason, "write-failed");
  assert.equal(JSON.stringify(part), before, "part left unchanged when spill fails");
  assert.ok(typeof res.error === "string" && res.error.length > 0, "error recorded");
});

// ---------------------------------------------------------------------------
test("factory hooks are registered and never throw", async () => {
  const plugin = await AttachmentBound();
  assert.equal(typeof plugin["tool.execute.after"], "function");
  assert.equal(typeof plugin["chat.message"], "function");
  assert.equal(typeof plugin["experimental.chat.messages.transform"], "function");

  await assert.doesNotReject(() => plugin["tool.execute.after"]({}, undefined));
  await assert.doesNotReject(() => plugin["tool.execute.after"](null, undefined));
  await assert.doesNotReject(() => plugin["chat.message"]({}, undefined));
  await assert.doesNotReject(() => plugin["chat.message"]({}, { parts: [null, 5, {}, { type: "text" }] }));
  await assert.doesNotReject(() => plugin["experimental.chat.messages.transform"]({}, undefined));
  await assert.doesNotReject(() => plugin["experimental.chat.messages.transform"]({}, { messages: [null, 1] }));
});

// ---------------------------------------------------------------------------
test("chat.message hook bounds a file part IN PLACE (same object opencode persists)", async () => {
  const dir = tmpDir();
  const plugin = await AttachmentBound();
  const part = { type: "file", id: "prt_1", mime: "image/png", filename: "pasted", url: dataUri("image/png", 1_500_000) };

  await withEnv({ [ENV_ATTACHMENT_SPILL_DIR]: dir }, async () => {
    await plugin["chat.message"]({}, { message: {}, parts: [part] });
  });

  assert.equal(part.mime, "text/plain", "same object was mutated");
  assert.ok(part.url.startsWith("data:text/plain;base64,"), "url replaced");
  assert.ok(fs.readdirSync(dir).length === 1, "one spill file written");
});

// ---------------------------------------------------------------------------
test("tool.execute.after hook bounds output.attachments via env spill dir", async () => {
  const dir = tmpDir();
  const plugin = await AttachmentBound();
  const output = {
    title: "read",
    output: "PDF read successfully",
    metadata: {},
    attachments: [{ type: "file", mime: "application/pdf", filename: "x.pdf", url: dataUri("application/pdf", 1_500_000) }],
  };

  await withEnv({ [ENV_ATTACHMENT_SPILL_DIR]: dir }, async () => {
    await plugin["tool.execute.after"]({ tool: "read", callID: "call1" }, output);
  });

  assert.equal(output.attachments[0].mime, "text/plain", "attachment bounded");
  assert.ok(output.output.includes("[attachment-bound]"), "output noted");
  assert.ok(fs.readdirSync(dir).length === 1, "one spill file written");
});

// ---------------------------------------------------------------------------
test("importing the plugin has no side effects", () => {
  const base = tmpDir();
  const wouldBeDir = path.join(base, "should-not-exist");
  const code = `
    const fs = (await import("node:fs")).default;
    await import(${JSON.stringify(PLUGIN_URL)});
    process.exit(fs.existsSync(${JSON.stringify(wouldBeDir)}) ? 7 : 0);
  `;
  const r = spawnSync(
    process.execPath,
    ["--no-warnings", "--input-type=module", "--eval", code],
    { env: { ...process.env, [ENV_ATTACHMENT_SPILL_DIR]: wouldBeDir }, encoding: "utf8" },
  );
  assert.equal(r.status, 0, `fresh import must not create the spill dir: ${r.stderr}`);
  assert.equal(fs.existsSync(wouldBeDir), false, "spill dir not created at import");
});
