// The note a choice question gets about the open dialog: a dialog without a title is still a dialog.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// The imported runner configuration needs a selected app; this fixture uses only the offline decider.
process.env.AT_APP_DIR = fileURLToPath(new URL('./fixture/', import.meta.url));
process.env.AT_DECIDER = 'stub';
const { dialogNote } = await import('../src/steps.ts');

test('no dialog, a titled dialog and a dialog without a title', () => {
  assert.equal(dialogNote(null), 'No dialog is open.');
  assert.equal(
    dialogNote('Record vitals'),
    'A modal dialog "Record vitals" is open; only its elements can be used.',
  );
  assert.equal(dialogNote(''), 'A modal dialog is open; only its elements can be used.');
});
