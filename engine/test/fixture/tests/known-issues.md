# Known issues and negative checks

Both tests are tagged `@expect-fail`: they are reported green when they fail, and red if they pass.

## Test: Cancel an appointment
id: cancel-an-appointment
tags: @expect-fail @known-bug
session: log in as reception
Note: the site has a planted bug. Cancel shows a success toast but never changes the status.
This test must FAIL on step 4; that is how we know the runner catches real bugs.
1. open "/worklist.html"
2. click "Cancel" in the row for "Elena Trajkovska"
3. click "Yes, cancel appointment"
4. expect "Elena Trajkovska" has status "Cancelled"

## Test: Clicking a button that does not exist fails
id: clicking-a-button-that-does-not-exist-fails
tags: @expect-fail @negative
session: log in as reception
Note: there is no "Discharge" action anywhere. The model must answer "none" (or be unsure) rather
than clicking something that looks similar.
1. open "/worklist.html"
2. click the "Discharge" action in the row for "Maja Angelovska"
