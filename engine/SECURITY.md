# Security policy

## Reporting a vulnerability

Please report security issues privately through GitHub's **Report a vulnerability** form on this repository's
Security tab, not in a public issue. Include the engine version, what an attacker could do, and how to reproduce it.

We acknowledge reports within five working days and keep you informed until a fix is released.

## Supported versions

Security fixes go into the latest released version. Upgrade to it before reporting, if you can.

## Scope notes

- The engine runs the tests and seeds you give it with your credentials; treat test folders as code.
- API keys and dashboard tokens are read from the environment and never written to reports, spools or logs; a case
  where one leaks is a vulnerability.
- Model requests contain the page's visible text and element descriptions. Point the engine at test data, not
  production personal data.
