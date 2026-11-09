# dsh-session-hub

DeepSeek Harness（DSH）的跨会话工具插件：查看、创建、管理会话，并在会话之间**投递消息、请求处理、等待空闲、搜索内容**。

以 DSH `0.2.2-rc.1` 为目标宿主版本，TypeScript 源码，零运行时依赖（宿主包由 DSH runtime resolution 提供），测试使用 `tsx --test`。

## 概述

插件向宿主注册 10 个工具，覆盖三类能力：

- **查看**：列出任意工作区的会话（workspace、cwd、状态、模型、所有者），读取单个会话的元数据与最近消息，按正文搜索会话。
- **管理**：创建会话、修改标题、切换模型、归档关闭、恢复归档。
- **通信**：向其它会话投递消息（不唤醒）、请求目标立即处理消息（空闲 followup / 运行中 steer）、等待目标空闲并取回最新回复。

## 设计原则：会话是独立个体

- **只留言、不指挥**：`session_send` 只把消息注入目标收件箱（inject），不启动目标、不产生回合、不返回回复。目标是否、何时处理由目标自己的调度决定。
- **需要处理时显式唤醒**：`session_wake` 才请求目标处理消息——空闲时 `followup` 开启新回合，运行中 `steer` 在下一步生效；它不会强杀当前回合。
- **创建时才启动**：`session_create` 的 `message` 必填，创建后立即作为初始任务投递并启动新会话。没有"创建空会话、再等指令"的路径。
- **等待是独立动作**：`session_wait` 只等待目标空闲并读取其最新 assistant 消息，不是请求/响应关联，也不产生消息。
- **读操作不设确认**：`session_list`、`session_get`、`session_search`、`session_wait` 在两种权限模式下都不需要 `confirm`。

## 权限模式

插件在 `apply` 时读取一次 `permissionMode`，整个插件实例内固定；修改配置后需要重启 DSH。

| 模式 | 行为 |
| --- | --- |
| `permissive`（默认） | 不做所有权检查：`session_update` / `session_close` / `session_send` / `session_wake` 可直接操作任意会话。仍然禁止向自身发送、禁止关闭自身。 |
| `owned` | 只有"调用方自己创建"的会话免确认；其它会话或所有权未知的会话，上述四个工具都要求 `confirm: true`。读操作与 `session_open` 不受限制。 |

配置示例（目标 profile 的 `cordis.patch.yml`）：

```yaml
# ~/.dsh/profiles/<name>/cordis.patch.yml（或 $DSH_HOME 对应位置）
- id: tool-session-hub
  name: dsh-session-hub
  config:
    permissionMode: owned   # permissive（默认）| owned
```

- 只有精确的字符串 `owned` 会开启所有权检查；缺省、拼写不符或未知值一律回落到 `permissive`，避免错误配置静默改变权限。
- `confirm` 必须是布尔值 `true`；字符串 `"true"`、数字 `1` 都不算授权。
- 未授权返回 `session-hub: CONFIRM_REQUIRED: session "<id>" is not owned by the calling session`。

权限矩阵（"自己创建"指所有权索引中 `ownerSessionId` 等于调用方会话 id）：

| 操作 | permissive | owned：自己创建 | owned：其它 / 所有权未知 |
| --- | --- | --- | --- |
| `session_list` / `session_get` / `session_search` | 允许 | 允许 | 允许（搜索按 mode 限定范围） |
| `session_create` | 允许 | —（创建新会话） | — |
| `session_update` | 允许 | 允许 | 需 `confirm: true` |
| `session_close` | 允许 | 允许 | 需 `confirm: true` |
| `session_open` | 允许 | 允许 | 允许 |
| `session_send` / `session_wake` | 允许（不能发给自身） | 允许 | 需 `confirm: true` |
| `session_wait` | 允许 | 允许 | 允许 |
| 关闭调用方自身 | 拒绝 | 拒绝 | 拒绝 |

## 工具

所有工具成功时返回纯文本；失败时返回以 `session-hub: ` 开头的文本，不会把异常抛给 agent。

