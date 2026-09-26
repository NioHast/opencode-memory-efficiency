// Unit tests for the summary-diff cap plugin (todo 6).
// Run: node --test --no-warnings ~/.config/opencode/tests/diffcap.test.mjs
//
// Fully deterministic: no DB, no network, no model calls.

import test from "node:test";
import assert from "node:assert/strict";

import {
  SummaryDiffCap,
  capDiffs,
  isVendorPath,
} from "../plugins/summary-diff-cap.js";

const KB = 1024;
const MAX_PATCH = 64 * KB;
const MAX_TOTAL = 512 * KB;
const MARKER = "[... truncated ...]";

function makeMessage(diffs, infoExtra = {}) {
  return {
    info: { role: "assistant", summary: { diffs }, ...infoExtra },
    parts: [],
  };
}

function patchBytes(entry) {
  return Buffer.byteLength(entry.patch ?? "", "utf8");
}

function totalPatchBytes(diffs) {
  return diffs.reduce((sum, d) => sum + patchBytes(d), 0);
}

// ---------------------------------------------------------------------------
// Pure helper sanity
// ---------------------------------------------------------------------------
test("exports are importable with no side effects", () => {
  assert.equal(typeof SummaryDiffCap, "function");
  assert.equal(typeof capDiffs, "function");
  assert.equal(typeof isVendorPath, "function");
});

test("isVendorPath matches vendor/generated/cache segments only", () => {
  const vendors = [
    "node_modules/left-pad/index.js",
    "app/.node-runtime/bin/node",
    "frontend/dist/app.js",
    "server/build/out.o",
    "backend/.venv/lib/python3.13/site.py",
    ".cache/turbo/x",
    "pkg/__pycache__/mod.pyc",
    "web/.next/server/chunk.js",
    "web/.turbo/cache",
    "C:\\proj\\node_modules\\x.js",
  ];
  for (const p of vendors) {
    assert.equal(isVendorPath(p), true, `expected vendor: ${p}`);
  }
  const legit = [
    "src/app.js",
    "resources/js/Pages/Cashier/Dashboard.jsx",
    "redistribute.js",
    "builders/index.ts", // partial segment, not `build`
    ".env.example",
    "",
    null,
    42,
  ];
  for (const p of legit) {
    assert.equal(isVendorPath(p), false, `expected non-vendor: ${String(p)}`);
  }
});

// ---------------------------------------------------------------------------
// 1. 5MB single patch -> per-file and total caps enforced
// ---------------------------------------------------------------------------
test("5MB single patch is capped to <=64KB and total <=512KB", () => {
  const huge = "a".repeat(5 * 1024 * 1024);
  assert.ok(Buffer.byteLength(huge) >= 5 * 1024 * 1024);

  const msg = makeMessage([
    { file: "src/big.js", patch: huge, additions: 10, deletions: 4, status: "modified" },
  ]);

  const returned = capDiffs(msg);
  assert.equal(returned, msg, "capDiffs returns the same message object");

  const diffs = msg.info.summary.diffs;
  assert.equal(Array.isArray(diffs), true, "summary.diffs array preserved");
  assert.equal(diffs.length, 1, "message entry retained");

  assert.ok(patchBytes(diffs[0]) <= MAX_PATCH, "per-file <=64KB");
  assert.ok(totalPatchBytes(diffs) <= MAX_TOTAL, "total <=512KB");
  assert.ok(diffs[0].patch.endsWith(MARKER), "truncation marker appended");

  // Non-patch fields survive verbatim.
  assert.deepEqual(
    { file: diffs[0].file, status: diffs[0].status, additions: diffs[0].additions, deletions: diffs[0].deletions },
    { file: "src/big.js", status: "modified", additions: 10, deletions: 4 },
  );
});

// ---------------------------------------------------------------------------
// 2. Total budget across many entries -> lowest-priority dropped
// ---------------------------------------------------------------------------
test("total cap drops lowest-priority entries and keeps total <=512KB", () => {
  const one = "x".repeat(MAX_PATCH); // exactly 64KB -> no per-file truncation
  const diffs = [];
  for (let i = 0; i < 10; i++) {
    diffs.push({
      file: `src/file-${i}.js`,
      patch: one,
      additions: i,
      deletions: 0,
      status: "modified",
    });
  }
  const msg = makeMessage(diffs);
  capDiffs(msg);

  const out = msg.info.summary.diffs;
  assert.ok(totalPatchBytes(out) <= MAX_TOTAL, "total <=512KB");
  assert.equal(out.length, 8, "8 x 64KB = 512KB retained");
  // Earliest entries win the tie-break (later indices dropped).
  assert.equal(out[0].file, "src/file-0.js");
  assert.equal(out[7].file, "src/file-7.js");
});

