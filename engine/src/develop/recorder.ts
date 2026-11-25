// The recorder of develop mode (docs/develop-mode.md, section 3.4): turns what a person does in the browser into
// grammar-valid steps written in the vocabulary of `describe()`.
//
// Browser side (`recorderInitScript`): an init script that listens in the capture phase and classifies the target with
// `collectElements` itself (its source is embedded), so "what the person clicked" is exactly an element the resolver
// can later be asked about, with the same name, kind and section. It reports raw actions through a Playwright binding.
// Node side (`StepCoalescer`, used by `Recorder`): turns the raw actions into steps (a click into a field and the typing
// after it are one `fill`; a checkbox click is `check` or `uncheck` from the state it ends in; opening a custom dropdown
// and clicking one of its options is one `select`; ...).
import type { Page } from '@playwright/test';
import {
  CLICK_LISTENERS,
  collectElements,
  describe,
  OPTION_SELECTOR,
  recordClickListeners,
  type ElementKind,
  type Snapshot,
  type SnapElement,
} from '../snapshot.ts';
import type { RecordedStep } from './protocol.ts';

/** Name of the `page.exposeBinding` the browser-side script calls with raw actions. */
export const RECORDER_BINDING = 'intentRecord';

/** What the browser side reports. `key` identifies the DOM element within one document (`elementId` is renumbered by every snapshot). */
export type RawAction = {
  type:
    'hello' | 'click' | 'option' | 'toggle' | 'input' | 'change' | 'key' | 'navigate' | 'activity';
  /** Milliseconds since the epoch, taken in the page. */
  at: number;
  url?: string;
  key?: number;
  elementId?: string;
  kind?: ElementKind;
  /** The element as `collectElements` described it when the action happened. */
  element?: SnapElement;
  /** Title of the open modal dialog (`''` when it has none); null or absent when no dialog is open. */
  dialog?: string | null;
  /** Tag name (lower case) of the actionable element: a `select` is a native one. */
  tag?: string;
  /**
   * `input`/`change`: the field's value. `change` on a native select: the chosen option's label. `option`: the clicked
   * option's visible label (icons left out). Never set for a password.
   */
  value?: string;
  /** `option`: the option was already selected when it was clicked. */
  selected?: boolean;
  /** `option`: its list takes several options (a click there can also deselect). */
  multiple?: boolean;
  /** The element sits in an open dropdown's panel next to its options (the panel's own search field). */
  inPopup?: boolean;
  isPassword?: boolean;
  /** `toggle`: the state the checkbox or radio ended in. */
  checked?: boolean;
  /** `key`: `Enter` (in a textbox) or `Escape`. */
  keyName?: string;
  /** `navigate`: how the document came about. */
  via?: 'load' | 'popstate' | 'hashchange';
  navType?: string;
  referrer?: string;
};

// ---------------------------------------------------------------------------------------------------------------
// Browser side

/**
 * Runs in the page (as an init script and once in the current document). Self-contained: it is serialized with
 * `toString()`, so it may not refer to anything outside itself. It changes nothing in the page except what a snapshot
 * does (the `data-at-id` attributes) and never throws into it.
 */
