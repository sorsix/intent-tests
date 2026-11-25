# Intent Tests

[![CI](https://github.com/sorsix/intent-tests/actions/workflows/ci.yml/badge.svg)](https://github.com/sorsix/intent-tests/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)

**UI tests written the way a person would describe them, run in a real browser.**

```markdown
## Test: Check in a patient by name
id: check-in-a-patient-by-name
session: log in as reception
1. open "/worklist.html"
2. click the "Check in" action in the row where patient is "Ana Petrova"
3. select "Private" in the insurance dropdown
4. check the "Consent form signed" checkbox
5. click "Confirm check-in"
6. expect the worklist shows "Ana Petrova" with status "Checked in"
```

There are no selectors, page objects or test IDs. [Playwright](https://playwright.dev) drives the browser, and a
**decision model** answers one narrow question per step: *which element on this page does the step mean?*, or *is this
statement true?* Everything else — the test grammar, the page description, waiting, clicking, typing, reporting — is
plain, deterministic code.

## When it is not sure, the step fails

The model's answer comes with a probability. When it is below the threshold, or the model answers that no element
matches, the step keeps looking until its timeout and then **fails** — before it clicks anything. The runner never
falls back to "the closest match" or retries with a looser question, so a red test means something is really wrong,
not that the runner gave up being careful.

## How a step runs

1. **Parse.** The step grammar is fixed and checked before any browser starts. An unknown verb or a malformed step is
   an error with the file and line, never something the model interprets.
2. **Describe the page.** The page becomes a compact list of elements: role, visible label, state, the section or
   dialog it is in, and for table cells the row and its values.
3. **Decide.** The model picks one of those elements (or "none") for an action, or answers yes/no for an `expect`.
4. **Act.** Playwright clicks, fills, selects or checks the chosen element, takes a screenshot with it outlined, and
   waits for the page to settle.

The HTML report shows every step with the element that was picked, the model's confidence and the screenshot; a
failed step also lists the candidates the model considered.

## Try it

You need Node.js 22.18 or newer.

```bash
git clone https://github.com/sorsix/intent-tests.git
cd intent-tests/engine
npm ci
npx playwright install chromium
npm run test:self    # the bundled demo clinic in a real browser, with an offline stub model: no API key, no network
```

The demo clinic in [`engine/test/fixture`](engine/test/fixture) has traps on purpose: near-identical patient names,
the same button on every row, disabled buttons, modal dialogs and a planted bug. To run its tests with a real decision
model, set the model's key (for example `TYPESAFE_API_KEY` for the default model), remove
`engine/test/fixture/intent-workspace.json` in your checkout so the run stays local, and run:

```bash
AT_APP_DIR=test/fixture AT_TESTS=tests node bin/intent-test.mjs run -g "Check in a patient by name"
```

Then open `engine/test/fixture/reports/report.html`.

## Use it on your application

Add the engine to your application's repository and write tests in `intent-tests/<app>/`. Public npm releases are
being set up; until then, run `npm pack` in `engine/` and install the tarball it creates.

```bash
npm install --save-dev --save-exact ./sorsix-intent-engine-<version>.tgz   # later: @sorsix/intent-engine
npx --no-install intent-test parse --app my-app     # check the test files: no browser, no model
npx --no-install intent-test run --app my-app       # run them
```

An app folder holds the tests as Markdown, the login steps per role, an optional `intent-tests.config.ts` (login hook,
decision model, timeouts), and optional seeds that create test data through your API before a test. See the
[engine README](engine/README.md) and the [test format](engine/docs/test-format.md).

## What is in this repository

| Folder | Status | What it is |
| --- | --- | --- |
| [`engine/`](engine/) | Available | `@sorsix/intent-engine`: the test format, parser, runner, decision-model clients, HTML report and the `intent-test` CLI. |
| `dashboard/` | Planned | A reporting portal: every run, test and step with its pick, confidence and screenshot; history per test case across runs and branches; model usage and cost. The engine already reports to it when one is configured. |
| `launcher/` | Planned | A desktop app that runs a version of the application under test locally (database, backend, frontend), runs and develops intent tests against it, and lets a person and their coding agent fix a failing step together. |

The engine works on its own: without a dashboard, every run keeps its reports locally.

## Decision models

The engine talks to a decision model over HTTP. Presets for hosted models ship with it, and an application can add its
own (for example a self-hosted model) in its config. Keys always come from the environment. Which model, which
threshold and how a step is worded all change how reliably a step picks the same element, so run a new case a few times
and compare its picks in the report before you rely on it.

## Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](.github/CONTRIBUTING.md) first: contributions are under
Apache 2.0 with a DCO sign-off. Report security issues privately, as described in [SECURITY.md](.github/SECURITY.md).
This project follows a [code of conduct](.github/CODE_OF_CONDUCT.md).

## License

[Apache License 2.0](LICENSE). Copyright 2026 Sorsix.
