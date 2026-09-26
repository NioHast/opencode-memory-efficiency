// ~/.config/opencode/tests/plugins.unit.test.mjs
// ---------------------------------------------------------------------------
// SINGLE ENTRYPOINT suite for the pure plugin helpers (plan todo 14,
// opencode-memory-efficiency).
//
// Run:
//   node --test --no-warnings ~/.config/opencode/tests/plugins.unit.test.mjs
//
// Covers:
//   * tool-output-spill   (todo 5)   -- oversized -> preview + spill + pointer
//   * summary-diff-cap    (todo 6)   -- per-file/total cap + vendor drop
//   * context-governor    (todo 8)   -- placeholders / dedupe-latest /
//                                       purge-error-input (keep error text) /
//                                       explicit supersession /
//                                       NEVER drop an active (running) call /
//                                       >= 40% byte reduction on the crafted array
//   * compaction-handoff  (todo 9)   -- all 8 required sections + verbatim last message
//   * attachment-bound    (todo 22)  -- oversized attachment previewed + spilled
//   * milestone-note      (todo 10)  -- append-only bounded block + fresh-session inject
//
// Deterministic and hermetic: NO live DB, NO network, NO model call. Every
// filesystem write goes to a fresh os.tmpdir() directory (passed via opts or a
// temp option path), and every temp dir is removed in the final `after` hook.
// ---------------------------------------------------------------------------

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Assertion / test counters so we can print a total summary at the end.
// ---------------------------------------------------------------------------
let assertionCount = 0;
let testCount = 0;

// Wrap node:assert so every method call bumps the assertion counter. `assert`
// method functions do not rely on `this`, so a plain forwarding proxy works.
const A = new Proxy(assert, {
  get(target, prop) {
    const value = target[prop];
    if (typeof value === "function") {
      return (...args) => {
        assertionCount += 1;
        return value.apply(target, args);
      };
    }
    return value;
  },
});

// Wrap `test` so we can report how many test cases were registered.
const it = (name, fn) => {
  testCount += 1;
  return test(name, fn);
};

const tmpDirs = [];
function mkTmp(prefix = "plugins-unit-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

after(() => {
  let removed = 0;
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      removed += 1;
    } catch {
      /* best effort */
    }
  }
  console.log(
    `\n[plugins.unit] SUMMARY total_tests=${testCount} total_assertions=${assertionCount} temp_dirs_removed=${removed}`,
  );
});

const clone = (value) => JSON.parse(JSON.stringify(value));
const serializedBytes = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");
const byteLength = (value) => Buffer.byteLength(typeof value === "string" ? value : String(value ?? ""), "utf8");

// ---------------------------------------------------------------------------
// Imports — pure helpers from the plugin modules (relative paths, Node 24 ESM).
// ---------------------------------------------------------------------------

import {
  ToolOutputSpill,
  spillIfNeeded,
  buildPreview,
  buildPointer,
  safeByteSlice as spillSafeByteSlice,
  sanitizeName as spillSanitizeName,
  resolveMaxBytes,
  resolveSpillDir,
  resolvePreviewBytes,
  resolvePreviewLines,
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_PREVIEW_BYTES,
  DEFAULT_PREVIEW_LINES,
  EXCLUDED_TOOLS,
} from "../plugins/tool-output-spill.js";

import {
  SummaryDiffCap,
  capDiffs,
  isVendorPath,
} from "../plugins/summary-diff-cap.js";

import {
  ContextGovernor,
  resetWatermarks,
  getWatermark,
  detectCompactionMarkerIndex,
  transformMessages,
  applyPlaceholders,
  dedupeCalls,
  purgeErrorInputs,
  applySupersession,
  makePlaceholder,
  PROTECTED_TOOLS,
  PLACEHOLDER_BYTES,
  PURGE_ERROR_TURNS,
} from "../plugins/context-governor.js";

import {
  CompactionHandoff,
  HOOK_NAME as COMPACTION_HOOK_NAME,
  HANDOFF_SECTIONS,
  MAX_TEMPLATE_BYTES,
  buildHandoffPrompt,
  extractLastUserMessage,
  normalizeContext,
} from "../plugins/compaction-handoff.js";

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
  safeByteSlice as attachmentSafeByteSlice,
  sanitizeName as attachmentSanitizeName,
  DEFAULT_MAX_ATTACHMENT_BYTES,
  DEFAULT_ATTACHMENT_PREVIEW_BYTES,
} from "../plugins/attachment-bound.js";

import MilestoneNoteDefault, {
  MilestoneNote,
  buildStateBlock,
  appendNote,
  readNoteBlock,
  buildStateFromEvent,
  isWithin,
  isFreshSession,
  resetSeenSessions,
  STATE_MARKER_START,
  STATE_MARKER_END,
  MAX_BLOCK_BYTES,
  MAX_INJECT_BYTES,
  NOTE_RELATIVE_PATH,
} from "../plugins/milestone-note.js";

// ===========================================================================
// SECTION 1 — tool-output-spill (todo 5)
// ===========================================================================

it("spill: oversized (500KB) output -> bounded preview + spill file + pointer", () => {
  const dir = mkTmp("spill-unit-");
  const big = "A".repeat(500 * 1024);
  const output = { title: "big", output: big, metadata: { tool: "bash" } };

  const res = spillIfNeeded(output, { tool: "bash", callID: "big-call", spillDir: dir });

  A.equal(res.spilled, true, "500KB must spill");
  A.equal(res.bytesIn, byteLength(big));
  A.ok(res.path.endsWith("big-call.txt"), "spill file is named after callID");
  A.ok(fs.existsSync(res.path), "spill file exists");
  A.equal(fs.readFileSync(res.path, "utf8"), big, "full text persisted verbatim");
  A.ok(byteLength(output.output) < DEFAULT_PREVIEW_BYTES, "preview stays under 8000 bytes");
  A.ok(output.output.includes(buildPointer(res.path).slice(0, 20)), "pointer present");
  A.ok(output.output.includes(res.path), "pointer names the file");
  A.ok(res.bytesOut < DEFAULT_PREVIEW_BYTES);
});

it("spill: under-cap output is byte-identical and writes nothing", () => {
  const dir = mkTmp("spill-unit-");
  const small = "hello world ".repeat(80); // 960 bytes
  const output = { output: small };
  const res = spillIfNeeded(output, { tool: "read", callID: "small-call", spillDir: dir });

  A.equal(res.spilled, false);
  A.equal(res.reason, "under-cap");
  A.equal(output.output, small, "output byte-identical");
  A.deepEqual(fs.readdirSync(dir), [], "no files written");
});

