# Engine self-test

Run with the deterministic stub decider (`npm run test:self`): every step quotes the labels it
means, because the stub only matches quoted text (see src/decider/stub.ts). Together these cover every verb (upload too), sessions,
shared blocks, parameterized tests (parameters:), optional steps, drag and drop, the @expect-fail and @exclusive tags. The tests in ../tests are written for a real
decision model (run them with AT_DECIDER=jev).

## Test: Session, row action, dropdown, checkbox and expect
id: session-row-action-dropdown-checkbox-and-expect
session: log in as reception
1. open "/worklist.html"
2. click the "Check in" action in the row for "Ana Petrova"
3. expect the "Confirm check-in" button is shown within 5 seconds
4. select "Private" in the "Insurance" dropdown
5. check "Consent form signed"
6. click "Confirm check-in"
7. expect the page says "Checked in" within 5 seconds

## Test: Shared block, fill and press
id: shared-block-fill-and-press
1. use "log in as reception"
2. open "/worklist.html"
3. fill the "Search" box with "Kostova"
4. press "Escape"
5. expect the worklist shows "Ivana Kostova"
6. wait 1 second

## Test: Search the worklist for "{{param.search}}"
id: self.worklist-search
parameters: worklist search
1. use "log in as reception"
2. open "/worklist.html"
3. fill the "Search" box with "{{param.search}}"
4. expect the worklist shows "{{param.patient}}"

## Test: Optional steps are skipped when nothing matches or the condition does not hold
id: optional-steps-are-skipped-when-nothing-matches-or-the
session: log in as reception
1. open "/worklist.html"
2. optionally click the "Discharge" action in the row for "Maja Angelovska"
3. optionally click "Check in" in the row for "Ana Petrova", only if "No such text anywhere" is shown
4. expect the page shows "Maja Angelovska"

## Test: Check and uncheck an ARIA switch
id: check-and-uncheck-an-aria-switch
session: log in as nurse
1. open "/triage.html"
2. check "Urgent patients only"
3. expect the page says "Showing urgent patients only"
4. uncheck "Urgent patients only"
5. expect the page says "Showing all patients"

## Test: Click an option an autocomplete in a dialog shows outside it
id: click-an-option-an-autocomplete-in-a-dialog-shows-outside-it
session: log in as nurse
1. open "/triage.html"
2. click "Assign ward"
3. fill the "Ward" field with "Ward 3"
4. click the "Ward 3 - Cardiology" option
5. click "Save ward"
6. expect the page says "Ward: Ward 3 - Cardiology"

## Test: Read text a web component renders in a shadow root
id: read-text-a-web-component-renders-in-a-shadow-root
session: log in as nurse
1. open "/triage.html"
2. expect the page shows "Triage summary: 2 patients waiting, 1 triaged today"

## Test: A field label says when it is read-only and what its placeholder is
id: a-field-label-says-when-it-is-read-only-and-what-its
session: log in as nurse
1. open "/triage.html"
2. expect the "Bed (disabled)" field shows "B-12"
3. expect the "Ward code" field has the placeholder "e.g. CAR-3"

## Test: Switch to another session and call an endpoint
id: switch-to-another-session-and-call-an-endpoint
session: log in as reception
1. open "/worklist.html"
2. switch to session "log in as nurse"
3. open "/triage.html"
4. expect the page shows "Record vitals"
5. call GET "/triage.html"

## Test: Two users in their own windows see what the other one holds
id: two-users-in-their-own-windows
session: log in as reception
Note: each window is its own browser context (its own login and storage). The case the reception user is reading drops
off the nurse's list while the reception window stays open in the background, and comes back when it is closed.
1. call DELETE "/api/claims"
2. switch to window "log in as nurse"
3. open "/reading.html"
4. expect the page shows "Bojan Kirov"
5. expect the reading list shows "Ana Petrova"
6. switch to window "log in as reception"
7. open "/reading.html"
8. expect the page shows "Sara Mitreva"
9. click the "Read" button in the row for "Ana Petrova"
10. expect the dialog shows "Reading Ana Petrova" within 5 seconds
11. switch to window "log in as nurse"
12. expect the page shows "Bojan Kirov"
13. expect "Ana Petrova" is not shown within 5 seconds
14. expect the reading list shows "Marko Ilievski"
15. switch to window "log in as reception"
16. expect the dialog shows "Reading Ana Petrova"
17. click the "Close" button
18. switch to window "log in as nurse"
19. expect the reading list shows "Ana Petrova" within 5 seconds
20. click the "Read" button in the row for "Ana Petrova"
21. expect the dialog shows "Reading Ana Petrova" within 5 seconds

