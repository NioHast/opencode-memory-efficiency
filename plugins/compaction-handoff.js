// High-fidelity compaction handoff plugin (todo 9, opencode-memory-efficiency).
//
// Hook: "experimental.session.compacting" (input:{sessionID}, output:{context:string[], prompt?:string})
// Behavior: replace the lossy default compaction prompt with a structured handoff
// template that preserves goal, verbatim user constraints/preferences, decisions,
// debugging state (tried / ruled out), active files, open errors, next steps, and the
// last user message VERBATIM.
//
// Guarantees:
//   - Never throws (hard try/catch around the hook body, plus the handler itself).
//   - Does NOT set output.context while output.prompt is set: any incoming
//     output.context entries are folded into the prompt, then the array is emptied
//     in place so context is never appended alongside the replacement prompt.
//   - Pure, deterministic, side-effect-free on import.
//
// Upstream context: anomalyco/opencode#3031 (default compaction is lossy and drops
// decisions/constraints) and #16512 (later compaction can silently discard earlier
// handoff content). The template below is written to survive both failure modes.

export const HOOK_NAME = "experimental.session.compacting";

// Section headers every handoff must contain. Exported so tests and downstream
// consumers can assert completeness without duplicating string literals.
export const HANDOFF_SECTIONS = Object.freeze([
  "## 1. GOAL",
  "## 2. USER CONSTRAINTS / PREFERENCES (VERBATIM)",
  "## 3. DECISIONS",
  "## 4. DEBUGGING STATE (TRIED / RULED OUT)",
  "## 5. ACTIVE FILES",
  "## 6. OPEN ERRORS",
  "## 7. NEXT STEPS",
  "## 8. LAST USER MESSAGE (VERBATIM)",
]);

// Bounds (bytes/chars). The base template stays well under MAX_TEMPLATE_BYTES and
// prior-compaction context is capped so the final prompt stays bounded.
export const MAX_TEMPLATE_BYTES = 8192;
export const MAX_CONTEXT_CHARS = 6000;
export const MAX_CONTEXT_ENTRY_CHARS = 2000;

// Immutable, deterministic base template. Contains every required section header.
const BASE_TEMPLATE = `# HIGH-FIDELITY COMPACTION HANDOFF

You are compacting an opencode session. The default compaction summary is lossy and
drops decisions and user constraints (upstream issue #3031), and later compactions can
silently discard content from an earlier handoff (upstream issue #16512). Produce the
structured handoff below instead. Preserve decisions and constraints; do NOT summarize
away user preferences.

RULES (mandatory):
1. USER CONSTRAINTS / PREFERENCES and the LAST USER MESSAGE must be copied VERBATIM,
   character-for-character. Never paraphrase, shorten, reorder, or "tidy" them.
2. Do not invent facts. If a section has no evidence, write "None known".
3. Record DEBUGGING state as what was TRIED and what was RULED OUT, each with a reason.
4. Keep the handoff information-dense and bounded. Facts over narrative prose.
5. This handoff is the only memory carried forward; anything omitted is lost.
6. Preserve decision provenance: mark which constraint/decision supersedes an older one.
7. Do not drop a user preference even if it appears minor or already satisfied.

## 1. GOAL
<primary objective and what "done" looks like>

## 2. USER CONSTRAINTS / PREFERENCES (VERBATIM)
<quote every explicit user instruction, constraint, or preference exactly as written;
tag each with its message/turn id when known>

## 3. DECISIONS
<decisions made, with rationale and the alternatives that were rejected>

## 4. DEBUGGING STATE (TRIED / RULED OUT)
Tried: <approaches attempted and their observed results>
Ruled out: <approaches disproven, with the reason>

## 5. ACTIVE FILES
<files currently being edited or read, and each one's role in the task>

## 6. OPEN ERRORS
<unresolved errors/failures with their exact messages; write "None known" if clean>

## 7. NEXT STEPS
<ordered next actions; the immediate next action first>

## 8. LAST USER MESSAGE (VERBATIM)`;