| 工具 | 参数 | 是否唤醒 | 需要 `confirm`（permissive / owned） |
| --- | --- | --- | --- |
| `session_list` | `workspace`（id/标题/路径）、`cwd`、`title_contains`、`owner`（`self`/`any`/会话 id，默认 `any`）、`status`（`running`/`idle`/`blank`/`archived`/`all`，默认 `all`）、`limit`（默认 30，1–200） | 否 | 否 / 否 |
| `session_get` | `session_id`（必填）、`include_recent`（0–20，默认 0） | 否 | 否 / 否 |
| `session_create` | `message`（必填）、`workspace` 或 `cwd`（互斥）、`title`、`agent_preset`、`model`、`provider`、`reasoning_effort` | 是（创建即启动） | 否 / 否 |
| `session_update` | `session_id`（必填）、`title`、`model`、`provider`、`reasoning_effort`、`confirm`（仅 owned） | 否 | 否 / 非自己创建需 `true` |
| `session_close` | `session_id`（必填）、`confirm`（仅 owned） | 停止活动（归档） | 否 / 非自己创建需 `true`；关闭自己总是拒绝 |
| `session_open` | `session_id`（必填） | 否（仅恢复归档） | 否 / 否 |
| `session_send` | `session_id`、`message`（均必填）、`confirm`（仅 owned） | 否（inject） | 否 / 非自己创建需 `true`；发给自身拒绝 |
| `session_wake` | `session_id`、`message`（均必填）、`confirm`（仅 owned） | 是（`followup` / `steer`） | 否 / 非自己创建需 `true`；发给自身拒绝 |
| `session_wait` | `session_id`（必填）、`timeout_ms`（默认 120000，夹紧 1000–600000） | 否（只等待） | 否 / 否 |
| `session_search` | `query`（必填）、`limit`（默认 20，1–50）、`cwd` | 否 | 否 / 否 |

补充说明：

- owned 模式下 `confirm` 才会出现在工具的 JSON Schema 中；permissive 模式不声明该参数。
- 向自身发送（`session_send` / `session_wake`）在所有权检查之前就被拒绝：`session-hub: SELF_TARGET: a session cannot send a message to itself`。`session_wait` 不限制目标。
- 关闭调用方自身在两种模式下都被拒绝：`session-hub: SELF_CLOSE_FORBIDDEN: a session cannot close itself`；`confirm: true` 不能绕过。
- `session_update` 未提供任何更新字段时返回 `session-hub: nothing to update`；`workspace` 与 `cwd` 同时提供时 `session_create` 返回 `session-hub: workspace and cwd are mutually exclusive`。
- `session_create` 省略 `workspace` / `cwd` 时使用调用方 cwd；`provider` / `reasoning_effort` 都要求同时提供 `model`，省略 `provider` 时会在模型目录中解析唯一提供该模型的 provider。
- `session_get` 只统计 user / assistant 消息，每条截断 500 字符。
- `session_list` 的 `owner: self` 表示"调用方自己创建的会话"；`any` 是默认值，不做所有者过滤。
- `session_search` 每个会话只渲染一条最佳命中片段（截断 200 字符），摘要格式为 `共 N 条命中，涉及 M 个会话（显示 K 个）`：N 是宿主原始命中条数，M 是去重后的会话数，K 是实际渲染行数。

## 消息语义

### `session_send`：只投递（inject）

- 消息以 `role: "user"` 进入目标会话，`source` 为 `{ "kind": "agent-message", "form": "relay" }`；已知发送方时还带 `senderSessionId`。
- 正文会被加上归属前缀：`Agent <发送方会话 id> sent a message:\n\n<原消息>`；`session_get` 中显示为 `[user:agent-message] ...`。
- 只调用宿主的 `inject`：目标**不会**因为收到消息而启动，也不会产生回复；返回 `已向会话 <id> 投递消息（不唤醒）`。
- 如果目标当前空闲且没有后续回合，消息会留在收件箱，直到该会话下次运行。
- 归档会话不能直接发送：返回 `session-hub: SESSION_ARCHIVED: ...`，需先 `session_open`。

### `session_wake`：请求处理（followup / steer）