it("spill: at-cap output is unchanged (strictly-over trigger)", () => {
  const dir = mkTmp("spill-unit-");
  const cap = 1000;
  const exact = "a".repeat(cap);
  const output = { output: exact };
  const res = spillIfNeeded(output, { tool: "bash", callID: "exact", spillDir: dir, maxBytes: cap });

  A.equal(byteLength(exact), cap);
  A.equal(res.spilled, false, "at-cap is not over-cap");
  A.equal(output.output, exact);
  A.deepEqual(fs.readdirSync(dir), []);
});

it("spill: excluded tools task/batch/compress are never touched", () => {
  const dir = mkTmp("spill-unit-");
  const oversized = "X".repeat(300000);
  for (const tool of EXCLUDED_TOOLS) {
    const output = { output: oversized };
    const res = spillIfNeeded(output, { tool, callID: tool, spillDir: dir, maxBytes: 100 });
    A.equal(res.spilled, false, `${tool} not spilled`);
    A.equal(res.reason, "excluded");
    A.equal(output.output, oversized);
  }
  A.deepEqual(fs.readdirSync(dir), [], "no spill files for excluded tools");
});

it("spill: undefined/non-string output never throws and stays unchanged", () => {
  const dir = mkTmp("spill-unit-");
  const a = spillIfNeeded(undefined, { spillDir: dir });
  const b = spillIfNeeded(null, { spillDir: dir });
  const c = spillIfNeeded({ output: 12345 }, { spillDir: dir });
  A.equal(a.spilled, false);
  A.equal(b.spilled, false);
  A.equal(c.spilled, false);
  A.equal(c.reason, "non-string-output");
  A.deepEqual(fs.readdirSync(dir), []);
});

it("spill: safeByteSlice is multibyte-safe; buildPreview honours caps", () => {
  const accented = "é".repeat(5000); // 2 bytes each
  const sliced = spillSafeByteSlice(accented, 8000);
  A.ok(byteLength(sliced) <= 8000);
  A.ok(!sliced.includes("\uFFFD"), "no split multibyte char");
  A.equal(sliced, "é".repeat(4000));

  const many = Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n");
  const preview = buildPreview(many, { previewLines: DEFAULT_PREVIEW_LINES, previewBytes: 100000 });
  A.equal(preview.split("\n").length, DEFAULT_PREVIEW_LINES);
  A.ok(!preview.includes("line 299"));

  A.equal(spillSanitizeName("../../etc/passwd").includes("/"), false);
  A.equal(DEFAULT_MAX_OUTPUT_BYTES, 200000);
  A.equal(DEFAULT_PREVIEW_BYTES, 8000);
  A.equal(resolveMaxBytes({ maxBytes: 5 }), 5);
  A.equal(resolvePreviewBytes({ previewBytes: 9 }), 9);
  A.equal(resolvePreviewLines({ previewLines: 3 }), 3);
  A.equal(resolveSpillDir({ spillDir: "/x" }), "/x");
});

it("spill: factory hook never throws and bounds oversized output", async () => {
  const dir = mkTmp("spill-unit-");
  const plugin = await ToolOutputSpill();
  A.equal(typeof plugin["tool.execute.after"], "function");
  await assert.doesNotReject(() => plugin["tool.execute.after"]({}, undefined));
  await assert.doesNotReject(() => plugin["tool.execute.after"](null, undefined));

  const prevDir = process.env.SPILL_DIR;
  const prevMax = process.env.SPILL_MAX_BYTES;
  process.env.SPILL_DIR = dir;
  process.env.SPILL_MAX_BYTES = "1000";
  try {
    const output = { output: "Z".repeat(5000) };
    await plugin["tool.execute.after"]({ tool: "bash", callID: "hook-x" }, output);
    A.ok(byteLength(output.output) < DEFAULT_PREVIEW_BYTES);
    A.ok(fs.existsSync(path.join(dir, "hook-x.txt")));
  } finally {
    if (prevDir === undefined) delete process.env.SPILL_DIR;
    else process.env.SPILL_DIR = prevDir;
    if (prevMax === undefined) delete process.env.SPILL_MAX_BYTES;
    else process.env.SPILL_MAX_BYTES = prevMax;
  }
});

// ===========================================================================
// SECTION 2 — summary-diff-cap (todo 6)
// ===========================================================================

const DIFF_MAX_PATCH = 64 * 1024;
const DIFF_MAX_TOTAL = 512 * 1024;
const DIFF_MARKER = "[... truncated ...]";

function makeDiffMessage(diffs, infoExtra = {}) {
  return { info: { role: "assistant", summary: { diffs }, ...infoExtra }, parts: [] };
}
function diffPatchBytes(entry) {
  return byteLength(entry.patch ?? "");
}
function diffTotalBytes(diffs) {
  return diffs.reduce((sum, d) => sum + diffPatchBytes(d), 0);
}

it("diffcap: 5MB single patch -> per-file <=64KB and total <=512KB, metadata survives", () => {
  const huge = "a".repeat(5 * 1024 * 1024);
  const msg = makeDiffMessage([
    { file: "src/big.js", patch: huge, additions: 10, deletions: 4, status: "modified" },
  ]);
  const returned = capDiffs(msg);
  A.equal(returned, msg, "same object returned");
  const diffs = msg.info.summary.diffs;
  A.equal(Array.isArray(diffs), true, "array preserved");
  A.equal(diffs.length, 1, "entry retained");
  A.ok(diffPatchBytes(diffs[0]) <= DIFF_MAX_PATCH, "per-file <= 64KB");
  A.ok(diffTotalBytes(diffs) <= DIFF_MAX_TOTAL, "total <= 512KB");
  A.ok(diffs[0].patch.endsWith(DIFF_MARKER), "truncation marker appended");
  A.deepEqual(
    { file: diffs[0].file, status: diffs[0].status, additions: diffs[0].additions, deletions: diffs[0].deletions },
    { file: "src/big.js", status: "modified", additions: 10, deletions: 4 },
  );
});

it("diffcap: total cap drops lowest-priority entries, keeps earliest", () => {
  const one = "x".repeat(DIFF_MAX_PATCH);
  const diffs = Array.from({ length: 10 }, (_, i) => ({
    file: `src/file-${i}.js`,
    patch: one,
    additions: i,
    deletions: 0,
    status: "modified",
  }));
  const msg = makeDiffMessage(diffs);
  capDiffs(msg);
  const out = msg.info.summary.diffs;
  A.ok(diffTotalBytes(out) <= DIFF_MAX_TOTAL);
  A.equal(out.length, 8, "8 x 64KB = 512KB retained");
  A.equal(out[0].file, "src/file-0.js");
  A.equal(out[7].file, "src/file-7.js");
});

