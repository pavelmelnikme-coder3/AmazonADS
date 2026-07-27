-- Lead Finder: business prospecting tool, separate from Amazon Ads.
-- Searches OpenStreetMap (Nominatim geocoding + Overpass business search) for local
-- businesses by region + free-text query, then scrapes public emails from their
-- websites. Results are NOT opted-in contacts — kept in their own tables until the
-- user explicitly promotes found emails into email_contacts (see routes/leadFinder.js).

CREATE TABLE IF NOT EXISTS lead_searches (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  region_query   TEXT        NOT NULL,
  business_query TEXT        NOT NULL,
  bbox           JSONB,                          -- {south,west,north,east} from Nominatim
  result_count   INTEGER     NOT NULL DEFAULT 0,
  created_by     UUID,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_lead_searches_ws ON lead_searches(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS lead_results (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  search_id         UUID        NOT NULL REFERENCES lead_searches(id) ON DELETE CASCADE,
  workspace_id      UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  osm_type          TEXT        NOT NULL,        -- node | way
  osm_id            BIGINT      NOT NULL,
  name              TEXT,
  category          TEXT,                        -- amenity/shop/cuisine value picked for display
  address           TEXT,
  lat               DOUBLE PRECISION,
  lon               DOUBLE PRECISION,
  website           TEXT,
  phone             TEXT,
  emails            TEXT[]      NOT NULL DEFAULT '{}',
  scrape_status     TEXT        NOT NULL DEFAULT 'pending', -- pending|found|no_email|no_website|error
  scraped_at        TIMESTAMPTZ,
  added_to_contacts BOOLEAN     NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_lead_results_osm ON lead_results(workspace_id, osm_type, osm_id);
CREATE INDEX IF NOT EXISTS idx_lead_results_search ON lead_results(search_id);
CREATE INDEX IF NOT EXISTS idx_lead_results_pending ON lead_results(search_id, scrape_status) WHERE scrape_status = 'pending';
