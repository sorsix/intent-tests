// Turns the live page into a compact, model-friendly description.
// Elements get a data-at-id attribute so Playwright can act on the one the decision model picks.
import type { Page } from '@playwright/test';
import { describeColour, parseCssColour } from './colour.ts';
import { formatOutline, type OutlineBlock } from './outline.ts';

/** `draggable` and `slot` (an element that accepts drops) are offered only by a drag snapshot (`snapshot(page, { drag: true })`). */
export type ElementKind =
  | 'button'
  | 'link'
  | 'textbox'
  | 'select'
  | 'checkbox'
  | 'radio'
  | 'draggable'
  | 'slot'
  /** A file input, or the label that opens a hidden one: only `upload` steps are offered these. */
  | 'file';

export type SnapElement = {
  id: string;
  kind: ElementKind;
  name: string;
  placeholder?: string;
  value?: string;
  checked?: boolean;
  disabled?: boolean;
  /** A pressed toggle button or selected chip / option-like button. */
  selected?: boolean;
  /** A button with role="tab": described as a tab, which is what the page shows and how tests name it. */
  tab?: boolean;
  /** Icon of an unlabelled icon-only button or link, e.g. "eye". */
  icon?: string;
  /** A named button or link that shows only an icon: its name is in aria-label / title, not on screen. */
  iconOnly?: boolean;
  /** For an unlabelled button or link: the short text right before it, e.g. "Additional details" for its edit icon. */
  near?: string;
  /** Password field: values typed into it are masked in the report. */
  secret?: boolean;
  /** Nearest heading / landmark label (dialog title, nav label, form heading…). */
  section?: string;
  /** Present when the element sits in a table row. Row numbers start at 1 for the first visible row. `column` is the
   *  header of the cell the element is in, when it isn't the row's actions cell. */
  row?: { table: string; number: number; cells: Record<string, string>; column?: string };
  /** Drag snapshots only: an offered element that can be dragged (`draggable="true"`). */
  draggable?: boolean;
  /** Drag snapshots only: an offered element that accepts drops (a `drop` listener or `ondrop`). */
  drop?: boolean;
};

export type Snapshot = {
  url: string;
  title: string;
  /** Title of the open modal dialog, if any. Only elements inside it are listed then. */
  dialog: string | null;
  headings: string[];
  elements: SnapElement[];
};

export type PageText = {
  url: string;
  title: string;
  dialog: { title: string; text: string } | null;
  /** Visible tables (not screen-reader-only ones); `section` is the heading path above it, e.g. "Studies › Per hour". */
  tables: { caption: string; section?: string; rows: Record<string, string>[] }[];
  fields: { label: string; value: string }[];
  /** Buttons and links: per table row (icon-only actions are named by their tooltip), and the rest of the page. */
  actions: {
    rows: { table: string; row: number; cells: Record<string, string>; actions: string[] }[];
    other: string[];
  };
  /** Visible text in reading order, headings and named sections as "#" lines (outline.ts). */
  visibleText: string;
};

type CollectedText = Omit<PageText, 'fields' | 'actions' | 'dialog' | 'visibleText'> & {
  dialog: { title: string; blocks: OutlineBlock[] } | null;
  blocks: OutlineBlock[];
  /** Only with `selection: true`: the main frame's selected text and the dialog or heading it sits under. */
  selection?: PageSelection;
};

/** The text selected in the page, as `pageSelection` returns it. */
export type PageSelection = { text: string; scope?: string };

/**
 * Options of an opened custom dropdown (ARIA options, Angular Material, rows of a CDK overlay panel). The `select` step
 * clicks one of these, and the recorder turns a click on one into that `select` step: keep both on this one list.
 */
// Some select components (e.g. a "beyond-select") list their options as plain buttons in an overlay panel (app-specific;
// may move to project config).
export const OPTION_SELECTOR =
  '[role="option"], mat-option, .cdk-overlay-pane [role="listitem"], .beyond-options-container button:not([aria-label="Sort"])';

// Runs in the browser. Must be self-contained (no closures over Node-side values).
// Where recordClickListeners keeps its lookup on window; collectElements reads it.
export const CLICK_LISTENERS = 'intent-engine.click-listeners';
/** Where the same init script keeps its lookup of elements with a `drop` listener (drop slots for `drag`). */
export const DROP_LISTENERS = `${CLICK_LISTENERS}:drop`;

/**
 * Init script (BrowserContext.addInitScript): remembers which elements get a click listener, so the snapshot can offer
 * elements that are clickable only through a script handler. Angular's (click) on a plain <div> (e.g. dashboard
 * cards) leaves nothing in the DOM, and pages can't list an element's listeners. Kept in a WeakMap, not in attributes:
 * the app's DOM is not touched while it renders. Zone.js wraps addEventListener after this runs and registers one
 * callback per element and event type, which still reaches this wrapper. `drop` listeners are kept apart, at
 * `${key}:drop` (DROP_LISTENERS): only a drag snapshot reads them, so drop slots never become click candidates.
 */
export function recordClickListeners(key: string) {
  const w = window as unknown as Record<string, unknown>;
  if (w[key]) return;
  const listeners = new WeakMap<EventTarget, Set<unknown>>();
  const drops = new WeakMap<EventTarget, Set<unknown>>();
  const proto = EventTarget.prototype;
  const add = proto.addEventListener;
  const remove = proto.removeEventListener;
  proto.addEventListener = function (
    this: EventTarget,
    type: string,
    fn: EventListenerOrEventListenerObject | null,
    opts?: boolean | AddEventListenerOptions,
  ) {
    if ((type === 'click' || type === 'drop') && fn && this instanceof Element) {
      const map = type === 'click' ? listeners : drops;
      let set = map.get(this);
      if (!set) map.set(this, (set = new Set()));
      set.add(fn);
    }
    return add.call(this, type, fn, opts);
  };
  proto.removeEventListener = function (
    this: EventTarget,
    type: string,
    fn: EventListenerOrEventListenerObject | null,
    opts?: boolean | EventListenerOptions,
  ) {
    if (type === 'click' && fn) listeners.get(this)?.delete(fn);
    if (type === 'drop' && fn) drops.get(this)?.delete(fn);
    return remove.call(this, type, fn, opts);
  };
  Object.defineProperty(w, key, { value: (el: Element) => (listeners.get(el)?.size ?? 0) > 0 });
  Object.defineProperty(w, `${key}:drop`, {
    value: (el: Element) => (drops.get(el)?.size ?? 0) > 0,
  });
}

/**
 * `drag`: also offer draggable elements (`draggable="true"`) and drop slots (elements with a `drop` listener), for the
 * drag step only. Without it the snapshot is exactly the one every other step uses.
 */
