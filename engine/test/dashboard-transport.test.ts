import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { DashboardClient, DashboardHttpError, batches } from '../src/dashboard/client.ts';
import { DashboardSession, loadSession } from '../src/dashboard/session.ts';
import { Spool } from '../src/dashboard/spool.ts';
import type { Envelope, Event, Manifest } from '../src/dashboard/spool.ts';

const envelope: Envelope = {
  project: { key: 'clinic', name: 'Clinic' },
  app: { key: 'fixture', name: 'Fixture' },
  clientRunId: 'durable-test-run',
};
function temporary(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'intent-dashboard-transport-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  let text = '';
  for await (const chunk of request) text += String(chunk);
  return JSON.parse(text) as Record<string, unknown>;
}
async function http(
  t: TestContext,
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
): Promise<string> {
  const server = createServer((request, response) => {
    void Promise.resolve(handler(request, response)).catch(() => {
      response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test('durable spool survives restart without changing retry payloads or dependency order', (t) => {
  const directory = temporary(t);
  const spool = new Spool(directory);
  spool.event({ id: 'finish', type: 'run.finished', status: 'failed' });
  spool.event({
    id: 'test-finish',
    type: 'test.finished',
    clientTestId: 'booking',
    status: 'failed',
  });
  spool.event({
    id: 'step',
    type: 'step.recorded',
    clientTestId: 'booking',
    clientStepId: 'save',
    text: 'click Save',
    status: 'failed',
  });
  spool.event({
    id: 'test',
    type: 'test.started',
    clientTestId: 'booking',
    title: 'Booking',
    file: 'booking.md',
  });
  spool.event({ id: 'start', type: 'run.started', displayName: 'Original' });
  const before = spool.events();
  assert.deepEqual(
    before.map((event) => event.type),
    ['run.started', 'test.started', 'step.recorded', 'test.finished', 'run.finished'],
  );
  assert.ok(before.every((event) => typeof event.ts === 'string'));
  const restarted = new Spool(directory);
  restarted.event({ id: 'start', type: 'run.started', displayName: 'Changed after restart' });
  assert.deepEqual(
    restarted.events(),
    before,
    'Retries must preserve the first persisted event including timestamp',
  );
  restarted.acknowledge(before[0]);
  assert.equal(new Spool(directory).events().length, 4);
  assert.deepEqual(restarted.events(true), before);
});

test('dropped HTTP acknowledgement leaves identical durable events replayable', async (t) => {
  const spool = new Spool(temporary(t));
  spool.event({ id: 'start', type: 'run.started' });
  const pending = spool.events();
  let attempts = 0;
  const payloads: string[] = [];
  const url = await http(t, async (request, response) => {
    const payload = await body(request);
    payloads.push(JSON.stringify(payload));
    attempts++;
    // Simulate a committed server transaction followed by a lost acknowledgement.
    if (attempts === 1) {
      request.socket.destroy();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify({ runId: '11111111-1111-1111-1111-111111111111', accepted: 0, duplicates: 1 }),
    );
  });
  const client = new DashboardClient(url, 500);
  await assert.rejects(() => client.ingest(envelope, pending));
  assert.deepEqual(
    spool.events(),
    pending,
    'An unsuccessful acknowledgement must never delete the spool',
  );
  const recovered = await client.ingest(envelope, new Spool(spool.dir).events());
  assert.equal(recovered.duplicates, 1);
  assert.equal(payloads[0], payloads[1]);
  for (const event of pending) spool.acknowledge(event);
  assert.deepEqual(new Spool(spool.dir).events(), []);
});

test('transport splits event batches by count and byte size while retaining event identities', () => {
  const events: Event[] = Array.from({ length: 501 }, (_, index) => ({
    id: String(index),
    type: 'run.log',
    message: 'diagnostic',
  }));
  const grouped = batches(envelope, events);
  assert.deepEqual(
    grouped.map((batch) => batch.length),
    [200, 200, 101],
  );
  assert.deepEqual(grouped.flat(), events);
  const large = [
    { id: 'large-a', type: 'run.log', message: 'a'.repeat(4 * 1024 * 1024) },
    { id: 'large-b', type: 'run.log', message: 'b'.repeat(4 * 1024 * 1024) },
  ];
  const sized = batches(envelope, large);
  assert.deepEqual(
    sized.map((batch) => batch.length),
    [1, 1],
  );
  for (const batch of sized)
    assert.ok(Buffer.byteLength(JSON.stringify({ ...envelope, events: batch })) < 8 * 1024 * 1024);
  assert.throws(
    () =>
      batches(envelope, [
        { id: 'oversized', type: 'run.log', message: 'x'.repeat(7 * 1024 * 1024) },
      ]),
    /exceeds/,
  );
});

test('artifact retries retain first captured bytes despite later evidence changes', (t) => {
  const directory = temporary(t);
  const spool = new Spool(directory);
  const original = Buffer.from('original evidence');
  spool.artifact(
    {
      clientArtifactId: 'trace',
      kind: 'trace',
      filename: '../../trace.zip',
      contentType: 'application/zip',
    },
    original,
  );
  spool.artifact(
    {
      clientArtifactId: 'trace',
      kind: 'trace',
      filename: 'trace.zip',
      contentType: 'application/zip',
    },
    Buffer.from('changed evidence'),
  );
  const jobs = new Spool(directory).artifacts();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].filename, 'trace.zip');
  assert.deepEqual(readFileSync(join(directory, jobs[0].path)), original);
  spool.acknowledgeArtifact(jobs[0]);
  assert.deepEqual(new Spool(directory).artifacts(), []);
});

test('session retries a committed batch after restart and acknowledges durable duplicates', async (t) => {
  const directory = temporary(t);
  const payloads: string[] = [];
  let attempts = 0;
  const ledger = new Map<string, string>();
  const url = await http(t, async (request, response) => {
    const payload = await body(request);
    payloads.push(JSON.stringify(payload));
    attempts++;
    let accepted = 0;
    let duplicates = 0;
    for (const event of payload.events as Event[]) {
      const serialized = JSON.stringify(event);
      if (ledger.has(event.id)) {
        assert.equal(ledger.get(event.id), serialized);
        duplicates++;
      } else {
        ledger.set(event.id, serialized);
        accepted++;
      }
    }
    if (attempts === 1) {
      request.socket.destroy();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify({ runId: '11111111-1111-1111-1111-111111111111', accepted, duplicates }),
    );
  });
  const manifest: Manifest = {
    version: 1,
    url,
    envelope,
    createdAt: new Date().toISOString(),
    reports: {},
    planned: {},
    finished: true,
  };
  const initial = new DashboardSession(directory, manifest, { timeoutMs: 500 });
  initial.spool.event({ id: 'start', type: 'run.started' });
  initial.spool.event({ id: 'finish', type: 'run.finished', status: 'failed', durationMs: 123 });
  const original = initial.spool.events();
  assert.equal(await initial.pump(), false);
  assert.deepEqual(initial.spool.events(), original);
  const restarted = loadSession(directory);
  assert.equal(await restarted.pump(), true);
  assert.deepEqual(restarted.spool.events(), []);
  assert.equal(restarted.runId, '11111111-1111-1111-1111-111111111111');
  assert.equal(ledger.size, 2);
  assert.equal(attempts, 2);
  assert.equal(payloads[0], payloads[1]);
  assert.equal(
    new Spool(directory).events(true).find((event) => event.type === 'run.finished')?.status,
    'failed',
  );
});

test('dashboard outage preserves failure outcomes and a single resumable terminal event', async (t) => {
  const directory = temporary(t);
  const url = await http(t, (_request, response) => {
    response.writeHead(503);
    response.end('temporarily unavailable');
  });
  const manifest: Manifest = {
    version: 1,
    url,
    envelope,
    createdAt: new Date().toISOString(),
    reports: {},
    planned: { parallel: 1, exclusive: 1 },
  };
  const session = new DashboardSession(directory, manifest, { timeoutMs: 250 });
  session.spool.event({ id: 'start', type: 'run.started' });
  session.spool.event({
    id: 'test',
    type: 'test.started',
    clientTestId: 'failed-case',
    title: 'Failure',
    file: 'failure.md',
  });
  session.spool.event({
    id: 'test-finish',
    type: 'test.finished',
    clientTestId: 'failed-case',
    status: 'failed',
    durationMs: 50,
  });
  assert.equal(await session.finish('failed', 100), false);
  assert.equal(await session.finish('failed', 100), false);
  const pending = new Spool(directory).events();
  assert.equal(pending.filter((event) => event.type === 'run.finished').length, 1);
  assert.equal(pending.find((event) => event.type === 'test.finished')?.status, 'failed');
  assert.equal(pending.find((event) => event.type === 'run.finished')?.status, 'failed');
  assert.equal(JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')).finished, true);
});

test('terminal completion captures every complete decision row in a large offline backlog first', async (t) => {
  const directory = temporary(t);
  const report = join(directory, 'report');
  mkdirSync(join(report, 'decisions'), { recursive: true });
  const records = Array.from({ length: 15 }, (_, index) => ({
    clientDecisionId: `decision-${index}`,
    ts: '2026-10-13T10:00:00Z',
    model: 'fixture-model',
    type: 'choice',
    ctx: { clientTestId: 't', attempt: 1, clientStepId: 's', look: index + 1 },
    request: {
      state: { text: 'x'.repeat(1024 * 1024) },
      instructions: 'click Save',
      options: { e1: 'Save' },
    },
    answer: { choice: 'e1', confidence: 0.9, latencyMs: 10, inputTokens: 1 },
  }));
  writeFileSync(
    join(report, 'decisions', 'worker.jsonl'),
    records.map((record) => JSON.stringify(record)).join('\n') + '\n',
  );
  const received: Event[] = [];
  const url = await http(t, async (request, response) => {
    const payload = await body(request);
    received.push(...(payload.events as Event[]));
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ runId: '11111111-1111-1111-1111-111111111111' }));
  });
  const manifest: Manifest = {
    version: 1,
    url,
    envelope,
    createdAt: new Date().toISOString(),
    reports: { parallel: report },
    planned: { parallel: 1 },
  };
  const session = new DashboardSession(join(directory, 'spool'), manifest, { timeoutMs: 2000 });
  session.spool.event({ id: 'start', type: 'run.started' });
  session.spool.event({
    id: 'test',
    type: 'test.started',
    clientTestId: 't',
    title: 'Test',
    file: 'test.md',
  });
  session.spool.event({
    id: 'step',
    type: 'step.recorded',
    clientTestId: 't',
    clientStepId: 's',
    status: 'passed',
  });
  session.spool.event({
    id: 'test-finish',
    type: 'test.finished',
    clientTestId: 't',
    status: 'passed',
    durationMs: 100,
  });
  writeFileSync(
    join(session.dir, 'phases', 'parallel.finished.json'),
    JSON.stringify({ status: 'passed', tests: 1 }),
  );
  assert.equal(await session.finish(undefined, 100), true);
  const decisions = received.filter((event) => event.type === 'decision.recorded');
  assert.equal(
    decisions.length,
    records.length,
    'Finalization must drain raw capture before the terminal event makes later writes invalid',
  );
  assert.equal(new Set(decisions.map((event) => event.clientDecisionId)).size, records.length);
  assert.ok(decisions.every((event) => event.clientTestId === 't' && event.clientStepId === 's'));
  assert.equal(received.filter((event) => event.type === 'run.finished').length, 1);
  assert.equal(received.at(-1)?.type, 'run.finished');
});

// A stand-in for the dashboard's ordering rule: once a test attempt finishes, its progress and steps are rejected with
// 409 and the whole batch is refused (Repository.ingest runs in one transaction).
async function orderingDashboard(t: TestContext, finished = new Set<string>()) {
  const requests: { status: number; events: Event[] }[] = [];
  const url = await http(t, async (request, response) => {
    const events = (await body(request)).events as Event[];
    const done = new Set(finished);
    let late = false;
    for (const event of events) {
      if (
        (event.type === 'test.progress' || event.type === 'step.recorded') &&
        done.has(String(event.clientTestId))
      )
        late = true;
      if (event.type === 'test.finished') done.add(String(event.clientTestId));
    }
    requests.push({ status: late ? 409 : 200, events });
    if (late) {
      response.writeHead(409, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'Finished test progress cannot change' }));
      return;
    }
    for (const id of done) finished.add(id);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ runId: '11111111-1111-1111-1111-111111111111' }));
  });
  return { url, requests };
}

