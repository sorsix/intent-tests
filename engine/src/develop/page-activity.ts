// What the page itself reported while one develop step ran (docs/develop-mode.md, section 3.6), and the small screenshot
// taken after it. Listeners are attached once per page (a develop context has one); the session resets the collector
// when a step starts and takes its lists when it finishes.
import type { Page } from '@playwright/test';
import type { PageActivity } from './protocol.ts';

/** Entries kept per list, and characters kept per text. */
export const ACTIVITY_LIMIT = 20;
export const ACTIVITY_TEXT = 300;
/** The after screenshot: at most this wide (CSS pixels scaled down), JPEG quality. */
export const AFTER_WIDTH = 640;
export const AFTER_QUALITY = 50;
const AFTER_TIMEOUT_MS = 5_000;

const cut = (text: string) =>
  text.length > ACTIVITY_TEXT ? `${text.slice(0, ACTIVITY_TEXT - 1)}…` : text;

/** A URL without credentials, query string and fragment: those can carry tokens. */
export function plainUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol === 'data:' || url.protocol === 'blob:') return `${url.protocol}…`;
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return cut(url.href);
  } catch {
    return cut(value.replace(/[?#].*$/s, ''));
  }
}

const empty = (): PageActivity => ({ errors: [], console: [], requests: [] });

function push<T>(list: T[], item: T): void {
  if (list.length < ACTIVITY_LIMIT) list.push(item);
}

export class PageActivityCollector {
  private current = empty();

  constructor(page: Page) {
    page.on('pageerror', (error) =>
      push(
        this.current.errors,
        cut(error.message ? `${error.name}: ${error.message}` : String(error)),
      ),
    );
    page.on('console', (message) => {
      const type = message.type();
      if (type === 'error' || type === 'warning')
        push(this.current.console, { level: type, text: cut(message.text()) });
    });
    page.on('response', (response) => {
      const status = response.status();
      if (status >= 400)
        push(this.current.requests, {
          method: response.request().method(),
          url: plainUrl(response.url()),
          status,
        });
    });
    page.on('requestfailed', (request) =>
      push(this.current.requests, {
        method: request.method(),
        url: plainUrl(request.url()),
        failure: cut(request.failure()?.errorText ?? 'failed'),
      }),
    );
  }

  /** Starts a new step: forgets what earlier steps collected. */
  reset(): void {
    this.current = empty();
  }

  /** What was collected since the last reset; collection goes on into a fresh list. */
  take(): PageActivity {
    const taken = this.current;
    this.current = empty();
    return taken;
  }
}

const collectors = new WeakMap<Page, PageActivityCollector>();

/** The page's collector, attaching the listeners the first time. */
export function pageActivity(page: Page): PageActivityCollector {
  let collector = collectors.get(page);
  if (!collector) {
    collector = new PageActivityCollector(page);
    collectors.set(page, collector);
  }
  return collector;
}

/** The viewport as a small JPEG, or undefined when the capture fails or takes too long: it never fails a step. */
export async function afterShot(page: Page): Promise<string | undefined> {
  if (page.isClosed()) return undefined;
  let timer: NodeJS.Timeout | undefined;
  const capture = (async () => {
    // Playwright cannot scale a screenshot; Chromium's own capture can (as steps.ts does for the model's image).
    const cdp = await page.context().newCDPSession(page);
    try {
      const { cssVisualViewport: v } = await cdp.send('Page.getLayoutMetrics');
      const scale = Math.min(1, AFTER_WIDTH / v.clientWidth);
      const { data } = await cdp.send('Page.captureScreenshot', {
        format: 'jpeg',
        quality: AFTER_QUALITY,
        clip: { x: v.pageX, y: v.pageY, width: v.clientWidth, height: v.clientHeight, scale },
      });
      return data;
    } finally {
      await cdp.detach().catch(() => undefined);
    }
  })();
  try {
    return await Promise.race([
      capture,
      new Promise<undefined>((done) => {
        timer = setTimeout(() => done(undefined), AFTER_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
    capture.catch(() => undefined);
  }
}