// ---------------------------------------------------------------------------
// 3. Vendor paths removed entirely
// ---------------------------------------------------------------------------
test("vendor/generated paths are removed entirely, legit entries kept", () => {
  const msg = makeMessage([
    { file: "src/keep.js", patch: "ok", additions: 1, deletions: 0, status: "added" },
    { file: "node_modules/pkg/index.js", patch: "v", additions: 9, deletions: 9, status: "modified" },
    { file: "web/.next/chunk.js", patch: "v", additions: 9, deletions: 9, status: "modified" },
    { file: "app/dist/main.js", patch: "v", additions: 9, deletions: 9, status: "modified" },
    { file: ".venv/lib/x.py", patch: "v", additions: 9, deletions: 9, status: "modified" },
    { file: "src/keep2.jsx", patch: "ok2", additions: 2, deletions: 0, status: "added" },
  ]);

  capDiffs(msg);
  const out = msg.info.summary.diffs;

  assert.equal(Array.isArray(out), true, "array preserved");
  assert.equal(out.length, 2, "only legit entries survive");
  for (const d of out) {
    assert.equal(isVendorPath(d.file), false, `no vendor path retained: ${d.file}`);
  }
  assert.deepEqual(out.map((d) => d.file), ["src/keep.js", "src/keep2.jsx"]);
});

// ---------------------------------------------------------------------------
// 4. Small message is byte-identical / deep-equal after transform
// ---------------------------------------------------------------------------
test("small message under caps is byte-identical after transform", () => {
  const msg = makeMessage([
    { file: "src/a.js", patch: "+a\n", additions: 1, deletions: 0, status: "added" },
    { file: "src/b.js", patch: "-b\n+c\n", additions: 1, deletions: 1, status: "modified" },
  ]);
  const beforeJson = JSON.stringify(msg);

  const returned = capDiffs(msg);
  assert.equal(returned, msg);
  assert.equal(JSON.stringify(msg), beforeJson, "serialized bytes unchanged");
  assert.deepEqual(msg.info.summary.diffs, [
    { file: "src/a.js", patch: "+a\n", additions: 1, deletions: 0, status: "added" },
    { file: "src/b.js", patch: "-b\n+c\n", additions: 1, deletions: 1, status: "modified" },
  ]);
});

// ---------------------------------------------------------------------------
// 5. Malformed payloads -> untouched, no throw
// ---------------------------------------------------------------------------
test("non-array summary.diffs is left untouched and does not throw", () => {
  const msg = makeMessage([]);
  msg.info.summary.diffs = "not-an-array";
  const before = JSON.stringify(msg);
  assert.doesNotThrow(() => capDiffs(msg));
  assert.equal(JSON.stringify(msg), before);
});

test("entry missing patch is left untouched (no drop, no throw)", () => {
  const msg = makeMessage([
    { file: "src/x.js", status: "modified", additions: 2, deletions: 1 },
  ]);
  const before = JSON.stringify(msg);
  assert.doesNotThrow(() => capDiffs(msg));
  assert.equal(JSON.stringify(msg), before);
  assert.equal(msg.info.summary.diffs.length, 1);
});

test("entry with null file is left untouched (no throw)", () => {
  const original = { file: null, patch: "+x", additions: 1, deletions: 0, status: "modified" };
  const msg = makeMessage([original]);
  const before = JSON.stringify(msg);
  assert.doesNotThrow(() => capDiffs(msg));
  assert.equal(JSON.stringify(msg), before);
  assert.deepEqual(msg.info.summary.diffs[0], original);
});

test("message with no summary is untouched", () => {
  const msg = { info: { role: "user" }, parts: [] };
  const before = JSON.stringify(msg);
  assert.doesNotThrow(() => capDiffs(msg));
  assert.equal(JSON.stringify(msg), before);
});