## Test: Selecting the option a custom dropdown already shows does not open it
id: selecting-the-option-a-custom-dropdown-already-shows-does
session: log in as reception
Note: the Clinic dropdown's list takes 12 s to load, longer than a step waits for options, so opening it would fail.
1. open "/register.html"
2. select "Skopje Centre" in the "Clinic" dropdown
3. expect the page shows "Skopje Centre"

## Test: A dropdown the page fills in while it opens counts as selected
id: a-dropdown-the-page-fills-in-while-it-opens-counts-as
session: log in as reception
Note: the Room list takes 15 s, longer than a step waits for options; the page sets "Room 2" itself meanwhile.
1. open "/register.html"
2. select "Room 2" in the "Room" dropdown
3. expect the page shows "Room 2"

## Test: A dropdown the page fills in with another value still fails
id: a-dropdown-the-page-fills-in-with-another-value-still-fails
tags: @expect-fail
session: log in as reception
Note: the page fills in "Room 2", not "Room 3", and no options show in time, so this must FAIL on step 2.
1. open "/register.html"
2. select "Room 3" in the "Room" dropdown

## Test: A step waits for the page's silent data loading
id: a-step-waits-for-the-pages-silent-data-loading
Note: the calendar loads how far it may go (2.5 s, no loading indicator) and refuses "Next week" until then.
1. open "/calendar.html"
2. click the "Next week" button
3. expect the page shows "Week 2"

## Test: A click that replaces the picker's grid with the next view worked
id: a-click-that-replaces-the-pickers-grid-with-the-next-view
Note: clicking a year redraws the grid as that year's months, so the clicked row is gone although the click worked.
1. open "/picker.html"
2. click the year "2017" in the "Choose a date" calendar
3. click "FEB" in the "Choose a date" calendar
4. expect the page shows "Chosen: February 2017"

## Test: A full-screen dialog hides the page behind it
id: a-full-screen-dialog-hides-the-page-behind-it
Note: the page behind has its own "Close" button; only the dialog's can be used, so the step is not ambiguous.
1. open "/enrol.html"
2. click the "Close" button
3. expect the page shows "Enrolment closed"

## Test: A full-screen dialog is not reported as an open dialog
id: a-full-screen-dialog-is-not-reported-as-an-open-dialog
tags: @expect-fail
Note: a full-screen dialog that doesn't say it is modal reads as a page. Its question text comes after 12,000 characters
of page text, so it only reaches the model if the dialog is reported as open, which it must not be: this must FAIL.
1. open "/enrol.html"
2. expect the page shows "recent changes to your breasts"

## Test: A check looks at once for a short-lived message
id: a-check-looks-at-once-for-a-short-lived-message
Note: the message shows for 2 s after the click while the page reloads its data (4 s); waiting for that first would miss it.
1. open "/toast.html"
2. click the "Expire" button
3. expect the page shows "Deferral expired successfully"

## Test: A check about colours reads the background colours
id: a-check-about-colours-reads-the-background-colours
Note: the stub only finds the quoted colours when the step's colour words made the engine send the page's colour list.
1. open "/sessions.html"
2. expect the "Tuesday, 10 November 2026" occurrence has an "orange #FE994A" background
3. expect the faded "Monday, 9 November 2026" occurrence is still "green #358856"

## Test: A step that matches nothing fails
id: a-step-that-matches-nothing-fails
tags: @expect-fail
session: log in as reception
1. open "/worklist.html"
2. click the "Discharge" action in the row for "Maja Angelovska"

## Test: Section headings and visible tables reach the page text
id: section-headings-and-visible-tables-reach-the-page-text
1. open "/dashboard.html"
2. expect the page shows "## Studies received" and "Last 7 days"
3. expect the page shows "Dashboard › Recently received"

## Test: A screen-reader-only table does not reach the page text
id: a-screen-reader-only-table-does-not-reach-the-page-text
tags: @expect-fail
Note: "Thu 15:00–16:00" is only in the chart's sr-only data table, so this must FAIL.
1. open "/dashboard.html"
2. expect the page shows "Thu 15:00–16:00"

