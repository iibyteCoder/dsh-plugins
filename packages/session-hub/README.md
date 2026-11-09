# dsh-session-hub

DeepSeek Harness（DSH）的跨会话工具插件：查看、创建、管理会话，并在会话之间发送消息或打断回合。

插件以 DSH `0.2.2-rc.1` 为目标宿主版本，零运行时依赖，测试使用 Node.js 内置的 `node --test`。

## 功能概述

- **查看**：列出任意工作区的会话（workspace、cwd、状态、模型、所有者），读取单个会话的元数据与最近消息。
- **创建**：在指定 workspace 或 cwd 下创建会话，可选设置标题、agent preset、模型和首条消息；调用方会被记录为新会话的所有者。
- **管理**：修改标题、切换模型、关闭（归档并停止活动）以及恢复会话。
- **通信**：向其它会话投递消息（`queue` 或 `steer`），可选择等待目标空闲并取回最新回复；打断目标会话的当前回合。

## 适用场景

- 从一个主会话创建并编排多个子会话，例如按任务拆分工作目录或 agent preset。
- 在多个工作区之间查找会话，确认某个会话的 cwd、状态和最近消息。
- 向另一个会话派发任务，并用 `wait: true` 等待它完成当前回合后读取回复。
- 整理长期运行的会话：关闭不再需要的会话，之后按需恢复。
- **不适用**：它不是 DSH 的权限边界或沙箱。`confirm` 只用于防止误操作，不能阻止有意操作；也不提供发送配额、审计或多进程协调。

## 工具

所有工具成功时返回纯文本，失败时返回以 `session-hub: ` 开头的文本，不会让异常穿透到 agent。

| 工具 | 参数摘要 | 是否需要 `confirm` |
| --- | --- | --- |
| `session_list` | `workspace`（id/标题/路径）、`cwd`、`title_contains`、`owner`（`self`/`any`/会话 id，默认 `any`）、`status`（`running`/`idle`/`blank`/`archived`/`all`，默认 `all`）、`limit`（默认 30，最大 200） | 否 |
| `session_get` | `session_id`（必填）、`include_recent`（0–20，默认 0） | 否 |
| `session_create` | `workspace` 与 `cwd` 互斥；`title`、`agent_preset`、`model`、`provider`、`reasoning_effort`、`initial_message` 均可选。未指定位置时使用调用方 cwd | 否 |
| `session_update` | `session_id`（必填）、`title`、`model`、`provider`、`reasoning_effort`、`confirm`；标题和模型至少提供一项 | 仅当目标不是自己创建的会话 |
| `session_close` | `session_id`（必填）、`confirm` | 关闭自己创建的会话不需要；关闭调用方自身或其它会话需要 |
| `session_open` | `session_id`（必填） | 否（幂等） |
| `session_send` | `session_id`、`message`（均必填）、`mode`（`queue`/`steer`，默认 `queue`）、`wait`（默认 `false`）、`timeout_ms`（默认 120000，限制 1000–600000）、`confirm` | 仅当目标不是自己创建的会话；不能发送给自身 |
| `session_interrupt` | `session_id`（必填）、`confirm` | 仅当目标不是自己创建的会话 |

补充说明：

- `confirm` 必须是布尔值 `true`；字符串 `"true"`、数字 `1` 等都不算授权。
- 未授权时返回 `session-hub: CONFIRM_REQUIRED: ...`。
- `session_list` 的 `owner` 过滤中，`self` 表示调用方自己创建的会话；`any` 是默认值，不做所有者过滤。
- `session_get` 的 `include_recent` 只统计 user/assistant 消息，每条截断 500 字符，最多 20 条。
- `session_update` 不提供任何可更新字段时返回 `session-hub: nothing to update`。
- `session_create` 的 `provider` 和 `reasoning_effort` 都要求同时提供 `model`；省略 `provider` 时会在模型目录中解析唯一提供该模型的 provider。