it("diffcap: vendor/generated paths removed entirely, legit entries kept", () => {
  const msg = makeDiffMessage([
    { file: "src/keep.js", patch: "ok", additions: 1, deletions: 0, status: "added" },
    { file: "node_modules/pkg/index.js", patch: "v", additions: 1, deletions: 0, status: "modified" },
    { file: "web/.next/chunk.js", patch: "v", additions: 1, deletions: 0, status: "modified" },
    { file: "app/dist/main.js", patch: "v", additions: 1, deletions: 0, status: "modified" },
    { file: "backend/.venv/lib/x.py", patch: "v", additions: 1, deletions: 0, status: "modified" },
    { file: "pkg/__pycache__/mod.pyc", patch: "v", additions: 1, deletions: 0, status: "modified" },
    { file: "src/keep2.jsx", patch: "ok2", additions: 2, deletions: 0, status: "added" },
  ]);
  capDiffs(msg);
  const out = msg.info.summary.diffs;
  A.equal(Array.isArray(out), true);
  A.equal(out.length, 2, "only legit entries survive");
  A.deepEqual(out.map((d) => d.file), ["src/keep.js", "src/keep2.jsx"]);
  for (const d of out) A.equal(isVendorPath(d.file), false);

  // Predicate sanity: whole-segment matching only.
  A.equal(isVendorPath("redistribute.js"), false);
  A.equal(isVendorPath("builders/index.ts"), false);
  A.equal(isVendorPath("C:\\proj\\node_modules\\x.js"), true);
  A.equal(isVendorPath(null), false);
});

it("diffcap: small message byte-identical; malformed payloads untouched, no throw", () => {
  const small = makeDiffMessage([
    { file: "src/a.js", patch: "+a\n", additions: 1, deletions: 0, status: "added" },
    { file: "src/b.js", patch: "-b\n+c\n", additions: 1, deletions: 1, status: "modified" },
  ]);
  const before = JSON.stringify(small);
  A.equal(capDiffs(small), small);
  A.equal(JSON.stringify(small), before, "small message unchanged");

  const nonArray = makeDiffMessage([]);
  nonArray.info.summary.diffs = "not-an-array";
  const nonArrayBefore = JSON.stringify(nonArray);
  A.doesNotThrow(() => capDiffs(nonArray));
  A.equal(JSON.stringify(nonArray), nonArrayBefore, "non-array untouched");

  const missingPatch = makeDiffMessage([{ file: "src/x.js", status: "modified", additions: 2, deletions: 1 }]);
  const mpBefore = JSON.stringify(missingPatch);
  A.doesNotThrow(() => capDiffs(missingPatch));
  A.equal(JSON.stringify(missingPatch), mpBefore, "missing patch untouched");

  const nullFile = makeDiffMessage([{ file: null, patch: "+x", additions: 1, deletions: 0, status: "modified" }]);
  const nfBefore = JSON.stringify(nullFile);
  A.doesNotThrow(() => capDiffs(nullFile));
  A.equal(JSON.stringify(nullFile), nfBefore, "null file untouched");

  const noSummary = { info: { role: "user" }, parts: [] };
  const nsBefore = JSON.stringify(noSummary);
  A.doesNotThrow(() => capDiffs(noSummary));
  A.equal(JSON.stringify(noSummary), nsBefore);
  A.equal(capDiffs(undefined), undefined);
});

it("diffcap: env overrides + UTF-8 byte-safe truncation", () => {
  const prevPatch = process.env.DIFF_MAX_PATCH_BYTES;
  const prevTotal = process.env.DIFF_MAX_TOTAL_BYTES;
  try {
    process.env.DIFF_MAX_PATCH_BYTES = "1024";
    process.env.DIFF_MAX_TOTAL_BYTES = "2048";
    const msg = makeDiffMessage([
      { file: "src/e1.js", patch: "q".repeat(5 * 1024), additions: 1, deletions: 0, status: "added" },
      { file: "src/e2.js", patch: "q".repeat(5 * 1024), additions: 1, deletions: 0, status: "added" },
    ]);
    capDiffs(msg);
    const out = msg.info.summary.diffs;
    for (const d of out) A.ok(diffPatchBytes(d) <= 1024, "env per-file cap honoured");
    A.ok(diffTotalBytes(out) <= 2048, "env total cap honoured");
    A.equal(out.length, 2);
  } finally {
    if (prevPatch === undefined) delete process.env.DIFF_MAX_PATCH_BYTES;
    else process.env.DIFF_MAX_PATCH_BYTES = prevPatch;
    if (prevTotal === undefined) delete process.env.DIFF_MAX_TOTAL_BYTES;
    else process.env.DIFF_MAX_TOTAL_BYTES = prevTotal;
  }

  const multibyte = "é".repeat(200 * 1024); // 2 bytes each
  const uni = makeDiffMessage([
    { file: "src/uni.js", patch: multibyte, additions: 1, deletions: 0, status: "added" },
  ]);
  capDiffs(uni, { maxPatchBytes: 100 });
  const outPatch = uni.info.summary.diffs[0].patch;
  A.ok(byteLength(outPatch) <= 100);
  A.equal(outPatch.includes("\uFFFD"), false, "no split code point");
  A.ok(outPatch.endsWith(DIFF_MARKER));
});

it("diffcap: factory hook caps in place and never reorders/removes messages", async () => {
  const plugin = await SummaryDiffCap();
  const hook = plugin["experimental.chat.messages.transform"];
  A.equal(typeof hook, "function");
  await A.doesNotReject(() => hook({}, {}));
  await A.doesNotReject(() => hook({}, { messages: "not-an-array" }));

  const huge = "z".repeat(5 * 1024 * 1024);
  const m1 = makeDiffMessage([
    { file: "src/one.js", patch: huge, additions: 1, deletions: 0, status: "added" },
    { file: "node_modules/drop.js", patch: "v", additions: 1, deletions: 0, status: "added" },
  ]);
  const m2 = { info: { role: "user" }, parts: [] };
  const m3 = makeDiffMessage([{ file: "src/two.js", patch: "small", additions: 1, deletions: 0, status: "added" }]);
  const output = { messages: [m1, m2, m3] };
  await hook({}, output);

  A.equal(output.messages.length, 3, "message count unchanged");
  A.equal(output.messages[0], m1);
  A.equal(output.messages[2], m3);
  A.equal(m1.info.summary.diffs.length, 1);
  A.ok(diffPatchBytes(m1.info.summary.diffs[0]) <= DIFF_MAX_PATCH);
  A.deepEqual(m3.info.summary.diffs.map((d) => d.file), ["src/two.js"]);
});