test('a finish seen by a directory read that missed the progress before it waits for the next pump', async (t) => {
  const directory = temporary(t);
  const { url, requests } = await orderingDashboard(t);
  const manifest: Manifest = {
    version: 1,
    url,
    envelope,
    createdAt: new Date().toISOString(),
    reports: {},
    planned: {},
  };
  const session = new DashboardSession(directory, manifest, { timeoutMs: 2000 });
  session.spool.event({ id: 'start', type: 'run.started' });
  session.spool.event({
    id: 'test',
    type: 'test.started',
    clientTestId: 'inv-06',
    title: 'Enrolment',
    file: 'inv-06.md',
  });
  session.spool.event({
    id: 'progress',
    type: 'test.progress',
    clientTestId: 'inv-06',
    attempt: 1,
    seq: 46,
    stepsDone: 23,
    stepsTotal: 23,
    currentStepState: 'between-steps',
  });
  session.spool.event({
    id: 'finish',
    type: 'test.finished',
    clientTestId: 'inv-06',
    attempt: 1,
    status: 'passed',
    durationMs: 28_000,
  });
  // Seen in a real run: the reporter wrote the progress and then the finish while the uploader read the events folder, and the
  // read returned the finish without the progress. Replay that in the uploader's reads: the first sees neither (it ran
  // just before the writes), the next sees only the finish.
  const file = (id: string) => `${createHash('sha256').update(id).digest('hex')}.json`;
  const racing = [[file('progress'), file('finish')], [file('progress')]];
  const { names, uploadable } = session.spool;
  let uploading = false;
  session.spool.names = () => {
    const hidden = uploading ? (racing.shift() ?? []) : [];
    return names.call(session.spool).filter((name) => !hidden.includes(name));
  };
  session.spool.uploadable = () => {
    uploading = true;
    try {
      return uploadable.call(session.spool);
    } finally {
      uploading = false;
    }
  };

  assert.equal(await session.pump(), true);
  const testEvents = () =>
    requests.flatMap((request) =>
      request.events.filter((event) => event.clientTestId === 'inv-06').map((event) => event.id),
    );
  assert.deepEqual(testEvents(), ['test'], 'A finish no earlier read has seen is held back');
  assert.equal(await session.pump(), true);
  assert.ok(
    requests.every((request) => request.status === 200),
    'The dashboard never sees progress after its finish',
  );
  assert.deepEqual(testEvents(), ['test', 'progress', 'finish']);
  assert.deepEqual(
    session.spool.events().filter((event) => event.clientTestId === 'inv-06'),
    [],
  );
});