## 权限矩阵

“自己”指调用方会话自身；“自己创建”指索引中 `ownerSessionId` 等于调用方会话 id；“其它会话”包含索引中没有记录、记录损坏或属于其它会话的情况。

| 工具 | 自己 | 自己创建的会话 | 其它会话 / 所有权未知 |
| --- | --- | --- | --- |
| `session_list` | 允许 | 允许 | 允许（可查看所有工作区） |
| `session_get` | 允许 | 允许 | 允许 |
| `session_create` | —（创建新会话） | — | — |
| `session_update` | 需 `confirm` | 允许 | 需 `confirm` |
| `session_close` | 需 `confirm` | 允许 | 需 `confirm` |
| `session_open` | 允许 | 允许 | 允许 |
| `session_send` | 拒绝（`SELF_TARGET`） | 允许 | 需 `confirm` |
| `session_interrupt` | 需 `confirm` | 允许 | 需 `confirm` |

关键规则：

- 所有权未知时一律按“不是调用方创建的”处理，必须 `confirm: true`；未知不会自动授予权限。
- 关闭调用方自身始终需要 `confirm`。
- 发送给自身在所有权检查之前就会被拒绝；`session_interrupt` 则允许在确认后打断自身。
- 归档会话不能直接发送消息，需先调用 `session_open`。

## 所有权与索引

所有权由插件自己维护，记录在：

```
${DSH_HOME:-~/.dsh}/storages/session-hub/owners.json
```

未设置 `DSH_HOME` 时，Windows 上默认即 `%USERPROFILE%\.dsh\storages\session-hub\owners.json`。路径在每次读写时解析，因此设置 `DSH_HOME` 会整体切换该索引的位置。

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
- 写入采用“临时文件 + rename”的原子替换，进程内的并发写入会串行化，避免产生半写文件。
- 读取时缺失、无法解析或结构不合法的文件按空索引处理，不会抛错。
- 索引不会自动清理已删除的会话条目，也不跨机器同步；位置由 `DSH_HOME` 决定、与 profile 无关，因此同一 `DSH_HOME` 下的多个 profile 共用该文件。

### 索引丢失后如何重建

索引只是插件本地状态，删除或损坏它不会删除 DSH 会话本身，也不会改变会话内容。丢失后有三种处理方式：

1. **直接使用确认（推荐）**：对每个目标会话的操作传入 `confirm: true`。这是插件设计的兜底路径，无需重建文件。
2. **重新创建会话**：通过 `session_create` 新建会话，所有权会自动写入；旧会话仍需按第 1 或第 3 种方式处理。
3. **手工恢复条目**：在所有 DSH 进程停止时编辑 `owners.json`，为每个会话补写 `{ "ownerSessionId": "<创建者会话 id>", "createdAt": <毫秒时间戳> }`。`createdAt` 仅作记录，可省略。插件没有跨进程锁，运行中手工编辑可能被后续写入覆盖，因此务必先停止所有会写该文件的 DSH 进程。

手工恢复后可用 `session_list` 的 `owner: self` 过滤验证：只有 `ownerSessionId` 等于当前调用方 id 的会话会出现在结果中。

## 消息归属与 `wait` 语义

