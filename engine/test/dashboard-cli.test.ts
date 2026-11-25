import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { Spool } from '../src/dashboard/spool.ts';
import type { Event, Manifest } from '../src/dashboard/spool.ts';
import { DashboardSession } from '../src/dashboard/session.ts';
import { DashboardClient } from '../src/dashboard/client.ts';
const DASHBOARD = 'https://dashboard.example.test';

import { runSuite } from '../src/cli/run-suite.ts';
import type { ChildResult as Result, Execute } from '../src/cli/run-suite.ts';

function environment(t: TestContext): string {
  const saved = { ...process.env };
  const directory = mkdtempSync(join(tmpdir(), 'intent-dashboard-cli-'));
  for (const key of Object.keys(process.env).filter(
    (key) =>
      key.startsWith('AT_DASHBOARD_') ||
      ['AT_RUN_NAME', 'AT_RUN_PURPOSE', 'AT_LAUNCHER_INSTALLATION_ID'].includes(key),
  ))
    delete process.env[key];
  process.env.AT_APP_DIR = fileURLToPath(new URL('fixture', import.meta.url));
  process.env.AT_APP = 'fixture';
  process.env.AT_DASHBOARD_URL = DASHBOARD;
  process.loadEnvFile(join(process.env.AT_APP_DIR, '.env.dev'));
  process.env.AT_REPORT_DIR = join(directory, 'reports');
  process.env.AT_DECIDER = 'stub';
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}
async function endpoint(
  t: TestContext,
  status = 200,
): Promise<{ url: string; events: Event[]; requests: number; status: number }> {
  const capture = { url: '', events: [] as Event[], requests: 0, status };
  const server = createServer((request, response) => {
    void (async () => {
      let text = '';
      for await (const chunk of request) text += String(chunk);
      capture.requests++;
      capture.events.push(...((JSON.parse(text).events as Event[]) || []));
      response.writeHead(capture.status, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify(
          capture.status === 200
            ? { runId: '11111111-1111-1111-1111-111111111111', runNumber: 42 }
            : { error: 'offline' },
        ),
      );
    })().catch(() => {
      response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  capture.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return capture;
}
function phase(env: Record<string, string>, project: string, status: 'passed' | 'failed'): void {
  if (!env.AT_DASHBOARD_SPOOL_DIR) return;
  const spool = new Spool(env.AT_DASHBOARD_SPOOL_DIR);
  const clientTestId = `${project}-case`;
  spool.event({
    id: `${project}:start`,
    type: 'test.started',
    clientTestId,
    title: project,
    file: `${project}.md`,
    stepsTotal: 1,
  });
  spool.event({
    id: `${project}:step`,
    type: 'step.recorded',
    clientTestId,
    clientStepId: '1',
    text: 'click Save',
    kind: 'click',
    status,
  });
  spool.event({
    id: `${project}:finish`,
    type: 'test.finished',
    clientTestId,
    status,
    durationMs: 50,
  });
  writeFileSync(
    join(spool.dir, 'phases', `${project}.progress.json`),
    JSON.stringify({ stepsDone: 1, stepsTotal: 1, running: [] }),
  );
  writeFileSync(
    join(spool.dir, 'phases', `${project}.finished.json`),
    JSON.stringify({ status, tests: 1, stats: { modelCalls: 0, inputTokens: 0 } }),
  );
}
function discovery(env: Record<string, string>, project: string): void {
  if (env.AT_DASHBOARD_DISCOVERY_DIR)
    writeFileSync(
      join(env.AT_DASHBOARD_DISCOVERY_DIR, `${project}.json`),
      JSON.stringify({ stepsTotal: 1, tests: 1 }),
    );
}
const result = (code = 0, stdout = ''): Result => ({ code, signal: null, stdout, stderr: '' });

function dependencies(capture: { url: string }, execute: Execute) {
  return {
    execute,
    authorize: async () => {
      return undefined;
    },
    createSession: (dir: string, manifest: Manifest) => {
      assert.equal(manifest.url, DASHBOARD);
      return new DashboardSession(dir, manifest, { client: new DashboardClient(capture.url) });
    },
  };
}

test('authenticated CLI captures both phases and uploads the final reporting receipt', async (t) => {
  environment(t);
  const capture = await endpoint(t);
  const calls: string[] = [];
  const execute: Execute = async (project, args, env, list) => {
    calls.push(project + (list ? ':list' : ':run'));
    if (list) {
      discovery(env, project);
      return result(0, 'tests.spec.ts:1:1 fixture');
    }
    assert.equal(capture.events.filter((event) => event.type === 'run.finished').length, 0);
    assert.equal(env.AT_LOG_DECISIONS, 'true');
    if (project === 'exclusive') assert(args.includes('--workers=1'));
    phase(env, project, 'passed');
    return result();
  };
  assert.equal(await runSuite([], dependencies(capture, execute)), 0);
  assert.deepEqual(calls, ['parallel:list', 'exclusive:list', 'parallel:run', 'exclusive:run']);
  assert.equal(capture.events.filter((event) => event.type === 'run.started').length, 1);
  assert.equal(capture.events.filter((event) => event.type === 'run.finished').length, 1);
  assert.equal(capture.events.at(-1)?.type, 'run.reporting');
  assert.equal(capture.events.at(-1)?.status, 'complete');
});

for (const explicit of [false, true]) {
  test(`CLI uploads the ${explicit ? 'explicit' : 'running app'} build ID before starting workers`, async (t) => {
    environment(t);
    const capture = await endpoint(t);
    let requests = 0;
    const discovered = '22222222-2222-4222-8222-222222222222',
      override = '33333333-3333-4333-8333-333333333333';
    const app = createServer((request, response) => {
      requests++;
      assert.equal(request.url, '/.well-known/intent-launch/environment');
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({
          kind: 'intent-launch-environment',
          schemaVersion: 1,
          buildId: discovered,
          label: 'untrusted label',
        }),
      );
    });
    await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
      app.closeAllConnections();
      await new Promise<void>((resolve) => app.close(() => resolve()));
    });
    process.env.BASE_URL = `http://127.0.0.1:${(app.address() as AddressInfo).port}/app/`;
    if (explicit) process.env.AT_ENVIRONMENT_BUILD_ID = override;
    else delete process.env.AT_ENVIRONMENT_BUILD_ID;
    const execute: Execute = async (project, _args, env, list) => {
      if (list) {
        discovery(env, project);
        return result(0, 'tests.spec.ts:1:1 fixture');
      }
      const started = capture.events.find((event) => event.type === 'run.started');
      assert.equal(started?.environmentBuildId, explicit ? override : discovered);
      assert.equal(started?.environmentBuild, undefined);
      assert(!JSON.stringify(started).includes('untrusted label'));
      phase(env, project, 'passed');
      return result();
    };
    assert.equal(await runSuite([], dependencies(capture, execute)), 0);
    assert.equal(requests, explicit ? 0 : 1);
  });
}
async function started(t: TestContext, argv: string[]) {
  const capture = await endpoint(t);
  const execute: Execute = async (project, _args, env, list) => {
    if (list) {
      discovery(env, project);
      return result(0, 'tests.spec.ts:1:1 fixture');
    }
    phase(env, project, 'passed');
    return result();
  };
  assert.equal(await runSuite(argv, dependencies(capture, execute)), 0);
  return capture.events.find((event) => event.type === 'run.started')!;
}

test('run.started leaves the purpose to the dashboard unless it is declared', async (t) => {
  environment(t);
  const event = await started(t, []);
  assert.equal('purpose' in event, false);
  assert.equal('launcherInstallationId' in event, false);
});

test('--purpose and AT_RUN_PURPOSE declare what the run is for, the flag winning', async (t) => {
  environment(t);
  assert.equal((await started(t, ['--purpose', 'verification'])).purpose, 'verification');
  assert.equal((await started(t, ['--purpose=authoring'])).purpose, 'authoring');
  process.env.AT_RUN_PURPOSE = 'verification';
  assert.equal((await started(t, [])).purpose, 'verification');
  assert.equal((await started(t, ['--purpose=authoring'])).purpose, 'authoring');
});

test('an invalid purpose stops the run before anything is reported', async (t) => {
  environment(t);
  const capture = await endpoint(t);
  const execute: Execute = async () => assert.fail('nothing runs');
  await assert.rejects(
    runSuite(['--purpose', 'exploring'], dependencies(capture, execute)),
    /--purpose must be verification or authoring/,
  );
  process.env.AT_RUN_PURPOSE = 'sometimes';
  await assert.rejects(
    runSuite([], dependencies(capture, execute)),
    /run purpose must be verification or authoring/,
  );
  assert.equal(capture.requests, 0);
});

test('the Launcher installation from AT_LAUNCHER_INSTALLATION_ID is reported when it is a UUID', async (t) => {
  environment(t);
  process.env.AT_LAUNCHER_INSTALLATION_ID = '4F0C1C0E-6C77-4B51-9D55-0F2C2D5B7E11';
  assert.equal(
    (await started(t, [])).launcherInstallationId,
    '4f0c1c0e-6c77-4b51-9d55-0f2c2d5b7e11',
  );
  process.env.AT_LAUNCHER_INSTALLATION_ID = 'not-a-uuid';
  assert.equal('launcherInstallationId' in (await started(t, [])), false);
});

test('list mode makes no token validation or dashboard requests', async (t) => {
  const directory = environment(t),
    capture = await endpoint(t);
  const execute: Execute = async (project, _args, env, list) => {
    assert(list);
    assert.equal(env.AT_DASHBOARD_SPOOL_DIR, '');
    assert.equal(env.AT_DASHBOARD_DISCOVERY_DIR, '');
    return result(project === 'exclusive' ? 2 : 0, 'tests.spec.ts:1:1 fixture');
  };
  assert.equal(
    await runSuite(['--list'], {
      execute,
      authorize: async () => {
        throw Error('must not authenticate a listing');
      },
    }),
    2,
  );
  assert.equal(capture.requests, 0);
  assert(!existsSync(join(directory, 'reports', 'dashboard')));
});
for (const scenario of [
  { name: 'personal access', ci: '', error: /personal access token/ },
  { name: 'automation', ci: 'true', error: /automation token/ },
]) {
  test(`missing ${scenario.name} token prevents even test discovery`, async (t) => {
    const directory = environment(t);
    let calls = 0;
    // Select the mode explicitly: the developer shell or CI host must not change this case.
    process.env.CI = scenario.ci;
    const execute: Execute = async () => {
      calls++;
      return result();
    };
    await assert.rejects(runSuite([], { execute }), scenario.error);
    assert.equal(calls, 0);
    assert(!existsSync(join(directory, 'reports', 'dashboard')));
  });
}
test('failed initial registration retains the spool and never starts workers', async (t) => {
  const directory = environment(t),
    capture = await endpoint(t, 503);
  let ran = false;
  const execute: Execute = async (project, _args, env, list) => {
    if (list) {
      discovery(env, project);
      return result(0, 'tests.spec.ts:1:1 fixture');
    }
    ran = true;
    return result();
  };
  await assert.rejects(runSuite([], dependencies(capture, execute)), /registration failed/);
  assert.equal(ran, false);
  assert.equal(readdirSync(join(directory, 'reports', 'dashboard')).length, 1);
});
test('upload failure after execution returns nonzero and retains original outcomes for replay', async (t) => {
  const directory = environment(t),
    capture = await endpoint(t);
  const executed: string[] = [];
  const execute: Execute = async (project, _args, env, list) => {
    if (list) {
      discovery(env, project);
      return result(0, 'tests.spec.ts:1:1 fixture');
    }
    executed.push(project);
    phase(env, project, 'passed');
    capture.status = 503;
    return result();
  };
  assert.equal(await runSuite([], dependencies(capture, execute)), 1);
  assert.deepEqual(executed, ['parallel', 'exclusive']);
  const dir = join(
    directory,
    'reports',
    'dashboard',
    readdirSync(join(directory, 'reports', 'dashboard'))[0],
  );
  assert.equal(
    new Spool(dir).events(true).find((event) => event.type === 'test.finished')?.status,
    'passed',
  );
  assert(new Spool(dir).events().length > 0);
});
test('incomplete evidence never reports success and retains the passed test outcome', async (t) => {
  const directory = environment(t),
    capture = await endpoint(t);
  const execute: Execute = async (project, _args, env, list) => {
    if (list) {
      discovery(env, project);
      return result(0, 'tests.spec.ts:1:1 fixture');
    }
    phase(env, project, 'passed');
    if (project === 'parallel')
      writeFileSync(
        join(env.AT_DASHBOARD_SPOOL_DIR, 'phases', project + '.finished.json'),
        JSON.stringify({ status: 'passed', captureIncomplete: true }),
      );
    return result();
  };
  assert.equal(await runSuite([], dependencies(capture, execute)), 1);
  assert.equal(capture.events.filter((event) => event.type === 'run.finished').length, 0);
  const dir = join(
    directory,
    'reports',
    'dashboard',
    readdirSync(join(directory, 'reports', 'dashboard'))[0],
  );
  assert(
    new Spool(dir)
      .events(true)
      .some((event) => event.type === 'run.log' && event.level === 'error'),
  );
});
test('case selection registers all discovered entries before workers with a stable portal link', async (t) => {
  environment(t);
  const capture = await endpoint(t);
  process.env.AT_RUN_NAME = 'Named local run';
  const output: string[] = [];
  t.mock.method(console, 'log', (...args: unknown[]) => output.push(args.join(' ')));
  const execute: Execute = async (project, args, env, list) => {
    assert(!args.some((arg) => arg.startsWith('--case-id')));
    assert.equal(process.env.AT_CASE_IDS, 'fixture.one');
    if (list) {
      writeFileSync(
        join(env.AT_DASHBOARD_DISCOVERY_DIR, project + '.json'),
        JSON.stringify({
          tests: 1,
          stepsTotal: 1,
          entries: [
            {
              clientTestId: project + '-case',
              title: project,
              file: 'one.md',
              kind: 'test',
              plan: [],
              ord: 0,
            },
          ],
        }),
      );
      return result(0, 'tests.spec.ts:1:1 fixture');
    }
    assert.equal(capture.events.filter((event) => event.type === 'test.registered').length, 2);
    phase(env, project, 'passed');
    return result();
  };
  assert.equal(await runSuite(['--case-id', 'fixture.one'], dependencies(capture, execute)), 0);
  assert(
    output.some((line) =>
      line.includes('Dashboard run #42: Named local run\nhttps://dashboard.example.test/runs/'),
    ),
  );
  const announcements = output.filter((line) => line.startsWith('@intent-run '));
  assert.deepEqual(announcements, [
    '@intent-run {"runId":"11111111-1111-1111-1111-111111111111","runNumber":42,"url":"https://dashboard.example.test/runs/11111111-1111-1111-1111-111111111111"}',
  ]);
  assert.ok(
    output.indexOf(announcements[0]) < output.findIndex((line) => line.startsWith('Dashboard run')),
    'the machine-readable line comes before the banner',
  );
});

test('the run line is printed again once the dashboard assigns the run number', async (t) => {
  environment(t);
  const capture = await endpoint(t);
  let responses = 0;
  const output: string[] = [];
  t.mock.method(console, 'log', (...args: unknown[]) => output.push(args.join(' ')));
  const execute: Execute = async (project, _args, env, list) => {
    if (list) {
      discovery(env, project);
      return result(0, 'tests.spec.ts:1:1 fixture');
    }
    phase(env, project, 'passed');
    return result();
  };
  const deps = dependencies(capture, execute);
  const createSession = (dir: string, manifest: Manifest) => {
    const session = deps.createSession(dir, manifest);
    const ingest = session.client.ingest.bind(session.client);
    // An older dashboard (or a slow number assignment) answers the registration without a run number.
    session.client.ingest = async (...args) => {
      const answer = await ingest(...args);
      return ++responses === 1 ? { ...answer, runNumber: undefined } : answer;
    };
    return session;
  };
  assert.equal(await runSuite([], { ...deps, createSession }), 0);
  const runs = output
    .filter((line) => line.startsWith('@intent-run '))
    .map((line) => JSON.parse(line.slice('@intent-run '.length)) as Record<string, unknown>);
  assert.deepEqual(
    runs.map((run) => run.runNumber),
    [null, 42],
  );
  assert.ok(runs.every((run) => run.runId === '11111111-1111-1111-1111-111111111111'));
});
test('an engine below the dashboard minimum is stopped before listing unless outdated engines are allowed', async (t) => {
  environment(t);
  const capture = await endpoint(t);
  let executed = 0;
  const { ENGINE_VERSION } = await import('../src/dashboard/engine-version.ts');
  const [major, minor] = ENGINE_VERSION.split('.').map(Number),
    minimum = `${major}.${minor + 1}.0`;
  const execute: Execute = async (project, _args, env, list) => {
    executed++;
    if (list) {
      discovery(env, project);
      return result(0, 'tests.spec.ts:1:1 fixture');
    }
    phase(env, project, 'passed');
    return result();
  };
  const options = {
    ...dependencies(capture, execute),
    authorize: async () => ({ latest: minimum, minimum }),
  };
  await assert.rejects(runSuite([], options), /below the dashboard's minimum.*--allow-outdated/);
  assert.equal(executed, 0);
  assert.equal(capture.requests, 0);
  assert.equal(await runSuite(['--allow-outdated'], options), 0);
  assert.deepEqual(capture.events.find((event) => event.type === 'run.started')?.engine, {
    version: ENGINE_VERSION,
    allowOutdated: true,
  });
});
