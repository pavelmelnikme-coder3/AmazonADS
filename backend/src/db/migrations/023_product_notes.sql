CREATE TABLE IF NOT EXISTS product_notes (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  product_id   UUID REFERENCES products(id) ON DELETE CASCADE, -- NULL = global (all products)
  note_date    DATE NOT NULL DEFAULT CURRENT_DATE,
  text         TEXT NOT NULL,
  created_by   UUID REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS product_notes_ws_idx ON product_notes(workspace_id, note_date DESC);
CREATE INDEX IF NOT EXISTS product_notes_product_idx ON product_notes(product_id, note_date DESC);
