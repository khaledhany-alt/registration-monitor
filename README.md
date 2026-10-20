# Registration monitor

Every hour a Claude cloud routine signs up a real test account on Daftra and Enerpize production, the same way a visitor would: it fills the form in headless Chrome, lets the page run its own reCAPTCHA, submits, and waits until the new account's owner dashboard opens. Each result goes to the **Registration Monitor** page: https://claude.ai/artifact/NXmC93o9LdaPCdNyFoG2c1

A site counts as working only if the account is created **and** the owner lands signed in on `https://<login-url>.daftra.com/…` (or `.enerpize.com`).

## How a run works

1. The routine clones this repo and runs `cloud-run.sh`, which installs dependencies, finds or downloads Chromium, and runs `monitor.js` once.
2. `monitor.js` writes one JSON file per site to `runs/outbox/`, in the shape the page reads.
3. The routine saves those files to the page's `checks` collection with Claude's ArtifactData tool, and once a day deletes checks older than 30 days.

The routine's prompt passes the phone number and email template as environment variables, so neither is in this repo.

## Reading a result

A failure names the step that broke (`load`, `fill`, `submit`, `open account`), quotes the error the page showed, and lists the pages the browser went through (without query strings, so sign-in tokens stay out).

A healthy signup goes `POST 302 /register → GET 200 <sub>/owners/firstlogin → GET 302 / → owner page`. If `firstlogin` answers `302` instead of `200`, the tenant didn't find the sign-in token and the owner ends up on the login page.

Failures before the form is submitted are retried once after 30 seconds, since no account was created yet. Failures after submit are reported straight away.

## Test accounts

Accounts are kept. Each one uses an email from `SIGNUP_EMAIL_TEMPLATE`, a login URL starting with `regmon` (`regmond…` for Daftra, `regmone…` for Enerpize), and the business name `Registration Monitor <stamp>`. The phone uses Egypt (+20) because a Saudi number can trigger the SMS OTP step, which the monitor can't complete.

## Running it locally

```bash
npm install
cp .env.example .env                                   # fill SIGNUP_PHONE and SIGNUP_EMAIL_TEMPLATE
node --env-file=.env monitor.js --dry-run              # fills and validates both forms, submits nothing
node --env-file=.env monitor.js --brand=enerpize       # one real check on one site
node --env-file=.env monitor.js --headed               # watch the browser
```

Local runs write `runs/outbox/` too but never reach the page. Exit code: `0` all working, `1` a site failed, `2` the monitor itself couldn't run.