// ===========================================================================
// SECTION 3 — context-governor (todo 8): the plan's required cases
// ===========================================================================

const GSESSION = "ses_plugins_unit_governor";

function gTextPart(id, messageID, text, metadata) {
  const part = { id, sessionID: GSESSION, messageID, type: "text", text };
  if (metadata) part.metadata = metadata;
  return part;
}

function gToolPart({ id, callID, tool, status = "completed", input = {}, output, error, metadata }) {
  const state = { status };
  if (status === "error") {
    state.input = input;
    state.error = error;
    state.time = { start: 1, end: 2 };
  } else if (status === "running" || status === "pending") {
    state.input = input;
    state.time = { start: 1 };
  } else {
    state.input = input;
    state.output = output;
    state.title = tool;
    state.metadata = {};
    state.time = { start: 1, end: 2 };
  }
  if (metadata) state.metadata = { ...state.metadata, ...metadata };
  return { id, sessionID: GSESSION, messageID: `msg_${id}`, type: "tool", callID, tool, state };
}

function gMessage(id, role, parts, extras = {}) {
  return { info: { id, sessionID: GSESSION, role, time: { created: 1 }, ...extras }, parts };
}

// 7 user turns with a compaction marker at index 10 (watermark = 10).
function craftGovernorArray() {
  const errorInput = { command: "deploy --now " + "x".repeat(6000) };
  const duplicateInput = { filePath: "/dup.txt" };
  const duplicateOutput = "D".repeat(500);

  return [
    gMessage("m0", "user", [gTextPart("t0", "m0", "start")]),
    gMessage("m1", "assistant", [
      gToolPart({ id: "p1", callID: "readA", tool: "read", input: { filePath: "/a.txt" }, output: "A".repeat(40000) }),
    ]),
    gMessage("m2", "user", [gTextPart("t2", "m2", "retry")]),
    gMessage("m3", "assistant", [
      gToolPart({ id: "p3", callID: "err1", tool: "bash", status: "error", input: errorInput, error: "Exit code 1: deploy failed" }),
    ]),
    gMessage("m4", "user", [gTextPart("t4", "m4", "did the retry work?")]),
    gMessage("m5", "assistant", [
      gToolPart({ id: "p5", callID: "err1-ok", tool: "bash", input: clone(errorInput), output: "ok" }),
    ]),
    gMessage("m6", "user", [gTextPart("t6", "m6", "decide")]),
    gMessage("m7", "assistant", [
      gTextPart("textA", "m7", "decision: use plan X", { supersededBy: "textB" }),
    ]),
    gMessage("m8", "user", [gTextPart("t8", "m8", "confirm")]),
    gMessage("m9", "assistant", [gTextPart("textB", "m9", "decision: use plan Y (current)")]),
    // Compaction marker at index 10.
    gMessage("m10", "assistant", [
      { id: "cmp", sessionID: GSESSION, messageID: "m10", type: "compaction", auto: true },
    ], { summary: true }),
    gMessage("m11", "user", [gTextPart("t11", "m11", "continue")]),
    gMessage("m12", "assistant", [
      gToolPart({ id: "p12", callID: "dup1", tool: "read", input: clone(duplicateInput), output: duplicateOutput }),
    ]),
    gMessage("m13", "assistant", [
      gToolPart({ id: "p13", callID: "dup2", tool: "read", input: clone(duplicateInput), output: duplicateOutput + "EXTRA" }),
    ]),
    gMessage("m14", "assistant", [
      gToolPart({ id: "run1", callID: "run1", tool: "bash", status: "running", input: { command: "tail -f log" } }),
    ]),
    gMessage("m15", "user", [gTextPart("t15", "m15", "end")]),
  ];
}

function gGetTool(messages, callID) {
  for (const m of messages) for (const p of m.parts) if (p.type === "tool" && p.callID === callID) return p;
  return undefined;
}
function gGetPart(messages, id) {
  for (const m of messages) for (const p of m.parts) if (p.id === id) return p;
  return undefined;
}

it("governor: crafted 7-turn array -- placeholders + dedupe-latest + error purge + supersession + running untouched + >=40% reduction", () => {
  resetWatermarks();
  const original = craftGovernorArray();
  const before = serializedBytes(original);

  const transformed = transformMessages(clone(original));
  const after = serializedBytes(transformed);

  A.equal(detectCompactionMarkerIndex(original), 10, "marker detected at index 10");
  A.equal(getWatermark(GSESSION), 10, "monotonic watermark = 10");

  // (1) OLD output below the watermark -> 1-line placeholder.
  const readA = gGetTool(transformed, "readA");
  A.match(readA.state.output, /^\[governor\] read output elided \(\d+ bytes\)$/);
  A.equal(readA.state.output.split("\n").length, 1, "placeholder is a single line");

  // (2) duplicate -> LATEST kept, earlier collapsed.
  const dup1 = gGetTool(transformed, "dup1");
  const dup2 = gGetTool(transformed, "dup2");
  A.equal(dup1.state.output, "[governor] duplicate read call elided (latest kept)");
  A.equal(dup2.state.output, "D".repeat(500) + "EXTRA", "latest duplicate result kept full");

  // (3) resolved error input purged BUT the error text is kept.
  const err = gGetTool(transformed, "err1");
  A.deepEqual(err.state.input, {}, "errored call input purged");
  A.equal(err.state.error, "Exit code 1: deploy failed", "error text preserved");
  A.equal(err.state.metadata.governor.inputPurged, true);

  // (4) explicit supersession: exactly one live decision remains.
  const superseded = gGetPart(transformed, "textA");
  const current = gGetPart(transformed, "textB");
  A.equal(superseded.text, "[governor] superseded by textB (current state kept)");
  A.equal(current.text, "decision: use plan Y (current)");
  const live = transformed
    .flatMap((m) => m.parts)
    .filter((p) => p.type === "text" && p.text.startsWith("decision:") && !p.text.startsWith("[governor]"));
  A.equal(live.length, 1, "a single current-state decision remains");

  // (5) NEVER-DROP-ACTIVE: the running call is byte-identical.
  A.deepEqual(gGetTool(transformed, "run1"), gGetTool(original, "run1"));

  // (6) >= 40% byte reduction on the crafted array.
  A.ok(after < before, `expected shrink: before=${before} after=${after}`);
  const reduction = 1 - after / before;
  A.ok(reduction >= 0.4, `expected >=40% reduction, got ${(reduction * 100).toFixed(1)}%`);

  // Env-configurable defaults are exposed.
  A.equal(PLACEHOLDER_BYTES, 8000);
  A.equal(PURGE_ERROR_TURNS, 4);
  A.ok(PROTECTED_TOOLS.has("write"));
  A.ok(PROTECTED_TOOLS.has("edit"));
  A.ok(PROTECTED_TOOLS.has("todowrite"));
  A.ok(PROTECTED_TOOLS.has("task"));
});

