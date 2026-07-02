# Email Marketing setup

The marketing-email code ships **behind config**: with the active provider's env vars unset,
`send`/`test` return `400` and the app is otherwise unaffected.

**Prod runs on Brevo SMTP relay** (`EMAIL_PROVIDER=brevo`, the default). The original Amazon SES
adapter (`services/email/ses.js`) is still present and selectable via `EMAIL_PROVIDER=ses`, but has
no attachment support and never left AWS's sandbox in this account — treat it as a legacy fallback,
not the primary path. This doc covers Brevo setup + the one manual step needed for delivery/open/
click/bounce tracking to work; the SES runbook is kept at the bottom for reference.

---

## 1. Brevo setup (primary — what prod actually uses)

1. **SMTP credentials**: Brevo dashboard → SMTP & API → SMTP tab. Set in the backend env:
   | Var | Example | Notes |
   |-----|---------|-------|
   | `EMAIL_PROVIDER` | `brevo` | default if unset |
   | `BREVO_SMTP_LOGIN` | `info@yourdomain.com` | the account's SMTP login |
   | `BREVO_SMTP_KEY` | `xsmtpsib-...` | SMTP key, **not** a REST API key — see note below |
   | `BREVO_SMTP_HOST` | `smtp-relay.brevo.com` | default if unset |
   | `BREVO_SMTP_PORT` | `587` | default if unset |
   | `MAIL_FROM_EMAIL` | `info@yourdomain.com` | **required** — part of `isConfigured()`; must be a verified sender in Brevo |
   | `MAIL_FROM_NAME` | `Your Company` | optional default From name |
   | `MAIL_REPLY_TO` | `support@yourdomain.com` | optional |
   | `EMAIL_DAILY_CAP` | `250` | account-wide daily send budget enforced by `dispatch.dripSend()` — Brevo's free plan hard-caps the WHOLE account (marketing + transactional) at 300/day, so this should stay comfortably below that |
   | `COMPANY_POSTAL_ADDRESS` | `Company GmbH, …` | **legally required** footer (EU/CAN-SPAM) |
   | `APP_PUBLIC_URL` | `https://app.yourdomain.com` | base for unsubscribe + public asset URLs |

   > ⚠️ The SMTP key does **not** double as a Brevo REST API key in every account (confirmed on this
   > one: `GET /v3/account` with the SMTP key → `401 Key not found`). If you need the REST API for
   > anything (e.g. programmatic webhook registration), generate a separate key under
   > SMTP & API → API Keys.

2. **Sender verification**: Brevo → Senders, Domains & Dedicated IPs → verify the `MAIL_FROM_EMAIL`
   sender/domain (SPF/DKIM records Brevo provides). Sends from an unverified sender are rejected or
   heavily deliverability-penalized.

3. **Tracking must be enabled** on the account for opens/clicks to be tracked at all (Brevo dashboard,
   usually on by default for new accounts — check under account/domain settings if opens never register
   despite the webhook below being correctly configured).

## 2. Webhook — required for delivered/opened/clicked/bounced/complained/unsubscribed stats

Without this, campaign stats only ever show `recipients`/`sent` — every other counter stays at 0
regardless of what actually happens to a campaign. **This step must be done manually in Brevo's
dashboard**; it can't be automated from this app's code (see the REST-API-key note above).

1. The app already tags every recipient at send time (`X-Mailin-Tag` SMTP header = the send's own
   `email_sends.id`) and generates+stores a shared secret in `BREVO_WEBHOOK_SECRET` (auto-generated on
   first deploy of this feature; check the backend `.env` for the current value, or set your own —
   any random string works, it's just a URL-embedded auth token since Brevo doesn't sign webhook
   payloads).
2. Brevo dashboard → **Transactional → Settings → Webhook** → add a new webhook:
   - URL: `https://<APP_PUBLIC_URL host>/api/v1/email/webhooks/brevo?token=<BREVO_WEBHOOK_SECRET>`
   - Events: `delivered`, `opened`, `click`, `hard_bounce`, `soft_bounce`, `blocked`, `spam`
     (`unsubscribed` too, though it's unlikely to ever fire — this app's emails carry their own RFC 8058
     unsubscribe link, not a Brevo-hosted one)
