# Email Marketing — Amazon SES setup (EU/GDPR)

The marketing-email code ships **behind config**: with the `SES_*` env vars unset, nothing sends and
the app is unaffected. This runbook is the one-time AWS + DNS + env setup needed before real sends.
Region throughout: **`eu-central-1` (Frankfurt)** for EU data residency.

> ⚠️ Prerequisite: a **public HTTPS domain** for AdsFlow. The SNS webhook and the RFC 8058
> unsubscribe links both require HTTPS — the bare-IP `http://…:3000` prod URL will not work for
> go-live. Set `APP_PUBLIC_URL` to that HTTPS origin.

---

## 1. Verify the sending domain (SES → Verified identities)

1. SES console (eu-central-1) → **Verified identities → Create identity → Domain**, e.g.
   `mail.adsflow.app` (a dedicated subdomain keeps marketing reputation separate).
2. Enable **Easy DKIM** (RSA 2048) → SES gives **3 CNAME** records → publish them in DNS.
3. Add **SPF** (TXT on the sending domain): `v=spf1 include:amazonses.com ~all`
4. Add **DMARC** (TXT at `_dmarc.mail.adsflow.app`): start with
   `v=DMARC1; p=none; rua=mailto:dmarc@adsflow.app` → tighten to `p=quarantine` then `p=reject`.
5. (Optional, recommended) **Custom MAIL FROM** subdomain (e.g. `bounce.mail.adsflow.app`) → publish the
   SES-provided single MX + SPF records.

Wait until the identity shows **Verified** and DKIM **Successful**.

## 2. Leave the sandbox (production access)

New SES accounts are sandboxed: 1 msg/s, 200/day, verified recipients only. Request production access:
SES console → **Account dashboard → Request production access** → mail type **Marketing** → provide the
website, use-case, and confirm you only mail opted-in recipients. Approval typically < 24h.

## 3. Configuration set + event publishing (SNS)

1. SES → **Configuration sets → Create**, e.g. `marketing-newsletter`.
2. Add an **event destination → Amazon SNS**; publish: `Bounce`, `Complaint`, `Delivery`, `Open`, `Click`.
3. Create the SNS topic; subscribe the AdsFlow webhook (HTTPS):
   `https://<APP_PUBLIC_URL>/api/v1/email/webhooks/ses`
   The webhook auto-confirms the subscription (it fetches `SubscribeURL`) and validates every message
   signature, so no manual confirmation step is needed.
4. Enable account-level suppression: `aws sesv2 put-account-suppression-attributes --suppressed-reasons BOUNCE COMPLAINT`
   (safety net on top of the app's own `email_suppressions`).

## 4. IAM credentials

Create an IAM user (or role) with a minimal policy and put the key in env:
```json
{ "Effect": "Allow", "Action": ["ses:SendEmail", "ses:SendRawEmail"], "Resource": "*" }
```
(SESv2 `SendEmail` with Raw content is what the adapter uses.)

## 5. Environment variables (backend)

| Var | Example | Notes |
|-----|---------|-------|
| `SES_REGION` | `eu-central-1` | default if unset |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | … | omit to use an instance IAM role |
| `SES_FROM_EMAIL` | `news@mail.adsflow.app` | **required** — part of the `isConfigured()` gate |
| `SES_FROM_NAME` | `AdsFlow` | optional default From name |
| `SES_REPLY_TO` | `support@adsflow.app` | optional |
| `SES_CONFIGURATION_SET` | `marketing-newsletter` | enables event publishing/suppression |
| `SES_MAX_SEND_RATE` | `14` | messages/sec (≤ your SES account rate); batch size = this, 1 batch/sec |
| `COMPANY_POSTAL_ADDRESS` | `West&East GmbH, …` | **legally required** footer (EU/CAN-SPAM) |
| `APP_PUBLIC_URL` | `https://app.adsflow.app` | base for unsubscribe + webhook URLs (must be HTTPS) |

Set these in the prod environment (do **not** commit `.env`). Restart the backend to pick them up;
`ses.isConfigured()` becomes true and `send`/`test` start working.

## 6. Verify end-to-end (sandbox first)

1. Import 2–3 **SES-verified** test addresses (Email page → Contacts → Import, with a consent source).
2. Create a campaign → **Send test** to a verified address → confirm receipt + the unsubscribe footer.
3. **Send** the campaign → check `email_sends` rows get `ses_message_id` and counters climb.
4. Trigger a bounce: send to `bounce@simulator.amazonses.com` → confirm the webhook marks it `bounced`
   and adds an `email_suppressions` row.
5. Click the email's **List-Unsubscribe** → confirm the contact flips to `unsubscribed` + a suppression row.
6. Deliverability sanity: send to a mail-tester.com address → SPF/DKIM/DMARC all pass.

## 7. Reputation hygiene (ongoing)

- Keep **bounce rate < 5%** and **complaint rate < 0.1%** (SES pauses accounts above thresholds).
- Only ever send to consented contacts; honor unsubscribes immediately (the app does this automatically).
- If volume grows, consider a **dedicated IP pool** + SES-guided warm-up on the configuration set.

## Compliance notes (EU)
- **GDPR / UWG §7 (DE)**: B2C marketing generally needs **double opt-in**. This release imports
  already-consented contacts and stores the consent proof (`consent_source`/`consent_at`/`consent_ip`);
  a public opt-in + confirmation flow can be added later, reusing this stack.
- Every email carries the postal address + one-click unsubscribe (RFC 8058) automatically.
