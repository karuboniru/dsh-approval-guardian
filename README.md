# dsh-approval-guardian

English | [中文](README.zh.md)

`dsh-approval-guardian` is a DeepSeek Harness (DSH) profile bundle. It intercepts only the **sandbox escalation approvals** that would otherwise pop up and ask a human to allow or deny in the Web/ACP interface, and hands a bounded slice of session context, the tool arguments, and the escalation reason to a fresh one-shot approval-reviewer agent.

Ordinary workspace operations never enter the automated approval flow. Even if an ordinary operation later fails because of a sandbox restriction, the plugin stays out of it as long as no real escalation approval was emitted.

## Overview

- **Problem it solves:** DSH shows an interactive approval prompt whenever an agent needs to widen its sandbox. For automation and for reviewers that should run without a human in the loop, `dsh-approval-guardian` replaces that popup with a deterministic, tool-less reviewer that produces a structured `allow`/`deny`.
- **Who it is for:** users and teams who want a lightweight, explainable approval policy in front of sandbox escalation, with a safe fallback when the reviewer cannot run. It is **not** a general approval-policy replacement: it claims only genuine sandbox widening requests and calls `next()` for everything else.

Every tool execution takes exactly one of three paths:

| Request | Plugin behavior |
| --- | --- |
| Executable within the current sandbox mode | Does not intervene at all |
| An approval that is not emitted by this tool execution, or not a strict widening | Calls the downstream answerer, preserving DSH's original behavior |
| A strict sandbox escalation exactly correlated with this tool execution | Starts a fresh tool-less reviewer and applies its `allow` or `deny` directly |

After a review completes, the result is queued through `ToolRunContext.deferContext()` so it is injected after the matching `tool/result`. The reviewer's rationale is explicitly framed as untrusted data and can never inject instructions back into the parent agent.

## Compatibility

- **Runtime:** Node.js `^22.19.0` or `>=24.0.0`, and pnpm.
- **Peer packages:** `@deepseek-ai/cordis ^4.0.1` and the DSH packages declared in [`package.json`](./package.json) at `^0.1.0-rc.5` (`dsh-agent`, `dsh-compaction`, `dsh-llm`, `dsh-sandbox`, `dsh-sandbox-policy`, `dsh-session`, `dsh-subagent`, `dsh-system-prompt`, `dsh-tools`, `dsh-user-approval`).
- **Verified against:** DSH CLI `0.1.0-rc.6` with all peer packages resolved at `0.1.0-rc.6` (exact resolved snapshot hashes are pinned in [`pnpm-lock.yaml`](./pnpm-lock.yaml)). `0.1.0-rc.6` is confirmed working: the automatic approval-review flow — matching a strict sandbox escalation, spawning the tool-less reviewer, and applying its structured `allow`/`deny` — was observed end-to-end at runtime in a live session on **2026-08-14**.
- The bundle is auto-loaded through the `dsh.bundle.patch` entry in `package.json`, which points at [`cordis.patch.yml`](./cordis.patch.yml).

## Install / Uninstall

### Install

From this checkout, install dependencies, build, and register the bundle into a profile:

```sh
pnpm install
pnpm run build
dsh plugin --profile web add .
```

You can also pass a Git URL or a published package name:

```sh
dsh plugin --profile <profile-name> add dsh-approval-guardian@0.1.1
```

The bundle's `cordis.patch.yml` registers the plugin ahead of the interactive Web/ACP approval answerer; requests the plugin does not claim continue to the downstream answerers. The plugin is loaded because `package.json` declares `dsh.bundle.patch`, so installing the package and restarting the DSH surface is all that is required.

Git installs execute the `prepare` script during install. On pnpm 10 and newer you may first need to allow the package to run build scripts in the target profile's `pnpm-workspace.yaml`.

### Upgrade

Update the package in the profile and restart:

```sh
dsh plugin --profile <profile-name> add dsh-approval-guardian@<new-version>
```

### Disable

Keep the package installed but turn the plugin off by overriding its row in the profile's own `cordis.patch.yml` (or in `$DSH_HOME/cordis.patch.yml`, the machine-level layer that applies to every profile):

