-- Visual block-based campaign editor + true SMTP attachments.
-- content_blocks: NULL = legacy/raw-HTML campaign (edited via the HTML textarea fallback);
--   populated {version, blocks:[...]} = block-editor mode. html_body always stays the
--   compiled/final HTML the send pipeline (dispatch.js/brevo.js) reads — unaffected either way.
-- attachments: true SMTP attachments (small files only, size-capped in the route layer),
--   distinct from hosted-link uploads which are just URLs referenced from block content.
ALTER TABLE email_campaigns
  ADD COLUMN IF NOT EXISTS content_blocks JSONB,
  ADD COLUMN IF NOT EXISTS attachments    JSONB NOT NULL DEFAULT '[]'::jsonb;
