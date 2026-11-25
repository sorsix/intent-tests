# Intent test format (v1)

This is the contract between the people who write intent tests and the runner. `src/parse.ts` implements it
deterministically: the decision model never reads the grammar, it only resolves the free text of a step (the
*target*) to an element on the page, or judges an `expect`.

Check files at any time without a browser or a model:

```bash
npx --no-install intent-test parse --app clinic          # the whole app
npx --no-install intent-test parse --app clinic booking    # one folder or file
```

## Files

- Every `.md` file in an app folder (`intent-tests/<app>/`, any depth) is a test file, except `README.md`,
  `AGENTS.md`, `CLAUDE.md`, and anything under `docs/`, `reports/`, `node_modules/` or a hidden folder.
- Text outside the sections below (titles, notes, explanations) is ignored, so a test file can document itself.
- File names start with a short id, e.g. `bk-01-slot-filters.md`. Seeds get it as `ctx.testId` (`BK01`).

## Sections

A section starts with a level-2 heading and ends at the next level-1 or level-2 heading.

### `## Test: <name>`

One test. The name is unique within its file. The `id:` line is required; the others are optional. Put them before the steps:

| Line | Meaning |
|---|---|
| `id: clinic.login.reception` | **Required.** The durable ID, unique across the app; 1–200 letters/digits/dots/underscores/hyphens, starting with a letter or digit. Put it right under the heading and never change it: case history and versions follow the ID, so renaming or moving the test keeps them. |
| `session: <block name>` | Start logged in as that session (a `## Steps:` block, see below). |
| `seed: <seed name>` | Run that seed from the app's `seeds.ts` first; its values are available as `{{seed.<key>}}`. |
| `parameters: <set name>` | Run the test once per row of that set from the app's `parameters.ts`; see [Parameterized tests](#parameterized-tests). |
| `tags: @a @b` | Playwright tags (the `@` is optional). Three have a meaning to the runner, see below. |
| `refs: C1234, C1235` | References to other systems, e.g. the TestRail cases the test covers: comma-separated, at most 20, each 1–50 letters, digits, `.`, `_`, `:`, `/` or `-`. The catalog lists them as `refs`; they are not part of the case's version. A malformed or second `refs:` line is a parse error. |

Dashboard identity is `case:<id>`. A `## Test:` without an `id:` line is a parse error naming the file and line. Run `intent-test ids --write <paths>` to add one under every heading that lacks it (see below). IDs are validated across all app files, including files outside a selected subset. `--case-id <id>` (repeatable) or `AT_CASE_IDS=id1,id2` selects exact IDs; unknown IDs fail parsing instead of running another case. Combine this with a file filter or Playwright grep when needed.

#### Adding ids: `intent-test ids`

`intent-test ids [--write] <file or folder>...` finds the tests without an `id:` line. It reads the files as text, so it
works on suites the parser rejects, and needs no app, environment or browser. Without `--write` it lists each missing
id (`file:line  <id>  <test name>`) and exits 1; with `--write` it inserts `id: <id>` right under each heading and
leaves every other byte of the file alone. The generated id is a slug of the test title (lowercase `a-z0-9-`, at most
60 characters), made unique across all the paths given by appending `-2`, `-3`, ... and never equal to an id already
written. Running it again changes nothing. Pass every suite folder of the app in one call so the ids stay unique across
files; review the result and commit it. Prefer a hand-written, namespaced id (`clinic.login.reception`) for new tests.

Then numbered steps, `1.` to `n.` with no gaps. Other lines (e.g. `Note: …`) are ignored.

### `## Steps: <name>`

A reusable block of numbered steps. Block names are unique across the whole app (put shared ones in `shared/`).
A block is used in four ways:

- `use "<name>"` inside a test or another block: its steps are inlined (numbered `3.1`, `3.2`, …). Cycles are an error.
- `session: <name>` on a test: the block is run once per run, the browser state is saved, and the test starts from
  it. A block that is a plain login (a `fill … user…` and a `fill … password …` step) is instead logged in through
  the app's `auth` hook (its API login) before each test.
