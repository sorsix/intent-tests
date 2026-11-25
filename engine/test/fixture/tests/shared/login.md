# Shared steps

Reusable step blocks. Call one from a test with `use "<name>"`, or start a test already logged in
with a `session: <name>` line (the block then runs once per test run, not once per test).

## Steps: log in as reception
1. open "/"
2. fill the username field with "{{RECEPTION_USER}}"
3. fill the password field with "{{RECEPTION_PASSWORD}}"
4. click the "Log in" button
5. expect the page shows the reception worklist

## Steps: log in as nurse
1. open "/"
2. fill the username field with "{{NURSE_USER}}"
3. fill the password field with "{{NURSE_PASSWORD}}"
4. click the "Log in" button
5. expect the page shows the triage queue
