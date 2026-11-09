# dsh-plugins

个人 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）插件集合，使用 pnpm workspace 管理。仓库不发布 npm 包，仅作为源码与开发工作区。

## 项目定位

- 目标宿主：DSH `0.2.2-rc.1`；运行时要求 Node.js >= 20。
- 每个插件是一个独立包：独立源码、独立构建、独立测试、独立安装。
- 插件以 `link:` 方式装进指定 DSH profile，不经过 npm 发布，改完代码重新构建并在 DSH 中重启即可生效。

## 目录结构

```text
dsh-plugins/
├── .github/
│   └── workflows/
│       └── ci.yml               # Node 20/22：install → check → build → test
├── packages/
│   └── session-hub/             # 跨会话工具插件（dsh-session-hub）
│       ├── src/                 # TypeScript 源码（唯一事实来源）
│       ├── lib/                 # tsc 构建产物（gitignore；安装前必须构建）
│       ├── test/                # tsx --test 测试（182 个，聚合入口 test/index.test.ts）
│       ├── cordis.patch.yml     # 向 profile 插入 tool-session-hub 的挂载补丁
│       ├── tsconfig.json        # 类型检查配置（noEmit，覆盖 src + test）
│       ├── tsconfig.build.json  # 构建配置：src/ → lib/
│       ├── package.json
│       └── README.md            # 插件详细文档
├── package.json                 # 根脚本：build / check / test
├── pnpm-workspace.yaml
├── LICENSE
└── README.md
```

`src/` 与 `lib/` 的关系：

- `src/` 是唯一事实来源；`lib/` 由 `pnpm build`（`tsc -p tsconfig.build.json`）生成，包含编译后的 `.js` 与 `.d.ts`。
- 包入口（`main` / `exports`）指向 `lib/index.js`（类型入口 `lib/index.d.ts`），因此没有构建产物的 `link:` 安装会加载失败。
- `lib/` 已被 `.gitignore` 忽略：克隆仓库或拉取新代码后，必须先 `pnpm build` 再安装/更新插件。

## 构建与测试

```bash
pnpm install   # 安装 workspace 依赖（TypeScript、tsx、宿主类型包）
pnpm check     # tsc --noEmit，检查 src 与 test 的类型
pnpm build     # tsc -p tsconfig.build.json，产出 packages/session-hub/lib
pnpm test      # tsx --test，运行全部 182 个测试
```

根脚本通过 `pnpm -r --if-present` 递归执行各包的同名脚本，也可以在单个包目录内执行。测试使用伪造的宿主 context，不依赖真实 DSH 进程。

CI 在 `ubuntu-latest` 上使用 Node 20 与 22，依次执行 `pnpm install --frozen-lockfile`、`pnpm check`、`pnpm build`、`pnpm test`。

## 安装

```bash
# 1. 先构建：link 安装只引用目录，lib/ 不会自动生成
pnpm build

# 2. 以 link 方式加入指定 profile
dsh plugin --profile <name> add link:D:\myprojects\projects\dsh-plugins\packages\session-hub

# 3. 重启 DSH 使插件生效
```

- 安装后目标 profile 的 `cordis.patch.yml` 中会出现 `tool-session-hub` 行；权限模式通过该行的 `config.permissionMode` 配置，见 [session-hub 文档](./packages/session-hub/README.md#权限模式)。
- 插件包不声明 `dependencies` / `peerDependencies`，宿主包由 DSH 的 runtime resolution 在运行时提供。
- 更新代码后需要重新 `pnpm build` 并重启 DSH。

## 插件列表

| 插件 | 说明 |
| --- | --- |
| [`session-hub`](./packages/session-hub) | 跨会话工具：查看、创建、管理会话，并在会话之间投递、唤醒、等待和搜索。 |

### session-hub 的 10 个工具

| 工具 | 一句话说明 |
| --- | --- |
| `session_list` | 按 workspace、cwd、标题、所有者、状态筛选并列出会话。 |
| `session_get` | 查看单个会话的元数据，可选附带最近消息。 |
| `session_create` | 创建会话（`message` 必填，创建后立即启动新会话）。 |
| `session_update` | 修改会话标题和/或切换模型。 |
| `session_close` | 归档并停止会话活动；不能关闭自己。 |
| `session_open` | 恢复已归档的会话（幂等）。 |
| `session_send` | 向目标会话投递消息（inject），不唤醒、不等回复。 |
| `session_wake` | 请求目标会话立即处理消息：空闲时 followup，运行中 steer。 |
| `session_wait` | 等待目标会话空闲，并取回其最新 assistant 回复。 |
| `session_search` | 复用宿主 `sessionQuery` 服务搜索会话正文。 |

权限规则、消息语义、所有权索引和已知限制见 [session-hub 文档](./packages/session-hub/README.md)。

## 许可证

[MIT](./LICENSE)