export function collectElements(opts?: { drag?: boolean }): Snapshot {
  const clean = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim();
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    return (
      r.width > 0 &&
      r.height > 0 &&
      (el as HTMLElement).checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
    );
  };
  // Styled checkboxes/radios (Material, Bootstrap…) hide the native input with opacity: 0 and draw their own.
  const shown = (el: Element) => {
    const t = el.tagName === 'INPUT' && (el as HTMLInputElement).type;
    if (t !== 'checkbox' && t !== 'radio') return visible(el);
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && el.checkVisibility({ checkVisibilityCSS: true });
  };
  // querySelectorAll that also descends into open shadow roots (web components render their content there).
  const queryAll = (root: ParentNode, sel: string): Element[] => {
    const out: Element[] = [];
    const walk = (node: ParentNode | null) => {
      // The page can change the DOM while this runs (a consent page that redirects to registration left a null node
      // and a null `children`): walk a copy and skip what's gone rather than fail the whole snapshot.
      if (!node) return;
      for (const child of Array.from(node.children ?? [])) {
        if (!child) continue;
        if (child.matches(sel)) out.push(child);
        if (child.shadowRoot) walk(child.shadowRoot);
        walk(child);
      }
    };
    walk(root);
    return out;
  };
  // closest() that continues from a shadow root to its host: grids that render each cell's HTML template in a shadow
  // root (e.g. a <shadow-template>) put the cell's buttons there, below the light-DOM <td> and <tr>.
  const acrossShadows = (el: Element, sel: string): Element | null => {
    for (let e: Element | null = el; e;) {
      const hit = e.closest(sel);
      if (hit) return hit;
      const root = e.getRootNode();
      e = root instanceof ShadowRoot ? root.host : null;
    }
    return null;
  };
  // A cell's text, its shadow roots included; a cell showing only images or icon buttons (a green tick for "Is Custom",
  // a grey circle that marks a letter as sent) is described by their names instead of reading as empty.
  const cellText = (td: Element): string => {
    const text = clean(
      [
        (td as HTMLElement).innerText,
        ...queryAll(td, '*')
          .filter((e) => e.shadowRoot)
          .map((h) =>
            [...h.shadowRoot!.children]
              .filter((c) => !c.matches('style, script, link, template'))
              .map((c) => (c as HTMLElement).innerText ?? '')
              .join(' '),
          ),
      ].join(' '),
    );
    return text || iconText(td);
  };
  const iconText = (td: Element): string => {
    const names: string[] = [];
    for (const e of queryAll(
      td,
      'img[alt], [role="img"][aria-label], button[aria-label], [role="button"][aria-label]',
    )) {
      if (!visible(e) && !(e.tagName !== 'IMG' && queryAll(e, 'img').some(visible))) continue;
      const button = e.matches('button, [role="button"]');
      // An image inside a named button is the button's picture, not a second thing in the cell.
      if (
        !button &&
        acrossShadows(
          e.parentElement ?? e,
          'button[aria-label], [role="button"][aria-label]',
        )?.getAttribute('aria-label')
      )
        continue;
      const name = clean(e.getAttribute(e.tagName === 'IMG' ? 'alt' : 'aria-label'));
      if (name) names.push(`${button ? 'button' : 'image'} "${name}"`);
    }
    return names.join(', ');
  };

  // An element with its own click handler (recordClickListeners, or an onclick property / attribute). The key is
  // repeated here: this function runs in the page and can't see module constants.
  const hasClickListener = (
    window as unknown as Record<string, ((el: Element) => boolean) | undefined>
  )['intent-engine.click-listeners'];
  const listens = (el: Element) =>
    el !== document.body &&
    el !== document.documentElement &&
    (!!hasClickListener?.(el) || (el as HTMLElement).onclick != null);

  queryAll(document, '[data-at-id], [data-at-dialog]').forEach((e) => {
    e.removeAttribute('data-at-id');
    e.removeAttribute('data-at-dialog');
  });

  // Modal if it says so, if it covers (nearly) the whole viewport itself, or if an empty full-screen layer (a backdrop)
  // covers the page around it. Angular Material dialogs use aria-modal="false" plus a backdrop, so the attribute alone
  // isn't enough; a full-screen one (e.g. "Enrol and book appointment") has no page around it to find a backdrop on.
  const saysModal = (d: Element) => d.getAttribute('aria-modal') === 'true' || d.matches(':modal');
  const coversViewport = (d: Element) => {
    const box = d.getBoundingClientRect();
    return box.width >= window.innerWidth * 0.9 && box.height >= window.innerHeight * 0.9;
  };
  const isModal = (d: Element) => {
    if (saysModal(d) || coversViewport(d)) return true;
    const w = window.innerWidth,
      h = window.innerHeight;
    return [
      [2, 2],
      [w - 3, 2],
      [2, h - 3],
      [w - 3, h - 3],
    ].some(([x, y]) => {
      const hit = document.elementFromPoint(x, y);
      if (!hit || d.contains(hit) || hit === document.body || hit === document.documentElement)
        return false;
      const r = hit.getBoundingClientRect();
      return (
        r.width >= w * 0.9 &&
        r.height >= h * 0.9 &&
        (hit.childElementCount === 0 || hit.contains(d))
      );
    });
  };
  const dialogs = queryAll(document, 'dialog[open], [role="dialog"], [role="alertdialog"]').filter(
    (d) => visible(d) && isModal(d),
  );
  const dialog = dialogs[dialogs.length - 1] || null;
  // collectText reads the same dialog, marked with its name further down. A full-screen dialog that doesn't say it is
  // modal reads as a page (e.g. a participant details view): only its elements can be clicked, but for an `expect` it is not
  // "a dialog that is open" (AS-07: "no dialog is open" once a confirmation over it had closed).
  const pageDialog = dialog && !saysModal(dialog) && coversViewport(dialog) ? dialog : null;
  // A menu, a date picker's calendar or an autocomplete's suggestions opened from a dialog (the participant details
  // "more" menu, the "Manage Deferral" date, a postcode search) render in an overlay outside it; while it's open it's
  // what can be clicked, so it's the root then. Only an overlay with controls counts (not a tooltip), and only one opened
  // after the dialog (not the dialog's own pane).
  const popup = dialog
    ? queryAll(document, '[role="menu"], .cdk-overlay-pane')
        .filter(
          (m) =>
            visible(m) &&
            !dialog.contains(m) &&
            !m.contains(dialog) &&
            !!(dialog.compareDocumentPosition(m) & Node.DOCUMENT_POSITION_FOLLOWING) &&
            // (the date picker's arrows and days are divs with a tabindex; autocomplete options have tabindex="-1")
            !!m.querySelector(
              'button, a[href], [role="button"], [role="menuitem"], [role="option"], [role="gridcell"], [tabindex]:not([tabindex="-1"])',
            ),
        )
        .pop()
    : null;
  const root = popup || dialog || document.body;

  const headingOf = (container: Element | null) => {
    if (!container) return '';
    const labelledBy = container.getAttribute('aria-labelledby');
    if (labelledBy) return clean(document.getElementById(labelledBy)?.textContent);
    if (container.getAttribute('aria-label')) return clean(container.getAttribute('aria-label'));
    const h = container.querySelector('h1, h2, h3, legend, caption');
    return h ? clean(h.textContent) : '';
  };

  const labelOf = (el: Element) => {
    const labelledBy = (el.getAttribute('aria-labelledby') || '')
      .split(/\s+/)
      .map((id) => id && document.getElementById(id))
      .filter(Boolean) as Element[];
    // A label elsewhere on the page wins over aria-label, as in the ARIA spec (e.g. a p-select with aria-label
    // "Select Type", its placeholder, and aria-labelledby pointing at the field's real label).
    const external = clean(
      labelledBy
        .filter((l) => !el.contains(l))
        .map((l) => l.textContent)
        .join(' '),
    );
    if (external) return external;
    const aria = el.getAttribute('aria-label');
    // Skip template leftovers like "undefined, date picker" so a real <label> can win.
    if (aria && !/\b(undefined|null)\b/.test(aria)) return clean(aria);
    // Can be empty, e.g. a mat-select labelled by its own (unselected) value.
    const byIds = clean(labelledBy.map((l) => l.textContent).join(' '));
    if (byIds) return byIds;
    const labels = (el as HTMLInputElement).labels;
    if (labels && labels.length) return clean([...labels].map((l) => l.textContent).join(' '));
    // Custom form controls: <label for="x"> often points at the component host (<my-select id="x">), not the inner input.
    for (let a = el.parentElement, depth = 0; a && depth < 6; a = a.parentElement, depth++) {
      if (!a.id) continue;
      const label = (a.getRootNode() as ParentNode).querySelector(
        `label[for="${CSS.escape(a.id)}"]`,
      );
      if (label) return clean(label.textContent);
    }
    return '';
  };

  // A field captioned by plain text just before it (<p>Resources</p><my-select>), with no <label> involved.
  const captionOf = (el: Element) => {
    for (let a: Element | null = el, depth = 0; a && depth < 8; a = a.parentElement, depth++) {
      for (let prev = a.previousElementSibling; prev; prev = prev.previousElementSibling) {
        if (
          /^(H[1-6]|LEGEND)$/.test(prev.tagName) ||
          prev.matches(controls) ||
          prev.querySelector(controls)
        )
          return '';
        const text = clean((prev as HTMLElement).innerText);
        if (!text) continue;
        return text.length <= 60 ? text : '';
      }
    }
    return '';
  };

  // What tells look-alike icon buttons apart (a participant details view: "Personal details ✎", "Contact details ✎",
  // "Additional details ✎"): the short text right before the button, from its previous siblings, a few levels up.
  const nearText = (el: Element) => {
    for (
      let a: Element | null = el, depth = 0;
      a && a !== document.body && depth < 4;
      a = a.parentElement, depth++
    ) {
      for (let p = a.previousElementSibling, k = 0; p && k < 3; p = p.previousElementSibling, k++) {
        if (!visible(p)) continue;
        const t = clean((p as HTMLElement).innerText);
        if (!t) continue;
        return /\p{L}/u.test(t) && t.length <= 40 ? t : '';
      }
    }
    return '';
  };

  // Icon-only controls: name the icon from its font-icon attribute, Material ligature or icon class.
  const iconOf = (el: Element) => {
    const i = el.querySelector('[fonticon], [svgicon], mat-icon, i[class], [class*="icon"]');
    if (!i) return '';
    const attr = i.getAttribute('fonticon') || i.getAttribute('svgicon');
    if (attr) return attr.replace(/[_-]+/g, ' ');
    if (
      (i.tagName === 'MAT-ICON' ||
        /\bmaterial-(icons|symbols)/.test(i.getAttribute('class') || '')) &&
      clean(i.textContent)
    )
      return clean(i.textContent).replace(/_/g, ' ');
    const m = (i.getAttribute('class') || '').match(
      /(?:^|\s)(?:pi|fa|bi|icon)[-_](?!solid|regular|light|brands|fw|lg|button)([a-z0-9_-]+)/i,
    );
    return m ? m[1].replace(/[_-]+/g, ' ') : '';
  };

  // The text a control shows besides its icons (an icon font's ligature, like "help_outline", isn't shown as words).
  const shownText = (el: Element) => {
    let text = clean((el as HTMLElement).innerText);
    for (const i of el.querySelectorAll(
      '[fonticon], [svgicon], mat-icon, p-icon, .material-icons, .material-icons-outlined, .material-symbols-outlined, .material-symbols-rounded, [aria-hidden="true"]',
    )) {
      const t = clean(i.textContent);
      if (t) text = clean(text.replace(t, ''));
    }
    return /[\p{L}\p{N}]/u.test(text);
  };

  // The icon a nameless click target shows, read from the target itself or its first icon: the font-icon attribute,
  // the icon_<name> class a component library's p-icon adds for its fontIcon (also when bound), or a Material ligature. App
  // classes like "icon-not-attached" on the same element would name it wrongly, so iconOf's class pattern is only the
  // last resort, for what the target contains.
  const shownIcon = (el: Element) => {
    const inner = el.querySelector(
      '[fonticon], [svgicon], mat-icon, .p-icon, .material-icons, .material-icons-outlined, .material-symbols-outlined, .material-symbols-rounded',
    );
    for (const i of [el, inner]) {
      if (!i) continue;
      const attr = i.getAttribute('fonticon') || i.getAttribute('svgicon');
      if (attr) return attr.replace(/[_-]+/g, ' ');
      const own = (i.getAttribute('class') || '').match(/(?:^|\s)icon_([a-z0-9_-]+)/i);
      if (own) return own[1].replace(/[_-]+/g, ' ');
      if (
        (i.tagName === 'MAT-ICON' ||
          /\bmaterial-(icons|symbols)/.test(i.getAttribute('class') || '')) &&
        clean(i.textContent)
      )
        return clean(i.textContent).replace(/_/g, ' ');
    }
    return iconOf(el);
  };
  // Icon-sized: a nameless (click) card or backdrop that happens to hold an icon is not that icon.
  const iconSized = (el: Element) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.width <= 64 && r.height <= 64;
  };
  // Part of another click target: one inside it (<div (click)><p-icon (click)/></div> offers the inner icon), or a
  // named one around it, up to three levels and barely larger (a "Mark as DNA" button whose glyph has its own
  // handler). A row or card with its own click handler is much larger than its icons, which stay separate actions.
  const partOfClickTarget = (el: Element) => {
    if ([...el.querySelectorAll('*')].some((d) => listens(d))) return true;
    const r = el.getBoundingClientRect();
    let a = el.parentElement;
    for (let depth = 0; a && depth < 3; a = a.parentElement, depth++) {
      if (!listens(a) && !a.matches('[data-action], .clickable, [tabindex]')) continue;
      const p = a.getBoundingClientRect();
      if (p.width * p.height <= 4 * r.width * r.height && (shownText(a) || labelOf(a))) return true;
    }
    return false;
  };

  // The field a widget belongs to: <label>Date</label><div>…calendar…</div>, even when the label's `for` is broken.
  const fieldOf = (el: Element) => {
    for (let a: Element | null = el, depth = 0; a && depth < 10; a = a.parentElement, depth++) {
      const prev = a.previousElementSibling;
      if (prev?.tagName !== 'LABEL' || prev.querySelector(controls)) continue;
      const text = clean(prev.textContent);
      return text.length <= 60 ? text : '';
    }
    return '';
  };

  // The label of a small field group around a control that has none of its own, e.g. a filter
  // <date-filter><mat-label>Day</mat-label>…<input>…<mat-icon>close</mat-icon></date-filter>.
  const groupLabelOf = (el: Element) => {
    for (let a = el.parentElement, depth = 0; a && depth < 5; a = a.parentElement, depth++) {
      if (a.querySelectorAll(controls).length > 4) break; // grown past the control's own small group
      // A label that comes before the control, holds no controls and isn't an empty <label for> of a toggle.
      const lab = [...a.querySelectorAll('mat-label, label')].find(
        (l) =>
          !l.contains(el) &&
          !l.querySelector(controls) &&
          clean(l.textContent) &&
          l.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING,
      );
      if (!lab) continue;
      const text = clean(lab.textContent);
      return text.length <= 60 ? text : '';
    }
    return '';
  };

  // A dialog is named by its own label (aria-labelledby / aria-label); else, when a tab list comes before any heading,
  // by its tab if it has only one (some questionnaire dialogs show their title as a single tab: "General Note",
  // "Treatment details", "Participant alerts") and untitled if it has several (participant details: "Episodes" named
  // only the selected tab); else by its first heading, but only when that heading comes before the dialog's content: a
  // heading after a form field or a table titles a part of the dialog ("Add biopsy" keeps its <h2>). Nesting depth
  // would not do: frameworks wrap a title in a varying number of elements.
  const dialogName = (d: Element) => {
    const by = d.getAttribute('aria-labelledby');
    if (by)
      return clean(
        by
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent ?? '')
          .join(' '),
      );
    if (d.getAttribute('aria-label')) return clean(d.getAttribute('aria-label'));
    const precedes = (a: Element, b: Element) =>
      !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    const heading = [...d.querySelectorAll('h1, h2, h3')].find(
      (h) => visible(h) && /\p{L}/u.test(h.textContent ?? ''),
    );
    const tablist = [...d.querySelectorAll('[role="tablist"]')].find(visible);
    if (tablist && (!heading || precedes(tablist, heading))) {
      const tabs = [...tablist.querySelectorAll('[role="tab"]')].filter(visible);
      return tabs.length === 1 ? clean(tabs[0].textContent) : '';
    }
    if (!heading) return '';
    const content =
      '[role="tablist"], input:not([type="hidden"]), select, textarea, [role="checkbox"], [role="radio"], [role="combobox"], [role="listbox"], table, [role="grid"]';
    const before = [...d.querySelectorAll(content)].some(
      (c) => visible(c) && !c.contains(heading) && precedes(c, heading),
    );
    return before ? '' : clean(heading.textContent);
  };
  const dialogTitle = dialog ? dialogName(dialog) : null;

  // The nearest heading above the element: one <form> often spans several titled sections, and its first
  // section's title may sit just outside it.
  // A <details> is titled by its <summary>, which often holds the section's own actions too (e.g. health questions:
  // <summary><div>Family history of breast cancer</div><button>+ Add</button><button>Archive</button></summary>):
  // its title is its visible text without them and without icon ligatures.
  const summaryTitle = (s: Element) => {
    const parts: string[] = [];
    const walk = (n: Node) => {
      for (const c of n.childNodes) {
        if (c.nodeType === Node.TEXT_NODE) parts.push(c.textContent ?? '');
        else if (
          c instanceof Element &&
          !c.matches(
            'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="checkbox"], [role="switch"], [tabindex], mat-icon, .material-icons, .material-icons-outlined, .material-symbols-outlined, .material-symbols-rounded, [aria-hidden="true"]',
          ) &&
          ((c as HTMLElement).checkVisibility({ checkVisibilityCSS: true }) ||
            getComputedStyle(c).display === 'contents')
        )
          walk(c);
      }
    };
    walk(s);
    const title = clean(parts.join(' '));
    return title.length <= 200 ? title : title.slice(0, 199) + '…';
  };
  const headingText = (h: Element) =>
    h.tagName === 'SUMMARY' ? summaryTitle(h) : clean(h.textContent);
  // Headings without letters are counters (dashboard tiles marked up as <h2>0</h2>), not section names.
  const sectionHeadings = queryAll(document, 'h1, h2, h3, h4, legend, details > summary').filter(
    (h) => visible(h) && /\p{L}/u.test(headingText(h)),
  );
  // What an element's section is looked up in. A <details> inside a dialog, form or section is the nearer one: its
  // summary titles it even when the dialog has a label of its own. Navigation and page headers keep their own naming.
  const containerOf = (el: Element) => {
    const c = el.closest(
      'dialog, nav, form, section, header, [role="dialog"], [role="navigation"]',
    );
    const details = el.closest('details');
    if (!details) return c;
    if (!c) return details;
    if (c.matches('nav, header, [role="navigation"]') || !c.contains(details)) return c;
    return details;
  };
  const sectionOf = (container: Element, el: Element) => {
    if (container.getAttribute('aria-labelledby') || container.getAttribute('aria-label'))
      return headingOf(container);
    // Inside a dialog or side panel (modal or not) only its own headings count: the page behind has headings too.
    // A panel without headings gives no section rather than an unrelated heading from the page.
    const panel = el.closest(
      'dialog[open], [role="dialog"], [role="alertdialog"], mat-dialog-container, mat-drawer, mat-sidenav, aside, [role="complementary"]',
    );
    const scope = dialog && dialog.contains(el) ? dialog : panel;
    // A heading whose own block (heading + table, list or its own fields) has ended before the element doesn't name
    // it, e.g. a dialog's Submit below an embedded "Worklist presence" table or a "Yes / No" question section.
    // Likewise a heading that titles a form ending before the element, e.g. "Mammogram lesion data" over the lesion
    // form, with the dialog's Back / Submit in a separate block after it: those belong to the dialog, not the form.
    // In a dialog or panel the heading's block is everything around it up to where the element starts: an "Add
    // Collaborative Care Team Member" dialog titles a card with <div class="row"><h4>team</h4></div> and its Services field
    // inside the form, with Save after the form; that Save is the dialog's, not the team card's. Only fields, tables and
    // lists end such a block, not buttons: a dialog header holds its title and the close button.
    const closed = (h: Element) => {
      // A summary titles its own <details> only, never what follows it.
      if (h.tagName === 'SUMMARY') return !h.parentElement!.contains(el);
      const block = h.parentElement;
      if (
        block &&
        !block.contains(el) &&
        block.querySelector(`table, ul, ol, [role="grid"], [role="list"], ${controls}`)
      )
        return true;
      if (scope && scope !== pageDialog) {
        let outer = h;
        while (outer.parentElement && !outer.parentElement.contains(el))
          outer = outer.parentElement;
        if (
          outer !== h &&
          outer.querySelector(`table, ul, ol, [role="grid"], [role="list"], ${fields}`)
        )
          return true;
      }
      let form = h.nextElementSibling;
      while (form && form.tagName !== 'FORM') form = form.nextElementSibling;
      return (
        !!form &&
        !form.contains(el) &&
        !!(form.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)
      );
    };
    const above = sectionHeadings.filter(
      (h) =>
        (!scope || scope.contains(h)) &&
        h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING &&
        !closed(h),
    );
    if (above.length) return headingText(above[above.length - 1]);
    // A panel's first heading may sit far below the element (e.g. an empty grid's "No results found"): label only.
    // A full-screen dialog that reads as a page (see pageDialog) is named like a panel too: its first heading anywhere
    // may be an empty table's "No results found" (e.g. a participant details view), which names nothing.
    if (scope && (scope !== dialog || scope === pageDialog))
      return clean(scope.getAttribute('aria-label'));
    // A dialog's own elements outside its sections (its close button, the footer's Save) take the dialog's name, not
    // its first section heading ("Participant alerts", not "Communication impairments").
    if (scope === dialog && dialogTitle) return dialogTitle;
    return scope ? headingOf(scope) : headingOf(container);
  };

  const kindOf = (el: Element): SnapElement['kind'] | null => {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role');
    const editable = (tag === 'input' || tag === 'textarea') && !(el as HTMLInputElement).readOnly;
    if (tag === 'select') return 'select';
    // Custom dropdowns (a listbox, or a combobox you can't type into) are handled like a select.
    if (role === 'listbox' || (role === 'combobox' && !editable)) return 'select';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const t = ((el as HTMLInputElement).type || 'text').toLowerCase();
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (['submit', 'button', 'reset', 'image'].includes(t)) return 'button';
      if (t === 'file') return 'file';
      if (['range', 'color', 'hidden'].includes(t)) return null;
      return 'textbox';
    }
    if (role === 'checkbox' || role === 'switch') return 'checkbox';
    if (
      tag === 'button' ||
      role === 'button' ||
      role === 'menuitem' ||
      role === 'option' ||
      role === 'tab'
    )
      return 'button';
    if (tag === 'a' || role === 'link') return 'link';
    if ((el as HTMLElement).isContentEditable) return 'textbox';
    // Custom widgets with no role but focusable and clickable (calendar day cells, chips): treated as buttons.
    if ((el as HTMLElement).tabIndex >= 0 && el.hasAttribute('tabindex')) return 'button';
    // Some grids render cell actions as <div class="clickable" data-action="…">, often an icon with a hover tooltip.
    if (el.matches(clickables)) return 'button';
    // An element with only a script click handler (Angular (click) on a <div>), when it names itself (see below).
    if (listens(el)) return 'button';
    return null;
  };

  // The question a radio button or checkbox answers: its labelled radiogroup/group, or the fieldset legend.
  const questionOf = (el: Element) => {
    const g = el.closest('[role="radiogroup"], [role="group"], fieldset');
    if (!g) return '';
    const by = g.getAttribute('aria-labelledby');
    const text =
      clean(
        by
          ? by
              .split(/\s+/)
              .map((id) => document.getElementById(id)?.textContent)
              .join(' ')
          : '',
      ) ||
      clean(g.querySelector(':scope > legend')?.textContent) ||
      clean(g.getAttribute('aria-label'));
    return text.replace(/\s*\*$/, '').slice(0, 160);
  };

  // The hidden hover tooltip that names an icon-only grid action: <div class="tooltipHover"><img><span class="tooltipText">…</span>.
  const tooltipOf = (el: Element) => {
    // Such tooltips: .tooltipText, or .tooltipTextLeft / .tooltipTextRight (e.g. the participant episodes actions).
    const sel = '.tooltipText, .tooltipTextLeft, .tooltipTextRight';
    const t =
      el.querySelector(sel) ?? (el.nextElementSibling?.matches(sel) ? el.nextElementSibling : null);
    const text = clean(t?.textContent);
    return text.length <= 60 ? text : '';
  };

  const fields =
    'input:not([type="hidden"]), select, textarea, [role="checkbox"], [role="radio"], [role="switch"], [role="combobox"], [role="listbox"], [role="textbox"], [contenteditable="true"]';
  const controls =
    'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="checkbox"], [role="switch"], [role="tab"], [role="menuitem"], [role="listbox"], [role="combobox"], [contenteditable="true"]';
  const clickables = '[data-action], .clickable';
  // Options of an open list (an autocomplete's suggestions) are clicked like menu items. Not in `controls`: that list
  // also decides which labels belong to a field.
  const selector = `${controls}, [role="option"], [tabindex], ${clickables}`;
  const elements: SnapElement[] = [];

  for (const el of queryAll(root, '*')) {
    if (!el.matches(selector) && !listens(el)) continue;
    // A radio/checkbox whose native input is hidden (Material image radios, custom toggles) is acted on through its
    // visible host; the input still provides the label and the checked state.
    let target: Element = el;
    if (!shown(el)) {
      const t = el.tagName === 'INPUT' && (el as HTMLInputElement).type;
      const host =
        t === 'radio' || t === 'checkbox'
          ? el.closest('mat-radio-button, mat-checkbox, mat-slide-toggle, label')
          : t === 'file'
            ? ((el as HTMLInputElement).labels?.[0] ?? el.closest('label'))
            : null;
      if (!host || !visible(host)) continue;
      // A hidden file input opened by its label (a styled "Upload files" card): the label is the target. When the
      // label is a click target of its own (a tabindex, a click handler), it is already offered as that button.
      if (t === 'file' && kindOf(host)) continue;
      target = host;
    }
    const kind = kindOf(el);
    if (!kind) continue;
    const input = el as HTMLInputElement;

    let name = labelOf(el);
    // Set when a click target names itself only by the icon it shows (see below).
    let namelessIcon = '';
    // Picked up only for its tabindex, as a grid clickable or for its click handler: counts if it names itself (text
    // or tooltip), or shows just an icon, and isn't a container of other controls.
    if (!el.matches(controls)) {
      // A handler inside a control is that control's (an icon's (click) in a button), not another element to offer.
      if (!el.matches(selector) && el.parentElement?.closest(`${controls}, ${clickables}`))
        continue;
      if (el.querySelector(`${controls}, ${clickables}`)) continue;
      if (!name)
        name =
          clean((el as HTMLElement).innerText) || tooltipOf(el) || clean(el.getAttribute('title'));
      if (!name) {
        // An icon with its own (click) and a hover-only tooltip (e.g. a patient files table:
        // <p-icon fontIcon="attach" pTooltip="Open file" (click)=…>) has no name until hovered: offer it by its icon,
        // as a nameless <button> is. Only icon-sized, and not when it is part of a click target around or inside it.
        namelessIcon = iconSized(el) && !partOfClickTarget(el) ? shownIcon(el) : '';
        if (!namelessIcon) continue;
      } else if (name.length > 60) continue;
    }
    if (!name && kind !== 'button' && kind !== 'link') name = captionOf(el);
    if (!name && (kind === 'button' || kind === 'link'))
      name = clean((el as HTMLElement).innerText) || clean(input.value);
    // An icon link around such a tooltip: <a href><div class="tooltipHover"><span class="tooltipTextLeft">Reschedule appointment</span>.
    if (!name && (kind === 'button' || kind === 'link')) name = tooltipOf(el);
    // …or an icon button followed by its caption ("Did not attend" dialog: <button><img></button><span>Mark as DNA</span>):
    // (an icon font glyph alone, no letters or digits, isn't a name)
    if ((!name || !/[\p{L}\p{N}]/u.test(name)) && kind === 'button') {
      const sib = el.nextElementSibling;
      const caption =
        sib && !sib.matches(selector) && !sib.querySelector(selector)
          ? clean((sib as HTMLElement).innerText)
          : '';
      if (caption && caption.length <= 40) name = caption;
    }
    // …or an icon button inside a grid clickable that carries the tooltip (a worklist's "Assign to LP"):
    // <div class="tooltipHover clickable" data-action…><span class="tooltipText">…</span><button>…</button></div>.
    // Also its caption: <div class="clickable"><p-button>…<button><p-icon></button></p-button><span>Mark as DNA</span></div>.
    if ((!name || !/[\p{L}\p{N}]/u.test(name)) && (kind === 'button' || kind === 'link')) {
      const host = el.parentElement?.closest(`${clickables}, .tooltipHover`);
      if (host && host.querySelectorAll(controls).length === 1) {
        const text = clean((host as HTMLElement).innerText);
        name = tooltipOf(host) || (text.length <= 40 ? text : '') || name;
      }
    }
    if (!name)
      name =
        clean(el.getAttribute('title')) ||
        clean(el.getAttribute('placeholder')) ||
        clean(el.getAttribute('name'));

    // A button wrapped in a link with the same text is one control (some navigation renders <a><button>…</button></a>).
    if (kind === 'button' && name) {
      const link = el.parentElement?.closest('a[href]');
      if (link && clean((link as HTMLElement).innerText) === clean((el as HTMLElement).innerText))
        continue;
    }

    // Icon-only buttons whose only text is the icon ligature ("close", "search") are better named by their
    // Material tooltip, which aria-describedby points to (e.g. "close" → "Reset filters").
    let ligature = '';
    if (kind === 'button' || kind === 'link') {
      const iconText = clean(
        [
          ...el.querySelectorAll(
            'mat-icon, .material-icons, .material-icons-outlined, .material-symbols-outlined, .material-symbols-rounded',
          ),
        ]
          .map((i) => i.textContent)
          .join(' '),
      );
      const described = clean(
        (el.getAttribute('aria-describedby') || '')
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent)
          .join(' '),
      );
      if (iconText && name === iconText && described && described.length <= 60) {
        ligature = iconText;
        name = described;
      } else if (!name && described && described.length <= 60) {
        name = described; // an image-only button, e.g. <button matTooltip="Add assessment recommendation"><img></button>
      } else if (
        /^[a-z0-9_ ]+$/.test(iconText) &&
        name.length > iconText.length &&
        name.startsWith(iconText)
      ) {
        // An icon font's ligature read as part of the label: <button><mat-icon>more_vert</mat-icon><span>more</span>
        // was named "more_vert more", which jev-1.14.0 doubted against a step saying the "more" menu button.
        ligature = iconText.replace(/_/g, ' ');
        name = clean(name.slice(iconText.length));
      }
    }

    const item: SnapElement = { id: `e${elements.length + 1}`, kind, name };
    if (ligature) item.icon = ligature;
    if (!name && (kind === 'button' || kind === 'link')) {
      const icon = namelessIcon || iconOf(el);
      if (icon) item.icon = icon;
      const near = nearText(el);
      if (near) item.near = near;
    }
    // Named only by aria-label / title, showing just an icon: e.g. a "?" that is button "Request assistance". Said so, a
    // model reading the screenshot looks for the icon; jev-1.14.0 looked for the words, missed them and answered "none".
    if (
      name &&
      (kind === 'button' || kind === 'link') &&
      el.tagName !== 'INPUT' &&
      !shownText(el)
    ) {
      item.iconOnly = true;
      const icon = item.icon || namelessIcon || iconOf(el);
      if (icon) item.icon = icon;
    }
    if (input.placeholder) item.placeholder = clean(input.placeholder);
    if (el.getAttribute('role') === 'tab') item.tab = true;
    if (kind === 'textbox' && input.type === 'password') item.secret = true;
    if (kind === 'textbox') {
      const v = (el as HTMLElement).isContentEditable
        ? clean((el as HTMLElement).innerText)
        : input.value;
      if (v) item.value = input.type === 'password' ? '(hidden)' : v;
    }
    if (kind === 'select') {
      item.value =
        el.tagName === 'SELECT'
          ? clean((el as HTMLSelectElement).selectedOptions[0]?.label)
          : clean(input.value ?? (el as HTMLElement).innerText);
    }
    if (kind === 'checkbox' || kind === 'radio')
      item.checked = input.checked ?? el.getAttribute('aria-checked') === 'true';
    if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true')
      item.disabled = true;
    // Chips and toggle buttons show their state only by class or aria (e.g. the procedure chosen in "Create lesion").
    if (
      kind === 'button' &&
      (el.getAttribute('aria-pressed') === 'true' ||
        el.getAttribute('aria-selected') === 'true' ||
        /(^|\s)(mat-mdc-chip-selected|mdc-evolution-chip--selected|mat-chip-selected|p-chip-selected|selected-chip|selected)(\s|$)/.test(
          target.className?.toString?.() ?? '',
        ))
    )
      item.selected = true;

    const tr = acrossShadows(target, 'tr');
    const table = tr?.closest('table');
    if (tr && table && tr.parentElement?.tagName === 'TBODY') {
      const headers = [...table.querySelectorAll('thead th')].map((th) => clean(th.textContent));
      const visibleRows = [...tr.parentElement.children].filter(visible);
      const cells: Record<string, string> = {};
      [...tr.children].forEach((td, i) => {
        // Skip the actions cell: one with controls in it, or (when they're in a shadow root) the "Actions" column.
        if (td.querySelector(controls) || /^actions$/i.test(headers[i] ?? '')) return;
        cells[headers[i] || `col${i + 1}`] = cellText(td);
      });
      const td = acrossShadows(target, 'td, th');
      const index = td && td.parentElement === tr ? [...tr.children].indexOf(td) : -1;
      const column = index >= 0 ? headers[index] : '';
      item.row = {
        table: headingOf(table),
        number: visibleRows.indexOf(tr) + 1,
        cells,
        ...(column && column.toLowerCase() !== 'actions' ? { column } : {}),
      };
    } else if ((kind === 'radio' || kind === 'checkbox') && questionOf(el)) {
      item.section = `question "${questionOf(el)}"`;
    } else if (fieldOf(el) && fieldOf(el) !== name) {
      item.section = `field "${fieldOf(el)}"`;
    } else if (!name && groupLabelOf(el)) {
      // only for controls without a label of their own
      item.section = `field "${groupLabelOf(el)}"`;
    } else if (popup && popup.contains(el) && !el.closest('[role="menu"]')) {
      // A pop-up opened from a dialog (a date picker's calendar): its own header row and the page's headings behind the
      // dialog don't name it ("in page header (Arriving for your appointment)" made the model doubt "in the calendar").
      item.section = popup.querySelector('.calendar, [role="grid"]')
        ? 'open calendar'
        : 'open pop-up';
    } else if (el.closest('[role="menu"]')) {
      // An item of an open dropdown menu ("Actions" → Cancel / Lock): say so, it often repeats a button's name.
      item.section = 'open menu';
    } else {
      const container = containerOf(el);
      const section = container ? sectionOf(container, el) : '';
      if (container?.tagName === 'NAV' && section) item.section = `navigation "${section}"`;
      else if (container?.tagName === 'HEADER')
        item.section = section ? `page header (${section})` : 'page header';
      else if (section) item.section = section;
    }

    target.setAttribute('data-at-id', item.id);
    elements.push(item);
  }

  if (opts?.drag) {
    // Drop slots and drag sources, after the ordinary elements (so their ids and order are unchanged). A drop slot is
    // named by its own label (a calendar cell's aria-label "Tue 03 Nov 11:30 AM") and its section by the nearest named
    // group around it (a resource column, role="group" aria-label="Dr Smith").
    const hasDropListener = (
      window as unknown as Record<string, ((el: Element) => boolean) | undefined>
    )['intent-engine.click-listeners:drop'];
    const acceptsDrop = (el: Element) =>
      !!hasDropListener?.(el) || (el as HTMLElement).ondrop != null;
    const isDraggable = (el: Element) => el.getAttribute('draggable') === 'true';
    const byId = new Map(elements.map((e) => [e.id, e]));
    for (const el of queryAll(root, '*')) {
      const drop = acceptsDrop(el);
      const drag = isDraggable(el);
      if (!drop && !drag) continue;
      const offered = byId.get(el.getAttribute('data-at-id') ?? '');
      if (offered) {
        if (drag) offered.draggable = true;
        if (drop) offered.drop = true;
        continue;
      }
      if (!visible(el)) continue;
      // The innermost draggable: an appointment inside a draggable day column is the one a test means.
      if (drag && !drop && el.querySelector('[draggable="true"]')) continue;
      let name = labelOf(el);
      if (!name && drag) name = clean((el as HTMLElement).innerText);
      if (name.length > 120) name = name.slice(0, 119) + '…';
      const item: SnapElement = {
        id: `e${elements.length + 1}`,
        kind: drop ? 'slot' : 'draggable',
        name,
      };
      if (drop && drag) item.draggable = true;
      const group = el.parentElement?.closest('[role="group"][aria-label]');
      if (group) item.section = `group "${clean(group.getAttribute('aria-label'))}"`;
      else {
        const container = containerOf(el);
        const section = container ? sectionOf(container, el) : '';
        if (section) item.section = section;
      }
      el.setAttribute('data-at-id', item.id);
      elements.push(item);
    }
  }

  // collectText reads the same dialog and its name from this attribute (pageText always snapshots first).
  if (dialog && !pageDialog) dialog.setAttribute('data-at-dialog', dialogTitle ?? '');
  // Headings without a letter are counters, not headings: a participant details view listed twenty "0" tab badges.
  const headings = queryAll(document, 'h1, h2')
    .filter((h) => visible(h) && /\p{L}/u.test(h.textContent ?? ''))
    .map((h) => clean(h.textContent));
  return { url: location.pathname, title: document.title, dialog: dialogTitle, headings, elements };
}

