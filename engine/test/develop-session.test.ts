// Develop mode end to end (docs/develop-mode.md, section 8): `intent-test develop` as a child process against the fixture
// clinic, spoken to over NDJSON exactly as Intent Launcher does. The stub decider is deterministic and BASE_URL is unset,
// so the session starts the fixture's webServer itself and stops it with the session.
//
// The session edits test files, and other test files parse the fixture at the same time (`node --test` runs files in
// parallel), so the child works on a copy of the fixture app next to it (`engine/test/.develop-session-*`, at the same
// depth so the config's relative engine imports resolve). The original fixture is checked to be byte-identical at the
// end, and the copy is removed even when a step fails.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { Ajv } from 'ajv';
import type {
  DevelopCase,
  DevelopMessage,
  DevelopReply,
  DevelopStepRecord,
  RecordedStep,
} from '../src/develop/protocol.ts';

const engine = fileURLToPath(new URL('..', import.meta.url));
const fixture = join(engine, 'test', 'fixture');
const caseFile = join('self-test', 'engine.md');
const CASE_ID = 'session-row-action-dropdown-checkbox-and-expect';
const STEP_TIMEOUT = 60_000;

/** Every fixture file's bytes before the test, to prove nothing outside the copy changed. */
function snapshotFiles(
  dir: string,
  files = new Map<string, Buffer>(),
  base = dir,
): Map<string, Buffer> {
  for (const entry of readdirEntries(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'reports') snapshotFiles(path, files, base);
    } else files.set(path.slice(base.length), readFileSync(path));
  }
  return files;
}
const readdirEntries = (dir: string) => readdirSync(dir, { withFileTypes: true });

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as { port: number };
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

type Reply = DevelopReply & { result?: Record<string, any> };

// Every message the engine writes is checked against the generated contract, results per request type.
const schema = JSON.parse(
  readFileSync(join(engine, 'docs', 'contract', 'develop-protocol.schema.json'), 'utf8'),
) as { definitions: { DevelopResults: { properties: Record<string, unknown> } } };
const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true });
ajv.addSchema(schema, 'develop');
function contractProblem(definition: string, value: unknown): string | null {
  const validate = ajv.getSchema(`develop#/definitions/${definition}`)!;
  return validate(value) ? null : `${definition}: ${ajv.errorsText(validate.errors)}`;
}

/** The engine child and its stdout, split into replies (by id) and events (in order). */
class Develop {
  readonly child: ChildProcess;
  readonly events: (DevelopMessage & { event: string; [key: string]: any })[] = [];
  readonly stderr: string[] = [];
  /** Messages that do not match the contract (checked at the end). */
  readonly violations: string[] = [];
  private readonly types = new Map<string, string>();
  private readonly replies = new Map<string, (reply: Reply) => void>();
  private readonly waiters = new Set<() => void>();
  private next = 0;
  readonly exited: Promise<number | null>;

  constructor(appDir: string, port: number, reports: string) {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.BASE_URL;
    delete env.AT_APP;
    delete env.AT_REPORT_DIR;
    delete env.AT_DECIDER;
    delete env.VIEWPORT;
    delete env.NODE_TEST_CONTEXT;
    this.child = spawn(
      process.execPath,
      [join(engine, 'src', 'cli', 'develop.ts'), '--app', 'fixture'],
      {
        cwd: engine,
        env: {
          ...env,
          AT_APP_DIR: appDir,
          AT_APP: 'fixture',
          AT_DECIDER: 'stub',
          AT_REPORT_DIR: reports,
          PORT: String(port),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    this.exited = new Promise((done) => this.child.once('exit', (code) => done(code)));
    createInterface({ input: this.child.stderr! }).on('line', (line) => {
      this.stderr.push(line);
      if (this.stderr.length > 400) this.stderr.shift();
    });
    createInterface({ input: this.child.stdout! }).on('line', (line) => {
      const message = JSON.parse(line) as DevelopMessage & Record<string, any>;
      const problem = contractProblem('DevelopMessage', message);
      if (problem) this.violations.push(`${problem}: ${line.slice(0, 300)}`);
      if ('id' in message && message.ok) {
        const type = this.types.get(message.id as string)!;
        const result = (message as { result: unknown }).result;
        const typed = type in schema.definitions.DevelopResults.properties;
        const wrong = typed
          ? contractProblem(`DevelopResults/properties/${type}`, result)
          : JSON.stringify(result) === '{}'
            ? null
            : 'an untyped request must reply {}';
        if (wrong) this.violations.push(`${type} reply: ${wrong}: ${line.slice(0, 300)}`);
      }
      if ('id' in message) {
        const resolve = this.replies.get(message.id as string);
        assert.ok(resolve, `a reply to an unknown id: ${line.slice(0, 200)}`);
        this.replies.delete(message.id as string);
        resolve(message as Reply);
      } else {
        this.events.push(message as any);
        for (const wake of this.waiters) wake();
      }
    });
  }

  /** Sends a request and waits for its reply (either kind). */
  send(type: string, fields: Record<string, unknown> = {}, timeout = STEP_TIMEOUT): Promise<Reply> {
    const id = `t${++this.next}`;
    this.types.set(id, type);
    return new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`no reply to ${type} within ${timeout} ms\n${this.tail()}`)),
        timeout,
      );
      this.replies.set(id, (reply) => {
        clearTimeout(timer);
        resolve(reply);
      });
      this.child.stdin!.write(`${JSON.stringify({ id, type, ...fields })}\n`);
    });
  }

  /** Sends a request that must succeed and returns its result. */
  async ok(type: string, fields: Record<string, unknown> = {}, timeout?: number) {
    const reply = await this.send(type, fields, timeout);
    assert.equal(
      reply.ok,
      true,
      `${type} failed: ${JSON.stringify(reply).slice(0, 2000)}\n${this.tail()}`,
    );
    return (reply as { result: Record<string, any> }).result;
  }

  /** The first event from `from` on that matches. */
  async event(
    match: (event: Develop['events'][number]) => boolean,
    from = 0,
    timeout = STEP_TIMEOUT,
  ): Promise<Develop['events'][number]> {
    const deadline = Date.now() + timeout;
    for (;;) {
      const found = this.events.slice(from).find(match);
      if (found) return found;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`no matching event within ${timeout} ms\n${this.tail()}`);
      await new Promise<void>((wake) => {
        const timer = setTimeout(done, Math.min(left, 1000));
        function done() {
          clearTimeout(timer);
          waiters.delete(done);
          wake();
        }
        const waiters = this.waiters;
        waiters.add(done);
      });
    }
  }

  tail(): string {
    const events = this.events
      .filter((e) => e.event !== 'frame')
      .slice(-15)
      .map((e) => JSON.stringify(e).slice(0, 300));
    return `events:\n${events.join('\n')}\nstderr:\n${this.stderr.slice(-30).join('\n')}`;
  }

  /** Pointer press and release at viewport coordinates, through the `input` request. */
  async click(x: number, y: number): Promise<void> {
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'])
      await this.ok('input', {
        event: {
          kind: 'mouse',
          type,
          x,
          y,
          button: type === 'mouseMoved' ? 'none' : 'left',
          clickCount: type === 'mouseMoved' ? 0 : 1,
        },
      });
  }

  /**
   * Ends the child after a failure too: SIGTERM lets it close the browser and stop the fixture web server (which runs
   * in its own process group); SIGKILL only when it does not exit within 20 s.
   */
  async end(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.kill('SIGTERM');
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 20_000);
    await this.exited;
    clearTimeout(timer);
  }
}

