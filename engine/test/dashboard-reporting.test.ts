import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { DashboardSession, loadSession } from '../src/dashboard/session.ts';
import type { Event, Manifest } from '../src/dashboard/spool.ts';

function temporary(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'evidence-receipt-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
async function server(
  t: TestContext,
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
): Promise<string> {
  const http = createServer((req, res) => {
    void handler(req, res).catch((error) => {
      res.writeHead(500);
      res.end(String(error));
    });
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });
  return `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
}
function manifest(url: string): Manifest {
  return {
    version: 1,
    reportingProtocol: 1,
    url,
    envelope: { project: { key: 'p', name: 'P' }, app: { key: 'a', name: 'A' }, clientRunId: 'r' },
    createdAt: new Date().toISOString(),
    reports: {},
    planned: {},
  };
}
const runId = '11111111-1111-1111-1111-111111111111';

test('execution finishes before final artifact upload; restart completes reporting only after durable artifact ACK', async (t) => {
  const received: Event[] = [],
    calls: string[] = [];
  let uploads = 0;
  const url = await server(t, async (req, res) => {
    let body = '';
    for await (const part of req) body += String(part);
    if (req.url?.startsWith('/api/ingest/artifacts')) {
      calls.push('artifact');
      assert.equal(received.find((event) => event.type === 'run.finished')?.status, 'failed');
      assert.ok(
        !received.some((event) => event.type === 'run.reporting' && event.status === 'complete'),
      );
      if (++uploads === 1) {
        res.writeHead(503);
        res.end('retry');
        return;
      }
    } else {
      const events = (JSON.parse(body) as { events: Event[] }).events;
      received.push(...events);
      calls.push(...events.map((event) => event.type));
      if (events.some((event) => event.type === 'run.reporting' && event.status === 'complete'))
        assert.equal(uploads, 2);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ runId }));
  });
  const dir = temporary(t),
    session = new DashboardSession(dir, manifest(url));
  session.spool.event({ id: 'start', type: 'run.started' });
  session.spool.event({ id: 'uploading', type: 'run.reporting', seq: 1, status: 'uploading' });
  session.spool.artifact(
    {
      clientArtifactId: 'image',
      kind: 'screenshot',
      filename: 'image.jpg',
      contentType: 'image/jpeg',
    },
    Buffer.from('immutable image'),
  );
  assert.equal(await session.finish('failed', 100), false);
  const terminal = session.spool.events(true).find((event) => event.type === 'run.finished')!;
  const restarted = loadSession(dir);
  assert.equal(await restarted.pump(), true);
  assert.equal(
    received.filter((event) => event.type === 'run.finished').length,
    1,
    'Execution outcome is not rewritten by replay',
  );
  assert.deepEqual(
    restarted.spool.events(true).find((event) => event.type === 'run.finished'),
    terminal,
  );
  assert.equal(calls.at(-1), 'run.reporting');
  assert.deepEqual(
    received.filter((event) => event.type === 'run.reporting').map((event) => event.status),
    ['uploading', 'complete'],
  );
  assert.equal(received.at(-1)?.expectedArtifacts, 1);
  assert.equal(received.at(-1)?.expectedDecisions, 0);
  assert.equal(restarted.spool.events().length, 0);
  assert.equal(restarted.spool.artifacts().length, 0);
});

test('missing original model records are partial evidence without changing a successful execution terminal', async (t) => {
  const received: Event[] = [];
  const url = await server(t, async (req, res) => {
    let body = '';
    for await (const part of req) body += String(part);
    received.push(...(JSON.parse(body) as { events: Event[] }).events);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ runId }));
  });
  const session = new DashboardSession(temporary(t), manifest(url));
  session.spool.event({ id: 'start', type: 'run.started' });
  session.spool.event({
    id: 'test',
    type: 'test.started',
    clientTestId: 'case:one',
    title: 'One',
    file: 'one.md',
  });
  session.spool.event({
    id: 'step',
    type: 'step.recorded',
    clientTestId: 'case:one',
    clientStepId: '1',
    status: 'passed',
    calls: [{ latencyMs: 10 }],
  });
  session.spool.event({
    id: 'test-finish',
    type: 'test.finished',
    clientTestId: 'case:one',
    status: 'passed',
  });
  assert.equal(await session.finish(undefined, 200), true);
  assert.equal(
    received.find((event) => event.type === 'run.finished')?.status,
    undefined,
    'Backend still derives the execution outcome',
  );
  const reporting = received.at(-1)!;
  assert.equal(reporting.status, 'partial');
  assert.equal(reporting.expectedDecisions, 1);
  assert.match(String(reporting.reason), /original request/);
  assert.equal(JSON.parse(readFileSync(join(session.dir, 'manifest.json'), 'utf8')).finished, true);
});

test('lost completion receipt acknowledgement replays the identical receipt without replacing execution', async (t) => {
  const receipts: string[] = [];
  let terminals = 0;
  const url = await server(t, async (req, res) => {
    let body = '';
    for await (const part of req) body += String(part);
    const events = (JSON.parse(body) as { events: Event[] }).events;
    terminals += events.filter((event) => event.type === 'run.finished').length;
    const receipt = events.find(
      (event) => event.type === 'run.reporting' && event.status === 'complete',
    );
    if (receipt) {
      receipts.push(JSON.stringify(receipt));
      if (receipts.length === 1) {
        req.socket.destroy();
        return;
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ runId }));
  });
  const dir = temporary(t),
    session = new DashboardSession(dir, manifest(url));
  session.spool.event({ id: 'start', type: 'run.started' });
  assert.equal(await session.finish('failed', 300), false);
  assert.equal(await loadSession(dir).pump(), true);
  assert.equal(terminals, 1);
  assert.equal(receipts.length, 2);
  assert.equal(receipts[0], receipts[1]);
});

test('rejected catalog remains replayable without blocking execution states or artifact uploads', async (t) => {
  const events: Event[] = [];
  let artifacts = 0,
    catalogCalls = 0;
  const url = await server(t, async (req, res) => {
    let body = '';
    for await (const part of req) body += String(part);
    if (req.url === '/api/ingest/suite') {
      catalogCalls++;
      res.writeHead(409);
      res.end('snapshot conflict');
      return;
    }
    if (req.url?.startsWith('/api/ingest/artifacts')) artifacts++;
    else events.push(...(JSON.parse(body) as { events: Event[] }).events);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ runId }));
  });
  const dir = temporary(t),
    session = new DashboardSession(dir, manifest(url));
  const { atomicJson } = await import('../src/dashboard/spool.ts');
  atomicJson(join(dir, 'suite.json'), {
    project: session.manifest.envelope.project,
    app: session.manifest.envelope.app,
    suite: { suiteHash: 'a'.repeat(64), cases: [], sources: [] },
  });
  session.spool.event({ id: 'start', type: 'run.started' });
  session.spool.artifact(
    {
      clientArtifactId: 'image',
      kind: 'screenshot',
      filename: 'image.jpg',
      contentType: 'image/jpeg',
    },
    Buffer.from('fixture'),
  );
  assert.equal(await session.pump(), false);
  assert.equal(await session.finish('failed', 400), false);
  assert.equal(artifacts, 1);
  assert.ok(catalogCalls >= 2);
  assert.equal(events.filter((event) => event.type === 'run.finished').length, 1);
  assert.equal(events.at(-1)?.type, 'run.reporting');
  assert.equal(events.at(-1)?.status, 'partial');
  assert.match(String(events.at(-1)?.reason), /Suite publication/);
  assert.equal(readFileSync(join(dir, 'suite.json'), 'utf8').includes('a'.repeat(64)), true);
  assert.equal(
    await loadSession(dir).pump(),
    false,
    'Replay still reports the independently rejected catalog job pending',
  );
  assert.equal(events.filter((event) => event.type === 'run.finished').length, 1);
});

test('catalog recovery advances partial receipt to complete with immutable IDs and no repeated unchanged receipts', async (t) => {
  const received: Event[] = [],
    ledger = new Map<string, string>();
  let acceptCatalog = false,
    artifacts = 0;
  const url = await server(t, async (req, res) => {
    let body = '';
    for await (const part of req) body += String(part);
    if (req.url === '/api/ingest/suite') {
      if (!acceptCatalog) {
        res.writeHead(409);
        res.end('repairable catalog rejection');
        return;
      }
    } else if (req.url?.startsWith('/api/ingest/artifacts')) artifacts++;
    else {
      const events = (JSON.parse(body) as { events: Event[] }).events;
      for (const event of events) {
        const serialized = JSON.stringify(event);
        if (ledger.has(event.id))
          assert.equal(
            ledger.get(event.id),
            serialized,
            'No event ID can acquire a different payload',
          );
        else {
          ledger.set(event.id, serialized);
          received.push(event);
        }
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ runId }));
  });
  const dir = temporary(t),
    initial = new DashboardSession(dir, manifest(url));
  const { atomicJson } = await import('../src/dashboard/spool.ts');
  atomicJson(join(dir, 'suite.json'), {
    project: initial.manifest.envelope.project,
    app: initial.manifest.envelope.app,
    suite: { suiteHash: 'b'.repeat(64), cases: [], sources: [] },
  });
  initial.spool.event({ id: 'start', type: 'run.started' });
  initial.spool.event({ id: 'uploading', type: 'run.reporting', seq: 1, status: 'uploading' });
  initial.spool.artifact(
    {
      clientArtifactId: 'image',
      kind: 'screenshot',
      filename: 'image.jpg',
      contentType: 'image/jpeg',
    },
    Buffer.from('immutable fixture'),
  );
  assert.equal(await initial.pump(), false);
  assert.equal(await initial.finish('failed', 500), false);
  const terminal = initial.spool.events(true).find((event) => event.type === 'run.finished')!;
  const partial = received.find(
    (event) => event.type === 'run.reporting' && event.status === 'partial',
  )!;
  assert.equal(partial.seq, 2);
  assert.match(String(partial.reason), /Suite publication/);
  assert.equal(await loadSession(dir).pump(), false);
  assert.equal(
    received.filter((event) => event.type === 'run.reporting').length,
    2,
    'Unchanged rejection does not add a receipt',
  );
  acceptCatalog = true;
  const replay = loadSession(dir);
  assert.equal(await replay.pump(), true);
  const complete = received.at(-1)!;
  assert.equal(complete.type, 'run.reporting');
  assert.equal(complete.status, 'complete');
  assert.equal(complete.seq, 3);
  assert.notEqual(complete.id, partial.id);
  assert.equal(complete.reason, undefined, 'Recovered transport reason clears');
  assert.deepEqual(
    replay.spool.events(true).find((event) => event.type === 'run.finished'),
    terminal,
  );
  assert.equal(received.filter((event) => event.type === 'run.finished').length, 1);
  assert.equal(artifacts, 1);
  assert.equal(replay.spool.events().length, 0);
  assert.equal(replay.spool.artifacts().length, 0);
  const size = ledger.size;
  assert.equal(await replay.pump(), true);
  assert.equal(ledger.size, size, 'An unchanged complete receipt is not restaged');
});
