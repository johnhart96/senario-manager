# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.8.0] - 2026-10-28

### Fixed

- Payments from customers who pay after a delay are dated on the scenario day they're due, so a
  payment due days later no longer lands on today's date when the pace is speeded up. *Pay now*,
  and payments held up while the scenario was stopped, are dated today.

## [0.7.0] - 2026-10-28

### Added

- **Online banking:** an optional website for the virtual bank, served by the app (Bank tab →
  Online banking; port 80 by default). Trainees log in with usernames and passwords you create,
  view the balance and transactions (search, date filter), pay money out (review, confirm,
  receipt), and download PDF or CSV statements. Payments land in the account, statements and the
  Activity log. No JavaScript, CSRF-protected forms, idle timeout and login lockout.
- **Arranged overdraft** on the bank account (Bank tab → Account details).

## [0.6.0] - 2026-10-27

### Added

- **Virtual banking:** a new **Bank** tab with the company's account. When an employee emails a
  customer an invoice, the customer agrees to pay it in their reply (unless it's wrong) and the
  money arrives straight away or after a delay, by customer (*Pays invoices* on the Customers
  tab). Payers sometimes email a remittance advice. Add your own transactions, Pay now or Cancel
  expected payments, and email a PDF bank statement for any period to an employee. Settings →
  Banking sets the timings. Saved in `.senario` files.

### Changed

- Slightly tighter sidebar spacing, so the extra **Bank** tab fits without scrolling.

## [0.5.0] - 2026-10-27

### Added

- **Forms come back filled in:** send a customer or party a PDF, Word or Excel form and they
  complete it and return it with their reply, under its original filename. Fills PDF form
  fields, Word content controls, `Label: ____` lines and table cells, and Excel cells next to a
  label. Forms without blanks come back as a completed copy.
- **Cooldown after a resolved conversation:** a customer whose conversation has just been
  resolved isn't picked to start another until a set time has passed (24 hours of scenario time
  by default; *Settings → Scenario behaviour*, 0 turns it off).
- **Per-customer follow-ups:** untick *Chases emails that haven't been answered* on a customer
  to stop just them chasing. Saved in `.senario` files (older files and apps are unaffected).

### Fixed

- Switching follow-ups off didn't stop chases that were already queued: they still went out.

## [0.4.0] - 2026-10-26

### Added

- **End conversation** and **Remove** on the Conversations tab. Ending marks it resolved and
  cancels its queued replies and chases; removing deletes it from the app.

## [0.3.0] - 2026-10-26

### Added

- **Send an email now** can send from an external party: choose them in the list and they
  write to the company about something within their services (an invoice, a renewal, documents
  they need). Parties still never start conversations on their own.
- **One conversation at a time:** a customer who is still in a conversation isn't picked to
  start a new one, so their emails don't overlap. On by default; switch it off under
  *Settings → Scenario behaviour*.

### Fixed

- The app icon now shows on Linux (Ubuntu showed a generic settings icon): packages include the
  standard icon sizes, and the window carries its own icon.

## [0.2.0] - 2026-10-26

### Added

- **HTML email** (now the default): messages are sent as HTML with a plain-text alternative,
  like real mail clients. Each customer and party has a consistent, era-appropriate font and
  quoting style (Outlook *From/Sent/To/Subject* block or *"On … wrote:"*), and lists are
  formatted. *Settings → Scenario behaviour → Email format* switches back to plain text.
- **Scripted injects:** a timeline of planned emails (AI-written from a brief or exact text) and
  guidance changes, fired on an exercise clock that runs in scenario time.
- **Outbox:** optionally review, edit, send or discard AI-written emails before they go out, and
  write emails yourself as any customer or party.
- **Report:** per-employee response times, unanswered mail and chases, plus conversation outcomes,
  exported as HTML or PDF.
- **Templates:** six ready-made scenarios (law firm, GP surgery, school, manufacturer, IT MSP,
  stage lighting 2005) via the new **New** button.
- **Documents:** customers and parties attach generated PDF, Word or Excel files in the format of
  the operating year (`.doc`/`.xls` before 2007).
- **Meeting invitations** (iCalendar), with accept/decline responses understood.
- **Colleagues:** contacts at the same organisation copy each other in, and a senior colleague
  can take over a chase. Customers can be generated in organisations of up to three.
- **Memory:** customers and parties remember earlier dealings.
- **Out-of-office replies** and **background mail** (newsletters, notifications).
- **Auto-updates** from GitHub Releases: downloads in the background and installs on restart
  (Windows installer, Linux AppImage/.deb/.rpm, signed macOS), or notifies with a download link
  (portable Windows, unsigned macOS). Can be switched off; `SENARIO_UPDATE_FEED` points at a
  self-hosted mirror.
- **Realistic headers:** a consistent, era-appropriate mail program per sender (X-Mailer /
  User-Agent, Message-ID shape, Outlook Thread-Index), local-time Date headers, and optional
  DKIM signing with DNS records to publish.

### Changed

- `.senario` files are now format version 2. Version 1 files still open; version 0.1.0 of
  the app can't open version 2 files.

### Fixed

- Inline styles blocked by the content security policy (message dates now align correctly).
- Quitting no longer waits up to 30 seconds for idle SMTP connections to close.

## [0.1.0] - 2026-10-06

First public release.

### Added

- **Scenario company:** define the company, its domain, description and employees yourself.
- **Customers:** generated by OpenAI from the company description and fully editable. They email
  the most relevant employee at random intervals and reply in thread, consistent with the whole
  conversation.
- **External parties:** user-defined suppliers and contractors (e.g. an accountant) who reply
  when employees email them but never start conversations.
- **SMTP-only mail flow:** customer emails are submitted to one configured mail server. Replies
  are received by a built-in SMTP listener that accepts connections only from that server and
  mail only for customer/party domains. No IMAP.
- **Follow-ups:** unanswered emails are chased with escalating tone, optionally copying in
  another member of staff. Optional for parties.
- **Pace slider:** run from real business time up to 360× faster, changeable live.
- **Attachments:** text is extracted from PDF, Word, Excel/ODS/CSV, PowerPoint, OpenDocument,
  RTF, HTML, text and forwarded emails, and images are transcribed, so customers respond to the
  content of quotes and invoices.
- **Company operating year:** run scenarios in a past year, with period-correct content, a
  scenario clock that keeps real weekdays, and optional scenario-year `Date:` headers.
- **`.senario` files:** save and open complete scenarios as SQLite files, with optional
  credentials and auto-save.
- **Activity log and Conversations view**, with attachment status and extracted text.
- **Installers** for Windows (NSIS, portable), macOS (dmg, zip) and Linux (AppImage, deb, rpm)
  via electron-builder. `.senario` files open in the app when double-clicked.

[Unreleased]: https://github.com/johnhart96/senario-manager/compare/v0.8.0...HEAD
[0.8.0]: https://github.com/johnhart96/senario-manager/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/johnhart96/senario-manager/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/johnhart96/senario-manager/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/johnhart96/senario-manager/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/johnhart96/senario-manager/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/johnhart96/senario-manager/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/johnhart96/senario-manager/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/johnhart96/senario-manager/releases/tag/v0.1.0
