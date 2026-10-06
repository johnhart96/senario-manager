# Settings reference

Every setting in the app, with its default. Settings are saved with **Save settings** and stored
in the app's data folder and in `.senario` files. Times marked *(scenario time)* are divided by
the [pace](user-guide.md#pace).

## Scenario mail server (outbound)

Where customer and party emails are submitted.

| Setting | Default | Description |
|---|---|---|
| Hostname or IP | *(empty)* | The scenario mail server. The **only** host the app sends to. No MX lookups. |
| SMTP port | `25` | Port on the mail server. |
| Security | `STARTTLS` | `None`, `STARTTLS` (required) or `TLS (SMTPS)`. |
| Accept self-signed certificates | on | Skip certificate validation. Typical for lab CAs. |
| Server requires authentication | off | Log in before sending. |
| Username / Password | *(empty)* | Used only when authentication is on. The password is encrypted at rest. |

## Reply listener (inbound)

The app's own SMTP server, which receives mail for customer and party domains.

| Setting | Default | Description |
|---|---|---|
| Listen address | `0.0.0.0` | Interface to listen on (`0.0.0.0` = all). |
| Listen port | `25` | Port the mail server delivers to. On Linux, ports below 1024 need [extra setup](installation.md#allow-port-25-linux-only). |
| Also accept from IPs | *(empty)* | Extra source addresses allowed to connect, comma separated. The mail server's own address(es) are always allowed: an IP is used as-is and a hostname is resolved when the listener starts. |
| Offer STARTTLS | on | Offer TLS with a built-in self-signed certificate. Turn off if the mail server insists on validating certificates. |

Fixed behaviour:

- Recipients must be on a customer or party domain, otherwise `550 No such user here`.
- Connections from any other IP are refused with `554 5.7.1 Access denied`.
- Messages are limited to 25 MB.

The listener starts when the app opens and stays up whether or not the scenario is running.
Changing these settings, or the mail server address, rebinds it immediately.

## OpenAI

| Setting | Default | Description |
|---|---|---|
| API key | *(empty)* | Your OpenAI API key, encrypted at rest. |
| Model | `gpt-4.1-mini` | Any chat-completions model that supports JSON output. To read image attachments it must also accept images. |
| Base URL | *(empty)* | Optional. Point at an OpenAI-compatible endpoint (a proxy, Azure OpenAI gateway or local server). |

## Scenario behaviour

| Setting | Default | Description |
|---|---|---|
| Fictional TLD for customer domains | `local` | Generated customers get domains like `brightfoods.local`. |
| Email format | HTML | **HTML (with plain-text copy)** sends `multipart/alternative` messages, as real mail clients do. **Plain text only** sends text. See [Email format](user-guide.md#email-format). |
| Extra guidance for customers | *(empty)* | Free text added to every customer and party prompt. See [extra guidance](user-guide.md#extra-guidance). |
| New customer email every … to … (min) | `20` – `90` | Random interval between new conversations *(scenario time)*. |
| Customer reply delay … to … (sec) | `900` – `7200` | How long customers and parties take to answer (15 min – 2 h) *(scenario time)*. |
| Working day starts / ends (hour) | `8` / `18` | Used with the option below. |
| Only send new emails and follow-ups during working hours | off | New emails and chases only Mon–Fri within those hours. Replies are still sent. Applies only at real-time pace. |

## Follow-ups

| Setting | Default | Description |
|---|---|---|
| Customers chase emails that haven't been answered | on | Enables chasing. |
| Chase after … to … (hours) | `4` – `24` | Wait before the first chase *(scenario time)*. Each later chase waits 50% longer. |
| Max follow-ups per email | `2` | Chases per unanswered email. |
| External parties also chase … | off | Lets parties chase questions they asked that went unanswered. |

## Pace (sidebar)

| Setting | Default | Description |
|---|---|---|
| Customer pace | Real time (1×) | 1×, 2×, 5×, 10×, 30×, 60×, 120× or 360×. Divides every *(scenario time)* delay. Applies live. |

## Company tab

| Setting | Default | Description |
|---|---|---|
| Company operating year | *(empty = present day)* | 1980–2100. See [Operating year](user-guide.md#operating-year). |
| Date emails in the operating year | on | Put scenario-year dates in `Date:` headers. |

## Where settings are stored

- The app's data folder: see [Installation → Where your data lives](installation.md#where-your-data-lives).
- `.senario` files: every section is stored in the `settings` table. Credentials are only
  included if you chose to on *Save as*. See [.senario files](senario-file-format.md).
