-- Marketing / bulk email subsystem (Amazon SES, EU/GDPR).
-- Fully separate from the transactional Brevo path. All tables are workspace-scoped.
-- Consent proof is stored on every contact; unsubscribe + suppression are first-class.

-- ── Contacts (the subscriber list) ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS email_contacts (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email            TEXT        NOT NULL,
  first_name       TEXT,
  last_name        TEXT,
  attributes       JSONB       NOT NULL DEFAULT '{}',   -- merge tags: {{first_name}}, {{company}}, ...
  tags             TEXT[]      NOT NULL DEFAULT '{}',
  status           TEXT        NOT NULL DEFAULT 'active', -- active | unsubscribed | bounced | complained
  -- GDPR consent proof (where/when/how consent was obtained)
  consent_source   TEXT,
  consent_method   TEXT,        -- e.g. import | api | form
  consent_at       TIMESTAMPTZ,
  consent_ip       TEXT,
  unsubscribe_token TEXT       NOT NULL,                 -- opaque, unguessable (RFC 8058 link)
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- One contact per address per workspace (case-insensitive).
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_contacts_ws_email ON email_contacts(workspace_id, lower(email));
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_contacts_unsub_token ON email_contacts(unsubscribe_token);
CREATE INDEX IF NOT EXISTS idx_email_contacts_ws_status ON email_contacts(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_email_contacts_tags ON email_contacts USING GIN (tags);

-- ── Segments (a saved filter over contacts) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS email_segments (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         TEXT        NOT NULL,
  filter       JSONB       NOT NULL DEFAULT '{}',        -- { tags: [...], status: 'active' }
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_email_segments_ws ON email_segments(workspace_id);

-- ── Campaigns ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS email_campaigns (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name          TEXT        NOT NULL,
  subject       TEXT        NOT NULL DEFAULT '',
  from_name     TEXT,
  from_email    TEXT,
  reply_to      TEXT,
  html_body     TEXT        NOT NULL DEFAULT '',
  segment_id    UUID        REFERENCES email_segments(id) ON DELETE SET NULL, -- NULL = all active
  status        TEXT        NOT NULL DEFAULT 'draft',     -- draft|scheduled|sending|sent|paused|failed
  scheduled_at  TIMESTAMPTZ,
  sent_at       TIMESTAMPTZ,
  -- counters
  recipients    INTEGER     NOT NULL DEFAULT 0,
  sent          INTEGER     NOT NULL DEFAULT 0,
  delivered     INTEGER     NOT NULL DEFAULT 0,
  opened        INTEGER     NOT NULL DEFAULT 0,
  clicked       INTEGER     NOT NULL DEFAULT 0,
  bounced       INTEGER     NOT NULL DEFAULT 0,
  complained    INTEGER     NOT NULL DEFAULT 0,
  unsubscribed  INTEGER     NOT NULL DEFAULT 0,
  created_by    UUID        REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_email_campaigns_ws ON email_campaigns(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_campaigns_scheduled ON email_campaigns(status, scheduled_at)
  WHERE status = 'scheduled';

-- ── Per-recipient send log (idempotency + tracking) ─────────────────────────
CREATE TABLE IF NOT EXISTS email_sends (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id    UUID        NOT NULL REFERENCES email_campaigns(id) ON DELETE CASCADE,
  contact_id     UUID        NOT NULL REFERENCES email_contacts(id) ON DELETE CASCADE,
  email          TEXT        NOT NULL,
  status         TEXT        NOT NULL DEFAULT 'queued',  -- queued|sent|delivered|bounced|complained|opened|clicked|failed|suppressed
  ses_message_id TEXT,
  error          TEXT,
  sent_at        TIMESTAMPTZ,
  delivered_at   TIMESTAMPTZ,
  opened_at      TIMESTAMPTZ,
  clicked_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- One send row per (campaign, contact) → guarantees no double-send on retry.
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_sends_campaign_contact ON email_sends(campaign_id, contact_id);
CREATE INDEX IF NOT EXISTS idx_email_sends_message ON email_sends(ses_message_id);
CREATE INDEX IF NOT EXISTS idx_email_sends_campaign_status ON email_sends(campaign_id, status);

-- ── Suppression list (never-send) ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS email_suppressions (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email             TEXT        NOT NULL,
  reason            TEXT        NOT NULL,                 -- unsubscribe | hard_bounce | complaint | manual
  source_campaign_id UUID       REFERENCES email_campaigns(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_suppressions_ws_email ON email_suppressions(workspace_id, lower(email));
