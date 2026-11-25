# Reception: check-in

## Test: Check in a patient by name
id: check-in-a-patient-by-name
session: log in as reception
Note: "Ana Petrova" and "Anna Petrovska" are both on the list, on purpose.
1. open "/worklist.html"
2. click the "Check in" action in the row where patient is "Ana Petrova"
3. expect a check-in dialog for "Ana Petrova" is open
4. select "Private" in the insurance dropdown
5. check the "Consent form signed" checkbox
6. click "Confirm check-in"
7. expect the worklist shows "Ana Petrova" with status "Checked in"
8. expect "Anna Petrovska" still has status "Scheduled"

## Test: Check in the patient in the first grid row
id: check-in-the-patient-in-the-first-grid-row
Note: logs in with `use` instead of a session, so both mechanisms stay covered.
1. use "log in as reception"
2. click the "Check in" action in the first row of the worklist
3. expect a check-in dialog for "Ana Petrova" is open
4. select "Public" in insurance
5. check consent form signed
6. click confirm check-in
7. expect a notification says "Ana Petrova checked in"

## Test: Check-in dialog validates required fields
id: check-in-dialog-validates-required-fields
session: log in as reception
1. open "/worklist.html"
2. click "Check in" for "Petar Georgiev"
3. click "Confirm check-in"
4. expect an error says an insurance type must be selected
5. expect the check-in dialog is still open
6. click "Close"
7. expect "Petar Georgiev" still has status "Scheduled"

## Test: Search the worklist, then check in
id: search-the-worklist-then-check-in
session: log in as reception
1. open "/worklist.html"
2. fill the patient search box with "Kostova"
3. expect the worklist shows only "Ivana Kostova"
4. click "Check in" in the first row
5. select "Self-pay" in insurance
6. check the consent checkbox
7. click "Confirm check-in"
8. expect "Ivana Kostova" has status "Checked in"

## Test: The check-in dialog closes after confirming
id: the-check-in-dialog-closes-after-confirming
session: log in as reception
1. open "/worklist.html"
2. click the "Check in" action in the row where patient is "Ana Petrova"
3. expect a check-in dialog for "Ana Petrova" is open
4. select "Private" in the insurance dropdown
5. check the "Consent form signed" checkbox
6. click "Confirm check-in"
7. expect the check-in dialog is not shown within 5 seconds
