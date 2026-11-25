import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setDecisionContext, withLogging } from '../src/decider/log.ts';
import type { Decider, DecisionCall } from '../src/decider/types.ts';

const choice: DecisionCall = {
  type: 'choice',
  instructions: 'Select the target',
  model: 'fixture-model',
  latencyMs: 12,
  inputTokens: 42,
  choice: 'e1',
  confidence: 0.92,
  reportedConfidence: 0.71,
  probabilities: { e1: 0.92, none: 0.08 },
};
const yes: DecisionCall = {
  type: 'yesno',
  instructions: 'Check the page',
  model: 'fixture-model',
  latencyMs: 9,
  inputTokens: 21,
  yes: 0.84,
};
const decider = (): Decider => ({
  name: 'fixture',
  model: 'fixture-model',
  host: 'fixture.invalid',
  limits: { maxOptions: 10 },
  pricing: { usdPerMInput: 0 },
  choose: async () => choice,
  yesNo: async () => yes,
});
const context = (id = 'source:booking.md:7', step = '1') => ({
  test: 'Same title',
  file: 'shared/actions.md',
  line: 10,
  step: Number(step),
  stepText: 'click "Book"',
  clientTestId: id,
  attempt: 2,
  clientStepId: step,
  pass: 'parallel',
});
function folder(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'intent-decision-log-'));
  t.after(() => {
    setDecisionContext(null);
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}
type LoggedRow = {
  clientDecisionId: string;
  type: string;
  ctx: ReturnType<typeof context> & { look: number };
  request: {
    state: Record<string, unknown>;
    instructions: string;
    options?: Record<string, string>;
    criteria?: { true?: string; false?: string };
  };
  answer?: Record<string, unknown>;
  error?: { name?: string; message: string };
};
function rows(dir: string): LoggedRow[] {
  const file = join(dir, `${process.pid}.jsonl`);
  return existsSync(file)
    ? readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
}

test('success preserves original request/answer and exact attempt/source linkage', async (t) => {
  const dir = folder(t);
  const call = { ...choice, unknownFutureField: { scores: [1, 2] } };
  const inner = decider();
  inner.choose = async () => call;
  const logged = withLogging(inner, { directory: dir });
  const state = { page: { title: 'Booking' }, extra: ['original', 3] };
  const options = { e1: 'Book', none: 'No match' };
  setDecisionContext(context());
  assert.equal(await logged.choose(state, 'Original instructions', options), call);
  const [row] = rows(dir);
  assert.deepEqual(row.ctx, { ...context(), look: 1 });
  assert.deepEqual(row.request, { state, instructions: 'Original instructions', options });
  const { instructions: _instructions, ...answer } = call;
  assert.deepEqual(row.answer, answer);
  assert.match(row.clientDecisionId, /^[0-9a-f-]{36}$/);
  assert.equal(rows(dir)[0].clientDecisionId, row.clientDecisionId);
});

test('repeated looks are distinct, reset per step, and retain yes/no criteria', async (t) => {
  const dir = folder(t),
    logged = withLogging(decider(), { directory: dir });
  setDecisionContext(context());
  await logged.choose({}, 'choose', { e1: 'Book' });
  await logged.yesNo({}, 'check', { true: 'Visible', false: 'Absent' });
  setDecisionContext(context('source:other.md:7', '2'));
  await logged.choose({}, 'choose again', { e1: 'Book' });
  const recorded = rows(dir);
  assert.deepEqual(
    recorded.map((row) => row.ctx.look),
    [1, 2, 1],
  );
  assert.equal(new Set(recorded.map((row) => row.clientDecisionId)).size, 3);
  assert.equal(recorded[2].ctx.clientTestId, 'source:other.md:7');
  assert.deepEqual(recorded[1].request.criteria, { true: 'Visible', false: 'Absent' });
  assert.equal(recorded[1].answer?.yes, 0.84);
});

test('an in-flight call keeps its original context when another step starts', async (t) => {
  const dir = folder(t),
    inner = decider();
  let finish!: (value: DecisionCall) => void;
  inner.choose = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const logged = withLogging(inner, { directory: dir });
  setDecisionContext(context('source:first.md:4'));
  const pending = logged.choose({}, 'first', {});
  setDecisionContext(context('source:second.md:4', '2'));
  finish(choice);
  await pending;
  assert.equal(rows(dir)[0].ctx.clientTestId, 'source:first.md:4');
  assert.equal(rows(dir)[0].ctx.clientStepId, '1');
});

test('failed calls retain the request/error without an answer and rethrow the original object', async (t) => {
  const dir = folder(t),
    inner = decider(),
    failure = new Error('Synthetic transport failure');
  inner.choose = async () => {
    throw failure;
  };
  inner.yesNo = async () => {
    throw failure;
  };
  const logged = withLogging(inner, { directory: dir });
  setDecisionContext(context());
  await assert.rejects(
    logged.choose({ version: 1 }, 'choose', { none: 'No match' }),
    (error) => error === failure,
  );
  await assert.rejects(logged.yesNo({ version: 2 }, 'check'), (error) => error === failure);
  const recorded = rows(dir);
  assert.deepEqual(
    recorded.map((row) => row.type),
    ['choice', 'yesno'],
  );
  assert.deepEqual(
    recorded.map((row) => row.ctx.look),
    [1, 2],
  );
  assert.ok(recorded.every((row) => !('answer' in row)));
  assert.deepEqual(recorded[0].error, { name: 'Error', message: 'Synthetic transport failure' });
  assert.equal(recorded[0].request.state.version, 1);
});

test('directory/write/serialization failures cannot change a model outcome', async (t) => {
  const root = folder(t);
  const warnings = t.mock.method(console, 'warn', () => undefined);
  const blocked = join(root, 'file-instead-of-directory');
  writeFileSync(blocked, 'fixture');
  const unavailable = withLogging(decider(), { directory: blocked });
  assert.equal(await unavailable.choose({}, 'still execute', {}), choice);
  assert.equal(await unavailable.yesNo({}, 'still check'), yes);
  const dir = join(root, 'decisions');
  const logged = withLogging(decider(), { directory: dir });
  renameSync(dir, join(root, 'moved'));
  assert.equal(await logged.choose({}, 'disk unavailable', {}), choice);
  mkdirSync(dir);
  const circular: Record<string, unknown> = {};
  circular['self'] = circular;
  assert.equal(await logged.choose(circular, 'unserializable capture', {}), choice);
  assert.equal(await logged.choose({}, 'storage recovered', {}), choice);
  assert.equal(rows(dir).length, 1);
  assert.equal(warnings.mock.callCount(), 2);
});

test('a logging failure cannot replace a rejected model call', async (t) => {
  const dir = folder(t),
    failure = new Error('Original failure'),
    inner = decider();
  const blocked = join(dir, 'file');
  writeFileSync(blocked, 'fixture');
  t.mock.method(console, 'warn', () => undefined);
  inner.choose = async () => {
    throw failure;
  };
  const logged = withLogging(inner, { directory: blocked });
  await assert.rejects(logged.choose({}, 'q', {}), (error) => error === failure);
});
