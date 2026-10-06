# `.senario` files

A `.senario` file is a complete, portable snapshot of a scenario: settings, company, customers,
parties, every conversation (including attachment text), queued replies and chases, and the
activity log. It's an ordinary **SQLite 3 database**, so besides opening it in Senario Manager
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
- **Compatibility:** files missing tables or columns added in later versions (`parties`,
  `attachments`, `activity_log`, `company.operating_year`) open with those parts empty. Files
  from a *newer* format version are refused with a clear message.

## Schema (format version 1)

### `meta`

Key/value pairs describing the file.

| key | value |
|---|---|
| `format` | Always `senario`. Used to recognise the file. |
| `format_version` | `1` |
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
| `customers` | `name`, `email`, `organisation`, `role`, `relationship`, `personality`, `writing_style`, `signature` |
| `parties` | `name`, `email`, `organisation`, `role`, `services`, `personality`, `writing_style`, `signature` |

### `threads`

| column | notes |
|---|---|
| `id` | Thread UUID. |
| `subject` | Base subject without `Re:`/`Fwd:`. |
| `customer` | Email of the customer or party the thread is with. |
| `updated_at` | ISO 8601, real-world time of the latest message. |

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

### `attachments`

Text extracted from attachments on received messages. The original files aren't stored.

| column | notes |
|---|---|
| `thread_id`, `position`, `idx` | Primary key: the message, then attachment order. |
| `filename`, `content_type`, `size` | As received. Size in bytes. |
| `kind` | `pdf`, `docx`, `doc`, `spreadsheet`, `pptx`, `opendocument`, `rtf`, `html`, `email`, `text`, `image`, or empty if unsupported. |
| `status` | `ok`, `empty`, `unsupported`, `too-large` or `error`. |
| `text` | Extracted text (up to 20,000 characters). |
| `truncated` | `1` if the text was cut short. |
| `error` | Error message when `status = 'error'`. |

### `pending_jobs`

Customer/party replies and follow-up chases waiting to be sent.

| column | notes |
|---|---|
| `id` | Job UUID. |
| `type` | `reply` or `followup`. |
| `customer` | Email of the customer or party who will write. |
| `thread_id` | Thread it belongs to. |
| `ref_message_id` | For `reply`: the message being answered. For `followup`: the unanswered message being chased. |
| `attempt` | Follow-up number (1, 2, …). |
| `remaining_ms` | Real milliseconds left when saved. |
| `scenario_ms` | The delay in scenario time (used for wording like "no reply for ~2 days"). |

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