test('heartbeats still reach the dashboard while it keeps rejecting another event', async (t) => {
  const directory = temporary(t);
  const { url, requests } = await orderingDashboard(t, new Set(['inv-06']));
  const manifest: Manifest = {
    version: 1,
    url,
    envelope,
    createdAt: new Date().toISOString(),
    reports: {},
    planned: {},
  };
  const session = new DashboardSession(directory, manifest, { timeoutMs: 2000 });
  session.runId = '11111111-1111-1111-1111-111111111111';
  session.spool.event({
    id: 'late-progress',
    type: 'test.progress',
    clientTestId: 'inv-06',
    attempt: 1,
    seq: 46,
    stepsDone: 23,
    stepsTotal: 23,
    currentStepState: 'between-steps',
  });

  assert.equal(await session.pump(), false);
  assert.deepEqual(
    requests.map((request) => [request.status, request.events.map((event) => event.type)]),
    [
      [200, ['run.heartbeat']],
      [409, ['test.progress', 'run.progress']],
    ],
  );
  assert.deepEqual(
    session.spool.events().map((event) => event.type),
    ['test.progress', 'run.progress'],
    'Only the heartbeat is acknowledged',
  );
});

class CountingSpool extends Spool {
  reads = new Map<string, number>();
  protected override read(path: string): string {
    this.reads.set(path, (this.reads.get(path) ?? 0) + 1);
    return super.read(path);
  }
}

