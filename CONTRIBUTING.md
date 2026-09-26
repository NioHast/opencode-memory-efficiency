# Contributing

Thanks for wanting to help. This doc covers the two things you'll actually do:
add or change a plugin, and run the checks before you open a pull request.

The short version:

1. Put the plugin in `plugins/<name>.js`.
2. Export an async factory that returns a hooks object.
3. Never let a hook throw.
4. Add a test file in `tests/<name>.test.mjs` that exercises the real behavior,
   plus a negative/mutation check where it makes sense.
5. Run the Node suite and the `bash -n` checks.
6. Keep it dependency-free and path-portable.

## Adding a plugin

A plugin is a single ESM file under `plugins/`. opencode loads every `*.js` file
in that directory at startup. The file exports a named async factory; the factory
returns an object whose keys are hook names and whose values are async handlers.

```js
// plugins/example.js
// Short note on WHAT this does and WHY.

export const Example = async (input, options = {}) => ({
  "tool.execute.after": async (hookInput, output) => {
    // do work in place; never throw
  },
});
```

Conventions in this repo:

- Named export in PascalCase (`ContextGovernor`, `ToolOutputSpill`), matching the
  filename in kebab-case (`context-governor.js`, `tool-output-spill.js`).
- Handlers mutate `output` in place; they don't republish events.
- The hook keys are the exact strings from
  `node_modules/@opencode-ai/plugin/dist/index.d.ts`, not guesses.

## The hook contract

opencode awaits each hook in order. A plugin that registers a hook returns a
handler shaped like `(input, output) => Promise<void>` (some hooks only take
`input`). The hooks used in this repo, with their real shapes:

| Hook | Handler signature | Used by |
| --- | --- | --- |
| `tool.execute.before` | `(input: { tool, sessionID, callID }, output: { args })` | `tool-concurrency.js` |
| `tool.execute.after` | `(input: { tool, sessionID, callID, args }, output: { title, output, metadata })` | `attachment-bound.js`, `tool-output-spill.js`, `tool-concurrency.js` |
| `chat.message` | `(input: { sessionID, agent?, model?, messageID?, variant? }, output: { message, parts })` | `attachment-bound.js` |
| `experimental.chat.messages.transform` | `(input: {}, output: { messages })` | `attachment-bound.js`, `context-governor.js`, `summary-diff-cap.js` |
| `experimental.chat.system.transform` | `(input: { sessionID?, model }, output: { system })` | `milestone-note.js` |
| `experimental.session.compacting` | `(input: { sessionID }, output: { context, prompt? })` | `compaction-handoff.js` |
| `event` | `(input: { event })` | `milestone-note.js` |

Notes that keep shared hooks from stepping on each other:

- Three plugins register `experimental.chat.messages.transform` (`attachment-bound`,
  `context-governor`, `summary-diff-cap`). They run in load order and each only
  rewrites the messages it owns, so they compose instead of overwriting. Keep any
  new handler scoped the same way.
- If you set `output.prompt`, it replaces the default prompt entirely. Prefer
  appending to `output.context` unless replacement is the actual intent.
- Handlers may run on every turn. Keep them cheap and side-effect-light.

Full ordering guarantees and the third-party hook reference live in
[`docs/HOOKS.md`](docs/HOOKS.md).

## Must never throw

A hook must not throw. A throw can abort the hook chain and interrupt the
session, which is exactly what these plugins exist to prevent. Every handler in
this repo wraps its work so that malformed input, a missing file, or an
unwritable spill directory degrades to a no-op instead of an exception. Tests
assert this explicitly (look for the `never throws` cases).

Practical rules:

- Guard every read: missing `output`, `undefined` fields, non-string output,
  missing `callID`. If the input isn't what you expect, return without changing it.
- Wrap filesystem work in `try/catch`; a failed spill must leave `output` intact.
- Use `safeByteSlice`-style helpers when slicing bytes so you never split a
  multi-byte character.
- Don't add new runtime dependencies. The only allowed import from outside the
  standard library is `@opencode-ai/plugin` for types.

## Tests are required

Every behavior change ships with a test. Add `tests/<name>.test.mjs` using
`node:test` and `node:assert/strict`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";

test("example: huge output is spilled and replaced in place", async () => {
  // import the plugin, run the hook against a fake output, assert the result
});
```

Test expectations for this repo:

- Unit-test the exported hook with realistic fake input. `tests/plugins.unit.test.mjs`
  is the shared suite; `tests/<plugin>.test.mjs` is the focused one.
- Assert the never-throw behavior with malformed input.
- Add a negative/mutation check when the invariant could silently pass. The
  `mutation.test.mjs` pattern spawns a subprocess with a loosened threshold and
  asserts the invariant breaks.
- Keep tests hermetic: no network, no live database, no model calls. Filesystem
  writes go to a fresh `os.tmpdir()` directory.
- Integration tests that need a real database must operate on a **copy** in a
  temp dir, never the live one. Follow `tests/retention.test.sh`.

## Running the suites

Run everything from the repo root (`~/.config/opencode`, portable as
`$HOME/.config/opencode`).

Node unit and mutation suite (Node 24, no framework needed):

```bash
node --test --no-warnings tests/*.test.mjs
```

From anywhere else, point at the installed config:

```bash
node --test --no-warnings "$HOME"/.config/opencode/tests/*.test.mjs
```

Expected: `tests 127`, `pass 127`, `fail 0`. Run a single file while iterating:

```bash
node --test --no-warnings tests/governor.test.mjs
```

Shell syntax checks (must be clean before you commit):

```bash
bash -n bin/*.sh
bash -n tests/*.sh
```

`shellcheck` is optional; it is not installed by default and no check depends on
it.

Integration shells (each is hermetic and safe on a live machine):

```bash
# retention across compaction and a fresh session, no model call
bash tests/context-retention.sh

# db-retention.sh against a temp DB copy; never touches the live DB
bash tests/retention.test.sh

# peak-RSS measurement under the cgroup-capped launcher (Linux + systemd-run)
bash tests/memory-ceiling.sh
```

`memory-ceiling.sh` needs `bin/opencode-capped.sh` and a working `systemd-run`;
on hosts without either it exits with an inconclusive result rather than a false
pass. `retention.test.sh` needs `python3` (it uses the `sqlite3` module) and a
live `opencode.db` to copy; `context-retention.sh` needs only `node` and `bash`.

## Code style

- ESM only. No CommonJS, no bundler step.
- No new runtime dependencies beyond `@opencode-ai/plugin`.
- Add a short comment to every non-trivial function explaining what it does and,
  where it's not obvious, why (byte-safe slicing, prefix stability, boundary
  gates). The repo has a comment-coverage expectation of zero undocumented
  non-trivial functions.
- Keep all paths portable: resolve the home directory from `os.homedir()` or
  `process.env.HOME`, never hardcode an absolute user path. Every knob already
  reads an env override; keep that pattern for new ones.
- Prefer pure helpers that can be imported and tested directly, and keep the
  factory thin.
- Match the existing formatting: two-space indent, double quotes, semicolons,
  named exports.
- Shell scripts: `set -uo pipefail`, quote expansions, and fail closed on
  destructive operations (refuse to run when the target looks live).
