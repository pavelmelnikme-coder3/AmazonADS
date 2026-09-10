-- A name for the ASINs Amazon will not give one for.
--
-- 276 of 551 active products carry no `title`: their listings are dead in the DE catalogue, so
-- the scraper has nothing to fetch and never will. They show in the app as a bare ASIN — a row in
-- Analytics reading "B0H6XVKLR7" and nothing else. 66 of them are articles in the company's own
-- ERP, which knows perfectly well what they are.
--
-- `products.title` stays what it says it is: the Amazon listing title. This is a separate name,
-- resolved from Wawi, that the app can fall back to for display. Keeping them apart matters —
-- writing the ERP name into `title` would also stop the scraper from ever trying again, and a
-- real listing title is the better one when it exists.

-- Wawi names carry warehouse bookkeeping at the front: "Lagerartikel_FBA_eBay_50 Paar …",
-- "FBM_50 Paar …", "ANGEBOT_Björn&Schiller …", "FBM Kopie von OP-Masken …". None of it means
-- anything to someone reading a dashboard. Stripped repeatedly, because they stack.
--
-- Deliberately NOT stripped: a leading "SET " — in "SET Elektrischer Kohleanzünder + 4Kg Kohle"
-- the word is part of what the product is.
CREATE OR REPLACE FUNCTION wawi_display_name(raw TEXT) RETURNS TEXT AS $$
DECLARE
  out_name TEXT := btrim(COALESCE(raw, ''));
  prev     TEXT := '';
BEGIN
  -- Loop until nothing more comes off, so chained prefixes collapse in one go.
  WHILE out_name <> prev LOOP
    prev := out_name;
    out_name := regexp_replace(
      out_name,
      '^(Lagerartikel|FBA|FBM|eBay|Amazon|AMZ(\s+USA)?|AMAZON)?\s*(ANGEBOT|Angebot)?[\s_]*(Kopie\s+von)?[\s_]+',
      '', 'i');
    out_name := btrim(out_name);
  END LOOP;
  -- If the cleaning ate everything (a name that was only bookkeeping), keep the original: a
  -- clumsy name beats no name.
  IF out_name = '' THEN RETURN NULLIF(btrim(COALESCE(raw, '')), ''); END IF;
  RETURN out_name;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- One name per (workspace, ASIN).
--
-- The "new arrivals" query in routes/products.js takes only top-level articles, and that is right
-- there: it is looking for products, and a variation child describes a size. Naming an ASIN is the
-- opposite problem — an ASIN *is* one variant, and the child is the row that says which one. Of
-- the 66 title-less products Wawi knows, 64 are variation children; filtering them out leaves 4.
--
-- So both are eligible, ranked: a top-level article first when one maps to this ASIN (it carries
-- the fuller name), then the most recently added, then by id so the result never wanders.
CREATE OR REPLACE VIEW wawi_asin_names AS
SELECT DISTINCT ON (wi.workspace_id, UPPER(wa.asin))
       wi.workspace_id,
       UPPER(wa.asin)                    AS asin,
       wawi_display_name(wi.name)        AS wawi_name,
       (wi.parent_item_id = 0 OR wi.parent_item_id IS NULL) AS from_top_level_item,
       wi.sku                            AS wawi_sku
  FROM wawi_items wi
  JOIN wawi_item_asins wa
    ON wa.workspace_id = wi.workspace_id AND wa.wawi_item_id = wi.wawi_id
 WHERE COALESCE(wi.name, '') <> ''
   AND wa.asin IS NOT NULL AND wa.asin <> ''
 ORDER BY wi.workspace_id, UPPER(wa.asin),
          (wi.parent_item_id = 0 OR wi.parent_item_id IS NULL) DESC,
          wi.added_at DESC NULLS LAST,
          wi.wawi_id;

CREATE INDEX IF NOT EXISTS idx_wawi_item_asins_ws_asin ON wawi_item_asins (workspace_id, UPPER(asin));
