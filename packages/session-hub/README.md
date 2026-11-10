# dsh-session-hub

DeepSeek Harness（DSH）的跨会话工具插件：查看、创建、管理会话，并在会话之间**投递消息、请求处理、等待空闲、搜索内容**。

以 DSH `0.2.2-rc.1` 为目标宿主版本，TypeScript 源码；除宿主 runtime resolution 提供的 `@deepseek-ai/schemastery` 外无运行时依赖。测试使用 `tsx --test`。

## 概述

插件向宿主注册 10 个工具，覆盖三类能力：

- **查看**：列出会话（workspace、cwd、状态、模型、所有者），读取单个会话的元数据与最近消息，按正文搜索会话。
- **管理**：创建会话、修改标题、切换模型、归档关闭、恢复归档。
- **通信**：向其它会话投递消息（不唤醒）、请求目标立即处理消息（空闲 followup / 运行中 steer）、等待目标空闲并取回最新回复。

每个工具都有独立的细粒度策略（`scope` / `targets` / `confirm` / `allowSelf` / `limit` …），在目标 profile 的 `cordis.patch.yml` 中配置；未配置时使用下表的历史默认行为。

## 设计原则：会话是独立个体

- **只留言、不指挥**：`session_send` 只把消息注入目标收件箱（inject），不启动目标、不产生回合、不返回回复。目标是否、何时处理由目标自己的调度决定。
- **需要处理时显式唤醒**：`session_wake` 才请求目标处理消息——空闲时 `followup` 开启新回合，运行中默认 `steer` 在下一步生效（可配置为排队）；它不会强杀当前回合。
- **创建时才启动**：`session_create` 的 `message` 默认必填，创建后立即作为初始任务投递并启动新会话；配置 `task: optional` 后可创建不启动的空会话。
- **等待是独立动作**：`session_wait` 只等待目标空闲并读取其最新 assistant 消息，不是请求/响应关联，也不产生消息。
- **读操作默认不设确认**：`session_list`、`session_get`、`session_search` 不读 `confirm`；`session_wait` 默认也不需要确认，但配置为 `confirm: non-owned` / `always` 时会要求。

## 配置

配置写在**目标 profile 的** `cordis.patch.yml`，覆盖 `tool-session-hub` 这一行的 `config`：

```text
~/.dsh/profiles/desktop/cordis.patch.yml
```

（设置了 `DSH_HOME` 时为 `$DSH_HOME/profiles/<name>/cordis.patch.yml`。）

```yaml
- id: tool-session-hub
  config:
    tools:
      session_list:
        scope: workspace      # 只看调用方 cwd 的会话
        limit: 50
        status: running
      session_search:
        scope: owned          # 只看自己创建的会话
        limit: 10
      session_send:
        confirm: non-owned    # 非自己创建的会话需要 confirm: true
        allowArchived: false
      session_wake:
        whenRunning: queue    # 运行中的目标改为排队，而不是 steer
        attribution: false    # 正文不加 "Agent <id> sent a message:" 前缀
      session_create:
        task: optional
        workspace: allowlist
        allowTitle: false
        allowModel: false
      session_wait:
        timeoutMaxMs: 60000
        reply: true
        replyMaxChars: 4000
    ownership:
      record: true
    filters:
      denyWorkspaces: ["scratch", "tmux"]
      allowSessions: []
```

- **HMR 热重载**：DSH 监听 profile 配置变化，修改 `cordis.patch.yml` 后无需重启；若宿主没有拾取到，再重启 DSH。
- **`enabled: false` 的工具直接消失**：模型工具表里不再出现该工具，调用会得到“未知工具”，而不是运行时报错。
- **没有 settings UI**：插件不注册任何设置页/设置工具，配置的唯一入口是 YAML 文件。
- **非法值回退默认，不抛异常**：字段类型或取值不合法时，该字段回退到该工具的默认值，其余字段不受影响。
- 构建后的 `lib/` 会保留一条运行时 import `@deepseek-ai/schemastery`，由 DSH runtime resolution 提供；其它 `@deepseek-ai/*` 仍然只是类型 import。

