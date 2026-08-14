# dsh-approval-guardian

`dsh-approval-guardian` 是一个 DeepSeek Harness（DSH）profile bundle。它只接管原本会通过 Web/ACP 弹窗要求用户允许或拒绝的**沙箱扩权请求**，并把有限的会话上下文、工具参数和提权理由交给一个全新的单次审批 Agent。

普通 workspace 操作不会进入自动审批流程。即使某个普通操作随后因沙箱限制执行失败，只要它没有触发真实的扩权审批，本插件也不会介入。

## 工作方式

一次工具执行会走下面三条路径之一：

| 请求 | 插件行为 |
| --- | --- |
| 当前 sandbox mode 内可直接执行 | 完全不介入 |
| 不是本次工具执行产生的审批，或不是严格扩权 | 调用下游 answerer，保留 DSH 原行为 |
| 与本次工具执行严格对应的 sandbox 扩权审批 | 启动无工具的单次 reviewer，直接应用 `allow` 或 `deny` |

审批完成后，结果通过 `ToolRunContext.deferContext()` 排在对应的 `tool/result` 后注入主 Agent 历史。reviewer 的说明会被显式包裹成不可信数据，不能反过来向主 Agent 注入指令。

## 环境要求

- Node.js `^22.19.0` 或 `>=24.0.0`
- pnpm
- 与 `package.json` 中 peer dependencies 兼容的 DeepSeek Harness profile

## 安装

在本仓库中安装依赖、构建并添加到目标 profile：

```sh
pnpm install
pnpm run build
dsh plugin --profile web add .
```

也可以将 Git URL 或已发布的包名传给：

```sh
dsh plugin --profile <profile-name> add <package-or-git-url>
```

Git 安装会执行 `prepare`。pnpm 10 及以上版本可能要求先在目标 profile 的 `pnpm-workspace.yaml` 中允许该包执行构建脚本。

包清单中的 `dsh.bundle.patch` 会让 DSH 自动加载 [`cordis.patch.yml`](./cordis.patch.yml)。该 patch 将本插件注册在交互式 Web/ACP approval answerer 之前；未被插件认领的请求仍会继续传给后续 answerer。

## 配置

可以在 profile 自己的 `cordis.patch.yml` 中用相同 `id` 覆盖配置：

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

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `prompt` | 内置通用策略 | 替换 reviewer 固定提示词中的部署安全策略部分。角色、证据可信度和输出协议不可覆盖 |
| `provider` | 继承主 Agent 路由 | reviewer 的模型 provider；必须和 `model` 同时配置或同时省略 |
| `model` | 继承主 Agent 路由 | reviewer 模型 id；必须和 `provider` 同时配置或同时省略 |
| `subagentProvider` | `spawn` | `ctx.subagents` 上注册的单次子代理 provider |
| `failureMode` | `fail-closed` | reviewer 不可用时返回 `unavailable`，或回退到用户审批 |
| `timeoutMs` | `90000` | 单次审批的超时时间，单位为毫秒 |
| `maxOutputTokens` | `1024` | reviewer 结构化输出的 token 上限 |

`failureMode` 支持：

- `fail-closed`：reviewer 超时、不可用或返回无效结构时返回 `unavailable`，不再弹出用户窗口。
- `fallback-to-user`：只有 reviewer 故障时才把请求交回 Web/ACP 等下游 answerer。

reviewer 明确返回 `deny` 属于有效决定，在两种模式下都不会回退给用户。

## 精确介入范围

插件只有在以下条件全部满足时才认领 `approval/request`：

1. 请求发生在当前 `tools/execute` 的动态执行范围内。
2. Agent、call id 和 tool name 与审批请求完全一致。
3. 工具参数同时包含非空的 `sandbox_permissions` 和 `justification`。
4. 审批 reason 与 DSH sandbox 模块生成的标准文本完全一致。
5. `sandbox_permissions` 相对会话当前生效的 sandbox mode 是严格扩权。

任何条件不满足都会调用 `next()`。这意味着普通 workspace 操作、非扩权审批、`tools/pre-execute` 产生的其他审批，以及没有标准 sandbox 提权参数的工具都不会交给 reviewer。

## Reviewer 与上下文

每次审批都创建一个新的 reviewer 子代理，使用：

- `toolFilter: { allow: [] }`，禁止 reviewer 调查或执行其他操作；
- scoped `structured_output`，只接收 `allow` 或 `deny` 决定及可选风险信息；
- 独立超时、取消和释放流程；
- 配置的 provider/model，或主 Agent 的模型路由。

