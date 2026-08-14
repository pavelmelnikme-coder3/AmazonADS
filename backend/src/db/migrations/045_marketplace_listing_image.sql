-- Per-country MAIN image for the cross-country matrix.
--
-- `products.image_url` only ever holds the home-marketplace photo, and it is
-- empty for every ASIN that is dead in the home marketplace — which is half the
-- tracked catalogue. Those rows still have live listings (and photos) in other
-- countries, so the matrix showed a blank thumbnail for products that do have
-- one. Storing the image per marketplace lets the row fall back to any country
-- that has a picture.
ALTER TABLE product_marketplace_listings ADD COLUMN IF NOT EXISTS image_url TEXT;

-- Backfill from the catalog payload already on the row — no extra SP-API calls.
-- Amazon returns MAIN at several sizes (75 / 500 / 2208 px); the smallest is the
-- thumbnail this table renders at ~26 px, so it is both the right one and the
-- cheapest to load across a several-hundred-row matrix.
UPDATE product_marketplace_listings l
   SET image_url = (
     SELECT img->>'link'
       FROM jsonb_array_elements(l.raw_data->'images') AS im,
            jsonb_array_elements(im->'images')         AS img
      WHERE im->>'marketplaceId' = l.marketplace_id
        AND img->>'variant' = 'MAIN'
        AND (img->>'width') ~ '^[0-9]+$'
      ORDER BY (img->>'width')::int ASC
      LIMIT 1
   )
 WHERE l.image_url IS NULL
   AND l.exists_in_catalog
   AND l.raw_data IS NOT NULL
   AND jsonb_typeof(l.raw_data->'images') = 'array';
