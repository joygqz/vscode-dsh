# Architecture

## Shared design

Each extension is an independent repository and VSIX. They share the same boundaries and developer command contract without introducing a cross-repository runtime dependency.

- `src/extension.ts` is the VS Code lifecycle entry point. It creates the controller and delegates shutdown.
- `src/controller.ts` owns commands, orchestration and activation-scoped state. VS Code resources are registered for disposal; asynchronous work is cancelled during shutdown.
- `src/config.ts` adapts VS Code settings to application configuration. Existing setting keys, command IDs and extension IDs are compatibility contracts.
- Domain modules implement the extension's specific behavior. UI adapters present results; transport/process adapters own external resources.
- Pure modules and adapters are tested without requiring a running Extension Host. CI packages the extension after static checks and tests.

## Module responsibilities

| Module | Responsibility |
| --- | --- |
| `extension.ts` | Activation and deactivation delegation. |
| `controller.ts` | Commands, workspace trust, preflight and UI orchestration. |
| `config.ts, types.ts` | Settings, launch fingerprints and domain contracts. |
| `serverManager.ts` | Managed/external ownership and server lifecycle. |
| `runtime.ts, args.ts, environment.ts, workspace.ts` | Runtime checks and launch preparation. |
| `http.ts, readiness.ts, endpoint.ts, parse.ts` | Loopback endpoints and readiness detection. |
| `storage.ts, homeLease.ts` | Shared application profile, migration and single-writer lease. |
| `webview.ts, output.ts` | Editor UI and diagnostic output. |

## Lifecycle and data flow

Command → trust/runtime/directory preflight → server manager → readiness → browser/webview. The controller owns UI state; the manager owns process state. Managed instances can be stopped; external instances can only be disconnected. Deactivation awaits cleanup. The application profile remains shared per local/remote environment and guarded by a lease.

## Compatibility and privacy

The publisher ID is `joygqz` and the source author is Quincy Zhang. Marketplace display names are account metadata. Changing the author must not alter extension IDs or user configuration namespaces.

Preserve workspace trust, loopback binding, process ownership and profile isolation between runtime environments. DSH itself stores model credentials; the extension does not read them.

## Validation and release

`check-types`, `test`, `test:watch`, `verify`, `compile`, `build`, `check`, `package`, `ext:package` and `ext:publish` have the same meaning across repositories. `check` and `package` are aliases for the verified production build; VSIX creation uses `ext:package`. Existing bundlers and minimum VS Code versions remain extension-specific.

Release workflows must package verified source. Do not change a release version or publish a Marketplace update as part of a structural refactor without an intentional release.
