import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { DashboardSession } from '../src/dashboard/session.ts';
import { digest, Spool } from '../src/dashboard/spool.ts';
import type { Event, Manifest } from '../src/dashboard/spool.ts';
import { isSecretVariable, resetSecretCache, sanitize } from '../src/dashboard/sanitize.ts';

function temporary(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'dashboard-redaction-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function secret(t: TestContext, name: string, value: string) {
  const original = process.env[name];
  process.env[name] = value;
  resetSecretCache();
  t.after(() => {
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
    resetSecretCache();
  });
}
async function receiver(t: TestContext): Promise<{ url: string; events: Event[] }> {
  const events: Event[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      let body = '';
      for await (const chunk of request) body += String(chunk);
      events.push(...(JSON.parse(body) as { events: Event[] }).events);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ runId: '11111111-1111-1111-1111-111111111111' }));
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
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, events };
}
function manifest(url: string): Manifest {
  return {
    version: 1,
    url,
    envelope: {
      project: { key: 'fixture', name: 'Fixture' },
      app: { key: 'app', name: 'App' },
      clientRunId: 'run',
    },
    createdAt: new Date().toISOString(),
    reports: {},
    planned: {},
  };
}

test('redaction keeps event identifiers and protocol values stable through acknowledgement', (t) => {
  secret(t, 'DASHBOARD_TEST_PASSWORD', 'deadbeef');
  secret(t, 'DASHBOARD_TEST_TOKEN', 'recorded');
  const spool = new Spool(temporary(t));
  spool.event({
    id: 'step-deadbeef',
    type: 'step.recorded',
    clientTestId: 'source:deadbeef.md:12',
    clientStepId: 'deadbeef',
    status: 'passed',
    kind: 'click',
    text: 'credential deadbeef',
  });
  const event = spool.events()[0];
  assert.equal(event.id, 'step-deadbeef');
  assert.equal(event.type, 'step.recorded');
  assert.equal(event.clientTestId, 'source:deadbeef.md:12');
  assert.equal(event.clientStepId, 'deadbeef');
  assert.equal(event.text, 'credential [REDACTED]');
  spool.acknowledge(event);
  assert.deepEqual(
    new Spool(spool.dir).events(),
    [],
    'ACK must use the same filename identity as capture',
  );
});

test('known hex secrets cannot alter staged artifact paths or ownership keys', (t) => {
  const artifactId = 'artifact-deadbeef';
  secret(t, 'DASHBOARD_TEST_PASSWORD', 'deadbeef');
  secret(t, 'DASHBOARD_TEST_TOKEN', digest(artifactId).slice(0, 8));
  const spool = new Spool(temporary(t)),
    bytes = Buffer.from('immutable screenshot fixture');
  spool.artifact(
    {
      clientArtifactId: artifactId,
      clientTestId: 'source:deadbeef.md:12',
      clientStepId: 'deadbeef',
      kind: 'screenshot',
      filename: 'image-deadbeef.png',
      contentType: 'image/png',
    },
    bytes,
  );
  const job = spool.artifacts()[0];
  assert.equal(job.path, `bytes/${digest(artifactId)}`);
  assert.equal(job.clientArtifactId, artifactId);
  assert.equal(job.clientTestId, 'source:deadbeef.md:12');
  assert.equal(job.filename, 'image-[REDACTED].png');
  assert.deepEqual(readFileSync(join(spool.dir, job.path)), bytes);
  spool.acknowledgeArtifact(job);
  assert.deepEqual(new Spool(spool.dir).artifacts(), []);
});

test('redacted raw requests retain explicit lineage and link to the original test and step', async (t) => {
  secret(t, 'DASHBOARD_TEST_PASSWORD', 'deadbeef');
  const dir = temporary(t),
    report = join(dir, 'report');
  mkdirSync(join(report, 'decisions'), { recursive: true });
  const clientTestId = 'source:deadbeef.md:12',
    clientDecisionId = 'decision-deadbeef';
  const original = {
    clientDecisionId,
    type: 'choice',
    model: 'fixture',
    ctx: { clientTestId, attempt: 1, clientStepId: 'deadbeef', pass: 'parallel' },
    request: { instructions: 'fill deadbeef' },
    answer: { type: 'choice', choice: 'e1', confidence: 0.9 },
  };
  writeFileSync(join(report, 'decisions', 'worker.jsonl'), JSON.stringify(original) + '\n');
  const capture = await receiver(t),
    data = { ...manifest(capture.url), reports: { parallel: report }, finished: true };
  const session = new DashboardSession(join(dir, 'spool'), data);
  session.spool.event({ id: 'start', type: 'run.started' });
  session.spool.event({
    id: 'test',
    type: 'test.started',
    clientTestId,
    title: 'Test',
    file: 'test.md',
  });
  session.spool.event({
    id: 'step',
    type: 'step.recorded',
    clientTestId,
    clientStepId: 'deadbeef',
    kind: 'click',
    status: 'passed',
  });
  assert.equal(await session.pump(), true);
  const decision = capture.events.find((event) => event.type === 'decision.recorded')!;
  assert.equal(decision.clientTestId, clientTestId);
  assert.equal(decision.clientStepId, 'deadbeef');
  assert.equal(decision.clientDecisionId, clientDecisionId);
  const row = decision.record as typeof original & { reportingRedactions: { applied: boolean } };
  assert.deepEqual(row.ctx, original.ctx);
  assert.equal(row.clientDecisionId, clientDecisionId);
  assert.equal(row.request.instructions, 'fill [REDACTED]');
  assert.equal(row.reportingRedactions.applied, true);
  assert.equal(
    session.spool.events().length,
    0,
    'Redaction must not strand acknowledged raw events',
  );
});