test('each spooled event and artifact file is parsed at most once across repeated pumps', async (t) => {
  const directory = temporary(t);
  const uploaded: string[] = [],
    artifacts: string[] = [];
  const url = await http(t, async (request, response) => {
    if (request.url?.startsWith('/api/ingest/artifacts')) {
      for await (const _chunk of request);
      artifacts.push(new URL(request.url, 'http://x').searchParams.get('clientArtifactId')!);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{}');
      return;
    }
    uploaded.push(...((await body(request)).events as Event[]).map((event) => event.id));
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ runId: '11111111-1111-1111-1111-111111111111' }));
  });
  const manifest: Manifest = {
    version: 1,
    url,
    envelope,
    createdAt: new Date().toISOString(),
    reports: {},
    planned: { parallel: 3 },
  };
  const session = new DashboardSession(directory, manifest, { timeoutMs: 2000 });
  const spool = new CountingSpool(directory);
  session.spool = spool;
  // The reporter writes from other processes: its files reach the parent only through the directory listing.
  const reporter = new Spool(directory);
  reporter.event({ id: 'start', type: 'run.started' });
  for (let pump = 0; pump < 6; pump++) {
    reporter.event({
      id: `test-${pump}`,
      type: 'test.started',
      clientTestId: `case-${pump}`,
      title: `Case ${pump}`,
      file: `case-${pump}.md`,
    });
    reporter.event({
      id: `finish-${pump}`,
      type: 'test.finished',
      clientTestId: `case-${pump}`,
      attempt: 1,
      status: 'passed',
      durationMs: 10,
    });
    reporter.artifact(
      {
        clientArtifactId: `shot-${pump}`,
        clientTestId: `case-${pump}`,
        kind: 'screenshot',
        filename: 'shot.png',
        contentType: 'image/png',
      },
      Buffer.from(`png ${pump}`),
    );
    assert.equal(await session.pump(), true);
  }
  assert.equal(await session.pump(), true);
  const repeated = [...spool.reads].filter(([, count]) => count > 1);
  assert.deepEqual(repeated, [], 'no spool file is read twice');
  // Every reporter file was read exactly once; the parent's own events (progress, heartbeat) never.
  assert.equal(spool.reads.size, 1 + 6 * 2 + 6);
  for (let pump = 0; pump < 6; pump++)
    assert.ok(
      uploaded.includes(`finish-${pump}`) &&
        uploaded.includes(`test-${pump}`) &&
        artifacts.includes(`shot-${pump}`),
    );
  assert.deepEqual(spool.events(), []);
  assert.deepEqual(spool.artifacts(), []);
  // A cold spool on the same directory (replay) still sees everything from disk.
  const cold = new Spool(directory);
  assert.equal(cold.events(true).length, spool.events(true).length);
  assert.deepEqual(cold.events(), []);
});

