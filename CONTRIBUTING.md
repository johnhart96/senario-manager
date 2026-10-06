# Contributing

Thanks for helping improve Senario Manager. Bug reports, feature ideas, documentation fixes and
pull requests are all welcome.

## Reporting bugs and suggesting features

Use [GitHub issues](https://github.com/johnhart96/senario-manager/issues/new/choose). The
templates ask for what's useful: OS, app version, mail server type and the relevant
**Activity** lines.

Before posting, remove real addresses, API keys, passwords and anything else from your network
you wouldn't publish. **Security problems** go through [SECURITY.md](SECURITY.md), not public issues.

## Development setup

```bash
git clone https://github.com/johnhart96/senario-manager.git
cd senario-manager
npm install
npm start
```

Node.js 24+ is required. The [architecture guide](docs/architecture.md) explains how the code
fits together. Read its **safety invariants** before changing anything in `src/core/mail.js`
or `src/core/engine.js`.

You don't need a mail server or an OpenAI key to work on most things. The tests run against a
local SMTP sink and a fake OpenAI endpoint.

## Checks

```bash
npm run check   # syntax-check every source file
npm test        # all test suites (about 45 seconds)
npm test -- e2e # just the suites whose file name contains "e2e"
```

Set `VERBOSE=1` to print every test's output. If you change packaging or anything loaded at
runtime (workers, dependencies), also run:

```bash
npm run pack && npm run test:packaged
```

## Pull requests

1. Fork, and create a branch from `main`.
2. Keep changes focused. One feature or fix per pull request is easiest to review.
3. Match the surrounding style: CommonJS, 2-space indent, single quotes, semicolons, small
   functions, and comments that explain *why*, not *what*.
4. Add or update tests for behaviour changes, especially anything touching sending, receiving,
   threading or the safety invariants.
5. Update the docs in `docs/` and the README if user-facing behaviour changes. Add a line to the
   *Unreleased* section of [CHANGELOG.md](CHANGELOG.md).
6. If you changed the UI noticeably, run `npm run screenshots` to refresh `docs/images/`.
7. If you added or removed dependencies, run `npm run licenses`. New dependencies must have a
   GPL-3.0-compatible license (MIT, BSD, ISC, Apache-2.0 and similar are fine).
8. Make sure `npm run check` and `npm test` pass.

## Guidelines for new features

- **Keep traffic contained.** Features must never make the app send to, or accept from, anything
  other than the configured mail server, or address recipients outside the company's domains.
- **Stay realistic.** The goal is a convincing inbox. New AI behaviour should read like real
  people, and must never reveal that it's a simulation.
- **No native modules** if avoidable. They complicate cross-platform builds.
- **Don't store secrets in plain text.** Use the store's encrypted secret fields.

## License

By contributing, you agree that your contributions are licensed under the
[GNU GPL v3](LICENSE), the same license as the project.