// Runs in the browser: text used to judge `expect` steps. With `selection`, only the selected text and its scope: the
// open dialog it is in (by title), else the nearest heading or named section above it, as the outline marks them.
function collectText({
  maxChars,
  selection,
}: {
  maxChars: number;
  selection?: boolean;
}): CollectedText {
  const clean = (s: string | null | undefined) =>
    (s || '')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n\s*\n+/g, '\n')
      .trim();
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    return (
      r.width > 0 &&
      r.height > 0 &&
      (el as HTMLElement).checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
    );
  };
  // innerText leaves out open shadow roots, where web components and compiled HTML templates (a booking summary, a
  // status chip in a grid cell) render their content; the element snapshot already reaches into them, so the text does
  // too. ownShadowText is a host's shadow root, shadowTexts every visible shadow root below `root`, in document order.
  // A hidden or fully transparent host shows nothing of its shadow root.
  // An element with `display: contents` has no box of its own, so checkVisibility() is always false for it, yet its
  // children render as if they were its parent's (some component libraries render a dialog's component in such a host): it is shown
  // when its parent is.
  const passThrough = (el: Element) => getComputedStyle(el).display === 'contents';
  const shownHost = (host: Element): boolean => {
    if ((host as HTMLElement).checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }))
      return true;
    if (!passThrough(host)) return false;
    const parent = host.parentElement ?? (host.parentNode as ShadowRoot | null)?.host;
    return !!parent && shownHost(parent);
  };
  const ownShadowText = (host: Element): string =>
    clean(
      [...host.shadowRoot!.children]
        .filter((c) => !c.matches('style, script, link, template'))
        .map((c) => (c as HTMLElement).innerText ?? '')
        .join('\n'),
    );
  const shadowTexts = (root: ParentNode): string[] => {
    const out: string[] = [];
    // Tolerates nodes removed while it runs, as queryAll in collectElements does.
    const walkShadows = (node: ParentNode | null) => {
      if (!node) return;
      for (const child of Array.from(node.children ?? [])) {
        if (!child) continue;
        if (child.shadowRoot && shownHost(child)) {
          const text = ownShadowText(child);
          if (text) out.push(text);
          walkShadows(child.shadowRoot);
        }
        walkShadows(child);
      }
    };
    walkShadows(root);
    return out;
  };
  // An element's text with that of the shadow roots in it, its own included (when it is the host).
  const deepText = (el: HTMLElement) =>
    clean(
      [
        el.innerText,
        ...(el.shadowRoot && shownHost(el)
          ? [ownShadowText(el), ...shadowTexts(el.shadowRoot)]
          : []),
        ...shadowTexts(el),
      ].join('\n'),
    );
  // A cell showing only images or icon buttons is described by their names, as in collectElements (cellText).
  const deepAll = (root: ParentNode, sel: string): Element[] => {
    const out: Element[] = [];
    const walk = (node: ParentNode | null) => {
      if (!node) return;
      for (const child of Array.from(node.children ?? [])) {
        if (!child) continue;
        if (child.matches(sel)) out.push(child);
        if (child.shadowRoot) walk(child.shadowRoot);
        walk(child);
      }
    };
    walk(root);
    return out;
  };
  const insideNamedButton = (el: Element) => {
    for (let e: Element | null = el.parentElement ?? null; e;) {
      const hit = e.closest('button[aria-label], [role="button"][aria-label]');
      if (hit) return !!clean(hit.getAttribute('aria-label'));
      const root = e.getRootNode();
      e = root instanceof ShadowRoot ? root.host : null;
    }
    return false;
  };
  const iconText = (td: Element): string =>
    deepAll(
      td,
      'img[alt], [role="img"][aria-label], button[aria-label], [role="button"][aria-label]',
    )
      .filter(
        (e) =>
          (visible(e) || (e.tagName !== 'IMG' && deepAll(e, 'img').some(visible))) &&
          (e.matches('button, [role="button"]') || !insideNamedButton(e)),
      )
      .map(
        (e) =>
          [
            e.matches('button, [role="button"]') ? 'button' : 'image',
            clean(e.getAttribute(e.tagName === 'IMG' ? 'alt' : 'aria-label')),
          ] as const,
      )
      .filter(([, name]) => name)
      .map(([kind, name]) => `${kind} "${name}"`)
      .join(', ');
  const d =
    document.querySelector('[data-at-dialog]') ??
    [...document.querySelectorAll('dialog[open], [role="dialog"][aria-modal="true"]')]
      .filter(visible)
      .pop();

  // Screen-reader-only content (the usual sr-only / visually-hidden pattern: a 1px box clipped away) passes visible().
  // A chart's hidden data table under a caption like "Studies received per hour" read as that section's content and
  // contradicted the visible cards, so such tables are left out. Short hidden words ("Down" before "−100%") stay.
  // The element itself may be the 1px box; a wrapper only hides it when it also cuts off its overflow (a zero-size
  // positioned anchor with overflow visible, e.g. for a pop-up, shows its content).
  const clipped = (el: Element, self: boolean) => {
    const s = getComputedStyle(el);
    if (s.clip === 'rect(0px, 0px, 0px, 0px)' || /inset\(\s*(50|100)%/.test(s.clipPath))
      return true;
    const r = el.getBoundingClientRect();
    return r.width <= 1 && r.height <= 1 && (self || s.overflow !== 'visible');
  };
  const screenReaderOnly = (el: Element) => {
    for (let a: Element | null = el; a && a !== document.body; a = a.parentElement)
      if (clipped(a, a === el)) return true;
    return false;
  };
  const shownTables = [...document.querySelectorAll('table')].filter(
    (t) => visible(t) && !screenReaderOnly(t),
  );

  // The page as blocks of text with its outline: headings (h1–h6, role="heading") and, where they have no heading of
  // their own, named sections and fieldset legends. Subtrees without any of these keep their innerText, so line breaks
  // and visibility are as before; only the walk down to a heading splits the text. Headings without letters are
  // counters (dashboard tiles marked up as <h2>0</h2>), not section names, as in collectElements.
  // `tag` is the heading's own level (h2 → 2; 7 for a legend or named section, which sits below the heading before
  // it); `scope` is the part of the page the heading titles, which decides what is nested under it (see outline).
  type Heading = { heading: string; tag: number; scope: Element; region?: boolean };
  type Mark = Heading | 'skip';
  const marks = new Map<Element, Mark>();
  const headingSel = 'h1, h2, h3, h4, h5, h6, [role="heading"]';
  const headingEls: Element[] = [];
  for (const h of document.querySelectorAll(headingSel)) {
    const text = clean((h as HTMLElement).innerText).replace(/\s+/g, ' ');
    if (!visible(h) || !/\p{L}/u.test(text)) continue;
    const tag = /^H[1-6]$/.test(h.tagName)
      ? Number(h.tagName[1])
      : Number(h.getAttribute('aria-level')) || 2;
    marks.set(h, { heading: text, tag, scope: h });
    headingEls.push(h);
  }
  // A heading titles the box it heads: the section or dialog it labels, else it grows past wrappers that hold nothing
  // but the heading (a card's title ribbon: <div class="ribbon"><h4>Assessment details</h4></div><div>…cards with their
  // own h4…</div>), so same-level headings inside that box are nested under it, as they look on screen.
  for (const h of headingEls) {
    const mark = marks.get(h) as Heading;
    const labelled = h.id
      ? h.parentElement?.closest(`[aria-labelledby~="${CSS.escape(h.id)}"]`)
      : null;
    if (labelled) {
      mark.scope = labelled;
      continue;
    }
    for (let p = h.parentElement; p && p !== document.body; p = p.parentElement) {
      if (clean((mark.scope as HTMLElement).innerText).replace(/\s+/g, ' ') !== mark.heading) break;
      if (headingEls.find((x) => p!.contains(x)) !== h) break;
      mark.scope = p;
    }
  }
  for (const l of document.querySelectorAll('fieldset > legend')) {
    const text = clean((l as HTMLElement).innerText).replace(/\s+/g, ' ');
    if (text && visible(l) && !marks.has(l))
      marks.set(l, { heading: text, tag: 7, scope: l.parentElement! });
  }
  // A <details> is titled by its <summary> without the actions and icons in it, as in collectElements (summaryTitle).
  // The summary's own text is then its marker: "+ Add" and "Archive" are buttons, not the section's content.
  const summaryActions =
    'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="checkbox"], [role="switch"], [tabindex], mat-icon, .material-icons, .material-icons-outlined, .material-symbols-outlined, .material-symbols-rounded, [aria-hidden="true"]';
  for (const s of document.querySelectorAll('details > summary')) {
    if (marks.has(s) || [...s.querySelectorAll(headingSel)].some((h) => marks.has(h))) continue;
    const parts: string[] = [];
    const walk = (n: Node) => {
      for (const c of n.childNodes) {
        if (c.nodeType === Node.TEXT_NODE) parts.push(c.textContent ?? '');
        else if (
          c instanceof Element &&
          !c.matches(summaryActions) &&
          ((c as HTMLElement).checkVisibility({ checkVisibilityCSS: true }) ||
            getComputedStyle(c).display === 'contents')
        )
          walk(c);
      }
    };
    walk(s);
    let text = parts.join(' ').replace(/\s+/g, ' ').trim();
    if (text.length > 200) text = text.slice(0, 199) + '…';
    if (visible(s) && /\p{L}/u.test(text))
      marks.set(s, { heading: text, tag: 7, scope: s.parentElement! });
  }
  for (const s of document.querySelectorAll(
    'section[aria-label], section[aria-labelledby], [role="region"][aria-label], [role="region"][aria-labelledby]',
  )) {
    if ([...s.querySelectorAll(headingSel)].some((h) => marks.has(h))) continue;
    const by = s.getAttribute('aria-labelledby');
    const name = clean(
      by
        ? by
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent)
            .join(' ')
        : s.getAttribute('aria-label'),
    ).replace(/\s+/g, ' ');
    if (name) marks.set(s, { heading: name, tag: 7, scope: s, region: true });
  }
  for (const t of document.querySelectorAll('table'))
    if (visible(t) && screenReaderOnly(t)) marks.set(t, 'skip');
  const onPath = new Set<Element>();
  for (const el of marks.keys())
    for (let a = el.parentElement; a && !onPath.has(a); a = a.parentElement) onPath.add(a);

  // Nesting: a heading is under an earlier one whose box contains it, or (as in a plain document) whose tag is
  // higher. Its level is its depth, so "#" counts follow what contains what rather than the tags alone.
  const outline = (root: Element, maxLen: number) => {
    const blocks: OutlineBlock[] = [];
    const headings: { el: Element; heading: string; level: number }[] = [];
    const open: Heading[] = [];
    let length = 0;
    const text = (s: string | null | undefined) => {
      if (!s || !s.trim()) return;
      blocks.push({ text: s });
      length += s.length;
    };
    const walk = (el: Element) => {
      for (const child of el.childNodes) {
        if (length > maxLen) return;
        if (child.nodeType === Node.TEXT_NODE) {
          text(child.textContent);
          continue;
        }
        if (child.nodeType !== Node.ELEMENT_NODE) continue;
        const c = child as Element;
        const mark = marks.get(c);
        if (mark === 'skip') continue;
        // (innerText of an element that isn't rendered is its whole textContent.) A `display: contents` wrapper isn't
        // rendered itself but its children are: it is walked rather than read, so each child is checked on its own and
        // its headings still mark sections (a library's dialog body, whose title and buttons alone were read).
        const shown = c.checkVisibility();
        const through = !shown && passThrough(c);
        if (!shown && !through) continue;
        if (mark) {
          while (
            open.length &&
            !open[open.length - 1].scope.contains(c) &&
            mark.tag <= open[open.length - 1].tag
          )
            open.pop();
          open.push(mark);
          const own = Math.min(open.length, 6);
          blocks.push({ heading: mark.heading, level: own });
          headings.push({ el: c, heading: mark.heading, level: own });
          length += mark.heading.length + own + 1;
          if (!mark.region) continue; // a heading's own text is its marker
        }
        if (mark || through || onPath.has(c)) {
          walk(c);
          if (c.shadowRoot && shownHost(c))
            text(clean([ownShadowText(c), ...shadowTexts(c.shadowRoot)].join('\n')));
        } else text(deepText(c as HTMLElement));
      }
    };
    walk(root);
    return { blocks, headings };
  };

  const page = outline(document.body, maxChars);
  // The headings above a node, nested by level; the last one is the nearest.
  const headingsAbove = (headings: typeof page.headings, t: Node) => {
    const stack: { heading: string; level: number }[] = [];
    for (const h of headings) {
      if (!(h.el.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING)) break;
      while (stack.length && stack[stack.length - 1].level >= h.level) stack.pop();
      stack.push(h);
    }
    return stack;
  };
  // Where a table sits: the headings above it, nested by level ("Studies received › Per hour, last 24 hours").
  const sectionOf = (t: Element) =>
    headingsAbove(page.headings, t)
      .map((h) => h.heading)
      .join(' › ');

  if (selection) {
    const picked = window.getSelection();
    const selected = (picked?.toString() ?? '').replace(/\s+/g, ' ').trim().slice(0, 500);
    let scope = '';
    let anchor: Node | null = selected ? (picked?.anchorNode ?? null) : null;
    // A selection inside a shadow root is placed at its host, which the outline's headings can be compared with.
    for (let root = anchor?.getRootNode(); root instanceof ShadowRoot; root = anchor!.getRootNode())
      anchor = root.host;
    if (anchor) {
      const dialogTitle = d?.contains(anchor) ? (d.getAttribute('data-at-dialog') ?? '') : '';
      const nearest = (headings: typeof page.headings) =>
        headingsAbove(headings, anchor!).pop()?.heading ?? '';
      scope =
        dialogTitle || nearest(d?.contains(anchor) ? outline(d, maxChars).headings : page.headings);
    }
    return {
      url: location.pathname,
      title: document.title,
      dialog: null,
      tables: [],
      blocks: [],
      selection: { text: selected, ...(scope ? { scope } : {}) },
    };
  }

  const tables = shownTables.map((t) => {
    const headers = [...t.querySelectorAll('thead th')].map((th) => clean(th.textContent));
    const rows = [...t.querySelectorAll('tbody tr')].filter(visible).map((tr) => {
      const row: Record<string, string> = {};
      [...tr.children].forEach((td, i) => {
        const h = headers[i] || `col${i + 1}`;
        if (h.toLowerCase() !== 'actions') row[h] = deepText(td as HTMLElement) || iconText(td);
      });
      return row;
    });
    const section = sectionOf(t);
    return {
      caption: clean(t.querySelector('caption')?.textContent),
      ...(section ? { section } : {}),
      rows,
    };
  });

  // Named only by its own label, as in collectElements.
  // Named in collectElements (see dialogName there); a dialog it didn't mark is untitled.
  const dialogTitle = d?.getAttribute('data-at-dialog') ?? '';

  return {
    url: location.pathname,
    title: document.title,
    dialog: d ? { title: dialogTitle, blocks: outline(d, 3000).blocks } : null,
    tables,
    blocks: page.blocks,
  };
}

