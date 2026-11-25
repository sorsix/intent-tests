# Nurse: menu

## Test: A nurse does not see the reception menu items
id: a-nurse-does-not-see-the-reception-menu-items
session: log in as nurse
Note: the main menu depends on the role; a nurse only has "Triage queue".
1. open "/triage.html"
2. expect the main menu shows "Triage queue"
3. expect the "Worklist" menu item is not shown
4. expect the "Register walk-in" menu item is not visible

## Test: A not-shown expect fails when reception has the menu item
id: a-not-shown-expect-fails-when-reception-has-the-menu-item
session: log in as reception
tags: @expect-fail
Note: reception has a "Worklist" menu item, so step 3 must FAIL.
1. open "/worklist.html"
2. expect the main menu shows "Worklist"
3. expect the "Worklist" menu item is not shown