// Coerce a possible message value (string / object / parts array) into text.
function coerceMessage(value) {
  if (value == null) return "";
  if (typeof value === "string") return value.trim() ? value : "";
  if (typeof value !== "object") return "";
  if (typeof value.text === "string" && value.text.trim()) return value.text;
  if (typeof value.content === "string" && value.content.trim()) return value.content;
  const partLists = [value.parts, value.content].filter(Array.isArray);
  for (const list of partLists) {
    const texts = list
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part.text === "string") return part.text;
        return "";
      })
      .filter((t) => t.trim().length > 0);
    if (texts.length > 0) return texts.join("\n");
  }
  return "";
}

// Extract a last user message from a variety of plausible hook-input shapes.
export function extractLastUserMessage(input) {
  if (!input || typeof input !== "object") return "";
  const candidates = [
    input.lastUserMessage,
    input.last_user_message,
    input.lastMessage,
    input.last_message,
    input.userMessage,
    input.user_message,
  ];
  for (const candidate of candidates) {
    const text = coerceMessage(candidate);
    if (text) return text;
  }
  if (typeof input.message === "string" && input.message.trim()) return input.message;
  const messages = Array.isArray(input.messages) ? input.messages : null;
  if (messages) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      const role =
        (message && message.role) || (message && message.info && message.info.role);
      if (role === "user" || role === "customer") {
        const text = coerceMessage(message);
        if (text) return text;
      }
    }
  }
  return "";
}

// Normalize output.context (or any context argument) into a list of non-empty strings.
export function normalizeContext(context) {
  if (!Array.isArray(context)) return [];
  return context
    .map((entry) => {
      if (entry == null) return "";
      return typeof entry === "string" ? entry : String(entry);
    })
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

// Render prior-compaction entries as an indented bullet list, clipping each
// entry and the whole block to the configured char bounds.
function renderContext(entries) {
  const rendered = entries
    .map((entry) => {
      const clipped =
        entry.length > MAX_CONTEXT_ENTRY_CHARS
          ? entry.slice(0, MAX_CONTEXT_ENTRY_CHARS) + " …[entry truncated]"
          : entry;
      return "- " + clipped.replace(/\r?\n/g, "\n  ");
    })
    .join("\n");
  if (rendered.length <= MAX_CONTEXT_CHARS) return rendered;
  return rendered.slice(0, MAX_CONTEXT_CHARS) + "\n…[prior context truncated]";
}

// Pure helper: build the handoff prompt. No I/O, no mutation of inputs, deterministic.
export function buildHandoffPrompt(input = {}, context = []) {
  const ctx = normalizeContext(context);
  const lastMessage = extractLastUserMessage(input);

  let prompt = BASE_TEMPLATE;
  if (ctx.length > 0) {
    prompt +=
      "\n\n## PRIOR COMPACTION CONTEXT (carried forward; preserve, do not re-summarize)\n" +
      renderContext(ctx);
  }
  prompt +=
    "\n" +
    (lastMessage
      ? lastMessage
      : "<read the most recent user turn in the conversation and copy it VERBATIM, " +
        "character-for-character; do not paraphrase>");
  return prompt;
}

// Plugin factory. Returns the hook map expected by opencode.
export const CompactionHandoff = async () => ({
  [HOOK_NAME]: async (input, output) => {
    try {
      const out = output && typeof output === "object" ? output : {};
      const context = Array.isArray(out.context) ? out.context : [];
      const prompt = buildHandoffPrompt(input || {}, context);

      // Empty output.context IN PLACE so nothing is appended alongside the prompt.
      // (We never set output.context when it was absent.)
      if (Array.isArray(out.context) && out.context.length > 0) {
        out.context.length = 0;
      }
      out.prompt = prompt;
    } catch {
      // Never throw: a throw here would abort the remaining plugin hook chain.
    }
  },
});

export default CompactionHandoff;
