// ~/.config/opencode/tests/mutation.test.mjs
// ---------------------------------------------------------------------------
// MUTATION check for the memory-efficiency plugin layer (plan todo 14).
//
// Purpose: prove the suite is mutation-SENSITIVE, not vacuous. Each test spawns
// a FRESH Node subprocess (via node:child_process) that imports a plugin and
// asserts that layer's invariant. The subprocess is run twice per layer:
//
//   * CONTROL   (default thresholds)            -> invariant HOLDS  (exit 0)
//   * MUTATION  (a disabled/loosened threshold) -> invariant FAILS (exit != 0)
//
// The parent test asserts the expected exit code. So this file PASSES normally
// exactly because it PROVES the invariant breaks when the layer is disabled.
//
// Deterministic, hermetic: no live DB, no network, no model call. Filesystem
// writes (spill/attachment spill dirs) go to fresh os.tmpdir() directories.
//
// Run:
//   node --test --no-warnings ~/.config/opencode/tests/mutation.test.mjs
// ---------------------------------------------------------------------------

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGINS_DIR = path.resolve(HERE, "..", "plugins");
const pluginUrl = (name) => pathToFileURL(path.join(PLUGINS_DIR, name)).href;

// Every env key a plugin/test in this file may read. Stripped from the base env
// so the parent process cannot accidentally influence a subprocess.
const MANAGED_ENV_KEYS = [
  "PLACEHOLDER_BYTES",
  "PURGE_ERROR_TURNS",
  "SPILL_DIR",
  "SPILL_MAX_BYTES",
  "MAX_ATTACHMENT_BYTES",
  "ATTACHMENT_SPILL_DIR",
  "ATTACHMENT_PREVIEW_BYTES",
  "DIFF_MAX_PATCH_BYTES",
  "DIFF_MAX_TOTAL_BYTES",
  "MUT_OPTION_PLACEHOLDER_BYTES",
  "MUT_SPILL_DIR",
  "MUT_ATTACH_DIR",
];

const tmpDirs = [];
function mkTmp(prefix = "mutation-test-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function envWith(overrides = {}) {
  const env = { ...process.env };
  for (const key of MANAGED_ENV_KEYS) delete env[key];
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined || value === null) delete env[key];
    else env[key] = String(value);
  }
  return env;
}

