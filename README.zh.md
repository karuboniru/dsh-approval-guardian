# dsh-approval-guardian

[English](README.md) | 中文

`dsh-approval-guardian` 是一个 DeepSeek Harness（DSH）profile bundle。它只拦截原本会在 Web/ACP 界面弹窗要求用户允许或拒绝的**沙箱扩权审批**，并把有限的会话上下文、工具参数和提权理由交给一个全新的单次审批 reviewer 子代理。

普通 workspace 操作永远不会进入自动审批流程。即使某个普通操作随后因沙箱限制执行失败，只要它没有触发真实的扩权审批，本插件也不会介入。

## 概述

- **解决的问题：** DSH 在代理需要扩大其沙箱时会显示交互式审批弹窗。对于自动化场景，以及希望在无人值守下运行审查的场景，`dsh-approval-guardian` 用一个确定性的、无工具的 reviewer 取代该弹窗，并产出结构化的 `allow`/`deny` 决定。
- **适用对象：** 希望在沙箱扩权前使用轻量、可解释的审批策略，并在 reviewer 无法运行时拥有安全回退机制的用户和团队。它**不是**通用审批策略的替代品：它只认领真正的沙箱扩权请求，其他一切请求都调用 `next()`。

每次工具执行恰好走三条路径之一：

| 请求 | 插件行为 |
| --- | --- |
| 在当前 sandbox mode 内可直接执行 | 完全不介入 |
| 不是本次工具执行产生的审批，或不是严格扩权 | 调用下游 answerer，保留 DSH 原行为 |
| 与本次工具执行严格对应的沙箱扩权审批 | 启动全新的无工具 reviewer，并直接应用其 `allow` 或 `deny` |

审批完成后，结果通过 `ToolRunContext.deferContext()` 排队，注入到对应的 `tool/result` 之后。reviewer 的说明会被显式标记为不可信数据，永远不能把指令注入回父代理。

## 兼容性

- **运行时：** Node.js `^22.19.0` 或 `>=24.0.0`，以及 pnpm。
- **peer 依赖：** `@deepseek-ai/cordis ^4.0.1` 以及 [`package.json`](./package.json) 中声明的 `^0.1.0-rc.5` DSH 包（`dsh-agent`、`dsh-compaction`、`dsh-llm`、`dsh-sandbox`、`dsh-sandbox-policy`、`dsh-session`、`dsh-subagent`、`dsh-system-prompt`、`dsh-tools`、`dsh-user-approval`）。
- **已验证组合：** DSH CLI `0.1.0-rc.6`，所有 peer 包解析为 `0.1.0-rc.6`（确切的解析快照哈希固定在 [`pnpm-lock.yaml`](./pnpm-lock.yaml) 中）。该功能于 **2026-08-14** 在此组合下确认可用。
- bundle 通过 `package.json` 中的 `dsh.bundle.patch` 条目自动加载，该条目指向 [`cordis.patch.yml`](./cordis.patch.yml)。

## 安装 / 卸载

### 安装

从本仓库开始，安装依赖、构建并把 bundle 注册到某个 profile：

```sh
pnpm install
pnpm run build
dsh plugin --profile web add .
```

也可以传入 Git URL 或已发布的包名：

```sh
dsh plugin --profile <profile-name> add dsh-approval-guardian@0.1.1
```

bundle 的 `cordis.patch.yml` 将插件注册在交互式 Web/ACP 审批 answerer 之前；插件未认领的请求会继续传给下游 answerer。插件之所以被加载，是因为 `package.json` 声明了 `dsh.bundle.patch`，所以安装包并重启 DSH 界面即可。

Git 安装会在安装过程中执行 `prepare` 脚本。在 pnpm 10 及更新版本上，你可能需要先在目标 profile 的 `pnpm-workspace.yaml` 中允许该包运行构建脚本。

### 升级

更新 profile 中的包并重启：

```sh
dsh plugin --profile <profile-name> add dsh-approval-guardian@<new-version>
```

### 禁用

保留已安装的包，但通过在 profile 自己的 `cordis.patch.yml`（或 `$DSH_HOME/cordis.patch.yml`，即应用于每个 profile 的机器级配置层）中覆盖其行来关闭插件：

