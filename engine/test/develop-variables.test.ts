// Develop mode's variable values (src/develop/variables.ts): seed, saved and param values as text, secret-looking keys
// masked (also inside non-string values), long values cut.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MASKED,
  MAX_VALUE_CHARS,
  sessionVariables,
  shownValue,
  withVariables,
} from '../src/develop/variables.ts';

test('values whose key looks secret are masked, whatever the case', () => {
  for (const key of [
    'password',
    'adminPass',
    'clientSecret',
    'TOKEN',
    'apiKey',
    'keyId',
    'passphrase',
  ])
    assert.equal(shownValue(key, 'hunter2'), MASKED, key);
  assert.equal(shownValue('mrn', 'ABC1234'), 'ABC1234');
  assert.equal(shownValue('monkey', 'x'), MASKED, 'a key containing "key" counts');
});

test('non-strings become JSON with secret-looking keys masked inside; long values are cut', () => {
  assert.equal(shownValue('count', 4), '4');
  assert.equal(shownValue('ok', true), 'true');
  assert.equal(shownValue('nothing', null), 'null');
  assert.equal(shownValue('nothing', undefined), 'undefined');
  assert.equal(shownValue('big', 10n), '"10"');
  assert.equal(
    shownValue('user', { name: 'ana', password: 'hunter2', nested: { accessToken: 't' } }),
    `{"name":"ana","password":"${MASKED}","nested":{"accessToken":"${MASKED}"}}`,
  );
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.equal(shownValue('cyclic', cyclic), '[object Object]');
  const long = shownValue('note', 'x'.repeat(500));
  assert.equal(long.length, MAX_VALUE_CHARS);
  assert.ok(long.endsWith('…'));
  assert.equal(shownValue('note', 'y'.repeat(MAX_VALUE_CHARS)), 'y'.repeat(MAX_VALUE_CHARS));
});

test('sessionVariables keeps the three sources apart and never reads the environment', () => {
  process.env.DEVELOP_VARIABLES_TEST = 'from the environment';
  try {
    const variables = sessionVariables({
      seed: { mrn: 'ABC1234', password: 'p' },
      saved: { jobId: '42' },
      param: { ward: 'Cardiology' },
    });
    assert.deepEqual(variables, {
      seed: { mrn: 'ABC1234', password: MASKED },
      saved: { jobId: '42' },
      param: { ward: 'Cardiology' },
    });
    assert.ok(!JSON.stringify(variables).includes('from the environment'));
    assert.deepEqual(sessionVariables({}), { seed: {}, saved: {}, param: {} });
  } finally {
    delete process.env.DEVELOP_VARIABLES_TEST;
  }
});

test('withVariables writes a recorded value that is one of the session values as its variable', () => {
  const variables = sessionVariables({
    seed: {
      mrn: 'DEMO-BK05-1711',
      dobDay: '1',
      dobYear: '1962',
      newSite: 'Harbour Imaging Northside',
      invitationLink: 'https://clinic.example.test/app/booking/474FEBE2F1E342AA',
      password: 'DEMO-BK05-1711-secret',
    },
    saved: { jobId: '42' },
  });
  const cases: [Parameters<typeof withVariables>[1], string, string][] = [
    [
      'fill',
      'fill the "MRN / Name" field with "DEMO-BK05-1711"',
      'fill the "MRN / Name" field with "{{seed.mrn}}"',
    ],
    [
      'click',
      'click the "Cancel & Defer" button in the row for "DEMO-BK05-1711"',
      'click the "Cancel & Defer" button in the row for "{{seed.mrn}}"',
    ],
    [
      'click',
      'click the "Harbour Imaging Northside" button',
      'click the "{{seed.newSite}}" button',
    ],
    [
      'select',
      'select "1962" in the "Year" dropdown',
      'select "{{seed.dobYear}}" in the "Year" dropdown',
    ],
    // A short value only as the step's own value: the option, not a label or a row.
    [
      'select',
      'select "1" in the "Day" dropdown',
      'select "{{seed.dobDay}}" in the "Day" dropdown',
    ],
    ['click', 'click the "1" button in the row for "1"', 'click the "1" button in the row for "1"'],
    ['fill', 'fill the "Job" field with "42"', 'fill the "Job" field with "{{saved.jobId}}"'],
    // An address the seed made, opened by its path.
    ['open', 'open "/app/booking/474FEBE2F1E342AA"', 'open "{{seed.invitationLink}}"'],
    ['open', 'open "/app/home"', 'open "/app/home"'],
    // A fill value with quotes stays as recorded; part of a value is not the value.
    [
      'fill',
      'fill the "Notes" field with "say "DEMO-BK05-1711""',
      'fill the "Notes" field with "say "DEMO-BK05-1711""',
    ],
    ['click', 'click the "DEMO-BK05-1711 details" link', 'click the "DEMO-BK05-1711 details" link'],
  ];
  for (const [kind, text, expected] of cases)
    assert.equal(withVariables(text, kind, variables), expected);
  // A masked value is never matched.
  assert.equal(
    withVariables('fill the "Code" field with "DEMO-BK05-1711-secret"', 'fill', variables),
    'fill the "Code" field with "DEMO-BK05-1711-secret"',
  );
  // Two variables with the same short value: neither.
  const twice = sessionVariables({ seed: { a: '7', b: '7' } });
  assert.equal(
    withVariables('select "7" in the "Day" dropdown', 'select', twice),
    'select "7" in the "Day" dropdown',
  );
});