test('an acknowledged event keeps only the fields the parent still reads', (t) => {
  const directory = temporary(t);
  const spool = new Spool(directory);
  const request = 'page text '.repeat(1000);
  spool.event({
    id: 'decision',
    type: 'decision.recorded',
    clientDecisionId: 'd1',
    clientTestId: 'case',
    attempt: 1,
    clientStepId: 's1',
    record: {
      request: { instructions: request },
      answer: { choice: 'e1', inputTokens: 1200 },
      error: { message: 'model timed out', stack: 'at somewhere' },
    },
  });
  spool.event({
    id: 'step',
    type: 'step.recorded',
    clientTestId: 'case',
    clientStepId: 's1',
    status: 'passed',
    text: 'click Save',
    calls: [{ prompt: request }, { prompt: request }],
  });
  const [step, decision] = spool.events();
  assert.deepEqual([step.id, decision.id], ['step', 'decision']);
  assert.equal(
    (decision.record as { request: { instructions: string } }).request.instructions,
    request,
  );
  spool.acknowledge(decision);
  spool.acknowledge(step);
  const slim = (s: Spool) => Object.fromEntries(s.events(true).map((event) => [event.id, event]));
  for (const index of [slim(spool), slim(new Spool(directory))]) {
    assert.deepEqual(index.decision, {
      id: 'decision',
      type: 'decision.recorded',
      ts: decision.ts,
      clientDecisionId: 'd1',
      clientTestId: 'case',
      attempt: 1,
      clientStepId: 's1',
      record: { error: 'model timed out', answer: { inputTokens: 1200 } },
    });
    assert.ok(!JSON.stringify(index.decision).includes('page text'));
    assert.deepEqual(index.step.calls, [null, null]);
    assert.equal(index.step.text, undefined);
    assert.equal(index.step.status, 'passed');
  }
  // The event file itself is unchanged.
  assert.equal(
    JSON.parse(
      readFileSync(
        join(directory, 'events', `${createHash('sha256').update('decision').digest('hex')}.json`),
        'utf8',
      ),
    ).record.request.instructions,
    request,
  );
});

test('only the newest pending progress per test attempt and for the run is uploaded', async (t) => {
  const directory = temporary(t);
  const uploaded: Event[] = [];
  const url = await http(t, async (request, response) => {
    uploaded.push(...((await body(request)).events as Event[]));
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ runId: '11111111-1111-1111-1111-111111111111' }));
  });
  const manifest: Manifest = {
    version: 1,
    url,
    envelope,
    createdAt: new Date().toISOString(),
    reports: {},
    planned: {},
    finished: true,
  };
  const session = new DashboardSession(directory, manifest, { timeoutMs: 2000 });
  const progress = (clientTestId: string, attempt: number, seq: number) =>
    session.spool.event({
      id: `progress:${clientTestId}:${attempt}:${seq}`,
      type: 'test.progress',
      clientTestId,
      attempt,
      seq,
      stepsDone: seq,
      stepsTotal: 10,
    });
  session.spool.event({ id: 'start', type: 'run.started' });
  // Written out of order on purpose: the seq decides, not the file or timestamp order.
  for (const seq of [2, 3, 1]) progress('case-a', 1, seq);
  for (const seq of [1, 2]) progress('case-a', 2, seq);
  progress('case-b', 1, 5);
  for (const seq of [1, 4, 2])
    session.spool.event({
      id: `run-progress:${seq}`,
      type: 'run.progress',
      seq,
      stepsDone: seq,
      stepsTotal: 10,
      running: [],
    });
  for (const seq of [1, 2]) session.spool.event({ id: `heartbeat:${seq}`, type: 'run.heartbeat' });
  for (const seq of [1, 2])
    session.spool.event({
      id: `log:${seq}`,
      type: 'run.log',
      level: 'info',
      message: `log ${seq}`,
    });

  assert.equal(await session.pump(), true);
  assert.deepEqual(uploaded.map((event) => event.id).sort(), [
    'heartbeat:1',
    'heartbeat:2',
    'log:1',
    'log:2',
    'progress:case-a:1:3',
    'progress:case-a:2:2',
    'progress:case-b:1:5',
    'run-progress:4',
    'start',
  ]);
  assert.deepEqual(session.spool.events(), []);
  const ack = (id: string) =>
    JSON.parse(
      readFileSync(
        join(directory, 'ack', `${createHash('sha256').update(id).digest('hex')}.json`),
        'utf8',
      ),
    ) as Record<string, unknown>;
  for (const id of [
    'progress:case-a:1:1',
    'progress:case-a:1:2',
    'progress:case-a:2:1',
    'run-progress:1',
    'run-progress:2',
  ])
    assert.equal(ack(id).superseded, true, id);
  assert.equal(ack('progress:case-a:1:3').superseded, undefined);
});

