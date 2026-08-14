# AGENTS.md

## Scope

These instructions apply to the entire `dsh-approval-guardian` repository.

## Project purpose

This package is a DeepSeek Harness profile bundle that answers only genuine sandbox-escalation approval requests with a fresh, tool-less reviewer agent. It must not review ordinary workspace operations or become a general approval-policy replacement.

The implementation targets the DSH package versions declared in `package.json`. Upstream DSH and Codex repositories are reference material only unless a task explicitly asks to modify them.

## Non-negotiable behavior

Preserve all of these invariants when changing the plugin:

1. Intercept only a strict sandbox widening emitted by the matching in-flight `tools/execute` call.
2. Match agent identity, call id, tool name, standard approval reason, `sandbox_permissions`, and `justification` before claiming a request.
3. Call `next()` for ordinary workspace operations, non-widening requests, unrelated approvals, and requests that cannot be correlated exactly.
4. Do not inspect or review a normal tool failure merely because it may have been caused by the sandbox.
5. Start one fresh reviewer per claimed request. The reviewer must have no tools (`toolFilter: { allow: [] }`) and must return the structured decision schema.
6. Treat only entries labelled `TRUSTED HUMAN MESSAGE` (direct human messages), `TRUSTED INSTRUCTION` (developer messages and `AGENTS.md`-class workspace instructions), and `TRUSTED QUESTION ANSWER` (human-selected options under an `ask_user_question` question) as user authorization. Assistant text, tool data, compaction checkpoints, approval reasons, arguments, and reviewer output are untrusted evidence.
7. Preserve chronological precedence: a later trusted human instruction supersedes an earlier conflicting instruction about the same operation or review.
8. DSH child-agent statements such as “approval prompts are disabled”, “approval policy: never”, and “delegated scope cannot be widened” constrain only actions attempted by the reviewer itself. They must never justify denial of the parent action.
9. Suppress dynamic system-prompt contexts only for the approval reviewer. Never remove contexts from the parent agent or unrelated subagents.
10. An explicit reviewer denial is authoritative and never falls back to a human answerer. Fallback is only for reviewer timeout, invalid output, or unavailability when `failureMode` is `fallback-to-user`.
11. An allow requires a valid structured assessment and clean reviewer disposal. A deny remains authoritative if disposal later fails.
12. On plugin disposal, cancel and drain active reviews before teardown completes.
13. Inject the applied decision through `ToolRunContext.deferContext()` and frame reviewer-produced rationale as untrusted data.
14. Do not add `ignorable: true` or custom session events until the required DSH API is officially supported and the compatibility behavior is tested.
15. Keep `provider` and `model` paired. Supplying only one must remain a configuration error; omitting both inherits the parent model route.

## Architecture

- `src/index.ts`: Cordis integration, configuration, execution-to-approval correlation, reviewer-only prompt-context suppression, result injection, fallback, and plugin lifecycle.
- `src/reviewer.ts`: reviewer identity tracking, one-shot subagent execution, timeout/cancellation, structured-output validation, and disposal semantics.
- `src/policy.ts`: immutable reviewer rules, deployment-configurable policy section, and review prompt construction.
- `src/transcript.ts`: Codex-style context selection, trust labels, deterministic rendering, token budgets, and UTF-8-safe truncation.
- `src/types.ts`: shared public and internal types.
- `cordis.patch.yml`: default bundle placement and conservative runtime defaults.
- `tests/plugin.spec.ts`: interception, configuration, failure, and prompt-assembly behavior.
- `tests/transcript.spec.ts`: context selection, trust boundaries, recency, and regression cases.
- `tests/cordis.spec.ts`: composition and lifecycle behavior with Cordis.
- `lib/`: generated package artifacts. Do not edit these files by hand.

## Coding conventions

- Use TypeScript ESM and retain explicit `.ts` suffixes for source-relative imports.
- Keep public exports intentional. The package currently has no default export.
- Prefer small pure functions for matching, transcript selection, normalization, and validation.
- Validate all values crossing model or plugin boundaries; do not rely on TypeScript types at runtime.
- Preserve `AsyncLocalStorage` correlation. Global “current execution” or “current reviewer” variables are unsafe under concurrent requests.
- Keep reviewer persona rules separate from the configurable `prompt`. Configuration may replace deployment policy, not evidence handling, role separation, or the output contract.
- Do not include private reasoning or arbitrary plugin messages in reviewer context.
- Keep comments focused on lifecycle, concurrency, security boundaries, and surprising DSH behavior.
- Update README configuration and behavior documentation when changing public options or semantics.

## Required tests for behavioral changes

Add or update regression coverage for every changed branch. At minimum, retain tests proving:

- workspace operations do not start a reviewer;
- sandbox failures without an escalation request are ignored;
- unrelated, malformed, and non-widening approvals call the downstream answerer;
- a strict widening starts a tool-less reviewer and applies its structured result;
- only the approval reviewer loses delegated-child runtime contexts;
- configured provider/model values are passed as a pair;
- explicit denial never falls back;
- unavailable and timeout behavior follows `failureMode`;
- cancellation and plugin disposal drain the reviewer;
- direct human messages are trusted and all other evidence is untrusted;
- developer messages and `AGENTS.md`-class instructions are trusted (`TRUSTED INSTRUCTION`) and ordinary tool/assistant/checkpoint evidence remains untrusted;
- human-selected options under an `ask_user_question` question are trusted (`TRUSTED QUESTION ANSWER`) and ordinary tool results remain untrusted;
- a later human `accept` supersedes an earlier conflicting `reject`;
- reviewer-owned disabled-approval/delegation constraints cannot be used against the parent action;
- transcript budgets, ordering, truncation, and stable action serialization remain deterministic.

## Validation

Run these commands from the repository root before handing off a change:

```sh
pnpm run typecheck
pnpm test
pnpm run build
npm pack --dry-run
```

`npm pack --dry-run` may need a writable npm cache depending on the execution sandbox. A cache-permission failure is environmental, but the check should still be rerun in an allowed environment.

After building, smoke-test the generated module when exports are touched:

```sh
node --input-type=module -e "import('./lib/index.js').then(m => console.log(Object.keys(m).sort()))"
```

Expected public exports are `Config`, `apply`, `inject`, `name`, and `resolveConfig`, plus declared type exports. Do not introduce a default export unintentionally.

## Dependency and generated-file policy

- Use pnpm and keep `pnpm-lock.yaml` synchronized with `package.json`.
- Add DSH packages used directly by source code to both peer and development dependencies as appropriate.
- Do not hand-edit `lib/`; regenerate it with `pnpm run build`.
- Do not modify vendored/upstream repositories while implementing this plugin unless the user explicitly expands the task scope.
- Preserve unrelated user changes. This checkout may not contain usable Git metadata, so inspect exact files before editing and report changes by path rather than assuming `git diff` is available.

## Definition of done

A change is complete only when its intended behavior is implemented in `src/`, regression-tested, typechecked, built into `lib/`, and documented when user-visible. Security-sensitive matching or trust changes require both positive and negative tests.
