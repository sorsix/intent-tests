# Changelog

## 0.29.2

- Documentation, fixtures and tests use generic examples.
- The public repository layout: the engine in `engine/`, its workflows at the root. npm publishing from GitHub runs
  once the repository has an `NPM_TOKEN` secret.

## 0.29.1

First version prepared for open-source release (0.29.0 was tagged but not published).

### Breaking

- **Dashboard reporting is optional and configured.** The engine no longer has a built-in dashboard address. A run
  reports to `AT_DASHBOARD_URL`, else to `"dashboard"` in `intent-workspace.json`; with neither (and no token or
  product), it keeps its reports local. A token or product without a dashboard URL stops the run before any test
  starts. To keep reporting, add `"dashboard": "<your dashboard URL>"` next to `"product"` in `intent-workspace.json`.
- **No built-in app login.** `auth: 'pinga'` is no longer supported and the default is now `'ui'` (the session block's
  steps in the browser). Apps that logged in through an API set `auth` to their own `AuthHook`.
- `replay` sends a spool to the dashboard recorded in it.
- The `d3nano-ft-spark` preset was removed.

### Added

- `presets` in `intent-tests.config.ts`: an app's own decision-model presets, added to the built-in ones.
- `AT_DASHBOARD_URL`.
- `catalog` reports `dashboard` (the URL, or `null` for local runs).
- The `Preset` type is exported.
- Apache 2.0 license; `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`.
