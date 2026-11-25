// One Playwright test per "## Test:" in the app's .md files, grouped by file; one test.step per step.
// Tests with a `session:` line start from the browser state saved by sessions.setup.ts.
import { test } from '@playwright/test';
import { runSteps, sessionFile, suite } from '../suite.ts';
import { clientTestId } from '../parse.ts';

for (const file of suite.files) {
  if (file.cases.length === 0) continue;

  test.describe(file.rel, () => {
    for (const tc of file.cases) {
      const define = () =>
        test(
          tc.name,
          {
            tag: tc.tags,
            annotation: [
              { type: 'at-file', description: file.rel },
              { type: 'at-line', description: String(tc.line) },
              { type: 'at-client-test-id', description: clientTestId(tc) },
              ...(tc.explicitId ? [{ type: 'at-explicit-id', description: tc.explicitId }] : []),
              { type: 'at-kind', description: 'test' },
              ...(tc.seed ? [{ type: 'at-seed', description: tc.seed }] : []),
              ...(tc.template
                ? [{ type: 'at-template-client-test-id', description: tc.template.clientTestId }]
                : []),
              ...(tc.parameters
                ? [{ type: 'at-parameters', description: JSON.stringify(tc.parameters) }]
                : []),
              ...(tc.session ? [{ type: 'at-session', description: tc.session }] : []),
            ],
          },
          async ({ page, browser }, testInfo) => {
            if (tc.expectFail) test.fail();
            await runSteps(
              page,
              testInfo,
              tc.steps,
              {
                kind: 'test',
                file: file.rel,
                line: tc.line,
                session: tc.session,
                seed: tc.seed,
                parameters: tc.parameters,
              },
              browser,
            );
          },
        );

      if (tc.session) {
        test.describe(() => {
          test.use({ storageState: sessionFile(tc.session!) });
          define();
        });
      } else {
        define();
      }
    }
  });
}
