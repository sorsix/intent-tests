# Reception: clinic session occurrences

The Future Events list shows each occurrence's status only as its background colour: active green, cancelled orange,
draft grey. A step that names a colour gets the page's computed background colours.

## Test: Occurrence statuses show as colours
id: occurrence-statuses-show-as-colours
1. open "/sessions.html"
2. expect the "Friday, 6 November 2026" occurrence in the Future Events list is green
3. expect the "Monday, 9 November 2026" occurrence has a green background
4. expect the "Tuesday, 10 November 2026" occurrence is orange
5. expect the "Wednesday, 11 November 2026" occurrence is grey, not green or orange

## Test: A cancelled occurrence is not green
id: a-cancelled-occurrence-is-not-green
tags: @expect-fail
Note: Tuesday is orange (cancelled), so this must FAIL on step 2.
1. open "/sessions.html"
2. expect the "Tuesday, 10 November 2026" occurrence in the Future Events list has a green background