function runPluginScript(code, overrides) {
  const result = spawnSync(
    process.execPath,
    ["--no-warnings", "--input-type=module", "--eval", code],
    { env: envWith(overrides), encoding: "utf8", timeout: 60000 },
  );
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

// ---------------------------------------------------------------------------
// Subprocess programs. Each prints `MUTATION_PASS`/`MUTATION_FAIL` and sets a
// non-zero exit code when the invariant is violated (exitCode, not process.exit,
// so stdout flushes).
// ---------------------------------------------------------------------------

const GOVERNOR_SCRIPT = `
import { transformMessages } from ${JSON.stringify(pluginUrl("context-governor.js"))};
const S = "ses_mutation_governor";
const msg = (id, role, parts, extras = {}) => ({ info: { id, sessionID: S, role, ...extras }, parts });
const tool = (id, callID, out) => ({
  id, sessionID: S, messageID: "msg_" + id, type: "tool", callID, tool: "read",
  state: { status: "completed", input: { filePath: "/x" }, output: out, metadata: {} },
});
// Compaction marker at index 1 -> watermark 1. The big output sits ABOVE the
// watermark, so only the PLACEHOLDER_BYTES size trigger can elide it.
const messages = [
  msg("m0", "user", [{ id: "t0", sessionID: S, messageID: "m0", type: "text", text: "start" }]),
  msg("m1", "assistant", [{ id: "cmp", sessionID: S, messageID: "m1", type: "compaction", auto: true }], { summary: true }),
  msg("m2", "assistant", [tool("p2", "bigcall", "A".repeat(200000))]),
];
const before = Buffer.byteLength(JSON.stringify(messages), "utf8");
const opts = {};
if (process.env.MUT_OPTION_PLACEHOLDER_BYTES) {
  opts.placeholderBytes = Number(process.env.MUT_OPTION_PLACEHOLDER_BYTES);
}
transformMessages(messages, opts);
const after = Buffer.byteLength(JSON.stringify(messages), "utf8");
const reduction = 1 - after / before;
const ok = reduction >= 0.4;
process.stdout.write("MUTATION_" + (ok ? "PASS" : "FAIL") + " reduction=" + reduction.toFixed(6) + "\\n");
process.exitCode = ok ? 0 : 1;
`;

const DIFFCAP_SCRIPT = `
import { capDiffs } from ${JSON.stringify(pluginUrl("summary-diff-cap.js"))};
const huge = "a".repeat(5 * 1024 * 1024);
const msg = { info: { role: "assistant", summary: { diffs: [
  { file: "src/big.js", patch: huge, additions: 1, deletions: 0, status: "modified" },
] } }, parts: [] };
capDiffs(msg);
const total = msg.info.summary.diffs.reduce((sum, d) => sum + Buffer.byteLength(d.patch || "", "utf8"), 0);
const cap = 512 * 1024;
const ok = total <= cap;
process.stdout.write("MUTATION_" + (ok ? "PASS" : "FAIL") + " total=" + total + " cap=" + cap + "\\n");
process.exitCode = ok ? 0 : 1;
`;

const SPILL_SCRIPT = `
import { spillIfNeeded } from ${JSON.stringify(pluginUrl("tool-output-spill.js"))};
const output = { output: "A".repeat(500 * 1024) };
spillIfNeeded(output, { tool: "bash", callID: "mutation", spillDir: process.env.MUT_SPILL_DIR });
const bytes = Buffer.byteLength(output.output, "utf8");
const ok = bytes < 8000;
process.stdout.write("MUTATION_" + (ok ? "PASS" : "FAIL") + " bytes=" + bytes + "\\n");
process.exitCode = ok ? 0 : 1;
`;

const ATTACHMENT_SCRIPT = `
import { boundAttachment } from ${JSON.stringify(pluginUrl("attachment-bound.js"))};
const payload = Buffer.alloc(1_500_000, 0x41);
const part = {
  type: "file", mime: "application/pdf", filename: "mutation.pdf",
  url: "data:application/pdf;base64," + payload.toString("base64"),
};
const res = boundAttachment(part, { spillDir: process.env.MUT_ATTACH_DIR });
const ok = res.bounded === true;
process.stdout.write("MUTATION_" + (ok ? "PASS" : "FAIL") + " reason=" + res.reason + "\\n");
process.exitCode = ok ? 0 : 1;
`;

// ---------------------------------------------------------------------------
// A tiny self-check that this harness treats any non-zero exit as a failure.
// ---------------------------------------------------------------------------
function assertMutationFails(result, label) {
  assert.notEqual(result.status, 0, `${label}: expected the invariant to FAIL, got status=${result.status}`);
  assert.match(result.stdout, /MUTATION_FAIL/, `${label}: expected MUTATION_FAIL marker`);
}

function assertControlPasses(result, label) {
  assert.equal(result.status, 0, `${label}: expected the invariant to hold; stderr=${result.stderr}`);
  assert.match(result.stdout, /MUTATION_PASS/, `${label}: expected MUTATION_PASS marker`);
}

// ---------------------------------------------------------------------------
// Governor
// ---------------------------------------------------------------------------
test("governor MUTATION: loosened PLACEHOLDER_BYTES disables the size bound -> reduction invariant FAILS", () => {
  const result = runPluginScript(GOVERNOR_SCRIPT, { PLACEHOLDER_BYTES: "999999999" });
  assertMutationFails(result, "PLACEHOLDER_BYTES=999999999");
});

test("governor MUTATION: injected huge placeholderBytes option -> reduction invariant FAILS", () => {
  const result = runPluginScript(GOVERNOR_SCRIPT, { MUT_OPTION_PLACEHOLDER_BYTES: "999999999" });
  assertMutationFails(result, "option placeholderBytes=999999999");
});

test("governor CONTROL: default PLACEHOLDER_BYTES passes the same reduction invariant", () => {
  const result = runPluginScript(GOVERNOR_SCRIPT, {});
  assertControlPasses(result, "governor control");
});

// ---------------------------------------------------------------------------
// Diff cap
// ---------------------------------------------------------------------------
test("diffcap MUTATION: loosened per-file + total caps -> 512KB total invariant FAILS", () => {
  const result = runPluginScript(DIFFCAP_SCRIPT, {
    DIFF_MAX_PATCH_BYTES: "999999999",
    DIFF_MAX_TOTAL_BYTES: "999999999",
  });
  assertMutationFails(result, "DIFF_MAX_* loosened");
});

test("diffcap CONTROL: default caps keep total <= 512KB", () => {
  const result = runPluginScript(DIFFCAP_SCRIPT, {});
  assertControlPasses(result, "diffcap control");
});

// ---------------------------------------------------------------------------
// Tool-output spill
// ---------------------------------------------------------------------------
test("spill MUTATION: loosened SPILL_MAX_BYTES -> preview-bounded invariant FAILS", () => {
  const result = runPluginScript(SPILL_SCRIPT, {
    SPILL_MAX_BYTES: "999999999",
    MUT_SPILL_DIR: mkTmp("mutation-spill-"),
  });
  assertMutationFails(result, "SPILL_MAX_BYTES loosened");
});

test("spill CONTROL: default MAX_OUTPUT_BYTES spills and bounds the preview", () => {
  const result = runPluginScript(SPILL_SCRIPT, { MUT_SPILL_DIR: mkTmp("mutation-spill-") });
  assertControlPasses(result, "spill control");
});

// ---------------------------------------------------------------------------
// Attachment bound
// ---------------------------------------------------------------------------
test("attachment MUTATION: loosened MAX_ATTACHMENT_BYTES -> oversized-attachment invariant FAILS", () => {
  const result = runPluginScript(ATTACHMENT_SCRIPT, {
    MAX_ATTACHMENT_BYTES: "999999999",
    MUT_ATTACH_DIR: mkTmp("mutation-attach-"),
  });
  assertMutationFails(result, "MAX_ATTACHMENT_BYTES loosened");
});

test("attachment CONTROL: default 1MB cap bounds a 1.5MB attachment", () => {
  const result = runPluginScript(ATTACHMENT_SCRIPT, { MUT_ATTACH_DIR: mkTmp("mutation-attach-") });
  assertControlPasses(result, "attachment control");
});

// ---------------------------------------------------------------------------
after(() => {
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  console.log("\n[mutation] SUMMARY all layers: MUTATION fails as expected; CONTROL passes");
});
