// Screenshots in OpenAI Decisions requests (AT_DECIDER_IMAGES): the state and the screenshots as one user message of
// `input_text` and `input_image` parts, against a local server.
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

// deciderSettings reads the app config, so an app must be selected; the fixture's is enough.
process.env.AT_APP_DIR = fileURLToPath(new URL('./fixture/', import.meta.url));
const { deciderSettings } = await import('../src/decider/index.ts');
const { openAIDecisions } = await import('../src/decider/openai.ts');

let server: Server;
let url = '';
let body: any = null;

before(async () => {
  server = createServer((req, res) => {
    let text = '';
    req.on('data', (c) => (text += c));
    req.on('end', () => {
      body = JSON.parse(text);
      const answers =
        body.questions[0].type === 'choice'
          ? [
              {
                type: 'choice',
                name: 'target',
                choice: 'e1',
                confidence: 0.8,
                probabilities: [
                  { value: 'e1', probability: 0.9 },
                  { value: 'none', probability: 0.1 },
                ],
              },
            ]
          : [{ type: 'predicate', name: 'claim', probability: 0.95 }];
      res
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ model: 'gpt-6-luna', answers, usage: { input_tokens: 10 } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/decisions`;
});
after(() => server.close());

const decider = () =>
  openAIDecisions({ name: 'openai', url, model: 'gpt-6-luna', maxOptions: 255, usdPerMInput: 0 });
const shot = 'data:image/jpeg;base64,AAAA';

test('screenshots follow the state in one user message, and are counted on the call', async () => {
  const choice = await decider().choose(
    { step: 'click Save' },
    'Which element?',
    { e1: 'button "Save"', none: 'nothing' },
    [shot],
  );
  assert.deepEqual(body.input, [
    {
      role: 'user',
      content: [
        { type: 'input_text', text: JSON.stringify({ step: 'click Save' }) },
        { type: 'input_image', image_url: shot },
      ],
    },
  ]);
  assert.equal(body.questions[0].type, 'choice');
  assert.equal(choice.images, 1);
  assert.equal(choice.confidence, 0.9);
  const yes = await decider().yesNo({ assertion: 'x' }, 'Is it true?', undefined, [shot, shot]);
  assert.equal(body.input[0].content.length, 3);
  assert.equal(body.questions[0].type, 'predicate');
  assert.equal(yes.images, 2);
  assert.equal(yes.yes, 0.95);
});

test('without screenshots `input` stays the state as text', async () => {
  const call = await decider().yesNo({ assertion: 'x' }, 'Is it true?');
  assert.equal(body.input, JSON.stringify({ assertion: 'x' }));
  assert.equal(call.images, undefined);
  await decider().choose('page text', 'Which element?', { e1: 'button "Save"' }, []);
  assert.equal(body.input, 'page text');
});

test('the openai preset defaults to the screenshot fallback; AT_DECIDER_IMAGES=false keeps it text only', () => {
  const env = (vars: Record<string, string | undefined>, fn: () => void) => {
    const old = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
    for (const [k, v] of Object.entries(vars))
      v === undefined ? delete process.env[k] : (process.env[k] = v);
    try {
      fn();
    } finally {
      for (const [k, v] of Object.entries(old))
        v === undefined ? delete process.env[k] : (process.env[k] = v);
    }
  };
  const vars = { AT_DECIDER: 'openai', OPENAI_API_KEY: 'test-key', AT_DECIDER_API_KEY: undefined };
  env({ ...vars, AT_DECIDER_IMAGES: undefined }, () =>
    assert.equal(deciderSettings().imageMode, 'fallback'),
  );
  env({ ...vars, AT_DECIDER_IMAGES: 'false' }, () =>
    assert.equal(deciderSettings().imageMode, 'off'),
  );
  env({ ...vars, AT_DECIDER_IMAGES: 'true' }, () => {
    assert.throws(() => deciderSettings(), /openai does not \(it supports fallback\)/);
  });
});
