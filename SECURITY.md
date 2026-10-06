# Security policy

## Reporting a vulnerability

Please **don't** open a public issue for security problems. Instead, use GitHub's private
vulnerability reporting: go to the repository's **Security** tab and click **Report a
vulnerability**
([direct link](https://github.com/YOUR-USER/senario-manager/security/advisories/new)).

Include what you found, how to reproduce it, and the impact you expect. You should get a
response within a week. Fixes are released as soon as practical and credited to you unless you
prefer otherwise.

## Supported versions

Only the latest release receives security fixes.

## Scope

Senario Manager talks to a mail server, runs an SMTP listener, calls the OpenAI API and parses
attachments from email, so these areas matter most:

- **Containment:** any way to make the app send mail to a host other than the configured mail
  server, to recipients outside the company's domains, or to accept SMTP connections from
  addresses other than the mail server.
- **The SMTP listener:** crashes, resource exhaustion or bypassing its IP and recipient checks.
- **Attachment parsing:** escaping the worker thread's time and memory limits, or code execution
  through crafted files.
- **Credentials:** exposure of the OpenAI API key or SMTP password (including through `.senario`
  files saved *without* credentials).
- **The UI:** script injection from email content, attachment text or `.senario` files.

Weaknesses in third-party dependencies should be reported upstream. Let us know too if Senario
Manager is affected and needs an update.

## Intended deployment

Senario Manager is built for **isolated lab, training and scenario networks**. Run it on such
networks only. Restrict its SMTP listener to the mail server with a host firewall (see
[Installation](docs/installation.md#firewall)), and don't expose it to the internet.
