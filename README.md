# Intent Tests

Plain-English UI tests, run in a real browser by [Playwright](https://playwright.dev) and a decision model. A step
names what a person would do (`click the "Confirm" button`); the runner finds the element, and when it is not
confident, the step fails instead of guessing.

| Folder | What it is |
| --- | --- |
| [`engine/`](engine/) | `@sorsix/intent-engine`: the test format, the runner and its CLI. Start with [engine/README.md](engine/README.md). |

Licensed under the [Apache License 2.0](LICENSE).