```yaml
- id: approval-guardian
  disabled: true
```

然后重启 DSH 界面。这与 DSH 用于自身可选行的 `disabled` 机制相同，不会删除任何文件。

### 移除

从 profile 中彻底移除插件及其 patch：

```sh
dsh plugin --profile <profile-name> remove dsh-approval-guardian
```

如果你在 `approval-guardian` id 下添加过 profile 级覆盖，也请从 profile 的 `cordis.patch.yml` 中删除该块，然后重启。移除后，请求会立即回退到交互式 Web/ACP answerer。

## 快速开始

随附的 `cordis.patch.yml` 已经应用了保守的默认值，所以最小化配置只需执行上面的安装步骤。要自定义部署策略，请在 profile 自己的 `cordis.patch.yml` 中覆盖同一个 `id`：

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

**可复现示例：** 启动 Web profile，让代理执行一个需要更宽 sandbox mode 的任务（例如写入当前可写根目录之外，这会触发一个携带 `sandbox_permissions` 和 `justification` 的 `tools/execute` 调用）。此时不会出现人工弹窗，而是由 guardian 启动一个无工具的 reviewer，应用其结构化的 `allow` 或 `deny`，并在会话中注入一条带有 `UNTRUSTED REVIEWER OUTPUT` 标记的通知。使用上述默认值时，`fail-closed` 意味着 reviewer 超时或输出无效时返回 `unavailable`，而不是打开用户对话框。

## 配置

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `prompt` | 内置通用策略 | 替换 reviewer 固定提示词中的部署安全策略部分。角色、证据可信规则和输出协议不可被覆盖。 |
| `provider` | 继承父模型路由 | reviewer 的模型 provider；必须与 `model` 一起配置。 |
| `model` | 继承父模型路由 | reviewer 模型 id；必须与 `provider` 一起配置。 |
| `subagentProvider` | `spawn` | 在 `ctx.subagents` 上注册的单次子代理 provider。 |
| `failureMode` | `fail-closed` | reviewer 不可用或输出无效时的行为。 |
| `timeoutMs` | `90000` | 单次 review 的截止时间，单位毫秒。 |
| `maxOutputTokens` | `1024` | reviewer 结构化输出的 token 上限。 |

`failureMode` 支持：

- `fail-closed` — reviewer 超时、不可用或输出无效时返回 `unavailable`；不显示用户对话框。
- `fallback-to-user` — 仅当 reviewer 故障时才把请求交回下游 answerer（如 Web/ACP）。

reviewer 明确返回的 `deny` 是有效决定，在任何一种模式下都不会回退给用户。

**配对规则：** `provider` 和 `model` 必须同时配置或同时省略；只配置其中一个属于配置错误，插件会拒绝以该配置启动。两者都省略则继承父模型路由。

**敏感项：** `prompt` 值可能包含部署特定的安全策略——如果含有内部规则，请勿放入公开仓库。这里不配置任何凭据或密钥；模型 provider 的凭据由 DSH 现有的模型路由管理，不由本插件管理。本插件没有专用环境变量。

## 权限与数据

- **文件：** 插件通过 `session.deriveMessages()` 在内存中读取父会话 transcript，并读取 sandbox 策略以获取当前 mode 和工作区根目录。它不读取任意文件，也不写入任何文件。reviewer 以 `toolFilter: { allow: [] }` 启动，因此没有任何工具，不能读写文件系统。
- **网络：** 唯一的网络活动是 reviewer 通过常规 DSH 模型路由（配置的 `provider`/`model` 或父路由）发出的模型 provider 请求。插件不建立其他连接。
- **凭据：** 插件不读取、存储或转发任何凭据。父代理的常规凭据使用由 reviewer 作为其策略的一部分进行评估，但插件本身绝不接触密钥。
- **用户数据：** 一个有界的、Codex 风格的会话历史子集，加上确切的计划操作 JSON（tool、arguments、cwd、工作区根目录、当前与请求的 sandbox mode、justification、审批 reason）会被发送给配置的 reviewer 模型。只有标记为 `TRUSTED HUMAN MESSAGE`、`TRUSTED INSTRUCTION` 或 `TRUSTED QUESTION ANSWER` 的条目才能建立授权；其余一切都被视为不可信证据。
- **提示词上下文抑制：** 在 `system-prompt/assemble` 阶段，只会移除审批 reviewer 的动态运行时上下文（例如“approval prompts are disabled”和“delegated scope cannot be widened”）。父代理和不相关的子代理保持上下文不变。