### 每工具字段

| 字段 | 取值 | 默认 | 作用 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | `false` 时不注册该工具 |
| `scope` | `all` / `workspace` / `owned` | `all` | 读范围：全部 / cwd 与调用方相同 / owner 为调用方 |
| `targets` | `owned` / `any` | `any` | 写目标：必须是调用方创建的 / 任意 |
| `confirm` | `never` / `non-owned` / `always` | `never` | 何时要求 `confirm: true` |
| `allowSelf` | boolean | `false` | 是否允许目标是调用方自己（`send` / `wake` / `close` / `update`） |
| `allowArchived` | boolean | `false` | 是否允许 `send` / `wake` 直接作用于归档会话 |
| `attribution` | boolean | `true` | 消息正文是否加 `Agent <id> sent a message:` 前缀 |
| `whenRunning` | `steer` / `queue` | `steer` | `wake` 遇到运行中目标：steer 下一步 / followup 排队 |
| `task` | `required` / `optional` | `required` | `create` 是否必须提供初始 `message` |
| `workspace` | `any` / `same` / `allowlist` | `any` | `create` 允许的工作区范围 |
| `allowTitle` | boolean | `true` | `false` 时 `create` 不暴露/不应用 `title` |
| `allowModel` | boolean | `true` | `false` 时 `create` 不暴露/不应用模型参数 |
| `limit` | 1–200 | `30` | `session_list` / `session_search` 的默认条数 |
| `recent` | 0–50 | `10` | `session_get` 默认包含的最近消息条数 |
| `status` | `all` / `running` / `idle` / `blank` / `archived` | `all` | `session_list` 默认状态过滤 |
| `timeoutMaxMs` | 1000–600000 | `120000` | `session_wait` 的默认等待预算，也是单次上限 |
| `reply` | boolean | `true` | `false` 时 `session_wait` 不读取回复 |
| `replyMaxChars` | 1–10000 | `2000` | `session_wait` 回复截断长度 |

数值字段还有各工具自己的运行上限：`session_search.limit` 最多 50（后端只取一页），`session_list.limit` 最多 200，`recent` 最多 50。

### 每工具默认行为

未配置时，各工具等价于：

| 工具 | 默认 |
| --- | --- |
| `session_list` | enabled，`scope: all`，`limit: 30`，`status: all` |
| `session_get` | enabled，`scope: all`，`recent: 10` |
| `session_search` | enabled，`scope: all`，`limit: 20` |
| `session_create` | enabled，`task: required`，`workspace: any`，`allowTitle/allowModel: true` |
| `session_update` | enabled，`targets: any`，`confirm: never`，`allowSelf: true` |
| `session_close` | enabled，`targets: any`，`confirm: never`，`allowSelf: false` |
| `session_open` | enabled，`targets: any`，`confirm: never` |
| `session_send` | enabled，`targets: any`，`confirm: never`，`allowSelf: false`，`allowArchived: false`，`attribution: true` |
| `session_wake` | enabled，`targets: any`，`confirm: never`，`allowSelf: false`，`allowArchived: false`，`whenRunning: steer`，`attribution: true` |
| `session_wait` | enabled，`timeoutMaxMs: 120000`，`reply: true`，`replyMaxChars: 2000` |
| `ownership.record` | `true` |
| `filters` | 全空 |

### 语义细节

