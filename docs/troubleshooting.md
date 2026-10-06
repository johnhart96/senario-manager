# Troubleshooting

Start with the **Activity** tab. Almost every problem leaves an `ERROR` or `INFO` line there
explaining what happened. The sidebar also shows whether the reply listener is running.

- [The app won't start](#the-app-wont-start)
- [The listener won't start](#the-listener-wont-start)
- [The mail server can't connect to the app](#the-mail-server-cant-connect-to-the-app)
- [Customer emails don't arrive](#customer-emails-dont-arrive)
- [Employees reply but the customer never answers](#employees-reply-but-the-customer-never-answers)
- [A reply appears as a new conversation](#a-reply-appears-as-a-new-conversation)
- [OpenAI errors](#openai-errors)
- [Attachments](#attachments)
- [Files and saving](#files-and-saving)

## The app won't start

### The app won't start on Linux (SUID sandbox helper)

```
The SUID sandbox helper binary was found, but is not configured correctly…
```

Ubuntu 24.04+ (AppArmor) and some other distributions block Chromium's sandbox for apps outside
system packages.

- **Installed from `.deb`/`.rpm`:** this shouldn't happen. Reinstall the package.
- **AppImage:** run it with `--no-sandbox`.
- **From source:** fix the helper's permissions once:
  ```bash
  sudo chown root:root node_modules/electron/dist/chrome-sandbox
  sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
  ```
  or, on an isolated lab machine, run `npm start -- --no-sandbox`.

### `TypeError: Cannot read properties of undefined (reading 'whenReady')`

Electron is running as plain Node because `ELECTRON_RUN_AS_NODE` is set. VS Code's integrated
terminal sets it. Use `npm start`, which clears it, or run
`env -u ELECTRON_RUN_AS_NODE npx electron .`.

### Windows: "Windows protected your PC"

The build is unsigned. Click **More info → Run anyway**.

### macOS: "Senario Manager is damaged and can't be opened" or "unidentified developer"

The build is unsigned. Right-click the app → **Open**, or run
`xattr -cr "/Applications/Senario Manager.app"`.

### Opening the app just focuses an existing window

Only one copy runs at a time, because two would fight over the SMTP port. Opening another
`.senario` file hands it to the running window.

## The listener won't start

The sidebar shows **Listener failed** with the reason. Click **Retry** once it's fixed.

| Message | Fix |
|---|---|
| `No permission to listen on port 25` | Linux only lets root use ports below 1024. See [Allow port 25](installation.md#allow-port-25-linux-only). |
| `Port 25 is already in use by another service` | Another mail server is running on this machine (Postfix, Exim, sendmail, IIS SMTP, hMailServer…). Stop it, or pick another listener port and point the mail server's routes at it. Find it with `sudo ss -ltnp \| grep ':25 '` (Linux), `sudo lsof -iTCP:25 -sTCP:LISTEN` (macOS) or `netstat -ano \| findstr :25` (Windows). |
| `No mail server configured` | Enter the mail server under **Settings → Scenario mail server**. The listener needs it to know who may connect. |
| `getaddrinfo ENOTFOUND <host>` | The mail server's hostname doesn't resolve from this machine. Use its IP address. |

## The mail server can't connect to the app

Test from the mail server with `telnet <app-ip> 25`.

**`Connection refused` or a timeout.** The connection never reached the app.

1. Is the app running and the sidebar showing **Listening**? The listener only exists while the
   app is open.
2. Is a firewall on the app's machine blocking it? This is the most common cause.
   - Linux: `sudo ufw status`. If it's active, run `sudo ufw allow from <mail-server-ip> to any port 25 proto tcp`.
     A blocked connection counts against `ufw-reject-input` in `sudo nft list ruleset`.
   - Windows: allow the app in Windows Defender Firewall (see [Installation](installation.md#windows)).
   - macOS: System Settings → Network → Firewall → allow Senario Manager.
3. Are you connecting to the right address? Use the app machine's LAN IP, not a VPN or Tailscale
   address, unless the mail server routes through it.
4. Is something between the two machines filtering port 25 (a network firewall or security group)?

**`554 5.7.1 Access denied: <ip> is not an allowed mail server`.** The connection reached the
app, but it came from an address other than the configured mail server. That's expected if you
test from another machine. If `<ip>` really is the mail server (it has several addresses, or
sits behind NAT or a Docker network), add it under **Settings → Reply listener → Also accept
from IPs**.

## Customer emails don't arrive

1. Click **Settings → Test SMTP**.
2. Check Activity for `Generate failed` or `Reply failed` lines.

| Symptom | Fix |
|---|---|
| `Greeting never received` / timeout | Wrong host or port, or a firewall between the app and the mail server. |
| TLS errors (`wrong version number`, `self-signed certificate`) | Match **Security** to the server: `None`, `STARTTLS` or `TLS`. Tick *Accept self-signed certificates* for lab CAs. |
| `530 Authentication required` | Tick *Server requires authentication* and enter credentials. |
| `550/554` relay or recipient rejected | The recipient must exist on the mail server. Employee addresses in the app must match real mailboxes. |
| Accepted, but nothing in the mailbox | Check the server's spam filter, quarantine, greylisting and SPF/DMARC policies, and whitelist the app's IP. See [Mail server setup](mail-server-setup.md#3-let-the-apps-mail-in). |
| `Refusing to send to address(es) outside the company` | By design, customers only email addresses on the company's domain. Check the employees' addresses and the company domain. |
| `Model returned an empty email` | A transient model hiccup. It retries on the next interval. |

## Employees reply but the customer never answers

Look at the Activity line after the `RECV`:

| Activity says | Meaning |
|---|---|
| *"will reply once the scenario is started"* | The scenario is stopped. Click **Start scenario**. |
| *"will reply in ~N min"* | Working as intended. Lower the reply delay, or raise the [pace](user-guide.md#pace). |
| *"considers … finished; no reply"* | The AI judged the conversation over (e.g. a final "thanks"). Write again to reopen it. |
| *"No customer persona for …"* | The address isn't a known customer or party. Check spelling, or add them. |
| *"Sender … is outside the company domain"* | The reply came from an address not on the company domain. Add that employee or domain. |
| *"Ignored automatic reply"* | Out-of-office and other auto-replies are deliberately ignored. |
| `Bounce/notification received` | The mail server sent a bounce, often because a route is missing. |
| No `RECV` line at all | The reply never reached the app. Check the routes and the [section above](#the-mail-server-cant-connect-to-the-app). Look in the mail server's queue: mail it couldn't deliver to the app is retried there. |

## A reply appears as a new conversation

Replies are matched by their `In-Reply-To`/`References` headers. Some clients and servers
(notably some Exchange setups) drop them. The app then falls back to matching by **subject
plus customer**. If the employee also changed the subject, the reply starts a new thread, but
the customer still answers it.

## OpenAI errors

| Error | Fix |
|---|---|
| `401 Incorrect API key` | Re-enter the key under Settings → OpenAI and click **Test OpenAI**. |
| `429 Rate limit` / `insufficient_quota` | Add credit or raise limits in your OpenAI account, or slow the [pace](user-guide.md#pace). |
| `404 model not found` | Check the model name and that your account can use it. |
| `response_format … not supported` | Choose a model that supports JSON output. |
| Image attachment `could not be read` | The model doesn't accept images. Use one that does, e.g. `gpt-4.1-mini`. |
| Network errors behind a proxy | The app has no HTTP proxy setting. Point **Base URL** at an OpenAI-compatible gateway that is reachable directly. |

## Attachments

| Status in Conversations | Meaning |
|---|---|
| *no readable text (scanned?)* | A scanned PDF or image-only document with no text layer. Send it as an image instead, or as a text-based PDF. |
| *type not supported* | Archives (`.zip`), executables and other formats aren't read. |
| *too large* | Over 25 MB. |
| *could not be read* | Corrupt, password-protected or malformed. Hover for the error. |

## Files and saving

| Problem | Fix |
|---|---|
| Sidebar shows **Save failed** | The file's folder is gone or read-only (e.g. an unplugged USB drive). Use **Save as** somewhere else. |
| `not a valid .senario file` | The file isn't a Senario Manager scenario, or it's damaged. |
| `saved by a newer version` | Update Senario Manager. |
| Credentials missing after opening a file | The file was saved without credentials, so the app kept its current ones. If those were empty, re-enter them. |
| Changes made in an SQLite tool disappeared | The app auto-saved over them. Close the file in the app (✕) before editing it externally. |

## Still stuck?

[Open an issue](https://github.com/YOUR-USER/senario-manager/issues/new/choose) with your OS,
app version, mail server type and the relevant Activity lines. Remove any real addresses, keys
or passwords first.