## 故障排查

- **我的扩权请求完全没有被 review。** 以下条件必须全部满足：审批请求在正在进行的 `tools/execute` 动态作用域内发出；agent、call id 和 tool name 完全匹配；工具参数包含非空的 `sandbox_permissions` 和 `justification`；reason 文本与 DSH 标准的沙箱扩权文本一致；请求的 mode 严格宽于会话当前 mode。其他任何情况都会调用 `next()` 并按设计进入正常审批通道。
- **“provider and model must be configured together”。** 插件拒绝只配置其中一个。请同时配置两者，或两者都省略以继承父路由。
- **`fail-closed` 返回 `unavailable`。** reviewer 超时、不可用，或返回的输出未通过结构化 schema。在考虑 `fallback-to-user` 之前，请调大 `timeoutMs`、检查 `maxOutputTokens` 并核实模型路由。
- **reviewer 总是拒绝。** 0.1.1 之前的版本会让子运行时“approval prompts are disabled”/“delegated scope cannot be widened”上下文泄漏到 review 中并偏向拒绝。0.1.1+ 仅对 reviewer 移除这些上下文。请确认安装的 bundle 版本，以及 `system-prompt/assemble` 抑制是否生效。
- **去哪里查看。** DSH 把用户数据放在 `$DSH_HOME`（默认 `~/.dsh`）下；profile 配置位于 `$DSH_HOME/profiles/<name>`，包含 `cordis.patch.yml` 和 `pnpm-workspace.yaml`。用 `dsh --profile <name> --dump-config` 检查组合后的配置树，确认 `approval-guardian` 行存在且未 `disabled`。DSH 不写独立的日志文件；诊断信息出现在启动控制台/stderr 上。
- **回滚。** 在 profile 的 `cordis.patch.yml` 中用 `- id: approval-guardian` + `disabled: true` 禁用，或用 `dsh plugin --profile <name> remove dsh-approval-guardian` 移除插件，或重新安装旧版本（`dsh plugin --profile <name> add dsh-approval-guardian@0.1.0`）。同时还原任何 profile 级配置覆盖，然后重启。

## 开发

```sh
pnpm run typecheck
pnpm test
pnpm run build
npm pack --dry-run
```

源码位于 `src/`，测试位于 `tests/`，构建产物是 `lib/index.js` 和 `lib/types/`。不要手工编辑 `lib/`；用 `pnpm run build` 重新生成。

主要文件：

- `src/index.ts` — 配置、事件接入、严格扩权匹配、结果注入和生命周期。
- `src/reviewer.ts` — 单次 reviewer 启动、身份跟踪、结构化结果校验和释放。
- `src/policy.ts` — 固定的 reviewer persona、默认策略和 review prompt 构建。
- `src/transcript.ts` — 上下文选择、信任标签、预算和 UTF-8 安全截断。
- `src/types.ts` — 共享类型。
- `tests/plugin.spec.ts` — 拦截、配置、故障和 prompt 组装行为。
- `tests/transcript.spec.ts` — 上下文选择、信任边界和时序规则。
- `tests/cordis.spec.ts` — 真实的 Cordis 生命周期组合。

行为变更必须附带回归测试（匹配与信任变更需要正反两种测试），并必须通过上述验证命令。完整维护约定请参阅 [`AGENTS.md`](./AGENTS.md)。

## 许可证与安全

- **许可证：** MIT — 见 [`LICENSE`](./LICENSE)。
- **报告安全问题：** 请私下报告，而不是发到公开 issue。请使用仓库上的私有漏洞报告（例如 GitHub Security Advisory），或直接联系维护者，并附上 DSH 版本和组合后的 profile dump。报告及仓库本身都不要包含凭据、会话数据或私有仓库内容。公开该仓库之前，请确认没有提交密钥、个人信息或私有仓库内容。
