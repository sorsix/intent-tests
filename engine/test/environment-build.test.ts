import assert from 'node:assert/strict';
import { createServer, type RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import { environmentBuild, environmentBuildMessage } from '../src/dashboard/environment-build.ts';

const id = '11111111-1111-4111-8111-111111111111';
const info = {
  kind: 'intent-launch-environment',
  schemaVersion: 1,
  buildId: id,
  label: 'Version',
  source: { branch: 'main', commit: 'abc' },
};
async function server(t: TestContext, listener: RequestListener): Promise<string> {
  const server = createServer(listener);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test('discovers the running app from its origin, independently of local workspace files', async (t) => {
  let requests = 0;
  const origin = await server(t, (request, response) => {
    requests++;
    assert.equal(request.url, '/.well-known/intent-launch/environment');
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.headers.cookie, undefined);
    assert.equal(request.headers.accept, 'application/json');
    response
      .writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      .end(JSON.stringify(info));
  });
  const build = await environmentBuild({
    BASE_URL: origin + '/app/?token=private#fragment',
    AT_DASHBOARD_TOKEN: 'must-not-be-forwarded',
    AT_LAUNCHER_WORKSPACE: '/missing',
  });
  assert.deepEqual(build, { id, endpoint: origin + '/.well-known/intent-launch/environment' });
  assert.equal(requests, 1);
  assert.match(environmentBuildMessage(build!)!, /Linked to Launcher build .* \(from http:/);
  assert(!JSON.stringify(build).includes('private'));
});

test('explicit build IDs win unchanged without any network request', async () => {
  const build = await environmentBuild(
    { AT_ENVIRONMENT_BUILD_ID: 'explicit-build', BASE_URL: 'http://app.test' },
    {
      fetcher: async () => {
        throw Error('must not fetch');
      },
    },
  );
  assert.deepEqual(build, { id: 'explicit-build' });
  assert.equal(environmentBuildMessage(build!), undefined);
});

test('missing, invalid, non-HTTP and credential-bearing URLs are not queried', async () => {
  for (const url of [
    undefined,
    '',
    'bad-url',
    'file:///tmp/environment',
    'ftp://host',
    'https://user:password@app.test',
  ]) {
    let called = false;
    assert.equal(
      await environmentBuild(
        { BASE_URL: url },
        {
          fetcher: async () => {
            called = true;
            throw Error('unexpected');
          },
        },
      ),
      undefined,
    );
    assert.equal(called, false);
  }
});

test('older apps, SPA pages and malformed or foreign metadata leave runs unlinked', async (t) => {
  const responses: [number, string, string][] = [
    [404, 'application/json', '{}'],
    [503, 'application/json', JSON.stringify(info)],
    [200, 'text/html', '<html>SPA</html>'],
    [200, 'application/json', '{'],
    [200, 'application/json', 'null'],
    [200, 'application/json', '{}'],
    ...[
      { ...info, kind: 'other' },
      { ...info, schemaVersion: 2 },
      { ...info, buildId: 'invalid' },
    ].map((value) => [200, 'application/json', JSON.stringify(value)] as [number, string, string]),
  ];
  let current = responses[0];
  const origin = await server(t, (_request, response) =>
    response.writeHead(current[0], { 'Content-Type': current[1] }).end(current[2]),
  );
  for (current of responses) assert.equal(await environmentBuild({ BASE_URL: origin }), undefined);
});

test('redirects are never followed, even to another path on the same origin', async (t) => {
  let requests = 0;
  const origin = await server(t, (_request, response) => {
    requests++;
    response.writeHead(302, { Location: '/login' }).end();
  });
  assert.equal(await environmentBuild({ BASE_URL: origin }), undefined);
  assert.equal(requests, 1);
});

test('timeouts cover both response headers and streaming bodies; oversized bodies are rejected', async (t) => {
  let mode = 'headers';
  const origin = await server(t, (_request, response) => {
    if (mode === 'headers') return;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.flushHeaders();
    if (mode === 'body') response.write('{');
    else response.end(' '.repeat(17 * 1024) + JSON.stringify(info));
  });
  for (mode of ['headers', 'body', 'large']) {
    const start = Date.now();
    assert.equal(await environmentBuild({ BASE_URL: origin }, { timeoutMs: 75 }), undefined);
    assert(Date.now() - start < 1500);
  }
  assert.equal(
    await environmentBuild(
      { BASE_URL: 'https://app.test' },
      {
        fetcher: async () => {
          throw Error('TLS verification failed');
        },
      },
    ),
    undefined,
  );
});
