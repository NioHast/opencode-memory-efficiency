// ~/.config/opencode/tests/governor.test.mjs
//
// Unit tests for the single-session context governor (plan todo 8 / todo 14).
// Run: node --test --no-warnings ~/.config/opencode/tests/governor.test.mjs
//
// No DB / no network: the plugin pure helpers and the hook factory are driven
// directly on crafted message arrays.

import test from "node:test";
import assert from "node:assert/strict";

import {
  ContextGovernor,
  resetWatermarks,
  getWatermark,
  detectCompactionMarkerIndex,
  observeWatermark,
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

const SESSION = "ses_governor_test";

const clone = (value) => JSON.parse(JSON.stringify(value));
const serializedBytes = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");

function textPart(id, messageID, text, metadata) {
  const part = { id, sessionID: SESSION, messageID, type: "text", text };
  if (metadata) part.metadata = metadata;
  return part;
}

function toolPart({ id, callID, tool, status = "completed", input = {}, output, error, metadata }) {
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
  return { id, sessionID: SESSION, messageID: `msg_${id}`, type: "tool", callID, tool, state };
}

function message(id, role, parts, extras = {}) {
  return {
    info: { id, sessionID: SESSION, role, time: { created: 1 }, ...extras },
    parts,
  };
}

// 7 user turns; a compaction marker sits at index 10 (watermark = 10).
function craftArray() {
  const errorInput = { command: "deploy --now " + "x".repeat(6000) };
  const duplicateInput = { filePath: "/dup.txt" };
  const duplicateOutput = "D".repeat(500);
  const bigOutput = "A".repeat(40000);

  return [
    message("m0", "user", [textPart("t0", "m0", "start")]),
    message("m1", "assistant", [
      toolPart({ id: "p1", callID: "readA", tool: "read", input: { filePath: "/a.txt" }, output: bigOutput }),
    ]),
    message("m2", "user", [textPart("t2", "m2", "retry")]),
    message("m3", "assistant", [
      toolPart({ id: "p3", callID: "err1", tool: "bash", status: "error", input: errorInput, error: "Exit code 1: deploy failed" }),
    ]),
    message("m4", "user", [textPart("t4", "m4", "did the retry work?")]),
    message("m5", "assistant", [
      toolPart({ id: "p5", callID: "err1-ok", tool: "bash", input: clone(errorInput), output: "ok" }),
    ]),
    message("m6", "user", [textPart("t6", "m6", "decide")]),
    message("m7", "assistant", [
      textPart("textA", "m7", "decision: use plan X", { supersededBy: "textB" }),
    ]),
    message("m8", "user", [textPart("t8", "m8", "confirm")]),
    message("m9", "assistant", [textPart("textB", "m9", "decision: use plan Y (current)")]),
    // Compaction marker (index 10).
    message("m10", "assistant", [{ id: "cmp", sessionID: SESSION, messageID: "m10", type: "compaction", auto: true }], { summary: true }),
    message("m11", "user", [textPart("t11", "m11", "continue")]),
    message("m12", "assistant", [
      toolPart({ id: "p12", callID: "dup1", tool: "read", input: clone(duplicateInput), output: duplicateOutput }),
    ]),
    message("m13", "assistant", [
      toolPart({ id: "p13", callID: "dup2", tool: "read", input: clone(duplicateInput), output: duplicateOutput + "EXTRA" }),
    ]),
    message("m14", "assistant", [
      toolPart({ id: "run1", callID: "run1", tool: "bash", status: "running", input: { command: "tail -f log" } }),
    ]),
    message("m15", "user", [textPart("t15", "m15", "end")]),
  ];
}

function getTool(messages, callID) {
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.type === "tool" && p.callID === callID) return p;
    }
  }
  return undefined;
}

function getPart(messages, id) {
  for (const m of messages) {
    for (const p of m.parts) if (p.id === id) return p;
  }
  return undefined;
}

test("env-configurable defaults are exposed", () => {
  assert.equal(PLACEHOLDER_BYTES, 8000);
  assert.equal(PURGE_ERROR_TURNS, 4);
  assert.ok(PROTECTED_TOOLS.has("write"));
  assert.ok(PROTECTED_TOOLS.has("edit"));
  assert.ok(PROTECTED_TOOLS.has("todowrite"));
  assert.ok(PROTECTED_TOOLS.has("task"));
});

