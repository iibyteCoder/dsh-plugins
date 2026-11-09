# dsh-plugins

个人 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）插件集合，使用 pnpm monorepo 管理。

## 项目定位

本仓库用于存放并维护个人自用的 DSH 插件。每个插件作为独立包发布与安装，仓库本身不发布 npm 包，仅作为源码与开发工作区。

## 目录结构

```
dsh-plugins/
├── packages/          # 每个插件一个包
├── package.json       # 工作区根配置
├── pnpm-workspace.yaml
├── LICENSE
└── README.md
```

- `packages/` 下每个子目录对应一个插件包，包名与目录名保持一致。
- 各插件包拥有自己的 `package.json`、源码、测试与构建配置。
- 根脚本 `pnpm test` 会递归执行所有包中已定义的 `test` 脚本（未定义的包会被跳过）。

## 插件列表

| 插件 | 状态 | 说明 |
| --- | --- | --- |
| `session-hub` | 开发中 | 规划中的插件，尚无可用实现。 |

当前仓库处于骨架阶段，`packages/` 下仅有占位文件，插件包将在后续提交中加入。

## 开发

安装依赖（在仓库根目录执行）：

```bash
pnpm install
```

环境要求：Node.js >= 20，pnpm 10。

## 安装插件

本地开发完成后，可通过 `link:` 方式将插件安装到指定的 DSH profile：

```bash
dsh plugin --profile <name> add link:<包绝对路径>
```

例如（路径需替换为实际包目录）：

```bash
dsh plugin --profile my-profile add link:D:\myprojects\projects\dsh-plugins\packages\session-hub
```

安装后需重启 DSH 使插件生效。

## 许可证

[MIT](./LICENSE)