export async function snapshot(page: Page, opts?: { drag?: boolean }): Promise<Snapshot> {
  return page.evaluate(collectElements, opts ?? {});
}

export async function pageText(page: Page, maxChars: number): Promise<PageText> {
  // Form fields come from the element snapshot so they get the same labels, states and shadow-DOM reach.
  const snap = await snapshot(page);
  const {
    blocks,
    dialog,
    selection: _,
    ...collected
  } = await page.evaluate(collectText, {
    maxChars,
  });
  const text = {
    ...collected,
    dialog: dialog ? { title: dialog.title, text: formatOutline(dialog.blocks, 3000) } : null,
    visibleText: formatOutline(blocks, maxChars),
  };
  const fields = snap.elements
    .filter(
      (e) =>
        (e.kind === 'textbox' ||
          e.kind === 'select' ||
          e.kind === 'checkbox' ||
          e.kind === 'radio') &&
        !e.secret,
    )
    .map((e) => ({
      // Both name and placeholder: custom dropdowns are often named generically ("Multi select field") and told apart
      // only by their placeholder ("Gender"). Disabled matters to `expect` steps about read-only fields.
      label:
        (e.name && e.placeholder && e.placeholder !== e.name
          ? `${e.name} (placeholder "${e.placeholder}")`
          : e.name || e.placeholder || '(no label)') + (e.disabled ? ' (disabled)' : ''),
      value: e.checked !== undefined ? (e.checked ? 'checked' : 'not checked') : (e.value ?? ''),
    }));
  const named = (e: SnapElement) =>
    (e.name || (e.icon ? `${e.icon} icon` : '')) + (e.disabled ? ' (disabled)' : '');
  const rows = new Map<string, PageText['actions']['rows'][number]>();
  const other: string[] = [];
  for (const e of snap.elements) {
    if (e.kind !== 'button' && e.kind !== 'link') continue;
    const label = named(e);
    if (!label) continue;
    if (e.row) {
      const key = `${e.row.table}#${e.row.number}`;
      if (!rows.has(key))
        rows.set(key, { table: e.row.table, row: e.row.number, cells: e.row.cells, actions: [] });
      const r = rows.get(key)!;
      const action = e.row.column ? `${label} (in "${e.row.column}")` : label;
      if (!r.actions.includes(action)) r.actions.push(action);
    } else if (!other.includes(label)) {
      other.push(label);
    }
  }
  return { ...text, fields, actions: { rows: [...rows.values()], other: other.slice(0, 150) } };
}

