# Intent Engine

Plain-English UI tests for web applications. Tests are Markdown files with numbered steps (`click the "Submit" button`,
`expect the worklist shows "Ana Petrova"`). Playwright drives the browser; a **decision model** (Jev by default)
only decides which element on the page a step means, or whether an `expect` statement is true.

Tests live in your application's repository, at `intent-tests/<app>`. This package is the reusable engine: install it
there, write tests next to your code, and run them against your app.

## How a step runs

1. **Parse** (deterministic, `src/parse.ts`): the step grammar is fixed ([docs/test-format.md](docs/test-format.md)).
   An unknown verb is an error, never a guess. `{{VARIABLES}}` are filled in from the env.
2. **Snapshot** (`src/snapshot.ts`): the page becomes a compact list of elements: role, label, state, and for elements
   in a table the row number and cell values. Dialogs, sections and pop-ups are included.
3. **Decide** (`src/decider/`): the model gets a *Choice* question ("which of these elements does the step mean?",
   with a `none` option) or a *yes/no* question for `expect`.
4. **Act** (`src/steps.ts`): Playwright clicks, fills, selects or checks the chosen element, after outlining it
   for the screenshot, then waits for the page to settle.

If the model answers `none`, or its probability is below the threshold (0.8 by default), the step keeps looking
until its timeout and then **fails**. The runner never "finds another way". That is what makes a failure mean
something.

## Core and what an app plugs in

| Core (same for every app) | Pluggable, per app |
|---|---|
| Test format and parser | **`auth` hook**: how a login session logs in. Default `'ui'` (run the login block's steps in the browser), or the app's own API login `{ login, homePath }` |
| Page snapshot and step runner | **Seeds**: `seeds.ts` in the app folder creates test data through the app's API before a test (`seed:` line) |
| Session handling (`session:`, `switch to session`, `switch to window`) | **Decider**: which decision model (`decider: 'jev'`) and its thresholds |
| Reporter (`report.html`, `results.json`, live `progress.json`) | **Run settings**: viewport, time zone, test timeout, workers, step timeouts, an optional `webServer` |
| CLIs, Playwright config, the two-pass `@exclusive` run | **Env profiles**: `BASE_URL` and the test accounts in `.env.<profile>` |

### What an app folder needs

```
intent-tests/<app>/
  intent-tests.config.ts    export default defineConfig({ … })   (optional; defaults: browser login, Jev)
  .env.dev                  BASE_URL and the test accounts of the default profile (AT_ENV=dev)
  seeds.ts                  export const seeds: Record<string, Seed>   (optional)
  parameters.ts             export const parameters: Record<string, ParameterSet>   (optional)
  shared/login.md           one "## Steps: log in as <role>" block per role
  <area>/<id>-<name>.md     the tests, e.g. booking/bk-01-slot-filters.md
  README.md                 what the suite covers and what it needs (not parsed as a test)
```

```ts
// intent-tests/<app>/intent-tests.config.ts
import { defineConfig } from '@sorsix/intent-engine';
import type { AuthHook } from '@sorsix/intent-engine';

// The app's API login: sessions log in with one request instead of the login steps in the browser.
const apiLogin: AuthHook = {
  async login(request, creds, baseURL) {
    const res = await request.post('/api/login', {
      data: { username: creds.username, password: creds.password },
      headers: { Origin: baseURL },
    });
    if (!res.ok()) throw new Error(`Login as ${creds.username} failed: ${res.status()}`);
  },
  homePath: '/home',                          // opened once after the login, so the app sets up its local storage
};

export default defineConfig({
  auth: apiLogin,                             // 'ui' (default) | an AuthHook
  decider: 'jev',
  viewport: { width: 1600, height: 1000 },    // dialogs that don't fit 1280x720
  timezone: 'Europe/Berlin',                  // the browser and the seeds use it
  testTimeoutMs: 900_000,                     // per test, all steps together
  workers: 2,                                 // default; omit to inherit it
});
```

Every field is optional; the public `AppConfig` type documents the available fields.

#### Login

A test starts logged in with `session: log in as <role>`, where `## Steps: log in as <role>` is a block of steps
(open the login page, fill the username and password, submit). With `auth: 'ui'` (the default) the engine runs those
steps once per run in the browser and reuses the saved session. With an `AuthHook`, a block made only of the username
and password fills logs in with the hook's `login(request, creds, baseURL)` instead (faster, and seeds can log in
with `ctx.login`), then opens `homePath`. `AT_LOGIN=ui` forces the browser login for one run.
Apps live in `<cwd>/intent-tests/`, or, when the engine runs from inside a test folder, in the nearest folder that has
`intent-workspace.json`. `AT_APPS_DIR` overrides both; `AT_APP_DIR` selects one external app directly.
**Precedence:** env var > app config > engine default, so `AT_WORKERS=1` beats `workers: 2`.

## Setup

- **Node 22.18 or newer.** The installed package runs compiled JavaScript; consumer `.ts` configs and seeds run natively.
  The CLIs stop with a clear message on an older Node.
