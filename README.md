# DeepSeek Harness Launcher

[![Visual Studio Marketplace](https://img.shields.io/visual-studio-marketplace/v/joygqz.vscode-dsh?label=VS%20Marketplace)](https://marketplace.visualstudio.com/items?itemName=joygqz.vscode-dsh)
[![Open VSX](https://img.shields.io/open-vsx/v/joygqz/vscode-dsh?label=Open%20VSX)](https://open-vsx.org/extension/joygqz/vscode-dsh)
[![GitHub release](https://img.shields.io/github/v/release/joygqz/vscode-dsh?label=GitHub%20Release)](https://github.com/joygqz/vscode-dsh/releases)

Start, open, and manage the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web UI from VS Code with one click. The extension checks the environment, fetches DSH through npm, picks a safe port, waits for readiness, and cleans up the process on stop.

## Prerequisites

- VS Code 1.125 or newer.
- Node.js 22.19+ (22.x only) or 24+, with both `node` and `npx` in the same installation directory.
- A trusted local, SSH, WSL, Dev Container, or Codespaces workspace.
- An API key for a model you have access to (configured inside the Harness page; this extension does not read or store it).

## Installation

Search for **DeepSeek Harness Launcher** in the Extensions view (`Ctrl/Cmd+Shift+X`), or install the `.vsix` from the [Marketplace](https://marketplace.visualstudio.com/items?itemName=joygqz.vscode-dsh), [Open VSX](https://open-vsx.org/extension/joygqz/vscode-dsh), or [GitHub Releases](https://github.com/joygqz/vscode-dsh/releases).

## Quick start

1. Open and trust a project folder, then click `DSH` in the status bar or run `DeepSeek Harness Launcher: Open`.
2. The first run fetches DSH through npm. The status bar shows "Working"; click it to cancel or view the output.
3. Once the page opens, add your API key under `Settings → Models` in Harness, then confirm a directory in `Choose workspace` and start a session.

`workingDirectory` is DSH's launch directory and default workspace context, which affects `AGENTS.md`, `CLAUDE.md`, cwd `.env`, and similar files.

## Commands and status bar

`Open` is the primary command: it starts the server when it is not running and opens it directly when it is.

| Command | Purpose |
| --- | --- |
| `Start Server` / `Stop Server` / `Restart Server` | Start, stop, or apply new settings |
| `Open in Browser` / `Open in VS Code` | Choose where to open (browser by default) |
| `Cancel Current Operation` | Cancel checks, startup, restart, or connection |
| `Connect to Running Server…` / `Disconnect External Server` | Connect to an external DSH; disconnecting does not stop it |
| `Copy Access URL` | Copy the full address a client can use |
| `Show Output` / `Open Settings` | Open the output panel or extension settings |

The status bar shows, in order: untrusted, not running, working, stopping, `DSH: port` (hosted by this window), a link icon (external server), `DSH: port*` (settings changed), or an error icon (hover for details).

## Settings

Settings apply per window; version 0.2 and later uses `vscode-dsh.*`, and the old `dsh.*` keys no longer work.

| Setting | Default | Description |
| --- | --- | --- |
| `startupBehavior` | `manual` | `manual` start on demand; `start` start silently when VS Code opens; `startAndOpen` start and open |
| `openLocation` | `browser` | Use the system `browser` or VS Code's `editor` for the primary command |
| `port` | `0` | Pick a free port automatically. When a fixed port is taken, the extension does not attach to other instances |
| `startupTimeout` | `120` | Maximum seconds to wait for DSH to become ready |
| `workingDirectory` | empty | Launch and default workspace context; supports absolute paths, relative paths, `~`, and `${workspaceFolder}` |
| `webArgs` | `[]` | Extra DSH Web arguments (must not include `--host`, `--port`, or `--patch`) |
| `environment` | `{}` | Process environment variables; may override `PATH`, cannot override `DSH_HOME` |

## Managed and external servers

- A managed server is started by the extension and stored in workspace-specific storage. Multiple windows in the same workspace are kept from writing concurrently by a single-writer lease. "Stop Server" waits for the session to clean up, then force-ends it and confirms the port was released.
- An external server can only be connected explicitly through an HTTP loopback address in this environment (for example `http://127.0.0.1:3080`). It supports open, copy, refresh, and disconnect only; the extension never stops it, and it keeps its own data directory.
- Each window manages one server; different workspaces manage their own DSH processes.

## Remote, WSL, and containers

Node/npx, `workingDirectory`, relative paths, environment variables, and connection addresses are resolved in the environment where the workspace lives. The system browser is opened through `openExternal`, which resolves localhost forwarding; the built-in page and "Copy Access URL" use `asExternalUri`. With an automatic port, the exact non-loopback authority returned by VS Code is added to the DSH Host allow-list; if the forwarded authority cannot be determined, the extension fails safely.

DSH only listens on `127.0.0.1`, but forwarding visibility is controlled by VS Code, Codespaces, or Dev Tunnels. Keep forwarded ports **Private** and do not share forwarded URLs.

## Security

- Use Harness only with projects you fully trust. `workingDirectory` and any added directories may be read, written, and executed by the agent. Workspace Trust is not a filesystem sandbox.
- The extension always passes `--host 127.0.0.1`, refuses to let users override the listen address, and does not support patches that would rewrite this boundary.
- The upstream Web service has no authentication or TLS suitable for the public internet. The first startup downloads a pinned top-level DSH version from npm; transitive dependencies may still change.
- API keys, model configuration, and sessions are written by DSH to workspace-specific storage. This extension does not read API keys and contains no telemetry.

## Troubleshooting

**Node.js / npx not found or unsupported version**: run `node --version` in the extension's runtime environment; Remote uses the remote Node. The integrated terminal may be initialized by nvm while the Extension Host's `PATH` is not synced; provide an absolute `PATH` in `vscode-dsh.environment`.

**First startup is slow**: `npx` downloads DSH and its dependencies. Click "Show Output" in the status bar or increase `startupTimeout`.

**Fixed port already in use**: change back to `port: 0`. If that port is a DSH instance you started yourself, use "Connect to Running Server…".

**The page opens but sessions do not work**: configure a model under `Settings → Models`, then add and select a directory under `Choose workspace`; see the [official Web UI guide](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/index.md).

**The built-in page is blank or limited**: use `Open in Browser` instead, and check the output panel and the Private setting for Remote port forwarding.

**The server exits unexpectedly**: hover the error status to see why and pick a recovery action. A managed process must confirm cleanup before restart is allowed.

## Feedback and license

- Extension issues: [joygqz/vscode-dsh Issues](https://github.com/joygqz/vscode-dsh/issues)
- DSH usage questions: [DeepSeek Harness Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions)
- License: [MIT](LICENSE)
