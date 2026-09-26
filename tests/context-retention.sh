#!/usr/bin/env bash
# context-retention.sh (todo 17, opencode-memory-efficiency)
# ---------------------------------------------------------------------------
# Proves CONTEXT RETENTION across compaction + a fresh session, WITHOUT any
# paid model call: it drives the exported plugin hook helpers directly.
#
#   A. compaction-handoff (todo 9): buildHandoffPrompt / CompactionHandoff
#      - prompt contains EVERY required section header
#      - the last user message appears VERBATIM
#      - output.prompt is set while output.context stays empty
#      - empty conversation still yields the full template (no throw)
#   B. milestone-note (todo 10): buildStateBlock / appendNote / readNoteBlock /
#      MilestoneNote.system.transform
#      - a written block is injected (prepended) into a FRESH session's
#        output.system
#      - a MISSING note is a no-op (no throw)
#      - append is append-only (prior content preserved)
#   C. MUTATION CHECK: the "required sections" assertion MUST FAIL against a
#      sabotaged/empty prompt (proves the assertion has teeth).
#
# Hermetic: all writes go to a temp dir; nothing touches the live repo/DB.
set -uo pipefail

PLUGIN_DIR="${PLUGIN_DIR:-$HOME/.config/opencode/plugins}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/ctx-retention.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

if [ ! -f "$PLUGIN_DIR/compaction-handoff.js" ] || [ ! -f "$PLUGIN_DIR/milestone-note.js" ]; then
  echo "FATAL: plugins not found under $PLUGIN_DIR" >&2
  exit 1
fi

export PLUGIN_DIR WORK
node --no-warnings --input-type=module - <<'NODE'
import fs from "node:fs";
import path from "node:path";

const pluginDir = process.env.PLUGIN_DIR;
const work = process.env.WORK;

const handoff = await import(path.join(pluginDir, "compaction-handoff.js"));
const milestone = await import(path.join(pluginDir, "milestone-note.js"));

