// What the runner counts as a click on a table row having done something (RD-05 lost its click under load).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { pagePath, ROW_CLICK_BOOKKEEPING } from '../src/row-click.ts';

describe('row click effects', () => {
  test("the grid's own requests are not effects of the click", () => {
    assert.ok(
      ROW_CLICK_BOOKKEEPING.test(
        'http://localhost:4444/app/api/grids/SCREENING_REVIEW/last-viewed',
      ),
    );
    assert.ok(
      ROW_CLICK_BOOKKEEPING.test(
        'http://localhost:4444/app/api/grids/preview/screening_review/html-template-above-grid/compiled?search=DEMO-RD05-9689',
      ),
    );
    assert.ok(
      !ROW_CLICK_BOOKKEEPING.test(
        'http://localhost:4444/app/api/clinic/reading/58616904/send-for-reading',
      ),
    );
  });

  test('a query-only URL change is not a navigation', () => {
    const before = 'http://localhost:4444/app/grids/preview/screening_review';
    assert.equal(pagePath(`${before}?pageSize=25&search=DEMO-RD05-9689`), pagePath(before));
    assert.notEqual(pagePath('http://localhost:4444/app/participants/1/details'), pagePath(before));
  });
});