function recorderPage(binding: string, collect: () => Snapshot, optionSelector: string): void {
  const w = window as unknown as Record<string, unknown>;
  const GUARD = '__intentRecorder';
  try {
    if (window !== window.top || w[GUARD]) return;
    let on = true;
    Object.defineProperty(w, GUARD, {
      value: {
        setOn: (value: boolean) => {
          on = value;
        },
      },
    });

    const call = (raw: unknown): Promise<unknown> | undefined => {
      try {
        const fn = w[binding];
        return typeof fn === 'function' ? (fn(raw) as Promise<unknown>) : undefined;
      } catch {
        return undefined;
      }
    };
    const send = (raw: Record<string, unknown>) => {
      void call(raw)?.catch(() => undefined);
    };

    // Whether the Node side is recording right now (a document loaded after `stop()` must stay quiet).
    void call({ type: 'hello', at: Date.now() })
      ?.then((active) => {
        if (active === false) on = false;
      })
      .catch(() => undefined);

    const keys = new WeakMap<Element, number>();
    let nextKey = 1;
    const keyOf = (el: Element) => {
      let key = keys.get(el);
      if (!key) keys.set(el, (key = nextKey++));
      return key;
    };
    // The elements found by the last snapshot that hit them: typing must not snapshot the page on every keystroke.
    const cache = new WeakMap<Element, { item: SnapElement; dialog: string | null }>();
    type Hit = { el: Element; item: SnapElement; dialog: string | null };
    const find = (event: Event, fresh: boolean): Hit | null => {
      const path = event.composedPath().filter((n): n is Element => n instanceof Element);
      if (!fresh) {
        for (const el of path) {
          const hit = cache.get(el);
          if (hit) return { el, ...hit };
        }
      }
      let snap: Snapshot;
      try {
        snap = collect();
      } catch {
        return null;
      }
      const byId = new Map(snap.elements.map((e) => [e.id, e]));
      for (const el of path) {
        const item = byId.get(el.getAttribute('data-at-id') ?? '');
        // Choosing a file is not recorded yet: a file input (or the label that opens it) records nothing, as before.
        if (!item || item.kind === 'file') continue;
        const hit = { item, dialog: snap.dialog };
        cache.set(el, hit);
        return { el, ...hit };
      }
      // A click on a dropdown's frame (its arrow icon, the form field around it) opens that dropdown: the smallest
      // container around the click that holds any listed element holds only the dropdown. (A "beyond-select" opens
      // from a click anywhere on its mat-form-field; only the read-only input inside it is listed.)
      for (const el of path) {
        if (el === document.body || el === document.documentElement) break;
        const inside = el.querySelectorAll('[data-at-id]');
        if (!inside.length) continue;
        const item =
          inside.length === 1 ? byId.get(inside[0].getAttribute('data-at-id') ?? '') : undefined;
        if (item?.kind === 'select') return { el: inside[0], item, dialog: snap.dialog };
        break;
      }
      return null;
    };

    // An option of an open dropdown (the same list the `select` step clicks in), its label as the step would quote
    // it: the option's text without icon ligatures ("all_out"), buttons inside it, or text kept for screen readers.
    const optionOf = (event: Event): Element | null => {
      for (const n of event.composedPath()) {
        if (!(n instanceof Element)) continue;
        if (n === document.body) return null;
        if (n.matches(optionSelector)) return n;
      }
      return null;
    };
    const optionLabel = (option: Element) => {
      const copy = option.cloneNode(true) as Element;
      copy
        .querySelectorAll(
          'mat-icon, .material-icons, .material-icons-outlined, .material-symbols-outlined, .material-symbols-rounded, button, .cdk-visually-hidden, .sr-only',
        )
        .forEach((n) => n.remove());
      return (copy.textContent ?? '').replace(/\s+/g, ' ').trim();
    };
    const optionSelected = (option: Element) =>
      option.getAttribute('aria-selected') === 'true' ||
      option.getAttribute('aria-checked') === 'true' ||
      /(^|\s)(active|p-highlight|p-select-option-selected|mdc-list-item--selected)(\s|$)/.test(
        option.className?.toString?.() ?? '',
      ) ||
      !!option.querySelector(
        'input[type="checkbox"]:checked, .mat-pseudo-checkbox-checked, [aria-checked="true"]',
      );
    const optionMultiple = (option: Element) =>
      !!option.closest('[aria-multiselectable="true"]') ||
      !!option.querySelector(
        'input[type="checkbox"], mat-checkbox, mat-pseudo-checkbox, [role="checkbox"]',
      );
    // The panel of an open dropdown: an overlay that lists options (not a dialog, which also renders in an overlay).
    const inOptionPanel = (el: Element) => {
      if (el.closest('dialog, [role="dialog"], [role="alertdialog"], mat-dialog-container'))
        return false;
      const pane = el.closest(
        '.cdk-overlay-pane, .beyond-options-container, .p-overlay, .p-select-overlay, .p-dropdown-panel, .p-multiselect-panel',
      );
      return !!pane && !!pane.querySelector(optionSelector);
    };

    const isTextField = (t: unknown): t is HTMLElement =>
      (t instanceof HTMLInputElement &&
        ![
          'checkbox',
          'radio',
          'file',
          'range',
          'color',
          'hidden',
          'button',
          'submit',
          'reset',
          'image',
        ].includes(t.type)) ||
      t instanceof HTMLTextAreaElement ||
      (t instanceof HTMLElement && t.isContentEditable);
    const isPassword = (t: unknown) => t instanceof HTMLInputElement && t.type === 'password';
    const textOf = (t: HTMLElement) =>
      t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement ? t.value : t.innerText;
    const checkedOf = (el: Element) => {
      const input =
        el instanceof HTMLInputElement
          ? el
          : el.querySelector('input[type="checkbox"], input[type="radio"]');
      return input instanceof HTMLInputElement
        ? input.checked
        : el.getAttribute('aria-checked') === 'true';
    };
    const base = (hit: Hit) => ({
      at: Date.now(),
      url: location.href,
      key: keyOf(hit.el),
      elementId: hit.item.id,
      kind: hit.item.kind,
      element: hit.item,
      dialog: hit.dialog,
      tag: hit.el.tagName.toLowerCase(),
      ...(inOptionPanel(hit.el) ? { inPopup: true } : {}),
    });
    const listen = (type: string, handler: (event: any) => void) =>
      window.addEventListener(
        type,
        (event) => {
          try {
            if (on && event.isTrusted) handler(event);
          } catch {
            // never break the page
          }
        },
        true,
      );

    // Enter in a field makes the browser click the form's default button: that click is the Enter, not a step.
    let enter: { at: number; form: HTMLFormElement | null } | undefined;

    listen('click', (event: MouseEvent) => {
      // Read before the page's own handlers run: whether the option was selected is the state before this click.
      // Only an option in an open dropdown's panel: a list of options on the page itself (a questionnaire's checkbox
      // list built as a selection list) keeps its checks and clicks.
      const option = optionOf(event);
      const label = option && inOptionPanel(option) ? optionLabel(option) : '';
      if (option && /[\p{L}\p{N}]/u.test(label)) {
        const hit = find(event, true);
        return send({
          ...(hit ? base(hit) : { at: Date.now(), url: location.href }),
          type: 'option',
          value: label,
          selected: optionSelected(option),
          multiple: optionMultiple(option),
        });
      }
      const hit = find(event, true);
      if (
        hit &&
        enter &&
        event.detail === 0 &&
        Date.now() - enter.at < 200 &&
        hit.el instanceof HTMLElement &&
        hit.el.matches('button:not([type="button"]):not([type="reset"]), input[type="submit"]') &&
        (hit.el as HTMLButtonElement).form === enter.form
      )
        return;
      if (!hit) return send({ type: 'activity', at: Date.now(), url: location.href });
      if (hit.item.kind === 'checkbox' || hit.item.kind === 'radio') {
        // A native input has already toggled when its click is dispatched. For anything else (a custom checkbox, a
        // hidden input behind a styled host) the page's handlers and the browser's activation behaviour run after this
        // capture listener (a label click is followed by one on its input): read the state they leave.
        if (hit.el instanceof HTMLInputElement) {
          return send({ ...base(hit), type: 'toggle', checked: hit.el.checked });
        }
        setTimeout(() => {
          try {
            send({ ...base(hit), type: 'toggle', checked: checkedOf(hit.el) });
          } catch {
            // the element may be gone
          }
        }, 30);
        return;
      }
      send({ ...base(hit), type: 'click' });
    });

    listen('input', (event: Event) => {
      const target = event.composedPath()[0];
      if (!isTextField(target)) return;
      const hit = find(event, false);
      if (hit?.item.kind !== 'textbox') return;
      const password = isPassword(target);
      send({
        ...base(hit),
        type: 'input',
        isPassword: password,
        value: password ? '' : textOf(target),
      });
    });

    listen('change', (event: Event) => {
      const target = event.composedPath()[0];
      if (target instanceof HTMLSelectElement) {
        const hit = find(event, true);
        if (hit?.item.kind !== 'select') return;
        send({
          ...base(hit),
          type: 'change',
          value: (target.selectedOptions[0]?.label ?? '').replace(/\s+/g, ' ').trim(),
        });
      } else if (isTextField(target)) {
        const hit = find(event, true);
        if (hit?.item.kind !== 'textbox') return;
        const password = isPassword(target);
        send({
          ...base(hit),
          type: 'change',
          isPassword: password,
          value: password ? '' : textOf(target),
        });
      }
    });

    listen('keydown', (event: KeyboardEvent) => {
      if (event.isComposing || event.repeat || event.ctrlKey || event.metaKey || event.altKey)
        return;
      if (event.key === 'Escape') {
        send({ type: 'key', keyName: 'Escape', at: Date.now(), url: location.href });
      } else if (event.key === 'Enter' && !event.shiftKey) {
        // Only Enter in a single-line field submits; elsewhere it activates a control (a click is recorded) or breaks a line.
        const target = event.composedPath()[0];
        if (!(target instanceof HTMLInputElement) || !isTextField(target)) return;
        enter = { at: Date.now(), form: target.form };
        const hit = find(event, true);
        if (hit?.item.kind !== 'textbox') return;
        const password = isPassword(target);
        send({
          ...base(hit),
          type: 'key',
          keyName: 'Enter',
          isPassword: password,
          value: password ? '' : target.value,
        });
      }
    });

    // Address changes: a document that did not come from a link has no referrer; a reload does not either way.
    const navigation = () =>
      (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined)
        ?.type;
    if (document.readyState === 'loading' && !location.href.startsWith('about:')) {
      send({
        type: 'navigate',
        via: 'load',
        at: Date.now(),
        url: location.href,
        navType: navigation(),
        referrer: document.referrer,
      });
    }
    window.addEventListener('popstate', () =>
      send({ type: 'navigate', via: 'popstate', at: Date.now(), url: location.href }),
    );
    window.addEventListener('hashchange', () =>
      send({ type: 'navigate', via: 'hashchange', at: Date.now(), url: location.href }),
    );
  } catch {
    // a page that blocks any of this stays unrecorded rather than broken
  }
}

