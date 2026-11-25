import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DashboardClient } from '../src/dashboard/client.ts';
import { loadSession } from '../src/dashboard/session.ts';
import { atomicJson, Spool } from '../src/dashboard/spool.ts';
import type { Event, Manifest } from '../src/dashboard/spool.ts';
import { replay } from '../src/cli/dashboard-replay.ts';
const id = '11111111-1111-1111-1111-111111111111';
test('replay sends a spool to the dashboard it was recorded for, without changing original names events or stable run numbers', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'token-replay-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const manifest: Manifest = {
    version: 1,
    url: 'https://recorded.example.test',
    envelope: {
      project: { key: 'p', name: 'P' },
      app: { key: 'a', name: 'A' },
      clientRunId: 'original-run',
    },
    createdAt: new Date().toISOString(),
    reports: {},
    planned: {},
    finished: true,
  };
  const spool = new Spool(dir);
  atomicJson(join(dir, 'manifest.json'), manifest);
  spool.event({ id: 'start', type: 'run.started', displayName: 'Original name' });
  spool.event({ id: 'finish', type: 'run.finished', status: 'failed' });
  const events = spool.events();
  const captured: Event[][] = [];
  class Client extends DashboardClient {
    override async request(_path: string, body: string | FormData) {
      captured.push((JSON.parse(body as string) as { events: Event[] }).events);
      return { runId: id, runNumber: 42 };
    }
  }
  const options = {
    authorize: async () => {
      return undefined;
    },
    clientFactory: (url: string) => {
      assert.equal(url, 'https://recorded.example.test');
      return new Client(url);
    },
  };
  assert.equal(await replay([dir], options), 0);
  assert.deepEqual(captured[0], events);
  assert.equal(JSON.parse(readFileSync(join(dir, 'transport.json'), 'utf8')).runNumber, 42);
  assert.equal(loadSession(dir).manifest.url, 'https://recorded.example.test');
  assert.equal(await replay([dir], options), 0);
  assert.equal(captured.length, 1);
  assert.deepEqual(new Spool(dir).events(true), events);
});
test('replay requires credentials and takes no destination', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'token-replay-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  atomicJson(join(dir, 'suite-publish.json'), { version: 1, url: 'https://recorded.example.test' });
  await assert.rejects(
    replay([dir], {
      authorize: async () => {
        throw Error('Token is required');
      },
    }),
    /Token is required/,
  );
  await assert.rejects(
    replay([dir, '--dashboard', 'http://localhost:8650']),
    /Usage: intent-test replay/,
  );
});
