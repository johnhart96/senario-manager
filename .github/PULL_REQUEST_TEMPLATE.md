## What does this change?

<!-- A short description, and the issue it fixes if any (e.g. "Fixes #12"). -->

## How was it tested?

<!-- e.g. new/updated tests, manual testing against Postfix, screenshots for UI changes. -->

## Checklist

- [ ] `npm run check` and `npm test` pass
- [ ] Tests added or updated for behaviour changes
- [ ] Docs (`docs/`, README) and CHANGELOG updated if user-facing
- [ ] Safety invariants still hold (see docs/architecture.md): one outbound host, company-only recipients, one inbound source, no reply loops
- [ ] No real addresses, keys or other secrets in code, tests or screenshots
