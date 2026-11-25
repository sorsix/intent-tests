// What does and doesn't show that a click on a table row did something (used by StepRunner.watchClick in steps.ts).
// No imports, so the unit tests run without node_modules.

/**
 * Non-GET requests a table row click or a grid redraw sends whether or not the clicked action happens, so they don't
 * show that it did (app-specific, like OPTION_SELECTOR): grids remember the last viewed row on every row click, and
 * a redraw fetches the text above the grid with a POST (…/html-template-above-grid/compiled; RD-05 under load).
 */
export const ROW_CLICK_BOOKKEEPING =
  /\/last-viewed(\?|$)|\/html-template-above-grid\/compiled(\?|$)/;

/** A page's address without its query and hash: a grid writes its filters into the query when it redraws. */
export const pagePath = (url: string) => {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return url;
  }
};
