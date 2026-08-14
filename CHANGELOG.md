# 更新日志

## 0.1.1 — 2026-08-14

- displayName 更名为 DeepSeek Harness Launcher（原名已被市场占用；OVSX 上 0.1.0 无法覆盖，故以新版本发布）

## 0.1.0 — 2026-08-14

- 发布配置对齐 joygqz 账户：publisher、repository、`ext:package`/`ext:publish` 脚本、bumpp 自动版本发布
- 使用 DeepSeek 鲸鱼 Logo（`#4176e6`）作为扩展图标，由 `scripts/make-icon.py` 零依赖光栅化生成
- 一键启动 DeepSeek Harness Web 服务（`npx @deepseek-ai/dsh web`）并自动打开 GUI
- 状态栏实时显示服务状态（未运行 / 启动中 / 运行中 / 出错），点击即可启动或打开
- 自动检测已在运行的 Harness 实例并直接复用，不重复启动
- 支持浏览器打开与 VS Code 内置 Webview 面板两种打开方式
- 服务就绪双重检测：解析 stdout 的 `dsh web: http://…` 行 + HTTP 轮询
- 进程树管理：停止 / 重启 / 取消 / 崩溃回收 / 退出 VS Code 时自动清理
- 端口占用检测与冲突提示、就绪超时提示、独立输出日志面板
- 丰富配置项：自定义命令与参数、host/port（支持 0 自动端口）、环境变量、工作目录等