- 投递的消息以 `role: "user"` 的消息进入目标会话，`source` 为 `{ "kind": "agent-message", "form": "relay" }`；已知发送方时还会带上 `senderSessionId`。
- 消息正文会被加上归属前缀：`Agent <发送方会话 id> sent a message:\n\n<原消息>`。`session_get` 的最近消息会显示为 `[user:agent-message] ...`。
- `mode: "queue"`（默认）通过宿主的 `followup` 投递，在目标会话下一回合处理；`mode: "steer"` 通过 `steer` 投递，在目标会话下一步生效。
- `wait` 默认 `false`：消息交给目标后立即返回投递结果，不等目标处理。
- `wait: true`：等待目标 agent 变为空闲，然后读取目标最新的 assistant 消息并追加 `- reply: ...`（最多 2000 字符）。等待超时返回 `session-hub: WAIT_TIMEOUT: message delivered but the session did not become idle`；此时消息**已经投递**，无法撤回。
- `timeout_ms` 只在 `wait: true` 时生效，默认 120000，非法值回落到默认值，有效范围被限制在 1000–600000。
- 如果宿主 agent 没有 `whenIdle` 能力，`wait: true` 会退化为立即返回投递结果，不会阻塞。
- `wait` 等待的是“目标变空闲”，并不保证取回的回复一定对应刚发送的消息；它只是目标会话最新的一条 assistant 消息。
- `session_create` 的 `initial_message` 固定按 `queue`、`wait: false` 投递，并使用创建方会话作为发送方；投递失败只会在创建结果中单独报告，不会让创建本身失败。
- 发送给归档会话返回 `session-hub: SESSION_ARCHIVED: ...`，需先 `session_open`。

## 要求

- DSH `0.2.2-rc.1`（宿主服务接口以该版本为准）。
- Node.js >= 20。
- 无运行时依赖：本包**不声明** `dependencies` 或 `peerDependencies`。宿主包由 DSH 的 runtime resolution 在运行时提供；若声明依赖，包管理器会安装独立副本并遮蔽宿主实例，导致插件与宿主使用的不是同一份模块。

## 安装

```powershell
dsh plugin --profile <name> add link:D:\myprojects\projects\dsh-plugins\packages\session-hub
```

安装后需重启 DSH 生效。插件以 `cordis.patch.yml` 向目标 profile 插入 `tool-session-hub` 插件行。

## 开发与测试

在包目录运行全部测试：

```powershell
cd D:\myprojects\projects\dsh-plugins\packages\session-hub
node --test
```

在仓库根目录运行：

```powershell
node --test packages/session-hub/test/
```

当前共 127 个测试，覆盖工具注册、schema 约束、所有权索引、权限确认、列表/详情格式化、消息投递与打断等行为。测试使用伪造的宿主 context，不依赖真实 DSH 进程，也不需要安装依赖。

CI 在 `ubuntu-latest` 上用 Node 20 和 22 执行 `node --test packages/session-hub/test/`。

## 已知限制

- **没有发送预算**：不限制消息条数、频率或目标数量，每次调用都会实际投递；需要节制时由调用方自行控制。
- **跨工作区可操作，不是隔离机制**：`session_list`/`session_get` 可查看所有工作区，`session_create` 可在任意 workspace/cwd 创建，发送和打断也可跨工作区进行。`confirm` 是防误操作，不是安全边界。
- **归档会话需先恢复**：`session_send` 不会隐式调用 `session_open`，归档目标会直接返回 `SESSION_ARCHIVED`。
- **所有权覆盖不完整**：仅记录由本插件 `session_create` 创建的会话；插件启用前存在的会话永远需要 `confirm`。
- **索引会累积**：已删除会话的记录不会自动清理，长期使用后 `owners.json` 可能包含失效条目；手工清理时不要破坏 JSON 结构。
- **无跨进程锁**：索引写入只在单个进程内串行化；多个 DSH 进程同时写同一 `DSH_HOME` 时是 last-write-wins。
- **`wait` 不是请求/响应关联**：只等待目标空闲并返回最新 assistant 消息，超时后消息已投递且不可撤回。
- **输出为纯文本且截断**：列表最多 200 行；`session_get` 最近消息最多 20 条、每条 500 字符；回复最多 2000 字符。没有结构化输出字段。
- **依赖宿主服务**：某些 profile 可能不提供 `sessionController` 或 `workspaceController`，相关工具会返回服务不可用的错误文本。
- **`steer` 会影响正在运行的回合**：消息插入目标下一步，可能改变其当前任务走向；对非自己创建的会话应先确认。

## 许可证

[MIT](../../LICENSE)