it("governor NEVER-DROP-ACTIVE invariant: only running/pending items -> byte-identical", () => {
  resetWatermarks();
  const active = [
    gMessage("a0", "user", [gTextPart("at0", "a0", "still working")]),
    gMessage("a1", "assistant", [
      gToolPart({ id: "runA", callID: "runA", tool: "bash", status: "running", input: { command: "sleep 100" } }),
    ]),
    gMessage("a2", "assistant", [
      gToolPart({ id: "pendA", callID: "pendA", tool: "read", status: "pending", input: { filePath: "/big.txt" } }),
    ]),
  ];
  const snapshot = clone(active);
  const result = transformMessages(active);
  A.deepEqual(result, snapshot);
  A.equal(serializedBytes(result), serializedBytes(snapshot));
});

it("governor: prefix-stable between compactions (same earlier bytes + newer turns)", () => {
  resetWatermarks();
  const base = craftGovernorArray();
  const first = transformMessages(clone(base));
  const prefixFromFirst = serializedBytes(first.slice(0, base.length));

  const newer = [
    gMessage("m16", "user", [gTextPart("t16", "m16", "one more question")]),
    gMessage("m17", "assistant", [gTextPart("t17", "m17", "here is the answer")]),
    gMessage("m18", "user", [gTextPart("t18", "m18", "thanks")]),
  ];
  const second = transformMessages([...clone(base), ...clone(newer)]);
  const prefixFromSecond = serializedBytes(second.slice(0, base.length));

  A.equal(prefixFromSecond, prefixFromFirst, "earlier prefix byte-identical");
  A.equal(getWatermark(GSESSION), 10, "watermark did not follow the tail");
});

it("governor: PROTECTED tools untouched even when huge and below the watermark", () => {
  resetWatermarks();
  const session = "ses_plugins_unit_protected";
  const huge = "Z".repeat(50000);
  const partsFor = (id, callID, tool) => ({
    ...gToolPart({ id, callID, tool, input: { filePath: "/x" }, output: huge }),
    sessionID: session,
  });
  const array = [
    { info: { id: "p0", sessionID: session, role: "assistant" }, parts: [partsFor("w1", "w1", "write")] },
    { info: { id: "p1", sessionID: session, role: "assistant" }, parts: [partsFor("e1", "e1", "edit")] },
    { info: { id: "p2", sessionID: session, role: "assistant" }, parts: [partsFor("td1", "td1", "todowrite")] },
    { info: { id: "p3", sessionID: session, role: "assistant" }, parts: [partsFor("tk1", "tk1", "task")] },
    { info: { id: "p4", sessionID: session, role: "assistant", summary: true }, parts: [{ id: "cmp2", sessionID: session, messageID: "p4", type: "compaction", auto: true }] },
  ];
  const snapshot = clone(array);
  transformMessages(array);
  A.deepEqual(array, snapshot, "protected tools byte-identical");
});

it("governor: rule gates -- spill pointer, non-superset dedupe refusal, purge age gate, explicit supersession only", () => {
  // applyPlaceholders appends a spill pointer when the callID spill file exists.
  const array = [
    gMessage("s0", "assistant", [
      gToolPart({ id: "sp1", callID: "spillcall", tool: "read", input: { filePath: "/s" }, output: "hello world" }),
    ]),
  ];
  applyPlaceholders(array, 0, { placeholderBytes: 1, spillDir: "/spill", fileExists: () => true });
  A.equal(array[0].parts[0].state.output, makePlaceholder("read", 11, "/spill/spillcall.txt"));
  A.match(array[0].parts[0].state.output, /full: \/spill\/spillcall\.txt$/);

  // dedupe refuses to collapse when the later result is not a superset (non-stateless).
  const dedupe = [
    gMessage("d0", "assistant", [gToolPart({ id: "d1", callID: "d1", tool: "bash", input: { command: "x" }, output: "first-result" })]),
    gMessage("d1", "assistant", [gToolPart({ id: "d2", callID: "d2", tool: "bash", input: { command: "x" }, output: "second-different" })]),
  ];
  dedupeCalls(dedupe, 0);
  A.equal(gGetTool(dedupe, "d1").state.output, "first-result");
  A.equal(gGetTool(dedupe, "d2").state.output, "second-different");

  // purgeErrorInputs requires resolution AND age below the watermark.
  const mk = () => [
    gMessage("q0", "assistant", [gToolPart({ id: "qe", callID: "qe", tool: "bash", status: "error", input: { command: "boom" }, error: "failed" })]),
  ];
  const unresolved = mk();
  purgeErrorInputs(unresolved, 10);
  A.deepEqual(gGetTool(unresolved, "qe").state.input, { command: "boom" }, "unresolved untouched");
  const young = mk();
  purgeErrorInputs(young, 2);
  A.deepEqual(gGetTool(young, "qe").state.input, { command: "boom" }, "too young untouched");
  const resolved = [
    ...mk(),
    gMessage("q1", "assistant", [gToolPart({ id: "qo", callID: "qo", tool: "bash", input: { command: "boom" }, output: "ok" })]),
  ];
  purgeErrorInputs(resolved, 10);
  A.deepEqual(gGetTool(resolved, "qe").state.input, {});
  A.equal(gGetTool(resolved, "qe").state.error, "failed");

  // applySupersession honours only explicit same-session newer tags.
  const sup = [
    gMessage("x0", "assistant", [gTextPart("old", "x0", "old decision", { supersededBy: "new" })]),
    gMessage("x1", "assistant", [gTextPart("new", "x1", "new decision")]),
    gMessage("x2", "assistant", [gTextPart("dangling", "x2", "dangling", { supersededBy: "ghost" })]),
    gMessage("x3", "assistant", [gTextPart("backwards", "x3", "backwards", { supersededBy: "old" })]),
  ];
  applySupersession(sup, 0);
  A.equal(gGetPart(sup, "old").text, "[governor] superseded by new (current state kept)");
  A.equal(gGetPart(sup, "new").text, "new decision");
  A.equal(gGetPart(sup, "dangling").text, "dangling");
  A.equal(gGetPart(sup, "backwards").text, "backwards");
});

