// Screenshots in System One requests (AT_DECIDER_IMAGES): vllm-sr's inline `images`, TypeSafe's `assets`, and the
// d3-ultra preset's model check, against a local server.
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

// deciderSettings reads the app config, so an app must be selected; the fixture's is enough.
process.env.AT_APP_DIR = fileURLToPath(new URL('./fixture/', import.meta.url));
const { deciderSettings } = await import('../src/decider/index.ts');
const { systemOne } = await import('../src/decider/systemone.ts');

let server: Server;
let url = '';
let body: any = null;
let headers: Record<string, string | string[] | undefined> = {};
/** Model the server names in its answer. */
let answeredBy = 'vllm-sr/d3-ultra';

before(async () => {
  server = createServer((req, res) => {
    let text = '';
    req.on('data', (c) => (text += c));
    req.on('end', () => {
      body = JSON.parse(text);
      headers = req.headers;
      const answers = body.questions.target
        ? { target: { choice: 'e1', confidence: 0.9, probabilities: { e1: 0.9, none: 0.1 } } }
        : { claim: { noul: 0.95 } };
      res
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ model: answeredBy, answers, usage: { input_tokens: 10 } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/systemone`;
});
after(() => server.close());

const decider = (requireModel = false) =>
  systemOne({
    name: 'd3-ultra',
    url,
    model: 'vllm-sr/d3-ultra',
    sendModel: true,
    maxOptions: 255,
    usdPerMInput: 0,
    requireModel,
    images: 'inline',
  });
const jev = () =>
  systemOne({
    name: 'jev',
    url,
    model: 'jev-latest',
    sendModel: true,
    maxOptions: 255,
    usdPerMInput: 0,
    images: 'assets',
  });

describe('System One images', () => {
  test('screenshots go in `images` and are counted on the call', async () => {
    answeredBy = 'vllm-sr/d3-ultra';
    const shot = 'data:image/jpeg;base64,AAAA';
    const choice = await decider().choose(
      { step: 'click Save' },
      'Which element?',
      { e1: 'button "Save"', none: 'nothing' },
      [shot],
    );
    assert.deepEqual(body.images, [shot]);
    assert.equal(choice.images, 1);
    const yes = await decider().yesNo({ assertion: 'x' }, 'Is it true?', undefined, [shot]);
    assert.deepEqual(body.images, [shot]);
    assert.equal(yes.images, 1);
  });

  test('inline screenshots send no TypeSafe header', async () => {
    await decider().yesNo({ assertion: 'x' }, 'Is it true?', undefined, [
      'data:image/jpeg;base64,AAAA',
    ]);
    assert.equal(headers['typesafe-danger-zone-images'], undefined);
    assert.equal('assets' in body, false);
  });

  test('without screenshots the request has no `images` field', async () => {
    answeredBy = 'vllm-sr/d3-ultra';
    const call = await decider().yesNo({ assertion: 'x' }, 'Is it true?');
    assert.equal('images' in body, false);
    assert.equal(call.images, undefined);
  });

  test('requireModel fails an answer from another model', async () => {
    answeredBy = 'vllm-sr/d3-turbo';
    await assert.rejects(
      decider(true).yesNo({}, 'Is it true?'),
      /asked for vllm-sr\/d3-ultra, answered by vllm-sr\/d3-turbo/,
    );
    assert.equal((await decider(false).yesNo({}, 'Is it true?')).model, 'vllm-sr/d3-turbo');
  });
});

describe('TypeSafe assets', () => {
  test('a screenshot becomes an asset referenced from the state, with the opt-in header', async () => {
    answeredBy = 'jev-1.14.0';
    const choice = await jev().choose(
      { step: 'click Save' },
      'Which element?',
      { e1: 'button "Save"', none: 'nothing' },
      ['data:image/jpeg;base64,AAAA'],
    );
    assert.equal(headers['typesafe-danger-zone-images'], 'true');
    assert.equal('images' in body, false);
    assert.equal(body.state.step, 'click Save');
    assert.deepEqual(body.assets, {
      [body.state.screenshot]: { type: 'image', format: 'jpeg', data_base64: 'AAAA' },
    });
    assert.equal(choice.images, 1);
  });

  test('a fresh reference per request, and none of it without screenshots', async () => {
    await jev().yesNo({ assertion: 'x' }, 'Is it true?', undefined, ['data:image/png;base64,BBBB']);
    const first = body.state.screenshot;
    assert.equal(body.assets[first].format, 'png');
    await jev().yesNo({ assertion: 'x' }, 'Is it true?', undefined, ['data:image/png;base64,BBBB']);
    assert.notEqual(body.state.screenshot, first);
    await jev().yesNo({ assertion: 'x' }, 'Is it true?');
    assert.equal('assets' in body, false);
    assert.equal('screenshot' in body.state, false);
    assert.equal(headers['typesafe-danger-zone-images'], undefined);
  });

  test('a non-image data URL is refused before sending', async () => {
    await assert.rejects(
      jev().yesNo({}, 'Is it true?', undefined, ['data:image/gif;base64,AAAA']),
      /PNG or JPEG data URLs/,
    );
  });
});

describe('AT_DECIDER_IMAGES', () => {
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

  test('is refused for a model that does not read screenshots', () => {
    env({ AT_DECIDER: 'stub', AT_DECIDER_IMAGES: 'true' }, () => {
      assert.throws(
        () => deciderSettings(),
        /AT_DECIDER_IMAGES=true needs a decision model that reads screenshots on every question; stub does not\. Use one of: d3-ultra/,
      );
    });
    env({ AT_DECIDER: 'stub', AT_DECIDER_IMAGES: 'fallback' }, () => {
      assert.throws(
        () => deciderSettings(),
        /AT_DECIDER_IMAGES=fallback needs a decision model that reads screenshots; stub does not\. Use one of: jev, openai, d3-ultra/,
      );
    });
  });

  test('is refused for an unknown mode', () => {
    env(
      { AT_DECIDER: 'd3-ultra', VLLM_SR_API_KEY: 'test-key', AT_DECIDER_IMAGES: 'sometimes' },
      () => {
        assert.throws(() => deciderSettings(), /AT_DECIDER_IMAGES=sometimes is not known/);
      },
    );
  });

  test('is fallback only for jev, with its screenshot size limit', () => {
    env(
      {
        AT_DECIDER: 'jev',
        TYPESAFE_API_KEY: 'test-key',
        AT_DECIDER_API_KEY: undefined,
        AT_DECIDER_IMAGES: 'fallback',
      },
      () => {
        const s = deciderSettings();
        assert.equal(s.imageMode, 'fallback');
        assert.equal(s.images, 'assets');
        assert.equal(s.maxImageSide, 1568);
      },
    );
    env(
      {
        AT_DECIDER: 'jev',
        TYPESAFE_API_KEY: 'test-key',
        AT_DECIDER_API_KEY: undefined,
        AT_DECIDER_IMAGES: 'true',
      },
      () => {
        assert.throws(
          () => deciderSettings(),
          /AT_DECIDER_IMAGES=true needs a decision model that reads screenshots on every question; jev does not \(it supports fallback\)\. Use one of: d3-ultra/,
        );
      },
    );
  });

  test('d3-ultra defaults to fallback; AT_DECIDER_IMAGES chooses another mode or turns it off', () => {
    env(
      {
        AT_DECIDER: 'd3-ultra',
        VLLM_SR_API_KEY: 'test-key',
        AT_DECIDER_API_KEY: undefined,
        AT_DECIDER_IMAGES: 'true',
      },
      () => {
        assert.equal(deciderSettings().imageMode, 'always');
        assert.equal(deciderSettings().model, 'vllm-sr/d3-ultra');
      },
    );
    env(
      { AT_DECIDER: 'd3-ultra', VLLM_SR_API_KEY: 'test-key', AT_DECIDER_IMAGES: 'fallback' },
      () => {
        assert.equal(deciderSettings().imageMode, 'fallback');
      },
    );
    env(
      { AT_DECIDER: 'd3-ultra', VLLM_SR_API_KEY: 'test-key', AT_DECIDER_IMAGES: undefined },
      () => {
        assert.equal(deciderSettings().imageMode, 'fallback');
      },
    );
    env({ AT_DECIDER: 'd3-ultra', VLLM_SR_API_KEY: 'test-key', AT_DECIDER_IMAGES: 'false' }, () => {
      assert.equal(deciderSettings().imageMode, 'off');
    });
  });

  test('jev defaults to fallback; AT_DECIDER_IMAGES=false keeps it text only', () => {
    env(
      {
        AT_DECIDER: 'jev',
        TYPESAFE_API_KEY: 'test-key',
        AT_DECIDER_API_KEY: undefined,
        AT_DECIDER_IMAGES: undefined,
      },
      () => {
        assert.equal(deciderSettings().imageMode, 'fallback');
      },
    );
    env(
      {
        AT_DECIDER: 'jev',
        TYPESAFE_API_KEY: 'test-key',
        AT_DECIDER_API_KEY: undefined,
        AT_DECIDER_IMAGES: 'false',
      },
      () => {
        assert.equal(deciderSettings().imageMode, 'off');
      },
    );
  });
});
