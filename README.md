# vscode-dsh — DeepSeek Harness VS Code 扩展

[![Visual Studio Marketplace](https://img.shields.io/visual-studio-marketplace/v/joygqz.vscode-dsh?label=VS%20Marketplace)](https://marketplace.visualstudio.com/items?itemName=joygqz.vscode-dsh)
[![Open VSX](https://img.shields.io/open-vsx/v/joygqz/vscode-dsh?label=Open%20VSX)](https://open-vsx.org/extension/joygqz/vscode-dsh)
[![GitHub release](https://img.shields.io/github/v/release/joygqz/vscode-dsh?label=GitHub%20Release)](https://github.com/joygqz/vscode-dsh/releases)

在 VS Code 里一键启动 [DeepSeek Harness](https://www.deepseek.com/harness/) Web GUI，告别手动开终端敲 `npx @deepseek-ai/dsh web`、再手动开浏览器输入 `http://127.0.0.1:3080` 的繁琐流程。

> 点一下状态栏的 `DSH`，扩展自动完成「启动服务 → 等待就绪 → 打开 GUI」全流程；服务已在运行时直接复用，不重复启动。

## 安装

> 使用前提：本机已安装 Node.js ≥ 18（首次启动时扩展会通过 `npx` 自动下载 `@deepseek-ai/dsh`）。

### 从扩展市场安装（推荐）

- **VS Code Marketplace**：在 VS Code 的扩展视图（`Cmd/Ctrl+Shift+X`）搜索 **DeepSeek Harness** 并安装；
- **Open VSX**：在 [Open VSX](https://open-vsx.org/extension/joygqz/vscode-dsh) 页面下载，或 `Cmd/Ctrl+Shift+X` → `…` 菜单 → `Install from VSIX...` 安装。

### 从 GitHub Releases 安装

1. 到 [Releases](https://github.com/joygqz/vscode-dsh/releases) 页面下载最新版 `vscode-dsh-x.y.z.vsix`；
2. `命令面板 (Cmd/Ctrl+Shift+P)` → `Extensions: Install from VSIX...` → 选择下载的文件；
3. 或命令行安装：`code --install-extension vscode-dsh-x.y.z.vsix`。

## 快速开始

1. 安装后，VS Code 左下角状态栏出现 `DSH` 图标；
2. 点击它 → 自动启动 Harness 并打开 GUI；
3. 首次运行需要下载依赖，稍等片刻（进度条在通知区显示）；
4. 再次点击状态栏 → 打开 GUI；在命令面板用「停止服务」随时停止。

也可以在命令面板 (`Cmd/Ctrl+Shift+P`) 输入 `DeepSeek Harness` 查看全部命令。

## 功能特性

- ⚡ **一键启动**：状态栏点击或命令面板一键完成 `npx @deepseek-ai/dsh web` 启动 + 打开 GUI
- 🕹 **状态栏实时状态**：`DSH`（未运行）/ `DSH 启动中…`（转圈）/ `DSH:3080`（运行中，含端口）/ `DSH`（出错），点击即可切换
- 🔍 **智能就绪检测**：解析 dsh stdout 的 `dsh web: http://…` 行 + HTTP 轮询双重检测，端口设为 `0` 时也能自动拿到真实端口
- 🔗 **自动复用已运行实例**：检测到 `127.0.0.1:3080` 已在服务 Harness 时直接连接，不重复启动（停止时也不会误杀外部进程）
- 🖥 **两种打开方式**：系统默认浏览器，或 VS Code 内置 Webview 面板（带刷新 / 浏览器打开 / 复制地址工具栏）
- 🧹 **完整生命周期管理**：启动 / 停止 / 重启 / 取消；崩溃自动回收；退出 VS Code 时自动清理进程树（可配置保留）
- 🛡 **友好报错**：端口被占用（非 Harness 程序）、首次启动下载依赖超时、进程提前退出等都有明确中文提示
- 📜 **独立输出面板**：`输出 → DeepSeek Harness` 查看完整启动日志

## 命令一览

| 命令 | 说明 |
| --- | --- |
| `DeepSeek Harness: 启动并打开 GUI` | 启动服务（如已在运行则直接复用），就绪后按 `dsh.openMode` 打开 |
| `DeepSeek Harness: 仅启动服务` | 只启动服务，就绪后弹通知（可点「打开」） |
| `DeepSeek Harness: 在浏览器中打开` | 用系统浏览器打开 GUI（未运行时提示先启动） |
| `DeepSeek Harness: 在 Webview 面板中打开` | 在 VS Code 内置面板中打开 |
| `DeepSeek Harness: 停止服务` | 停止由本扩展启动的服务 |
| `DeepSeek Harness: 重启服务` | 完整停止后重新启动 |
| `DeepSeek Harness: 复制 GUI 地址` | 把 `http://127.0.0.1:3080` 之类的地址复制到剪贴板 |
| `DeepSeek Harness: 显示日志` | 打开输出面板查看日志 |

## 设置一览

`设置 → 扩展 → DeepSeek Harness`（或 `settings.json` 中 `dsh.*`）：

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `dsh.command` | `npx` | 启动命令（可执行文件），可改为本地 dsh 路径 |
| `dsh.args` | `["--yes","@deepseek-ai/dsh","web"]` | 传给命令的参数；`--host`/`--port` 自动追加在末尾。固定版本改成 `@deepseek-ai/dsh@0.1.0-rc.6` |
| `dsh.host` | `127.0.0.1` | Web 服务绑定地址（`dsh web --host`） |
| `dsh.port` | `3080` | Web 服务端口（`--port`）；`0` = 自动选择空闲端口 |
| `dsh.extraArgs` | `[]` | 其它 `dsh web` 参数（如 `--patch`、`--trusted-host`） |
| `dsh.autoStart` | `false` | VS Code 启动后自动启动服务 |
| `dsh.autoOpen` | `true` | 服务就绪后自动打开 GUI |
| `dsh.openMode` | `browser` | `browser` 系统浏览器 / `webview` 内置面板 |
| `dsh.startupTimeout` | `90` | 等待就绪的最长秒数（首次下载依赖可调大） |
| `dsh.stopOnExit` | `true` | 退出 VS Code 时停止由本扩展启动的服务 |
| `dsh.workspace` | `""` | 启动 dsh 的工作目录（留空用当前工作区，无工作区用主目录） |
| `dsh.env` | `{}` | 额外环境变量（如 `{ "DSH_HOME": "/custom/path" }`） |

## 常见问题

**Q：首次点击启动卡了很久？**
首次运行 `npx` 要下载整个 `@deepseek-ai/dsh` 依赖树，属正常现象。进度与日志见通知区和 `输出 → DeepSeek Harness`；网络慢可调大 `dsh.startupTimeout`。

**Q：提示「端口已被其它程序占用」？**
说明 `dsh.port` 上的服务不是 Harness（扩展会区分）。换一个端口（如 `3090`）或停掉占用程序。

**Q：Webview 面板打开后页面空白？**
Harness 服务本身未设置 `X-Frame-Options`，正常可直接内嵌。若个别版本加了限制，请改用 `dsh.openMode: browser`。

**Q：想用本地 checkout 的 dsh 而不是 npx 下载版？**
把 `dsh.command` 设为本地可执行文件路径（如 `/path/to/checkout/node_modules/.bin/dsh`），`dsh.args` 设为 `["web"]`。

**Q：启动后状态栏显示 `DSH:3080`，点击没反应？**
`openMode: webview` 时点击会在编辑区打开面板；`browser` 时会唤起系统浏览器，注意浏览器可能已在后台打开新标签。

## 工作原理（可选阅读）

```text
点击启动
  │
  ├─ 探测 dsh.port 端口
  │    ├─ 已有 Harness 在跑 → 直接复用（attached，停止时不误杀）
  │    ├─ 被其它程序占用     → 明确报错，提示改端口
  │    └─ 空闲               → 启动进程
  │
  ├─ spawn: npx --yes @deepseek-ai/dsh web --host … --port …
  │     ├─ stdout 出现 "dsh web: http://127.0.0.1:<port>" → 就绪（端口 0 时拿到真实端口）
  │     └─ HTTP 轮询 http://127.0.0.1:<port>/ 且页面含 __DSH_BOOT__ → 就绪
  │
  └─ 就绪 → 按 dsh.openMode 打开（浏览器 / Webview）
```

进程以独立进程组（POSIX `detached`）启动，停止/崩溃/退出 VS Code 时按进程树整体终止，不会残留孤儿进程。

---

# 开发者指南

以下内容面向维护者，普通用户无需阅读。

## 本地开发

> 需要 Node.js ≥ 18 与 [pnpm](https://pnpm.io/)。

```bash
pnpm install
pnpm watch        # 增量编译
```

按 `F5` 启动 Extension Development Host 调试扩展。

```bash
pnpm compile     # TypeScript 类型检查
pnpm test        # 单元测试（vitest，30 个用例）
pnpm build       # esbuild 打包 → dist/extension.cjs
pnpm package     # 打包 → vscode-dsh-x.y.z.vsix
```

- 核心逻辑（进程生命周期 / 就绪探测 / 状态机）位于 `src/serverManager.ts`，通过依赖注入与 VS Code 解耦，用假进程离线测试；
- `src/parse.ts`、`src/args.ts` 为纯函数，无副作用；
- 图标由 `scripts/make-icon.py` 零依赖生成。

## 自动发布

内置 `.github/workflows/release.yml`（参考 commit-genie 的发布流程）：推送 `v*` 标签即触发，自动完成：

1. **测试门禁** — 运行全部单元测试，失败则中止发布
2. **打包** — `pnpm package` 产出 `.vsix`
3. **创建 Release** — `npx changelogithub` 依据 [Conventional Commits](https://www.conventionalcommits.org/) 提交历史生成 Release Notes 并创建 GitHub Release
4. **上传附件** — 把 `.vsix` 上传为 Release 附件，用户可直接从 Release 页面下载安装
5. **发布到扩展市场**（可选）— 配置了 `VSCE_PAT` 与 `OVSX_PAT` 时自动发布到 VS Code Marketplace 与 Open VSX，未配置则自动跳过

### 发布步骤

```bash
pnpm release        # bumpp 交互式选择新版本 → 自动 bump 版本 + commit + tag + push
```

`pnpm release` 会自动保证版本号与标签一致（changeloggithub 会校验两者匹配）。推送标签后到仓库的 Actions 页查看进度，完成后 Release 页面即可下载 `.vsix`。

也可以手动发布：

```bash
# 修改 package.json 的 version，并更新 CHANGELOG.md
git add -A
git commit -m "chore: release v0.1.1"
git tag v0.1.1
git push && git push --tags
```

### 发布前置条件

- 先把仓库推送到 GitHub（当前本地仓库尚未配置远程）：

  ```bash
  git remote add origin git@github.com:joygqz/vscode-dsh.git
  git push -u origin main
  ```

- 发布者与仓库地址已在 `package.json` 中配置（`publisher: joygqz`、`repository: joygqz/vscode-dsh`，与 commit-genie 同一账户）。
- 若要启用市场发布：在仓库 `Settings → Secrets and variables → Actions` 中配置 `VSCE_PAT`、`OVSX_PAT`（与 commit-genie 使用同一套令牌即可），未配置时该步骤自动跳过，不影响 GitHub Release 发布。

## License

MIT