- **`targets: owned`**：目标必须出现在插件所有权索引里且 `ownerSessionId` 等于调用方；否则返回 `session-hub: TARGET_NOT_ALLOWED: ...`。`targets: any` 不检查所有权。
- **`confirm`**：`never` 从不要求；`non-owned` 在目标 owner 不等于调用方（含所有权未知）时要求；`always` 总是要求。只有布尔 `true` 算确认，字符串 `"true"`、数字 `1` 都不算。
- **`allowSelf: false`**：目标是调用方自己时直接拒绝。`send` / `wake` / `update` 返回 `SELF_TARGET`，`close` 返回 `SELF_CLOSE_FORBIDDEN`；`wait` / `open` 不读该字段。
- **`allowArchived: false`**：`send` / `wake` 对归档会话返回 `SESSION_ARCHIVED`，需先 `session_open`；`wait` 不读该字段，仍返回「已归档，不会运行」。
- **`scope`**（读）：`all` 全部；`workspace` 只保留 cwd 与调用方 cwd 相同的会话（调用方 cwd 未知时为空）；`owned` 只保留 owner 为调用方的会话（调用方自己的会话若没有索引记录，也不在 `owned` 范围内）。`session_get` 目标不在范围内时返回 `session-hub: SCOPE_DENIED: ...`；`session_list` / `session_search` 直接不返回该会话。
- **`filters`**：`denySessions` / `denyWorkspaces` 优先，命中即排除；设置了任一 allow 列表时，会话必须命中 `allowSessions` 或位于 `allowWorkspaces` 中的工作区才放行；两个 allow 列表都为空表示不限制。工作区匹配支持 id、大小写不敏感的标题、归一化路径。
- **`create.task: optional`**：`message` 可省略；省略时创建会话但不投递、不唤醒，返回 `- started: 未提供初始任务（未唤醒）`。
- **`create.workspace`**：`any` 任意；`same` 目标 cwd 必须等于调用方 cwd；`allowlist` 的目标工作区或 cwd 必须落在 `filters.allowWorkspaces` 中（工作区按 id/标题/路径匹配，cwd 按路径包含判断）。
- **`create.allowTitle` / `allowModel`**：为 `false` 时参数不出现在工具 schema 中；调用方即使传入也会被忽略。
- **`attribution: false`**：消息正文不再加前缀，但 `source` 仍保留 `{ kind: "agent-message", form: "relay", senderSessionId }`。
- **`whenRunning`**：`steer`（默认）在目标下一步插入消息；`queue` 走 `followup`，排队到下一轮。空闲目标始终 `followup`。
- **`wait.timeoutMaxMs`**：既是默认等待预算，也是单次上限；`timeout_ms` 会被夹到 `1000..timeoutMaxMs`。`reply: false` 时完全不读目标日志；`replyMaxChars` 控制返回回复的截断长度。
- **`ownership.record`**：`false` 时 `session_create` 不写 `owners.json`，返回 `- owner: 未记录（ownership.record 已关闭）`。

## 工具

所有工具成功时返回纯文本；失败时返回以 `session-hub: ` 开头的文本，不会把异常抛给 agent。

| 工具 | 参数 | 是否唤醒 | 默认 `confirm` |
| --- | --- | --- | --- |
| `session_list` | `workspace`（id/标题/路径）、`cwd`、`title_contains`、`owner`（`self`/`any`/会话 id，默认 `any`）、`status`（默认取配置）、`limit`（默认取配置，最大 200） | 否 | 不需要 |
| `session_get` | `session_id`（必填）、`include_recent`（默认取配置，0–50） | 否 | 不需要 |
| `session_create` | `message`（默认必填）、`workspace` 或 `cwd`（互斥）、`title`、`agent_preset`、`model`、`provider`、`reasoning_effort` | 是（创建即启动） | 不需要 |
| `session_update` | `session_id`（必填）、`title`、`model`、`provider`、`reasoning_effort`、`confirm`（按策略出现） | 否 | `never` |
| `session_close` | `session_id`（必填）、`confirm`（按策略出现） | 停止活动（归档） | `never` |
| `session_open` | `session_id`（必填）、`confirm`（按策略出现） | 否（仅恢复归档） | `never` |
| `session_send` | `session_id`、`message`（均必填）、`confirm`（按策略出现） | 否（inject） | `never` |
| `session_wake` | `session_id`、`message`（均必填）、`confirm`（按策略出现） | 是（`followup` / `steer`） | `never` |
| `session_wait` | `session_id`（必填）、`timeout_ms`（默认/上限取配置）、`confirm`（按策略出现） | 否（只等待） | `never` |
| `session_search` | `query`（必填）、`limit`（默认取配置，最大 50）、`cwd` | 否 | 不需要 |

