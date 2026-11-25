# Writing intent tests

An intent test is a Markdown file of plain-English steps. The engine parses the steps deterministically (the grammar
below), opens the app in a real browser and resolves each step's *target* (free text such as `the "Save" button in the
"Booking" dialog`) to one element on the page with a decision model. It fails rather than guesses: a target that
matches nothing, or matches too weakly, fails the step. Write what a manual tester would do and see.

## A test file

```md
## Test: Reschedule the assessment appointment
id: clinic.appointment.reschedule
session: log in as data manager
seed: bscc participant with a booked assessment
tags: @draft
refs: C1234

1. open "/app/home"
2. click the "Search Participant" button in the page header
3. fill the "Patient ID" field with "{{seed.patientId}}"
4. expect the participant details show "Recalled for assessment" within 30 seconds
```

- `## Test: <name>` starts a case. `id:` is required and never changes: history and versions follow it.
- `session: <block>` starts the browser logged in through that `## Steps:` block (a block that is a plain login uses
  the app's login API instead of clicking through the form).
- `seed: <name>` runs that seed from the app's `seeds.ts` first; its values are available as `{{seed.<key>}}`.
- `tags: @draft` keeps the case out of verification runs while it is being written (a draft may have no steps yet);
  `refs:` lists the TestRail cases (or other ids) the case covers.
- `## Steps: <name>` is a reusable block of steps: `use "<name>"` inlines it, `session:` starts from it,
  `switch to session "<name>"` continues as that user.
- Other text in the file (notes, headings) is ignored, so a file can explain itself.

## Steps

| Step | Example |
|---|---|
| `open "<path or URL>"` | `open "/app/home"` |
| `click <target>` | `click the "Submit" button in the "Booking" dialog` |
| `fill <target> with "<value>"` | `fill the "Patient ID" field with "{{seed.patientId}}"` |
| `select "<option>" in <target>` | `select "Māori" in the ethnicity dropdown` (`"*"` picks the first real option) |
| `check <target>` / `uncheck <target>` | `check "I consent to enrol"` |
| `drag <element> to <slot>` | `drag the "Jane Doe" appointment to the "Tue 03 Nov 11:30 AM" slot for "Dr Smith"` (quote the slot as labelled; native HTML5 drag-and-drop only) |
| `upload "<file>" to <target>` | `upload "files/referral.pdf" to the "Upload Files" button` (the file's path is relative to the app folder) |
| `press "<key>"` | `press "Escape"` |
| `expect <statement> [within N seconds]` | `expect the worklist shows "{{seed.patientId}}" within 20 seconds` |
| `wait N seconds` | `wait 2 seconds` (avoid; prefer `expect … within`) |
| `use "<block>"` | `use "book the first free slot"` |
| `switch to session "<block>"` | `switch to session "log in as radiologist"` |
| `call <METHOD> "<path>" [and save "<field>" as "<name>"]` | `call POST "/app/api/jobs/run" and save "data.id" as "jobId"` |
| `optionally <step>[, only if <condition>]` | `optionally click "Next dates" in the calendar, only if the day "Tue 13" is not shown` |

Verbs are case-insensitive; `optionally` applies to click, fill, select, check and uncheck. Variables: `{{NAME}}`
from the environment, `{{param.<key>}}` from the row of a parameterized test, `{{seed.<key>}}` from the seed,
`{{saved.<name>}}` from an earlier `call … and save`.

## Steps that resolve with confidence

- Quote the visible label exactly as the page shows it and name the element kind: `the "Save" button`,
  `the "Patient ID" field`, `the "Status" dropdown`, `the "Participant details" icon`.
- When a label repeats on the page, say where: `in the "Booking" dialog`, `in the row for "Ana Petrova"`,
  `in the page header`.
- One fact per `expect`, in the page's own words. Scope it to a section by its heading on a long page:
  `expect the "Studies received" section shows "Last 7 days"`.
- When the fact is a value in a form field, name the field and quote its value as it shows in the field, not a
  description of the dialog or drawer around it: `expect the "IOL Booking" field shows "18 Nov 2026, 05:00 pm"`,
  not `expect the page shows a drawer to reschedule the appointment for 05:00 pm`.
- For `drag`, quote the slot label in full (day, date and time, e.g. `"Wed 18 Nov 05:00 PM"`) and the group around it
  (`for "Dr Smith"`). Only slots that contain every quoted text are offered, and nothing is converted, so `"5:00 PM"`
  or `"17:00"` matches nothing.
- Add `within N seconds` to an `expect` that follows a save, a search or a page load; do not pad with `wait`.
- For `upload`, keep the files with the tests in the app folder (`files/…`) and name what a person clicks to choose
  a file, as it is labelled: `upload "files/referral.pdf" to the "Upload Files" button`. Then check the result in the
  page's own words (`expect … shows "referral.pdf"`); a test PDF with a unique marker text lets an `expect` confirm
  that a PDF viewer shows that very file.
- To check that something is absent (a menu item the user may not see), write exactly
  `expect the "Debtors" menu item is not shown` (or `is not visible`, `is not displayed`, `is not listed`), one thing
  per step. Put a positive `expect` for the same area before it (`expect the menu shows "Patients"`), so the step
  cannot pass on a page that has not loaded yet.
- When a status shows only as a colour, name the element and the colour as a person sees it:
  `expect the "Monday, 9 November 2026" occurrence has a green background`. Naming a colour makes the engine read
  each coloured area's computed background (red, orange, yellow, green, teal, blue, purple, pink, grey, white, black,
  or an exact `#RRGGBB`); do not replace a colour check with a text proxy.
- Stay at the user's level: no selectors, ids, URLs of internal pages or coordinates. The resolver reads the page the
  way a person does.
- Start from a `session:` block instead of repeating login steps, and create data with a `seed:` instead of clicking
  through forms the case is not about.
- Give a new case a namespaced id (`clinic.booking.cancel-slot`), keep `@draft` until every step passes, and record the
  TestRail ids in `refs:`.

## In Develop mode

Intent Launcher's Develop mode runs one case step by step in a live browser session: verify a wording before saving
it (it shows the element the resolver would pick and its confidence), run a step or run from a step, record clicks and
typing as steps, and edit the file in place; every edit is saved at once. A step is done when it passes there, and what
passes there passes in a run. The complete grammar is `docs/test-format.md` next to this file.
