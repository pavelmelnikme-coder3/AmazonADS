-- Stop re-scraping ASINs that have nothing to give.
--
-- 276 of this workspace's 551 active products have had no title since April, and syncProductsMeta
-- re-fetched every one of them every night. Against a 1,000-request monthly ScraperAPI plan that
-- empties the credits in four days — and once they are gone, rank tracking, which shares the same
-- key, goes with them. The ASINs are ones that no longer resolve in the DE catalogue; tomorrow's
-- answer is the same as tonight's.
--
-- The counter records only attempts that actually reached Amazon and came back empty. A refusal
-- from the fetcher (403/429/503) says nothing about the ASIN and costs it nothing; a successful
-- fetch resets it to 0.
ALTER TABLE products ADD COLUMN IF NOT EXISTS meta_scrape_attempts INT NOT NULL DEFAULT 0;

-- The 276 already-known-empty ones start at the ceiling rather than being given five more nights
-- each: they have had months of nightly attempts already. A new product is unaffected, and any of
-- these can be retried on demand by setting the column back to 0.
UPDATE products SET meta_scrape_attempts = 5
 WHERE title IS NULL AND is_active = true AND created_at < NOW() - INTERVAL '30 days';

CREATE INDEX IF NOT EXISTS idx_products_meta_pending
    ON products (workspace_id) WHERE title IS NULL AND is_active = true;