## Test: Cards inside a titled panel are nested under its heading
id: cards-inside-a-titled-panel-are-nested-under-its-heading
Note: every title is an h4; "Lab results" is a card inside the "Visit details" panel, "Notes" a panel of its own.
1. open "/details.html"
2. expect the page shows "## Visit details" and "### Lab results" and "## Notes"

## Test: Same-level headings are not flattened to their tag level
id: same-level-headings-are-not-flattened-to-their-tag-level
tags: @expect-fail
Note: with levels taken from the h4 tags alone the page text would read "#### Lab results", so this must FAIL.
1. open "/details.html"
2. expect the page shows "#### Lab results"

## Test: An icon font's ligature is not part of a button's name
id: an-icon-fonts-ligature-is-not-part-of-a-buttons-name
tags: @expect-fail
Note: the "more" button's icon ligature "more_vert" used to be read into its name ("more_vert more"), so this must FAIL.
1. open "/details.html"
2. click the "more" button
3. expect the page shows "more_vert more"

## Test: A row icon with only a click handler is clicked by the icon it shows
id: a-row-icon-with-only-a-click-handler-is-clicked-by-its-icon
Note: the Documents icons have no name until hovered (like a patient files table); they are offered by their icon.
1. open "/details.html"
2. click the "delete" icon in the row for "prior exams.jpg"
3. expect the page shows "Deleted prior exams.jpg"
4. click the "attach" icon in the row for "referral.pdf"
5. expect the page shows "Opened referral.pdf"

## Test: Drag an appointment to another resource and time
id: drag-an-appointment-to-another-resource-and-time
Note: native HTML5 drag-and-drop onto slots named like a care calendar's day grid; "Dr Lee" on Wednesday starts off-screen.
1. open "/drag.html"
2. drag the "Jane Doe" appointment to the "Tue 03 Nov 11:30 AM" slot for "Dr Jones"
3. expect the page shows "Jane Doe moved to Dr Jones, Tue 03 Nov 11:30 AM"
4. drag the "Tom Brown" appointment to the "Wed 04 Nov 01:00 PM" slot for "Dr Lee"
5. expect the page shows "Tom Brown moved to Dr Lee, Wed 04 Nov 01:00 PM"

## Test: A drag to a slot that does not exist fails
id: a-drag-to-a-slot-that-does-not-exist-fails
tags: @expect-fail
Note: the calendar starts at 09:00 AM; no slot is named "Tue 03 Nov 07:00 AM", so this must FAIL on step 2, not drop nearby.
1. open "/drag.html"
2. drag the "Jane Doe" appointment to the "Tue 03 Nov 07:00 AM" slot for "Dr Smith"

## Test: An expect that something is not shown
id: an-expect-that-something-is-not-shown
1. open "/details.html"
2. expect the "Discharge everyone" button is not shown
3. expect the page shows "referral.pdf"

## Test: A not-shown expect on something that is shown fails
id: a-not-shown-expect-on-something-that-is-shown-fails
tags: @expect-fail
Note: "referral.pdf" is in the Documents list, so this must FAIL on step 2.
1. open "/details.html"
2. expect "referral.pdf" is not shown

## Test: Upload files through a label card, a file field and a button
id: upload-files-through-a-label-card-a-file-field-and-a-button
Note: the "Upload Files" card is a basic upload control (a focusable label over a hidden file input); the PDF
viewer draws the page on a canvas with a transparent text layer, as pdf.js does.
1. open "/upload.html"
2. upload "files/referral.pdf" to the "Upload Files" button
3. expect the page shows "referral.pdf"
4. click the "visibility" icon
5. expect the page shows "INTENT-UPLOAD-7f3a"
6. upload "files/photo.png" to the "Referral letter" file upload
7. expect the page shows "Referral letter: photo.png"
8. upload "files/referral.pdf" to the "Attach photo" button
9. expect the page shows "Photo: referral.pdf"

## Test: An upload to something that opens no file picker fails
id: an-upload-to-something-that-opens-no-file-picker-fails
tags: @expect-fail
Note: "Clear received" opens no file picker, so this must FAIL on step 2.
1. open "/upload.html"
2. upload "files/referral.pdf" to the "Clear received" button

## Test: An exclusive test runs in the second pass
id: an-exclusive-test-runs-in-the-second-pass
tags: @exclusive
1. open "/"
2. expect the page shows "Log in"