let pass = 0, fail = 0;
const results = [];
async function check(name, fn) {
  try { await fn(); results.push(["PASS", name]); pass++; }
  catch (e) { results.push(["FAIL", name, e && e.message]); fail++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }
function assertThrows(fn, msg) {
  let threw = false;
  try { fn(); } catch { threw = true; }
  if (!threw) throw new Error(msg || "expected throw");
}

// ---------------------------------------------------------------------------
// A. compaction handoff
// ---------------------------------------------------------------------------
const LAST_MSG = "USER CONSTRAINT (verbatim): jangan hapus sesi boulder aktif; swap 8GB; jangan pindah sesi manual.";
const craftedInput = { lastUserMessage: LAST_MSG };
const builtPrompt = handoff.buildHandoffPrompt(craftedInput, []);

await check("handoff prompt contains EVERY required section header", () => {
  for (const header of handoff.HANDOFF_SECTIONS) {
    assert(builtPrompt.includes(header), `missing section header: ${header}`);
  }
});

await check("handoff prompt contains the last user message VERBATIM", () => {
  assert(builtPrompt.includes(LAST_MSG), "last user message not copied verbatim");
});

await check("empty conversation still produces the full template (no throw)", () => {
  const p = handoff.buildHandoffPrompt({}, []);
  assert(typeof p === "string" && p.length > 0, "empty prompt");
  for (const header of handoff.HANDOFF_SECTIONS) assert(p.includes(header), `missing ${header}`);
});

await check("CompactionHandoff hook sets output.prompt and leaves output.context empty", async () => {
  const hooks = await handoff.CompactionHandoff();
  const out = { context: [] };
  await hooks["experimental.session.compacting"]({ sessionID: "ses_fresh_test" }, out);
  assert(typeof out.prompt === "string" && out.prompt.length > 0, "output.prompt not set");
  assert(Array.isArray(out.context) && out.context.length === 0, "output.context must stay empty");
  for (const header of handoff.HANDOFF_SECTIONS) assert(out.prompt.includes(header), `missing ${header}`);
});

await check("CompactionHandoff hook never throws on empty input", async () => {
  const hooks = await handoff.CompactionHandoff();
  const out = { context: [] };
  await hooks["experimental.session.compacting"]({}, out);
  assert(typeof out.prompt === "string" && out.prompt.length > 0, "no prompt on empty input");
});

// ---------------------------------------------------------------------------
// B. milestone note write + fresh-session injection
// ---------------------------------------------------------------------------
const notePath = path.join(work, "current-state.md");
process.env.MILESTONE_NOTE_PATH = notePath;

const STATE = {
  goal: "Keep one long session alive under a RAM ceiling with context retention",
  decisions: "export-then-delete mega sessions; snapshot:false; aggressive prune",
  activeFiles: "plugins/context-governor.js, plugins/compaction-handoff.js",
  next: "run Final Verification Wave F1-F4",
  reason: "session.compacted",
  sessionID: "ses_milestone_test",
  timestamp: "2026-09-26T04:00:00.000Z",
};
const block = milestone.buildStateBlock(STATE);

await check("milestone block is bounded (<= 4096 bytes) and self-delimited", () => {
  assert(Buffer.byteLength(block, "utf8") <= 4096, "block exceeds 4KB");
  assert(block.includes(milestone.STATE_MARKER_START), "missing start marker");
  assert(block.includes(milestone.STATE_MARKER_END), "missing end marker");
  assert(block.includes("## Milestone Current State"), "missing heading");
});

await check("appendNote is APPEND-ONLY (prior content preserved)", () => {
  const r1 = milestone.appendNote(notePath, block, { boundary: work });
  assert(r1.ok, `first append failed: ${r1.reason}`);
  const firstLen = fs.readFileSync(notePath, "utf8").length;
  const r2 = milestone.appendNote(notePath, block, { boundary: work });
  assert(r2.ok, `second append failed: ${r2.reason}`);
  const content = fs.readFileSync(notePath, "utf8");
  assert(content.length > firstLen, "file did not grow on append");
  const count = content.split(milestone.STATE_MARKER_START).length - 1;
  assert(count === 2, `expected 2 blocks after 2 appends, got ${count}`);
});

await check("readNoteBlock returns the latest block", () => {
  const read = milestone.readNoteBlock(notePath);
  assert(read.includes(milestone.STATE_MARKER_START), "no block read");
  assert(read.includes("Keep one long session alive"), "latest block content missing");
});

await check("fresh-session system.transform injects the milestone note block", async () => {
  milestone.resetSeenSessions();
  const hooks = await milestone.MilestoneNote({ worktree: work }, { notePath });
  const out = { system: ["BASE SYSTEM PROMPT"] };
  await hooks["experimental.chat.system.transform"]({ sessionID: "ses_fresh_A" }, out);
  assert(Array.isArray(out.system) && out.system.length >= 2, "system not prepended");
  assert(out.system[0].includes("## Milestone Current State"), "note not at system[0]");
  assert(out.system[out.system.length - 1] === "BASE SYSTEM PROMPT", "original system lost");
});

await check("missing note is a no-op (no throw, system unchanged)", async () => {
  milestone.resetSeenSessions();
  const missing = path.join(work, "does-not-exist.md");
  const prevEnv = process.env.MILESTONE_NOTE_PATH;
  process.env.MILESTONE_NOTE_PATH = missing; // env takes precedence over opts
  try {
    const hooks = await milestone.MilestoneNote({ worktree: work }, { notePath: missing });
    const out = { system: ["BASE"] };
    await hooks["experimental.chat.system.transform"]({ sessionID: "ses_fresh_B" }, out);
    assert(out.system.length === 1 && out.system[0] === "BASE", "missing note must not mutate system");
  } finally {
    process.env.MILESTONE_NOTE_PATH = prevEnv;
  }
});

// ---------------------------------------------------------------------------
// C. mutation / sensitivity check: the assertion MUST detect sabotage
// ---------------------------------------------------------------------------
await check("MUTATION: 'required sections' assertion FAILS on a sabotaged/empty prompt", () => {
  const sabotaged = builtPrompt.replace(handoff.HANDOFF_SECTIONS[0], "");
  assertThrows(
    () => {
      for (const header of handoff.HANDOFF_SECTIONS) {
        assert(sabotaged.includes(header), `missing section header: ${header}`);
      }
    },
    "section assertion did not detect a removed header",
  );
});

await check("MUTATION: verbatim assertion FAILS when the message is paraphrased", () => {
  const paraphrased = builtPrompt.replace(LAST_MSG, "user asked us to be careful");
  assertThrows(
    () => assert(paraphrased.includes(LAST_MSG), "verbatim check missed a paraphrase"),
    "verbatim assertion did not detect a paraphrase",
  );
});

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------
console.log("=== context-retention test ===");
for (const [st, name, msg] of results) {
  console.log(`${st}: ${name}${msg ? " - " + msg : ""}`);
}
console.log(`=== SUMMARY: ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exitCode = 1;
NODE
rc=$?
echo "context-retention: exit=$rc"
exit $rc
