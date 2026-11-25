// postJson's retries, against a local server that misbehaves on purpose.
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { postJson } from '../src/decider/http.ts';

let server: Server;
let url = '';
/** What the server does on each request, in order; the last one repeats. */
let script: ('ok' | 'cut-body' | 'malformed' | '503')[] = [];
let requests = 0;

before(async () => {
  server = createServer((req, res) => {
    const action = script[Math.min(requests++, script.length - 1)];
    req.resume();
    req.on('end', () => {
      if (action === '503') return void res.writeHead(503).end('busy');
      if (action === 'malformed')
        return void res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"answers":');
      if (action === 'cut-body') {
        // 200 and part of the body, then the connection drops: fetch's r.text() rejects with "TypeError: terminated".
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '100' });
        res.write('{"answers":');
        return void setTimeout(() => res.socket?.destroy(), 20);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"answers":{"ok":true}}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/systemone`;
});
after(() => server.close());

const post = () =>
  postJson(
    {
      name: 'test',
      url,
      headers: { 'Content-Type': 'application/json' },
      body: { q: 1 },
      retryBaseMs: 5,
    },
    (json) => json.answers,
  );

describe('postJson', () => {
  test('a body cut off after a 200 is retried', async () => {
    script = ['cut-body', 'ok'];
    requests = 0;
    const { res } = await post();
    assert.deepEqual(res, { ok: true });
    assert.equal(requests, 2);
  });

  test('5xx is retried', async () => {
    script = ['503', 'ok'];
    requests = 0;
    assert.deepEqual((await post()).res, { ok: true });
    assert.equal(requests, 2);
  });

  test('a complete but malformed 200 is not retried, and the error names the decider and host', async () => {
    script = ['malformed', 'ok'];
    requests = 0;
    await assert.rejects(post(), /^Error: test: unexpected response from 127\.0\.0\.1:\d+: /);
    assert.equal(requests, 1);
  });

  test('a connection that keeps dropping fails after the retries, naming the decider and host', async () => {
    script = ['cut-body'];
    requests = 0;
    await assert.rejects(
      post(),
      /^Error: test: request to 127\.0\.0\.1:\d+ failed: TypeError: terminated/,
    );
    assert.equal(requests, 4);
  });
});