补充说明：

- `confirm` 只在 `confirm: non-owned` / `always` 时出现在工具的 JSON Schema 中；`never` 不声明该参数。
- 向自身发送（`session_send` / `session_wake`）默认在所有权检查之前就被拒绝：`session-hub: SELF_TARGET: a session cannot send a message to itself`。配置 `allowSelf: true` 后允许。
- 关闭调用方自身默认被拒绝：`session-hub: SELF_CLOSE_FORBIDDEN: a session cannot close itself`；`close.allowSelf: true` 后允许，`confirm: true` 本身不能绕过该默认。
- `session_update` 未提供任何更新字段时返回 `session-hub: nothing to update`；`workspace` 与 `cwd` 同时提供时 `session_create` 返回 `session-hub: workspace and cwd are mutually exclusive`。
- `session_create` 省略 `workspace` / `cwd` 时使用调用方 cwd；`provider` / `reasoning_effort` 都要求同时提供 `model`，省略 `provider` 时会在模型目录中解析唯一提供该模型的 provider。
- `session_get` 只统计 user / assistant 消息，每条截断 500 字符。
- `session_get` 通过 `sessions`（live 会话）或 `sessionQuery.observeSession`（cold 会话）读取会话头与事件；读取失败返回 `session-hub: GET_FAILED: <原始错误>`，不再把任何失败都伪装成 `not found`。
- `session_list` 的 `owner: self` 表示“调用方自己创建的会话”；`any` 是默认值，不做所有者过滤。
- `session_search` 每个会话只渲染一条最佳命中片段（截断 200 字符），摘要格式为 `共 N 条命中，涉及 M 个会话（显示 K 个）`：N 是宿主原始命中条数，M 是去重后的会话数，K 是实际渲染行数。

## 消息语义

### `session_send`：只投递（inject）

- 消息以 `role: "user"` 进入目标会话，`source` 为 `{ "kind": "agent-message", "form": "relay" }`；已知发送方时还带 `senderSessionId`。
- 默认正文带归属前缀：`Agent <发送方会话 id> sent a message:\n\n<原消息>`；`attribution: false` 时只保留原消息。`session_get` 中显示为 `[user:agent-message] ...`。
- 只调用宿主的 `inject`：目标**不会**因为收到消息而启动，也不会产生回复；返回 `已向会话 <id> 投递消息（不唤醒）`。
- 如果目标当前空闲且没有后续回合，消息会留在收件箱，直到该会话下次运行。
- 归档会话默认不能直接发送：返回 `session-hub: SESSION_ARCHIVED: ...`，需先 `session_open`；`allowArchived: true` 可跳过该门禁。

### `session_wake`：请求处理（followup / steer）

- 目标空闲：通过 `followup` 投递，消息排队并开启一个新回合。
- 目标运行中：默认通过 `steer` 投递，消息在目标下一步生效，不打断当前步骤；`whenRunning: queue` 时改用 `followup` 排队到下一轮。
- 返回文本带投递方式：`已请求会话 <id> 处理消息（idle → followup）`、`（running → steer）` 或 `（running → followup）`。
- 唤醒不等于等待：需要回复时再调用 `session_wait`，或让目标在后续回合自行回传。
- 与 `session_send` 相同的授权、自发送拒绝和归档检查（由各自的策略决定）。

### `session_wait`：等待空闲（whenIdle + 超时）

- 通过宿主的 `agent.whenIdle()` 等待目标变为空闲；`timeout_ms` 默认取 `timeoutMaxMs`（默认 120000），夹紧到 `1000..timeoutMaxMs`，非法值回落到默认值。
- 变为空闲后读取目标最新的一条 assistant 消息，按 `replyMaxChars` 截断，渲染为 `会话 <id> 已空闲`（有回复时追加 `- reply: ...`）。
- `reply: false` 时完全不读取回复，只返回空闲状态。
- 回复与会话头使用与 `session_get` 相同的读取路径：live 会话读 `sessions`，cold 会话读 `sessionQuery.observeSession`；读取失败时仍返回空闲状态，只是不再附带 `- reply`。
- 归档会话立即返回 `会话 <id> 已归档，不会运行`；目标未加载（cold）立即返回 `会话 <id> 空闲（未加载）`。
- 超时返回 `session-hub: WAIT_TIMEOUT: session "<id>" did not become idle within <n>ms`。
- 它不是请求/响应关联：只保证“等待结束时目标空闲”，取回的回复可能来自更早的回合；宿主 agent 没有 `whenIdle` 能力时视为立即空闲。
- 不投递任何消息；默认不需要 `confirm`，但可按 `targets` / `confirm` 策略收紧。

