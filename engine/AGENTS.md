# AGENTS.md: Intent Engine

The engine that runs plain-English `.md` UI tests (`intent-tests/<app>/` in the repository of the app under test) with
Playwright and a decision model. Read [README.md](README.md) for what it does and how to run it, and [docs/test-format.md](docs/test-format.md)
for the test format. This file is what you need on top of that to change the engine safely.

## Invariants (do not break)

- **Fail, don't guess.** A step whose target matches nothing, or matches below the threshold, fails. Never add a
  fallback that picks "the closest" element, retries with a looser question, or skips a required step. Tests are only
  worth something because a failure is real.
- **The parser is deterministic.** The model never interprets the grammar. Unknown or malformed steps are parse
  errors with `file:line` and a hint on how to write the step.
- **Compiled releases, native TypeScript development.** Consumers install `@sorsix/intent-engine`, which declares
  Playwright as a dependency and ships JavaScript plus declarations under `dist/`. Node cannot strip TypeScript in
  `node_modules`. Keep `.ts` extensions in source-relative imports; the build rewrites them. Use erasable TypeScript
  and `import type` for types. Never resolve dependencies or app folders relative to a particular consumer's checkout.
- **`parse` must run without `node_modules`.** CI runs it on bare Node. Anything `src/cli/parse-main.ts` loads
  (parse, env, app, app-config, seeds, parameters, define-config, the app's `seeds.ts`, `parameters.ts` and config) may import `@playwright/test`
  only as `import type` or lazily inside a function (see `src/seeds.ts`).
- **`define-config.ts` stays a leaf** (type imports only). App configs import it through `src/index.ts`, and
  `app-config.ts` imports the app configs with top-level await: a runtime import back into the engine would deadlock.
- **Precedence: env var > app config > engine default**, for every setting that has all three.
- **Secrets only in the environment or ignored personal env files.** API keys via `apiKeyEnv` / `${VAR}` in
  preset URLs; never a committed default. The shared `intent-tests/.env` and each `<app>/.env` are Git-ignored.
  The committed `.env.<profile>` files hold local test accounts only.
- **Generic engine, app specifics in the app folder.** Behaviour specific to one application (its API login, its test
  data, its own model) belongs in that app's folder (the `auth` hook, `seeds.ts`, `presets`), never hard-coded in core
  files. Heuristics for common UI patterns (custom selects, icon buttons, grids) are fine in `src/snapshot.ts`; describe
  the pattern, not the product it was first seen in.
- **Reporting is optional and never silently skipped.** A run reports only to a configured dashboard
  (`AT_DASHBOARD_URL`, else `dashboard` in `intent-workspace.json`). A token or product without a URL stops the run
  before any test starts (`reportingTarget` in `src/dashboard/catalog.ts`); keep that rule when changing reporting.

## Where things are

| Change | Files |
|---|---|
| A new step verb or test-file syntax | `src/parse.ts` (types, `parseStep`, `VERBS`), `src/steps.ts` (`run` switch), `docs/test-format.md`, `test/parse.test.ts`, and a case in `test/fixture/self-test/engine.md` if the stub can exercise it |
| How elements are found or described | `src/snapshot.ts` (`snapshot`, `describe`, `pageText`) |
| How a step resolves, acts, retries | `src/steps.ts` (`resolve`, thresholds from `src/config.ts`) |
| Login and sessions | `src/login.ts`, `src/specs/sessions.setup.ts`, the `switch` case in `src/steps.ts`, `authHook` in `src/app-config.ts` |
| A new app setting | `AppConfig` in `src/define-config.ts`, read in `src/config.ts` or `playwright.intent.config.ts`, README settings table |
| A decision model backend | a preset in `src/decider/presets.ts`; a new wire format implements `Decider` (`src/decider/types.ts`) and is chosen in `getDecider` (`src/decider/index.ts`) |
| Which app, env files, reports folder | `src/app.ts`, `src/env.ts` |
| Report contents | `src/reporter.ts` |
| Two-pass run, CLI flags | `src/cli/run-suite.ts` |
| Develop mode (`intent-test develop`, e.g. Intent Launcher's Develop view) | `src/develop/protocol.ts` (the contract: after changing it, run `npm run contract:develop`; clients mirror it, so keep changes additive), `src/develop/session.ts` (requests, browser context, runs, verify), `src/develop/edit.ts` (pure text edits, `test/develop-edit.test.ts`), `src/develop/cases.ts` (case list and view), `src/develop/screencast.ts` (CDP frames and input), `src/develop/test-context.ts` (the `TestInfo` StepRunner needs), `src/cli/develop.ts` (stdin/stdout); `test/develop-protocol-schema.test.ts` fails when the schema drifts |
| Recording steps from the person's clicks and typing | `src/develop/recorder.ts` (browser script, coalescing, `stepText`), `test/recorder.test.ts` |
| `refs:` and `@draft` | `src/parse.ts` (`parseRefs`, `withoutDrafts`), `src/suite.ts` (drafts left out of runs), `src/dashboard/catalog.ts` (`refs`, `draft` in the catalog, outside `intentHash`) |
| Any new or changed command, flag, environment variable, config key, preset or modifier | `docs/reference.json` (the dashboard's Engine reference); `test/reference.test.ts` fails when it drifts from the source |

## Running from this repository

`bin/intent-test.mjs` (the CLI) runs the compiled `dist/` when it exists, and the TypeScript in `src/cli/` only when
there is no build. After any source change, pull or branch switch, run `npm run build` (or delete `dist`) before
using the CLI, or run `node src/cli/run-suite.ts` to run the source directly; otherwise a run silently tests
older code. The commands in `src/cli/` are TypeScript like the rest of the engine (typechecked by `npm run typecheck`).

## Commands to run before you finish

From this package's folder:

```bash
npm run typecheck        # typecheck the engine
npm run format           # Prettier (.prettierrc.json); CI checks it with format:check
npm test                 # unit tests (node:test)
npm run build            # compiled release
npm run test:self        # fixed fixture, real browser, in-memory reporting, ~20 s
```

For a change to snapshots, resolving or acting, also run the demo tests against a real model
(`AT_APP_DIR=test/fixture AT_TESTS=tests node src/cli/run-suite.ts`, `-g "<name>"` for some; jev by default, needs
`TYPESAFE_API_KEY`, costs cents), and ideally the affected tests of a real app (`-g` one file). Ask before starting a
long full-suite run.

## Debugging a failed step

1. `intent-tests/<app>/reports/report.html`: the failed step shows the candidates, the model's top answers and the
   screenshot taken before the action.
2. Rerun that test with `AT_DEBUG=true` to list every candidate element (or the page text for an `expect`):
   `AT_DEBUG=true node src/cli/run-suite.ts --app <app> -g "<file id>"`.
3. The Playwright trace: `npx playwright show-trace <reports>/test-results/<test>/trace.zip`.
4. `AT_LOG_DECISIONS=true` writes every model request and answer to `<reports>/decisions/`.
5. A test-data problem: `AT_KEEP_SEED=true` keeps the seeded data to inspect in the app.

Usually the fix is in the test text (quote the visible label, one fact per `expect`, `within N seconds`), not in
the engine. Change the engine only when the page description is wrong or misses something.

## The self-test fixture

`test/fixture/` is an app folder like any other (`AT_APP_DIR`): `site/` is a static demo clinic served by
`src/cli/serve.ts` through the fixture's `webServer`, `auth: 'ui'` because it has no login API.
`self-test/engine.md` is written for the `stub` decider (every target quoted); `tests/` is written for a real model.
Keep both passing. The fixture's `intent-workspace.json` names the engine's development product; the self-test injects
its reporting boundary, so it needs no dashboard or network.

## Dashboard reporting

A run reports to the dashboard named by `AT_DASHBOARD_URL` or `dashboard` in `intent-workspace.json`, and only then.
With a dashboard, local runs need a personal access token and CI an automation token in `AT_DASHBOARD_TOKEN`:
validate credentials before discovery/execution and register the run before starting workers. Pending uploads return
nonzero and retain the spool; `replay` sends a spool to the dashboard it records. Listing/parsing never need a token.
Unit tests and the fixed fixture harness inject the reporting boundary; do not add a switch that lets a configured
dashboard be skipped.
