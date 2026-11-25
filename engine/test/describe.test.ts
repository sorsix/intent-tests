// One-line element descriptions: an icon-only control is named by its icon.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// The imported runner configuration needs a selected app; this fixture uses only the offline decider.
process.env.AT_APP_DIR = fileURLToPath(new URL('./fixture/', import.meta.url));
process.env.AT_DECIDER = 'stub';
const { describe } = await import('../src/snapshot.ts');

test('an unnamed button showing only an icon is named by the icon', () => {
  assert.equal(
    describe({ id: 'e1', kind: 'button', name: '', icon: 'close', section: 'Episode 1' }),
    'button "close" (icon only) — in Episode 1',
  );
});

test('a named button keeps its name and lists its icon', () => {
  assert.equal(
    describe({ id: 'e1', kind: 'button', name: 'Print', icon: 'print' }),
    'button "Print", icon "print"',
  );
});

test('an unnamed control without an icon still says it has no label', () => {
  assert.equal(
    describe({ id: 'e1', kind: 'link', name: '', near: 'Version' }),
    'link "(no label)", next to "Version"',
  );
});

test('a role="tab" control is described as a tab, keeping its state', () => {
  assert.equal(
    describe({ id: 'e1', kind: 'button', name: 'Deferrals', tab: true }),
    'tab "Deferrals"',
  );
  assert.equal(
    describe({ id: 'e1', kind: 'button', name: 'Episodes', tab: true, selected: true }),
    'tab "Episodes", selected',
  );
});

test('a button named only by aria-label and showing an icon says so', () => {
  assert.equal(
    describe({
      id: 'e1',
      kind: 'button',
      name: 'Request assistance',
      icon: 'help outline',
      iconOnly: true,
    }),
    'button "Request assistance" (icon only), icon "help outline"',
  );
  assert.equal(
    describe({ id: 'e1', kind: 'button', name: 'Close', iconOnly: true }),
    'button "Close" (icon only)',
  );
});