## 搜索

- 复用宿主的 `ctx.sessionQuery` 服务（`searchSessions`）：插件只负责构造请求、按会话去重、补齐标题和渲染。
- `scope: all` 且没有 filters：搜索整个会话索引，不附加 `id` 过滤。
- `scope: owned`：附加 `id` 过滤器，范围 = 所有权索引中 owner 为调用方的会话；调用方 id 不可用或索引为空时直接返回 `没有匹配的会话。`
- `scope: workspace`：附加 `id` 过滤器，范围 = cwd 与调用方 cwd 相同的会话；调用方 cwd 未知时返回空结果。
- `filters` 的 allow/deny 会先被解析成允许的会话 id 集合，再作为 `id` 过滤条件传给宿主；需要会话列表才能判定时，列表服务缺失会退化为“没有任何可见会话”，而不是放开全量搜索。
- 宿主按事件返回命中，同一会话可能重复；插件每个会话只保留第一条（最佳）命中。
- `limit` 默认 20、最大 50；`cwd` 作为精确的 `cwd` 过滤条件传给宿主；`query` 必填。
- 搜索是只读操作，默认不需要 `confirm`。
- 依赖：profile 未挂载 `sessionQuery` 服务时返回 `session-hub: SEARCH_UNAVAILABLE: sessionQuery service is unavailable in this profile`；宿主搜索失败返回 `session-hub: SEARCH_FAILED: <原始错误>`。该服务依赖宿主侧的内容索引（sqlite），索引不可用时搜索同样不可用，其他工具不受影响。

## 所有权索引

`session_create` 默认会把“创建者 → 新会话”的关系写入插件自己的索引：

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

- 只有通过 `session_create` 创建的会话会写入记录；`ownership.record: false` 时完全不写。
- 写入采用“临时文件 + rename”的原子替换，进程内并发写入会串行化。
- 读取时文件缺失、无法解析或结构不合法按空索引处理，不会抛错。
- 索引不自动清理已删除会话，也不跨机器同步；没有跨进程锁，多个 DSH 进程同时写是 last-write-wins。

**丢失后的影响**：删除或损坏索引不会删除 DSH 会话，也不会改变会话内容，但“自己创建”的判断会全部退化为“所有权未知”。此时 `targets: owned` 会拒绝原本自己创建的会话，`confirm: non-owned` 会要求确认，`scope: owned` 的列表/搜索会变空；默认的 `targets: any` / `confirm: never` / `scope: all` 不受影响。

恢复方式：

1. **直接使用确认（推荐）**：对目标操作传 `confirm: true`（前提是 `confirm` 不是 `always` 或 `targets` 不是 `owned`）。
2. **停止所有 DSH 进程后手工补写** `owners.json`，为每个会话补 `{ "ownerSessionId": "<创建者会话 id>", "createdAt": <毫秒时间戳> }`；运行中手工编辑可能被后续写入覆盖。
3. **重新创建会话**：新会话会正常写入所有权，旧会话仍需按第 1 或第 2 种方式处理。

## 构建、安装与测试

在仓库根目录（或包目录内）：

```bash
pnpm install   # 安装 TypeScript、tsx、schemastery 与宿主类型包
pnpm check     # tsc --noEmit，检查 src 与 test 类型
pnpm build     # rimraf lib 后 tsc -p tsconfig.build.json，src/ → lib/
pnpm test      # tsx --test，全部 261 个测试
```

安装到指定 profile（`lib/` 已被 gitignore，必须先构建）：

