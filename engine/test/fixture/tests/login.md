# Login

These tests check the login itself, so they write the steps out instead of using a session.

## Test: Receptionist logs in
id: receptionist-logs-in
1. open "/"
2. fill the username field with "{{RECEPTION_USER}}"
3. fill the password field with "{{RECEPTION_PASSWORD}}"
4. click the "Log in" button
5. expect the page shows the reception worklist with today's appointments
6. expect the header shows the logged-in user "Sara Mitreva"

## Test: Wrong password shows an error
id: wrong-password-shows-an-error
1. open "/"
2. fill username with "{{RECEPTION_USER}}"
3. fill password with "wrong-password"
4. click "Log in"
5. expect an error says the username or password is invalid
6. expect the staff login form is still shown