let work = '';
let app = '';
let develop: Develop;
let original: Map<string, Buffer>;
let port = 0;

before(async () => {
  original = snapshotFiles(fixture);
  // At the fixture's depth (engine/test/<app>), so `../../src/index.ts` in its config still names the engine.
  work = mkdtempSync(join(engine, 'test', '.develop-session-'));
  app = work;
  cpSync(fixture, app, {
    recursive: true,
    filter: (source) => !source.startsWith(join(fixture, 'reports')),
  });
  port = await freePort();
  develop = new Develop(app, port, join(work, 'reports'));
});

after(async () => {
  await develop?.end();
  if (work) rmSync(work, { recursive: true, force: true });
  // Nothing the session did may reach the real fixture.
  const now = snapshotFiles(fixture);
  assert.deepEqual([...now.keys()].sort(), [...original.keys()].sort());
  for (const [path, bytes] of original)
    assert.ok(now.get(path)!.equals(bytes), `fixture file changed: ${path}`);
});

const engineFile = () => readFileSync(join(app, caseFile));

test('a develop session over stdin/stdout, end to end', { timeout: 600_000 }, async (t) => {
  const bytes = engineFile();
  const text = bytes.toString('utf8');
  let loaded: DevelopCase;

  await t.test('ready and hello', async () => {
    const ready = await develop.event((e) => e.event === 'ready', 0, 30_000);
    assert.equal(ready.app, 'fixture');
    assert.equal(ready.appDir, app);
    assert.ok(existsSync(ready.docs.testFormat), ready.docs.testFormat);
    // The engine says which requests it answers, so Launcher offers only those.
    for (const type of [
      'hello',
      'run_step',
      'discard_case',
      'promote',
      'duplicate_case',
      'rename_case',
      'move_case',
      'describe_point',
      'variables',
      'load_block',
      'search_steps',
      'replace_text',
    ])
      assert.ok(ready.requests.includes(type), `${type} announced`);
    assert.ok(existsSync(ready.docs.authoring), ready.docs.authoring);
    // BASE_URL is unset: the default base is the fixture's webServer.
    assert.equal(ready.baseUrl, `http://127.0.0.1:${port}/`);
    const hello = await develop.ok('hello');
    assert.deepEqual(hello, {
      engineVersion: ready.engineVersion,
      app: ready.app,
      appDir: ready.appDir,
      docs: ready.docs,
      baseUrl: ready.baseUrl,
      requests: ready.requests,
    });
  });

  await t.test('cases lists the whole app, its session blocks and seeds', async () => {
    const listed = await develop.ok('cases');
    const { cases } = listed;
    assert.equal(listed.error, undefined);
    assert.ok(listed.sessions.includes('log in as reception'), listed.sessions.join(', '));
    assert.deepEqual(listed.seeds, [
      { name: 'fixture base', description: 'Reports the base URL seeds use; creates nothing' },
    ]);
    const ids = cases.map((c: { id: string }) => c.id);
    assert.ok(ids.includes(CASE_ID));
    // Template rows are listed by row.
    assert.ok(
      ids.some((id: string) => id.startsWith('self.worklist-search[')),
      ids.join(', '),
    );
    // The real-model tests too.
    assert.ok(cases.some((c: { file: string }) => c.file.startsWith('tests/')));
    assert.ok(cases.every((c: { draft: unknown }) => typeof c.draft === 'boolean'));
  });

  await t.test('load', async () => {
    const from = develop.events.length;
    const result = await develop.ok('load', { caseId: CASE_ID });
    loaded = result.case;
    assert.equal(result.error, undefined);
    assert.equal(loaded.id, CASE_ID);
    assert.equal(loaded.file, 'self-test/engine.md');
    assert.equal(loaded.session, 'log in as reception');
    assert.deepEqual(
      loaded.steps.map((s) => s.kind),
      ['open', 'click', 'expect', 'select', 'check', 'click', 'expect'],
    );
    assert.equal(loaded.steps[1].text, 'click the "Check in" action in the row for "Ana Petrova"');
    const event = await develop.event((e) => e.event === 'case.loaded', from);
    assert.deepEqual(event.case, loaded);
  });

  await t.test('start logs in through the session block and reports ready', async () => {
    const from = develop.events.length;
    const result = await develop.ok('start', {}, 120_000);
    assert.match(result.url, new RegExp(`^http://127\\.0\\.0\\.1:${port}/`));
    const states = develop.events
      .slice(from)
      .filter((e) => e.event === 'session.state')
      .map((e) => e.state);
    assert.deepEqual(states, ['starting', 'ready']);
  });

  await t.test('run_step 0..2', async () => {
    const records: DevelopStepRecord[] = [];
    for (const index of [0, 1, 2]) {
      const from = develop.events.length;
      const { record } = await develop.ok('run_step', { index });
      assert.equal(record.status, 'passed', JSON.stringify(record).slice(0, 1000));
      assert.equal(record.index, index);
      const started = await develop.event((e) => e.event === 'step.started', from);
      assert.equal(started.index, index);
      const finished = await develop.event((e) => e.event === 'step.finished', from);
      assert.deepEqual(finished.record, record);
      records.push(record);
    }
    const click = records[1];
    assert.ok(click.chosen, 'the click chose an element');
    assert.match(click.chosen.description, /Check in/);
    assert.ok(click.chosen.confidence > 0);
    assert.ok(click.candidates && click.candidates.length > 0);
    assert.ok(click.screenshot && click.screenshot.length > 1000, 'a screenshot before the action');
    assert.ok(
      Buffer.from(click.screenshot, 'base64')
        .subarray(0, 2)
        .equals(Buffer.from([0xff, 0xd8])),
    );
    // Every record carries the small screenshot after the step and the page's errors during it.
    for (const record of records) {
      assert.ok(record.after && record.after.length > 1000, 'a screenshot after the step');
      const after = Buffer.from(record.after, 'base64');
      assert.ok(after.subarray(0, 2).equals(Buffer.from([0xff, 0xd8])), 'a JPEG');
      assert.ok(record.page, 'the page activity');
      assert.ok(Array.isArray(record.page.errors));
      assert.ok(Array.isArray(record.page.console));
      assert.ok(Array.isArray(record.page.requests));
    }
  });

  await t.test(
    'verify_step resolves without acting, and refuses an expect step with a hint',
    async () => {
      const result = await develop.ok('verify_step', { index: 3 });
      assert.ok(result.chosen, JSON.stringify(result).slice(0, 1000));
      assert.match(result.chosen.description, /Insurance/);
      assert.ok(result.candidates.length > 0);
      // A wording trial.
      const trial = await develop.ok('verify_step', {
        index: 4,
        text: 'check "Consent form signed"',
      });
      assert.ok(trial.chosen);
      const refused = await develop.send('verify_step', { index: 2 });
      assert.equal(refused.ok, false);
      assert.match((refused as { error: string }).error, /expect/);
      assert.ok((refused as { hint?: string }).hint, 'a hint');
    },
  );

  await t.test('snapshot and page_text', async () => {
    const snap = await develop.ok('snapshot');
    assert.match(snap.url, /worklist\.html/);
    assert.ok(Array.isArray(snap.headings));
    assert.ok(snap.elements.length > 0);
    assert.ok(
      snap.elements.some((e: { description: string }) => /Confirm check-in/.test(e.description)),
    );
    const page = await develop.ok('page_text');
    assert.match(page.url, /worklist\.html/);
    assert.equal(typeof page.visibleText, 'string');
    assert.ok(Array.isArray(page.tables));
    assert.ok(Array.isArray(page.fields));
    assert.ok(Array.isArray(page.actions?.rows) && Array.isArray(page.actions?.other), 'actions');
    assert.ok(
      page.actions.rows.length + page.actions.other.length > 0,
      JSON.stringify(page.actions),
    );
  });

  await t.test('screencast streams frames with the viewport', async () => {
    const from = develop.events.length;
    await develop.ok('screencast', { enabled: true, maxWidth: 800, quality: 50 });
    const frame = await develop.event((e) => e.event === 'frame', from, 30_000);
    assert.ok(frame.data.length > 100);
    assert.ok(
      Buffer.from(frame.data, 'base64')
        .subarray(0, 2)
        .equals(Buffer.from([0xff, 0xd8])),
    );
    assert.deepEqual(frame.viewport, { width: 1280, height: 720 });
    assert.ok(frame.width <= 800 && frame.width > 0);
    assert.match(frame.url, /worklist\.html/);
    await develop.ok('screencast', { enabled: false });
  });

  await t.test('edit_step rewrites one line and autosaves', async () => {
    const from = develop.events.length;
    const original = '7. expect the page says "Checked in" within 5 seconds';
    const edited = '7. expect the page says "Checked in" within 6 seconds';
    assert.ok(text.includes(original));
    const result = await develop.ok('edit_step', {
      index: 6,
      text: 'expect the page says "Checked in" within 6 seconds',
    });
    assert.equal(result.saved, true);
    assert.equal(result.file, 'self-test/engine.md');
    assert.equal(result.error, undefined);
    assert.equal(result.case.steps[6].text, 'expect the page says "Checked in" within 6 seconds');
    assert.equal(engineFile().toString('utf8'), text.replace(original, edited));
    const event = await develop.event((e) => e.event === 'case.updated', from);
    assert.deepEqual(event.case, result.case);
    // A step the parser rejects is refused, with the parser's hint; nothing is written.
    const refused = await develop.send('edit_step', {
      index: 6,
      text: 'frobnicate the "Save" button',
    });
    assert.equal(refused.ok, false);
    assert.ok((refused as { hint?: string }).hint);
    await develop.ok('edit_step', {
      index: 6,
      text: 'expect the page says "Checked in" within 5 seconds',
    });
    assert.ok(engineFile().equals(bytes), 'edited back to the original bytes');
  });

  await t.test('insert_step and delete_step restore the exact bytes', async () => {
    const inserted = await develop.ok('insert_step', { index: 3, text: 'wait 1 second' });
    assert.equal(inserted.saved, true);
    assert.equal(inserted.case.steps.length, 8);
    assert.equal(inserted.case.steps[3].text, 'wait 1 second');
    const now = engineFile().toString('utf8');
    assert.ok(
      now.includes('4. wait 1 second\n5. select "Private" in the "Insurance" dropdown'),
      now,
    );
    assert.ok(now.includes('8. expect the page says "Checked in" within 5 seconds'));
    const deleted = await develop.ok('delete_step', { index: 3 });
    assert.equal(deleted.case.steps.length, 7);
    assert.ok(engineFile().equals(bytes), 'the original bytes');
    // Appending at the end, then removing it again.
    await develop.ok('insert_step', { index: 7, text: 'wait 1 second' });
    assert.ok(engineFile().toString('utf8').includes('8. wait 1 second'));
    await develop.ok('delete_step', { index: 7 });
    assert.ok(engineFile().equals(bytes));
  });

  await t.test('set_meta: draft and refs on, then off, leave the bytes identical', async () => {
    const on = await develop.ok('set_meta', { draft: true, refs: ['C1234', 'C5678'] });
    assert.equal(on.saved, true);
    assert.equal(on.case.draft, true);
    assert.deepEqual(on.case.refs, ['C1234', 'C5678']);
    assert.ok(on.case.tags.includes('@draft'));
    const now = engineFile().toString('utf8');
    assert.ok(now.includes(`id: ${CASE_ID}\n`), now);
    assert.match(now, /tags: @draft\n/);
    assert.match(now, /refs: C1234, C5678\n/);
    // Drafts stay in the case list.
    const { cases } = await develop.ok('cases');
    const listed = cases.find((c: { id: string }) => c.id === CASE_ID);
    assert.equal(listed.draft, true);
    assert.deepEqual(listed.refs, ['C1234', 'C5678']);
    const off = await develop.ok('set_meta', { draft: false, refs: [] });
    assert.equal(off.case.draft, false);
    assert.deepEqual(off.case.refs, []);
    assert.ok(engineFile().equals(bytes), 'the original bytes');
  });

  await t.test('set_meta: session and seed lines, refused when the app lacks them', async () => {
    const path = join(app, caseFile);
    const badSession = await develop.send('set_meta', { session: 'nobody' });
    assert.equal(badSession.ok, false);
    assert.match(badSession.error ?? '', /session "nobody" is not defined/);
    const badSeed = await develop.send('set_meta', { seed: 'nothing' });
    assert.equal(badSeed.ok, false);
    assert.match(badSeed.error ?? '', /seed "nothing" is not defined/);
    assert.ok(engineFile().equals(bytes), 'a refused change writes nothing');
    const seeded = await develop.ok('set_meta', { seed: 'fixture base' });
    assert.equal(seeded.case.seed, 'fixture base');
    assert.equal(seeded.error, undefined);
    assert.match(
      readFileSync(path, 'utf8'),
      /\nsession: log in as reception\nseed: fixture base\n1\. open/,
    );
    const same = await develop.ok('set_meta', { session: 'log in as reception' });
    assert.equal(same.case.session, 'log in as reception');
    const removed = await develop.ok('set_meta', { seed: null });
    assert.equal(removed.case.seed, undefined);
    assert.ok(engineFile().equals(bytes), 'the file is byte-identical again');
  });

  await t.test(
    'load_block: a Steps block in the rail, edited with exact bytes and run in the open session',
    async () => {
      const loginFile = join(app, 'tests', 'shared', 'login.md');
      const loginBytes = readFileSync(loginFile);
      const loginText = loginBytes.toString('utf8');
      let from = develop.events.length;
      const result = await develop.ok('load_block', { name: 'log in as reception' });
      const block = result.block;
      assert.equal(result.error, undefined);
      assert.equal(block.name, 'log in as reception');
      assert.equal(block.file, 'tests/shared/login.md');
      assert.equal(block.line, 6);
      assert.deepEqual(
        block.steps.map((s: { kind: string }) => s.kind),
        ['open', 'fill', 'fill', 'click', 'expect'],
      );
      assert.equal(block.steps[0].text, 'open "/"');
      assert.equal(block.steps[3].line, 10);
      // Every way a case uses it, by the case's written id (a template once).
      const uses = (caseId: string) =>
        block.usedBy
          .filter((use: { caseId: string }) => use.caseId === caseId)
          .map((use: { as: string }) => use.as);
      assert.deepEqual(uses(CASE_ID), ['session']);
      assert.deepEqual(uses('shared-block-fill-and-press'), ['use']);
      assert.deepEqual(uses('self.worklist-search'), ['use']);
      assert.deepEqual(uses('switch-to-another-session-and-call-an-endpoint'), ['session']);
      const loaded = await develop.event((e) => e.event === 'block.loaded', from);
      assert.deepEqual(loaded.block, block);
      const nurse = await develop.ok('load_block', { name: 'log in as nurse' });
      assert.ok(
        nurse.block.usedBy.some(
          (use: { caseId: string; as: string }) =>
            use.caseId === 'switch-to-another-session-and-call-an-endpoint' && use.as === 'switch',
        ),
        JSON.stringify(nurse.block.usedBy),
      );
      await develop.ok('load_block', { name: 'log in as reception' });

      // Edit one step and back: only that line of the block's file changes; the case file is untouched.
      from = develop.events.length;
      const edited = await develop.ok('edit_step', {
        index: 3,
        text: 'click the "Log in" button in the form',
      });
      assert.equal(edited.saved, true);
      assert.equal(edited.file, 'tests/shared/login.md');
      assert.equal(edited.error, undefined);
      assert.equal(edited.block.steps[3].text, 'click the "Log in" button in the form');
      assert.equal(
        readFileSync(loginFile, 'utf8'),
        loginText.replace(
          '4. click the "Log in" button\n5. expect the page shows the reception worklist',
          '4. click the "Log in" button in the form\n5. expect the page shows the reception worklist',
        ),
      );
      const updated = await develop.event((e) => e.event === 'block.updated', from);
      assert.deepEqual(updated.block, edited.block);
      assert.equal(updated.saved, true);
      await develop.ok('edit_step', { index: 3, text: 'click the "Log in" button' });
      assert.ok(readFileSync(loginFile).equals(loginBytes), 'edited back to the original bytes');
      const inserted = await develop.ok('insert_step', { index: 1, text: 'wait 1 second' });
      assert.equal(inserted.block.steps.length, 6);
      assert.ok(
        readFileSync(loginFile, 'utf8').includes(
          '1. open "/"\n2. wait 1 second\n3. fill the username field',
        ),
      );
      const deleted = await develop.ok('delete_step', { index: 1 });
      assert.equal(deleted.block.steps.length, 5);
      assert.ok(readFileSync(loginFile).equals(loginBytes), 'the original bytes');
      assert.ok(engineFile().equals(bytes), 'the case file is untouched');

      // The block's own steps run in the open session.
      from = develop.events.length;
      const { record } = await develop.ok('run_step', { index: 0 });
      assert.equal(record.status, 'passed', JSON.stringify(record).slice(0, 1000));
      assert.equal((await develop.event((e) => e.event === 'step.finished', from)).index, 0);
      // A wording trial resolves on the page as it is (the session is logged in, so on the worklist, not the form).
      await develop.ok('navigate', { path: '/worklist.html' });
      const trial = await develop.ok('verify_step', {
        index: 1,
        text: 'click the "Check in" action in the row for "Ana Petrova"',
      });
      assert.match(
        trial.chosen?.description ?? '',
        /Check in/,
        JSON.stringify(trial).slice(0, 500),
      );

      // Case-only requests are refused while a block is loaded; nothing is written.
      for (const [type, fields] of [
        ['set_meta', { draft: true }],
        ['promote', {}],
        ['discard_case', { caseId: CASE_ID }],
      ] as const) {
        const refused = await develop.send(type, fields);
        assert.equal(refused.ok, false, type);
        assert.match(refused.error ?? '', /^a Steps block is loaded/, type);
        assert.ok(refused.hint, `${type}: a hint`);
      }
      assert.ok(engineFile().equals(bytes));
      const unknown = await develop.send('load_block', { name: 'no such block' });
      assert.equal(unknown.ok, false);
      assert.match(unknown.error ?? '', /unknown steps block "no such block"/);

      // `start` with a login block loaded logs in through it: the login form is gone.
      from = develop.events.length;
      await develop.ok('start', {}, 120_000);
      assert.deepEqual(
        develop.events
          .slice(from)
          .filter((e) => e.event === 'session.state')
          .map((e) => e.state),
        ['starting', 'ready'],
      );
      const snap = await develop.ok('snapshot');
      assert.ok(
        !snap.elements.some((e: { description: string }) => /Username/.test(e.description)),
        'logged in through the block',
      );

      // Loading the case again unloads the block.
      from = develop.events.length;
      const back = await develop.ok('load', { caseId: CASE_ID });
      assert.equal(back.case.id, CASE_ID);
      await develop.event((e) => e.event === 'case.loaded', from);
      const meta = await develop.ok('set_meta', { refs: [] });
      assert.equal(meta.case.id, CASE_ID);
      assert.ok(engineFile().equals(bytes));
    },
  );

  await t.test(
    'promote: drafts only; every step from a fresh session; @draft goes only with refs',
    async () => {
      // Not a draft: refused, nothing runs or changes.
      const refused = await develop.send('promote');
      assert.equal(refused.ok, false);
      assert.equal(
        refused.error ?? '',
        `only drafts can be promoted: "${CASE_ID}" is not tagged @draft`,
      );
      assert.ok(refused.hint, 'a hint');
      assert.ok(engineFile().equals(bytes), 'a refusal writes nothing');

      const passedAll = (result: Record<string, any>, from: number) => {
        assert.equal(result.passed, true, JSON.stringify(result).slice(0, 2000));
        assert.equal(result.stoppedAt, undefined);
        assert.deepEqual(
          result.records.map((r: DevelopStepRecord) => [r.index, r.status]),
          loaded.steps.map((_, index) => [index, 'passed']),
        );
        // A fresh session first, then one step.* pair per step, as run_from 0 emits them.
        const events = develop.events.slice(from);
        const states = events.filter((e) => e.event === 'session.state').map((e) => e.state);
        assert.deepEqual(states, ['starting', 'ready']);
        assert.deepEqual(
          events.filter((e) => e.event === 'step.started').map((e) => e.index),
          loaded.steps.map((_, index) => index),
        );
      };

      // A draft without refs: every step passes, the tag stays.
      await develop.ok('set_meta', { draft: true });
      const drafted = engineFile().toString('utf8');
      assert.equal(drafted, text.replace(`id: ${CASE_ID}\n`, `id: ${CASE_ID}\ntags: @draft\n`));
      let from = develop.events.length;
      const noRefs = await develop.ok('promote', {}, 300_000);
      passedAll(noRefs, from);
      assert.equal(noRefs.promoted, false);
      assert.equal(noRefs.reason, 'add refs first');
      assert.equal(engineFile().toString('utf8'), drafted, 'nothing written without refs');

      // With refs: promoted, and the tags line (only @draft) is gone; nothing else changed.
      await develop.ok('set_meta', { refs: ['C1234'] });
      const withRefs = engineFile().toString('utf8');
      assert.equal(
        withRefs,
        text.replace(`id: ${CASE_ID}\n`, `id: ${CASE_ID}\ntags: @draft\nrefs: C1234\n`),
      );
      from = develop.events.length;
      const promoted = await develop.ok('promote', {}, 300_000);
      passedAll(promoted, from);
      assert.equal(promoted.promoted, true);
      assert.equal(promoted.reason, undefined);
      assert.equal(engineFile().toString('utf8'), withRefs.replace('tags: @draft\n', ''));
      const updated = await develop.event((e) => e.event === 'case.updated', from);
      assert.equal(updated.case.draft, false);
      assert.deepEqual(updated.case.refs, ['C1234']);
      // The session stays open on the final page.
      const snap = await develop.ok('snapshot');
      assert.match(snap.url, /worklist\.html/);

      await develop.ok('set_meta', { refs: [] });
      assert.ok(engineFile().equals(bytes), 'the original bytes');
    },
  );

  await t.test(
    'duplicate_case, rename_case, move_case: a copy goes from file to file, the original untouched',
    async () => {
      // The case's section as written, for comparing the copy byte for byte.
      const start = text.indexOf('## Test: Session, row action');
      const section = text.slice(start, text.indexOf('\n\n## Test:', start) + 1);
      const copied = (name: string, id: string) =>
        section
          .replace(/^## Test: .*\n/, `## Test: ${name}\n`)
          .replace(`id: ${CASE_ID}\n`, `id: ${id}\ntags: @draft\n`);

      // Into a folder: the file is named after the copy, which is loaded as a draft.
      let from = develop.events.length;
      const copy = await develop.ok('duplicate_case', {
        caseId: CASE_ID,
        name: 'Develop mode copy',
        file: 'self-test/',
      });
      assert.equal(copy.case.id, 'develop-mode-copy');
      assert.equal(copy.case.file, 'self-test/develop-mode-copy.md');
      assert.equal(copy.case.draft, true);
      assert.equal(copy.case.steps.length, loaded.steps.length);
      const copyFile = join(app, 'self-test', 'develop-mode-copy.md');
      assert.equal(
        readFileSync(copyFile, 'utf8'),
        copied('Develop mode copy', 'develop-mode-copy'),
      );
      const loadedCopy = await develop.event((e) => e.event === 'case.loaded', from);
      assert.equal(loadedCopy.case.id, 'develop-mode-copy');

      // Rename: an id another case has is refused; a new id and name rewrite two lines only.
      const taken = await develop.send('rename_case', {
        caseId: 'develop-mode-copy',
        newId: CASE_ID.toUpperCase(),
      });
      assert.equal(taken.ok, false);
      assert.match(taken.error ?? '', /already used in the app/);
      from = develop.events.length;
      const renamed = await develop.ok('rename_case', {
        caseId: 'develop-mode-copy',
        newId: 'develop-mode-copy-2',
        name: 'Develop mode copy renamed',
      });
      assert.equal(renamed.case.id, 'develop-mode-copy-2');
      assert.equal(renamed.case.name, 'Develop mode copy renamed');
      assert.equal(renamed.file, 'self-test/develop-mode-copy.md');
      assert.equal(
        readFileSync(copyFile, 'utf8'),
        copied('Develop mode copy renamed', 'develop-mode-copy-2'),
      );
      const update = await develop.event((e) => e.event === 'case.updated', from);
      assert.equal(update.case.id, 'develop-mode-copy-2');

      // Move: the section leaves its file (removed, nothing else was in it) for a new one.
      from = develop.events.length;
      const moved = await develop.ok('move_case', {
        caseId: 'develop-mode-copy-2',
        file: 'self-test/moved.md',
      });
      assert.equal(moved.from, 'self-test/develop-mode-copy.md');
      assert.equal(moved.to, 'self-test/moved.md');
      assert.equal(moved.fileRemoved, true);
      assert.equal(moved.case.file, 'self-test/moved.md');
      assert.ok(!existsSync(copyFile), 'the emptied file is gone');
      const movedFile = join(app, 'self-test', 'moved.md');
      assert.equal(
        readFileSync(movedFile, 'utf8'),
        copied('Develop mode copy renamed', 'develop-mode-copy-2'),
      );
      const movedEvent = await develop.event((e) => e.event === 'case.updated', from);
      assert.equal(movedEvent.file, 'self-test/moved.md');
      const same = await develop.send('move_case', {
        caseId: 'develop-mode-copy-2',
        file: 'self-test/moved.md',
      });
      assert.equal(same.ok, false);

      // Discarded, it takes its file with it; the original case was never touched.
      await develop.ok('discard_case', { caseId: 'develop-mode-copy-2' });
      assert.ok(!existsSync(movedFile), 'moved.md is gone');
      assert.ok(engineFile().equals(bytes), 'the original bytes');
      const listed = await develop.ok('cases');
      assert.equal(listed.error, undefined);
      assert.ok(!listed.cases.some((c: { id: string }) => c.id.startsWith('develop-mode-copy')));
      await develop.ok('load', { caseId: CASE_ID });
    },
  );

  await t.test(
    'suggest_step: a failed step rewritten to an element of its record; nothing is saved',
    async () => {
      await develop.ok('start', {}, 120_000);
      await develop.ok('run_step', { index: 0 });
      const original = 'click the "Check in" action in the row for "Ana Petrova"';
      const wrong = 'click the "Check out" action in the row for "Ana Petrova"';
      // Before the step has run in this context, there is no record to take an id from.
      const early = await develop.send('suggest_step', { index: 1, elementId: 'e1' });
      assert.equal(early.ok, false);
      assert.match(early.error ?? '', /has not run in this session/);
      await develop.ok('edit_step', { index: 1, text: wrong });
      const edited = engineFile();
      const { record } = await develop.ok('run_step', { index: 1 });
      assert.equal(record.status, 'failed', JSON.stringify(record).slice(0, 1000));
      assert.equal(record.failure?.kind, 'target-not-found');
      const offered = [...(record.top ?? []), ...(record.candidates ?? [])].filter(
        (item: { id: string }) => item.id !== 'none',
      );
      const top = (record.top ?? []).find(
        (item: { id: string; p: number }) => item.id !== 'none' && item.p > 0,
      );
      const id = (
        top ??
        offered.find(
          (item: { description: string }) =>
            /Check in/.test(item.description) && /Ana Petrova/.test(item.description),
        )
      )?.id;
      assert.ok(id, JSON.stringify(offered).slice(0, 1000));
      const { text: suggested } = await develop.ok('suggest_step', { index: 1, elementId: id });
      assert.match(suggested, /^click the "Check in" (action|button) in the row for "/);
      // Equivalent wording: it resolves to the same element.
      const verified = await develop.ok('verify_step', { index: 1, text: suggested });
      assert.equal(verified.chosen?.id, id, JSON.stringify(verified).slice(0, 1000));
      assert.ok(engineFile().equals(edited), 'suggest_step writes nothing');
      // Refused: the model's "none", an id the record does not list, and a step without an element.
      for (const [fields, pattern] of [
        [{ index: 1, elementId: 'none' }, /not an element/],
        [{ index: 1, elementId: 'e9999' }, /not an element/],
        [{ index: 0, elementId: id }, /open step/],
      ] as const) {
        const refused = await develop.send('suggest_step', fields);
        assert.equal(refused.ok, false);
        assert.match(refused.error ?? '', pattern);
        assert.ok(refused.hint, 'a hint');
      }
      await develop.ok('edit_step', { index: 1, text: original });
      assert.ok(engineFile().equals(bytes), 'the original bytes');
    },
  );

  await t.test('promote with runs: 2 runs twice from a fresh session', async () => {
    const refused = await develop.send('promote', { runs: 6 });
    assert.equal(refused.ok, false);
    assert.match(refused.error ?? '', /runs must be a whole number from 1 to 5/);
    await develop.ok('set_meta', { draft: true });
    const from = develop.events.length;
    const result = await develop.ok('promote', { runs: 2 }, 600_000);
    assert.equal(result.passed, true, JSON.stringify(result).slice(0, 2000));
    assert.equal(result.runs, 2);
    assert.equal(result.records.length, loaded.steps.length);
    assert.equal(result.promoted, false);
    assert.equal(result.reason, 'add refs first');
    const events = develop.events.slice(from);
    assert.deepEqual(
      events.filter((e) => e.event === 'session.state').map((e) => e.state),
      ['starting', 'ready', 'starting', 'ready'],
    );
    assert.equal(events.filter((e) => e.event === 'step.started').length, loaded.steps.length * 2);
    await develop.ok('set_meta', { draft: false });
    assert.ok(engineFile().equals(bytes), 'the original bytes');
  });

  await t.test('stop closes the session; the process stays', async () => {
    const from = develop.events.length;
    await develop.ok('stop');
    const state = await develop.event((e) => e.event === 'session.state', from);
    assert.equal(state.state, 'closed');
    const refused = await develop.send('snapshot');
    assert.equal(refused.ok, false);
    const noSelection = await develop.send('page_selection');
    assert.equal(noSelection.ok, false);
    assert.match((noSelection as { error: string }).error, /not open/);
    assert.equal(develop.child.exitCode, null);
  });

  await t.test(
    'search_steps and replace_text: find a label, preview, apply, rename back; no session needed',
    async () => {
      const checkin = join('tests', 'reception', 'checkin.md');
      const checkinBytes = readFileSync(join(app, checkin));
      const { matches } = await develop.ok('search_steps', { query: 'check IN' });
      assert.deepEqual(
        matches.map((m: Record<string, unknown>) => [m.file, m.line, m.index]),
        [
          ['self-test/engine.md', 12, 1],
          ['self-test/engine.md', 41, 2],
          ['tests/reception/checkin.md', 8, 1],
          ['tests/reception/checkin.md', 20, 1],
          ['tests/reception/checkin.md', 31, 1],
          ['tests/reception/checkin.md', 44, 3],
          ['tests/reception/checkin.md', 54, 1],
        ],
      );
      assert.deepEqual(matches[0], {
        caseId: CASE_ID,
        name: 'Session, row action, dropdown, checkbox and expect',
        file: 'self-test/engine.md',
        line: 12,
        index: 1,
        text: 'click the "Check in" action in the row for "Ana Petrova"',
      });
      const blank = await develop.send('search_steps', { query: '  ' });
      assert.equal(blank.ok, false);

      // A preview writes nothing.
      const preview = await develop.ok('replace_text', { from: 'Check in', to: 'Check-in' });
      assert.equal(preview.applied, false);
      assert.equal(preview.changes.length, 7);
      assert.deepEqual(preview.changes[0], {
        file: 'self-test/engine.md',
        line: 12,
        caseId: CASE_ID,
        before: 'click the "Check in" action in the row for "Ana Petrova"',
        after: 'click the "Check-in" action in the row for "Ana Petrova"',
      });
      assert.deepEqual(
        preview.changes.map((c: { file: string }) => c.file),
        [...Array(2).fill('self-test/engine.md'), ...Array(5).fill(checkin)],
      );
      assert.ok(engineFile().equals(bytes), 'a preview writes nothing');
      for (const [fields, pattern] of [
        [{ from: '', to: 'x' }, /empty/],
        [{ from: 'Check in', to: 'Say "hi"' }, /double quote/],
      ] as const) {
        const refused = await develop.send('replace_text', fields);
        assert.equal(refused.ok, false);
        assert.match((refused as { error: string }).error, pattern);
      }

      // Applied: only the quoted labels change, and the loaded case is updated.
      let from = develop.events.length;
      const applied = await develop.ok('replace_text', {
        from: 'Check in',
        to: 'Check-in',
        apply: true,
      });
      assert.equal(applied.applied, true);
      assert.deepEqual(applied.changes, preview.changes);
      assert.equal(
        engineFile().toString('utf8'),
        text
          .replace(
            '2. click the "Check in" action in the row for "Ana Petrova"',
            '2. click the "Check-in" action in the row for "Ana Petrova"',
          )
          .replace(
            '3. optionally click "Check in" in the row',
            '3. optionally click "Check-in" in the row',
          ),
      );
      assert.equal(
        readFileSync(join(app, checkin), 'utf8'),
        checkinBytes.toString('utf8').replaceAll('"Check in"', '"Check-in"'),
      );
      const updated = await develop.event((e) => e.event === 'case.updated', from);
      assert.equal(
        updated.case.steps[1].text,
        'click the "Check-in" action in the row for "Ana Petrova"',
      );
      assert.equal(updated.saved, true);
      assert.equal((await develop.ok('cases')).error, undefined, 'the app still parses');

      // And back: every file byte-identical.
      from = develop.events.length;
      const back = await develop.ok('replace_text', {
        from: 'Check-in',
        to: 'Check in',
        apply: true,
      });
      assert.equal(back.changes.length, 7);
      assert.ok(engineFile().equals(bytes), 'the case file is byte-identical again');
      assert.ok(readFileSync(join(app, checkin)).equals(checkinBytes), 'and the other file');
      await develop.event((e) => e.event === 'case.updated', from);
      const none = await develop.ok('replace_text', { from: 'Check-in', to: 'X', apply: true });
      assert.deepEqual(none, { changes: [], applied: false });
    },
  );

  // A new case: written as a draft, empty until a step is inserted; the app parses all the same.
  let coordinates: Awaited<ReturnType<typeof measureLogin>>;

  await t.test('new_case, insert_step, run_step', async () => {
    const created = await develop.ok('new_case', {
      file: 'self-test/develop-new.md',
      name: 'Develop mode new case',
    });
    assert.equal(created.case.id, 'develop-mode-new-case');
    assert.equal(created.case.draft, true);
    assert.deepEqual(created.case.steps, []);
    assert.equal(created.error, undefined, 'a draft without steps parses');
    const file = join(app, 'self-test', 'develop-new.md');
    assert.match(
      readFileSync(file, 'utf8'),
      /## Test: Develop mode new case\nid: develop-mode-new-case\ntags: @draft\n/,
    );
    // Nothing to run or verify before the first step is written: a plain refusal, not an index error.
    for (const type of ['run_step', 'run_from', 'verify_step', 'promote']) {
      const early = await develop.send(type, { index: 0 });
      assert.equal(early.ok, false, type);
      assert.equal(early.error ?? '', 'the case has no steps yet', type);
      assert.equal(early.hint ?? '', 'Add the first step with insert_step at index 0.', type);
    }
    // No file, or a folder: the file is named after the case. A nameless file is refused.
    const named = await develop.ok('new_case', { file: 'self-test/', name: 'Named After Me' });
    assert.equal(named.case.file, 'self-test/named-after-me.md');
    assert.ok(existsSync(join(app, 'self-test', 'named-after-me.md')));
    await develop.ok('discard_case', { caseId: named.case.id });
    assert.ok(!existsSync(join(app, 'self-test', 'named-after-me.md')));
    const nameless = await develop.send('new_case', { file: 'self-test/.md', name: 'Nameless' });
    assert.equal(nameless.ok, false);
    assert.match(nameless.error ?? '', /has no file name/);
    await develop.ok('load', { caseId: 'develop-mode-new-case' });
    // The app still parses: the list is the parsed one, with the new case as a draft.
    const listed = await develop.ok('cases');
    assert.equal(listed.error, undefined);
    const fresh = listed.cases.find((c: { id: string }) => c.id === 'develop-mode-new-case');
    assert.equal(fresh?.draft, true);
    assert.ok(listed.cases.some((c: { id: string }) => c.id === CASE_ID));
    assert.ok(listed.sessions.includes('log in as reception'));
    assert.equal(listed.seeds.length, 1);
    const added = await develop.ok('insert_step', { index: 0, text: 'open "/register.html"' });
    assert.equal(added.error, undefined);
    assert.equal(added.case.steps.length, 1);
    assert.match(readFileSync(file, 'utf8'), /\n1\. open "\/register\.html"\n?$/);
    await develop.ok('start', {}, 120_000);
    const { record } = await develop.ok('run_step', { index: 0 });
    assert.equal(record.status, 'passed', JSON.stringify(record).slice(0, 1000));
    // Without a login, the register page sends the visitor to the login form.
    const snap = await develop.ok('snapshot');
    assert.match(snap.url, /\/(index\.html)?$/);
    assert.ok(snap.elements.some((e: { description: string }) => /Username/.test(e.description)));

    // A page the clinic does not have: the 404 is on that step's record, without the query string; then the step goes.
    await develop.ok('insert_step', { index: 1, text: 'open "/no-such-page.html?token=x#part"' });
    const missing = (await develop.ok('run_step', { index: 1 })).record as DevelopStepRecord;
    assert.equal(missing.status, 'passed', JSON.stringify(missing).slice(0, 1000));
    assert.deepEqual(
      missing.page?.requests.find((r) => r.status === 404),
      { method: 'GET', url: `http://127.0.0.1:${port}/no-such-page.html`, status: 404 },
      JSON.stringify(missing.page),
    );
    const removed = await develop.ok('delete_step', { index: 1 });
    assert.equal(removed.case.steps.length, 1);
    // Back on the login form for the input test below.
    assert.equal((await develop.ok('run_step', { index: 0 })).record.status, 'passed');
  });

  await t.test('input: a click at a known point changes the page', async () => {
    coordinates = await measureLogin(port);
    const before = await develop.ok('page_text');
    assert.doesNotMatch(before.visibleText, /No card reader detected/);
    await develop.click(coordinates.card.x, coordinates.card.y);
    const deadline = Date.now() + 10_000;
    let after = before;
    while (Date.now() < deadline && !/No card reader detected/.test(after.visibleText)) {
      await new Promise((r) => setTimeout(r, 200));
      after = await develop.ok('page_text');
    }
    assert.match(after.visibleText, /No card reader detected/);
  });

  await t.test(
    'record turns clicks and typing into fill and click steps, then verifies them',
    async () => {
      // The click above showed an alert that moved the form down: start from a fresh login page.
      const { url } = await develop.ok('navigate', { path: '/index.html' });
      assert.match(url, /\/index\.html$/);
      const from = develop.events.length;
      await develop.ok('record', { enabled: true });
      await develop.click(coordinates.username.x, coordinates.username.y);
      await develop.ok('input', { event: { kind: 'insertText', text: 'reception1' } });
      await develop.click(coordinates.card.x, coordinates.card.y);
      const fill = await develop.event(
        (e) => e.event === 'recorded' && e.step.kind === 'fill',
        from,
      );
      const click = await develop.event(
        (e) => e.event === 'recorded' && e.step.kind === 'click',
        from,
      );
      const steps = [fill.step, click.step] as RecordedStep[];
      assert.equal(
        steps[0].text,
        'fill the "Username" field in the "Staff login" section with "reception1"',
      );
      assert.equal(steps[0].value, 'reception1');
      assert.equal(
        steps[1].text,
        'click the "Sign in with staff card" button in the "Staff login" section',
      );
      for (const step of steps) {
        const verified = await develop.event(
          (e) => e.event === 'recorded.verified' && e.at === step.at,
          from,
        );
        assert.equal(verified.verification.matches, true, JSON.stringify(verified));
        assert.equal(verified.verification.chosenId, step.elementId);
      }
      const { steps: recorded } = await develop.ok('recording');
      assert.ok(recorded.some((s: RecordedStep) => s.at === steps[0].at));
      await develop.ok('record', { enabled: false });
      await develop.ok('clear_recording');
      assert.deepEqual((await develop.ok('recording')).steps, []);
    },
  );

  await t.test(
    'describe_point: the wording and steps for what is at a point, nothing acted on',
    async () => {
      // The clicks above showed the alert that moves the form: measure against a fresh login page again.
      const { url } = await develop.ok('navigate', { path: '/index.html' });
      assert.match(url, /\/index\.html$/);
      const card = await develop.ok('describe_point', coordinates.card);
      assert.equal(card.element.kind, 'button');
      assert.match(card.element.description, /^button "Sign in with staff card"/);
      assert.equal(card.target, 'the "Sign in with staff card" button');
      assert.equal(card.context, 'in the "Staff login" section');
      assert.deepEqual(card.steps, [
        {
          kind: 'click',
          text: 'click the "Sign in with staff card" button in the "Staff login" section',
        },
      ]);
      const username = await develop.ok('describe_point', coordinates.username);
      assert.equal(username.target, 'the "Username" field');
      assert.deepEqual(username.steps, [
        { kind: 'fill', text: 'fill the "Username" field in the "Staff login" section with ""' },
      ]);
      // Nothing was clicked or typed: the alert is still hidden.
      const page = await develop.ok('page_text');
      assert.doesNotMatch(page.visibleText, /No card reader detected/);
      const nothing = await develop.ok('describe_point', { x: 2, y: 2 });
      assert.deepEqual(nothing.steps, []);
      assert.ok(nothing.reason, 'a reason when nothing is there');
      const bad = await develop.send('describe_point', { x: 'left', y: 3 });
      assert.equal(bad.ok, false);
      assert.match(bad.error ?? '', /x and y must be numbers/);
    },
  );

  await t.test(
    'page_selection: the selected words and their section, empty without a selection',
    async () => {
      await develop.ok('navigate', { path: '/index.html' });
      assert.deepEqual(await develop.ok('page_selection'), { text: '' });
      const { x, y } = coordinates.staff;
      await develop.ok('input', {
        event: { kind: 'mouse', type: 'mouseMoved', x, y, button: 'none' },
      });
      for (const clickCount of [1, 2])
        for (const type of ['mousePressed', 'mouseReleased'])
          await develop.ok('input', {
            event: { kind: 'mouse', type, x, y, button: 'left', clickCount },
          });
      const deadline = Date.now() + 10_000;
      let selection = await develop.ok('page_selection');
      while (Date.now() < deadline && !selection.text) {
        await new Promise((r) => setTimeout(r, 200));
        selection = await develop.ok('page_selection');
      }
      assert.deepEqual(selection, { text: 'Staff', scope: 'Staff login' });
    },
  );

  await t.test('stop, then start again opens a fresh session', async () => {
    await develop.ok('stop');
    const from = develop.events.length;
    await develop.ok('start', {}, 120_000);
    const states = develop.events
      .slice(from)
      .filter((e) => e.event === 'session.state')
      .map((e) => e.state);
    assert.deepEqual(states, ['starting', 'ready']);
    const { record } = await develop.ok('run_step', { index: 0 });
    assert.equal(record.status, 'passed');
  });

  await t.test(
    'start with baseUrl: a chosen origin sticks until null returns to the default',
    async () => {
      const refused = await develop.send('start', { baseUrl: 'ftp://127.0.0.1/' });
      assert.equal(refused.ok, false);
      assert.match(refused.error ?? '', /baseUrl/);
      // Refused before anything changed: the open session still answers.
      const still = await develop.ok('navigate', { path: '/index.html' });
      assert.equal(still.url, `http://127.0.0.1:${port}/index.html`);
      // Only the origin counts. The loaded case has no session block, so the page stays blank until a relative
      // navigate shows which base applies; the same server answers on localhost.
      const at = async () => (await develop.ok('navigate', { path: '/index.html' })).url;
      await develop.ok('start', { baseUrl: `http://localhost:${port}/some/path?x=1` }, 120_000);
      assert.equal(await at(), `http://localhost:${port}/index.html`);
      await develop.ok('start', {}, 120_000);
      assert.equal(
        await at(),
        `http://localhost:${port}/index.html`,
        'a start without baseUrl keeps the choice',
      );
      await develop.ok('start', { baseUrl: null }, 120_000);
      assert.equal(
        await at(),
        `http://127.0.0.1:${port}/index.html`,
        'null returns to the default',
      );
    },
  );

  await t.test('a chosen base reaches seeds too', async () => {
    const created = await develop.ok('new_case', {
      file: 'self-test/develop-seeded.md',
      name: 'Develop mode seeded case',
      seed: 'fixture base',
    });
    assert.equal(created.case.seed, 'fixture base');
    await develop.ok('insert_step', { index: 0, text: 'open "/index.html"' });
    const seedBase = (from: number) =>
      develop.events
        .slice(from)
        .map((e) => (e.event === 'log' ? String((e as { message?: unknown }).message) : ''))
        .find((line) => line.startsWith('[seed fixture base] base '));
    let from = develop.events.length;
    await develop.ok('start', { baseUrl: `http://localhost:${port}` }, 120_000);
    assert.equal(seedBase(from), `[seed fixture base] base http://localhost:${port}`);
    from = develop.events.length;
    await develop.ok('start', { baseUrl: null }, 120_000);
    assert.equal(seedBase(from), `[seed fixture base] base http://127.0.0.1:${port}`);
  });

  await t.test('variables: the seed after start, a saved value after a call step', async () => {
    // The seeded case of the test above is loaded; its seed returns { base }.
    const expected = { seed: { base: `http://127.0.0.1:${port}` }, saved: {}, param: {} };
    let from = develop.events.length;
    const started = await develop.ok('start', {}, 120_000);
    assert.deepEqual(started.variables, expected);
    const sent = await develop.event((e) => e.event === 'variables', from);
    assert.deepEqual(sent.variables, expected);
    assert.deepEqual(await develop.ok('variables'), expected);
    // A step that saves nothing sends no event.
    from = develop.events.length;
    assert.equal((await develop.ok('run_step', { index: 0 })).record.status, 'passed');
    assert.ok(!develop.events.slice(from).some((e) => e.event === 'variables'));
    // `call … and save`: the event follows step.finished with the saved value as text.
    await develop.ok('insert_step', {
      index: 1,
      text: 'call GET "/limits.json" and save "lastWeek" as "weeks"',
    });
    from = develop.events.length;
    const { record } = await develop.ok('run_step', { index: 1 });
    assert.equal(record.status, 'passed', JSON.stringify(record));
    const saved = await develop.event((e) => e.event === 'variables', from);
    assert.deepEqual(saved.variables, { ...expected, saved: { weeks: '4' } });
    const order = develop.events
      .slice(from)
      .map((e) => e.event)
      .filter((name) => name === 'step.finished' || name === 'variables');
    assert.deepEqual(order, ['step.finished', 'variables']);
    assert.deepEqual((await develop.ok('variables')).saved, { weeks: '4' });
    await develop.ok('delete_step', { index: 1 });
    // Closed: nothing to show.
    await develop.ok('stop');
    assert.deepEqual(await develop.ok('variables'), { seed: {}, saved: {}, param: {} });
  });

  await t.test(
    'discard_case: drafts only; the loaded case is unloaded; an emptied file goes',
    async () => {
      // Not a draft: refused, with the way to make it one. An unknown id: as `load` answers.
      const kept = await develop.send('discard_case', { caseId: CASE_ID });
      assert.equal(kept.ok, false);
      assert.equal(
        kept.error ?? '',
        `only drafts can be discarded: "${CASE_ID}" is not tagged @draft`,
      );
      assert.equal(
        kept.hint ?? '',
        'Tag it with set_meta { draft: true } first, or delete it in the file by hand.',
      );
      const unknown = await develop.send('discard_case', { caseId: 'no-such-case' });
      assert.equal(unknown.ok, false);
      assert.match(unknown.error ?? '', /unknown case id "no-such-case"/);
      assert.ok(engineFile().equals(bytes), 'a refusal writes nothing');

      // A second draft in the new file: its section goes, the file and the case above it stay.
      const newFile = join(app, 'self-test', 'develop-new.md');
      const second = await develop.ok('new_case', {
        file: 'self-test/develop-new.md',
        name: 'Develop mode second case',
      });
      assert.equal(second.case.id, 'develop-mode-second-case');
      assert.match(
        readFileSync(newFile, 'utf8'),
        /\n\n## Test: Develop mode second case\nid: develop-mode-second-case\ntags: @draft\n$/,
      );
      let from = develop.events.length;
      const partial = await develop.ok('discard_case', { caseId: 'develop-mode-second-case' });
      assert.deepEqual(partial, {
        caseId: 'develop-mode-second-case',
        file: 'self-test/develop-new.md',
        fileRemoved: false,
      });
      assert.equal(
        readFileSync(newFile, 'utf8'),
        '## Test: Develop mode new case\nid: develop-mode-new-case\ntags: @draft\n1. open "/register.html"\n',
      );
      const event = await develop.event((e) => e.event === 'case.discarded', from);
      assert.deepEqual(event, { event: 'case.discarded', ...partial });
      // new_case had loaded it: nothing is loaded now.
      const noCase = await develop.send('run_step', { index: 0 });
      assert.equal(noCase.ok, false);
      assert.match(noCase.error ?? '', /no case is loaded/);

      // The only section of its file: the file goes with it.
      await develop.ok('load', { caseId: 'develop-mode-seeded-case' });
      from = develop.events.length;
      const whole = await develop.ok('discard_case', { caseId: 'develop-mode-seeded-case' });
      assert.deepEqual(whole, {
        caseId: 'develop-mode-seeded-case',
        file: 'self-test/develop-seeded.md',
        fileRemoved: true,
      });
      assert.ok(!existsSync(join(app, 'self-test', 'develop-seeded.md')), 'the file is gone');
      await develop.event((e) => e.event === 'case.discarded' && e.fileRemoved === true, from);
      const listed = await develop.ok('cases');
      assert.equal(listed.error, undefined);
      const ids = listed.cases.map((c: { id: string }) => c.id);
      assert.ok(
        !ids.includes('develop-mode-seeded-case') && !ids.includes('develop-mode-second-case'),
      );
      assert.ok(ids.includes('develop-mode-new-case'));
    },
  );

  await t.test('stdin EOF closes the browser and exits 0', async () => {
    develop.child.stdin!.end();
    const code = await Promise.race([
      develop.exited,
      new Promise((done) => setTimeout(() => done('timeout'), 30_000).unref()),
    ]);
    assert.equal(code, 0, develop.tail());
    assert.deepEqual(develop.violations, [], 'every message matches the contract');
    // The fixture web server stopped with the session.
    await assert.rejects(fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) }));
  });
});

/** Where the login form's username field and staff-card button are at the Desktop Chrome viewport (1280x720). */
async function measureLogin(port: number) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.goto(`http://127.0.0.1:${port}/index.html`);
    const centre = async (selector: string) => {
      const box = (await page.locator(selector).boundingBox())!;
      return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
    };
    // The word "Staff" of the "Staff login" heading, for a double-click that selects it.
    const staff = await page.evaluate(() => {
      const text = document.querySelector('#login-form h2')!.firstChild!;
      const range = document.createRange();
      range.setStart(text, 0);
      range.setEnd(text, 'Staff'.length);
      const box = range.getBoundingClientRect();
      return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
    });
    return { username: await centre('#username'), card: await centre('#card-login'), staff };
  } finally {
    await browser.close();
  }
}