it("governor: malformed input never throws and hook is safe", async () => {
  resetWatermarks();
  const hook = await ContextGovernor();
  const transform = hook["experimental.chat.messages.transform"];
  await A.doesNotReject(() => transform({}, undefined));
  await A.doesNotReject(() => transform({}, {}));
  await A.doesNotReject(() => transform({}, { messages: "not-an-array" }));
  await A.doesNotReject(() => transform({}, { messages: [null, 42, { info: {}, parts: "x" }] }));
  A.equal(transformMessages(null), null);
  A.equal(transformMessages("nope"), "nope");
  A.equal(transformMessages(undefined), undefined);
});

// ===========================================================================
// SECTION 4 — compaction-handoff (todo 9)
// ===========================================================================

const VERBATIM_LAST =
  "keep the ORIGINAL  spaces, tabs\tand 'quotes' — do NOT normalize me!\nsecond line.";

it("compaction: prompt contains every required section header", () => {
  const prompt = buildHandoffPrompt({}, []);
  A.equal(HANDOFF_SECTIONS.length, 8, "eight required sections");
  for (const header of HANDOFF_SECTIONS) A.ok(prompt.includes(header), `missing header: ${header}`);
  A.ok(byteLength(prompt) <= MAX_TEMPLATE_BYTES, "base template bounded");
});

it("compaction: last user message appears VERBATIM; context is folded and emptied", async () => {
  const hooks = await CompactionHandoff();
  const hook = hooks[COMPACTION_HOOK_NAME];
  A.equal(typeof hook, "function");

  const withMsg = { context: [] };
  await hook({ sessionID: "ses_c1", lastUserMessage: VERBATIM_LAST }, withMsg);
  A.equal(typeof withMsg.prompt, "string");
  A.ok(withMsg.prompt.includes(VERBATIM_LAST), "last user message verbatim");
  A.equal(withMsg.context.length, 0, "context remains empty when prompt is set");

  const marker = "PRIOR-FACT: target is FrankenPHP on port 8081.";
  const withCtx = { context: [marker, "second prior note"] };
  await hook({ sessionID: "ses_c2" }, withCtx);
  A.ok(withCtx.prompt.includes(marker), "prior context folded into prompt");
  A.ok(withCtx.prompt.includes("second prior note"));
  A.equal(withCtx.context.length, 0, "context emptied in place");

  const absent = {};
  await hook({ sessionID: "ses_c3" }, absent);
  A.ok(!("context" in absent), "output.context not created when absent");
});

it("compaction: empty/undefined input still produces a full prompt, deterministic, no throw", async () => {
  const hooks = await CompactionHandoff();
  const hook = hooks[COMPACTION_HOOK_NAME];
  const empty = { context: [] };
  await A.doesNotReject(() => hook({}, empty));
  for (const header of HANDOFF_SECTIONS) A.ok(empty.prompt.includes(header), `empty input lost ${header}`);
  await A.doesNotReject(() => hook(undefined, undefined));
  await A.doesNotReject(() => hook(null, null));

  const a = { context: [] };
  const b = { context: [] };
  await hook({ sessionID: "ses_c4", lastUserMessage: "x" }, a);
  await hook({ sessionID: "ses_c4", lastUserMessage: "x" }, b);
  A.equal(a.prompt, b.prompt, "deterministic across calls");
});

it("compaction: extractLastUserMessage + normalizeContext pure helpers", () => {
  A.equal(
    extractLastUserMessage({ messages: [
      { role: "assistant", content: "hi" },
      { role: "user", content: "the real last one" },
      { role: "assistant", content: "bye" },
    ] }),
    "the real last one",
  );
  A.deepEqual(normalizeContext(null), []);
  A.deepEqual(normalizeContext("nope"), []);
  A.deepEqual(normalizeContext(["", "  ", "keep"]), ["keep"]);

  const input = { lastUserMessage: "hello" };
  const context = ["alpha", "beta"];
  const inputCopy = { ...input };
  const contextCopy = [...context];
  const prompt = buildHandoffPrompt(input, context);
  A.ok(prompt.includes("alpha"));
  A.deepEqual(input, inputCopy, "input not mutated");
  A.deepEqual(context, contextCopy, "context not mutated");
});

// ===========================================================================
// SECTION 5 — attachment-bound (todo 22)
// ===========================================================================

function dataUri(mime, bytes, fill = 0x41) {
  return `data:${mime};base64,${Buffer.alloc(bytes, fill).toString("base64")}`;
}

it("attachment: oversized (>1MB) is previewed + spilled and replaced IN PLACE", () => {
  const dir = mkTmp("attach-unit-");
  const payload = Buffer.alloc(1_500_000, 0x41);
  const part = {
    type: "file",
    mime: "application/pdf",
    filename: "big-laporan.pdf",
    url: `data:application/pdf;base64,${payload.toString("base64")}`,
  };
  const urlBefore = part.url;

  const res = boundAttachment(part, { spillDir: dir });

  A.equal(res.bounded, true);
  A.equal(res.reason, "bounded");
  A.ok(res.bytesIn > DEFAULT_MAX_ATTACHMENT_BYTES, "bytesIn over cap");
  A.ok(res.path && fs.existsSync(res.path), "spill file created");
  A.ok(res.path.endsWith(".pdf"), "spill uses mime extension");
  A.equal(Buffer.compare(fs.readFileSync(res.path), payload), 0, "decoded payload byte-accurate");
  A.equal(part.mime, "text/plain", "placeholder mime is text/plain");
  A.notEqual(part.url, urlBefore, "url replaced in place");
  A.ok(part.url.startsWith("data:text/plain;base64,"), "placeholder is a small data URI");
  A.ok(byteLength(part.url) < (DEFAULT_ATTACHMENT_PREVIEW_BYTES + 4096) * 2, "placeholder bounded");
  const note = decodeDataUriPayload(parseDataUri(part.url)).toString("utf8");
  A.ok(note.includes("[attachment elided"), "pointer present");
  A.ok(note.includes(res.path), "pointer names spill file");
  A.equal(res.bytesOut, byteLength(part.url));
});

it("attachment: small (<1MB) image unchanged, at-cap unchanged, writes nothing", () => {
  const dir = mkTmp("attach-unit-");
  const small = { type: "file", mime: "image/png", filename: "clipboard", url: dataUri("image/png", 100_000, 0x89) };
  const before = JSON.stringify(small);
  const res = boundAttachment(small, { spillDir: dir });
  A.equal(res.bounded, false);
  A.equal(res.reason, "under-cap");
  A.equal(JSON.stringify(small), before, "part byte-identical");

  const atCap = { type: "file", mime: "text/plain", url: "y".repeat(1000) };
  const capRes = boundAttachment(atCap, { spillDir: dir, maxAttachmentBytes: 1000 });
  A.equal(capRes.bounded, false, "at-cap is not over-cap");
  A.equal(atCap.url.length, 1000);
  A.deepEqual(fs.readdirSync(dir), [], "nothing written");
});