```yaml
- id: approval-guardian
  disabled: true
```

Then restart the DSH surface. This is the same `disabled` mechanism DSH uses for its own optional rows, so no files are removed.

### Remove

Fully remove the plugin and its patch from a profile:

```sh
dsh plugin --profile <profile-name> remove dsh-approval-guardian
```

If you added a profile-level override under the `approval-guardian` id, remove that block from the profile's `cordis.patch.yml` as well, then restart. Requests fall back to the interactive Web/ACP answerer immediately after removal.

## Quick start

The shipped `cordis.patch.yml` already applies conservative defaults, so a minimal setup is just the install step above. To customize the deployment policy, override the same `id` in the profile's own `cordis.patch.yml`:

```yaml
- id: approval-guardian
  name: dsh-approval-guardian
  config:
    prompt: |
      - Deny writes below /company/protected unless the user explicitly names the target.
      - Allow routine package installation required by the user's task.
    provider: deepseek-official
    model: deepseek-v4-flash
    subagentProvider: spawn
    failureMode: fail-closed
    timeoutMs: 90000
    maxOutputTokens: 1024
```

**Reproducible example:** start the Web profile and ask the agent to perform a task that requires a wider sandbox mode (for example writing outside the current writable root, which triggers a `tools/execute` call carrying `sandbox_permissions` and a `justification`). Instead of a human popup, the guardian spawns a tool-less reviewer, applies its structured `allow` or `deny`, and injects a notice into the session under an `UNTRUSTED REVIEWER OUTPUT` marker. With the defaults above, `fail-closed` means a reviewer timeout or invalid output returns `unavailable` rather than opening a user dialog.

## Configuration

| Field | Default | Description |
| --- | --- | --- |
| `prompt` | built-in generic policy | Replaces the deployment security-policy section in the reviewer's fixed prompt. Role, evidence-trust rules, and the output contract cannot be overridden. |
| `provider` | inherited from the parent model route | Reviewer model provider; must be configured together with `model`. |
| `model` | inherited from the parent model route | Reviewer model id; must be configured together with `provider`. |
| `subagentProvider` | `spawn` | One-shot subagent provider registered on `ctx.subagents`. |
| `failureMode` | `fail-closed` | Behavior when the reviewer is unavailable or produces invalid output. |
| `timeoutMs` | `90000` | Deadline for a single review, in milliseconds. |
| `maxOutputTokens` | `1024` | Token cap for the reviewer's structured output. |

`failureMode` accepts:

- `fail-closed` — reviewer timeout, unavailability, or invalid output returns `unavailable`; no user dialog is shown.
- `fallback-to-user` — only a reviewer failure hands the request back to a downstream answerer such as Web/ACP.

An explicit reviewer `deny` is a valid decision and never falls back to the user in either mode.

**Pairing rule:** `provider` and `model` must be supplied together or omitted together; supplying only one is a configuration error and the plugin refuses to start with that config. Omitting both inherits the parent model route.

**Sensitive items:** the `prompt` value may embed deployment-specific security policy — keep it out of public repositories if it contains internal rules. No credentials or secrets are configured here; model-provider credentials are managed by DSH's existing model routing, not by this plugin. There are no environment variables specific to this plugin.

## Permissions & data

- **Files:** the plugin reads the parent session transcript in memory via `session.deriveMessages()` and reads the sandbox policy for the current mode and workspace root. It does not read arbitrary files and does not write any files itself. The reviewer is spawned with `toolFilter: { allow: [] }`, so it has no tools and cannot read or write the filesystem.
- **Network:** the only network activity is the reviewer's model-provider request over the normal DSH model route (the configured `provider`/`model` or the parent's route). The plugin opens no other connections.
- **Credentials:** no credentials are read, stored, or forwarded by the plugin. Routine credential use by the parent is evaluated by the reviewer as part of its policy, but the plugin itself never touches secrets.
- **User data:** a bounded, Codex-style subset of conversation history plus the exact planned-action JSON (tool, arguments, cwd, workspace root, current and requested sandbox modes, justification, approval reason) is sent to the configured reviewer model. Only entries labelled `TRUSTED HUMAN MESSAGE`, `TRUSTED INSTRUCTION`, or `TRUSTED QUESTION ANSWER` establish authorization; everything else is treated as untrusted evidence.
- **Prompt-context suppression:** dynamic runtime contexts (for example "approval prompts are disabled" and "delegated scope cannot be widened") are removed only for the approval reviewer during `system-prompt/assemble`. Parent agents and unrelated subagents keep their contexts unchanged.