- **Install:** `npm install --save-dev --save-exact @sorsix/intent-engine`. Playwright is a package dependency;
  install its browser with `npx playwright install chromium`.
- **Credentials:** put the decision model's key in `intent-tests/.env` (Git-ignored), e.g. Jev's `TYPESAFE_API_KEY`
  (see [Decision models](#decision-models)), and `AT_DASHBOARD_TOKEN` if you report to a dashboard. This one file works
  for every app under `intent-tests/`. Shell/CI variables also work and take precedence.
- **The app running** at the `BASE_URL` of the env profile, or a `webServer` in the app config that starts it.
- **Try it without a model key:** the `stub` decider (`AT_DECIDER=stub`) answers from the quoted labels in a step.
  It is deterministic and free, and is what the engine's own self-test uses.

## Run

From your application's repository, with `intent-tests/.env` holding the model key:

```dotenv
TYPESAFE_API_KEY=your-typesafe-api-key
```

run the commands below. Defaults are **Jev, two parallel workers and the app's `.env.dev` profile**; the exclusive pass
uses one worker. Each app supplies its own URL and test accounts in its `.env.dev`. Extra Playwright arguments follow
the command.

| Command | What |
|---|---|
| `npx --no-install intent-test run --app clinic` | Run the whole suite of the app in `intent-tests/clinic` (two passes, see [Exclusive tests](#exclusive-tests)) |
| `npx --no-install intent-test run --app clinic -g "bk-01"` | Only tests whose file path or name matches |
| `npx --no-install intent-test run --app clinic --headed --workers=1` | Watch it in a visible browser |
| `npx --no-install intent-test progress --app clinic` | In a second terminal: progress of a running suite every 30 s |
| `npx --no-install intent-test parse --app clinic [folder-or-file]` | Check the test files: no browser or model |
| `npx --no-install intent-test parse-all` | Check every app (a good CI step) |
| `npx --no-install intent-test ids [--write] <folder-or-file>...` | List, or with `--write` add, the `id:` line of tests that lack one |
| `npx --no-install intent-test catalog [--app clinic]` | The app's suite catalog as JSON (without `--app`: the app folders), for tools that start the engine |
| `tsc -p intent-tests/tsconfig.json` | Typecheck your app configs and seeds (with a `tsconfig.json` that includes them) |

Common variations (env vars go before the command):

```bash
AT_TESTS=booking npx --no-install intent-test run --app clinic        # one folder (or file) of the app
AT_DECIDER=openai npx --no-install intent-test run --app clinic       # another decision model
AT_KEEP_SEED=true AT_DEBUG=true npx --no-install intent-test run --app clinic -g "fin-01"   # keep the test data, list candidates on failure
AT_REPORT_DIR=reports/run1 npx --no-install intent-test run --app clinic   # keep runs apart
AT_ENV=staging npx --no-install intent-test run --app clinic          # use intent-tests/clinic/.env.staging
AT_APP_DIR=path/to/folder npx --no-install intent-test run           # an app folder anywhere
```

Developing the engine itself (from this package's folder):

| Command | What |
| --- | --- |
| `npm test` | Typecheck the engine and run its unit tests |
| `npm run test:self` | Run the fixed browser fixture with the stub decider and in-memory reporting |
| `npm run build` | Compile to `dist/` (what the npm package ships) |

Playwright options that work after `--`: `-g`/`--grep`, `--headed`, `--workers=N` (prefer `AT_WORKERS`, see below),
`--trace on`, `--list`, `--project=parallel|exclusive`.

### Dashboard reporting (optional)

Without a dashboard, a run keeps everything local: `report.html`, `results.json` and Playwright's traces (see
[Reports](#reports)). Runs can also stream to an **Intent dashboard**, which keeps every run's steps, screenshots and
model decisions, and compares runs. Set its address once, next to the app folders:

```json
// intent-tests/intent-workspace.json
{ "product": "my-product", "dashboard": "https://dashboard.example.com" }
```

`AT_DASHBOARD_URL` overrides `dashboard`. With a dashboard, local execution requires your **personal access token**
(created under **Settings → Users**) and pipeline execution (`CI=true`) an **automation token** (**Settings →
Automation tokens**), saved as a protected/masked `AT_DASHBOARD_TOKEN` variable. Both need `reports.read` and
`reports.write` (the default scopes).

```bash
# Opens the dashboard's Settings and securely prompts for the personal token you create there.
export AT_DASHBOARD_TOKEN="$(npx --no-install intent-test login)"
AT_RUN_NAME="Login check" AT_TESTS=login/login-ui.md AT_WORKERS=1 npx --no-install intent-test run --app clinic

# CI: inject AT_DASHBOARD_TOKEN from your protected secret store before this command.
CI=true npx --no-install intent-test run --app clinic
```

**Which runs report.** A dashboard URL turns reporting on. With no URL, no `AT_DASHBOARD_TOKEN` and no product, the run
is local. A token or a product **without** a URL is a setup that meant to report, so the run stops before any test
starts and names the setting to add, rather than quietly running without the dashboard.

When reporting, the runner validates the token with the dashboard before discovery/execution. Missing, revoked,
expired or wrong-type credentials stop execution. It registers the run before starting Playwright; an unavailable
dashboard prevents the run from starting. `--list` and parsing need no token. Direct Playwright execution requires the
reporting wrapper. The engine's self-test is a fixed fixture with in-memory reporting. Reporting calls the dashboard
under `/api` (`/api/ingest/...`, `/api/projects`), so pair this engine with a dashboard at least as new as itself.

#### Engine version check

Each reported run records the installed `@sorsix/intent-engine` version, shown and filterable on the dashboard's Runs
page. During the token check the dashboard also returns its latest release and an optional minimum supported version set by
an administrator under **Settings → Engine**. An engine older than the latest prints a warning and runs. An engine below
the minimum stops before any test starts; `--allow-outdated` or `INTENT_ALLOW_OUTDATED=1` runs it anyway, and the
dashboard marks that run outdated. Older dashboards without this policy skip the check.

Results, completed steps, model calls, screenshots and Playwright evidence stream to the dashboard. The command prints
the stable global run number, name and link on acknowledgement and before each execution phase. Setup sessions and
retry attempts keep separate identities; the parent command finishes the run after both passes.

#### Integration with tools that start the engine

Tools that start `intent-test run` (such as Intent Launcher's Execute view) read one machine-readable stdout line
instead of parsing the banner. It is printed when the dashboard first acknowledges the run, and again when the run
number becomes known, always on its own line before the human banner:

```text
@intent-run {"runId":"<uuid>","runNumber":42,"url":"https://dashboard.example.com/runs/<uuid>"}
```

The JSON is compact; `runNumber` is `null` until the dashboard has assigned one. The human banner is unchanged.

Uploads use a durable spool with immutable event IDs and artifact bytes at `<reports>/dashboard/<run-id>/`.
Local reports are in its `reports/parallel` and `reports/exclusive` folders. Only the newest pending progress snapshot
of each test attempt and of the run is uploaded; older ones are marked superseded in the spool. If the dashboard
permanently rejects one event and names it (HTTP 400/409 with its `eventId`), that event is quarantined in the spool
with the reason, a warning goes into the run logs, the evidence receipt becomes `partial`, and the rest of the upload
continues. Other failures keep the spool and retry. Incomplete uploads produce a nonzero command status and a replay
command; keep the spool until reporting completes:

```bash
npx --no-install intent-test replay /absolute/path/to/reports/dashboard/<run-id>
```

Replay loads the shared `intent-tests/.env` and sends the spool to the dashboard it was recorded for, preserving the
original run identity/name/number with the current token. Credentials are never saved to spools, reports or replay commands. Structured captured records redact the
values of environment variables named like credentials (`PASSWORD`, `PASSWD`, `SECRET`, `TOKEN`, `API_KEY`/`APIKEY`,
`ACCESS_KEY`, `PRIVATE_KEY`, `CREDENTIAL`, at least 3 characters) and of any other `*_KEY` variable of at least 8
characters (such as `MICROSOFT_FOUNDRY_KEY`); the catalog identifiers `AT_DASHBOARD_PRODUCT_KEY`/`APP_KEY`
are never redacted. Binary traces retain their original browser evidence.

Runs report into a **product** on the dashboard: `product` in `intent-workspace.json` next to the app folders (an app
folder may carry its own).
`AT_DASHBOARD_PRODUCT_KEY` overrides it. The product must already exist in the dashboard's Products & apps: `run`
and `publish-suite` stop before any test if it does not. A missing or invalid file (and no
`AT_DASHBOARD_PRODUCT_KEY`) is an error that names the file to create; there is no default product. Applications register themselves on their first run (key = app folder,
or `AT_DASHBOARD_APP_KEY` / `AT_DASHBOARD_APP_NAME`). Display names are edited in Products & apps and survive later
reports.
`AT_RUN_NAME` labels the run. Run links point at the dashboard the run reports to; `replay` takes only the spool
directory.

Branch/commit come from CI or Git. Override context with `AT_DASHBOARD_BRANCH`, `AT_DASHBOARD_COMMIT_SHA`,
`AT_DASHBOARD_ENVIRONMENT` or `AT_DASHBOARD_TRIGGERED_BY`. Set `AT_ENVIRONMENT_BUILD_ID=<build-uuid>` to attach
an Intent Launcher environment's exact source/database build.

Without `AT_ENVIRONMENT_BUILD_ID`, the engine queries the **running app** once before
registering the run:

```text
GET <BASE_URL origin>/.well-known/intent-launch/environment
```

Intent Launcher serves this JSON endpoint from the environment's nginx, independently of the
application backend. It identifies the installed build and its label, Git branch/commit,
and local-changes flag. The engine sends only its build ID; the dashboard validates the
build against the run's application and saves the trusted source/database details.
The test checkout's branch/commit remain separate from the deployed application's revision.
This works without access to the launcher's filesystem, including engines on other machines
that can reach the same app origin.

An explicit `AT_ENVIRONMENT_BUILD_ID` always wins and skips the request. Automatic discovery
has a two-second limit, validates the versioned JSON response, does not follow redirects or
send dashboard credentials, and keeps TLS certificate verification enabled. Older apps,
unreachable endpoints and malformed responses leave the run unlinked without failing it.
Local workspace files are never used to guess which environment is running.


### Suite catalog and durable case selection

Publish the full app suite before executing any tests. This reads the Markdown and expands its plans with the normal
deterministic parser; it needs no browser or decision-model key:

```bash
npx --no-install intent-test publish-suite --app clinic

# Run exactly the durable login case; the full app catalog is still published.
npx --no-install intent-test run --app clinic --case-id clinic.login.receptionist

# Equivalent selection, with multiple IDs separated by commas.
AT_CASE_IDS=clinic.login.receptionist npx --no-install intent-test run --app clinic
```

`intent-test catalog --app clinic` prints the same captured suite as one JSON object on stdout, without publishing
it: `kind: "intent-catalog"`, `schema: 1`, the engine version, the app and project identity, the loaded environment
profile and the available `.env.<profile>` names, `dashboardToken` (whether a token is set, never its value),
`dashboard` (the dashboard URL, or `null` for local runs), `baseUrl`, and `suite` (`suiteHash`, `cases`, `sources`). It
needs no browser, model, token or network. Intent Launcher's Execute view uses it so a checkout is always shown and run
with the engine version it pins.

Every case needs a durable `id:` line right under its `## Test:` heading; the parser rejects a test without one. Keep it
when moving or renaming the case: history and versions follow the id. Add missing ids with
`intent-test ids --write <folders-or-files>`, which inserts a slug of each test title and leaves the rest of the file
untouched. IDs are exact, app-wide unique values, independently of Playwright grep. See [test format](docs/test-format.md).

Captured sources and expanded plans are sanitized before hashing. Source SHA256 describes captured UTF-8 Markdown.
`intentHash` describes the canonical semantic plan (title, tags, session/seed when present, and numbered step text,
labels and kinds). `suiteHash` describes canonical `{cases,sources}`, recursively ordinal-sorted object keys and
preserved array order. The optional `AT_DASHBOARD_SUITE_REVISION` labels the immutable snapshot without changing its
content hash. A run records the full app snapshot, selected case IDs/file filter, actual app/environment profile,
and effective model/threshold/browser settings. Suite publishing has a durable spool and uses the same replay command.

New live reports include each entry's execution phase and the assigned Playwright worker index (zero-based; setup
sessions run independently in the parallel and exclusive passes). The parent reports `settings.activePhase` before
each pass. A `test.progress` update from an actual `test.step` begin carries its current title and
`currentStepState: "running"`; ending the step clears the title with `currentStepState: "between-steps"`, or resumes an
active parent for nested steps. Progress sequences increase across both begins and ends for each attempt. Older
reports without the marker can only identify the last reported step. Effective input pricing is included in
`settings.pricing.usdPerMInput`, where zero is a known free price. Certainty retains the native report's semantics:
passed-step final chosen confidence and the last yes/no probability for passed `expect` steps; phase means are not
averaged together.

The dashboard reserves every selected test and setup session as pending before workers start. Execution outcome and
evidence status are separate: `uploading` while evidence is pending, `complete` only after execution has ended and
every staged artifact is acknowledged, or `partial` when capture warnings or missing original model records remain.
Replay can complete reporting after execution without changing its outcome. Older spools keep their existing protocol
and are never assigned an invented completeness receipt. A missing child producer marker prevents a fabricated passed
run; the original process exit status remains unchanged.

Failure metadata identifies explicit seed/setup failures, model request errors, unresolved targets, low confidence,
failed assertions and browser errors. It supplements the original error and preserves the same thresholds, steps,
retries and outcomes. “Target could not be resolved” describes the engine/model result, not proof that the UI element
physically does not exist.

### Reports

In `intent-tests/<app>/reports/` (gitignored), or `AT_REPORT_DIR`:

- `report.html`: per file, test and step: what the model picked, its probability, the top candidates, latency,
  tokens, and a screenshot taken just before each action with the target outlined. Open it in a browser.
- `results.json`: the same, machine-readable, plus the run's settings (model, thresholds, timeouts, cost).
- `progress.json`: live progress, read by `intent-test progress`.
- `playwright/`: Playwright's own report with **traces** of failed tests: `npx playwright show-report <dir>/playwright`.
- `exclusive/`: the same files for the `@exclusive` pass.
- `decisions/`, `decider-errors/`: model calls (with `AT_LOG_DECISIONS=true`) and failed requests.

### Develop mode

`intent-test develop --app <app> [--headed]` (or `AT_APP_DIR=<path>`) is the engine side of Intent Launcher's Develop
view (or any other client), where a person and their AI agent (through Launcher's MCP server) write and fix tests in one live browser. It
keeps one Chromium context open and takes newline-delimited JSON requests on stdin, answering each on stdout (replies
and events only; logs go to stderr). The protocol is `src/develop/protocol.ts`, with its JSON Schema in
`docs/contract/develop-protocol.schema.json` (regenerate with `npm run contract:develop`).

- **Same execution as a run.** `start` builds the context like a test's (Desktop Chrome, `VIEWPORT`/`TIMEZONE` or the
  app config, `BASE_URL` or the config's `webServer`, which it starts when needed), logs in for the case's `session:`
  (API login for a plain login block, otherwise the block's steps), then runs its seed. Steps run through the same
  `StepRunner`, snapshot and decider (`AT_DECIDER`) as in a run; a failed step leaves the page as it is.
  `verify_step` asks the resolver which element a step (or a trial wording) would act on, without acting.
- **Autosave.** `edit_step`, `insert_step`, `delete_step` and `set_meta` rewrite only the touched lines of the case's
  `## Test:` section (steps renumbered, line endings and every other byte kept), save at once and re-parse the app;
  a file the parser then rejects is still saved and the error is reported. `new_case` appends a section tagged
  `@draft`; `discard_case` removes a draft's section (and its file when nothing else was in it). Git is the undo.
- **Screencast and input.** The browser may run headless: frames are streamed over CDP (`Page.startScreencast`) and
  the person's mouse and keyboard are replayed with CDP input events. `--headed` also opens a visible window.
- **Recording.** `record` turns clicks and typing into steps in the engine's own wording (`src/develop/recorder.ts`),
  and checks each through the resolver.
- **Base URL.** A session opens at `BASE_URL` (the profile) or the app config's `webServer`, as a run does; `hello`
  reports that default (`baseUrl`, null when neither is set). A `start` may name `baseUrl` instead (an absolute http(s) address: Launcher sends the running
  environment or address the person picked), and that origin stays the base for later starts, so an agent's
  `develop_start` opens the same environment; `baseUrl: null` returns to the default. The session's base becomes
  `BASE_URL` in the engine process, so seeds and `switch to session` logins use it too.
- **No reporting.** Develop sessions need no dashboard token and report nothing. Their files go to
  `<app>/reports/develop/` (decision logs with `AT_LOG_DECISIONS=true`, saved session states for `switch to session`).
  Seed cleanup runs on `stop` unless `AT_KEEP_SEED=true`. The process exits 0 when stdin closes or on SIGINT/SIGTERM,
  after closing the browser.

Cases tagged `@draft` (new cases start as drafts) are left out of `intent-test run`, its `--list` and dashboard
discovery unless `AT_INCLUDE_DRAFTS=true`; `catalog` and `publish-suite` still list them with `draft: true`, and the
`refs:` line (e.g. TestRail case ids) as `refs`. A draft is the only case that may have no steps yet; a step-less
draft is never run, whatever `AT_INCLUDE_DRAFTS` says.

### Exclusive tests

Tests tagged `@exclusive` change something global (a bulk invitation, auto-booking, shared configuration) and must
not run next to other tests. `intent-test run` (`src/cli/run-suite.ts`) runs two passes: first every other test with the usual workers, then
the exclusive ones one at a time with nothing else running. The second pass always runs, also after failures.
Running `npx playwright test` yourself would start both projects together, so use the CLI. `AT_WORKERS` or
`--workers=N` set parallel workers; the CLI enforces one worker for the exclusive phase. `--project=parallel` or
`--project=exclusive` selects one phase without letting Playwright overlap the projects.

## Writing tests

The format is specified in [docs/test-format.md](docs/test-format.md) (steps, sessions, blocks, seeds, variables,
optional steps, tags). In short:

```markdown
## Test: Check in a patient by name
id: reception.check-in-by-name
session: log in as reception
seed: patient booked for today
1. open "/app/reception/worklist"
2. click the "Check in" action in the row for "{{seed.name}}"
3. select "Private" in the "Insurance" dropdown
4. check "Consent form signed"
5. click "Confirm check-in"
6. expect the worklist shows "{{seed.name}}" with status "Checked in" within 10 seconds
```

Tips from building real suites:

- **Quote the visible label** (`click the "Send invitation" button`). For click, check, fill and select, the runner
  first offers the model only the elements whose name contains the first quoted text; fewer options make it surer.
- **One fact per `expect`.** "Errors say first name, last name and doctor are required" scored 0.80; split into
  single facts, each scored above 0.97.
- **Name the row by content or position**: `in the row for "X"` or `in the first row`. Every element carries its row
  number and cell values, so the model never has to count.
- **Use `within N seconds`** for anything that changes after a background request, instead of `wait`.
- **Describe what is on the screen.** `click the "Next" button` beats `click the Next button of the arrival form`
  when the form's name isn't next to the button: a detail that doesn't match the screen makes the model doubt.

Check your files with `parse` before running them; it catches unknown steps, missing variables, unknown seeds,
sessions and blocks in a second.

### Seeds

`seeds.ts` in the app folder exports `seeds: Record<string, Seed>`. A test picks one with `seed: <name>`; it runs
before step 1, returns `vars` (used as `{{seed.<key>}}`) and optionally a `cleanup` (skipped with
`AT_KEEP_SEED=true`). The seed context (`SeedContext` in [`src/seeds.ts`](src/seeds.ts)) gives `baseURL`, `testId`
(from the file name: `bk-01-….md` → `BK01`; put it in generated names), `newRequest()`, `login(user, password)`
through the app's `auth` hook, and `log()`. To learn which API calls a UI flow makes, run it once with
`AT_NET_LOG=/tmp/net.jsonl` (bodies may contain personal data; delete the file afterwards).
A seed of a parameterized test also gets its row as `ctx.params`.

### Parameter sets

`parameters.ts` in the app folder exports `parameters: Record<string, ParameterSet>`. A test with
`parameters: <name>` runs once per row and reads it as `{{param.<key>}}`; see
[Parameterized tests](docs/test-format.md#parameterized-tests). `AT_PARAMS=first` (or a comma-separated list of row
keys) runs only those rows while writing a test.

## Decision models

Pick one with `AT_DECIDER` or the app config's `decider`. Presets are in
[`src/decider/presets.ts`](src/decider/presets.ts); keys always come from the environment. An app adds its own (a
self-hosted or experimental model) with `presets` in its config, using the same `Preset` shape:

```ts
export default defineConfig({
  decider: 'my-model',
  presets: {
    'my-model': {
      description: 'Our self-hosted model', url: 'http://${MODEL_HOST}:8011/v1/systemone', model: 'my-model',
      sendModel: false, maxOptions: 255, usdPerMInput: 0, choiceThreshold: 0.8, yesNoThreshold: 0.8,
    },
  },
});
```

| `AT_DECIDER` | Backend | Needs | Price per M input tokens |
|---|---|---|---|
| `jev` (default) | TypeSafe Jev, `api.typesafe.ai`; reads screenshots (experimental), `fallback` by default | `TYPESAFE_API_KEY` | $0.042 |
| `openai` | OpenAI Decisions API, `gpt-6-luna` (thresholds 0.6); reads screenshots, `fallback` by default | `OPENAI_API_KEY` | $0.10 |
| `microsoft` | Microsoft-Decision-1 on Microsoft Foundry (`AT_DECIDER_MODEL` = your deployment name) | `MICROSOFT_FOUNDRY_KEY`, `MICROSOFT_FOUNDRY_ENDPOINT` | $0.042 |
| `clef-flash`, `clef` | Cloudflare Workers AI | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | $0.09, $0.24 |
| `d3-ultra` | vllm-sr Decision 3.0 d3-ultra, `decision.vllm-sr.ai` (logs requests: test data only); reads screenshots, `fallback` by default | `VLLM_SR_API_KEY` | free |
| `llamacpp` | A llama.cpp server with `/v1/systemone` you started on port 8080 (`AT_DECIDER_MODEL` names the model) | nothing | free |
| `stub` | The self-test decider: offline, deterministic, matches quoted labels. Not a model | nothing | free |

Any other System One endpoint: `AT_DECIDER_URL=https://…/v1/systemone AT_DECIDER_API_KEY=…`. A different kind of API
plugs in by implementing the `Decider` interface in [`src/decider/types.ts`](src/decider/types.ts). A missing key or
an unknown preset stops the run before it starts. The report header and `results.json` show the model and every
setting it ran with.

"Confidence" is always the **probability of the option the model picked**, whatever the server calls confidence
(models compute it differently); the server's own value is kept as `reportedConfidence`.

## Settings

Every command, flag, environment variable and config key is listed in [docs/reference.json](docs/reference.json),
shown as **Engine reference** on the dashboard.

Env precedence: existing process variables (shell/CI) > `intent-tests/.env` (shared, Git-ignored) >
`<app>/.env` (app-specific, Git-ignored) > `<app>/.env.<AT_ENV>` (default `dev`). Put shared credentials in the shared file and URLs/accounts in each app's
profile. External `AT_APP_DIR` folders, including the self-test fixture, load only their own env files.
The ones marked *config* can also be set in `intent-tests.config.ts`.

**App and run**

| Env var | Default | Meaning |
|---|---|---|
| `AT_APP` / `--app` | — | App folder name under `intent-tests/` |
| `AT_APP_DIR` | — | App folder path instead (used by the self-test) |
| `AT_APPS_DIR` | `./intent-tests`, else the nearest folder with `intent-workspace.json` | Folder that holds the app folders |
| `AT_ENV` | `dev` | Loads `<app>/.env.<AT_ENV>` |
| `AT_CASE_IDS` | all selected cases | Exact durable IDs separated by commas/whitespace; `--case-id` is repeatable and overrides this selection |
| `INTENT_ALLOW_OUTDATED` | unset | `1`/`true`: run an engine below the dashboard's minimum version (same as `--allow-outdated`); the run is marked outdated |
| `AT_RUN_PURPOSE` (*config* `purpose`) | the dashboard decides | `verification` or `authoring`; `--purpose` overrides. Without it, runs by an automation token are verification and every other run is authoring |
| `AT_LAUNCHER_INSTALLATION_ID` | unset | Set by the Launcher desktop app: its installation (a UUID), recorded on the run. Ignored from any other reporter |
| `AT_TESTS` | whole app | Run one subfolder or file of the app, e.g. `booking` |
| `AT_PARAMS` | all rows | Keep a subset of every parameter set's rows (`first` or row keys) |
| `AT_INCLUDE_DRAFTS` | false | `true` also runs cases tagged `@draft` (otherwise left out of `run`, `--list` and discovery) |
| `BASE_URL` | — | The app under test (required unless the app config has a `webServer`) |
| `IGNORE_HTTPS_ERRORS` | false | Accept self-signed certificates |
| `AT_WORKERS` (*config* `workers`) | 2 | Parallel tests, locally and in CI; exclusive tests always use 1 |
| `AT_TEST_TIMEOUT_MS` (*config* `testTimeoutMs`) | 90000 | Time for one whole test; long multi-role flows need more (e.g. 900000) |
| `AT_REPORT_DIR` | `<app>/reports` | Where reports go (relative to the current folder) |

**Browser**

| Env var | Default | Meaning |
|---|---|---|
| `VIEWPORT` (*config* `viewport`) | 1280x720 | `WIDTHxHEIGHT`; raise it when a dialog doesn't fit and doesn't scroll |
| `TIMEZONE` (*config* `timezone`) | machine | Browser time zone; seeds use it too |
| `PW_VIDEO` | off | `on` records a video of every test |

**Decision model and timing**

| Env var | Default | Meaning |
|---|---|---|
| `AT_DECIDER` (*config* `decider`) | jev | Preset, see above |
| `AT_DECIDER_MODEL`, `AT_DECIDER_URL`, `AT_DECIDER_API_KEY` | per preset | Another model id, endpoint or key |
| `AT_DECIDER_MAX_OPTIONS`, `AT_DECIDER_USD_PER_M_INPUT` | per preset | Choice option limit; price for the cost estimate |
| `AT_DECIDER_IMAGES` | fallback (`jev`, `openai`, `d3-ultra`); false for the others | Screenshots for models that read images. `fallback`: an element choice (click, fill, check, select) whose text-only answer is below the threshold is asked again with a viewport screenshot, scrolled to the element the model leaned to; that answer decides. A text-only "none" at 0.9 or more is not re-asked. `true`: a screenshot with every element, condition and `expect` question. `jev` (experimental on TypeSafe's side) and `openai` support only `fallback`; `d3-ultra` both. Jev takes at most 1568 px a side, so a larger viewport is captured scaled down. `jev`, `openai` and `d3-ultra` use `fallback` unless set; `false` turns screenshots off |
| `AT_CHOICE_THRESHOLD` (*config* `choiceThreshold`) | 0.8 (per preset) | Minimum probability to act on an element |
| `AT_YESNO_THRESHOLD` (*config* `yesNoThreshold`) | 0.8 (per preset) | Minimum yes probability for an `expect` |
| `AT_RESOLVE_TIMEOUT_MS` (*config* `resolveTimeoutMs`) | 3000 | How long an optional step or a plain `expect` keeps looking |
| `AT_REQUIRED_RESOLVE_TIMEOUT_MS` (*config* `requiredResolveTimeoutMs`) | 10000 | The same for a required step (slow forms and dialogs) |
| `AT_MIN_LOOKS` | 3 | Looks at the page before a step fails, even after its timeout (slow models) |
| `AT_POLL_INTERVAL_MS` | 500 | Pause between looks |
| `AT_SETTLE_MS` (*config* `settleMs`) | 250 | Pause after each action |
| `AT_MAX_REQUEST_CHARS` | 80000 | Above this, table rows are described by number only (very long worklists) |

**Sessions, data and debugging**

| Env var | Default | Meaning |
|---|---|---|
| `AT_LOGIN` | (the app's `auth`, else `ui`) | `ui` logs every session in through its steps instead of the app's API login |
| `AT_ANONYMOUS_FRESH_COOKIES` | true | A non-login session (e.g. "participant (not logged in)") starts each test without server cookies |
| `AT_KEEP_SEED` | false | Skip seed cleanup, to look at the data in the app |
| `AT_DEBUG` | false | On a failed step, list every candidate element, or what the page showed for an `expect` |
| `AT_LOG_DECISIONS` | false | Write every model call with its full input to `<reports>/decisions/` |
| `AT_NET_LOG` | — | File path: append the app's API calls as JSON lines (for writing seeds) |

**Dashboard reporting** (see [Dashboard reporting](#dashboard-reporting-optional))

| Env var | Default | Meaning |
|---|---|---|
| `AT_DASHBOARD_URL` | `dashboard` in `intent-workspace.json`; none: local reports only | The dashboard runs report to |
| `AT_DASHBOARD_TOKEN` | — (required when reporting: `run`, `publish-suite`, `replay`) | Dashboard token: a personal access token locally, an automation token in CI (`CI=true`). Secret |
| `AT_RUN_NAME` | `<App> intent suite` | Run display name |
| `AT_DASHBOARD_PRODUCT_KEY` | `intent-workspace.json` (required when reporting, unless set here) | Product the run reports into; it must exist on the dashboard |
| `AT_DASHBOARD_APP_KEY`, `AT_DASHBOARD_APP_NAME` | app folder name | Application key, and its name when the dashboard creates it |
| `AT_DASHBOARD_BRANCH`, `AT_DASHBOARD_COMMIT_SHA` | CI variables, else Git | Branch and commit on the run |
| `AT_DASHBOARD_ENVIRONMENT` | `AT_ENV`, else `dev` | Environment label on the run |
| `AT_DASHBOARD_TRIGGERED_BY` | `CI` in CI, else `USER` | Who started the run |
| `AT_DASHBOARD_SUITE_REVISION` | — | Label for the captured suite snapshot; does not change its hash |
| `AT_ENVIRONMENT_BUILD_ID` | discovered from the running app | Links the run to an Intent Launcher environment version |
| `AT_DASHBOARD_PHASE`, `AT_DASHBOARD_SPOOL_DIR`, `AT_DASHBOARD_DISCOVERY_DIR` | — | Internal: set by `run` for its Playwright children (current pass, upload spool, discovery output). Do not set them |

## How it uses Playwright

Each `## Test:` becomes a normal Playwright test (`src/specs/tests.spec.ts`), each step a `test.step`. Playwright
provides parallel workers, timeouts, the session setup project (`src/specs/sessions.setup.ts`), traces, videos,
`--grep` and reporters. The runner only adds the decision part: snapshot, decide, act.

## Layout

```
playwright.intent.config.ts  Playwright config (not playwright.config.ts, so tools that infer e2e targets ignore it)
docs/test-format.md          the test format spec (v1)
docs/reference.json          commands, flags, env vars, config keys and modifiers; shown as the dashboard's Engine reference
docs/authoring.md            the primer agents read before writing tests
docs/contract/               develop-protocol.schema.json, generated from src/develop/protocol.ts
scripts/develop-contract.mjs generates it (npm run contract:develop)
src/index.ts                 what app folders import: defineConfig and the seed/config types
src/define-config.ts         AppConfig, AuthHook
src/app.ts                   which app folder (AT_APP / AT_APP_DIR / --app), reports folder, AT_TESTS filter
src/app-config.ts            loads intent-tests.config.ts and resolves its auth hook
src/env.ts                   env files: process > intent-tests/.env > <app>/.env > <app>/.env.<AT_ENV>
src/config.ts                engine defaults (timeouts, thresholds) merged with app config and env
src/parse.ts                 the step grammar, `use` expansion, file discovery
src/suite.ts                 loads the app once per worker; runs a list of steps (seed, login, steps, cleanup)
src/login.ts                 API login through the auth hook, fresh anonymous sessions
src/seeds.ts                 SeedContext and loading seeds.ts
src/parameters.ts            loading parameters.ts; the suite with templates expanded (loadSuite)
src/snapshot.ts              page → elements and page text
src/steps.ts                 resolve → outline + screenshot → act → settle; thresholds and retries
src/reporter.ts              report.html, results.json, progress.json
src/decider/                 Decider interface, System One / OpenAI clients, presets, stub
src/develop/                 develop mode: protocol, session, case edits, screencast/input, recorder, test context
src/cli/develop.ts           intent-test develop: the develop session on stdin/stdout
src/specs/                   the Playwright entry points (sessions setup, tests)
src/cli/                     the commands: run-suite.ts, parse.ts, parse-all.ts, ids.ts, catalog.ts, progress.ts, serve.ts, …
test/                        unit tests (node:test)
test/fixture/                demo clinic app (site/), its demo tests (tests/, for a real model) and the self-test
```

The demo app has traps on purpose: near-identical names (Ana Petrova / Anna Petrovska), the same button on every
row, disabled buttons, modal dialogs, two "Register walk-in" links, an icon-only button, and a planted bug (Cancel
shows a toast but doesn't change the status). `npm run test:self` runs `test/fixture/self-test` with the stub decider.
To run the demo tests against a real model: `AT_APP_DIR=test/fixture AT_TESTS=tests npx intent-test run` with the
model's key set (add `-g "<name>"` for some). Its `intent-workspace.json` names the engine's own development product,
so set `AT_DASHBOARD_URL` and a token to report the run, or delete that file in your checkout to keep it local.
