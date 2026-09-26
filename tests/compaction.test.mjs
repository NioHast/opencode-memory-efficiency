// Unit tests for the high-fidelity compaction handoff plugin (todo 9).
// Run: node --test --no-warnings ~/.config/opencode/tests/compaction.test.mjs
//
// These tests exercise the pure hook functions directly. No network, no DB, no model.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CompactionHandoff,
  HOOK_NAME,
  HANDOFF_SECTIONS,
  MAX_TEMPLATE_BYTES,
  buildHandoffPrompt,
  extractLastUserMessage,
  normalizeContext,
} from "../plugins/compaction-handoff.js";

const VERBATIM_MESSAGE =
  "keep the ORIGINAL  spaces, tabs\tand 'quotes' — do NOT normalize me!\nsecond line.";

async function makeHook() {
  const hooks = await CompactionHandoff();
  return hooks[HOOK_NAME];
}

test("module contract: factory and hook are exported as functions", async () => {
  assert.equal(typeof CompactionHandoff, "function");
  const hooks = await CompactionHandoff();
  assert.equal(typeof hooks, "object");
  assert.equal(typeof hooks[HOOK_NAME], "function");
});

test("buildHandoffPrompt contains every required section header", () => {
  const prompt = buildHandoffPrompt({}, []);
  for (const header of HANDOFF_SECTIONS) {
    assert.ok(
      prompt.includes(header),
      `missing required section header: ${header}`
    );
  }
});

test("template explicitly instructs VERBATIM copying of constraints and last message", () => {
  const prompt = buildHandoffPrompt({}, []);
  assert.ok(/USER CONSTRAINTS \/ PREFERENCES/.test(prompt));
  assert.ok(/VERBATIM/.test(prompt));
  assert.ok(/character-for-character/.test(prompt));
  assert.ok(/do NOT\s+summarize\s+away\s+user\s+preferences/.test(prompt));
  assert.ok(/#3031/.test(prompt), "must reference upstream issue #3031 semantics");
  assert.ok(/#16512/.test(prompt), "must reference upstream issue #16512 semantics");
});

test("hook sets output.prompt and keeps output.context empty (not set) when no context", async () => {
  const hook = await makeHook();
  const output = { context: [] };
  await hook({ sessionID: "ses_test_1" }, output);
  assert.equal(typeof output.prompt, "string");
  assert.ok(output.prompt.length > 0);
  assert.equal(output.context.length, 0, "context must remain empty when prompt is set");
});

test("hook does not create output.context when it was absent", async () => {
  const hook = await makeHook();
  const output = {};
  await hook({ sessionID: "ses_test_2" }, output);
  assert.equal(typeof output.prompt, "string");
  assert.ok(!("context" in output), "output.context must not be set");
});

test("a provided last user message appears VERBATIM in the prompt", async () => {
  const hook = await makeHook();
  const output = { context: [] };
  await hook({ sessionID: "ses_test_3", lastUserMessage: VERBATIM_MESSAGE }, output);
  assert.ok(
    output.prompt.includes(VERBATIM_MESSAGE),
    "last user message must be copied verbatim into the prompt"
  );
});

test("extractLastUserMessage finds a user message from a messages array", () => {
  const found = extractLastUserMessage({
    messages: [
      { role: "assistant", content: "hi" },
      { role: "user", content: "the real last one" },
      { role: "assistant", content: "bye" },
    ],
  });
  assert.equal(found, "the real last one");
});

test("empty input still yields a full prompt and does not throw", async () => {
  const hook = await makeHook();
  const output = { context: [] };
  await assert.doesNotReject(() => hook({}, output));
  for (const header of HANDOFF_SECTIONS) {
    assert.ok(output.prompt.includes(header), `empty input lost section: ${header}`);
  }
});

test("undefined/null output and input do not throw", async () => {
  const hook = await makeHook();
  await assert.doesNotReject(() => hook(undefined, undefined));
  await assert.doesNotReject(() => hook(null, null));
});

test("calling the hook twice is deterministic and does not corrupt state", async () => {
  const hook = await makeHook();
  const first = { context: [] };
  const second = { context: [] };
  await hook({ sessionID: "ses_test_4", lastUserMessage: VERBATIM_MESSAGE }, first);
  await hook({ sessionID: "ses_test_4", lastUserMessage: VERBATIM_MESSAGE }, second);
  assert.equal(first.prompt, second.prompt, "prompt must be deterministic");
  assert.equal(first.context.length, 0);
  assert.equal(second.context.length, 0);
});

test("existing context entries are folded into the prompt and context is emptied", async () => {
  const hook = await makeHook();
  const marker = "PRIOR-FACT: the deploy target is FrankenPHP on port 8081.";
  const output = { context: [marker, "second prior note"] };
  await hook({ sessionID: "ses_test_5" }, output);
  assert.ok(output.prompt.includes(marker), "prior context entry must be folded in");
  assert.ok(output.prompt.includes("second prior note"));
  assert.equal(output.context.length, 0, "context must be emptied when prompt is set");
});

test("buildHandoffPrompt is bounded (<= MAX_TEMPLATE_BYTES) for empty input", () => {
  const prompt = buildHandoffPrompt({}, []);
  const bytes = Buffer.byteLength(prompt, "utf8");
  assert.ok(
    bytes <= MAX_TEMPLATE_BYTES,
    `prompt ${bytes} bytes exceeds bound ${MAX_TEMPLATE_BYTES}`
  );
});

test("normalizeContext ignores blanks and non-array input", () => {
  assert.deepEqual(normalizeContext(null), []);
  assert.deepEqual(normalizeContext("nope"), []);
  assert.deepEqual(normalizeContext(["", "  ", "keep"]), ["keep"]);
});

test("buildHandoffPrompt does not mutate its inputs", () => {
  const context = ["alpha", "beta"];
  const input = { lastUserMessage: "hello" };
  const contextCopy = [...context];
  const inputCopy = { ...input };
  const prompt = buildHandoffPrompt(input, context);
  assert.ok(prompt.includes("alpha"));
  assert.deepEqual(context, contextCopy, "context array must not be mutated");
  assert.deepEqual(input, inputCopy, "input object must not be mutated");
});