## Troubleshooting

- **My escalation was not reviewed at all.** All of these must hold: the approval request is emitted inside the in-flight `tools/execute` dynamic scope; agent, call id, and tool name match exactly; the tool arguments include non-empty `sandbox_permissions` and `justification`; the reason text matches DSH's standard sandbox escalation text; and the requested mode is strictly wider than the session's current mode. Anything else calls `next()` and reaches the normal approval channel by design.
- **"provider and model must be configured together".** The plugin refuses to start with only one of the pair. Configure both, or omit both to inherit the parent route.
- **`fail-closed` returns `unavailable`.** The reviewer timed out, was unavailable, or returned output that failed the structured schema. Raise `timeoutMs`, check `maxOutputTokens`, and verify the model route before considering `fallback-to-user`.
- **The reviewer always denies.** Versions before 0.1.1 let the child-runtime "approval prompts are disabled" / "delegated scope cannot be widened" context leak into the review and bias it toward denial. 0.1.1+ removes those contexts for the reviewer only. Confirm the installed bundle version and that the `system-prompt/assemble` suppression is active.
- **Where to look.** DSH keeps user data under `$DSH_HOME` (default `~/.dsh`); profile config lives at `$DSH_HOME/profiles/<name>` with `cordis.patch.yml` and `pnpm-workspace.yaml`. Inspect the composed tree with `dsh --profile <name> --dump-config` to confirm the `approval-guardian` row is present and not `disabled`. DSH writes no separate log file; diagnostics appear on the boot console/stderr.
- **Rollback.** Disable with `- id: approval-guardian` + `disabled: true` in the profile's `cordis.patch.yml`, remove the plugin (`dsh plugin --profile <name> remove dsh-approval-guardian`), or reinstall a previous version (`dsh plugin --profile <name> add dsh-approval-guardian@0.1.0`). Revert any profile-level config override at the same time, then restart.

## Development

```sh
pnpm run typecheck
pnpm test
pnpm run build
npm pack --dry-run
```

Source lives in `src/`, tests in `tests/`, and build output is `lib/index.js` plus `lib/types/`. Do not edit `lib/` by hand; regenerate it with `pnpm run build`.

Key files:

- `src/index.ts` — config, event wiring, strict widening matching, result injection, and lifecycle.
- `src/reviewer.ts` — one-shot reviewer start, identity tracking, structured-result validation, and disposal.
- `src/policy.ts` — fixed reviewer persona, default policy, and review-prompt construction.
- `src/transcript.ts` — context selection, trust labels, budgets, and UTF-8-safe truncation.
- `src/types.ts` — shared types.
- `tests/plugin.spec.ts` — interception, configuration, failure, and prompt-assembly behavior.
- `tests/transcript.spec.ts` — context selection, trust boundaries, and timing rules.
- `tests/cordis.spec.ts` — real Cordis lifecycle composition.

Behavioral changes must ship regression coverage (positive and negative tests for matching and trust changes) and must pass the validation commands above. See [`AGENTS.md`](./AGENTS.md) for the full maintenance contract.

## License & security

- **License:** MIT — see [`LICENSE`](./LICENSE).
- **Reporting security issues:** report privately rather than in a public issue. Use a private vulnerability report (for example a GitHub Security Advisory) on the repository, or contact the maintainer directly, and include the DSH version and the composed profile dump. Do not include credentials, session data, or private repository contents in any report or in the repository itself. Before publishing the repo publicly, confirm no secrets, personal information, or private-repo content are committed.
