# Nurse: triage

## Test: Nurse records vitals
id: nurse-records-vitals
session: log in as nurse
1. open "/triage.html"
2. expect the triage queue shows "Marko Ilievski" and "Stefan Dimitrov"
3. click "Record vitals" for "Stefan Dimitrov"
4. fill blood pressure with "128/84"
5. fill pulse with "76"
6. fill temperature with "36.8"
7. click "Save vitals"
8. expect "Stefan Dimitrov" is listed under "Triaged today" with blood pressure "128/84"
9. expect "Marko Ilievski" is still waiting in the triage queue