async function rejectingDashboard(
  t: TestContext,
  reject: (event: Event, index: number) => { status: number; body: Record<string, unknown> } | null,
) {
  const requests: { status: number; events: Event[] }[] = [];
  const url = await http(t, async (request, response) => {
    const events = (await body(request)).events as Event[];
    for (const [index, event] of events.entries()) {
      const rejection = reject(event, index);
      if (!rejection) continue;
      requests.push({ status: rejection.status, events });
      response.writeHead(rejection.status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(rejection.body));
      return;
    }
    requests.push({ status: 200, events });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ runId: '11111111-1111-1111-1111-111111111111', runNumber: 7 }));
  });
  return { url, requests };
}
function finishedSession(t: TestContext, url: string) {
  const directory = temporary(t);
  const manifest: Manifest = {
    version: 1,
    reportingProtocol: 1,
    url,
    envelope,
    createdAt: new Date().toISOString(),
    reports: {},
    planned: {},
    finished: true,
  };
  const session = new DashboardSession(directory, manifest, { timeoutMs: 2000 });
  writeFileSync(
    join(directory, 'reporting.json'),
    JSON.stringify({ status: 'complete', expectedArtifacts: 0, expectedDecisions: 0 }),
  );
  session.spool.event({ id: 'start', type: 'run.started' });
  session.spool.event({
    id: 'test',
    type: 'test.started',
    clientTestId: 'case',
    title: 'Case',
    file: 'case.md',
  });
  session.spool.event({
    id: 'late-step',
    type: 'step.recorded',
    clientTestId: 'case',
    clientStepId: 's1',
    status: 'passed',
  });
  session.spool.event({ id: 'finish', type: 'run.finished', durationMs: 5 });
  return session;
}
const ackOf = (directory: string, id: string) =>
  JSON.parse(
    readFileSync(
      join(directory, 'ack', `${createHash('sha256').update(id).digest('hex')}.json`),
      'utf8',
    ),
  ) as Record<string, unknown>;

test('an HTTP error keeps its message and carries the status and parsed body', async (t) => {
  const url = await http(t, (_request, response) => {
    response.writeHead(409, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: 'Conflict', eventId: 'e1', eventIndex: 0 }));
  });
  const error = await new DashboardClient(url).ingest(envelope, []).then(
    () => assert.fail('expected a rejection'),
    (failure: unknown) => failure as DashboardHttpError,
  );
  assert.ok(error instanceof DashboardHttpError);
  assert.equal(
    error.message,
    'Dashboard HTTP 409: {"error":"Conflict","eventId":"e1","eventIndex":0}',
  );
  assert.equal(error.status, 409);
  assert.deepEqual(error.body, { error: 'Conflict', eventId: 'e1', eventIndex: 0 });
  assert.equal(error.permanent, true);
  const proxy = await http(t, (_request, response) => {
    response.writeHead(429, { 'Content-Type': 'text/html' });
    response.end('<html>slow down</html>');
  });
  const throttled = await new DashboardClient(proxy).ingest(envelope, []).catch((e: unknown) => e);
  assert.ok(throttled instanceof DashboardHttpError);
  assert.equal(throttled.body, undefined);
  assert.equal(throttled.permanent, false);
});

