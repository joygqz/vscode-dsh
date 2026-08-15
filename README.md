# DeepSeek Harness Launcher

[![Visual Studio Marketplace](https://img.shields.io/visual-studio-marketplace/v/joygqz.vscode-dsh?label=VS%20Marketplace)](https://marketplace.visualstudio.com/items?itemName=joygqz.vscode-dsh)
[![Open VSX](https://img.shields.io/open-vsx/v/joygqz/vscode-dsh?label=Open%20VSX)](https://open-vsx.org/extension/joygqz/vscode-dsh)
[![GitHub release](https://img.shields.io/github/v/release/joygqz/vscode-dsh?label=GitHub%20Release)](https://github.com/joygqz/vscode-dsh/releases)

在 VS Code 中一键启动、打开和管理 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web UI。扩展负责检查运行环境、通过 npm 获取 DSH、选择安全端口、等待就绪，并在停止时清理进程树。

> 本扩展是社区项目，并非 DeepSeek 官方产品。DeepSeek Harness 仍处于 Developer Preview，上游明确可能发生破坏性变化。扩展默认使用已验证的顶层 DSH 版本以降低变化风险，但 npm 依赖图仍可能随上游发布而变化。

## 使用前准备

- VS Code 1.125 或更高版本。
- Node.js 22.19+（仅 22.x）或 Node.js 24+，且同一安装目录中包含 `node` 和 `npx`。
- 一个你信任的本地、SSH、WSL、Dev Container 或 Codespaces 工作区。
- 可用模型的 API Key。它在 Harness 页面内配置，本扩展不会读取或保存。

DeepSeek Harness 能读写文件并执行命令。本扩展在 Restricted Mode 中不会启动或连接服务；空窗口选择目录时也会再次要求确认。

## 安装

在扩展视图（`Ctrl/Cmd+Shift+X`）搜索 **DeepSeek Harness Launcher**，或从以下位置安装：

- [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=joygqz.vscode-dsh)
- [Open VSX](https://open-vsx.org/extension/joygqz/vscode-dsh)
- [GitHub Releases](https://github.com/joygqz/vscode-dsh/releases) 中的 `.vsix`

安装本地包：打开命令面板，运行 `Extensions: Install from VSIX...`。

## 快速开始

1. 在 VS Code 中打开项目文件夹，并确认工作区受信任。
2. 点击左下角状态栏的 `DSH`，或运行 `DeepSeek Harness Launcher: 打开`。
3. 首次运行会通过 npm 获取 DSH。状态栏显示“处理中”；点击它可取消当前操作或查看输出。
4. 页面打开后，进入 Harness 的 `Settings → Models`，填写 API Key 并保存。
5. 点击 Harness 页面中的 `Choose workspace`，确认或选择项目目录，然后新建会话。

扩展选择的 `workingDirectory` 是 DSH 的启动目录和默认 workspace 上下文，会影响适用的 `AGENTS.md`、`CLAUDE.md`、cwd `.env` 等内容。新的 Web UI 仍需要你在 `Choose workspace` 中确认或选择目录。

## 日常使用

`DeepSeek Harness Launcher: 打开` 是主命令：未运行时启动，已运行时直接打开，不会重复创建进程。

| 命令 | 用途 |
| --- | --- |
| `打开` | 启动（如需要）并在默认位置打开 |
| `启动服务` | 只启动服务，不立即打开页面 |
| `在浏览器中打开` | 启动（如需要）并使用系统浏览器打开 |
| `在 VS Code 中打开` | 启动（如需要）并在编辑器区域打开 |
| `停止服务` | 停止当前窗口托管的服务；清理失败时可再次执行 |
| `重启服务` | 应用新设置；未修改 `workingDirectory` 时复用本实例已经选定的目录 |
| `取消当前操作` | 取消环境检查、启动、重启或连接 |
| `连接到运行中的服务…` | 连接工作区所在环境中已有的 DSH，并立即打开 |
| `断开外部服务` | 取消跟踪，但不停止外部进程 |
| `复制访问地址` | 复制客户端真正可访问的完整地址；Remote 下是转发地址 |
| `显示输出` | 打开 `输出 → DeepSeek Harness Launcher` |
| `打开设置` | 打开本扩展设置 |

VS Code 内置页面的标题栏提供刷新、在浏览器中打开和复制地址。隐藏再返回不会主动重载页面；“刷新”才会重新加载。关闭浏览器标签或内置页面不会停止服务，需要释放进程请运行“停止服务”。

### 状态栏

| 显示 | 含义 |
| --- | --- |
| 盾牌图标 + `DSH` | 工作区未受信任；点击可管理 Workspace Trust |
| `DSH` | 尚未运行；点击启动并打开 |
| `DSH 处理中…` | 正在检查、启动、重启或连接；点击可取消或看输出 |
| `DSH 停止中…` | 正在安全停止；点击查看输出 |
| `DSH:端口` | 当前窗口托管的服务正在运行 |
| 链接图标 + `DSH:端口` | 已连接外部服务，扩展不会停止它 |
| `DSH:端口*` | 进程设置已改变；点击可“重启并应用设置” |
| 错误图标 + `DSH` | 悬停查看原因；点击查看重连、重试或再次清理选项 |

## 设置

打开 `设置 → 扩展 → DeepSeek Harness Launcher`，或编辑 `settings.json` 中的 `vscode-dsh.*`。扩展每个 VS Code 窗口只管理一个服务，因此进程设置均按窗口生效。

> 0.2 是不兼容重构：旧的 `dsh.*` 设置和命令不再生效，请改用 `vscode-dsh.*`。

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `startupBehavior` | `manual` | `manual` 手动；`start` 启动 VS Code 后静默启动；`startAndOpen` 启动并打开 |
| `openLocation` | `browser` | 主命令使用系统 `browser` 或 VS Code 内的 `editor` |
| `port` | `0` | 自动选择端口；固定端口被占用时不会静默附加到别的实例 |
| `startupTimeout` | `120` | 等待 DSH 完全就绪的最长秒数 |
| `workingDirectory` | 空 | DSH 的启动/默认 workspace 上下文；支持绝对路径、相对路径、`~`、`${workspaceFolder}` |

`workingDirectory` 留空时：手动启动优先使用活动编辑器所属文件夹；没有活动编辑器所属根的多根工作区会让你选择，并在本实例后续重启时记住；自动启动始终使用列表中的第一个根；空窗口会打开目录选择器并要求安全确认。相对路径必须有已打开的工作区作为基准，自动启动时也以第一个根解析。

### 高级设置

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `webArgs` | `[]` | 额外 DSH Web 参数；不能包含扩展管理的 `--host`、`--port` 或 `--patch` |
| `environment` | `{}` | 用于检查 Node/npx 并启动托管进程的环境变量；可覆盖 `PATH`，但不能覆盖扩展管理的 `DSH_HOME` |

例如，仅在你明确知道反向代理 authority 时扩展 Host 信任名单：

```json
{
  "vscode-dsh.webArgs": ["--trusted-host", "proxy.example.test"]
}
```

`--trusted-host` 只是 DSH 的 Host 允许名单，不提供身份验证。扩展不开放 `--patch`，因为补丁可以改写监听配置并破坏回环安全边界。

## 托管服务与外部服务

默认 `port: 0` 时，每个不同工作区的 VS Code 窗口管理自己的 DSH 进程，避免意外共享端口、工作目录和生命周期。托管 DSH 的模型、会话和设置保存在 VS Code 的工作区专属存储中；同一工作区若同时打开多个窗口，扩展会用单写租约阻止第二个进程，避免 DSH 的 JSON 存储互相覆盖。

- 托管服务由扩展启动。普通“停止服务”会给 DSH 足够的会话清理时间，随后才强制清理，并确认监听端口已经释放。
- VS Code 关闭扩展宿主的等待时间较短；如有重要会话，建议先手动运行“停止服务”，等状态变为未运行后再关闭窗口。
- 外部服务必须显式连接，地址只能是工作区所在环境的 HTTP 回环地址，例如 `http://127.0.0.1:3080`。
- 外部服务只支持打开、复制、刷新和断开；不会被扩展停止或“伪重启”。打开或刷新前会重新检查服务身份与可用性。
- 外部服务使用它自己的数据目录，不受本扩展的工作区存储和单写租约管理。

## Remote、WSL 与容器

扩展运行在工作区所在环境。Node/npx、`workingDirectory`、相对路径、环境变量和“连接”地址也都在 SSH/WSL/容器/Codespaces 一侧解析，而不是客户端电脑。

- 系统浏览器由 VS Code 的 `openExternal` 解析 localhost 转发。
- VS Code 内置页面和“复制访问地址”使用 `asExternalUri` 获取客户端可访问地址。
- 托管服务使用自动端口时，扩展会先选择具体端口，再把 VS Code 返回的精确非回环 authority 自动加入 DSH Host 信任名单；不会使用通配符。
- 无法确定 Remote 转发 authority 时，启动会安全失败并给出提示，不会制造“页面打开但 API 被 Host fence 拒绝”的假成功。

DSH 进程始终只监听 `127.0.0.1`，但 Remote 转发的可见性由 VS Code、Codespaces 或 Dev Tunnel 平台控制。请把转发端口保持为 **Private**，不要分享复制出的转发 URL。外部 DSH 不由扩展启动，因此在非回环转发下可能需要你为它单独配置正确的 `--trusted-host`。

## 安全与隐私

- 只对你完全信任的项目使用 Harness；`workingDirectory` 以及在 Harness 中添加的每个目录都可能被 Agent 读写并执行命令。
- Workspace Trust 不是文件系统沙箱，`workingDirectory` 也不是访问边界。
- 扩展固定传入 `--host 127.0.0.1`，拒绝用户覆盖监听地址，并且不支持能改写该边界的 launcher patch。
- 上游 Web 服务没有公网部署所需的认证或 TLS；Remote 转发必须保持 Private。
- 首次启动会从 npm 下载并执行扩展内置、已验证的顶层 `@deepseek-ai/dsh@0.1.0-rc.6`；其传递依赖仍可能随上游发布变化。
- API Key、模型配置、会话和 Harness 数据均由 DSH 写入 VS Code 的工作区专属存储；本扩展不读取 API Key。切换到另一个工作区时需要单独配置模型。
- 本扩展不包含遥测代码。

## 常见问题

### 提示找不到 Node.js、npx 或版本不支持

在扩展运行环境中执行 `node --version`：需要 Node.js 22.19+（仅 22.x）或 24+。Remote 使用远端 Node。

集成终端可能经过 nvm/fnm 初始化，而 VS Code Extension Host 的 `PATH` 没有同步。完全退出 VS Code 后从已加载正确 Node 的终端运行 `code .`，或在 `vscode-dsh.environment` 中提供 Extension Host 可见的绝对 `PATH`，然后重试。

### 首次启动很慢

`npx` 需要下载 DSH 及依赖。点击“处理中”的状态栏项目并选择“显示输出”。网络较慢时可调大 `vscode-dsh.startupTimeout`。

### 固定端口已被占用

把 `vscode-dsh.port` 改回 `0`。如果该端口确实是你自己启动的 DSH，请使用“连接到运行中的服务…”。扩展不会静默附加到身份和工作目录不明的进程。

### 页面能打开，但不能开始会话

确认已经完成：

1. `Settings → Models` 中至少配置一个可用模型；
2. `Choose workspace` 中已经添加并选中目录。

详细步骤见 [DeepSeek Harness 官方 Web UI 指南](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/index.md)。

### VS Code 内置页面空白或功能受限

运行 `DeepSeek Harness Launcher: 在浏览器中打开`。浏览器是默认模式，也是上游页面嵌入策略、剪贴板或 Remote 平台行为发生变化时最可靠的备用入口。然后检查 `输出 → DeepSeek Harness Launcher` 和 Remote 端口转发是否为 Private 且可访问。

### 服务或连接意外退出

悬停错误状态查看原因，然后点击状态栏选择恢复动作。托管进程若仍未确认退出，只会提供“再次停止服务”和日志；确认清理完成后才允许启动新进程。修复问题后无需重载窗口即可重试。

## 反馈与许可证

- 扩展问题与建议：[joygqz/vscode-dsh Issues](https://github.com/joygqz/vscode-dsh/issues)
- DSH 使用问题与上游反馈：[DeepSeek Harness Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions)
- License: [MIT](LICENSE)
