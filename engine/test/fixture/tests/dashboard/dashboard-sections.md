# Dashboard: checks scoped to a section

The dashboard shows card grids under section headings, a bar chart with a screen-reader-only data table, and a
recent-studies table. An `expect` that names a section must be judged inside that section.

## Test: A card is checked inside its section
id: a-card-is-checked-inside-its-section
1. open "/dashboard.html"
2. expect the "Studies received" section shows "Last 7 days"
3. expect the "Studies received" section shows "Last 30 days" with 14 studies
4. expect the "Recently received" section shows a table of studies

## Test: A card from another section does not count
id: a-card-from-another-section-does-not-count
tags: @expect-fail @negative
Note: "Last 7 days" is a card under "Studies received", not in "Recently received". This test must FAIL on step 2.
1. open "/dashboard.html"
2. expect the "Recently received" section shows "Last 7 days"