/** Self-contained browser source for `context.addInitScript({ content })` (and `page.evaluate` in the current document). */
export function recorderInitScript(): string {
  // `recordClickListeners` is idempotent: it only does something when the session has not installed it already.
  return `(() => {
(${recordClickListeners.toString()})(${JSON.stringify(CLICK_LISTENERS)});
(${recorderPage.toString()})(${JSON.stringify(RECORDER_BINDING)}, ${collectElements.toString()}, ${JSON.stringify(OPTION_SELECTOR)});
})();`;
}

// ---------------------------------------------------------------------------------------------------------------
// Step text

const NO_ELEMENT: SnapElement = { id: '', kind: 'button', name: '' };

/** Text inside quotes: no quote (the grammar has no escape), one line, and no `{{` (it would read as a variable). */
const plain = (s: string) =>
  s.replace(/\s+/g, ' ').trim().replace(/"/g, "'").replace(/\{\{/g, '{ {');
export const quoted = (s: string) => `"${plain(s)}"`;

/** The target phrase of an element, and the context it is in (`describe.ts` reuses both for Pick). */
export function targetOf(
  kind: RecordedStep['kind'],
  e: SnapElement,
  dialog: string | null | undefined,
): { target: string; context: string } {
  let name = plain(e.name);
  let section = e.section ?? '';
  const noun = e.tab ? 'tab' : e.kind;
  // An unlabelled control is named by the field it sits in.
  const field = /^field "(.*)"$/.exec(section)?.[1];
  if (!name && field !== undefined) {
    name = plain(field);
    section = '';
  }
  // A required field's marker is not part of what a person reads as its label ("I consent to enrol *").
  if (name.length > 2) name = name.replace(/\s*\*$/, '');
  // A card-like button or link is named by all its text, which can change from day to day ("… Next available
  // appointment Tuesday 03 November 2026"): its first sentence names it (the resolver matches names that contain it).
  if ((e.kind === 'button' || e.kind === 'link') && name.length > 60) {
    const first = /^(.{3,60}?)[.!?](\s|$)/.exec(name)?.[1];
    if (first) name = first;
  }

  let target: string;
  if (e.kind === 'button' || e.kind === 'link') {
    if (name) target = `the ${quoted(name)} ${noun}`;
    else if (e.icon) target = `the ${quoted(e.icon)} icon ${noun}`;
    else if (e.near) target = `the ${noun} next to ${quoted(e.near)}`;
    else target = `the unlabelled ${noun}`;
  } else if (e.kind === 'textbox') {
    target = name ? `the ${quoted(name)} field` : 'the text field';
  } else if (e.kind === 'select') {
    target = name ? `the ${quoted(name)} dropdown` : 'the dropdown';
  } else if (e.kind === 'radio') {
    target = name ? `the ${quoted(name)} radio button` : 'the radio button';
  } else {
    // A checkbox is written the way the format's example does: check "I consent to enrol".
    target = name ? quoted(name) : 'the checkbox';
  }
  void kind;

  return { target, context: contextOf(e, section, dialog) };
}

/** The context phrase of an element (` in the "Booking" dialog`, ` in the row for "Ana"`), or '' when it has none. */
export function contextOf(
  e: SnapElement,
  section: string,
  dialog: string | null | undefined,
): string {
  if (e.row) {
    const cell = Object.values(e.row.cells)
      .map((v) => plain(v))
      .find((v) => /[\p{L}\p{N}]/u.test(v));
    const column = e.row.column ? `the ${quoted(e.row.column)} column of ` : '';
    if (cell)
      return ` in ${column}the row for ${quoted(cell.length > 50 ? cell.slice(0, 50) : cell)}`;
    const table = e.row.table ? ` of the ${quoted(e.row.table)} table` : '';
    return ` in ${column}row ${e.row.number}${table}`;
  }
  let m: RegExpExecArray | null;
  if ((m = /^field "(.*)"$/.exec(section))) return ` in the ${quoted(m[1])} field`;
  if ((m = /^question "(.*)"$/.exec(section))) return ` in the ${quoted(m[1])} question`;
  if ((m = /^navigation "(.*)"$/.exec(section))) return ` in the ${quoted(m[1])} navigation`;
  if (/^page header/.test(section)) return ' in the page header';
  if (section === 'open calendar' || section === 'open pop-up' || section === 'open menu')
    return ` in the ${section}`;
  // The same heading that names the open dialog is the dialog; another one is a section of it.
  const heading = plain(section);
  if (dialog !== null && dialog !== undefined) {
    const title = plain(dialog);
    const of = title ? `the ${quoted(title)} dialog` : 'the dialog';
    if (!heading || heading === title) return ` in ${of}`;
    return ` in the ${quoted(heading)} section of ${of}`;
  }
  return heading ? ` in the ${quoted(heading)} section` : '';
}

/**
 * Grammar-valid step text for an action on a snapshot element, e.g. `click the "Save" button in the "Booking" dialog`.
 * `open` and `press` need no element (pass any); their `value` is the path and the key. `context.dialog` is the title of
 * the dialog the element was in (`SnapElement` does not carry it); without it a dialog's heading reads as a section.
 */
export function stepText(
  kind: RecordedStep['kind'],
  element: SnapElement,
  value?: string,
  context: { dialog?: string | null } = {},
): string {
  if (kind === 'open')
    return `open "${(value ?? '/').replace(/"/g, '%22').replace(/\{\{/g, '%7B%7B')}"`;
  if (kind === 'press') return `press ${quoted(value || 'Enter')}`;
  const { target, context: where } = targetOf(kind, element, context.dialog);
  switch (kind) {
    case 'click':
      return `click ${target}${where}`;
    case 'check':
    case 'uncheck':
      return `${kind} ${target}${where}`;
    case 'select':
      return `select ${quoted(value ?? '') === '""' ? '"(blank)"' : quoted(value ?? '')} in ${target}${where}`;
    case 'fill':
      // The value is the last quoted thing: it may hold quotes, not a line break or a `{{` that reads as a variable.
      return `fill ${target}${where} with "${
        element.secret
          ? '{{PASSWORD}}'
          : (value ?? '').replace(/\s*[\r\n]+\s*/g, ' ').replace(/\{\{/g, '{ {')
      }"`;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Coalescing

type Pending = {
  key: string;
  at: number;
  raw: RawAction;
  value: string;
  dirty: boolean;
};

/** Typed URLs and links: a navigation within this long of the person's last action is that action's effect. */
const ACTION_WINDOW_MS = 1000;
/** Toggle events for the same element within this long are one click (a label click also clicks its input). */
const TOGGLE_DEDUPE_MS = 400;

/**
 * Turns raw actions into steps (section 3.4): a click into a textbox and the input after it are one `fill` with the
 * final value, a change of a native select is one `select`, opening a custom dropdown and clicking one of its options
 * is one `select` (each option picked while it is open is one), a checkbox or radio click is `check`/`uncheck`, Enter in
 * a textbox is `press "Enter"`, a navigation the person typed is `open`. Pure and synchronous, so it is tested without a
 * browser; `Recorder` adds the idle timer that flushes a field the person stopped typing in.
 */
export class StepCoalescer {
  /** The origin `open` paths are relative to; a navigation to another origin is written as a full URL. */
  origin: string | undefined;
  #emit: (step: RecordedStep) => void;
  #pending: Pending | undefined;
  #lastFilled = new Map<string, string>();
  #lastAction = -Infinity;
  #lastAt = 0;
  #lastToggle: { key: string; checked: boolean; at: number } | undefined;
  /**
   * The custom dropdown the person opened, held back until they choose: an option makes it a `select` (the step opens
   * the dropdown itself), anything else makes it the `click` it was. `picked`: a step was written for this opening.
   * `clicks`: after a deselection the options of this opening are written as clicks (see `#option`).
   */
  #open: { raw: RawAction; key: string; picked: boolean; clicks?: boolean } | undefined;

  constructor(emit: (step: RecordedStep) => void) {
    this.#emit = emit;
  }

  push(raw: RawAction): void {
    switch (raw.type) {
      case 'activity':
        this.#lastAction = raw.at;
        return;
      case 'navigate':
        return this.#navigate(raw);
      case 'click':
        return this.#click(raw);
      case 'option':
        return this.#option(raw);
      case 'toggle':
        return this.#toggle(raw);
      case 'input':
        return this.#input(raw, false);
      case 'change':
        if (raw.kind === 'select') return this.#select(raw);
        if (raw.kind === 'textbox') return this.#input(raw, true);
        return;
      case 'key':
        return this.#key(raw);
      default:
        return;
    }
  }

  /** Emits the field the person typed in, if any. */
  flush(): void {
    const p = this.#pending;
    if (!p) return;
    this.#pending = undefined;
    if (!p.dirty) return;
    this.#lastFilled.set(p.key, p.value);
    const secret = p.raw.isPassword || p.raw.element?.secret;
    this.#step(p.raw, 'fill', p.at, secret ? undefined : p.value, secret);
  }

  /** Emits everything in progress, also a dropdown opened and left open (the recording stops). */
  finish(): void {
    this.flush();
    this.#settleOpen();
  }

  /** Forgets what is in progress (the recording was cleared). */
  reset(): void {
    this.#pending = undefined;
    this.#lastFilled.clear();
    this.#lastToggle = undefined;
    this.#open = undefined;
  }

  /** The held dropdown click is a step after all when no option was chosen from it (something else came next). */
  #settleOpen() {
    const open = this.#open;
    this.#open = undefined;
    if (open && !open.picked) this.#step(open.raw, 'click', open.raw.at);
  }

  /** Typing or clicking in the search field of the open dropdown's panel: the `select` step searches by itself. */
  #inOpenPanel(raw: RawAction) {
    return !!this.#open && !!raw.inPopup && raw.kind === 'textbox';
  }

  #keyOf(raw: RawAction) {
    return String(raw.key ?? raw.elementId ?? '');
  }

  #touch(raw: RawAction) {
    this.#lastAction = raw.at;
  }

  #click(raw: RawAction) {
    this.#touch(raw);
    if (!raw.element) return;
    if (this.#inOpenPanel(raw)) return;
    if (raw.kind === 'select' && raw.tag !== 'select') {
      // A custom dropdown: opening it is not a step yet, choosing in it is (`option`). A second click on the same one
      // closes it.
      this.flush();
      const key = this.#keyOf(raw);
      if (this.#open?.key === key) {
        this.#open = undefined;
        return;
      }
      this.#settleOpen();
      this.#open = { raw, key, picked: false };
      return;
    }
    this.#settleOpen();
    if (raw.kind === 'textbox') {
      // Focus only: the step comes with the typing.
      if (this.#pending && this.#pending.key !== this.#keyOf(raw)) this.flush();
      if (!this.#pending)
        this.#pending = { key: this.#keyOf(raw), at: raw.at, raw, value: '', dirty: false };
      return;
    }
    this.flush();
    // Opening a native dropdown is not a step; choosing in it is (`change`).
    if (raw.kind === 'select' && raw.tag === 'select') return;
    this.#step(raw, 'click', raw.at);
  }

  #option(raw: RawAction) {
    const open = this.#open;
    if (!open) {
      // An option of a list nobody was seen opening (an autocomplete's suggestions, a list open before recording):
      // a click on it, when the page lists it.
      if (raw.element) return this.#click({ ...raw, type: 'click' });
      this.#touch(raw);
      return;
    }
    this.#touch(raw);
    this.flush();
    const value = raw.value?.trim();
    if (!value) return;
    if (open.clicks || (raw.multiple && raw.selected)) {
      // Deselecting in a multi-select: the grammar has no step for it, and a `select` would read as choosing. Write
      // what the person did: open the dropdown (again, when a `select` already closed it on replay) and click the
      // option. The rest of this opening is clicks too, in the dropdown those steps left open.
      if (!open.clicks) this.#step(open.raw, 'click', open.raw.at);
      open.picked = true;
      open.clicks = true;
      const option: SnapElement = raw.element ?? {
        id: '',
        kind: 'button',
        name: value,
        section: 'open pop-up',
      };
      this.#step({ ...raw, element: option }, 'click', raw.at);
      return;
    }
    open.picked = true;
    this.#step({ ...open.raw, url: raw.url ?? open.raw.url }, 'select', raw.at, value);
  }

  #toggle(raw: RawAction) {
    this.#touch(raw);
    this.flush();
    this.#settleOpen();
    if (!raw.element || raw.checked === undefined) return;
    const key = this.#keyOf(raw);
    const last = this.#lastToggle;
    this.#lastToggle = { key, checked: raw.checked, at: raw.at };
    if (
      last &&
      last.key === key &&
      last.checked === raw.checked &&
      raw.at - last.at < TOGGLE_DEDUPE_MS
    )
      return;
    if (raw.checked) this.#step(raw, 'check', raw.at);
    else if (raw.kind === 'checkbox') this.#step(raw, 'uncheck', raw.at);
  }

  #input(raw: RawAction, commit: boolean) {
    this.#touch(raw);
    if (!raw.element) return;
    if (this.#inOpenPanel(raw)) return;
    const key = this.#keyOf(raw);
    if (this.#pending && this.#pending.key !== key) this.flush();
    const value = raw.value ?? '';
    if (commit && !this.#pending?.dirty && this.#lastFilled.get(key) === value) return; // Enter's change after its fill
    const p = this.#pending ?? { key, at: raw.at, raw, value, dirty: false };
    this.#pending = p;
    if (value !== p.value || !p.dirty) {
      p.raw = raw;
      p.value = value;
      // A click into a field then a change to the very same value (nothing typed) is not a step.
      p.dirty = commit ? value !== (this.#lastFilled.get(key) ?? '') || p.dirty : true;
    }
    if (commit) this.flush();
  }

  #select(raw: RawAction) {
    this.#touch(raw);
    this.flush();
    this.#settleOpen();
    if (!raw.element || !raw.value?.trim()) return; // choosing the blank option is not a step
    this.#step(raw, 'select', raw.at, raw.value);
  }

  #key(raw: RawAction) {
    this.#touch(raw);
    if (this.#open) {
      // Escape closes the open dropdown (the `select` step closes it by itself); Enter in its search field is its own.
      if (raw.keyName === 'Escape') {
        this.flush();
        this.#open = undefined;
        return;
      }
      if (this.#inOpenPanel(raw)) return;
    }
    this.flush();
    this.#settleOpen();
    if (raw.keyName === 'Enter' || raw.keyName === 'Escape')
      this.#step(raw, 'press', raw.at, raw.keyName);
  }

  #navigate(raw: RawAction) {
    this.flush();
    this.#settleOpen();
    this.#lastFilled.clear();
    this.#lastToggle = undefined;
    if (!raw.url) return;
    const justActed = raw.at - this.#lastAction < ACTION_WINDOW_MS;
    const typed =
      raw.via === 'load'
        ? raw.navType === 'reload' || (raw.navType !== 'back_forward' && !raw.referrer)
        : true;
    if (typed && !justActed) {
      let path = raw.url;
      try {
        const url = new URL(raw.url);
        this.origin ??= url.origin;
        if (url.origin === this.origin) path = url.pathname + url.search + url.hash;
      } catch {
        // keep the URL as it is
      }
      this.#step(raw, 'open', raw.at, path);
    }
  }

  #step(
    raw: RawAction,
    kind: RecordedStep['kind'],
    at: number,
    value?: string,
    secret?: boolean,
  ): void {
    const element = raw.element ?? NO_ELEMENT;
    this.#lastAt = Math.max(at, this.#lastAt + 1);
    const step: RecordedStep = {
      at: this.#lastAt,
      kind,
      text: stepText(kind, element, value, { dialog: raw.dialog }),
    };
    if (kind !== 'open' && kind !== 'press' && raw.element) {
      step.elementId = raw.element.id;
      const { value: _current, ...rest } = raw.element;
      step.description = describe(rest);
    }
    if (value !== undefined && !secret) step.value = value;
    if (secret) step.secret = true;
    if (raw.url) step.url = raw.url;
    this.#emit(step);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The recorder

/** Idle time after which a field the person typed in becomes a step even if it was not left (no `change` yet). */
const IDLE_FLUSH_MS = 1500;

type Slot = { target: Recorder | null };
/** A page can expose a binding and add an init script once; recorders take turns on it. */
const installed = new WeakMap<Page, Slot>();

export class Recorder {
  #page: Page;
  #onStep: (step: RecordedStep) => void;
  #steps: RecordedStep[] = [];
  #coalescer: StepCoalescer;
  #active = false;
  #idle: ReturnType<typeof setTimeout> | undefined;

  constructor(page: Page, onStep: (step: RecordedStep) => void) {
    this.#page = page;
    this.#onStep = onStep;
    this.#coalescer = new StepCoalescer((step) => {
      this.#steps.push(step);
      this.#onStep(step);
    });
  }

  async start(): Promise<void> {
    if (this.#active) return;
    const page = this.#page;
    let slot = installed.get(page);
    if (!slot) {
      slot = { target: null };
      const mine = slot;
      await page.exposeBinding(RECORDER_BINDING, (_source, raw: RawAction) => {
        const recorder = mine.target;
        if (!recorder) return false;
        if (raw?.type === 'hello') return recorder.#active;
        recorder.#receive(raw);
        return undefined;
      });
      await page.addInitScript({ content: recorderInitScript() });
      installed.set(page, slot);
    }
    slot.target = this;
    this.#active = true;
    try {
      this.#coalescer.origin = new URL(page.url()).origin;
      if (this.#coalescer.origin === 'null') this.#coalescer.origin = undefined;
    } catch {
      this.#coalescer.origin = undefined;
    }
    // Init scripts only apply to documents loaded from now on.
    await page.evaluate(
      `${recorderInitScript()}; window.__intentRecorder && window.__intentRecorder.setOn(true);`,
    );
  }

  async stop(): Promise<void> {
    if (!this.#active) return;
    clearTimeout(this.#idle);
    this.#coalescer.finish();
    this.#active = false;
    const slot = installed.get(this.#page);
    if (slot?.target === this) slot.target = null;
    // Quiet the current document; later ones ask (`hello`) and hear that nobody is recording.
    await this.#page
      .evaluate(`window.__intentRecorder && window.__intentRecorder.setOn(false)`)
      .catch(() => undefined);
  }

  steps(): RecordedStep[] {
    return [...this.#steps];
  }

  clear(): void {
    clearTimeout(this.#idle);
    this.#steps = [];
    this.#coalescer.reset();
  }

  #receive(raw: RawAction): void {
    if (!this.#active || !raw || typeof raw !== 'object') return;
    try {
      this.#coalescer.push(raw);
    } catch {
      // a malformed action from the page is dropped, never thrown back into it
    }
    clearTimeout(this.#idle);
    if (raw.type === 'input') {
      this.#idle = setTimeout(() => this.#coalescer.flush(), IDLE_FLUSH_MS);
      this.#idle.unref?.();
    }
  }
}
