-- ─── Workspace Invitations ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS workspace_invitations (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email        TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT 'analyst',
  token        TEXT NOT NULL UNIQUE,
  invited_by   UUID REFERENCES users(id),
  user_id      UUID REFERENCES users(id),
  is_new_user  BOOLEAN NOT NULL DEFAULT false,
  accepted_at  TIMESTAMPTZ,
  expires_at   TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '7 days',
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workspace_invitations_token ON workspace_invitations(token);
CREATE INDEX IF NOT EXISTS idx_workspace_invitations_email ON workspace_invitations(email);
