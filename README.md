# dsh-plugins

个人 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）插件集合，使用 pnpm workspace 管理。

## 项目定位

本仓库用于存放并维护个人自用的 DSH 插件。每个插件是一个独立包，独立安装、独立测试；仓库不发布 npm 包，仅作为源码与开发工作区。插件以 DSH `0.2.2-rc.1` 为目标宿主版本，运行时要求 Node.js >= 20。

## 目录结构

```
dsh-plugins/
├── .github/
│   └── workflows/
│       └── ci.yml             # Node 20/22 测试矩阵
├── packages/
│   └── session-hub/           # 跨会话工具插件
│       ├── lib/               # 插件实现（零运行时依赖）
│       ├── test/              # node --test 测试
│       ├── cordis.patch.yml   # 插件挂载补丁
│       ├── package.json
│       └── README.md          # 插件详细文档
├── package.json               # 工作区根配置
├── pnpm-workspace.yaml
├── LICENSE
└── README.md
```

- `packages/` 下每个子目录对应一个插件包，目录名是插件短名，包名带 `dsh-` 前缀（如 `packages/session-hub` → `dsh-session-hub`）。
- 各插件包拥有自己的 `package.json`、源码、测试与挂载配置。
- 根脚本 `pnpm test` 会递归执行所有包中已定义的 `test` 脚本（未定义的包会被跳过）。

## 插件列表

| 插件 | 状态 | 说明 |
| --- | --- | --- |
| [`session-hub`](./packages/session-hub) | 可用 | 跨会话查看、创建、管理与通信工具。 |

### session-hub 工具

| 工具 | 说明 |
| --- | --- |
| `session_list` | 列出会话，可按 workspace、cwd、标题、所有者、状态过滤。 |
| `session_get` | 查看单个会话的元数据，可选附带最近若干条消息。 |
| `session_create` | 创建会话（可指定 workspace 或 cwd、标题、预设、模型），并记录调用方为所有者。 |
| `session_update` | 修改会话标题和/或切换模型。 |
| `session_close` | 关闭会话：归档并停止其活动，之后可用 `session_open` 恢复。 |
| `session_open` | 恢复已归档的会话，幂等，无需确认。 |
| `session_send` | 向其它会话发送消息，支持 `queue`/`steer` 投递及等待目标空闲。 |
| `session_interrupt` | 打断目标会话当前回合，保留其收件箱。 |

权限、确认规则、消息归属和索引位置等细节见 [session-hub 文档](./packages/session-hub/README.md)。

## 安装插件

插件通过 `link:` 方式从本仓库安装到指定 DSH profile：

```bash
dsh plugin --profile <name> add link:D:\myprojects\projects\dsh-plugins\packages\session-hub
```

安装后需重启 DSH 使插件生效。插件包不声明 `dependencies`/`peerDependencies`，宿主包由 DSH 的 runtime resolution 提供，因此安装时不会额外拉取运行时依赖。

## 开发

环境要求：Node.js >= 20；仓库本身没有运行时依赖，运行测试无需安装依赖。

在插件包内运行全部测试：

```bash
cd packages/session-hub
node --test
```

或使用 pnpm 递归执行各包的 `test` 脚本：

```bash
pnpm test
```

CI（`.github/workflows/ci.yml`）在 `ubuntu-latest` 上使用 Node 20 与 22，在 `packages/session-hub` 目录内执行 `node --test`，不执行依赖安装。

## 许可证

[MIT](./LICENSE)