test("crafted 7-turn array: placeholders, dedupe, error purge, supersession, running untouched", () => {
  resetWatermarks();
  const original = craftArray();
  const before = serializedBytes(original);

  const transformed = transformMessages(clone(original));
  const after = serializedBytes(transformed);

  // Marker detection + monotonic watermark at the compaction index.
  assert.equal(detectCompactionMarkerIndex(original), 10);
  assert.equal(getWatermark(SESSION), 10);

  // 1. Old large output below the watermark becomes a 1-line placeholder.
  const readA = getTool(transformed, "readA");
  assert.match(readA.state.output, /^\[governor\] read output elided \(\d+ bytes\)$/);
  assert.equal(readA.state.output.split("\n").length, 1);

  // 2. Duplicate read reduced to the LATEST: earlier collapsed, latest kept full.
  const dup1 = getTool(transformed, "dup1");
  const dup2 = getTool(transformed, "dup2");
  assert.equal(dup1.state.output, "[governor] duplicate read call elided (latest kept)");
  assert.equal(dup2.state.output, "D".repeat(500) + "EXTRA");

  // 3. Resolved error input purged, error text kept.
  const err = getTool(transformed, "err1");
  assert.deepEqual(err.state.input, {});
  assert.equal(err.state.error, "Exit code 1: deploy failed");

  // 4. Exactly one current decision remains; the superseded one is collapsed.
  const superseded = getPart(transformed, "textA");
  const current = getPart(transformed, "textB");
  assert.equal(superseded.text, "[governor] superseded by textB (current state kept)");
  assert.equal(current.text, "decision: use plan Y (current)");
  const liveDecisions = transformed
    .flatMap((m) => m.parts)
    .filter((p) => p.type === "text" && p.text.startsWith("decision:") && !p.text.startsWith("[governor]"));
  assert.equal(liveDecisions.length, 1);

  // 5. The running call is byte-identical.
  const runBefore = getTool(original, "run1");
  const runAfter = getTool(transformed, "run1");
  assert.deepEqual(runAfter, runBefore);

  // 6. Total serialized bytes reduced by >= 40%.
  assert.ok(after < before, `expected shrink: before=${before} after=${after}`);
  const reduction = 1 - after / before;
  assert.ok(reduction >= 0.4, `expected >=40% reduction, got ${(reduction * 100).toFixed(1)}%`);
});

test("invariant: an array of only active/unresolved items is byte-identical", () => {
  resetWatermarks();
  const active = [
    message("a0", "user", [textPart("at0", "a0", "still working")]),
    message("a1", "assistant", [
      toolPart({ id: "runA", callID: "runA", tool: "bash", status: "running", input: { command: "sleep 100" } }),
    ]),
    message("a2", "assistant", [
      toolPart({ id: "pendA", callID: "pendA", tool: "read", status: "pending", input: { filePath: "/big.txt" } }),
    ]),
  ];
  const snapshot = clone(active);
  const result = transformMessages(active);
  assert.deepEqual(result, snapshot);
  assert.equal(serializedBytes(result), serializedBytes(snapshot));
});

test("prefix-stability: same array plus 3 newer messages yields identical earlier prefix", () => {
  resetWatermarks();
  const base = craftArray();

  const first = transformMessages(clone(base));
  const prefixFromFirst = serializedBytes(first.slice(0, base.length));

  const newer = [
    message("m16", "user", [textPart("t16", "m16", "one more question")]),
    message("m17", "assistant", [textPart("t17", "m17", "here is the answer")]),
    message("m18", "user", [textPart("t18", "m18", "thanks")]),
  ];
  const extended = [...clone(base), ...clone(newer)];
  const second = transformMessages(extended);
  const prefixFromSecond = serializedBytes(second.slice(0, base.length));

  assert.equal(prefixFromSecond, prefixFromFirst);
  assert.equal(getWatermark(SESSION), 10);
});

test("PROTECTED tools are untouched even when huge and below the watermark", () => {
  resetWatermarks();
  const session = "ses_governor_protected";
  const huge = "Z".repeat(50000);
  const partsFor = (id, callID, tool) =>
    ({ ...toolPart({ id, callID, tool, input: { filePath: "/x" }, output: huge }), sessionID: session });
  const array = [
    { info: { id: "p0", sessionID: session, role: "assistant" }, parts: [partsFor("w1", "w1", "write")] },
    { info: { id: "p1", sessionID: session, role: "assistant" }, parts: [partsFor("e1", "e1", "edit")] },
    { info: { id: "p2", sessionID: session, role: "assistant" }, parts: [partsFor("td1", "td1", "todowrite")] },
    { info: { id: "p3", sessionID: session, role: "assistant" }, parts: [partsFor("tk1", "tk1", "task")] },
    { info: { id: "p4", sessionID: session, role: "assistant", summary: true }, parts: [{ id: "cmp2", sessionID: session, messageID: "p4", type: "compaction", auto: true }] },
  ];
  const snapshot = clone(array);
  transformMessages(array);
  assert.deepEqual(array, snapshot);
});