- `switch to session "<name>"` in a test: continue as that user, in the same window (the earlier user's page is left).
- `switch to window "<name>"` in a test: continue as that user in their own window. The first use opens a separate
  window (its own cookies and storage, like a private window) and logs it in as the block, the way a test with
  `session: <name>` starts; a later use returns to that window as it was left, with any open dialog. The test's own
  `session:` names its first window, so a test that switches windows needs a `session:` line. Windows left in the
  background keep running (websockets, polling), so one user can hold a record open while another checks what they
  can see:

  ```markdown
  ## Test: A first read in progress is hidden from another radiologist
  id: clinic.records.first-read-is-hidden
  session: log in as radiologist
  seed: bscc participant in reading

  1. switch to window "log in as second radiologist"
  2. open "/app/reading/first"
  3. fill the "Patient ID / Name" filter with "{{seed.patientId}}"
  4. expect the worklist shows the participant "{{seed.patientId}}" within 20 seconds
  5. switch to window "log in as radiologist"
  6. open "/app/reading/first"
  7. fill the "Patient ID / Name" filter with "{{seed.patientId}}"
  8. click the "Read mammogram" action in the row for "{{seed.patientId}}"
  9. switch to window "log in as second radiologist"
  10. expect the worklist shows "No results found" within 10 seconds
  ```

  Seed values and `{{saved.…}}` values are shared by every window of the test; every window is closed when the test
  ends, before the seed is cleaned up. A step's report says which window it ran in. Session blocks themselves can't
  switch windows, and develop mode does not support it yet.

## Steps

| Step | Example |
|---|---|
| `open "<path or URL>"` | `open "/app/home"` |
| `click <target>` | `click the "Submit" button in the "Booking" dialog` |
| `fill <target> with "<value>"` | `fill the patient ID field with "{{seed.patientId}}"` |
| `select "<option>" in <target>` (or `from`) | `select "Māori" in the ethnicity dropdown` |
| `select "*" in <target>` | the first real option, for lists whose values depend on the environment's data |
| `check <target>` / `uncheck <target>` | `check "I consent to enrol"` |
| `drag <element> to <slot>` | `drag the "Jane Doe" appointment to the "Tue 03 Nov 11:30 AM" slot for "Dr Smith"` |
| `upload "<file>" to <target>` | `upload "files/referral.pdf" to the "Upload Files" button` |
| `press "<key>"` | `press "Escape"` (Playwright key names) |
| `expect <statement> [within N seconds]` | `expect the worklist shows "{{seed.patientId}}" within 20 seconds` |
| `wait N seconds` | `wait 2 seconds` (avoid; prefer `expect … within`) |
| `use "<block>"` | `use "book the first free slot"` |
| `switch to session "<block>"` | `switch to session "log in as radiologist"` |
| `switch to window "<block>"` | `switch to window "log in as second radiologist"` |
| `call <METHOD> "<path>" [and save "<field>" as "<name>"]` | `call POST "/app/api/jobs/run" and save "data.id" as "jobId"` |

- Verbs are case-insensitive. A *target* is free text describing the element as a user would; quote the visible
  label and add context ("in the row for …", "in the … dialog") when a label is ambiguous.
- An icon that is clickable but has no name of its own (no text, `aria-label` or `title`, only a tooltip shown on
  hover) is named by the icon it shows: its font-icon name (`fontIcon`, `svgIcon`, a component library's `icon_<name>` class)
  or Material ligature, so write `click the "attach" icon in the row for "referral.pdf"`, not the hover tooltip. A
  name the app gives it (`aria-label`, text, `title`) always wins.
- `expect` is judged on the visible page text with its headings and named sections marked, so a statement can be
  scoped to a section by its heading as shown: `expect the "Studies received" section shows "Last 7 days"`.
  Screen-reader-only content such as a chart's hidden data table is not part of it.
- An `expect` (or an `optionally …, only if` condition) that names a colour also gets the page's coloured areas: each
  visible element whose background differs from what is behind it (a status tile, a chip, a coloured button or row),
  by the text inside it, with the colour as the browser paints it, whether a stylesheet, an inline style or a CSS
  variable set it. Colours are named in code: `red`, `orange`, `yellow`, `green`, `teal`, `blue`, `purple`, `pink`,
  `grey`, `white`, `black`, with `light`/`dark` at either end, plus the exact `#RRGGBB`. Write the colour as a person
  sees it and say which element: `expect the "Monday, 9 November 2026" occurrence has a green background`. A colour
  name (also `gray`), `colour`/`color`, `background` or a `#hex` value as a whole word turns this on. Faded (opacity)
  elements keep their colour; gradients and images are not background colours. Only rendered elements count: items a
  virtual-scroll list has not drawn yet are not on the page.
- `expect` without `within` uses the runner's short resolve timeout (3 s); with `within N seconds` it keeps checking
  until the statement holds or N seconds pass.
- `expect <thing> is not shown` (also `is not visible`, `is not displayed`, `is not listed`) checks that something is
  absent: `expect the "Debtors" menu item is not shown`. The model is asked the positive statement ("the "Debtors" menu
  item is shown"), because it judges negative statements poorly, and the step passes only when the answer is a
  confident no (yes at most 1 − the yes/no threshold, 0.2 at 0.8) on `AT_MIN_LOOKS` looks in a row (3) after the page
  has settled; an unsure answer never counts. With `within N seconds` it waits up to N seconds for the thing to go
  away. Only this exact single-clause form is inverted: anything after the verb, a second clause or a list (`, and or`
  outside quotes), and other wordings (`no longer lists …`, `no dialog is open`, `is not "Enrolled"`) are judged as
  written. Put a positive `expect` about the same area before it, so it cannot pass on a page still loading.
- `upload "<file>" to <target>` clicks the target and chooses the file in the file picker it opens (Playwright's file
  chooser; no system dialog appears). The file's path is relative to the app folder, written with `/`, and must stay
  inside it: an absolute path or `..` is a parse error, and a file that does not exist fails when the suite loads, with
  `file:line`. The target is what a person clicks to choose a file: a file field (`the "Referral letter" file field`),
  the card or label that opens a hidden one (`the "Upload Files" button`), or a button whose script opens the picker.
  File fields and the labels that open hidden ones are offered only to `upload` steps, never to `click`. If the target
  opens no file picker within 5 seconds the step fails (`did not open a file picker`). One file per step; the file is
  never sent to the decision model. Drag-and-drop drop zones are not supported, and choosing a file is not recorded in
  Develop mode yet.
- `drag <element> to <slot>` drags with native HTML5 drag-and-drop (`dragstart`, `dragover`, `drop` with a real
  `dataTransfer`), dropped at the centre of the slot. While the drag is held, the engine waits up to 2 seconds for the
  slot to be the element under that point (pages often raise their drop cells only once a drag is under way), and
  fails with `something covers the drop slot` if it never is. The dragged element is one marked `draggable="true"`. A drop
  slot is an element with its own `drop` listener (or `ondrop`), named by its accessible name (`aria-label`); its
  section is the nearest named group around it (`role="group" aria-label="Dr Smith"`). Quote the slot's label as the
  app writes it, and its group when several groups repeat it: only slots whose name or group contain **every** quoted
  text are offered, nothing is converted (`11:30` does not match `11:30 AM`), and when none match the step fails
  (`no drop slot matches …`) instead of choosing a nearby slot. Drop zones that only work with pointer events (Angular
  CDK `cdkDrag`) or a listener on a container rather than on each slot are not supported yet. Drop slots are never
  click candidates and are not part of the page text. Develop mode runs `drag` steps but does not record them, and
  `verify` and `suggest` don't cover them.
- `call` uses the current browser session's cookies; server errors are retried 3 times. `METHOD` is GET, POST,
  PUT, PATCH or DELETE. A saved field (`data.token` walks into objects) is used later as `{{saved.<name>}}`.

### `optionally <step>`

Only for `click`, `fill`, `select`, `check` and `uncheck`. When no element matches, the step is skipped instead of
failing. It can carry a condition, checked on its own as a yes/no question about the page; the step runs only if it
holds:

```
19. optionally click "Next dates" in the calendar, only if the day "Tue 13" is not shown (it can fall in the next week)
```

A trailing explanation in brackets is for the reader and is not asked.

## Variables

| Syntax | Filled from | When |
|---|---|---|
| `{{NAME}}` | Environment: shell > `<app>/.env` > `<app>/.env.<AT_ENV>` | Parse time (a missing variable is a parse error) |
| `{{param.<key>}}` | The test's row of its `parameters:` set | Parse time (in the test name and steps) |
| `{{seed.<key>}}` | The values the test's seed returns | When the test runs |
| `{{saved.<name>}}` | A value saved by an earlier `call … and save` step | When the step runs |

`fill` values are not shown with their variables filled in (they may be passwords).

## Parameterized tests

A test with `parameters: <set>` is a template: it becomes one case per row of that set, with `{{param.<key>}}` filled
in its name and steps. Put a parameter in the name so each case has its own title. Like `seed:` names an entry of the app's
`seeds.ts`, `parameters:` names an entry of its `parameters.ts`.

```md
## Test: BBM booking price ({{param.timePeriod}}, {{param.ageRange}})
id: clinic.booking.pricing
parameters: bbm pricing
seed: bbm timeslot

1. fill the age field with "{{param.age}}"
2. expect the "Consultation Cost" shows "{{param.price}}"
```

The sets live in the app folder's `parameters.ts`:

```ts
import type { ParameterSet } from '@sorsix/intent-engine';

export const parameters: Record<string, ParameterSet> = {
  'bbm pricing': {
    description: 'Time of day × age group',
    rows: () => timeGroups.flatMap((t) => ageGroups.map((a) => ({ ...t, ...a, price: '45.00' }))),
    key: (row) => `${row.timePeriod}|${row.ageRange}`,
  },
};
```

- The rows are needed before anything runs (to list the cases and publish the dashboard catalog), so a set is pure
  data: no network, no clock, no Playwright imports and no top-level await. Test data that must be created per run is a
  seed's job; a seed gets its test's row as `ctx.params`.
- Values are strings, numbers or booleans (used as text). Row keys are letters, digits and `_`.
- Each case's identity is the template's plus its row key: `case:clinic.booking.pricing[In-hours|18+]`. Keep the key when reordering or adding rows, so a case keeps its
  history. Without `key(row)` it is the row's values joined with `|`. Keys are unique within a set, at most 120
  characters, without `]` or line breaks.
- `--case-id clinic.booking.pricing` runs every case of the template, `--case-id "clinic.booking.pricing[In-hours|18+]"` one.
  `AT_PARAMS=first` runs each template's first row, `AT_PARAMS=<key>,<key>` the rows with those keys (while writing a
  test; the dashboard catalog still lists every case).
- Branching on a row's value is not possible; a row that needs different steps belongs to a different set and
  template (a set can filter another's rows).
- `{{param.<key>}}` outside such a test, a key the row lacks, an unknown set, and two cases with the same name are
  parse errors. Session blocks run before any test, so they cannot use `{{param.<key>}}`.

## Tags with a meaning

- `@exclusive`: the test changes something global (bulk invitations, auto-booking, shared configuration). It runs
  in a second pass, alone, after all other tests.
- `@expect-fail`: the test is reported green when it fails and red when it passes (known bugs, negative checks).
- `@draft`: work in progress. `intent-test run` (also its `--list` and the dashboard's discovery) leaves the test out
  unless `AT_INCLUDE_DRAFTS=true`; `catalog` and `publish-suite` still list it, marked `draft: true`, and the dashboard
  shows it as a draft. A draft is the only test that may have no steps yet (any other `## Test:` without a numbered
  step is a parse error); a draft without steps is never run, not even with `AT_INCLUDE_DRAFTS=true`. Cases created
  in develop mode start as drafts; remove the tag when the test is ready.

`refs:` and `@draft` were added without a version change: files without them mean what they meant before.

## The runner's promise

A step whose target matches nothing, or matches with a confidence below the threshold, **fails**. The runner never
"finds another way". `expect` passes only when the model's yes probability is above the threshold.

## Changing the format

This file is the spec. A change that makes an existing valid file invalid, or makes it mean something else, is a
**breaking change**: it needs the version above bumped, every app's tests updated in the same merge request, and
`parse` passing for every app (`nx run intent-tests:parse`). Adding a new verb or an optional line is not breaking,
but still goes in this file, in `src/parse.ts`, in `test/parse.test.ts`, and in `VERBS` (the parser's error message).