3. Verify: send a campaign test, wait a few seconds, `GET /campaigns/:id/stats` — `delivered` (and
   `opened` once you open the test email) should now be non-zero instead of stuck at 0.

**Testing note**: always verify the send pipeline via `POST /campaigns/:id/test` (single explicit
recipient) — never `POST /campaigns/:id/send`, which has no dry-run mode and immediately targets the
campaign's real, full audience (or its segment) with no confirmation step.

## 3. Environment summary (backend, Brevo path)

```
EMAIL_PROVIDER=brevo
BREVO_SMTP_LOGIN=...
BREVO_SMTP_KEY=...
MAIL_FROM_EMAIL=...
MAIL_FROM_NAME=...
MAIL_REPLY_TO=...
EMAIL_DAILY_CAP=250
BREVO_WEBHOOK_SECRET=...
COMPANY_POSTAL_ADDRESS=...
APP_PUBLIC_URL=https://...
```
Set these in the prod environment (do **not** commit `.env`). Restart the backend to pick them up.

## 4. Reputation hygiene (ongoing)

- Keep bounce/complaint rates low — Brevo throttles or suspends accounts that trend high.
- Only ever send to consented contacts; honor unsubscribes immediately (the app does this
  automatically).
- The daily budget (`EMAIL_DAILY_CAP`) drains a large campaign over several days rather than bursting
  — this is intentional, not a bug, given the free-plan account-wide cap.

## Compliance notes (EU)
- **GDPR / UWG §7 (DE)**: B2C marketing generally needs **double opt-in**. This app imports
  already-consented contacts and stores the consent proof (`consent_source`/`consent_at`/`consent_ip`);
  a public opt-in + confirmation flow can be added later, reusing this stack.
- Every email carries the postal address + one-click unsubscribe (RFC 8058) automatically.

---

## Appendix: Amazon SES setup (legacy, `EMAIL_PROVIDER=ses`)

Region throughout: **`eu-central-1` (Frankfurt)** for EU data residency, if you go this route.

### 1. Verify the sending domain (SES → Verified identities)

1. SES console (eu-central-1) → **Verified identities → Create identity → Domain**, e.g.
   `mail.yourdomain.com` (a dedicated subdomain keeps marketing reputation separate).
2. Enable **Easy DKIM** (RSA 2048) → SES gives **3 CNAME** records → publish them in DNS.
3. Add **SPF** (TXT on the sending domain): `v=spf1 include:amazonses.com ~all`
4. Add **DMARC** (TXT at `_dmarc.mail.yourdomain.com`): start with
   `v=DMARC1; p=none; rua=mailto:dmarc@yourdomain.com` → tighten to `p=quarantine` then `p=reject`.
5. (Optional, recommended) **Custom MAIL FROM** subdomain → publish the SES-provided MX + SPF records.

### 2. Leave the sandbox (production access)

New SES accounts are sandboxed: 1 msg/s, 200/day, verified recipients only. Request production access:
SES console → **Account dashboard → Request production access** → mail type **Marketing**.

### 3. Configuration set + event publishing (SNS)

1. SES → **Configuration sets → Create**.
2. Add an **event destination → Amazon SNS**; publish: `Bounce`, `Complaint`, `Delivery`, `Open`, `Click`.
3. Create the SNS topic; subscribe: `https://<APP_PUBLIC_URL>/api/v1/email/webhooks/ses`
   (auto-confirms the subscription and validates every message signature).
4. `aws sesv2 put-account-suppression-attributes --suppressed-reasons BOUNCE COMPLAINT`

### 4. Environment variables

| Var | Notes |
|-----|-------|
| `EMAIL_PROVIDER` | `ses` |
| `SES_REGION` | default `eu-central-1` |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | omit to use an instance IAM role |
| `SES_FROM_EMAIL` | required |
| `SES_FROM_NAME`, `SES_REPLY_TO` | optional |
| `SES_CONFIGURATION_SET` | enables event publishing/suppression |
| `SES_MAX_SEND_RATE` | messages/sec; batch size = this |

IAM policy: `{ "Effect": "Allow", "Action": ["ses:SendEmail", "ses:SendRawEmail"], "Resource": "*" }`
