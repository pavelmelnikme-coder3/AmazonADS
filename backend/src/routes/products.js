const express = require("express");
const router = express.Router();
const ExcelJS = require("exceljs");
const { requireAuth, requireWorkspace } = require("../middleware/auth");
const { query } = require("../db/pool");
const { getCatalogItem } = require("../services/amazon/spClient");
const { EU_MARKETPLACES, EU_MARKETPLACE_IDS, listingUrl } = require("../services/amazon/marketplaces");
const { queueProductMetaSync, queueSpSync } = require("../jobs/workers");
const logger = require("../config/logger");

router.use(requireAuth, requireWorkspace);

// An SB ad keeps state "ENABLED" while its creative is rejected or still waiting
// for moderation — Amazon reports that separately, in creativeStatus and in
// extendedData.servingStatus, and such an ad shows nothing to anyone. SP/SD rows
// carry neither field, so the COALESCE defaults leave them judged exactly as
// before. Campaign-level reasons (paused, out of budget) are deliberately NOT
// read from servingStatus: the campaign state column already carries those.
const AD_CAN_SERVE = `(
       COALESCE(pa.raw_data->'creative'->>'creativeStatus', 'PUBLISHED') = 'PUBLISHED'
   AND COALESCE(pa.raw_data->'extendedData'->>'servingStatus', '') NOT LIKE 'AD_POLICING%'
)`;