test('an event the dashboard names as permanently rejected is quarantined and the rest uploads', async (t) => {
  const { url, requests } = await rejectingDashboard(t, (event, index) =>
    event.id === 'late-step'
      ? {
          status: 409,
          body: {
            error: 'Cannot record a step after the test finished',
            eventId: event.id,
            eventIndex: index,
          },
        }
      : null,
  );
  const session = finishedSession(t, url);
  const warnings: string[] = [];
  t.mock.method(console, 'warn', (message: string) => warnings.push(message));
  assert.equal(await session.pump(), false, 'the pump that quarantines ends there');
  assert.deepEqual(ackOf(session.dir, 'late-step'), {
    acknowledgedAt: ackOf(session.dir, 'late-step').acknowledgedAt,
    quarantined: true,
    status: 409,
    message: 'Cannot record a step after the test finished',
  });
  assert.deepEqual(warnings, [
    'Dashboard rejected event late-step (409): Cannot record a step after the test finished',
  ]);
  assert.equal(await session.pump(), true);
  assert.deepEqual(session.spool.events(), []);
  const accepted = requests.filter((request) => request.status === 200).flatMap((r) => r.events);
  assert.ok(!accepted.some((event) => event.id === 'late-step'));
  for (const id of ['start', 'test', 'finish'])
    assert.ok(
      accepted.some((event) => event.id === id),
      id,
    );
  const warning = accepted.find(
    (event) =>
      event.id === `parent:quarantine:${createHash('sha256').update('late-step').digest('hex')}`,
  );
  assert.equal(warning?.type, 'run.log');
  assert.equal(warning?.level, 'warn');
  assert.equal(
    warning?.message,
    'Dashboard rejected event late-step (409): Cannot record a step after the test finished',
  );
  const receipt = accepted.filter((event) => event.type === 'run.reporting').at(-1);
  assert.equal(receipt?.status, 'partial');
  assert.match(String(receipt?.reason), /rejected 1 event/);
});

test('rejections without an event id, of run.started or that may pass later are retried, not quarantined', async (t) => {
  const cases: [
    string,
    (event: Event, index: number) => { status: number; body: Record<string, unknown> } | null,
  ][] = [
    [
      'older dashboard',
      (event) => (event.id === 'late-step' ? { status: 409, body: { error: 'Conflict' } } : null),
    ],
    [
      'run.started',
      (event, index) =>
        event.id === 'start'
          ? { status: 400, body: { error: 'Bad run', eventId: 'start', eventIndex: index } }
          : null,
    ],
    [
      'throttled',
      (event, index) =>
        event.id === 'late-step'
          ? { status: 429, body: { error: 'Slow down', eventId: event.id, eventIndex: index } }
          : null,
    ],
    [
      'unknown id',
      (event, index) =>
        event.id === 'late-step'
          ? { status: 409, body: { error: 'Conflict', eventId: 'elsewhere', eventIndex: index } }
          : null,
    ],
  ];
  for (const [name, reject] of cases) {
    const { url } = await rejectingDashboard(t, reject);
    const session = finishedSession(t, url);
    const warnings: string[] = [];
    const warn = t.mock.method(console, 'warn', (message: string) => warnings.push(message));
    assert.equal(await session.pump(), false, name);
    assert.equal(await session.pump(), false, name);
    warn.mock.restore();
    assert.equal(warnings.length, 1, `${name}: one warning across retries`);
    assert.match(
      warnings[0],
      /^Dashboard upload pending; replay the saved spool\. Dashboard HTTP 4\d\d:/,
    );
    assert.ok(
      session.spool.events().some((event) => event.id === 'late-step'),
      name,
    );
    assert.ok(
      !session.spool.events(true).some((event) => event.id.startsWith('parent:quarantine:')),
      name,
    );
  }
});

// The dashboard rejects event ids and run.log messages longer than 1024 characters.
test('event ids stay within the server limit, deterministically and without collisions', async (t) => {
  const { boundedEventId, MAX_EVENT_TEXT } = await import('../src/dashboard/spool.ts');
  const short = 'x'.repeat(MAX_EVENT_TEXT);
  assert.equal(boundedEventId(short), short, 'an id at the limit is untouched');
  const prefix = 'phase:source:very/long/path/'.repeat(80);
  const first = boundedEventId(`${prefix}a:start`),
    second = boundedEventId(`${prefix}b:start`);
  assert.ok(first.length <= MAX_EVENT_TEXT && second.length <= MAX_EVENT_TEXT);
  assert.notEqual(first, second, 'ids that differ only past the cut stay distinct');
  assert.equal(first, boundedEventId(`${prefix}a:start`));
  assert.ok(first.startsWith(prefix.slice(0, 200)), 'the readable prefix is kept');
  const astral = boundedEventId('😀'.repeat(2000));
  assert.ok(astral.length <= MAX_EVENT_TEXT);
  assert.ok(!/[\ud800-\udbff]~/.test(astral), 'a surrogate pair is never split');
});

