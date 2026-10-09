# Contributing

## Setup

Use Node.js 24 and the pnpm version in `package.json`. Install with `pnpm install --frozen-lockfile`.

## Implementation conventions

Keep `extension.ts` focused on lifecycle delegation and put command orchestration in `controller.ts`. Keep configuration access in `config.ts`; place domain logic and external-resource adapters in focused modules. Release timers, listeners, requests and processes through the lifecycle owner. Preserve public command IDs, setting keys, and extension IDs.

Follow the existing TypeScript formatting enforced by each repository. Share architectural conventions rather than copying unrelated functionality or adding a shared runtime package.

## Validation

Run `pnpm verify` for static checks and tests, `pnpm compile` for a development bundle, and `pnpm ext:package` to verify the production VSIX. Test behavior at changed boundaries, including cancellation and error cases. Use VS Code's Extension Development Host for manual command/UI checks; unit tests do not replace that check.

## Documentation and releases

Update README for user-visible behavior and `docs/ARCHITECTURE.md` for module or lifecycle changes. Document unreleased changes in CHANGELOG. CI must pass before a release. `pnpm ext:publish` publishes to Visual Studio Marketplace and requires publisher credentials; releasing to Open VSX is handled by the repository release workflow. Keep the publisher ID `joygqz` and author Quincy Zhang.