- 目标空闲：通过 `followup` 投递，消息排队并开启一个新回合。
- 目标运行中：通过 `steer` 投递，消息在目标下一步生效，不打断当前步骤。
- 返回文本带投递方式：`已请求会话 <id> 处理消息（idle → followup）` 或 `（running → steer）`。
- 唤醒不等于等待：需要回复时再调用 `session_wait`，或让目标在后续回合自行回传。
- 与 `session_send` 相同的授权、自发送拒绝和归档检查。

### `session_wait`：等待空闲（whenIdle + 超时）

- 通过宿主的 `agent.whenIdle()` 等待目标变为空闲；`timeout_ms` 默认 120000，夹紧到 1000–600000，非法值回落到默认值。
- 变为空闲后读取目标最新的一条 assistant 消息，截断 2000 字符，渲染为 `会话 <id> 已空闲`（有回复时追加 `- reply: ...`）。
- 归档会话立即返回 `会话 <id> 已归档，不会运行`；目标未加载（cold）立即返回 `会话 <id> 空闲（未加载）`。
- 超时返回 `session-hub: WAIT_TIMEOUT: session "<id>" did not become idle within <n>ms`。
- 它不是请求/响应关联：只保证"等待结束时目标空闲"，取回的回复可能来自更早的回合；宿主 agent 没有 `whenIdle` 能力时视为立即空闲。
- 不投递任何消息，不需要 `confirm`，两种模式一致。

## 搜索

- 复用宿主的 `ctx.sessionQuery` 服务（`searchSessions`）：插件只负责构造请求、按会话去重、补齐标题和渲染。
- `permissive`：搜索整个会话索引，不附加 `id` 过滤。
- `owned`：附加 `id` 过滤器，范围 = 调用方自身 + 其创建的会话；调用方 id 不可用时集合为空，直接返回 `没有匹配的会话。`
- 宿主按事件返回命中，同一会话可能重复；插件每个会话只保留第一条（最佳）命中。
- `limit` 默认 20、最大 50；`cwd` 作为精确的 `cwd` 过滤条件传给宿主；`query` 必填。
- 两种模式都不需要 `confirm`；搜索是只读操作。
- 依赖：profile 未挂载 `sessionQuery` 服务时返回 `session-hub: SEARCH_UNAVAILABLE: sessionQuery service is unavailable in this profile`；宿主搜索失败返回 `session-hub: SEARCH_FAILED: <原始错误>`。该服务依赖宿主侧的内容索引（sqlite），索引不可用时搜索同样不可用，其他工具不受影响。

## 所有权索引

`session_create` 会把"创建者 → 新会话"的关系写入插件自己的索引：

```text
${DSH_HOME:-~/.dsh}/storages/session-hub/owners.json
```

未设置 `DSH_HOME` 时，Windows 上默认是 `%USERPROFILE%\.dsh\storages\session-hub\owners.json`。路径在每次读写时解析，设置 `DSH_HOME` 会整体切换索引位置；同一 `DSH_HOME` 下的多个 profile 共用该文件。

文件结构：

```json
{
  "session-abc": {
    "ownerSessionId": "session-parent",
    "createdAt": 1760000000000
  }
}
```

- 只有通过 `session_create` 创建的会话会写入记录；插件启用前已存在的会话没有记录。
- 写入采用"临时文件 + rename"的原子替换，进程内并发写入会串行化。
- 读取时文件缺失、无法解析或结构不合法按空索引处理，不会抛错。
- 索引不自动清理已删除会话，也不跨机器同步；没有跨进程锁，多个 DSH 进程同时写是 last-write-wins。

**丢失后的影响**：删除或损坏索引不会删除 DSH 会话，也不会改变会话内容，但"自己创建"的判断会全部退化为"所有权未知"。在 `owned` 模式下，`session_update` / `session_close` / `session_send` / `session_wake` 对原本自己创建的会话也会要求 `confirm: true`，`session_search` 的范围也会缩到仅调用方自身；`permissive` 模式不受影响。

恢复方式：

