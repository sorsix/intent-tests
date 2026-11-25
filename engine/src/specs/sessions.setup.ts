// Runs each step block used as a `session:` once, then saves the browser state for the tests.
import { failureFor, markFailure } from '../failure.ts';
import { test as setup } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { authHook } from '../app-config.ts';
import { apiLogin, apiLoginCredentials } from '../login.ts';
import { runSteps, sessionFile, suite } from '../suite.ts';

for (const name of suite.sessions) {
  const block = suite.blocks.get(name)!;
  setup(
    `Session: ${name}`,
    {
      tag: '@session',
      annotation: [
        { type: 'at-file', description: block.file },
        { type: 'at-line', description: String(block.line) },
        { type: 'at-session', description: name },
        { type: 'at-kind', description: 'session' },
        {
          type: 'at-client-test-id',
          description: `session:${process.env.AT_DASHBOARD_PHASE || 'sessions'}:${name}`,
        },
      ],
    },
    async ({ page }, testInfo) => {
      try {
        const creds = apiLoginCredentials(name);
        if (creds) {
          // A login block: log in by API, then load the app once so it sets up its local storage.
          await apiLogin(page.context(), process.env.BASE_URL!, creds);
          await page.goto(authHook()!.homePath);
          await page.waitForURL((url) => !url.pathname.endsWith('/login'), { timeout: 30_000 });
        } else {
          await runSteps(page, testInfo, block.steps, {
            kind: 'session',
            file: block.file,
            line: block.line,
            session: name,
          });
        }
        const path = sessionFile(name);
        mkdirSync(dirname(path), { recursive: true });
        await page.context().storageState({ path });
      } catch (error) {
        markFailure(error, 'setup');
        await testInfo
          .attach('at-failure', {
            contentType: 'application/json',
            body: JSON.stringify(failureFor(error, 'setup')),
          })
          .catch(() => undefined);
        throw error;
      }
    },
  );
}
