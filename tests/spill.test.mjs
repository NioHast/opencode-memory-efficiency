// Unit tests for the tool-output-spill plugin (todo 5).
//
// Run:
//   node --test --no-warnings ~/.config/opencode/tests/spill.test.mjs
//
// Node 24 auto-detects ESM in the plugin's `.js` (no package.json "type"), so
// `--no-warnings` suppresses the MODULE_TYPELESS_PACKAGE_JSON notice.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ToolOutputSpill,
  spillIfNeeded,
  buildPreview,
  buildPointer,
  safeByteSlice,
  sanitizeName,
  resolveMaxBytes,
  resolveSpillDir,
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_PREVIEW_BYTES,
  DEFAULT_PREVIEW_LINES,
  EXCLUDED_TOOLS,
} from "../plugins/tool-output-spill.js";

function tmpDir(prefix = "spill-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
test("500KB output is spilled: preview < 8000 bytes, file created, pointer present", () => {
  const dir = tmpDir();
  const big = "A".repeat(500 * 1024); // 512000 bytes, well over the 200000 cap
  const output = { title: "big", output: big, metadata: { tool: "bash" } };

  const res = spillIfNeeded(output, { tool: "bash", callID: "call-500k", spillDir: dir });

  assert.equal(res.spilled, true, "should spill");
  assert.ok(res.path && res.path.endsWith("call-500k.txt"), "path uses callID");
  assert.ok(fs.existsSync(res.path), "spill file created");
  assert.equal(fs.readFileSync(res.path, "utf8"), big, "full text persisted verbatim");
  assert.ok(
    Buffer.byteLength(output.output, "utf8") < DEFAULT_PREVIEW_BYTES,
    `preview bytes < ${DEFAULT_PREVIEW_BYTES} (got ${Buffer.byteLength(output.output, "utf8")})`,
  );
  assert.ok(output.output.includes("[... output truncated: full text at "), "pointer present");
  assert.ok(output.output.includes(res.path), "pointer names the spill file");
  const body = output.output.slice(output.output.indexOf("\n") + 1);
  assert.ok(body.startsWith("A") && body.length > 0, "preview still carries real content");
});

// ---------------------------------------------------------------------------
test("1KB output is byte-identical and nothing is written", () => {
  const dir = tmpDir();
  const small = "hello world ".repeat(80); // 960 bytes < 200000
  const output = { title: "small", output: small, metadata: { a: 1 } };
  const before = output.output;

  const res = spillIfNeeded(output, { tool: "read", callID: "c-small", spillDir: dir });

  assert.equal(res.spilled, false, "should not spill");
  assert.equal(res.reason, "under-cap");
  assert.equal(output.output, before, "output byte-identical");
  assert.deepEqual(fs.readdirSync(dir), [], "no spill files written");
});

// ---------------------------------------------------------------------------
test("output exactly at the threshold is unchanged", () => {
  const dir = tmpDir();
  const maxBytes = 1000;
  const exact = "a".repeat(maxBytes); // ASCII => exactly 1000 UTF-8 bytes
  const output = { output: exact };

  const res = spillIfNeeded(output, { tool: "bash", callID: "exact", spillDir: dir, maxBytes });

  assert.equal(Buffer.byteLength(exact, "utf8"), maxBytes, "sanity: exactly at cap");
  assert.equal(res.spilled, false, "at-cap is not over-cap");
  assert.equal(res.reason, "under-cap");
  assert.equal(output.output, exact, "unchanged");
  assert.deepEqual(fs.readdirSync(dir), [], "no spill file for at-cap");
});

// ---------------------------------------------------------------------------
test("excluded tools task/batch/compress are never touched", () => {
  const dir = tmpDir();
  const oversized = "X".repeat(300000);
  for (const tool of EXCLUDED_TOOLS) {
    const output = { output: oversized };
    const res = spillIfNeeded(output, { tool, callID: tool, spillDir: dir, maxBytes: 100 });
    assert.equal(res.spilled, false, `${tool} not spilled`);
    assert.equal(res.reason, "excluded", `${tool} reason`);
    assert.equal(output.output, oversized, `${tool} output unchanged`);
  }
  assert.deepEqual(fs.readdirSync(dir), [], "no spill files for excluded tools");
});

// ---------------------------------------------------------------------------
test("undefined / non-string output: no throw, object unchanged", () => {
  const dir = tmpDir();
  const o1 = { title: "t", metadata: {} }; // output undefined
  const r1 = spillIfNeeded(o1, { tool: "bash", callID: "u", spillDir: dir });
  assert.equal(r1.spilled, false);
  assert.equal(r1.reason, "non-string-output");
  assert.equal(o1.output, undefined, "undefined output left undefined");

  const o2 = { output: 12345 };
  const r2 = spillIfNeeded(o2, { tool: "bash", callID: "n", spillDir: dir });
  assert.equal(r2.spilled, false);
  assert.equal(o2.output, 12345, "numeric output left as-is");

  assert.doesNotThrow(() => spillIfNeeded(undefined, {}), "undefined output object");
  assert.doesNotThrow(() => spillIfNeeded(null, {}), "null output object");
  assert.deepEqual(fs.readdirSync(dir), [], "nothing written");
});

// ---------------------------------------------------------------------------
test("missing callID: no throw and a fallback filename is used", () => {
  const dir = tmpDir();
  const output = { output: "B".repeat(300000) };

  const res = spillIfNeeded(output, { tool: "bash", spillDir: dir, maxBytes: 1000 });

  assert.equal(res.spilled, true, "still spills without callID");
  assert.ok(res.path.endsWith(".txt"), "fallback name has .txt suffix");
  assert.ok(fs.existsSync(res.path), "fallback spill file created");
  assert.equal(fs.readdirSync(dir).length, 1, "exactly one spill file");
  const stem = path.basename(res.path, ".txt");
  assert.ok(stem.length > 0, "fallback stem is non-empty");
});

// ---------------------------------------------------------------------------
test("unwritable SPILL_DIR: no throw and output unchanged", () => {
  const base = tmpDir();
  const blocker = path.join(base, "not-a-dir");
  fs.writeFileSync(blocker, "x");
  const badDir = path.join(blocker, "sub"); // mkdir ENOTDIR
  const output = { output: "C".repeat(300000) };
  const before = output.output;

  const res = spillIfNeeded(output, { tool: "bash", callID: "unwritable", spillDir: badDir, maxBytes: 1000 });

  assert.equal(res.spilled, false, "no spill on write failure");
  assert.equal(res.reason, "write-failed");
  assert.equal(output.output, before, "output left unchanged when spill fails");
  assert.ok(typeof res.error === "string" && res.error.length > 0, "error recorded");
});

// ---------------------------------------------------------------------------
test("safeByteSlice never splits a multibyte char and respects the cap", () => {
  const accented = "é".repeat(5000); // 2 bytes each => 10000 bytes
  const sliced = safeByteSlice(accented, 8000);
  assert.ok(Buffer.byteLength(sliced, "utf8") <= 8000, "byte cap respected");
  assert.equal(Buffer.byteLength(sliced, "utf8") % 2, 0, "no half of a 2-byte char");
  assert.ok(!sliced.includes("\uFFFD"), "no replacement char (no split)");
  assert.equal(sliced, "é".repeat(4000), "exactly 4000 whole chars");

  const emoji = "😀".repeat(3000); // surrogate pair => 4 bytes each
  const es = safeByteSlice(emoji, 8001);
  assert.ok(Buffer.byteLength(es, "utf8") <= 8001, "emoji byte cap respected");
  assert.equal(es, "😀".repeat(2000), "whole surrogate pairs only");

  assert.equal(safeByteSlice("abc", 0), "", "zero budget -> empty");
  assert.equal(safeByteSlice("abc", 10), "abc", "already under cap -> unchanged");
});

// ---------------------------------------------------------------------------
test("buildPreview caps to first 200 lines and 8000 bytes", () => {
  const many = Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n");
  const preview = buildPreview(many, { previewLines: DEFAULT_PREVIEW_LINES, previewBytes: 100000 });
  assert.equal(preview.split("\n").length, DEFAULT_PREVIEW_LINES, "line cap honours 200");
  assert.ok(!preview.includes("line 299"), "tail lines dropped");

  const longLine = "z".repeat(50000);
  const bytesCapped = buildPreview(longLine, { previewLines: 200, previewBytes: 8000 });
  assert.equal(Buffer.byteLength(bytesCapped, "utf8"), 8000, "byte cap exactly 8000 here");

  assert.equal(buildPointer("/tmp/x.txt").includes("/tmp/x.txt"), true, "pointer names path");
});

// ---------------------------------------------------------------------------
test("factory returns a tool.execute.after hook that never throws", async () => {
  const plugin = await ToolOutputSpill();
  assert.equal(typeof plugin["tool.execute.after"], "function", "hook registered");

  await assert.doesNotReject(() => plugin["tool.execute.after"]({}, undefined));
  await assert.doesNotReject(() => plugin["tool.execute.after"](null, undefined));
  await assert.doesNotReject(() => plugin["tool.execute.after"]({ tool: "bash" }, { output: 42 }));

  const dir = tmpDir();
  const prevDir = process.env.SPILL_DIR;
  const prevMax = process.env.SPILL_MAX_BYTES;
  process.env.SPILL_DIR = dir;
  process.env.SPILL_MAX_BYTES = "1000";
  try {
    const output = { title: "hook", output: "Z".repeat(5000), metadata: {} };
    await plugin["tool.execute.after"]({ tool: "bash", callID: "hook1" }, output);
    assert.ok(
      Buffer.byteLength(output.output, "utf8") < DEFAULT_PREVIEW_BYTES,
      "hook preview is bounded",
    );
    assert.ok(fs.existsSync(path.join(dir, "hook1.txt")), "hook honoured SPILL_DIR/SPILL_MAX_BYTES");
  } finally {
    if (prevDir === undefined) delete process.env.SPILL_DIR;
    else process.env.SPILL_DIR = prevDir;
    if (prevMax === undefined) delete process.env.SPILL_MAX_BYTES;
    else process.env.SPILL_MAX_BYTES = prevMax;
  }
});

// ---------------------------------------------------------------------------
test("constants + resolvers honour opts and env", () => {
  assert.equal(DEFAULT_MAX_OUTPUT_BYTES, 200000);
  assert.equal(DEFAULT_PREVIEW_BYTES, 8000);
  assert.equal(DEFAULT_PREVIEW_LINES, 200);
  assert.deepEqual([...EXCLUDED_TOOLS].sort(), ["batch", "compress", "task"]);
  assert.equal(resolveMaxBytes({ maxBytes: 5 }), 5);

  const dir = tmpDir();
  assert.equal(resolveSpillDir({ spillDir: dir }), dir);
  assert.ok(sanitizeName("../../etc/passwd").indexOf("/") === -1, "path separators sanitized");
});