test('a spooled event with an over-long id uploads once under a bounded id and can be quarantined by it', async (t) => {
  const longId = `test:${'case/'.repeat(500)}:start`;
  const { url, requests } = await rejectingDashboard(t, (event, index) =>
    event.id.startsWith('test:case/')
      ? {
          status: 409,
          body: { error: 'Rejected', eventId: event.id, eventIndex: index },
        }
      : null,
  );
  const session = finishedSession(t, url);
  session.spool.event({
    id: longId,
    type: 'test.started',
    clientTestId: 'long',
    title: 'Long',
    file: 'long.md',
  });
  // Writing the same event again (a retried worker) must not create a second one.
  session.spool.event({
    id: longId,
    type: 'test.started',
    clientTestId: 'long',
    title: 'Long',
    file: 'long.md',
  });
  t.mock.method(console, 'warn', () => undefined);
  assert.equal(await session.pump(), false);
  assert.equal(await session.pump(), true);
  const sent = requests.flatMap((request) => request.events);
  assert.ok(sent.every((event) => event.id.length <= 1024));
  const started = sent.filter((event) => event.id.startsWith('test:case/'));
  assert.equal(started.length, 1, 'written twice, sent once, and not resent after quarantine');
  assert.ok(started[0].id.length <= 1024 && started[0].id.length > 900);
  const warning = sent.find((event) => event.type === 'run.log' && event.level === 'warn');
  assert.match(String(warning?.message), /^Dashboard rejected event test:case\//);
  assert.ok(String(warning?.message).length <= 1024);
});

test('run.log messages over the limit are truncated with a marker; short ones and other fields are untouched', async (t) => {
  const { boundedLogMessage } = await import('../src/dashboard/spool.ts');
  const spool = new Spool(temporary(t));
  const long = `Failure: ${'0123456789'.repeat(400)}`;
  spool.event({ id: 'log-long', type: 'run.log', level: 'error', message: long });
  spool.event({ id: 'log-exact', type: 'run.log', level: 'info', message: 'y'.repeat(1024) });
  spool.event({ id: 'log-short', type: 'run.log', level: 'info', message: 'short' });
  spool.event({ id: 'step-long', type: 'step.recorded', text: long });
  const byId = new Map(spool.events().map((event) => [event.id, event]));
  const truncated = String(byId.get('log-long')?.message);
  assert.ok(truncated.length <= 1024);
  assert.ok(truncated.startsWith('Failure: 0123456789'));
  assert.match(truncated, /… \[truncated \d+ characters\]$/);
  const cut = Number(/truncated (\d+) characters/.exec(truncated)?.[1]);
  assert.equal(truncated.length - ` … [truncated ${cut} characters]`.length + 1 + cut, long.length);
  assert.equal(byId.get('log-exact')?.message, 'y'.repeat(1024));
  assert.equal(byId.get('log-short')?.message, 'short');
  assert.equal(byId.get('step-long')?.text, long, 'only run.log messages are bounded');
  assert.ok(boundedLogMessage('😀'.repeat(2000)).length <= 1024);
});

test('the quarantine warning for a long server message stays within the log limit', async (t) => {
  const { url, requests } = await rejectingDashboard(t, (event, index) =>
    event.id === 'late-step'
      ? {
          status: 409,
          body: { error: 'Server said: ' + 'x'.repeat(5000), eventId: event.id, eventIndex: index },
        }
      : null,
  );
  const session = finishedSession(t, url);
  t.mock.method(console, 'warn', () => undefined);
  await session.pump();
  await session.pump();
  const warning = requests
    .flatMap((request) => request.events)
    .find((event) => event.id.startsWith('parent:quarantine:'));
  assert.ok(String(warning?.message).length <= 1024);
  assert.match(String(warning?.message), /\[truncated \d+ characters\]$/);
});

test('a repeated run.started is byte-identical, also when the replaying process has a different environment', async (t) => {
  const directory = temporary(t);
  const sent: string[] = [];
  let attempts = 0;
  const url = await http(t, async (request, response) => {
    const payload = await body(request);
    for (const event of payload.events as Event[])
      if (event.type === 'run.started') sent.push(JSON.stringify({ ...payload, events: [event] }));
    attempts++;
    if (attempts === 1) {
      request.socket.destroy();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ runId: '11111111-1111-1111-1111-111111111111' }));
  });
  const manifest: Manifest = {
    version: 1,
    url,
    envelope,
    createdAt: '2026-01-01T00:00:00.000Z',
    reports: {},
    planned: {},
    finished: true,
  };
  const saved = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });
  process.env.AT_DASHBOARD_BRANCH = 'first-branch';
  const initial = new DashboardSession(directory, manifest, { timeoutMs: 500 });
  initial.spool.event({
    id: 'parent:started',
    type: 'run.started',
    ts: manifest.createdAt,
    displayName: 'Run',
    environment: 'dev',
    branch: process.env.AT_DASHBOARD_BRANCH,
    commitSha: 'abc123',
    triggeredBy: 'developer',
  });
  assert.equal(await initial.pump(), false);
  process.env.AT_DASHBOARD_BRANCH = 'changed-branch';
  process.env.AT_RUN_NAME = 'Another name';
  assert.equal(await loadSession(directory).pump(), true);
  assert.equal(sent.length, 2);
  assert.equal(sent[0], sent[1]);
  assert.equal(JSON.parse(sent[1]).events[0].branch, 'first-branch');
});