// GET /products — list all products for workspace with latest BSR + metrics
router.get("/", async (req, res, next) => {
  try {
    // ── Filters (enum-driven → safe to inline) ──
    // availability: all | available (live listing) | unavailable (delisted / 404, no catalog data)
    // advertising:  all | advertised (enabled ad in enabled campaign) | not_advertised
    const availability = ["available", "unavailable"].includes(req.query.availability) ? req.query.availability : "all";
    const advertising  = ["advertised", "not_advertised"].includes(req.query.advertising) ? req.query.advertising : "all";

    const advExists = `EXISTS (
      SELECT 1 FROM product_ads pa JOIN campaigns c ON c.id = pa.campaign_id
      WHERE pa.workspace_id = p.workspace_id AND UPPER(pa.asin) = p.asin
        AND pa.state = 'enabled' AND c.state = 'enabled' AND ${AD_CAN_SERVE}
    )`;
    let availFilter = "";
    if (availability === "available")   availFilter = "AND p.title IS NOT NULL AND p.title <> ''";
    if (availability === "unavailable") availFilter = "AND (p.title IS NULL OR p.title = '')";
    let advFilter = "";
    if (advertising === "advertised")     advFilter = `AND ${advExists}`;
    if (advertising === "not_advertised") advFilter = `AND NOT ${advExists}`;

    const { rows } = await query(
      `SELECT
         p.id, p.asin, p.marketplace_id, p.title, p.brand, p.image_url, p.is_active,
         p.created_at, p.parent_asin,
         ${advExists} AS is_advertised,
         (p.title IS NOT NULL AND p.title <> '') AS is_available,
         -- How many campaigns carry an ad for this ASIN (see GET /products/ad-placements
         -- for the campaign names themselves). "Live" = enabled ad in an enabled campaign,
         -- i.e. what has to be switched off to stop promoting the product.
         COALESCE(adcamp.campaign_count, 0)      AS ad_campaign_count,
         COALESCE(adcamp.live_campaign_count, 0) AS ad_campaign_live_count,
         s.best_rank,
         s.best_category,
         s.classification_ranks,
         s.display_group_ranks,
         s.captured_at as bsr_updated_at,
         lh.issue_count AS lh_issue_count,
         lh.issues AS lh_issues,
         lh.checked_at AS lh_checked_at,
         COALESCE(sm.sku, '') AS internal_sku,
         COALESCE(inv.seller_skus, ARRAY[]::text[]) AS seller_skus,
         -- cost / price metadata
         COALESCE(sm.cogs_per_unit, 0)    AS cogs_per_unit,
         COALESCE(sm.amazon_fee_pct, -0.15) AS amazon_fee_pct,
         -- stock
         COALESCE(stock.fba_qty, 0) AS fba_qty,
         COALESCE(stock.fbm_qty, 0) AS fbm_qty,
         -- sell price (buy-box preferred)
         pricing.sell_price,
         -- PPC spend — true per-ASIN ad spend (advertised_product level). Replaces the
         -- old campaign-level attribution that repeated a campaign's full spend on every
         -- ASIN in it (double-counted across a listing's variations).
         COALESCE(adp.ad_spend_yesterday, 0) AS ppc_yesterday,
         COALESCE(adp.ad_spend_7d, 0)        AS ppc_7d,
         COALESCE(adp.ad_spend_7d, 0) AS ad_spend_7d,
         COALESCE(adp.ad_sales_7d, 0) AS ad_sales_7d,
         -- orders / revenue
         COALESCE(orders.revenue_yesterday, 0) AS revenue_yesterday,
         COALESCE(orders.revenue_7d, 0)        AS revenue_7d,
         COALESCE(orders.qty_yesterday, 0)     AS qty_yesterday,
         COALESCE(orders.qty_7d, 0)            AS qty_7d,
         -- Net profit (revenue after Amazon fee minus COGS minus per-ASIN ad spend).
         -- COGS uses the PRICED quantity, not the full one: a freshly-placed order has
         -- its quantity but no ItemPrice yet, so charging its COGS against revenue that
         -- has not landed would show a phantom loss on the current day.
         ROUND((
           COALESCE(orders.revenue_yesterday, 0) * (1 + COALESCE(sm.amazon_fee_pct, -0.15))
           - COALESCE(sm.cogs_per_unit, 0) * COALESCE(orders.qty_yesterday_priced, 0)
           - COALESCE(adp.ad_spend_yesterday, 0)
         )::numeric, 2) AS profit_yesterday,
         ROUND((
           COALESCE(orders.revenue_7d, 0) * (1 + COALESCE(sm.amazon_fee_pct, -0.15))
           - COALESCE(sm.cogs_per_unit, 0) * COALESCE(orders.qty_7d_priced, 0)
           - COALESCE(adp.ad_spend_7d, 0)
         )::numeric, 2) AS profit_7d
       FROM products p
       LEFT JOIN LATERAL (
         SELECT best_rank, best_category, classification_ranks, display_group_ranks, captured_at
         FROM bsr_snapshots
         WHERE product_id = p.id
         ORDER BY captured_at DESC
         LIMIT 1
       ) s ON true
       LEFT JOIN LATERAL (
         SELECT COUNT(DISTINCT pa.campaign_id) FILTER (
                  WHERE c.state <> 'archived' AND pa.state <> 'archived') AS campaign_count,
                -- Same three-link rule the panel uses for its green dot: a paused
                -- ad GROUP stops delivery just as a paused campaign does, so it
                -- must not be counted as live here either.
                COUNT(DISTINCT pa.campaign_id) FILTER (
                  WHERE c.state = 'enabled' AND pa.state = 'enabled'
                    AND COALESCE(ag.state, 'enabled') = 'enabled'
                    AND ${AD_CAN_SERVE}) AS live_campaign_count
         FROM product_ads pa
         JOIN campaigns c ON c.id = pa.campaign_id
         LEFT JOIN ad_groups ag ON ag.id = pa.ad_group_id
         WHERE pa.workspace_id = p.workspace_id AND UPPER(pa.asin) = p.asin
       ) adcamp ON true
       LEFT JOIN product_listing_health lh ON lh.product_id = p.id
       LEFT JOIN sku_mapping sm
         ON sm.workspace_id = p.workspace_id AND sm.asin = p.asin
       LEFT JOIN LATERAL (
         SELECT ARRAY_AGG(DISTINCT si.seller_sku) FILTER (WHERE si.seller_sku != '') AS seller_skus
         FROM sp_inventory si
         WHERE si.workspace_id = p.workspace_id
           AND si.asin = p.asin
           AND si.marketplace_id = p.marketplace_id
       ) inv ON true
       -- FBA / FBM stock
       LEFT JOIN LATERAL (
         SELECT
           COALESCE(SUM(CASE WHEN UPPER(si.fulfillment_channel) LIKE '%AMAZON%'
                             THEN si.quantity_sellable ELSE 0 END), 0) AS fba_qty,
           COALESCE(SUM(CASE WHEN UPPER(si.fulfillment_channel) NOT LIKE '%AMAZON%'
                             THEN si.quantity_sellable ELSE 0 END), 0) AS fbm_qty
         FROM sp_inventory si
         WHERE si.workspace_id = p.workspace_id
           AND si.asin = p.asin
           AND si.marketplace_id = p.marketplace_id
       ) stock ON true
       -- Sell price (latest buy-box, fall back to listing price)
       LEFT JOIN LATERAL (
         SELECT COALESCE(buy_box_price_amount, listing_price_amount) AS sell_price
         FROM sp_pricing
         WHERE workspace_id = p.workspace_id
           AND asin = p.asin
           AND marketplace_id = p.marketplace_id
         ORDER BY captured_at DESC
         LIMIT 1
       ) pricing ON true
       -- Per-ASIN ad spend & ad-attributed sales (advertised_product level) — correct
       -- per-ASIN attribution (the old campaign-level join repeated a campaign's full
       -- spend on every ASIN, double-counting across a listing's variations).
       LEFT JOIN LATERAL (
         SELECT
           COALESCE(SUM(CASE WHEN m.date = CURRENT_DATE - 1 THEN m.cost ELSE 0 END), 0) AS ad_spend_yesterday,
           COALESCE(SUM(CASE WHEN m.date >= CURRENT_DATE - 7 AND m.date <= CURRENT_DATE - 1 THEN m.cost     ELSE 0 END), 0) AS ad_spend_7d,
           -- 14-day attribution — the app-wide standard (campaigns/rules/analytics all use sales_14d)
           COALESCE(SUM(CASE WHEN m.date >= CURRENT_DATE - 7 AND m.date <= CURRENT_DATE - 1 THEN m.sales_14d ELSE 0 END), 0) AS ad_sales_7d
         FROM fact_metrics_daily m
         WHERE m.workspace_id = p.workspace_id
           AND m.entity_type = 'advertised_product'
           AND UPPER(m.amazon_id) = p.asin
           AND m.date >= CURRENT_DATE - 7
       ) adp ON true
       -- Orders revenue from SP Orders API.
       -- item_price_amount is Amazon's ItemPrice = the EXTENDED price of the line
       -- (unit price x quantity), never the unit price — verified against raw_data
       -- (quantity 2 -> {"Amount": "71.98"} = 2 x 35.99). Multiplying it by
       -- quantity_ordered again inflated revenue on every multi-unit line, which in
       -- turn deflated TACOS and profit.
       LEFT JOIN LATERAL (
         SELECT
           COALESCE(SUM(CASE WHEN DATE(o.purchase_date AT TIME ZONE 'UTC') = CURRENT_DATE - 1
                             THEN oi.item_price_amount ELSE 0 END), 0) AS revenue_yesterday,
           COALESCE(SUM(CASE WHEN DATE(o.purchase_date AT TIME ZONE 'UTC') >= CURRENT_DATE - 7
                              AND DATE(o.purchase_date AT TIME ZONE 'UTC') <= CURRENT_DATE - 1
                             THEN oi.item_price_amount ELSE 0 END), 0) AS revenue_7d,
           COALESCE(SUM(CASE WHEN DATE(o.purchase_date AT TIME ZONE 'UTC') = CURRENT_DATE - 1
                             THEN oi.quantity_ordered ELSE 0 END), 0) AS qty_yesterday,
           COALESCE(SUM(CASE WHEN DATE(o.purchase_date AT TIME ZONE 'UTC') >= CURRENT_DATE - 7
                              AND DATE(o.purchase_date AT TIME ZONE 'UTC') <= CURRENT_DATE - 1
                             THEN oi.quantity_ordered ELSE 0 END), 0) AS qty_7d,
           -- Quantities restricted to lines that already carry a price, so the profit
           -- calculation pairs COGS with revenue from the very same lines.
           COALESCE(SUM(CASE WHEN DATE(o.purchase_date AT TIME ZONE 'UTC') = CURRENT_DATE - 1
                              AND oi.item_price_amount IS NOT NULL
                             THEN oi.quantity_ordered ELSE 0 END), 0) AS qty_yesterday_priced,
           COALESCE(SUM(CASE WHEN DATE(o.purchase_date AT TIME ZONE 'UTC') >= CURRENT_DATE - 7
                              AND DATE(o.purchase_date AT TIME ZONE 'UTC') <= CURRENT_DATE - 1
                              AND oi.item_price_amount IS NOT NULL
                             THEN oi.quantity_ordered ELSE 0 END), 0) AS qty_7d_priced
         FROM sp_order_items oi
         JOIN sp_orders o ON o.id = oi.order_id
         WHERE oi.workspace_id = p.workspace_id
           AND oi.asin = p.asin
           AND o.purchase_date >= NOW() - INTERVAL '8 days'
           -- Amazon spells it "Canceled" (one l); the old "Cancelled" matched nothing,
           -- so every cancelled line passed the filter. Pending is a real order that
           -- flips to Unshipped within hours — excluding it under-counted the last day
           -- and disagreed with /period-orders, alerts and metrics, which all keep it.
           AND o.order_status NOT IN ('Canceled', 'Unfulfillable')
       ) orders ON true
       WHERE p.workspace_id = $1 AND p.is_active = true
         ${availFilter}
         ${advFilter}
       ORDER BY s.best_rank ASC NULLS LAST, p.created_at DESC`,
      [req.workspaceId]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// GET /products/new-unadvertised — recently-arrived Wawi items that carry an ASIN
// (i.e. are listed on Amazon) but have NO enabled ad in any enabled campaign.
// Deduped by ASIN (multiple Wawi SKUs — e.g. FBA vs local "ANGEBOT_" — collapse
// to one row). "New" = wawi_items.added_at within the last `days` days.
router.get("/new-unadvertised", async (req, res, next) => {
  try {
    const days = Math.min(365, Math.max(1, parseInt(req.query.days, 10) || 90));
    const { rows } = await query(
      `WITH new_asins AS (
         SELECT UPPER(wa.asin)                                    AS asin,
                max(wi.added_at)                                  AS added_at,
                bool_or(wi.is_active)                             AS is_active,
                (array_agg(wi.name ORDER BY wi.added_at DESC NULLS LAST))[1] AS wawi_name,
                max(wi.sales_price_net)                           AS sales_price_net,
                min(wi.purchase_price_net)                        AS purchase_price_net,
                max(wi.amazon_price)                              AS amazon_price,
                count(DISTINCT wi.wawi_id)                        AS wawi_sku_count,
                array_agg(DISTINCT wi.wawi_id)                    AS wawi_ids
           FROM wawi_items wi
           JOIN wawi_item_asins wa
             ON wa.workspace_id = wi.workspace_id AND wa.wawi_item_id = wi.wawi_id
          WHERE wi.workspace_id = $1
            AND wi.added_at IS NOT NULL
            AND wi.added_at > now() - make_interval(days => $2)
            AND (wi.parent_item_id = 0 OR wi.parent_item_id IS NULL)
            AND wa.asin IS NOT NULL AND wa.asin <> ''
          GROUP BY UPPER(wa.asin)
       )
       SELECT na.asin, na.added_at, na.is_active, na.wawi_name,
              na.sales_price_net, na.purchase_price_net, na.amazon_price,
              na.wawi_sku_count,
              p.id AS product_id,
              COALESCE(p.title, ic.title, na.wawi_name)  AS title,
              COALESCE(p.image_url, ic.image_url)        AS image_url,
              (ic.asin IS NOT NULL)                      AS img_cached,
              p.brand,
              -- display price: prefer a real (non-zero) Amazon price, else the Wawi net sales price
              CASE WHEN COALESCE(na.amazon_price, 0) > 0 THEN na.amazon_price ELSE na.sales_price_net END AS price,
              COALESCE(st.stock, 0) AS stock
         FROM new_asins na
         LEFT JOIN products p
                ON p.workspace_id = $1 AND UPPER(p.asin) = na.asin
         LEFT JOIN asin_image_cache ic
                ON ic.workspace_id = $1 AND ic.asin = na.asin
         LEFT JOIN LATERAL (
                SELECT COALESCE(sum(ws.quantity_total), 0) AS stock
                  FROM wawi_stocks ws
                 WHERE ws.workspace_id = $1 AND ws.wawi_item_id = ANY(na.wawi_ids)
              ) st ON true
        WHERE NOT EXISTS (
                SELECT 1 FROM product_ads pa JOIN campaigns c ON c.id = pa.campaign_id
                 WHERE pa.workspace_id = $1 AND UPPER(pa.asin) = na.asin
                   AND pa.state = 'enabled' AND c.state = 'enabled' AND ${AD_CAN_SERVE}
              )
        ORDER BY na.added_at DESC`,
      [req.workspaceId, days]
    );

    // Best-effort: for rows still missing a photo (ASIN not tracked in products and
    // not yet cached), pull the Amazon catalog image + real title, cache it, and patch
    // this response. Bounded + non-fatal so a slow/failed SP-API call never breaks the list.
    const marketplaceId = "A1PA6795UKMFR9"; // DE
    // Only ASINs with no image AND no cache row yet — a cached row (even with a null
    // image, meaning Amazon has none) is left alone so we don't re-hit SP-API each load.
    const missing = rows.filter(r => !r.image_url && !r.img_cached).slice(0, 25);
    if (missing.length) {
      const enrichOne = async (r) => {
        try {
          const data = await getCatalogItem(r.asin, marketplaceId);
          const img = data?.imageUrl || null;
          const ttl = data?.title || null;
          if (img || ttl) {
            await query(
              `INSERT INTO asin_image_cache (workspace_id, asin, image_url, title, fetched_at)
                 VALUES ($1, $2, $3, $4, NOW())
               ON CONFLICT (workspace_id, asin)
               DO UPDATE SET image_url = EXCLUDED.image_url, title = EXCLUDED.title, fetched_at = NOW()`,
              [req.workspaceId, r.asin, img, ttl]
            );
            if (img) r.image_url = img;
            if (ttl && (!r.title || r.title === r.wawi_name)) r.title = ttl;
          }
        } catch (e) {
          logger.warn("new-unadvertised catalog image fetch failed", { asin: r.asin, error: e.message });
        }
      };
      // small concurrency to respect SP-API catalog rate limits
      const CONC = 3;
      for (let i = 0; i < missing.length; i += CONC) {
        await Promise.all(missing.slice(i, i + CONC).map(enrichOne));
      }
    }

    res.json({ days, items: rows });
  } catch (err) { next(err); }
});

// GET /products/ad-placements?asins=B0AAA,B0BBB
// "Where is this ASIN actually being advertised?" — the campaigns/ad groups that
// carry an ad for it, so a product can be pulled out of advertising without
// hunting through the Amazon console.
//
// Source of truth is `product_ads` (Amazon's ad rows: one per ASIN/SKU inside an
// ad group) for SP and SD, plus one row per ASIN of an SB creative. SB ads have
// no ad group of their own in our DB (Amazon exposes no SB ad-group list we
// sync), so their ad_group_name is null and the delivery chain is ad → campaign.
router.get("/ad-placements", async (req, res, next) => {
  try {
    const asins = [...new Set(
      String(req.query.asins || "")
        .split(",")
        .map(s => s.trim().toUpperCase())
        .filter(s => /^[A-Z0-9]{10}$/.test(s))
    )].slice(0, 200);

    if (!asins.length) return res.json({ coverage: ["SP", "SD", "SB"], placements: {} });

    const { rows } = await query(
      `SELECT UPPER(pa.asin)   AS asin,
              pa.amazon_ad_id, pa.sku, pa.state AS ad_state,
              ${AD_CAN_SERVE} AS ad_can_serve,
              pa.raw_data->'extendedData'->>'servingStatus' AS serving_status,
              pa.raw_data->'creative'->>'creativeStatus'    AS creative_status,
              c.id             AS campaign_id,
              c.amazon_campaign_id,
              c.name           AS campaign_name,
              c.campaign_type,
              c.state          AS campaign_state,
              c.daily_budget,
              pf.name          AS portfolio_name,
              prof.marketplace_id,
              ag.name          AS ad_group_name,
              ag.state         AS ad_group_state
         FROM product_ads pa
         JOIN campaigns c          ON c.id    = pa.campaign_id
         JOIN amazon_profiles prof ON prof.id = c.profile_id
         LEFT JOIN portfolios pf   ON pf.id   = c.portfolio_id
         LEFT JOIN ad_groups ag    ON ag.id   = pa.ad_group_id
        WHERE pa.workspace_id = $1
          AND UPPER(pa.asin) = ANY($2::text[])
          -- Archived campaigns and archived ads cannot serve and cannot be
          -- revived, so they are noise for "where do I switch this off?" —
          -- and leaving them in would make the panel disagree with the
          -- campaign count on the product row, which filters them the same way.
          AND c.state <> 'archived'
          AND pa.state <> 'archived'`,
      [req.workspaceId, asins]
    );

    // Campaign-level spend for the last 7 full days. It covers the WHOLE campaign,
    // not just this ASIN (Amazon reports per-ASIN spend only aggregated across
    // campaigns), so the field name says so and the UI labels it that way.
    const campaignAmazonIds = [...new Set(rows.map(r => r.amazon_campaign_id).filter(Boolean))];
    const spendByCampaign = new Map();
    if (campaignAmazonIds.length) {
      const { rows: mrows } = await query(
        `SELECT amazon_id,
                COALESCE(SUM(cost), 0)      AS spend,
                COALESCE(SUM(sales_14d), 0) AS sales,
                COALESCE(SUM(clicks), 0)    AS clicks
           FROM fact_metrics_daily
          WHERE workspace_id = $1
            AND entity_type = 'campaign'
            AND amazon_id = ANY($2::text[])
            AND date >= CURRENT_DATE - 7 AND date <= CURRENT_DATE - 1
          GROUP BY amazon_id`,
        [req.workspaceId, campaignAmazonIds]
      );
      for (const m of mrows) spendByCampaign.set(m.amazon_id, m);
    }

    // Group ad rows → one entry per (ASIN, campaign). A listing normally has one
    // ad per SKU (FBA + FBM) in every ad group, so the raw rows repeat the same
    // campaign many times — collapse them and keep the detail underneath.
    const placements = {};
    for (const a of asins) placements[a] = [];

    const byKey = new Map();
    for (const r of rows) {
      const key = `${r.asin}::${r.campaign_id}`;
      let entry = byKey.get(key);
      if (!entry) {
        const m = spendByCampaign.get(r.amazon_campaign_id);
        entry = {
          campaign_id:        r.campaign_id,
          amazon_campaign_id: r.amazon_campaign_id,
          campaign_name:      r.campaign_name,
          campaign_type:      r.campaign_type,
          campaign_state:     r.campaign_state,
          marketplace_id:     r.marketplace_id,
          portfolio_name:     r.portfolio_name,
          daily_budget:       r.daily_budget == null ? null : Number(r.daily_budget),
          campaign_spend_7d:  m ? Number(m.spend) : 0,
          campaign_sales_7d:  m ? Number(m.sales) : 0,
          campaign_clicks_7d: m ? Number(m.clicks) : 0,
          ad_count:           0,
          enabled_ad_count:   0,
          blocked_reason:     null,
          skus:               [],
          ad_groups:          [],
          is_live:            false,
        };
        byKey.set(key, entry);
        (placements[r.asin] = placements[r.asin] || []).push(entry);
      }
      entry.ad_count += 1;
      if (r.ad_state === "enabled") entry.enabled_ad_count += 1;
      if (r.sku && !entry.skus.includes(r.sku)) entry.skus.push(r.sku);
      // Why an enabled ad in an enabled campaign still shows nothing (SB only).
      // Under a paused campaign the reason is noise — the campaign badge already
      // says why nothing runs, and the tooltip here would contradict it.
      if (r.ad_state === "enabled" && r.campaign_state === "enabled"
          && !r.ad_can_serve && !entry.blocked_reason) {
        entry.blocked_reason = r.creative_status && r.creative_status !== "PUBLISHED"
          ? r.creative_status : r.serving_status;
      }

      const agName = r.ad_group_name || null;
      let ag = entry.ad_groups.find(g => g.name === agName);
      if (!ag) {
        ag = { name: agName, state: r.ad_group_state || null, ad_count: 0, enabled_ad_count: 0 };
        entry.ad_groups.push(ag);
      }
      ag.ad_count += 1;
      if (r.ad_state === "enabled") ag.enabled_ad_count += 1;

      // "Live" = the ad actually serves: enabled ad, in an enabled ad group, in an
      // enabled campaign, with a creative Amazon is willing to show. Any broken
      // link in that chain stops delivery.
      if (r.ad_state === "enabled" && r.campaign_state === "enabled"
          && (r.ad_group_state || "enabled") === "enabled"
          && r.ad_can_serve) {
        entry.is_live = true;
      }
    }

    // A campaign with one rejected creative and one live creative is serving —
    // the reason only matters when nothing in it can show.
    for (const e of byKey.values()) if (e.is_live) e.blocked_reason = null;

    // Live campaigns first (that's what the user has to switch off), then the
    // still-enabled ones, then paused/archived; alphabetical inside each tier.
    const tier = (c) => c.is_live ? 0 : c.campaign_state === "enabled" ? 1 : c.campaign_state === "paused" ? 2 : 3;
    for (const a of Object.keys(placements)) {
      placements[a].sort((x, y) =>
        tier(x) - tier(y) ||
        y.campaign_spend_7d - x.campaign_spend_7d ||
        String(x.campaign_name).localeCompare(String(y.campaign_name)));
    }

    res.json({ coverage: ["SP", "SD", "SB"], placements });
  } catch (err) { next(err); }
});

// POST /products — add ASIN to track
router.post("/", async (req, res, next) => {
  try {
    const { asin, marketplaceId = "A1PA6795UKMFR9" } = req.body;
    if (!asin || !/^[A-Z0-9]{10}$/.test(asin.trim().toUpperCase())) {
      return res.status(400).json({ error: "Invalid ASIN format (10 alphanumeric chars)" });
    }
    const cleanAsin = asin.trim().toUpperCase();

    const { rows: [product] } = await query(
      `INSERT INTO products (workspace_id, asin, marketplace_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (workspace_id, asin, marketplace_id)
       DO UPDATE SET is_active = true, updated_at = NOW()
       RETURNING *`,
      [req.workspaceId, cleanAsin, marketplaceId]
    );

    // Fetch BSR immediately if SP-API is configured
    if (process.env.SP_API_REFRESH_TOKEN) {
      try {
        const data = await getCatalogItem(cleanAsin, marketplaceId);

        await query(
          `UPDATE products SET title=$1, brand=$2, image_url=$3, updated_at=NOW() WHERE id=$4`,
          [data.title, data.brand, data.imageUrl, product.id]
        );

        const allRanks = [...data.classificationRanks, ...data.displayGroupRanks];
        const best = allRanks.reduce((b, r) => (!b || r.rank < b.rank ? r : b), null);

        await query(
          `INSERT INTO bsr_snapshots
             (product_id, classification_ranks, display_group_ranks, best_rank, best_category)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            product.id,
            JSON.stringify(data.classificationRanks),
            JSON.stringify(data.displayGroupRanks),
            best?.rank || null,
            best?.title || null,
          ]
        );

        return res.json({
          ...product,
          title: data.title,
          brand: data.brand,
          image_url: data.imageUrl,
          bsr: data,
        });
      } catch (spErr) {
        logger.warn("SP-API fetch failed on add", { asin: cleanAsin, error: spErr.message });
        return res.json({ ...product, bsr_warning: "SP-API not configured or failed" });
      }
    }

    // No SP-API — queue background meta scrape
    queueProductMetaSync(req.workspaceId).catch(() => {});
    res.json(product);
  } catch (err) { next(err); }
});

// POST /products/sync-meta — trigger metadata scrape for all products without title
router.post("/sync-meta", async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT COUNT(*) as cnt FROM products WHERE workspace_id = $1 AND is_active = true AND title IS NULL`,
      [req.workspaceId]
    );
    const pending = parseInt(rows[0].cnt);
    if (pending === 0) return res.json({ ok: true, queued: 0, message: "All products already have metadata" });
    await queueProductMetaSync(req.workspaceId);
    res.json({ ok: true, queued: pending });
  } catch (err) { next(err); }
});

// POST /products/:id/refresh — manually trigger BSR refresh for one ASIN
router.post("/:id/refresh", async (req, res, next) => {
  try {
    const { rows: [product] } = await query(
      `SELECT * FROM products WHERE id = $1 AND workspace_id = $2`,
      [req.params.id, req.workspaceId]
    );
    if (!product) return res.status(404).json({ error: "Product not found" });

    const data = await getCatalogItem(product.asin, product.marketplace_id);

    await query(
      `UPDATE products SET title=$1, brand=$2, image_url=$3, updated_at=NOW() WHERE id=$4`,
      [data.title, data.brand, data.imageUrl, product.id]
    );

    const allRanks = [...data.classificationRanks, ...data.displayGroupRanks];
    const best = allRanks.reduce((b, r) => (!b || r.rank < b.rank ? r : b), null);

    const { rows: [snapshot] } = await query(
      `INSERT INTO bsr_snapshots
         (product_id, classification_ranks, display_group_ranks, best_rank, best_category)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        product.id,
        JSON.stringify(data.classificationRanks),
        JSON.stringify(data.displayGroupRanks),
        best?.rank || null,
        best?.title || null,
      ]
    );

    res.json({ product, snapshot, raw: data });
  } catch (err) { next(err); }
});

// GET /products/:id/history — BSR history for chart (all snapshots, optional ?start=YYYY-MM-DD&end=YYYY-MM-DD)
router.get("/:id/history", async (req, res, next) => {
  try {
    const { start, end } = req.query;
    const params = [req.params.id];
    let conds = `WHERE product_id = $1`;
    if (start) { params.push(start); conds += ` AND captured_at >= $${params.length}::date`; }
    if (end)   { params.push(end);   conds += ` AND captured_at < ($${params.length}::date + INTERVAL '1 day')`; }
    const { rows } = await query(
      `SELECT captured_at, best_rank, best_category, classification_ranks, display_group_ranks
       FROM bsr_snapshots
       ${conds}
       ORDER BY captured_at ASC`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// GET /products/timeseries?asins=A,B,C&start=YYYY-MM-DD&end=YYYY-MM-DD&compare=1
// Daily aligned series for the listing/ASIN charts: BSR, price, orders, ad spend,
// ACOS, TACOS, ROAS. Per-ASIN series + a listing aggregate. With compare=1 it also
// returns the immediately-preceding equal-length window (`prev`), aligned by index.
// Lazy-loaded on expand (never for the whole page) so 500+ products stay performant.
router.get("/timeseries", async (req, res, next) => {
  try {
    const asins = String(req.query.asins || "").split(",")
      .map((a) => a.trim().toUpperCase()).filter((a) => /^[A-Z0-9]{10}$/.test(a)).slice(0, 60);
    if (!asins.length) return res.json({ start: null, end: null, by_asin: {}, aggregate: [], prev: null });

    const end   = /^\d{4}-\d{2}-\d{2}$/.test(req.query.end)   ? req.query.end   : new Date().toISOString().slice(0, 10);
    const start = /^\d{4}-\d{2}-\d{2}$/.test(req.query.start) ? req.query.start
      : new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
    const compare = req.query.compare === "1" || req.query.compare === "true";
    const ws = req.workspaceId;

    const DAY = 86400000;
    const spine = (from, to) => {
      const out = [];
      for (let d = new Date(from + "T00:00:00Z"); d <= new Date(to + "T00:00:00Z"); d = new Date(d.getTime() + DAY)) out.push(d.toISOString().slice(0, 10));
      return out;
    };
    const curDates = spine(start, end);
    const windowLen = curDates.length;
    const prevStart = new Date(new Date(start + "T00:00:00Z").getTime() - windowLen * DAY).toISOString().slice(0, 10);
    const prevEnd   = new Date(new Date(start + "T00:00:00Z").getTime() - DAY).toISOString().slice(0, 10);
    const prevDates = compare ? spine(prevStart, prevEnd) : [];
    const qStart = compare ? prevStart : start;   // widen the queried range to cover both windows

    const [bsr, ad, price, ord, ordAgg] = await Promise.all([
      query(`SELECT UPPER(p.asin) AS asin, bs.captured_at::date::text AS d, MIN(bs.best_rank) AS bsr
               FROM products p JOIN bsr_snapshots bs ON bs.product_id = p.id
              WHERE p.workspace_id=$1 AND UPPER(p.asin)=ANY($2::text[]) AND bs.best_rank IS NOT NULL
                AND bs.captured_at::date BETWEEN $3 AND $4
              GROUP BY 1,2`, [ws, asins, qStart, end]),
      query(`SELECT UPPER(amazon_id) AS asin, date::text AS d,
                COALESCE(SUM(cost),0) AS ad_spend, COALESCE(SUM(sales_14d),0) AS ad_sales
               FROM fact_metrics_daily
              WHERE workspace_id=$1 AND entity_type='advertised_product' AND UPPER(amazon_id)=ANY($2::text[])
                AND date BETWEEN $3 AND $4
              GROUP BY 1,2`, [ws, asins, qStart, end]),
      query(`SELECT UPPER(asin) AS asin, captured_at::date::text AS d,
                (array_agg(COALESCE(buy_box_price_amount, listing_price_amount) ORDER BY captured_at DESC)
                   FILTER (WHERE COALESCE(buy_box_price_amount, listing_price_amount) IS NOT NULL))[1] AS price
               FROM sp_pricing
              WHERE workspace_id=$1 AND UPPER(asin)=ANY($2::text[]) AND captured_at::date BETWEEN $3 AND $4
              GROUP BY 1,2`, [ws, asins, qStart, end]),
      query(`SELECT UPPER(oi.asin) AS asin, o.purchase_date::date::text AS d,
                COUNT(DISTINCT o.id) AS orders, COALESCE(SUM(oi.quantity_ordered),0) AS units,
                COALESCE(SUM(oi.item_price_amount),0) AS revenue
               FROM sp_order_items oi JOIN sp_orders o ON o.id = oi.order_id
              WHERE oi.workspace_id=$1 AND UPPER(oi.asin)=ANY($2::text[])
                AND o.order_status NOT IN ('Canceled', 'Unfulfillable')
                AND o.purchase_date::date BETWEEN $3 AND $4
              GROUP BY 1,2`, [ws, asins, qStart, end]),
      // Listing-level order count per day. One order that contains two variations is
      // ONE order for the listing — summing the per-ASIN counts above would count it
      // twice, so the aggregate series takes its `orders` from here.
      query(`SELECT o.purchase_date::date::text AS d, COUNT(DISTINCT o.id) AS orders
               FROM sp_order_items oi JOIN sp_orders o ON o.id = oi.order_id
              WHERE oi.workspace_id=$1 AND UPPER(oi.asin)=ANY($2::text[])
                AND o.order_status NOT IN ('Canceled', 'Unfulfillable')
                AND o.purchase_date::date BETWEEN $3 AND $4
              GROUP BY 1`, [ws, asins, qStart, end]),
    ]);

    const key = (asin, d) => `${asin}|${d}`;
    const bsrM = new Map(bsr.rows.map((r) => [key(r.asin, r.d), Number(r.bsr)]));
    const adM = new Map(ad.rows.map((r) => [key(r.asin, r.d), r]));
    const priceM = new Map(price.rows.map((r) => [key(r.asin, r.d), r.price != null ? Number(r.price) : null]));
    const ordM = new Map(ord.rows.map((r) => [key(r.asin, r.d), r]));
    const ordAggM = new Map(ordAgg.rows.map((r) => [r.d, Number(r.orders)]));
    const r2 = (v) => Math.round(v * 100) / 100;
    const r1 = (v) => Math.round(v * 10) / 10;
    // ACOS = spend/adSales; TACOS = spend/totalRevenue; ROAS = adSales/spend.
    const mkPoint = (date, { bsr, cost, adSales, price, orders, units, revenue }) => ({
      date, bsr, price: price != null ? r2(price) : null, orders, units,
      ad_spend: r2(cost), ad_sales: r2(adSales), revenue: r2(revenue),
      acos:  adSales > 0 ? r1((cost / adSales) * 100) : null,
      tacos: revenue > 0 ? r1((cost / revenue) * 100) : null,
      roas:  cost > 0    ? r2(adSales / cost)         : null,
    });
    const buildSeries = (asin, dateList) => dateList.map((d) => {
      const a = adM.get(key(asin, d)); const o = ordM.get(key(asin, d));
      return mkPoint(d, {
        bsr: bsrM.has(key(asin, d)) ? bsrM.get(key(asin, d)) : null,
        cost: a ? Number(a.ad_spend) : 0, adSales: a ? Number(a.ad_sales) : 0,
        price: priceM.has(key(asin, d)) ? priceM.get(key(asin, d)) : null,
        orders: o ? Number(o.orders) : 0, units: o ? Number(o.units) : 0, revenue: o ? Number(o.revenue) : 0,
      });
    });
    const aggregateOf = (seriesByAsin, len) => Array.from({ length: len }, (_, i) => {
      let bsr = null, cost = 0, adSales = 0, revenue = 0, units = 0, pSum = 0, pN = 0, date = null;
      for (const asin of asins) {
        const pt = seriesByAsin[asin][i]; if (!pt) continue; date = pt.date;
        if (pt.bsr != null) bsr = bsr == null ? pt.bsr : Math.min(bsr, pt.bsr);
        if (pt.price != null) { pSum += pt.price; pN++; }
        cost += pt.ad_spend; adSales += pt.ad_sales; revenue += pt.revenue; units += pt.units;
      }
      // Orders are deduplicated across the listing, not summed (see ordAgg above).
      return mkPoint(date, { bsr, cost, adSales, price: pN ? pSum / pN : null, orders: ordAggM.get(date) || 0, units, revenue });
    });

    const by_asin = {}; const prev_by_asin = {};
    for (const asin of asins) {
      by_asin[asin] = buildSeries(asin, curDates);
      if (compare) prev_by_asin[asin] = buildSeries(asin, prevDates);
    }
    const aggregate = aggregateOf(by_asin, curDates.length);
    const prev = compare
      ? { start: prevStart, end: prevEnd, by_asin: prev_by_asin, aggregate: aggregateOf(prev_by_asin, prevDates.length) }
      : null;

    res.json({ start, end, by_asin, aggregate, prev });
  } catch (err) { next(err); }
});

// GET /products/period-orders?start=&end= — total orders/units/revenue per ASIN over a
// date range (default last 30d). Lightweight: powers "sort by orders for the period" so
// the user can surface the top revenue-driving listings without loading every chart.
//
// Returns two aggregations of the same rows:
//   by_asin    — per ASIN, for the flat product list
//   by_listing — per variation family (parent ASIN), where `orders` is a TRUE
//                COUNT(DISTINCT order). Summing the per-ASIN counts client-side
//                counted one order once per variation it touched, so a listing with
//                many variations over-reported its order count.
router.get("/period-orders", async (req, res, next) => {
  try {
    const end   = /^\d{4}-\d{2}-\d{2}$/.test(req.query.end)   ? req.query.end   : new Date().toISOString().slice(0, 10);
    const start = /^\d{4}-\d{2}-\d{2}$/.test(req.query.start) ? req.query.start
      : new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
    // Same status rule as the product list above: drop only what Amazon itself
    // no longer counts as a sale.
    const [{ rows }, { rows: listingRows }] = await Promise.all([
      query(
        `SELECT UPPER(oi.asin) AS asin,
           COUNT(DISTINCT o.id) AS orders,
           COALESCE(SUM(oi.quantity_ordered),0) AS units,
           COALESCE(SUM(oi.item_price_amount),0) AS revenue
         FROM sp_order_items oi JOIN sp_orders o ON o.id = oi.order_id
         WHERE oi.workspace_id=$1 AND o.order_status NOT IN ('Canceled', 'Unfulfillable')
           AND o.purchase_date::date BETWEEN $2 AND $3 AND oi.asin IS NOT NULL
         GROUP BY UPPER(oi.asin)`,
        [req.workspaceId, start, end]
      ),
      query(
        // Listing key mirrors the frontend grouping: parent_asin when known, else the
        // ASIN itself. The join is restricted to active products because the page only
        // ever renders those — an archived variation must not fold its orders into a
        // listing whose visible children exclude it; it falls back to standing alone
        // under its own ASIN, where nothing renders it.
        `SELECT COALESCE(p.parent_asin, UPPER(oi.asin)) AS listing_id,
           COUNT(DISTINCT o.id) AS orders,
           COALESCE(SUM(oi.quantity_ordered),0) AS units,
           COALESCE(SUM(oi.item_price_amount),0) AS revenue
         FROM sp_order_items oi
         JOIN sp_orders o ON o.id = oi.order_id
         LEFT JOIN products p
           ON p.workspace_id = oi.workspace_id AND p.asin = UPPER(oi.asin) AND p.is_active
         WHERE oi.workspace_id=$1 AND o.order_status NOT IN ('Canceled', 'Unfulfillable')
           AND o.purchase_date::date BETWEEN $2 AND $3 AND oi.asin IS NOT NULL
         GROUP BY 1`,
        [req.workspaceId, start, end]
      ),
    ]);
    const shape = (r) => ({ orders: Number(r.orders), units: Number(r.units), revenue: Math.round(Number(r.revenue) * 100) / 100 });
    const by_asin = {};
    for (const r of rows) by_asin[r.asin] = shape(r);
    const by_listing = {};
    for (const r of listingRows) by_listing[r.listing_id] = shape(r);
    res.json({ start, end, by_asin, by_listing });
  } catch (err) { next(err); }
});

// GET /products/notes — get notes for workspace (optionally filtered by product_id)
router.get("/notes", async (req, res, next) => {
  try {
    const { product_id } = req.query;
    const { rows } = await query(
      `SELECT n.*, u.name as author_name
       FROM product_notes n
       LEFT JOIN users u ON u.id = n.created_by
       WHERE n.workspace_id = $1
         AND (n.product_id IS NULL OR n.product_id = $2 OR $2 IS NULL)
       ORDER BY n.note_date DESC, n.created_at DESC`,
      [req.workspaceId, product_id || null]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// POST /products/notes — create note
router.post("/notes", async (req, res, next) => {
  try {
    const { product_id, note_date, text } = req.body;
    if (!text?.trim()) return res.status(400).json({ error: "text is required" });
    const { rows: [note] } = await query(
      `INSERT INTO product_notes (workspace_id, product_id, note_date, text, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [req.workspaceId, product_id || null, note_date || new Date().toISOString().slice(0, 10), text.trim(), req.user.id]
    );
    res.status(201).json(note);
  } catch (err) { next(err); }
});

// DELETE /products/notes/:noteId — delete note
router.delete("/notes/:noteId", async (req, res, next) => {
  try {
    await query(
      `DELETE FROM product_notes WHERE id = $1 AND workspace_id = $2`,
      [req.params.noteId, req.workspaceId]
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ─── Products report export (XLSX) ─────────────────────────────────────────
// All columns we know how to compute. Frontend sends back a subset based on
// user checkbox state, so we render only those. Order here = order in sheet.
const ALL_EXPORT_COLUMNS = [
  { key: "asin",          label: "ASIN",                 width: 14 },
  { key: "title",         label: "Title",                width: 50 },
  { key: "brand",         label: "Brand",                width: 16 },
  { key: "marketplace",   label: "Marketplace",          width: 8  },
  { key: "best_rank",     label: "Latest BSR",           width: 12, num: "#,##0" },
  { key: "best_category", label: "Best Category",        width: 22 },
  { key: "min_bsr",       label: "Best BSR (period)",    width: 14, num: "#,##0" },
  { key: "max_bsr",       label: "Worst BSR (period)",   width: 14, num: "#,##0" },
  { key: "avg_bsr",       label: "Avg BSR (period)",     width: 13, num: "#,##0" },
  { key: "first_bsr",     label: "BSR (period start)",   width: 14, num: "#,##0" },
  { key: "last_bsr",      label: "BSR (period end)",     width: 14, num: "#,##0" },
  { key: "bsr_change",    label: "BSR change %",         width: 12, num: '#,##0.0"%"' },
  { key: "snapshots",     label: "Snapshots",            width: 11, num: "#,##0" },
  { key: "ad_spend",      label: "Ad spend (€)",         width: 12, num: "#,##0.00" },
  { key: "ad_sales",      label: "Ad sales (€)",         width: 12, num: "#,##0.00" },
  { key: "ad_orders",     label: "Ad orders",            width: 11, num: "#,##0" },
  { key: "ad_clicks",     label: "Ad clicks",            width: 11, num: "#,##0" },
  { key: "ad_acos",       label: "ACoS %",               width: 10, num: '#,##0.00"%"' },
];

router.post("/export", async (req, res, next) => {
  try {
    const { startDate, endDate, columns: rawCols, format = "xlsx", includeHistory = false } = req.body || {};
    const wid = req.workspaceId;

    // ISO date format check — must validate before passing to SQL or postgres
    // throws "invalid input syntax for type date" with a leaky stack trace.
    // Accept only YYYY-MM-DD strings; allow null/undefined → use defaults.
    const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
    const validISO = (v) => v == null || (typeof v === "string" && ISO_DATE.test(v) && !isNaN(new Date(v).getTime()));
    if (!validISO(startDate)) return res.status(400).json({ error: "startDate must be in YYYY-MM-DD format" });
    if (!validISO(endDate))   return res.status(400).json({ error: "endDate must be in YYYY-MM-DD format" });

    const start = startDate || new Date(Date.now() - 30 * 86400000).toISOString().split("T")[0];
    const end   = endDate   || new Date().toISOString().split("T")[0];
    if (new Date(start) > new Date(end)) {
      return res.status(400).json({ error: "startDate must be before endDate" });
    }

    // Pick columns by key, preserving canonical order. Whitelist only — never
    // trust raw column names (no SQL string injection possible since we never
    // interpolate them, but still defensive).
    const requestedKeys = Array.isArray(rawCols) && rawCols.length
      ? new Set(rawCols)
      : new Set(ALL_EXPORT_COLUMNS.map(c => c.key));
    const cols = ALL_EXPORT_COLUMNS.filter(c => requestedKeys.has(c.key));
    if (!cols.length) return res.status(400).json({ error: "No valid columns selected" });

    // ── Aggregate per-product data ──────────────────────────────────────────
    // BSR aggregates from bsr_snapshots in [start, end].
    // Ad performance from fact_metrics_daily joined by amazon_id (advertised
    // ASIN reports use ASIN as amazon_id with entity_type='advertised_product').
    const { rows } = await query(
      `WITH bsr AS (
         SELECT product_id,
                MIN(best_rank) FILTER (WHERE best_rank IS NOT NULL)        AS min_bsr,
                MAX(best_rank) FILTER (WHERE best_rank IS NOT NULL)        AS max_bsr,
                AVG(best_rank) FILTER (WHERE best_rank IS NOT NULL)::int   AS avg_bsr,
                COUNT(*)                                                   AS snapshots,
                (ARRAY_AGG(best_rank ORDER BY captured_at ASC))[1]         AS first_bsr,
                (ARRAY_AGG(best_rank ORDER BY captured_at DESC))[1]        AS last_bsr
         FROM bsr_snapshots
         WHERE captured_at::date BETWEEN $2 AND $3
         GROUP BY product_id
       ),
       latest AS (
         SELECT DISTINCT ON (product_id) product_id, best_rank, best_category, captured_at
         FROM bsr_snapshots
         ORDER BY product_id, captured_at DESC
       ),
       ads AS (
         SELECT m.amazon_id AS asin,
                SUM(m.cost)         AS ad_spend,
                SUM(m.sales_14d)    AS ad_sales,   -- 14d attribution — app-wide standard, consistent with the UI
                SUM(m.orders_14d)   AS ad_orders,
                SUM(m.clicks)       AS ad_clicks
         FROM fact_metrics_daily m
         WHERE m.workspace_id = $1
           AND m.date BETWEEN $2 AND $3
           AND m.entity_type = 'advertised_product'
         GROUP BY m.amazon_id
       )
       SELECT p.asin, p.marketplace_id AS marketplace,
              COALESCE(p.title, '')   AS title,
              COALESCE(p.brand, '')   AS brand,
              latest.best_rank, latest.best_category,
              bsr.min_bsr, bsr.max_bsr, bsr.avg_bsr, bsr.snapshots,
              bsr.first_bsr, bsr.last_bsr,
              CASE WHEN bsr.first_bsr > 0 AND bsr.last_bsr IS NOT NULL
                   THEN ((bsr.last_bsr - bsr.first_bsr)::numeric / bsr.first_bsr * 100)::numeric(10,2)
              END AS bsr_change,
              ads.ad_spend, ads.ad_sales, ads.ad_orders, ads.ad_clicks,
              CASE WHEN ads.ad_sales > 0
                   THEN (ads.ad_spend / ads.ad_sales * 100)::numeric(10,2)
              END AS ad_acos
       FROM products p
       LEFT JOIN bsr      ON bsr.product_id    = p.id
       LEFT JOIN latest   ON latest.product_id = p.id
       LEFT JOIN ads      ON ads.asin          = p.asin
       WHERE p.workspace_id = $1 AND p.is_active = true
       ORDER BY latest.best_rank ASC NULLS LAST, p.asin ASC`,
      [wid, start, end]
    );

    // ── Build XLSX ──────────────────────────────────────────────────────────
    const wb = new ExcelJS.Workbook();
    wb.creator = "AdsFlow";
    wb.created = new Date();
    const headerFill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2D3748" } };
    const headerFont = { bold: true, color: { argb: "FFFFFFFF" }, size: 10, name: "Arial" };
    const dataFont   = { size: 10, name: "Arial" };

    // Sheet 1: Per-product summary
    const ws = wb.addWorksheet("Products");
    ws.addRow([`Period: ${start} to ${end}`]).font = { italic: true, color: { argb: "FF718096" }, size: 9 };
    ws.addRow([]);
    ws.addRow(cols.map(c => c.label));
    const headerRow = ws.getRow(3);
    headerRow.eachCell(c => { c.fill = headerFill; c.font = headerFont; c.alignment = { vertical: "middle", horizontal: "center", wrapText: true }; });
    headerRow.height = 30;
    cols.forEach((c, i) => { ws.getColumn(i + 1).width = c.width; });

    // OWASP CSV-Injection mitigation: any text cell starting with =, +, -, @,
    // tab or CR is prepended with a single quote so Excel/Sheets renders it
    // as text, not a formula. Amazon allows arbitrary product titles, and a
    // hostile listing like `=HYPERLINK("http://evil",…)` could otherwise
    // execute when the user opens the XLSX.
    const sanitizeText = (s) => {
      if (typeof s !== "string" || !s.length) return s;
      return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    };

    rows.forEach(r => {
      // Postgres returns NUMERIC columns as strings via node-postgres, so
      // numeric cells end up as text in XLSX and number formats don't apply.
      // Coerce columns that have a numFmt to actual JS numbers; leave others
      // (asin, title, brand) as strings.
      const cellValues = cols.map(c => {
        const v = r[c.key];
        if (v == null || v === "") return "";
        if (c.num) {
          const n = Number(v);
          return Number.isFinite(n) ? n : "";
        }
        return sanitizeText(v);
      });
      const newRow = ws.addRow(cellValues);
      newRow.eachCell((cell, colNum) => {
        cell.font = dataFont;
        const colDef = cols[colNum - 1];
        if (colDef.num && typeof cell.value === "number") {
          cell.numFmt = colDef.num;
        }
      });
    });
    ws.views = [{ state: "frozen", ySplit: 3 }];

    // Sheet 2 (optional): per-snapshot history
    if (includeHistory) {
      const { rows: histRows } = await query(
        `SELECT p.asin, p.title, p.brand, s.captured_at, s.best_rank, s.best_category
         FROM bsr_snapshots s
         JOIN products p ON p.id = s.product_id
         WHERE p.workspace_id = $1 AND p.is_active = true
           AND s.captured_at::date BETWEEN $2 AND $3
         ORDER BY p.asin ASC, s.captured_at DESC`,
        [wid, start, end]
      );
      const ws2 = wb.addWorksheet("BSR History");
      const HEAD2 = ["ASIN", "Title", "Brand", "Captured At (UTC)", "Best BSR", "Category"];
      ws2.addRow(HEAD2);
      const h2 = ws2.getRow(1);
      h2.eachCell(c => { c.fill = headerFill; c.font = headerFont; c.alignment = { vertical: "middle", horizontal: "center", wrapText: true }; });
      h2.height = 24;
      [14, 50, 16, 22, 12, 22].forEach((w, i) => { ws2.getColumn(i + 1).width = w; });
      histRows.forEach(r => {
        const newRow = ws2.addRow([
          sanitizeText(r.asin),
          sanitizeText(r.title || ""),
          sanitizeText(r.brand || ""),
          new Date(r.captured_at),
          r.best_rank,
          sanitizeText(r.best_category || ""),
        ]);
        newRow.eachCell((cell, colNum) => {
          cell.font = dataFont;
          if (colNum === 4) cell.numFmt = "yyyy-mm-dd hh:mm";
          if (colNum === 5) cell.numFmt = "#,##0";
        });
      });
      ws2.views = [{ state: "frozen", ySplit: 1 }];
    }

    const buffer = await wb.xlsx.writeBuffer();
    const filename = `adsflow-products-${start}_${end}.xlsx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(Buffer.from(buffer));
    logger.info("Products report exported", { wid, start, end, rows: rows.length, cols: cols.length, includeHistory });
  } catch (err) { next(err); }
});

// ─── Cross-country listings ──────────────────────────────────────────────────

// GET /products/marketplaces — the ASIN × country matrix.
// filter: all | issues (only ASINs with at least one finding abroad) | missing
// (only ASINs not listed in at least one country).
// includeDead=1 also returns ASINs absent from *every* checked country — half
// the tracked catalog is long-dead listings, and because the default sort ranks
// by "missing in most countries" they otherwise bury every actionable row.
// The test is "missing everywhere", not "missing at home", so an ASIN that is
// dead in the home marketplace but still live abroad — the interesting case —
// stays visible.
// country=IT narrows to ASINs with something to fix in that one country. It
// takes over from the cross-country `filter`, which then says *which* kind of
// problem counts there — otherwise the two would compound into "has an issue
// somewhere AND in Italy", which is not what clicking Italy means.
// Further narrowing, all optional and all combinable:
//   issue=<code>    only ASINs carrying that finding (in `country` if one is set)
//   brand=<name>    exact brand match
//   ads=advertised|not_advertised
//   coverage=single|partial|full   how many countries the ASIN is actually live in
//   sort=missing|issues|coverage|asin|title
const MKT_ISSUE_CODES = [
  "not_listed", "title_not_localized", "bullets_not_localized",
  "aplus_missing_vs_ref", "fewer_images_vs_ref", "no_bsr",
  "title", "bullets", "description", "images_count", "images_zoom", "aplus",
];
const MKT_SORTS = ["missing", "issues", "coverage", "asin", "title"];
// Whitelisted ORDER BY fragments — `sort` is validated against the keys, so no
// user text ever reaches the SQL. Every one ends in p.asin for a stable order.
const MKT_SORT_SQL = {
  missing:  "COALESCE(m.countries_missing, 0) DESC, COALESCE(m.total_issues, 0) DESC, p.asin",
  issues:   "COALESCE(m.total_issues, 0) DESC, COALESCE(m.countries_missing, 0) DESC, p.asin",
  coverage: "(COALESCE(m.countries_checked, 0) - COALESCE(m.countries_missing, 0)) ASC, p.asin",
  asin:     "p.asin",
  title:    "COALESCE(NULLIF(p.title, ''), m.any_title, p.asin), p.asin",
};

router.get("/marketplaces", async (req, res, next) => {
  try {
    const filter = ["issues", "missing"].includes(req.query.filter) ? req.query.filter : "all";
    const includeDead = req.query.includeDead === "1" || req.query.includeDead === "true";
    const search = (req.query.q || "").trim().toUpperCase();
    const country = EU_MARKETPLACES.some(m => m.countryCode === req.query.country)
      ? req.query.country
      : null;
    const issue = MKT_ISSUE_CODES.includes(req.query.issue) ? req.query.issue : null;
    const brand = (req.query.brand || "").trim() || null;
    const ads = ["advertised", "not_advertised"].includes(req.query.ads) ? req.query.ads : null;
    const coverage = ["single", "partial", "full"].includes(req.query.coverage) ? req.query.coverage : null;
    const sort = MKT_SORTS.includes(req.query.sort) ? req.query.sort : "missing";

    const params = [req.workspaceId];
    let searchFilter = "";
    if (search) {
      params.push(`%${search}%`);
      searchFilter = ` AND (UPPER(p.asin) LIKE $${params.length} OR UPPER(COALESCE(p.title,'')) LIKE $${params.length})`;
    }

    let brandFilter = "";
    if (brand) {
      params.push(brand);
      brandFilter = ` AND p.brand = $${params.length}`;
    }

    // Same advertised test the main products list uses, so the two agree.
    const advExistsMkt = `EXISTS (
      SELECT 1 FROM product_ads pa JOIN campaigns c ON c.id = pa.campaign_id
       WHERE pa.workspace_id = p.workspace_id AND UPPER(pa.asin) = p.asin
         AND pa.state = 'enabled' AND c.state = 'enabled' AND ${AD_CAN_SERVE}
    )`;
    const adsFilter = ads === "advertised" ? ` AND ${advExistsMkt}`
                    : ads === "not_advertised" ? ` AND NOT ${advExistsMkt}`
                    : "";

    // Live-country count drives the coverage buckets: "single" is the strongest
    // expansion signal (sells in one country only), "full" needs no expansion.
    const coverageFilter = coverage === "single"
        ? " AND (m.countries_checked - m.countries_missing) = 1"
      : coverage === "partial"
        ? " AND (m.countries_checked - m.countries_missing) BETWEEN 2 AND m.countries_checked - 1"
      : coverage === "full"
        ? " AND m.countries_checked > 0 AND m.countries_missing = 0"
      : "";
    const deadFilter = includeDead
      ? ""
      : " AND NOT (COALESCE(m.countries_checked, 0) > 0 AND m.countries_missing = m.countries_checked)";

    // Country-scoped view. `not_listed` is itself a finding, so the unfiltered
    // "issue_count > 0" already covers both a missing listing and a flawed one.
    let countryFilter = "";
    let countrySeverity = "NULL";
    if (country) {
      params.push(country);
      const ci = `$${params.length}`;
      const cond = filter === "missing" ? "NOT lc.exists_in_catalog"
                 : filter === "issues"  ? "lc.exists_in_catalog AND lc.issue_count > 0"
                 : "lc.issue_count > 0";
      countryFilter = ` AND EXISTS (SELECT 1 FROM product_marketplace_listings lc
                                     WHERE lc.product_id = p.id AND lc.country_code = ${ci} AND ${cond})`;
      // Rank by how bad that one country is: absent listings first, then by
      // number of findings. 1000 is simply above any achievable issue count.
      countrySeverity = `MAX(CASE WHEN l.country_code = ${ci}
                                  THEN CASE WHEN NOT l.exists_in_catalog THEN 1000 ELSE l.issue_count END
                             END)`;
    }

    // Issue-type filter. Scoped to the selected country when there is one —
    // "missing A+ in Italy" is a different question from "missing A+ anywhere".
    let issueFilter = "";
    if (issue) {
      params.push(JSON.stringify([{ code: issue }]));
      const ii = `$${params.length}`;
      let scope = "";
      if (country) {
        params.push(country);
        scope = ` AND li.country_code = $${params.length}`;
      }
      issueFilter = ` AND EXISTS (SELECT 1 FROM product_marketplace_listings li
                                   WHERE li.product_id = p.id${scope}
                                     AND li.issues @> ${ii}::jsonb)`;
    }

    const { rows } = await query(
      `SELECT p.id, p.asin, p.marketplace_id AS reference_marketplace_id,
              -- products.title/image_url only ever hold the home-marketplace copy
              -- and are empty for every ASIN dead at home — half the catalogue.
              -- Those rows still have live listings abroad, so fall back to any
              -- country that has one (preferring the home marketplace).
              COALESCE(NULLIF(p.title, ''), m.any_title)   AS title,
              COALESCE(p.image_url, m.any_image)           AS image_url,
              COALESCE(m.cells, '[]'::json) AS cells,
              COALESCE(m.countries_checked, 0)  AS countries_checked,
              COALESCE(m.countries_missing, 0)  AS countries_missing,
              COALESCE(m.total_issues, 0)       AS total_issues,
              m.checked_at
         FROM products p
         LEFT JOIN LATERAL (
           SELECT json_agg(json_build_object(
                    'marketplaceId',   l.marketplace_id,
                    'countryCode',     l.country_code,
                    'isReference',     l.is_reference,
                    'existsInCatalog', l.exists_in_catalog,
                    'title',           l.title,
                    'titleLen',        l.title_len,
                    'bulletCount',     l.bullet_count,
                    'imageCount',      l.image_count,
                    'hasAplus',        l.has_aplus,
                    'bestRank',        l.best_rank,
                    'issues',          l.issues,
                    'issueCount',      l.issue_count,
                    'errorMessage',    l.error_message
                  ) ORDER BY l.is_reference DESC, l.country_code)      AS cells,
                  COUNT(*)                                             AS countries_checked,
                  COUNT(*) FILTER (WHERE NOT l.exists_in_catalog)      AS countries_missing,
                  SUM(l.issue_count)                                   AS total_issues,
                  MAX(l.checked_at)                                    AS checked_at,
                  (array_agg(l.title ORDER BY l.is_reference DESC, l.country_code)
                     FILTER (WHERE NULLIF(l.title, '') IS NOT NULL))[1]     AS any_title,
                  (array_agg(l.image_url ORDER BY l.is_reference DESC, l.country_code)
                     FILTER (WHERE l.image_url IS NOT NULL))[1]            AS any_image,
                  ${countrySeverity}                                       AS country_severity
             FROM product_marketplace_listings l
            WHERE l.product_id = p.id
         ) m ON true
        WHERE p.workspace_id = $1 AND p.is_active = true${searchFilter}${deadFilter}${countryFilter}${issueFilter}${brandFilter}${adsFilter}${coverageFilter}
          ${!country && filter === "issues"  ? "AND COALESCE(m.total_issues, 0) > 0" : ""}
          ${!country && filter === "missing" ? "AND COALESCE(m.countries_missing, 0) > 0" : ""}
        ORDER BY ${country ? "COALESCE(m.country_severity, -1) DESC," : ""}
                 ${MKT_SORT_SQL[sort]}`,
      params
    );

    // How many rows the dead-everywhere filter is holding back, so the UI can
    // say so instead of silently showing a shorter list.
    const { rows: [deadRow] } = await query(
      `SELECT COUNT(*)::int AS n FROM products p
         JOIN LATERAL (
           SELECT COUNT(*) AS checked, COUNT(*) FILTER (WHERE NOT l.exists_in_catalog) AS missing
             FROM product_marketplace_listings l WHERE l.product_id = p.id
         ) m ON true
        WHERE p.workspace_id = $1 AND p.is_active = true
          AND m.checked > 0 AND m.missing = m.checked`,
      [req.workspaceId]
    );

    // Per-country rollup for the summary strip above the matrix. It must honour
    // the same dead-everywhere exclusion as the list below it — otherwise the
    // card promises "185 not listed in IT" and clicking it returns 26, because
    // the other 159 are ASINs hidden as dead in every country.
    const { rows: byCountry } = await query(
      `SELECT l.country_code, l.marketplace_id,
              COUNT(*)                                        AS products,
              COUNT(*) FILTER (WHERE NOT l.exists_in_catalog) AS missing,
              -- Excludes the not-listed rows: "not listed" is itself a finding,
              -- so counting them here too made the strip read as 65 missing +
              -- 67 with findings out of 76 — the same ASINs counted twice.
              COUNT(*) FILTER (WHERE l.exists_in_catalog AND l.issue_count > 0) AS with_issues,
              SUM(l.issue_count) FILTER (WHERE l.exists_in_catalog)             AS issues
         FROM product_marketplace_listings l
         JOIN products p ON p.id = l.product_id
         JOIN LATERAL (
           SELECT COUNT(*) AS checked, COUNT(*) FILTER (WHERE NOT l2.exists_in_catalog) AS missing
             FROM product_marketplace_listings l2 WHERE l2.product_id = p.id
         ) d ON true
        WHERE p.workspace_id = $1 AND p.is_active = true
          ${includeDead ? "" : "AND NOT (d.checked > 0 AND d.missing = d.checked)"}
        GROUP BY l.country_code, l.marketplace_id
        ORDER BY l.country_code`,
      [req.workspaceId]
    );

    // Brand list for the picker — only brands that actually have checked rows,
    // so the dropdown can never offer an option that returns nothing.
    const { rows: brands } = await query(
      `SELECT DISTINCT p.brand
         FROM products p
        WHERE p.workspace_id = $1 AND p.is_active = true
          AND NULLIF(p.brand, '') IS NOT NULL
          AND EXISTS (SELECT 1 FROM product_marketplace_listings l WHERE l.product_id = p.id)
        ORDER BY p.brand`,
      [req.workspaceId]
    );

    res.json({
      marketplaces: EU_MARKETPLACES, items: rows, byCountry, filter, country,
      includeDead, deadCount: deadRow?.n || 0,
      issue, brand, ads, coverage, sort,
      brands: brands.map(b => b.brand),
      issueCodes: MKT_ISSUE_CODES,
    });
  } catch (err) { next(err); }
});

// POST /products/marketplaces/check — run the cross-country sweep now.
// Optional body: { asins: [...], marketplaceIds: [...] } to narrow the scope —
// a full sweep is 2 SP-API calls per (ASIN, country) and runs for hours.
router.post("/marketplaces/check", async (req, res, next) => {
  try {
    if (!process.env.SP_API_REFRESH_TOKEN) {
      return res.status(503).json({ error: "SP-API not configured" });
    }
    const asins = Array.isArray(req.body?.asins)
      ? req.body.asins.filter(a => /^[A-Za-z0-9]{10}$/.test(String(a).trim()))
      : [];
    const marketplaceIds = Array.isArray(req.body?.marketplaceIds)
      ? req.body.marketplaceIds.filter(m => EU_MARKETPLACE_IDS.includes(m))
      : [];
    // Resume rather than restart. A sweep runs for hours, so anything that stops the worker
    // mid-way (deploy, restart, BullMQ giving up after repeated stalls) leaves a partly-checked
    // catalogue; re-running from zero spends the whole SP-API quota again on rows that are
    // already fresh. staleHours > 0 skips products whose entire country set was checked that
    // recently. 0 (the default) keeps the plain "check everything now" behaviour.
    const staleHours = Number.isFinite(Number(req.body?.staleHours))
      ? Math.max(0, Math.min(168, Number(req.body.staleHours)))
      : 0;

    const { rows: [product] } = await query(
      `SELECT marketplace_id FROM products
        WHERE workspace_id=$1 AND is_active=true LIMIT 1`,
      [req.workspaceId]
    );
    if (!product) return res.status(400).json({ error: "No active products to check" });

    const job = await queueSpSync(
      req.workspaceId, product.marketplace_id, ["marketplace_listings"], 3,
      { asins, marketplaceIds, staleHours }
    );
    res.json({
      jobId: job.id, asins: asins.length || "all",
      countries: marketplaceIds.length || EU_MARKETPLACE_IDS.length, staleHours,
    });
  } catch (err) { next(err); }
});

// GET /products/marketplaces/status — is a cross-country sweep running, and how far along?
//
// A sweep is queued, not run inline, so POST /marketplaces/check returns long before any work
// happens. Without this the UI could only report "queued" and had to re-enable its button
// immediately, while the sweep itself ran for another couple of hours.
//
// Declared before "/:id/marketplaces" so Express does not match "marketplaces" as an :id.
router.get("/marketplaces/status", async (req, res, next) => {
  try {
    // A sweep whose worker died (backend restart, container kill) leaves its log row
    // 'running' forever — nothing ever writes completed_at. Without an age cut-off the
    // button that keys off this endpoint would stay disabled permanently. A full sweep is
    // ~2.5h, so anything older than STALE_RUN_HOURS is treated as dead, not running.
    const STALE_RUN_HOURS = 6;
    const { rows: [run] } = await query(
      `SELECT id, started_at, progress_done, progress_total
         FROM sp_sync_log
        WHERE workspace_id=$1 AND sync_type='marketplace_listings' AND status='running'
          AND started_at > NOW() - make_interval(hours => $2::int)
        ORDER BY started_at DESC LIMIT 1`,
      [req.workspaceId, STALE_RUN_HOURS]
    );

    if (!run) {
      // Report the last finish too, so the page can tell "never run" from "done a while ago".
      const { rows: [last] } = await query(
        `SELECT status, completed_at, records_upserted
           FROM sp_sync_log
          WHERE workspace_id=$1 AND sync_type='marketplace_listings'
            AND (status <> 'running' OR started_at <= NOW() - make_interval(hours => $2::int))
          ORDER BY started_at DESC LIMIT 1`,
        [req.workspaceId, STALE_RUN_HOURS]
      );
      return res.json({
        running: false,
        lastStatus:      last?.status || null,
        lastCompletedAt: last?.completed_at || null,
        lastUpserted:    last?.records_upserted ?? null,
      });
    }

    // A sweep started before progress tracking existed has no counters. Fall back to counting
    // the rows it has written so far — same number, just costlier to obtain.
    let done  = run.progress_done;
    let total = run.progress_total;
    if (done == null) {
      const { rows: [c] } = await query(
        `SELECT COUNT(*)::int AS n
           FROM product_marketplace_listings l
           JOIN products p ON p.id = l.product_id
          WHERE p.workspace_id=$1 AND l.checked_at >= $2`,
        [req.workspaceId, run.started_at]
      );
      done = c?.n ?? 0;
    }

    res.json({
      running: true,
      startedAt: run.started_at,
      done,
      total: total ?? null,
      pct: total ? Math.min(100, Math.round((done / total) * 100)) : null,
    });
  } catch (err) { next(err); }
});

// GET /products/:id/marketplaces — full per-country detail for one ASIN.
router.get("/:id/marketplaces", async (req, res, next) => {
  try {
    const { rows: [product] } = await query(
      `SELECT id, asin, title, image_url, marketplace_id FROM products
        WHERE id=$1 AND workspace_id=$2`,
      [req.params.id, req.workspaceId]
    );
    if (!product) return res.status(404).json({ error: "Product not found" });

    const { rows } = await query(
      `SELECT marketplace_id, country_code, is_reference, exists_in_catalog, title,
              title_len, bullet_count, image_count, has_zoomable_image, has_description,
              has_aplus, best_rank, best_category, issues, issue_count, error_message, checked_at
         FROM product_marketplace_listings
        WHERE product_id=$1
        ORDER BY is_reference DESC, country_code`,
      [product.id]
    );

    res.json({
      product,
      marketplaces: EU_MARKETPLACES,
      listings: rows.map(r => ({ ...r, url: listingUrl(product.asin, r.marketplace_id) })),
    });
  } catch (err) { next(err); }
});

// DELETE /products/:id — soft delete (deactivate tracking)
router.delete("/:id", async (req, res, next) => {
  try {
    await query(
      `UPDATE products SET is_active=false, updated_at=NOW()
       WHERE id=$1 AND workspace_id=$2`,
      [req.params.id, req.workspaceId]
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