/** A coloured area of the page: its visible text and its background as the browser paints it (`rgb(r, g, b)`). */
export type ColouredArea = { text: string; background: string };

/** Areas longer than this are containers (a panel, a page section), not the tile or chip a colour check is about. */
const MAX_AREA_TEXT = 200;

/**
 * The page's coloured areas, in document order (browser side). An area is a visible element whose background, as
 * painted (a semi-transparent one blended over what is behind it), differs from the background behind it: a status
 * tile, a chip, a coloured button or row. It is reported by its own visible text (lines joined with " · "), else its
 * aria-label or title. The background comes from `getComputedStyle`, so it is the same whether a stylesheet (SCSS
 * class), an inline style (`[ngStyle]`) or a CSS variable set it. Opacity is ignored: a tile drawn faded keeps its
 * colour. Transparent elements take the colour behind them and are not areas; neither are form fields, `html` and
 * `body`, or gradients and images (not a background colour). Shadow roots are included.
 */
function collectColours({ max, maxText }: { max: number; maxText: number }): ColouredArea[] {
  type Colour = [number, number, number, number];
  const parse = (css: string): Colour | null => {
    const m = css.match(/^rgba?\(([^)]*)\)$/);
    if (!m) return null;
    const p = m[1]
      .split(/[\s,/]+/)
      .filter(Boolean)
      .map(Number);
    if (p.length < 3 || p.length > 4 || p.some((v) => !Number.isFinite(v))) return null;
    return [p[0], p[1], p[2], p.length === 4 ? p[3] : 1];
  };
  const over = (top: Colour, under: Colour): Colour => [
    top[0] * top[3] + under[0] * (1 - top[3]),
    top[1] * top[3] + under[1] * (1 - top[3]),
    top[2] * top[3] + under[2] * (1 - top[3]),
    1,
  ];
  const distance = (a: Colour, b: Colour) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const clean = (s: string) =>
    s
      .split('\n')
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join(' · ');
  const out: ColouredArea[] = [];
  const seen = new Set<string>();
  const visit = (el: Element, behind: Colour) => {
    if (out.length >= max) return;
    const style = getComputedStyle(el);
    if (style.display === 'none') return;
    let painted = behind;
    const own = parse(style.backgroundColor);
    if (own && own[3] >= 0.1) painted = over(own, behind);
    const root = el === document.documentElement || el === document.body;
    if (!root && distance(painted, behind) > 20 && !el.matches('input, textarea, select, option')) {
      const r = el.getBoundingClientRect();
      const shown =
        r.width > 0 &&
        r.height > 0 &&
        (el as HTMLElement).checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
      const text = shown
        ? clean((el as HTMLElement).innerText || '') ||
          (el.getAttribute('aria-label') || el.getAttribute('title') || '').trim()
        : '';
      if (text && text.length <= maxText) {
        const background = `rgb(${painted
          .slice(0, 3)
          .map((v) => Math.round(v))
          .join(', ')})`;
        const key = `${text}\n${background}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push({ text, background });
        }
      }
    }
    for (const child of Array.from(el.children)) visit(child, painted);
    if (el.shadowRoot)
      for (const child of Array.from(el.shadowRoot.children)) visit(child, painted);
  };
  visit(document.documentElement, [255, 255, 255, 1]);
  return out;
}

/**
 * The page's coloured areas for an `expect` step about colours, one line each: the area's text and its background as a
 * plain name and the exact value, e.g. `"Friday, 6 November 2026 · Test Clinic B · 07:30 - 12:00": background green
 * #358856`. At most `max` areas.
 */
export async function pageColours(page: Page, max = 150): Promise<string[]> {
  const areas = await page.evaluate(collectColours, { max, maxText: MAX_AREA_TEXT });
  return areas.flatMap((a) => {
    const c = parseCssColour(a.background);
    return c ? [`"${a.text}": background ${describeColour(c)}`] : [];
  });
}

/**
 * The text selected in the main frame (whitespace runs collapsed, trimmed, at most 500 characters; `''` when nothing is
 * selected) and its `scope`: the title of the open dialog it is in, else the nearest heading or named section above
 * it, as `pageText` outlines the page.
 */
export async function pageSelection(page: Page): Promise<PageSelection> {
  // The snapshot marks the open dialog with its title, as for pageText. The whole page is outlined, so a selection far
  // down a long page still finds its heading.
  await snapshot(page);
  const { selection } = await page.evaluate(collectText, {
    maxChars: Number.MAX_SAFE_INTEGER,
    selection: true,
  });
  return selection ?? { text: '' };
}

/** One-line description of an element; used as the Choice criterion text. */
/** `compact` names a row by its number only, without its cells. */
export function describe(e: SnapElement, opts: { compact?: boolean } = {}): string {
  // An unnamed control showing only an icon is named by that icon, which is all a user sees: an X button read as
  // `button "(no label)", icon "close"` left jev-1.14.0 unsure of `click the "close" icon button` (MIT-03, ~0.8).
  // Tabs are clicked like buttons but named as tabs: `click the "Deferrals" tab` against `button "Deferrals"` made
  // d3-ultra (text only) weigh "no element matches exactly" and pick a participant-details view's tabs at ~0.8.
  const kind = e.tab ? 'tab' : e.kind === 'file' ? 'file upload' : e.kind;
  let s =
    !e.name && e.icon
      ? `${kind} "${e.icon}" (icon only)`
      : `${kind} "${e.name || '(no label)'}"${e.iconOnly ? ' (icon only)' : ''}`;
  if (e.name && e.icon) s += `, icon "${e.icon}"`;
  if (e.near) s += `, next to "${e.near}"`;
  if (e.placeholder && e.placeholder !== e.name) s += `, placeholder "${e.placeholder}"`;
  if (e.value) s += `, current value "${e.value}"`;
  if (e.checked !== undefined) s += e.checked ? ', checked' : ', not checked';
  if (e.disabled) s += ', disabled';
  if (e.selected) s += ', selected';
  if (e.draggable && e.kind !== 'draggable') s += ', draggable';
  const column = e.row?.column ? `column "${e.row.column}" of ` : '';
  if (e.row && opts.compact) {
    s += ` — in ${column}row ${e.row.number} of table "${e.row.table}"`;
  } else if (e.row) {
    // Empty cells dropped and long ones cut: every action in a row repeats the row, and a worklist with a few
    // multi-line rows (assessment worklist) otherwise overflows the decision model's input.
    const cells = Object.entries(e.row.cells)
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}: ${v.length > 60 ? v.slice(0, 60) + '…' : v}`)
      .join(', ');
    s += ` — in ${column}row ${e.row.number} of table "${e.row.table}" (${cells})`;
  } else if (e.section) {
    s += ` — in ${e.section}`;
  }
  return s;
}
