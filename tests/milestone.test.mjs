// Unit tests for the milestone note writer (todo 10, opencode-memory-efficiency).
//
// Run: node --test --no-warnings ~/.config/opencode/tests/milestone.test.mjs
//
// All tests are deterministic and require NO LLM/network call. They exercise the
// pure helpers plus the two hook surfaces (`event`, `experimental.chat.system.transform`)
// by driving the factory directly. The note path is overridden with
// MILESTONE_NOTE_PATH so nothing outside a temp dir is ever written.

import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import MilestoneNoteDefault, {
  MilestoneNote,
  buildStateBlock,
  appendNote,
  readNoteBlock,
  buildStateFromEvent,
  isWithin,
  isFreshSession,
  markSessionSeen,
  resetSeenSessions,
  STATE_MARKER_START,
  STATE_MARKER_END,
  TRUNCATION_MARKER,
  MAX_BLOCK_BYTES,
  MAX_INJECT_BYTES,
  NOTE_RELATIVE_PATH,
} from "../plugins/milestone-note.js";

const tmpDirs = [];

function mkTmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "milestone-test-"));
  tmpDirs.push(dir);
  return dir;
}

function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

beforeEach(() => {
  delete process.env.MILESTONE_NOTE_PATH;
  resetSeenSessions();
});