test("malformed input never throws and is left untouched", async () => {
  resetWatermarks();
  const hook = await ContextGovernor();
  const transform = hook["experimental.chat.messages.transform"];
  const big = { messages: [{ info: { id: "x", sessionID: SESSION, role: "assistant" }, parts: [{ type: "tool", id: "q", callID: "q", tool: "read", state: { status: "completed", input: {}, output: "A".repeat(40000) } }] }] };
  const bigSnapshot = clone(big);

  await assert.doesNotReject(() => transform({}, undefined));
  await assert.doesNotReject(() => transform({}, {}));
  await assert.doesNotReject(() => transform({}, { messages: "not-an-array" }));
  await assert.doesNotReject(() => transform({}, { messages: [{ parts: [] }] }));
  await assert.doesNotReject(() => transform({}, { messages: [null, 42, { info: {}, parts: "x" }] }));

  // Message with parts but no info -> no session -> untouched (no size placeholder).
  const noInfo = { messages: [{ parts: bigSnapshot.messages[0].parts }] };
  const noInfoSnapshot = clone(noInfo);
  await transform({}, noInfo);
  assert.deepEqual(noInfo, noInfoSnapshot);

  // Non-array helpers.
  assert.equal(transformMessages(null), null);
  assert.equal(transformMessages("nope"), "nope");
  assert.equal(transformMessages(undefined), undefined);
});

test("applyPlaceholders adds a spill pointer when a spill file exists", () => {
  const array = [
    message("s0", "assistant", [
      toolPart({ id: "sp1", callID: "spillcall", tool: "read", input: { filePath: "/s" }, output: "hello world" }),
    ]),
  ];
  applyPlaceholders(array, 0, {
    placeholderBytes: 1,
    spillDir: "/spill",
    fileExists: () => true,
  });
  assert.equal(
    array[0].parts[0].state.output,
    makePlaceholder("read", 11, "/spill/spillcall.txt"),
  );
  assert.match(array[0].parts[0].state.output, /full: \/spill\/spillcall\.txt$/);
});

test("dedupe refuses to collapse when the later result is not a superset (non-stateless)", () => {
  const array = [
    message("d0", "assistant", [toolPart({ id: "d1", callID: "d1", tool: "bash", input: { command: "x" }, output: "first-result" })]),
    message("d1", "assistant", [toolPart({ id: "d2", callID: "d2", tool: "bash", input: { command: "x" }, output: "second-different" })]),
  ];
  dedupeCalls(array, 0);
  assert.equal(getTool(array, "d1").state.output, "first-result");
  assert.equal(getTool(array, "d2").state.output, "second-different");
});

test("purgeErrorInputs requires resolution and age below the watermark", () => {
  const mk = () => [
    message("q0", "assistant", [toolPart({ id: "qe", callID: "qe", tool: "bash", status: "error", input: { command: "boom" }, error: "failed" })]),
  ];
  // Unresolved -> untouched.
  const unresolved = mk();
  purgeErrorInputs(unresolved, 10);
  assert.deepEqual(getTool(unresolved, "qe").state.input, { command: "boom" });

  // Resolved but not far enough below the watermark -> untouched.
  const young = mk();
  purgeErrorInputs(young, 2);
  assert.deepEqual(getTool(young, "qe").state.input, { command: "boom" });

  // Resolved + old enough -> input purged, error kept.
  const resolved = [
    ...mk(),
    message("q1", "assistant", [toolPart({ id: "qo", callID: "qo", tool: "bash", input: { command: "boom" }, output: "ok" })]),
  ];
  purgeErrorInputs(resolved, 10);
  assert.deepEqual(getTool(resolved, "qe").state.input, {});
  assert.equal(getTool(resolved, "qe").state.error, "failed");
});

test("applySupersession only honours explicit same-session newer tags", () => {
  const array = [
    message("x0", "assistant", [textPart("old", "x0", "old decision", { supersededBy: "new" })]),
    message("x1", "assistant", [textPart("new", "x1", "new decision")]),
    // Missing reference -> untouched.
    message("x2", "assistant", [textPart("dangling", "x2", "dangling", { supersededBy: "ghost" })]),
    // Same id but reference is older -> untouched.
    message("x3", "assistant", [textPart("backwards", "x3", "backwards", { supersededBy: "old" })]),
  ];
  applySupersession(array, 0);
  assert.equal(getPart(array, "old").text, "[governor] superseded by new (current state kept)");
  assert.equal(getPart(array, "new").text, "new decision");
  assert.equal(getPart(array, "dangling").text, "dangling");
  assert.equal(getPart(array, "backwards").text, "backwards");
});
