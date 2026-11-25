import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  authorizeRunner,
  DashboardAuth,
  dashboardBaseUrl,
  requiredReportingToken,
} from '../src/dashboard/auth.ts';
import { DashboardClient } from '../src/dashboard/client.ts';
const personal = 'pit_pat_' + 'a'.repeat(32) + '_' + 'b'.repeat(43);
const DASHBOARD = 'https://dashboard.example.test';
const automation = 'pit_auto_' + 'c'.repeat(32) + '_' + 'd'.repeat(43);

test('reporting credentials stay in headers without entering request bodies', async (t) => {
  const previous = process.env.AT_DASHBOARD_TOKEN;
  t.after(() => {
    if (previous === undefined) delete process.env.AT_DASHBOARD_TOKEN;
    else process.env.AT_DASHBOARD_TOKEN = previous;
  });
  process.env.AT_DASHBOARD_TOKEN = personal;
  const requests: RequestInit[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: string | URL | Request, options: RequestInit) => {
    requests.push(options);
    return Response.json({ accepted: 1 });
  });
  const client = new DashboardClient(DASHBOARD);
  await client.request('/api/ingest/events', '{"events":[]}');
  await client.request('/api/ingest/artifacts', new FormData());
  for (const request of requests)
    assert.equal(new Headers(request.headers).get('Authorization'), 'Bearer ' + personal);
  assert.equal(new Headers(requests[1].headers).has('Content-Type'), false);
  assert.equal(requests[0].redirect, 'error');
  assert.equal(JSON.stringify(requests.map(({ body }) => body)).includes(personal), false);
  await assert.rejects(
    new DashboardClient('http://remote.example.test').request('/api/ingest/events', '{}'),
    /HTTPS/,
  );
});
test('local runs require personal tokens and CI runs require automation tokens', () => {
  assert.equal(requiredReportingToken({ AT_DASHBOARD_TOKEN: personal }).kind, 'personal');
  assert.equal(
    requiredReportingToken({ AT_DASHBOARD_TOKEN: automation, CI: 'true' }).kind,
    'automation',
  );
  for (const value of ['', 'session-cookie', automation])
    assert.throws(
      () => requiredReportingToken({ AT_DASHBOARD_TOKEN: value }),
      /personal access token/,
    );
  assert.throws(
    () => requiredReportingToken({ AT_DASHBOARD_TOKEN: personal, CI: 'true' }),
    /automation token/,
  );
});
test('preflight validates the token with the configured dashboard before allowing test execution', async () => {
  const environment = { AT_DASHBOARD_TOKEN: personal };
  await authorizeRunner(DASHBOARD, environment, (async (url: string, options: RequestInit) => {
    assert.equal(url, DASHBOARD + '/api/runner/access');
    assert.equal(new Headers(options.headers).get('Authorization'), 'Bearer ' + personal);
    return Response.json({
      credentialKind: 'personal',
      permissions: ['reports.read', 'reports.write'],
    });
  }) as typeof fetch);
  await assert.rejects(
    authorizeRunner(
      DASHBOARD,
      environment,
      (async () => new Response('', { status: 401 })) as typeof fetch,
    ),
    /rejected/,
  );
  await assert.rejects(
    authorizeRunner(DASHBOARD, environment, (async () =>
      Response.json({
        credentialKind: 'personal',
        permissions: ['reports.read'],
      })) as typeof fetch),
    /required test reporting access/,
  );
  assert.equal(
    await new DashboardAuth().token({ AT_DASHBOARD_CLIENT_SECRET: 'legacy-azure-secret' }),
    undefined,
  );
});
test('runner access returns the dashboard engine policy and older dashboards return none', async () => {
  const environment = { AT_DASHBOARD_TOKEN: personal };
  const access = { credentialKind: 'personal', permissions: ['reports.write'] };
  assert.deepEqual(
    await authorizeRunner(DASHBOARD, environment, (async () =>
      Response.json({ ...access, engine: { latest: '0.11.0', minimum: null } })) as typeof fetch),
    { latest: '0.11.0', minimum: null },
  );
  assert.equal(
    await authorizeRunner(DASHBOARD, environment, (async () =>
      Response.json(access)) as typeof fetch),
    undefined,
  );
});
test('preflight refuses a product the dashboard does not know, before any test starts', async () => {
  const environment = { AT_DASHBOARD_TOKEN: personal };
  const dashboard = (async (url: string) =>
    url.endsWith('/api/runner/access')
      ? Response.json({
          credentialKind: 'personal',
          permissions: ['reports.read', 'reports.write'],
        })
      : Response.json([{ key: 'clinic' }, { key: 'lab' }])) as typeof fetch;
  await authorizeRunner(DASHBOARD, environment, dashboard, 'lab');
  await assert.rejects(
    authorizeRunner(DASHBOARD, environment, dashboard, 'pharmacy'),
    /Product "pharmacy" is not registered.*\/products\).*intent-workspace\.json.*not started/,
  );
});

test('a dashboard URL is http(s), without a trailing slash, query or credentials', () => {
  assert.equal(dashboardBaseUrl('https://dashboard.example.test/', 'AT_DASHBOARD_URL'), DASHBOARD);
  assert.equal(
    dashboardBaseUrl(' https://example.test/intent/ ', 'AT_DASHBOARD_URL'),
    'https://example.test/intent',
  );
  assert.throws(() => dashboardBaseUrl('dashboard.example.test', 'X'), /X: .* is not a URL/);
  assert.throws(() => dashboardBaseUrl('ftp://example.test', 'X'), /https:\/\/ or http:\/\//);
  assert.throws(() => dashboardBaseUrl('https://u:p@example.test', 'X'), /credentials/);
  assert.throws(() => dashboardBaseUrl('https://example.test/?a=1', 'X'), /query/);
});
test('the token message links to the dashboard it will report to', () => {
  assert.throws(
    () => requiredReportingToken({}, DASHBOARD),
    (error: Error) => error.message.includes(DASHBOARD + '/settings?tab=users'),
  );
});