```bash
pnpm build
dsh plugin --profile <name> add link:D:\myprojects\projects\dsh-plugins\packages\session-hub
```

- 安装后需重启 DSH 生效；插件通过 `cordis.patch.yml` 向目标 profile 插入 `tool-session-hub` 行。
- 包入口是 `lib/index.js`，`link:` 安装不会触发构建，缺少 `lib/` 时插件无法加载。
- 更新代码后重新 `pnpm build` 并重启 DSH；`cordis.patch.yml` 中的 `config` 由 HMR 热重载。
- `lib/` 中只有 `@deepseek-ai/schemastery` 一条运行时 import，由 DSH runtime resolution 提供，不需要把 schemastery 打进包。

## 已知限制

- **归档会话需先恢复**：`session_send` / `session_wake` 默认不会隐式 `session_open`，归档目标直接返回 `SESSION_ARCHIVED`。
- **不能关闭自己（默认）**：`allowSelf: false` 时返回 `SELF_CLOSE_FORBIDDEN`，`confirm: true` 也无法绕过。
- **搜索依赖宿主 sqlite 服务**：`session_search` 依赖 `sessionQuery` 及其内容索引；profile 未提供该服务或索引不可用时返回 `SEARCH_UNAVAILABLE` / `SEARCH_FAILED`。
- **改 Host 插件需重启**：插件代码在 DSH 启动时加载；修改源码、重新构建后必须重启 DSH。仅有 `cordis.patch.yml` 的配置变更可热重载。
- **`wait` 不是请求/响应关联**：只等待目标空闲并返回最新 assistant 消息，超时后不撤回任何消息；`timeoutMaxMs` 同时是默认值与上限。
- **所有权覆盖不完整**：只记录本插件 `session_create` 创建的会话；插件启用前存在的会话在 `targets: owned` / `confirm: non-owned` 下永远视为“所有权未知”。
- **索引会累积且无跨进程锁**：已删除会话的记录不会自动清理；多个 DSH 进程写同一 `DSH_HOME` 时可能互相覆盖。
- **输出为纯文本且截断**：列表最多 200 行；`session_get` 最近消息最多 50 条、每条 500 字符；`session_wait` 回复由 `replyMaxChars` 控制；`session_search` 片段最多 200 字符，且没有结构化输出字段。
- **依赖宿主服务**：某些 profile 可能不提供 `sessionController`、`workspaceController`、`sessions` 或 `sessionQuery`，相关工具会返回服务不可用的错误文本；`session_get` / `session_wait` 的会话读取需要 `sessions` 或 `sessionQuery` 至少有一个可用。
- **`steer` 会影响正在运行的回合**：消息插入目标下一步，可能改变其当前任务走向；需要排队语义时配置 `whenRunning: queue`。
- **没有发送预算**：不限制消息条数、频率或目标数量，需要节制时由调用方自行控制。
- **`confirm` 不是安全边界**：它只用于防止误操作，不能阻止有意操作。
- **`enabled: false` 是注册期行为**：修改后由 HMR 触发插件重新 apply；若宿主未重新加载，工具仍按旧表存在。

## 与 Codex 协作工具的对应关系

| Codex 工具 | session-hub 工具 | 说明 |
| --- | --- | --- |
| `spawn_agent` | `session_create` | `message` 默认必填，创建后立即启动新会话并记录所有权。 |
| `send_message` | `session_send` | 只投递（inject），不唤醒目标、不等待回复。 |
| `followup_task` | `session_wake` | 空闲目标 `followup` 开启新回合；运行中默认 `steer`，可配置为排队。 |
| `wait_agent` | `session_wait` | 等待目标空闲（默认/上限 120s，夹紧 1s–600s），取回最新 assistant 回复。 |
| （列表 / 查看） | `session_list` / `session_get` | 定位会话 id、查看元数据与最近消息。 |
| （无直接对应） | `session_search` / `session_close` / `session_open` / `session_update` | 内容搜索、归档管理、标题与模型修改。 |

## 许可证

[MIT](../../LICENSE)