1. **直接使用确认（推荐）**：对目标操作传 `confirm: true`，这是设计内的兜底路径。
2. **停止所有 DSH 进程后手工补写** `owners.json`，为每个会话补 `{ "ownerSessionId": "<创建者会话 id>", "createdAt": <毫秒时间戳> }`；运行中手工编辑可能被后续写入覆盖。
3. **重新创建会话**：新会话会正常写入所有权，旧会话仍需按第 1 或第 2 种方式处理。

## 构建、安装与测试

在仓库根目录（或包目录内）：

```bash
pnpm install   # 安装 TypeScript、tsx 与宿主类型包
pnpm check     # tsc --noEmit，检查 src 与 test 类型
pnpm build     # tsc -p tsconfig.build.json，src/ → lib/
pnpm test      # tsx --test，全部 182 个测试
```

安装到指定 profile（`lib/` 已被 gitignore，必须先构建）：

```bash
pnpm build
dsh plugin --profile <name> add link:D:\myprojects\projects\dsh-plugins\packages\session-hub
```

- 安装后需重启 DSH 生效；插件通过 `cordis.patch.yml` 向目标 profile 插入 `tool-session-hub` 行。
- 包入口是 `lib/index.js`，`link:` 安装不会触发构建，缺少 `lib/` 时插件无法加载。
- 更新代码后重新 `pnpm build` 并重启 DSH；权限模式等 host 插件配置也在重启后生效。

## 已知限制

- **归档会话需先恢复**：`session_send` / `session_wake` 不会隐式 `session_open`，归档目标直接返回 `SESSION_ARCHIVED`。
- **不能关闭自己**：两种模式都返回 `SELF_CLOSE_FORBIDDEN`，`confirm: true` 也无法绕过。
- **搜索依赖宿主 sqlite 服务**：`session_search` 依赖 `sessionQuery` 及其内容索引；profile 未提供该服务或索引不可用时返回 `SEARCH_UNAVAILABLE` / `SEARCH_FAILED`。
- **改 Host 插件需重启**：插件在 DSH 启动时加载；修改源码、重新构建或调整 `permissionMode` 后都必须重启 DSH 才能生效。
- **`wait` 不是请求/响应关联**：只等待目标空闲并返回最新 assistant 消息，超时后不撤回任何消息。
- **所有权覆盖不完整**：只记录本插件 `session_create` 创建的会话；插件启用前存在的会话永远需要 `confirm`（owned 模式）。
- **索引会累积且无跨进程锁**：已删除会话的记录不会自动清理；多个 DSH 进程写同一 `DSH_HOME` 时可能互相覆盖。
- **输出为纯文本且截断**：列表最多 200 行；`session_get` 最近消息最多 20 条、每条 500 字符；`session_wait` 回复最多 2000 字符；`session_search` 片段最多 200 字符，且没有结构化输出字段。
- **依赖宿主服务**：某些 profile 可能不提供 `sessionController`、`workspaceController` 或 `sessionQuery`，相关工具会返回服务不可用的错误文本。
- **`steer` 会影响正在运行的回合**：消息插入目标下一步，可能改变其当前任务走向。
- **没有发送预算**：不限制消息条数、频率或目标数量，需要节制时由调用方自行控制。
- **`confirm` 不是安全边界**：它只用于防止误操作，不能阻止有意操作。

## 与 Codex 协作工具的对应关系

| Codex 工具 | session-hub 工具 | 说明 |
| --- | --- | --- |
| `spawn_agent` | `session_create` | `message` 必填，创建后立即启动新会话并记录所有权。 |
| `send_message` | `session_send` | 只投递（inject），不唤醒目标、不等待回复。 |
| `followup_task` | `session_wake` | 空闲目标 `followup` 开启新回合；运行中目标 `steer` 在下一步生效。 |
| `wait_agent` | `session_wait` | 等待目标空闲（默认 120s，夹紧 1s–600s），取回最新 assistant 回复。 |
| （列表 / 查看） | `session_list` / `session_get` | 定位会话 id、查看元数据与最近消息。 |
| （无直接对应） | `session_search` / `session_close` / `session_open` / `session_update` | 内容搜索、归档管理、标题与模型修改。 |

## 许可证

[MIT](../../LICENSE)
