# dsh-session-hub

DeepSeek Harness 的跨会话工具插件：用于查看、创建、改名、关闭会话，以及向其它会话发送消息。

## 当前状态

骨架阶段。插件仅声明身份（`name`）和所需服务（`inject: ['tools']`），工具将按后续提交逐步实现。

## 安装

```powershell
dsh plugin --profile <name> add link:D:\myprojects\projects\dsh-plugins\packages\session-hub
```

安装后需重启 DSH 生效。

## 依赖策略

本包**不声明** `dependencies` 或 `peerDependencies`。宿主包（如 `@deepseek-ai/dsh` 相关模块）由 DSH 的 runtime resolution 在运行时提供；若在此声明依赖，pnpm 会安装独立副本并遮蔽宿主实例，导致插件与宿主使用的不是同一份模块。

## 许可证

MIT
