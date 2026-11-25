# Reception: walk-in registration

## Test: Register a walk-in patient
id: register-a-walk-in-patient
session: log in as reception
1. open "/worklist.html"
2. click "Register walk-in" in the main navigation
3. click "Register patient"
4. expect an error says the first name is required
5. expect an error says a doctor must be chosen
6. fill first name with "Nikola"
7. fill last name with "Jovanov"
8. fill date of birth with "1992-08-14"
9. select "Dr. Ristov" in the doctor dropdown
10. fill reason for visit with "Sore throat and fever"
11. click "Register patient"
12. expect the worklist shows "Nikola Jovanov" as a walk-in with status "Scheduled"
