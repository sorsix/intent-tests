# Reception: care calendar

## Test: Reschedule an appointment by dragging it
id: reschedule-an-appointment-by-dragging-it
Note: slots are named like a care calendar's day grid; "Dr Lee" on Wednesday starts off-screen in the scrolling week.
1. open "/drag.html"
2. drag the "Jane Doe" appointment to the "Tue 03 Nov 11:30 AM" slot for "Dr Jones"
3. expect the page says Jane Doe was moved to Dr Jones on Tue 03 Nov at 11:30 AM
4. drag the "Tom Brown" appointment to the "Wed 04 Nov 01:00 PM" slot for "Dr Lee"
5. expect the page says Tom Brown was moved to Dr Lee on Wed 04 Nov at 01:00 PM
