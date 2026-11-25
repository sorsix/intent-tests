// Pick (docs/develop-mode.md, sections 3.1 and 3.6, `describe_point`): what is under a viewport point of the page,
// described as the resolver reads it, with the wording the recorder would write for it and ready-made steps to insert.
//
// Browser side (`pointPage`, serialized with `collectElements` like the recorder's init script): the deepest element at
// the point, climbed to the actionable element the snapshot listed, so "what the person pointed at" is exactly an
// element a step can be verified against; for plain text, the text and where it sits. Node side (`pointDescription`,
// pure): the wording, built with the recorder's own `targetOf`, `contextOf` and `stepText`.
import { collectElements, describe, type Snapshot, type SnapElement } from '../snapshot.ts';
import type { PointDescription, SessionVariables } from './protocol.ts';
import { contextOf, quoted, stepText, targetOf } from './recorder.ts';
import { withVariables } from './variables.ts';

/** What the browser side reports for a point: the snapshot element there, or the plain text under it. */
export type PointHit = {
  /** The actionable element at the point (the hit or its nearest actionable ancestor), as `collectElements` lists it. */
  element?: SnapElement;
  /** Title of the open modal dialog (`''` for one without a title), or null. */
  dialog: string | null;
  /** Visible text of a non-interactive element at the point, trimmed to `TEXT_LIMIT` characters. */
  text?: string;
  /** The nearest heading above that text (its dialog's own headings when it is in one). */
  section?: string;
  /** The table row the text is in. */
  row?: NonNullable<SnapElement['row']>;
};

/** The most characters of plain text an `expect` suggestion quotes. */
export const TEXT_LIMIT = 80;

/**
 * Runs in the page. Self-contained: it is serialized with `toString()`, so it may not refer to anything outside itself.
 * Changes nothing in the page except what a snapshot does (the `data-at-id` attributes).
 */
function pointPage(x: number, y: number, collect: () => Snapshot, limit: number): PointHit | null {
  const snap = collect();
  const clean = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim();
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  // The deepest element at the point, into open shadow roots.
  let el: Element | null = document.elementFromPoint(x, y);
  while (el?.shadowRoot) {
    const inner: Element | null = el.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === el) break;
    el = inner;
  }
  if (!el || el === document.documentElement) return null;
  // Up to the actionable element the snapshot listed (a label's text, an icon in a button), across shadow hosts.
  const byId = new Map(snap.elements.map((e) => [e.id, e]));
  for (let a: Element | null = el; a;) {
    const item = byId.get(a.getAttribute('data-at-id') ?? '');
    if (item) return { element: item, dialog: snap.dialog };
    const root = a.getRootNode();
    a = a.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
  }
  if (el === document.body) return { dialog: snap.dialog };

  // Plain text: the element's own when it is short; a long one belongs to a container, where only the text written
  // directly in it counts, cut to the limit.
  const all = clean((el as HTMLElement).innerText);
  let text = all.length <= limit ? all : '';
  if (all.length > limit) {
    const own = clean(
      [...el.childNodes]
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent)
        .join(' '),
    );
    text = own ? own.slice(0, limit).trim() : '';
  }
  if (!text) return { dialog: snap.dialog };
  const hit: PointHit = { dialog: snap.dialog, text };

  // In a table body: the row, as `collectElements` describes a row action's (header cells, cells without controls).
  const controls = 'a[href], button, input, select, textarea, [role="button"], [role="link"]';
  const tr = el.closest('tr');
  const table = tr?.closest('table');
  if (tr && table && tr.parentElement?.tagName === 'TBODY') {
    const headers = [...table.querySelectorAll('thead th')].map((th) => clean(th.textContent));
    const cells: Record<string, string> = {};
    [...tr.children].forEach((td, i) => {
      if (td.querySelector(controls) || /^actions$/i.test(headers[i] ?? '')) return;
      cells[headers[i] || `col${i + 1}`] = clean((td as HTMLElement).innerText);
    });
    const by = table.getAttribute('aria-labelledby');
    const title = by
      ? document.getElementById(by)?.textContent
      : table.getAttribute('aria-label') ||
        table.querySelector('caption, h1, h2, h3, legend')?.textContent;
    hit.row = {
      table: clean(title),
      number: [...tr.parentElement.children].filter(visible).indexOf(tr) + 1,
      cells,
    };
    return hit;
  }

  // Otherwise the nearest heading above it: inside a dialog or side panel only its own headings count. A heading
  // names itself, not the heading before it.
  const marked = snap.dialog === null ? null : document.querySelector('[data-at-dialog]');
  const scope =
    marked && marked.contains(el)
      ? marked
      : el.closest(
          'dialog[open], [role="dialog"], [role="alertdialog"], aside, [role="complementary"]',
        );
  if (!el.closest('h1, h2, h3, h4, legend')) {
    const heading = [...(scope ?? document).querySelectorAll('h1, h2, h3, h4, legend')]
      .filter(
        (h) =>
          visible(h) &&
          /\p{L}/u.test(h.textContent ?? '') &&
          !h.contains(el) &&
          h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING,
      )
      .pop();
    if (heading) hit.section = clean(heading.textContent);
  }
  return hit;
}

/** The browser expression for `page.evaluate`: the `PointHit` at viewport point (x, y), or null. */
export function pointScript(x: number, y: number): string {
  return `(${pointPage.toString()})(${x}, ${y}, ${collectElements.toString()}, ${TEXT_LIMIT})`;
}

const NO_ELEMENT: SnapElement = { id: '', kind: 'button', name: '' };