it("attachment: malformed parts never throw and are unchanged", () => {
  const dir = mkTmp("attach-unit-");
  for (const part of [null, undefined, "string", 42, { type: "file" }, { type: "file", url: 123 }]) {
    A.doesNotThrow(() => boundAttachment(part, { spillDir: dir }), `no throw for ${String(part)}`);
  }
  A.equal(boundAttachment({ type: "file" }, { spillDir: dir }).reason, "missing-url");
  const numeric = { type: "file", url: 123 };
  A.equal(boundAttachment(numeric, { spillDir: dir }).reason, "non-string-url");
  A.equal(numeric.url, 123);
  A.deepEqual(fs.readdirSync(dir), []);
});

it("attachment: resolvers/preview/byte helpers + boundMessageParts/boundToolOutput", () => {
  const dir = mkTmp("attach-unit-");
  A.equal(DEFAULT_MAX_ATTACHMENT_BYTES, 1048576);
  A.equal(DEFAULT_ATTACHMENT_PREVIEW_BYTES, 4096);
  A.equal(resolveMaxAttachmentBytes({ maxAttachmentBytes: 7 }), 7);
  A.equal(resolveAttachmentPreviewBytes({ previewBytes: 9 }), 9);
  A.equal(resolveAttachmentSpillDir({ spillDir: dir }), dir);
  A.equal(attachmentSanitizeName("../../etc/passwd").includes("/"), false);
  A.equal(extensionForMime("application/pdf"), "pdf");
  A.equal(extensionForMime("image/jpeg; charset=binary"), "jpg");

  const uri = dataUri("image/png", 12);
  A.equal(isDataUri(uri), true);
  A.equal(isDataUri("file:///tmp/x.png"), false);
  A.equal(parseDataUri(uri).mime, "image/png");
  A.equal(attachmentByteLength({ url: 5 }), 0);
  A.equal(attachmentByteLength(null), 0);

  const accented = "é".repeat(5000);
  const sliced = attachmentSafeByteSlice(accented, 8000);
  A.ok(byteLength(sliced) <= 8000);
  A.equal(sliced, "é".repeat(4000));

  // boundToolOutput: big bounded, small byte-identical, array length preserved.
  const big = { type: "file", mime: "application/pdf", filename: "a.pdf", url: dataUri("application/pdf", 1_500_000) };
  const keep = { type: "file", mime: "image/png", filename: "b.png", url: dataUri("image/png", 100_000) };
  const keepBefore = JSON.stringify(keep);
  const output = { title: "read", output: "PDF read successfully", metadata: {}, attachments: [big, keep] };
  const summary = boundToolOutput(output, { tool: "read", callID: "c1", spillDir: dir });
  A.equal(summary.bounded, 1);
  A.equal(big.mime, "text/plain");
  A.equal(JSON.stringify(keep), keepBefore);
  A.equal(output.attachments.length, 2);
  A.ok(output.output.includes("[attachment-bound]"));
  A.ok(fs.existsSync(summary.results[0].path));

  // boundMessageParts: file parts + tool state.attachments, text part untouched.
  const filePart = { type: "file", mime: "image/png", filename: "clip", url: dataUri("image/png", 1_400_000) };
  const textPart = { type: "text", text: "hello" };
  const toolAtt = { type: "file", mime: "application/pdf", filename: "p.pdf", url: dataUri("application/pdf", 1_600_000) };
  const messages = [
    { info: {}, parts: [filePart, textPart] },
    { info: {}, parts: [{ type: "tool", callID: "c9", state: { status: "completed", attachments: [toolAtt] } }] },
  ];
  const textBefore = JSON.stringify(textPart);
  const n = boundMessageParts(messages, { spillDir: dir });
  A.equal(n, 2);
  A.equal(filePart.mime, "text/plain");
  A.equal(toolAtt.mime, "text/plain");
  A.equal(JSON.stringify(textPart), textBefore);
  A.equal(boundMessageParts(null, {}), 0);
  A.equal(boundToolOutput(undefined, {}).bounded, 0);
});

it("attachment: factory hooks registered, never throw, and bound in place", async () => {
  const dir = mkTmp("attach-unit-");
  const plugin = await AttachmentBound();
  A.equal(typeof plugin["tool.execute.after"], "function");
  A.equal(typeof plugin["chat.message"], "function");
  A.equal(typeof plugin["experimental.chat.messages.transform"], "function");
  await A.doesNotReject(() => plugin["tool.execute.after"]({}, undefined));
  await A.doesNotReject(() => plugin["chat.message"]({}, undefined));
  await A.doesNotReject(() => plugin["experimental.chat.messages.transform"]({}, undefined));

  const prevDir = process.env.ATTACHMENT_SPILL_DIR;
  process.env.ATTACHMENT_SPILL_DIR = dir;
  try {
    const part = { type: "file", id: "prt_1", mime: "image/png", filename: "pasted", url: dataUri("image/png", 1_500_000) };
    await plugin["chat.message"]({}, { message: {}, parts: [part] });
    A.equal(part.mime, "text/plain", "same object mutated in place");
    A.ok(part.url.startsWith("data:text/plain;base64,"));
  } finally {
    if (prevDir === undefined) delete process.env.ATTACHMENT_SPILL_DIR;
    else process.env.ATTACHMENT_SPILL_DIR = prevDir;
  }
});

// ===========================================================================
// SECTION 6 — milestone-note (todo 10)
// ===========================================================================

it("milestone: buildStateBlock contains goal/decisions/files/next and is <=4KB", () => {
  const block = buildStateBlock({
    goal: "Ship milestone note",
    decisions: ["append-only", "bounded 4KB"],
    activeFiles: ["milestone-note.js"],
    next: "run tests",
    reason: "session.compacted",
    sessionID: "ses_abc",
    timestamp: "2026-01-01T00:00:00.000Z",
  });
  A.ok(block.includes(STATE_MARKER_START));
  A.ok(block.includes(STATE_MARKER_END));
  A.match(block, /Goal: Ship milestone note/);
  A.match(block, /Decisions: append-only; bounded 4KB/);
  A.match(block, /Next: run tests/);
  A.ok(byteLength(block) <= MAX_BLOCK_BYTES);

  const huge = "A".repeat(200000);
  const truncated = buildStateBlock({ goal: huge, decisions: [huge], activeFiles: [huge], next: huge });
  A.ok(byteLength(truncated) <= MAX_BLOCK_BYTES, "oversized state bounded");
  A.ok(truncated.startsWith(STATE_MARKER_START));
  A.ok(truncated.endsWith(STATE_MARKER_END));
});

