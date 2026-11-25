// The self-test decider must stay deterministic and strict: a wrong pick there would hide engine regressions.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { stubDecider } from '../src/decider/stub.ts';

const stub = stubDecider();
const options = {
  e1: 'button "Check in" — in row 1 of table "Today\'s appointments" (Patient: Ana Petrova)',
  e2: 'button "Check in" — in row 2 of table "Today\'s appointments" (Patient: Anna Petrovska)',
  e3: 'button "Cancel" — in row 1 of table "Today\'s appointments" (Patient: Ana Petrova)',
  none: 'No element on this page matches the step exactly',
};

describe('stub decider', () => {
  test('picks the one option with every quoted label', async () => {
    const call = await stub.choose(
      { step: 'click "Check in" in the row for "Ana Petrova"' },
      'Which element?',
      options,
    );
    assert.equal(call.choice, 'e1');
    assert.equal(call.confidence, 1);
  });

  test('answers none on a tie or no match', async () => {
    assert.equal((await stub.choose({ step: 'click "Check in"' }, 'q', options)).choice, 'none');
    assert.equal(
      (await stub.choose({ step: 'click "Discharge" for "Maja Angelovska"' }, 'q', options)).choice,
      'none',
    );
  });

  test('dropdown options: the wanted text', async () => {
    const call = await stub.choose(
      { wanted: 'Private', options: ['Public', 'Private'] },
      'Which option?',
      { o1: 'Public', o2: 'Private', none: 'none' },
    );
    assert.equal(call.choice, 'o2');
  });

  test('yes/no: every quoted text on the page', async () => {
    const page = { text: 'Ana Petrova — Checked in', fields: [], actions: { rows: [], other: [] } };
    assert.equal(
      (await stub.yesNo({ assertion: 'the page says "Checked in" for "Ana Petrova"', page }, 'q'))
        .yes,
      1,
    );
    assert.equal((await stub.yesNo({ assertion: 'the page says "Cancelled"', page }, 'q')).yes, 0);
  });
});