test("summary present but no diffs key is untouched", () => {
  const msg = { info: { role: "assistant", summary: { foo: 1 } }, parts: [] };
  const before = JSON.stringify(msg);
  assert.doesNotThrow(() => capDiffs(msg));
  assert.equal(JSON.stringify(msg), before);
});

// ---------------------------------------------------------------------------
// 6. Hook behaviour
// ---------------------------------------------------------------------------
test("hook handles empty messages without throwing", async () => {
  const plugin = await SummaryDiffCap();
  const hook = plugin["experimental.chat.messages.transform"];
  assert.equal(typeof hook, "function");
  await assert.doesNotReject(async () => {
    await hook({}, { messages: [] });
  });
  await assert.doesNotReject(async () => {
    await hook({}, {});
  });
});

test("hook caps messages in place, keeps array + message count, no reorder", async () => {
  const plugin = await SummaryDiffCap();
  const hook = plugin["experimental.chat.messages.transform"];

  const huge = "z".repeat(5 * 1024 * 1024);
  const m1 = makeMessage([
    { file: "src/one.js", patch: huge, additions: 1, deletions: 0, status: "added" },
    { file: "node_modules/drop.js", patch: "v", additions: 1, deletions: 0, status: "added" },
  ]);
  const m2 = { info: { role: "user" }, parts: [] };
  const m3 = makeMessage([
    { file: "src/two.js", patch: "small", additions: 1, deletions: 0, status: "added" },
  ]);

  const output = { messages: [m1, m2, m3] };
  await hook({}, output);

  assert.equal(output.messages.length, 3, "message count unchanged");
  assert.equal(output.messages[0], m1);
  assert.equal(output.messages[1], m2);
  assert.equal(output.messages[2], m3);

  assert.equal(Array.isArray(m1.info.summary.diffs), true, "array not removed");
  assert.equal(m1.info.summary.diffs.length, 1);
  assert.ok(patchBytes(m1.info.summary.diffs[0]) <= MAX_PATCH);
  assert.deepEqual(m3.info.summary.diffs.map((d) => d.file), ["src/two.js"]);
});

// ---------------------------------------------------------------------------
// 7. Env overrides
// ---------------------------------------------------------------------------
test("DIFF_MAX_PATCH_BYTES / DIFF_MAX_TOTAL_BYTES env overrides are honoured", () => {
  const prevPatch = process.env.DIFF_MAX_PATCH_BYTES;
  const prevTotal = process.env.DIFF_MAX_TOTAL_BYTES;
  try {
    process.env.DIFF_MAX_PATCH_BYTES = "1024";
    process.env.DIFF_MAX_TOTAL_BYTES = "2048";
    const msg = makeMessage([
      { file: "src/e1.js", patch: "q".repeat(5 * KB), additions: 1, deletions: 0, status: "added" },
      { file: "src/e2.js", patch: "q".repeat(5 * KB), additions: 1, deletions: 0, status: "added" },
    ]);
    capDiffs(msg);
    const out = msg.info.summary.diffs;
    for (const d of out) {
      assert.ok(patchBytes(d) <= 1024, "env per-file cap honoured");
    }
    assert.ok(totalPatchBytes(out) <= 2048, "env total cap honoured");
    assert.equal(out.length, 2, "two 1KB truncated patches fit in 2KB total");
  } finally {
    if (prevPatch === undefined) delete process.env.DIFF_MAX_PATCH_BYTES;
    else process.env.DIFF_MAX_PATCH_BYTES = prevPatch;
    if (prevTotal === undefined) delete process.env.DIFF_MAX_TOTAL_BYTES;
    else process.env.DIFF_MAX_TOTAL_BYTES = prevTotal;
  }
});

// ---------------------------------------------------------------------------
// 8. Byte-safe truncation at multibyte boundaries
// ---------------------------------------------------------------------------
test("truncation is UTF-8 byte-safe (no split code points)", () => {
  const multibyte = "é".repeat(200 * KB); // 2 bytes each
  const msg = makeMessage([
    { file: "src/uni.js", patch: multibyte, additions: 1, deletions: 0, status: "added" },
  ]);
  capDiffs(msg, { maxPatchBytes: 100 });
  const out = msg.info.summary.diffs[0].patch;
  assert.ok(Buffer.byteLength(out, "utf8") <= 100, "<=100 bytes");
  assert.equal(out.includes("\uFFFD"), false, "no replacement char from split code point");
  assert.ok(out.endsWith(MARKER));
});
