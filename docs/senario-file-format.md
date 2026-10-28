# `.senario` files

A `.senario` file is a complete, portable snapshot of a scenario: settings, company, customers,
parties (with their memory), every conversation (including attachment text), queued replies and
chases, drafts awaiting review, injects, the exercise clock and the activity log. It's an ordinary **SQLite 3 database**, so besides opening it in Senario Manager
you can inspect or query it with any SQLite tool, such as
[DB Browser for SQLite](https://sqlitebrowser.org) or the `sqlite3` command line.

For how to save, open and auto-save from the app, see the
[user guide](user-guide.md#saving-opening-and-auto-save).

## Behaviour

- **Atomic writes:** a save writes a temporary file next to the target and renames it over the
  original, so a crash mid-save never leaves a half-written file.
- **Credentials** (OpenAI API key, SMTP password) are written only if you chose *Include
  credentials* on Save as. Otherwise those fields are empty strings and
  `meta.includes_credentials` is `0`. Opening such a file keeps the credentials already in the app.
- **Scheduled jobs** store the time they had *remaining* (`remaining_ms`), not an absolute time,
  so a file opened days later resumes as if no time had passed.
- **The exercise clock** is saved paused, at the time it had reached.
- **Compatibility:** version 1 files open normally; tables and columns added later open empty.
  Files from a *newer* format version are refused with a clear message (version 0.1.0 of the app
  refuses version 2 files).

## Schema (format version 2)

### `meta`

Key/value pairs describing the file.

| key | value |
|---|---|
| `format` | Always `senario`. Used to recognise the file. |
| `format_version` | `2` |
| `app_version` | Version of Senario Manager that saved it. |
| `saved_at` | ISO 8601 timestamp. |
| `includes_credentials` | `1` or `0` |

### `settings`

One row per settings section. `value` is JSON matching the [settings reference](configuration.md).

| section | Contents |
|---|---|
| `openai` | `apiKey`, `model`, `baseURL` |
| `mail` | `host`, `smtpPort`, `smtpSecurity`, `allowSelfSigned`, `smtpAuth`, `username`, `password` |
| `listener` | `bindAddress`, `port`, `offerStartTls`, `extraAllowedIps` |
| `scenario` | Timing, follow-ups, pace, guidance, customer TLD, working hours |

### `company`

A single row (`id = 1`).

| column | type | notes |
|---|---|---|
| `name`, `domain`, `description` | TEXT | |
| `operating_year` | INTEGER | `NULL` for the present day |
| `dated_emails` | INTEGER | `1` = put scenario-year dates in `Date:` headers |

### `employees`, `customers`, `parties`

Ordered by `position` (the order shown in the app).

| table | columns |
|---|---|
| `employees` | `name`, `email`, `role`, `responsibilities` |
| `customers` | `name`, `email`, `organisation`, `role`, `relationship`, `personality`, `writing_style`, `signature`, `memory` (JSON array of notes), `follow_ups` (`1`/`0`; missing in files from before 0.5.0, meaning `1`), `payment_habit` (`prompt`, `delayed` or empty for either; 0.6.0) |
| `parties` | `name`, `email`, `organisation`, `role`, `services`, `personality`, `writing_style`, `signature`, `memory` |

### `threads`

| column | notes |
|---|---|
| `id` | Thread UUID. |
| `subject` | Base subject without `Re:`/`Fwd:`. |
| `customer` | Email of the customer or party the thread is with. |
| `updated_at` | ISO 8601, real-world time of the latest message. |
| `status` | `open` or `resolved`. |
| `background` | `1` for background mail (newsletters and notifications). |
| `thread_index` | Outlook `Thread-Index` base for the conversation, if any. |
| `resolved_at` | ISO 8601 time the conversation was last resolved, for the cooldown. Added in 0.5.0. |

### `messages`

| column | notes |
|---|---|
| `thread_id`, `position` | Primary key: the message's place in its thread. |
| `message_id` | The RFC 5322 `Message-ID`, e.g. `<a1b2…@riversidetheatre.local>`. |
| `direction` | `out` = written by the app (customer/party), `in` = received from the company. |
| `from_addr`, `from_name` | Sender. |
| `to_addrs`, `cc_addrs` | JSON arrays of addresses. |
| `subject`, `body` | Body is the new text only, with quoted history stripped. |
| `date` | ISO 8601, **real-world** time sent or received (scenario-year dates are derived for display). |
| `meta` | JSON with any extra fields: `kind` (`new`, `reply`, `followup`, `inject`, `manual`, `ooo`, `background`), `exerciseMs` (exercise clock reading), `followUp` (chase number), `meeting` (invitation sent), `meetingResponse` (accept/decline received). |

### `attachments`

Text extracted from attachments on received messages. The original files aren't stored, except
forms (`form`), which are kept so they can be filled in.

| column | notes |
|---|---|
| `thread_id`, `position`, `idx` | Primary key: the message, then attachment order. |
| `filename`, `content_type`, `size` | As received. Size in bytes. |
| `kind` | `pdf`, `docx`, `doc`, `spreadsheet`, `pptx`, `opendocument`, `rtf`, `html`, `email`, `text`, `image`, or empty if unsupported. |
| `status` | `ok`, `empty`, `unsupported`, `too-large` or `error`. |
| `text` | Extracted text (up to 20,000 characters). |
| `truncated` | `1` if the text was cut short. |
| `error` | Error message when `status = 'error'`. |
| `spec` | For documents the app generated and sent: the JSON description they were rendered from (used by **Save**). |
| `sent` | `1` for documents the app sent, `0` for attachments received. |
| `form` | For a form the company sent (PDF, `.docx`, `.xlsx`/`.xls` up to 1 MB): JSON `{ fields: [{ id, label, type, options? }], data }`, `data` being the original file in base64. Added in 0.5.0. |
| `filled` | For a form sent back filled in: JSON `{ messageId, idx, answers }`, pointing at the original form and the answers given (used by **Save**). Added in 0.5.0. |

### `pending_jobs`

Customer/party replies and follow-up chases waiting to be sent.

| column | notes |
|---|---|
| `id` | Job UUID. |
| `type` | `reply`, `followup` or `payment`. |
| `customer` | Email of the customer or party who will write. |
| `thread_id` | Thread it belongs to. |
| `ref_message_id` | For `reply`: the message being answered. For `followup`: the unanswered message being chased. |
| `attempt` | Follow-up number (1, 2, …). |
| `remaining_ms` | Real milliseconds left when saved. |
| `scenario_ms` | The delay in scenario time (used for wording like "no reply for ~2 days"). |
| `data` | For `payment`: JSON `{ reference, amount, threadId, replyToId }`, the invoice being paid (amount in minor units). Added in 0.6.0. |

### `outbox`

Drafts waiting for review: `position`, `draft` (JSON: kind, sender, to, cc, subject, body,
thread and quoting references, optional document and meeting).

### `injects`

The exercise timeline: `position`, `inject` (JSON: `at` minutes, title, type, from, to, mode,
subject, body, status, firedAt).

### `state`

| key | value |
|---|---|
| `exercise` | `{ elapsedMs, startedAt }`: the exercise clock, paused |
| `dkimKeys` | DKIM keys per sender domain (`selector`, `privateKey`, `publicKey`). Lab-only keys, included so DNS records stay valid when a file is moved. |
| `bankAccount` | The company's bank account: `{ bankName, accountName, sortCode, accountNumber, currency, openingBalance, openedOn, overdraftLimit }`, amounts in minor units (pence). Added in 0.6.0; `overdraftLimit` in 0.7.0. |
| `bankOnline` | Online banking: `{ enabled, bindAddress, port, users: [{ username, name, salt, hash }] }`. `hash` is `scrypt(password, salt)` (32 bytes, hex). Kept even in files saved without credentials, since the site needs it; the passwords themselves are never stored. Added in 0.7.0. |

### `bank_transactions`

Money in and out of the company's bank account (added in 0.6.0; older files have none).

| column | notes |
|---|---|
| `position` | Order added. |
| `id` | UUID. |
| `date` | `YYYY-MM-DD`, in the operating year. |
| `amount` | Minor units (pence, cents): positive is money in, negative money out. |
| `description` | As shown on the statement, e.g. `BGC BRIGHT FOODS LTD INV-1042`. |
| `reference`, `invoice` | The invoice reference a customer paid. |
| `counterparty`, `customer` | Who paid: organisation name and email. |
| `meta` | JSON extras. For payments made in online banking: `{ payee, sortCode, accountNumber, by }` (`by` is the online banking username). Added in 0.7.0. |

### `activity_log`

| column | notes |
|---|---|
| `id` | Order. |
| `time` | ISO 8601 real-world time. |
| `level` | `send`, `recv`, `info` or `error`. |
| `message` | Log text. |

### `seen_messages`

Message-IDs the app has generated (`kind = 'sent'`) or already handled (`kind = 'processed'`).
This prevents the app answering its own mail or handling a message twice after a reload.

## Example queries

```sql
-- Conversations with the most messages
SELECT t.subject, t.customer, count(*) AS messages
FROM threads t JOIN messages m ON m.thread_id = t.id
GROUP BY t.id ORDER BY messages DESC;

-- Everything a particular employee received from customers
SELECT m.date, m.from_name, m.subject
FROM messages m
WHERE m.direction = 'out' AND m.to_addrs LIKE '%sarah.collins@%'
ORDER BY m.date;

-- Attachments the app couldn't read
SELECT filename, status, error FROM attachments WHERE status <> 'ok';

-- Strip credentials from a file before sharing it
UPDATE settings SET value = json_set(value, '$.apiKey', '') WHERE section = 'openai';
UPDATE settings SET value = json_set(value, '$.password', '') WHERE section = 'mail';
UPDATE meta SET value = '0' WHERE key = 'includes_credentials';
```

Edit files only while they aren't open in Senario Manager with auto-save on, or your changes
will be overwritten.
