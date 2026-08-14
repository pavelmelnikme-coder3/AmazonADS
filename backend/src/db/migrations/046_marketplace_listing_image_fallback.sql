-- Thumbnail fallback for listings with no MAIN image.
--
-- 045 required variant='MAIN', which Amazon does not guarantee: verified on the
-- live account that B099ZVM384 returns 24 images in BE and SE across variants
-- PT01–PT08 with no MAIN entry, so those rows kept a NULL thumbnail. Fall back
-- to the lowest-numbered supplementary photo — the one Amazon shows first —
-- still picking the smallest size, since this renders at ~26 px.
UPDATE product_marketplace_listings l
   SET image_url = (
     SELECT img->>'link'
       FROM jsonb_array_elements(l.raw_data->'images') AS im,
            jsonb_array_elements(im->'images')         AS img
      WHERE im->>'marketplaceId' = l.marketplace_id
        AND img->>'link' IS NOT NULL
        AND (img->>'width') ~ '^[0-9]+$'
      ORDER BY (img->>'variant' <> 'MAIN'),          -- MAIN first when present
               img->>'variant',                       -- then PT01, PT02, …
               (img->>'width')::int ASC
      LIMIT 1
   )
 WHERE l.image_url IS NULL
   AND l.exists_in_catalog
   AND l.raw_data IS NOT NULL
   AND jsonb_typeof(l.raw_data->'images') = 'array';