/**
 * The description, target wording and suggested steps for what the browser side found (pure). Buttons, links, tabs
 * and row actions get `click`; text fields `fill … with ""`; dropdowns `select "<current value>" in …` (the grammar
 * needs an option, so the current one stands in for the person to replace); checkboxes and switches the action that
 * changes their state first, then the other; radios `check`. Plain text gets one `expect … shows "<text>"` scoped the
 * way the recorder scopes a target (`the page` when there is none). `press` is never suggested.
 */
export function pointDescription(hit: PointHit | null): PointDescription {
  if (!hit) return { steps: [], reason: 'nothing is at this point' };
  const { dialog } = hit;
  const e = hit.element;
  if (e) {
    const { target, context } = targetOf('click', e, dialog);
    const steps: PointDescription['steps'] = [];
    const add = (kind: 'click' | 'fill' | 'select' | 'check' | 'uncheck', value?: string) =>
      steps.push({ kind, text: stepText(kind, e, value, { dialog }) });
    switch (e.kind) {
      case 'button':
      case 'link':
        add('click');
        break;
      case 'textbox':
        add('fill', '');
        break;
      case 'select':
        add('select', e.value ?? '');
        break;
      case 'checkbox':
        add(e.checked ? 'uncheck' : 'check');
        add(e.checked ? 'check' : 'uncheck');
        break;
      case 'radio':
        add('check');
        break;
    }
    return {
      element: { id: e.id, kind: e.kind, description: describe(e) },
      target,
      ...(context.trim() ? { context: context.trim() } : {}),
      steps,
    };
  }
  if (!hit.text)
    return { steps: [], reason: 'no actionable element or visible text at this point' };
  const where = contextOf(
    hit.row ? { ...NO_ELEMENT, row: hit.row } : NO_ELEMENT,
    hit.section ?? '',
    dialog,
  ).trim();
  const scope = where ? where.replace(/^in /, '') : 'the page';
  return {
    ...(where ? { context: where } : {}),
    steps: [{ kind: 'expect', text: `expect ${scope} shows ${quoted(hit.text)}` }],
  };
}

// ---- suggest_step (docs/develop-mode.md, sections 3.1 and 3.6) ----------------------------------------------------

/** The step kinds `suggest_step` rewrites. */
export const SUGGEST_KINDS = ['click', 'fill', 'select', 'check', 'uncheck', 'expect'];
/** The words that start an expect's statement after its subject (`the page shows …`, `the "Name" field is empty`). */
const STATEMENT_VERBS = new Set([
  'shows',
  'show',
  'says',
  'is',
  'are',
  'has',
  'have',
  'contains',
  'lists',
  'displays',
  'reads',
  'includes',
  'does',
]);

/**
 * A written step rewritten to target `element` (pure): the verb, the value (`fill … with "…"`), the option
 * (`select "…" in …`), `optionally` and an optional step's `, only if …` condition, and an expect's statement and
 * `within N seconds` stay as written; the target and context are the recorder's wording (`targetOf`), with the
 * session's values as variables like a recorded step. An expect's subject (the words before its first statement verb)
 * becomes the element. The result is not parsed here: the session checks it with the parser.
 */
export function suggestedStep(
  written: string,
  element: SnapElement,
  dialog: string | null,
  variables?: SessionVariables,
): { text: string } | { error: string; hint: string } {
  const { target, context } = targetOf('click', element, dialog);
  const plainPhrase = `${target}${context}`;
  const phrase = variables
    ? withVariables(`click ${plainPhrase}`, 'click', variables).replace(/^click /, '')
    : plainPhrase;
  const optional = /^optionally\s+/i.exec(written.trim())?.[0] ?? '';
  const step = written.trim().slice(optional.length);
  // An optional step's condition is part of its target as the parser reads it: kept as written.
  const condition = (old: string) =>
    optional ? (/,\s*(?:only\s+)?if\s+.+$/i.exec(old)?.[0] ?? '') : '';
  let m: RegExpExecArray | null;
  if ((m = /^(fill)\s+(.+?)\s+(with)\s+"(.*)"$/i.exec(step)))
    return {
      text: `${optional}${m[1]} ${phrase}${condition(m[2])} ${m[3]} "${m[4]}"`,
    };
  if ((m = /^(select)\s+("[^"]+")\s+(in|from)\s+(.+)$/i.exec(step)))
    return { text: `${optional}${m[1]} ${m[2]} ${m[3]} ${phrase}${condition(m[4])}` };
  if ((m = /^(uncheck|check|click)\s+(.+)$/i.exec(step)))
    return { text: `${optional}${m[1]} ${phrase}${condition(m[2])}` };
  if ((m = /^(expect)\s+(.+?)(\s+within\s+\d+\s*seconds?)?$/i.exec(step))) {
    const statement = m[2];
    // The first statement verb outside quotes ends the subject.
    const verb = [...statement.matchAll(/"[^"]*"|\S+/g)].find(
      (token) => token.index > 0 && STATEMENT_VERBS.has(token[0].toLowerCase()),
    );
    if (!verb)
      return {
        error: `the expect has no subject to replace: "${statement}"`,
        hint: 'Write it as <what> shows "<text>", or edit its wording with edit_step.',
      };
    return { text: `${m[1]} ${phrase} ${statement.slice(verb.index)}${m[3] ?? ''}` };
  }
  return {
    error: `suggest_step rewrites ${SUGGEST_KINDS.join(', ')} steps`,
    hint: 'Edit the step with edit_step.',
  };
}