it("milestone: appendNote is append-only and refuses out-of-boundary paths", () => {
  const dir = mkTmp("milestone-unit-");
  const file = path.join(dir, "current-state.md");
  fs.writeFileSync(file, "PRIOR CONTENT\n");
  const block = buildStateBlock({ goal: "g", timestamp: "t" });
  const res = appendNote(file, block);
  A.equal(res.ok, true);
  A.equal(res.reason, "appended");
  const after = fs.readFileSync(file, "utf8");
  A.ok(after.startsWith("PRIOR CONTENT\n"), "prior bytes are a prefix");
  A.equal(after.split(STATE_MARKER_START).length - 1, 1, "exactly one block");

  const outside = appendNote(path.join(dir, "outside.md"), block, { boundary: path.join(dir, ".omo") });
  A.equal(outside.ok, false);
  A.equal(outside.reason, "outside-boundary");
  A.equal(fs.existsSync(path.join(dir, "outside.md")), false);
});

it("milestone: session.compacted appends exactly one bounded block, prior preserved", async () => {
  const dir = mkTmp("milestone-unit-");
  const note = path.join(dir, "current-state.md");
  fs.writeFileSync(note, "PRIOR\n");

  const hooks = await MilestoneNote({ worktree: dir, directory: dir }, { notePath: note });
  await hooks.event({ event: { type: "session.compacted", properties: { sessionID: "ses_x" } } });

  const after = fs.readFileSync(note, "utf8");
  A.ok(after.startsWith("PRIOR\n"), "prior content preserved");
  A.equal(after.split(STATE_MARKER_START).length - 1, 1, "exactly one block");
  A.equal(after.split(STATE_MARKER_END).length - 1, 1);
  const block = after.slice(after.indexOf(STATE_MARKER_START)).trim();
  A.ok(byteLength(block) <= MAX_BLOCK_BYTES);

  // Unrelated events are ignored; stateProvider content is honoured.
  await hooks.event({ event: { type: "message.updated", properties: { sessionID: "ses_x" } } });
  A.equal(fs.readFileSync(note, "utf8").split(STATE_MARKER_START).length - 1, 1, "unrelated event ignored");

  const providerNote = path.join(dir, "provider.md");
  const providerHooks = await MilestoneNote(
    { worktree: dir },
    { notePath: providerNote, stateProvider: () => ({ goal: "PROVIDED-GOAL", next: "PROVIDED-NEXT" }) },
  );
  await providerHooks.event({ event: { type: "session.idle", properties: { sessionID: "ses_p" } } });
  const providerText = fs.readFileSync(providerNote, "utf8");
  A.match(providerText, /Goal: PROVIDED-GOAL/);
  A.match(providerText, /Next: PROVIDED-NEXT/);
});

it("milestone: system.transform injects the note once for a fresh session; missing file no-op", async () => {
  resetSeenSessions();
  const dir = mkTmp("milestone-unit-");
  const note = path.join(dir, "current-state.md");
  fs.writeFileSync(note, buildStateBlock({ goal: "GOAL-XYZ", timestamp: "t" }) + "\n");

  const hooks = await MilestoneNote({ worktree: dir }, { notePath: note });
  const first = { system: ["BASE SYSTEM"] };
  await hooks["experimental.chat.system.transform"]({ sessionID: "ses_fresh", model: {} }, first);
  A.equal(first.system.length, 2, "note prepended");
  A.ok(first.system[0].includes(STATE_MARKER_START));
  A.ok(first.system[0].includes("GOAL-XYZ"));
  A.equal(first.system[1], "BASE SYSTEM", "existing system entries preserved");

  const second = { system: ["BASE SYSTEM"] };
  await hooks["experimental.chat.system.transform"]({ sessionID: "ses_fresh", model: {} }, second);
  A.deepEqual(second.system, ["BASE SYSTEM"], "only injected once per session");

  const missing = await MilestoneNote({ worktree: dir }, { notePath: path.join(dir, "nope", "current-state.md") });
  const noop = { system: ["BASE"] };
  await missing["experimental.chat.system.transform"]({ sessionID: "ses_missing", model: {} }, noop);
  A.deepEqual(noop.system, ["BASE"], "missing note -> no-op");
});

it("milestone: readNoteBlock returns latest; bound; helpers + default export identity", () => {
  const dir = mkTmp("milestone-unit-");
  const file = path.join(dir, "cs.md");
  fs.appendFileSync(file, buildStateBlock({ goal: "FIRST", timestamp: "t" }) + "\n");
  fs.appendFileSync(file, buildStateBlock({ goal: "SECOND", timestamp: "t" }) + "\n");
  const latest = readNoteBlock(file);
  A.ok(latest.includes("SECOND"));
  A.ok(!latest.includes("FIRST"));
  A.equal(readNoteBlock(path.join(dir, "missing.md")), "");

  const big = path.join(dir, "big.md");
  fs.writeFileSync(big, "Z".repeat(100000));
  A.ok(byteLength(readNoteBlock(big)) <= MAX_INJECT_BYTES, "unmarked content bounded");

  const state = buildStateFromEvent(
    { event: { type: "session.compacted", properties: { sessionID: "ses_z" } } },
    { state: { goal: "G1" } },
  );
  A.equal(state.reason, "session.compacted");
  A.equal(state.sessionID, "ses_z");
  A.equal(state.goal, "G1");

  A.equal(isFreshSession("ses_new"), true);
  A.equal(isWithin(path.join(dir, NOTE_RELATIVE_PATH), path.join(dir, ".omo")), true);
  A.equal(isWithin(path.join(dir, "elsewhere.md"), path.join(dir, ".omo")), false);
  A.equal(MilestoneNoteDefault, MilestoneNote, "default export is the factory");
});

// ===========================================================================
// Entrypoint identity / import purity sanity
// ===========================================================================

it("entrypoint imports only pure, side-effect-free helpers", () => {
  A.equal(typeof ToolOutputSpill, "function");
  A.equal(typeof SummaryDiffCap, "function");
  A.equal(typeof ContextGovernor, "function");
  A.equal(typeof CompactionHandoff, "function");
  A.equal(typeof AttachmentBound, "function");
  A.equal(typeof MilestoneNote, "function");
  A.equal(typeof transformMessages, "function");
  A.equal(typeof capDiffs, "function");
  A.equal(typeof spillIfNeeded, "function");
  A.equal(typeof boundAttachment, "function");
  A.equal(typeof buildHandoffPrompt, "function");
  A.equal(typeof buildStateBlock, "function");
});