afterEach(() => {
  delete process.env.MILESTONE_NOTE_PATH;
  resetSeenSessions();
  while (tmpDirs.length > 0) {
    try {
      fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

// ---------------------------------------------------------------------------
// buildStateBlock
// ---------------------------------------------------------------------------

test("buildStateBlock contains goal/decisions/active files/next and is bounded", () => {
  const block = buildStateBlock({
    goal: "Ship milestone note",
    decisions: ["append-only", "bounded 4KB"],
    activeFiles: ["milestone-note.js"],
    next: "run tests",
    reason: "session.compacted",
    sessionID: "ses_abc",
    timestamp: "2026-01-01T00:00:00.000Z",
  });
  assert.ok(block.includes(STATE_MARKER_START));
  assert.ok(block.includes(STATE_MARKER_END));
  assert.match(block, /Goal: Ship milestone note/);
  assert.match(block, /Decisions: append-only; bounded 4KB/);
  assert.match(block, /Active files: milestone-note\.js/);
  assert.match(block, /Next: run tests/);
  assert.match(block, /Session: ses_abc/);
  assert.ok(Buffer.byteLength(block, "utf8") <= MAX_BLOCK_BYTES);
});

test("buildStateBlock truncates oversized state to <= 4KB with a marker", () => {
  const huge = "A".repeat(200000);
  const block = buildStateBlock(
    { goal: huge, decisions: [huge], activeFiles: [huge], next: huge },
    MAX_BLOCK_BYTES,
  );
  assert.ok(Buffer.byteLength(block, "utf8") <= MAX_BLOCK_BYTES);
  assert.ok(block.startsWith(STATE_MARKER_START));
  assert.ok(block.endsWith(STATE_MARKER_END));
  assert.ok(block.includes("truncated"));
  assert.match(block, /Goal: A+/);
});

// ---------------------------------------------------------------------------
// appendNote — append-only
// ---------------------------------------------------------------------------

test("appendNote appends and preserves prior content", () => {
  const dir = mkTmp();
  const file = path.join(dir, "current-state.md");
  fs.writeFileSync(file, "PRIOR CONTENT\n");

  const block = buildStateBlock({ goal: "g", timestamp: "t" });
  const res = appendNote(file, block);

  assert.equal(res.ok, true);
  assert.equal(res.reason, "appended");
  const after = fs.readFileSync(file, "utf8");
  assert.ok(after.startsWith("PRIOR CONTENT\n"), "prior bytes are a prefix");
  assert.equal(countOccurrences(after, STATE_MARKER_START), 1);
});

test("appendNote refuses paths outside its boundary without throwing", () => {
  const dir = mkTmp();
  const res = appendNote(path.join(dir, "outside.md"), buildStateBlock({ goal: "g" }), {
    boundary: path.join(dir, ".omo"),
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "outside-boundary");
  assert.equal(fs.existsSync(path.join(dir, "outside.md")), false);
});

// ---------------------------------------------------------------------------
// event hook — one bounded block per trigger
// ---------------------------------------------------------------------------

test("session.compacted event appends exactly one bounded block; prior preserved", async () => {
  const dir = mkTmp();
  const note = path.join(dir, "current-state.md");
  fs.writeFileSync(note, "PRIOR\n");
  process.env.MILESTONE_NOTE_PATH = note;

  const hooks = await MilestoneNote({ worktree: dir, directory: dir });
  await hooks.event({
    event: { type: "session.compacted", properties: { sessionID: "ses_x" } },
  });

  const after = fs.readFileSync(note, "utf8");
  assert.ok(after.startsWith("PRIOR\n"), "prior content preserved");
  assert.equal(countOccurrences(after, STATE_MARKER_START), 1, "exactly one block");
  assert.equal(countOccurrences(after, STATE_MARKER_END), 1);

  const block = after.slice(after.indexOf(STATE_MARKER_START)).trim();
  assert.ok(Buffer.byteLength(block, "utf8") <= MAX_BLOCK_BYTES);
});

test("session.idle appends and unrelated events are ignored", async () => {
  const dir = mkTmp();
  const note = path.join(dir, "n.md");
  process.env.MILESTONE_NOTE_PATH = note;

  const hooks = await MilestoneNote({ worktree: dir });
  await hooks.event({
    event: { type: "session.idle", properties: { sessionID: "ses_y" } },
  });
  await hooks.event({
    event: { type: "message.updated", properties: { sessionID: "ses_y" } },
  });

  const after = fs.readFileSync(note, "utf8");
  assert.equal(countOccurrences(after, STATE_MARKER_START), 1);
});

test("event hook honors stateProvider for goal/next content", async () => {
  const dir = mkTmp();
  const note = path.join(dir, "n.md");
  process.env.MILESTONE_NOTE_PATH = note;

  const hooks = await MilestoneNote(
    { worktree: dir },
    { stateProvider: () => ({ goal: "PROVIDED-GOAL", next: "PROVIDED-NEXT" }) },
  );
  await hooks.event({
    event: { type: "session.compacted", properties: { sessionID: "ses_p" } },
  });

  const after = fs.readFileSync(note, "utf8");
  assert.match(after, /Goal: PROVIDED-GOAL/);
  assert.match(after, /Next: PROVIDED-NEXT/);
});

// ---------------------------------------------------------------------------
// experimental.chat.system.transform — injection
// ---------------------------------------------------------------------------

test("system.transform on a fresh session prepends the note block", async () => {
  const dir = mkTmp();
  const note = path.join(dir, "current-state.md");
  fs.writeFileSync(
    note,
    buildStateBlock({ goal: "GOAL-XYZ", timestamp: "t" }) + "\n",
  );
  process.env.MILESTONE_NOTE_PATH = note;

  const hooks = await MilestoneNote({ worktree: dir });
  const output = { system: ["BASE SYSTEM"] };
  await hooks["experimental.chat.system.transform"](
    { sessionID: "ses_fresh", model: {} },
    output,
  );

  assert.equal(output.system.length, 2);
  assert.ok(output.system[0].includes(STATE_MARKER_START));
  assert.ok(output.system[0].includes("GOAL-XYZ"));
  assert.equal(output.system[1], "BASE SYSTEM");
});

test("system.transform is a no-op when the note file is missing", async () => {
  const dir = mkTmp();
  process.env.MILESTONE_NOTE_PATH = path.join(dir, "nope", "current-state.md");

  const hooks = await MilestoneNote({ worktree: dir });
  const output = { system: ["BASE"] };
  await hooks["experimental.chat.system.transform"](
    { sessionID: "ses_missing", model: {} },
    output,
  );

  assert.deepEqual(output.system, ["BASE"]);
});

test("system.transform only injects once per session (fresh session)", async () => {
  const dir = mkTmp();
  const note = path.join(dir, "cs.md");
  fs.writeFileSync(note, buildStateBlock({ goal: "G", timestamp: "t" }) + "\n");
  process.env.MILESTONE_NOTE_PATH = note;

  const hooks = await MilestoneNote({ worktree: dir });
  const first = { system: ["BASE"] };
  await hooks["experimental.chat.system.transform"](
    { sessionID: "ses_same", model: {} },
    first,
  );
  assert.equal(first.system.length, 2);

  const second = { system: ["BASE"] };
  await hooks["experimental.chat.system.transform"](
    { sessionID: "ses_same", model: {} },
    second,
  );
  assert.deepEqual(second.system, ["BASE"]);
});

// ---------------------------------------------------------------------------
// Failure modes + boundaries
// ---------------------------------------------------------------------------

test("non-writable note path does not throw or crash", async () => {
  const dir = mkTmp();
  const blocker = path.join(dir, "blocker");
  fs.writeFileSync(blocker, "x"); // a regular file where a dir would be needed
  const note = path.join(blocker, "current-state.md"); // dirname is a file -> ENOTDIR
  process.env.MILESTONE_NOTE_PATH = note;

  const hooks = await MilestoneNote({ worktree: dir });
  await assert.doesNotReject(async () => {
    await hooks.event({
      event: { type: "session.compacted", properties: { sessionID: "ses_e" } },
    });
    await hooks["experimental.chat.system.transform"](
      { sessionID: "ses_e2", model: {} },
      { system: ["B"] },
    );
  });

  const res = appendNote(note, buildStateBlock({ goal: "g" }));
  assert.equal(res.ok, false);
  assert.equal(res.reason, "write-failed");
});

test("default writes stay under <worktree>/.omo", async () => {
  const dir = mkTmp();
  const hooks = await MilestoneNote({ worktree: dir, directory: dir });
  await hooks.event({
    event: { type: "session.compacted", properties: { sessionID: "ses_d" } },
  });

  const expected = path.join(dir, NOTE_RELATIVE_PATH);
  assert.ok(fs.existsSync(expected), `expected note at ${expected}`);
  assert.ok(expected.includes(`${path.sep}.omo${path.sep}`));
});

test("isWithin keeps the default note path inside the .omo boundary", () => {
  const dir = mkTmp();
  const note = path.join(dir, NOTE_RELATIVE_PATH);
  assert.equal(isWithin(note, path.join(dir, ".omo")), true);
  assert.equal(isWithin(path.join(dir, "elsewhere.md"), path.join(dir, ".omo")), false);
});

// ---------------------------------------------------------------------------
// readNoteBlock
// ---------------------------------------------------------------------------

test("readNoteBlock returns the latest block; missing file -> empty", () => {
  const dir = mkTmp();
  const file = path.join(dir, "cs.md");
  fs.appendFileSync(file, buildStateBlock({ goal: "FIRST", timestamp: "t" }) + "\n");
  fs.appendFileSync(file, buildStateBlock({ goal: "SECOND", timestamp: "t" }) + "\n");

  const block = readNoteBlock(file);
  assert.ok(block.includes("SECOND"));
  assert.ok(!block.includes("FIRST"));
  assert.equal(readNoteBlock(path.join(dir, "missing.md")), "");
});

test("readNoteBlock bounds oversized unmarked content", () => {
  const dir = mkTmp();
  const file = path.join(dir, "cs.md");
  fs.writeFileSync(file, "Z".repeat(100000));

  const block = readNoteBlock(file);
  assert.ok(Buffer.byteLength(block, "utf8") <= MAX_INJECT_BYTES);
});

// ---------------------------------------------------------------------------
// Helpers / factory shape
// ---------------------------------------------------------------------------

test("buildStateFromEvent derives reason/session and honors stateProvider", () => {
  const state = buildStateFromEvent(
    { event: { type: "session.compacted", properties: { sessionID: "ses_z" } } },
    { state: { goal: "G1" } },
  );
  assert.equal(state.reason, "session.compacted");
  assert.equal(state.sessionID, "ses_z");
  assert.equal(state.goal, "G1");

  const provided = buildStateFromEvent(
    { type: "session.idle", properties: { sessionID: "s" } },
    { stateProvider: (ev) => ({ next: ev.type }) },
  );
  assert.equal(provided.reason, "session.idle");
  assert.equal(provided.next, "session.idle");
});

test("freshness helpers track sessions and can be reset", () => {
  assert.equal(isFreshSession("ses_new"), true);
  markSessionSeen("ses_new");
  assert.equal(isFreshSession("ses_new"), false);
  resetSeenSessions();
  assert.equal(isFreshSession("ses_new"), true);
});

test("default export is the MilestoneNote factory", () => {
  assert.equal(MilestoneNoteDefault, MilestoneNote);
});