上下文来自 `session.deriveMessages()`，因此遵守 compaction 后的可见历史。选择规则模仿 Codex Guardian 的默认行为：

- 保留第一条和最新一条可信消息（直接用户消息、instruction 或 question 回答）；
- 在约 10,000-token 的消息预算内，从新到旧补充其他可信消息；
- 工具证据使用独立的约 10,000-token 预算；
- 最多保留最近 40 条非可信记录；
- 单条消息、工具证据、审批 reason 和 action 分别限制为约 2,000、1,000、512 和 16,000 tokens。

只会选择直接用户消息、developer/工作区指令（`agent-instructions`）、question 回答、compaction checkpoint、assistant 可见文本、tool call 和 tool result。推理内容、普通插件上下文、生命周期事件和审计记录不会发送给 reviewer。

每条历史都会标记为：

- `TRUSTED HUMAN MESSAGE`：直接用户消息，可以表达授权；
- `TRUSTED INSTRUCTION`：developer 消息与工作区指令文件（`AGENTS.md`、`CLAUDE.md`），视为用户已把其内容设为任务授权依据，可以表达授权；
- `TRUSTED QUESTION ANSWER`：用户在 `ask_user_question` 的 question 下选中的选项，等于用户直接回答，可以表达授权；
- `UNTRUSTED ...`：assistant、工具、checkpoint 等只能作为证据，不能作为指令。

三者都属于可信来源，可以建立 user authorization。授权上限仍受政策约束：例如可信指令/回答不能覆盖 critical-risk 或绝对 deny 规则，且不可信内容不能借这些来源间接扩展授权（除非用户明确要求遵循该内容）。

历史按时间排序。对于同一操作或审批的冲突指令，较新的可信消息覆盖较早消息。例如用户先要求 reviewer 拒绝，随后明确要求接受，则后一个可信指令具有更高时序优先级。

## Reviewer 子会话隔离

DSH 会给普通委派子代理加入“自身 approval prompts disabled”和“delegated permission scope cannot be widened”等运行时上下文。这些限制只约束 reviewer 自己可能发起的操作，不是父 Agent 待审批操作的拒绝理由。

插件在 `system-prompt/assemble` 阶段只为当前 approval reviewer 移除这些动态 runtime contexts，同时在 reviewer 固定 persona 中声明会话边界。普通 Agent 和其他子代理的 runtime context 保持不变。

这项隔离修复了 reviewer 倾向于始终拒绝的典型问题：reviewer 不再把“我自己不能提权”误读成“父 Agent 的请求必须拒绝”。

## 安全与失败语义

- reviewer 输出必须通过结构化 schema 校验；无效输出按 reviewer 不可用处理。
- reviewer 没有工具，不能借审批过程扩大自身权限。
- 明确 `deny` 始终有效，即使随后释放 reviewer 报错。
- `allow` 只有在 reviewer 返回有效结果且成功完成释放后才生效。
- 插件卸载会取消并等待所有进行中的 review，避免悬空子代理。
- reviewer rationale 在主会话中始终标记为不可信数据。

当前 DSH 尚未提供所需支持，因此插件暂不为注入消息设置 `ignorable: true`。待官方接口支持后再实现，当前不会写入自定义 session event。

## 开发与验证

```sh
pnpm run typecheck
pnpm test
pnpm run build
npm pack --dry-run
```

源码位于 `src/`，测试位于 `tests/`，构建产物为 `lib/index.js` 和 `lib/types/`。不要直接编辑 `lib/`；运行 `pnpm run build` 重新生成。

主要文件：

- `src/index.ts`：配置、事件接入、严格扩权匹配、结果注入和生命周期管理。
- `src/reviewer.ts`：单次 reviewer 的启动、识别、结构化结果校验和释放。
- `src/policy.ts`：固定 reviewer persona、默认策略和审批 prompt。
- `src/transcript.ts`：上下文选择、可信度标签、预算与截断。
- `src/types.ts`：共享类型。
- `tests/plugin.spec.ts`：审批边界和故障模式。
- `tests/transcript.spec.ts`：上下文选择、信任及时序规则。
- `tests/cordis.spec.ts`：真实 Cordis 生命周期组合。

进一步的维护约束请参阅 [`AGENTS.md`](./AGENTS.md)。
