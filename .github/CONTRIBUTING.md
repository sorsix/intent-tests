# Contributing to Intent Tests

Thank you for helping. Bug reports, test-format ideas and pull requests are all welcome.

## Before you start

- **A bug:** open an issue with the step text, what the engine picked (the step's candidates and the model's answer
  from `report.html`, or a run with `AT_DEBUG=true`), and what you expected. A minimal page that reproduces it, like the
  ones in `engine/test/fixture/site/`, makes a fix much faster.
- **A new step verb, modifier or setting:** open an issue first. The test format is a contract with every suite that
  uses it, so changes are discussed before they are built.
- Read [engine/AGENTS.md](../engine/AGENTS.md): it lists the rules the engine keeps (fail rather than guess, a deterministic parser,
  settings precedence) and where each kind of change lives. It is written for AI agents and people alike.

## Development

Node 22.18 or newer. The engine's commands run in its folder:

```bash
cd engine
npm install
npx playwright install chromium
npm run typecheck
npm test            # unit tests
npm run test:self   # the demo clinic in a real browser with the offline stub decider (~20 s, no API key)
npm run format
```

Pull requests need all of these passing. Add or update a unit test for the behaviour you change, and a case in
`engine/test/fixture/self-test/engine.md` when the stub decider can exercise it. Every new or changed command, flag,
environment variable or config key also goes into `engine/docs/reference.json` (a test checks it) and the engine's README.

## Developer Certificate of Origin

Contributions are accepted under the project's [Apache 2.0 license](../LICENSE). Sign off every commit to certify the
[Developer Certificate of Origin](https://developercertificate.org/):

```bash
git commit -s -m "Describe what the change does"
```

## How changes are merged

This repository is published from Sorsix's internal monorepo. A maintainer reviews your pull request here; once it is
approved, it is applied in the monorepo with your authorship kept and released with the next version, and the pull
request is closed with a link to that release. You will be credited as a co-author of the release commit.