test('complete phase latency is weighted by model call counts without fabricating unknown cost', async (t) => {
  const capture = await receiver(t),
    data = { ...manifest(capture.url), planned: { parallel: 0, exclusive: 0 } };
  const session = new DashboardSession(temporary(t), data);
  session.spool.event({ id: 'start', type: 'run.started' });
  writeFileSync(
    join(session.dir, 'phases', 'parallel.finished.json'),
    JSON.stringify({
      status: 'passed',
      stats: { modelCalls: 2, inputTokens: 20, avgLatencyMs: 100, costUsd: null },
    }),
  );
  writeFileSync(
    join(session.dir, 'phases', 'exclusive.finished.json'),
    JSON.stringify({
      status: 'passed',
      stats: { modelCalls: 3, inputTokens: 30, avgLatencyMs: 200, costUsd: null },
    }),
  );
  assert.equal(await session.finish(undefined, 1000), true);
  const stats = capture.events.find((event) => event.type === 'run.finished')?.stats as Record<
    string,
    unknown
  >;
  assert.equal(stats.modelCalls, 5);
  assert.equal(stats.inputTokens, 50);
  assert.equal(stats.avgLatencyMs, 160);
  assert.equal(stats.costUsd, undefined, 'Unknown billing must remain unknown');
});

test('credential-like environment names are redacted while catalog identifiers and short keys are kept', (t) => {
  secret(t, 'MICROSOFT_FOUNDRY_KEY', 'foundry-0123456789abcdef');
  secret(t, 'FIXTURE_APIKEY', 'apikey-value');
  secret(t, 'FIXTURE_ACCESS_KEY', 'access-value');
  secret(t, 'FIXTURE_PRIVATE_KEY', 'private-value');
  secret(t, 'FIXTURE_CREDENTIALS', 'credential-value');
  secret(t, 'FIXTURE_PASSWORD', 'abc');
  secret(t, 'AT_DASHBOARD_PRODUCT_KEY', 'long-product-identifier');
  secret(t, 'AT_DASHBOARD_APP_KEY', 'long-application-identifier');
  secret(t, 'FIXTURE_SHORT_KEY', 'xyz');
  const text = [
    'foundry-0123456789abcdef',
    'apikey-value',
    'access-value',
    'private-value',
    'credential-value',
    'abc',
    'long-product-identifier',
    'long-application-identifier',
    'xyz',
  ].join(' ');
  assert.equal(
    sanitize(text),
    '[REDACTED] [REDACTED] [REDACTED] [REDACTED] [REDACTED] [REDACTED] long-product-identifier long-application-identifier xyz',
  );
  assert.equal(isSecretVariable('FIXTURE_KEY', '1234567'), false, 'short keys are identifiers');
  assert.equal(isSecretVariable('FIXTURE_KEY', '12345678'), true);
  assert.equal(isSecretVariable('MONKEY', '12345678'), false);
  assert.equal(isSecretVariable('AT_DASHBOARD_TOKEN', 'tok'), true);
});

test('the secret list is memoised until variables are added or removed', (t) => {
  secret(t, 'FIXTURE_MEMO_TOKEN', 'first-secret');
  assert.equal(sanitize('first-secret'), '[REDACTED]');
  // An in-place change keeps the variable count, so the memoised list still applies until it is reset.
  process.env.FIXTURE_MEMO_TOKEN = 'second-secret';
  assert.equal(sanitize('second-secret'), 'second-secret');
  resetSecretCache();
  assert.equal(sanitize('second-secret'), '[REDACTED]');
  // Adding a variable (an env file loading) rebuilds it without a reset.
  process.env.FIXTURE_MEMO_PASSWORD = 'added-secret';
  t.after(() => {
    delete process.env.FIXTURE_MEMO_PASSWORD;
    resetSecretCache();
  });
  assert.equal(sanitize('added-secret'), '[REDACTED]');
});
