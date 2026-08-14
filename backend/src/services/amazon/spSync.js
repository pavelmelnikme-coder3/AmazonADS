const crypto = require("crypto");
const pool = require("../../db/pool");
const logger = require("../../config/logger");
const {
  getCatalogItem,
  getListingContent,
  getAplusStatus,
  getInventory,
  getOrders,
  getOrderItems,
  getFinancialEvents,
  getCompetitivePricing,
} = require("./spClient");
const { computeListingIssues, computeCrossCountryIssues } = require("./listingHealth");
const { EU_MARKETPLACES } = require("./marketplaces");

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function _startLog(workspaceId, marketplaceId, syncType) {
  const { rows } = await pool.query(
    `INSERT INTO sp_sync_log (workspace_id, marketplace_id, sync_type, status)
     VALUES ($1, $2, $3, 'running') RETURNING id`,
    [workspaceId, marketplaceId, syncType]
  );
  return rows[0].id;
}

// Progress for sweeps long enough that the UI needs to show one. Best-effort:
// a failed progress write must never abort the sweep it is only reporting on.
async function _setProgress(logId, done, total) {
  try {
    await pool.query(
      "UPDATE sp_sync_log SET progress_done=$1, progress_total=$2 WHERE id=$3",
      [done, total, logId]
    );
  } catch (err) {
    logger.warn("Failed to update sync progress", { logId, error: err.message });
  }
}

async function _finishLog(logId, status, counts, extra = {}) {
  await pool.query(
    `UPDATE sp_sync_log SET status=$1, records_fetched=$2, records_upserted=$3,
     error_message=$4, completed_at=NOW() WHERE id=$5`,
    [status, counts.fetched || 0, counts.upserted || 0, extra.error || null, logId]
  );
}

// ─── BSR Sync ─────────────────────────────────────────────────────────────────
async function syncBsr(workspaceId, marketplaceId, refreshToken) {
  const logId = await _startLog(workspaceId, marketplaceId, "bsr");
  let fetched = 0, upserted = 0;
  try {
    const { rows: products } = await pool.query(
      `SELECT id, asin FROM products WHERE workspace_id=$1 AND marketplace_id=$2 AND is_active=true`,
      [workspaceId, marketplaceId]
    );
    for (const product of products) {
      try {
        const data = await getCatalogItem(product.asin, marketplaceId, refreshToken);
        fetched++;
        await pool.query(
          `UPDATE products SET title=$1, brand=$2, image_url=$3,
             parent_asin=COALESCE($4, parent_asin), updated_at=NOW() WHERE id=$5`,
          [data.title, data.brand, data.imageUrl, data.parentAsin, product.id]
        );
        const bestRank = _bestRank(data.classificationRanks, data.displayGroupRanks);
        await pool.query(
          `INSERT INTO bsr_snapshots (product_id, classification_ranks, display_group_ranks, best_rank, best_category, raw_data)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [product.id, JSON.stringify(data.classificationRanks), JSON.stringify(data.displayGroupRanks),
           bestRank?.rank || null, bestRank?.category || null, JSON.stringify(data.rawData || {})]
        );
        upserted++;
        await _sleep(600);
      } catch (err) {
        if (err.message?.includes("rate limit")) {
          logger.warn(`BSR sync rate-limited, pausing 10s`, { asin: product.asin });
          await _sleep(10000);
        } else {
          logger.warn(`BSR sync failed for ASIN ${product.asin}`, { error: err.message });
        }
      }
    }
    await _finishLog(logId, "success", { fetched, upserted });
    return { fetched, upserted };
  } catch (err) {
    await _finishLog(logId, "failed", { fetched, upserted }, { error: err.message });
    throw err;
  }
}

// ─── Listing Health sync ──────────────────────────────────────────────────────
// Recomputes Amazon's own "listing improvement recommendations" checks per ASIN
// (title length, bullets, description, image count/zoom, A+ content). Two SP-API
// calls per product (Catalog Items + A+ Content), so this runs far less often
// than BSR — daily, not every 4h (see scheduler.js listingHealthJob).
async function syncListingHealth(workspaceId, marketplaceId, refreshToken) {
  const logId = await _startLog(workspaceId, marketplaceId, "listing_health");
  let fetched = 0, upserted = 0;
  try {
    const { rows: products } = await pool.query(
      `SELECT id, asin FROM products WHERE workspace_id=$1 AND marketplace_id=$2 AND is_active=true`,
      [workspaceId, marketplaceId]
    );
    for (const product of products) {
      try {
        const content = await getListingContent(product.asin, marketplaceId, refreshToken);
        await _sleep(500);
        const aplus = await getAplusStatus(product.asin, marketplaceId, refreshToken);
        fetched++;

        const result = computeListingIssues({
          title: content.title,
          bulletPoints: content.bulletPoints,
          description: content.description,
          images: content.images,
          hasAplus: aplus.hasAplus,
        });

        await pool.query(
          `INSERT INTO product_listing_health
             (product_id, title_len, bullet_count, image_count, has_zoomable_image,
              has_description, has_aplus, issues, issue_count, raw_data, checked_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
           ON CONFLICT (product_id) DO UPDATE SET
             title_len=$2, bullet_count=$3, image_count=$4, has_zoomable_image=$5,
             has_description=$6, has_aplus=$7, issues=$8, issue_count=$9, raw_data=$10, checked_at=NOW()`,
          [
            product.id, result.titleLen, result.bulletCount, result.imageCount,
            result.hasZoomableImage, result.hasDescription, result.hasAplus,
            JSON.stringify(result.issues), result.issueCount, JSON.stringify(content.rawData || {}),
          ]
        );
        upserted++;
        await _sleep(500);
      } catch (err) {
        if (err.message?.includes("rate limit")) {
          logger.warn(`Listing health sync rate-limited, pausing 10s`, { asin: product.asin });
          await _sleep(10000);
        } else {
          logger.warn(`Listing health sync failed for ASIN ${product.asin}`, { error: err.message });
        }
      }
    }
    await _finishLog(logId, "success", { fetched, upserted });
    return { fetched, upserted };
  } catch (err) {
    await _finishLog(logId, "failed", { fetched, upserted }, { error: err.message });
    throw err;
  }
}

function _bestRank(classificationRanks, displayGroupRanks) {
  const all = [...(classificationRanks || []), ...(displayGroupRanks || [])];
  if (!all.length) return null;
  const best = all.reduce((a, b) => (a.rank < b.rank ? a : b));
  return { rank: best.rank, category: best.title || best.displayGroupId || null };
}

// ─── Inventory Sync ───────────────────────────────────────────────────────────
async function syncInventory(workspaceId, marketplaceId, refreshToken) {
  const logId = await _startLog(workspaceId, marketplaceId, "inventory");
  let fetched = 0, upserted = 0;
  try {
    const items = await getInventory(marketplaceId, refreshToken);
    fetched = items.length;
    // FBA Inventory API returns quantities as plain numbers (0 is meaningful = out of stock),
    // so coalesce only on null/undefined — never with `|| null`, which would drop a real 0.
    const num = (v) => (v == null ? null : Number(v));
    for (const item of items) {
      const inv = item.inventoryDetails || {};
      const rs  = inv.researchingQuantity || {};
      await pool.query(
        `INSERT INTO sp_inventory
           (workspace_id, asin, marketplace_id, seller_sku, condition, fulfillment_channel,
            quantity_total, quantity_sellable, quantity_reserved, quantity_pending_removal,
            inbound_working, inbound_shipped, inbound_receiving,
            researching_quantity, unfulfillable_quantity, raw_data, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW())
         ON CONFLICT (workspace_id, asin, marketplace_id, seller_sku, fulfillment_channel)
         DO UPDATE SET
           condition=$5, quantity_total=$7, quantity_sellable=$8, quantity_reserved=$9,
           quantity_pending_removal=$10, inbound_working=$11, inbound_shipped=$12,
           inbound_receiving=$13, researching_quantity=$14, unfulfillable_quantity=$15,
           raw_data=$16, synced_at=NOW(), updated_at=NOW()`,
        [
          workspaceId, item.asin, marketplaceId,
          item.sellerSku || "", item.condition || null,
          item.fulfillmentChannelCode || "",
          num(item.totalQuantity),
          num(inv.fulfillableQuantity),
          num(inv.reservedQuantity?.totalReservedQuantity),
          num(inv.pendingCustomsQuantity),
          num(inv.inboundWorkingQuantity),
          num(inv.inboundShippedQuantity),
          num(inv.inboundReceivingQuantity),
          num(rs.totalResearchingQuantity),
          num(inv.unfulfillableQuantity?.totalUnfulfillableQuantity),
          JSON.stringify(item),
        ]
      );
      upserted++;
    }
    await _finishLog(logId, "success", { fetched, upserted });
    return { fetched, upserted };
  } catch (err) {
    await _finishLog(logId, "failed", { fetched, upserted }, { error: err.message });
    throw err;
  }
}

// ─── Orders Sync ──────────────────────────────────────────────────────────────
async function syncOrders(workspaceId, marketplaceId, refreshToken, options = {}) {
  const logId = await _startLog(workspaceId, marketplaceId, "orders");
  let fetched = 0, upserted = 0;
  try {
    // Incremental: resume from the last known order date. On first run (empty
    // table) start with a 7-day window — Orders API rate is 1 req/min so a
    // 30-day backfill across many pages can take an hour. Once the table has
    // data, subsequent runs are tiny incrementals.
    if (!options.createdAfter) {
      const { rows } = await pool.query(
        `SELECT MAX(purchase_date) AS last FROM sp_orders WHERE workspace_id=$1 AND marketplace_id=$2`,
        [workspaceId, marketplaceId]
      );
      if (rows[0].last) {
        options.createdAfter = rows[0].last.toISOString();
      } else {
        options.createdAfter = new Date(Date.now() - 7 * 86400000).toISOString();
      }
    }

    const orders = await getOrders(marketplaceId, refreshToken, options);
    fetched = orders.length;

    for (const o of orders) {
      const { rows: [order] } = await pool.query(
        `INSERT INTO sp_orders
           (workspace_id, amazon_order_id, marketplace_id, purchase_date, last_update_date,
            order_status, fulfillment_channel, sales_channel, order_type,
            number_of_items_shipped, number_of_items_unshipped,
            order_total_amount, order_total_currency,
            is_business_order, is_prime, is_premium_order, is_replacement_order,
            buyer_email, ship_city, ship_state, ship_country, ship_postal_code,
            promised_delivery_date, earliest_ship_date, latest_ship_date, raw_data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
         ON CONFLICT (workspace_id, amazon_order_id) DO UPDATE SET
           last_update_date=$5, order_status=$6, number_of_items_shipped=$10,
           number_of_items_unshipped=$11, order_total_amount=$12, raw_data=$26, updated_at=NOW()
         RETURNING id, last_update_date`,
        [
          workspaceId, o.AmazonOrderId, marketplaceId,
          o.PurchaseDate || null, o.LastUpdateDate || null,
          o.OrderStatus, o.FulfillmentChannel, o.SalesChannel, o.OrderType,
          o.NumberOfItemsShipped || 0, o.NumberOfItemsUnshipped || 0,
          o.OrderTotal?.Amount || null, o.OrderTotal?.CurrencyCode || null,
          o.IsBusinessOrder || false, o.IsPrime || false,
          o.IsPremiumOrder || false, o.IsReplacementOrder || false,
          o.BuyerInfo?.BuyerEmail || null,
          o.ShippingAddress?.City || null, o.ShippingAddress?.StateOrRegion || null,
          o.ShippingAddress?.CountryCode || null, o.ShippingAddress?.PostalCode || null,
          o.PromisedDeliveryDate || null, o.EarliestShipDate || null, o.LatestShipDate || null,
          JSON.stringify(o),
        ]
      );
      upserted++;

      // Fetch items only if status changed or new
      try {
        const items = await getOrderItems(o.AmazonOrderId, marketplaceId, refreshToken);
        for (const item of items) {
          await pool.query(
            `INSERT INTO sp_order_items
               (order_id, workspace_id, amazon_order_item_id, asin, seller_sku, title,
                quantity_ordered, quantity_shipped,
                item_price_amount, item_price_currency, item_tax_amount,
                shipping_price_amount, shipping_discount_amount, promotion_discount_amount,
                points_granted, condition_id, condition_subtype, is_gift, is_transparency, raw_data)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
             ON CONFLICT (order_id, amazon_order_item_id) DO UPDATE SET
               quantity_shipped=$8, item_price_amount=$9, raw_data=$20, updated_at=NOW()`,
            [
              order.id, workspaceId, item.OrderItemId,
              item.ASIN, item.SellerSKU, item.Title,
              item.QuantityOrdered || 0, item.QuantityShipped || 0,
              item.ItemPrice?.Amount || null, item.ItemPrice?.CurrencyCode || null,
              item.ItemTax?.Amount || null,
              item.ShippingPrice?.Amount || null,
              item.ShippingDiscount?.Amount || null,
              item.PromotionDiscount?.Amount || null,
              item.PointsGranted?.PointsNumber || null,
              item.ConditionId, item.ConditionSubtypeId,
              item.IsGift === "true", item.IsTransparency || false,
              JSON.stringify(item),
            ]
          );
        }
        await _sleep(400);
      } catch (itemErr) {
        logger.warn(`Order items fetch failed for ${o.AmazonOrderId}`, { error: itemErr.message });
      }
    }
    await _finishLog(logId, "success", { fetched, upserted });
    return { fetched, upserted };
  } catch (err) {
    await _finishLog(logId, "failed", { fetched, upserted }, { error: err.message });
    throw err;
  }
}

// ─── Financials Sync ──────────────────────────────────────────────────────────
async function syncFinancials(workspaceId, marketplaceId, refreshToken, options = {}) {
  const logId = await _startLog(workspaceId, marketplaceId, "financials");
  let fetched = 0, upserted = 0;
  try {
    if (!options.postedAfter) {
      const { rows } = await pool.query(
        `SELECT MAX(posted_date) AS last FROM sp_financials WHERE workspace_id=$1`,
        [workspaceId]
      );
      if (rows[0].last) options.postedAfter = rows[0].last.toISOString();
    }

    const events = await getFinancialEvents(marketplaceId, refreshToken, options);
    fetched = events.length;

    for (const ev of events) {
      const r = ev.raw;
      const amount = _extractAmount(r);
      const postedDate = r.PostedDate || r.TransactionPostedDate || null;
      const orderId = r.AmazonOrderId || r.MarketplaceOrderId || null;
      const asin = r.ItemChargeList?.[0]?.ASIN || r.ASIN || null;
      const sku  = r.SellerSKU || r.SellerOrderId || null;

      const hashSrc = `${workspaceId}${orderId || ""}${ev.event_type}${postedDate || ""}${asin || ""}${sku || ""}${amount || ""}`;
      const eventHash = crypto.createHash("md5").update(hashSrc).digest("hex");

      await pool.query(
        `INSERT INTO sp_financials
           (workspace_id, marketplace_id, amazon_order_id, posted_date, event_type, event_group,
            amount, currency_code, asin, seller_sku, transaction_type, description, event_hash, raw_data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (event_hash) WHERE event_hash IS NOT NULL DO NOTHING`,
        [
          workspaceId, marketplaceId, orderId, postedDate,
          ev.event_type, ev.event_group,
          amount, _extractCurrency(r), asin, sku,
          r.TransactionType || null, r.Description || null,
          eventHash, JSON.stringify(r),
        ]
      );
      upserted++;
    }
    await _finishLog(logId, "success", { fetched, upserted });
    return { fetched, upserted };
  } catch (err) {
    await _finishLog(logId, "failed", { fetched, upserted }, { error: err.message });
    throw err;
  }
}

function _extractAmount(r) {
  return r.ItemChargeList?.[0]?.ChargeAmount?.CurrencyAmount
    || r.ShipmentFeeList?.[0]?.FeeAmount?.CurrencyAmount
    || r.Amount?.CurrencyAmount
    || null;
}
function _extractCurrency(r) {
  return r.ItemChargeList?.[0]?.ChargeAmount?.CurrencyCode
    || r.Amount?.CurrencyCode
    || null;
}

// ─── Pricing Sync ─────────────────────────────────────────────────────────────
async function syncPricing(workspaceId, marketplaceId, refreshToken) {
  const logId = await _startLog(workspaceId, marketplaceId, "pricing");
  let fetched = 0, upserted = 0;
  try {
    const { rows: products } = await pool.query(
      `SELECT DISTINCT asin FROM products WHERE workspace_id=$1 AND marketplace_id=$2 AND is_active=true`,
      [workspaceId, marketplaceId]
    );
    const asins = products.map(p => p.asin);
    if (!asins.length) {
      await _finishLog(logId, "success", { fetched: 0, upserted: 0 });
      return { fetched: 0, upserted: 0 };
    }

    const pricingData = await getCompetitivePricing(asins, marketplaceId, refreshToken);
    fetched = pricingData.length;

    for (const item of pricingData) {
      const asin = item.ASIN;
      const detail = item.Product?.CompetitivePricing || {};
      const compPrices = detail.CompetitivePrices || [];
      const buyBox = compPrices.find(p => p.belongsToRequester && p.CompetitivePriceType === "BuyBoxPrice")
                  || compPrices.find(p => p.CompetitivePriceType === "BuyBoxPrice");
      const listing = compPrices.find(p => p.condition === "New") || compPrices[0];

      await pool.query(
        `INSERT INTO sp_pricing
           (workspace_id, asin, marketplace_id, item_condition,
            listing_price_amount, listing_price_currency,
            buy_box_price_amount, buy_box_price_currency, buy_box_seller_id,
            competitive_prices, offers_count, raw_data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          workspaceId, asin, marketplaceId, "New",
          listing?.Price?.LandedPrice?.Amount || null,
          listing?.Price?.LandedPrice?.CurrencyCode || null,
          buyBox?.Price?.LandedPrice?.Amount || null,
          buyBox?.Price?.LandedPrice?.CurrencyCode || null,
          buyBox?.sellerId || null,
          JSON.stringify(compPrices),
          detail.NumberOfOfferListings?.reduce((s, o) => s + (o.Count || 0), 0) || null,
          JSON.stringify(item),
        ]
      );
      upserted++;
    }
    await _finishLog(logId, "success", { fetched, upserted });
    return { fetched, upserted };
  } catch (err) {
    await _finishLog(logId, "failed", { fetched, upserted }, { error: err.message });
    throw err;
  }
}

// ─── Cross-country listing sync ───────────────────────────────────────────────
// Checks the same ASIN in every EU marketplace the seller participates in, so
// the Products page can answer "where is this listing missing or unlocalized?".
//
// Deliberately per-marketplace calls rather than one batched request: verified
// 2026-07-31 that getCatalogItem accepts a comma-separated marketplaceIds list
// but is all-or-nothing — if the ASIN is absent from a single marketplace the
// whole request 404s, which is exactly the case we most need data for.
//
// Cost is 2 SP-API calls per (ASIN, country) — Catalog Items + A+ Content — so
// ~10k calls for 553 ASINs across 9 countries. Catalog Items documents 5 rps,
// but a probe on 2026-07-31 drew a 429 QuotaExceeded at roughly 3 rps sustained,
// so the default pace below deliberately sits far under the documented ceiling
// and backs off further whenever Amazon does push back. A full sweep is a
// multi-hour background job by design — see `_Throttle`.
const LISTING_PACE_MS = Number(process.env.SP_LISTING_PACE_MS || 700);

// Adaptive pacing: widens the gap between calls on every 429 and only walks it
// back after a run of clean responses. Being throttled is a signal that the
// account's real quota is below the documented one, so the sweep should slow
// down and stay slow rather than immediately re-provoking the limit.
class _Throttle {
  constructor(baseMs) {
    this.base = baseMs;
    this.current = baseMs;
    this.clean = 0;
    this.throttled = 0;
  }
  async wait() { await _sleep(this.current); }
  penalise() {
    this.throttled++;
    this.clean = 0;
    this.current = Math.min(Math.round(this.current * 1.5), 10000);
  }
  reward() {
    // 25 clean calls before easing off — fast enough to recover on a one-off
    // blip, slow enough not to oscillate around a genuinely lower quota.
    if (this.current === this.base) return;
    if (++this.clean >= 25) {
      this.clean = 0;
      this.current = Math.max(this.base, Math.round(this.current / 1.5));
    }
  }
}

async function syncMarketplaceListings(workspaceId, refreshToken, options = {}) {
  const targets = (options.marketplaceIds && options.marketplaceIds.length)
    ? EU_MARKETPLACES.filter(m => options.marketplaceIds.includes(m.marketplaceId))
    : EU_MARKETPLACES;

  // Skip products whose whole country set was already checked this recently, so
  // an interrupted sweep can be re-run to pick up only what it never reached
  // instead of spending the entire quota again on rows it already has.
  const staleHours = Number.isFinite(options.staleHours) ? Number(options.staleHours) : 0;
  const limit = Number.isFinite(options.limit) ? Number(options.limit) : 0;
  const throttle = new _Throttle(Number(options.paceMs) || LISTING_PACE_MS);

  const logId = await _startLog(workspaceId, targets.map(m => m.countryCode).join(","), "marketplace_listings");
  let fetched = 0, upserted = 0;
  try {
    const params = [workspaceId];
    let sql = `SELECT p.id, p.asin, p.marketplace_id FROM products p
                WHERE p.workspace_id=$1 AND p.is_active=true`;
    if (options.asins && options.asins.length) {
      params.push(options.asins.map(a => a.toUpperCase()));
      sql += ` AND UPPER(p.asin) = ANY($${params.length})`;
    }
    if (staleHours > 0) {
      // Array.push returns the new length, which is exactly the 1-based
      // placeholder index for the value just added.
      const iMkts  = params.push(targets.map(m => m.marketplaceId));
      const iHours = params.push(staleHours);
      const iCount = params.push(targets.length);
      sql += ` AND (
        SELECT COUNT(*) FROM product_marketplace_listings l
         WHERE l.product_id = p.id
           AND l.marketplace_id = ANY($${iMkts})
           AND l.checked_at > NOW() - make_interval(hours => $${iHours}::int)
      ) < $${iCount}::int`;
    }
    sql += " ORDER BY p.asin";
    if (limit > 0) {
      params.push(limit);
      sql += ` LIMIT $${params.length}`;
    }
    const { rows: products } = await pool.query(sql, params);

    logger.info("Cross-country listing sync started", {
      workspaceId, products: products.length, countries: targets.length,
      paceMs: throttle.base, staleHours,
    });

    // Publish the size of the sweep up front so the UI can show a real progress
    // bar from the first poll rather than an indeterminate spinner for hours.
    const progressTotal = products.length * targets.length;
    await _setProgress(logId, 0, progressTotal);

    for (const product of products) {
      // Gather every marketplace first, then score — the cross-country checks
      // need the home-marketplace listing as their reference, and it is not
      // guaranteed to be the first one fetched.
      const perMarket = [];
      for (const mkt of targets) {
        const row = await _fetchOneMarketplaceListing(product, mkt, refreshToken, throttle);
        perMarket.push(row);
        if (row.existsInCatalog) fetched++;
      }

      const reference = perMarket.find(r => r.marketplaceId === product.marketplace_id && r.existsInCatalog) || null;

      for (const row of perMarket) {
        const isReference = row.marketplaceId === product.marketplace_id;
        let issues = row.base ? [...row.base.issues] : [];

        if (!row.existsInCatalog) {
          // "Not listed" applies to the home marketplace too. Without this the
          // reference row would carry zero findings while its cell renders red,
          // and the detail panel would claim the listing is clean.
          issues = [{ code: "not_listed" }];
        } else if (!isReference) {
          const cross = computeCrossCountryIssues({
            target: {
              title: row.title,
              bulletPoints: row.bulletPoints,
              hasAplus: row.base?.hasAplus || false,
              imageCount: row.base?.imageCount || 0,
              bestRank: row.bestRank,
            },
            reference: reference && {
              title: reference.title,
              bulletPoints: reference.bulletPoints,
              hasAplus: reference.base?.hasAplus || false,
              imageCount: reference.base?.imageCount || 0,
            },
            existsInCatalog: row.existsInCatalog,
          });
          issues = cross.replacesBase
            ? cross.issues
            : [...issues.filter(i => !cross.drop?.has(i.code)), ...cross.issues];
        }

        await pool.query(
          `INSERT INTO product_marketplace_listings
             (product_id, marketplace_id, country_code, is_reference, exists_in_catalog,
              title, title_len, bullet_count, image_count, has_zoomable_image,
              has_description, has_aplus, best_rank, best_category,
              issues, issue_count, raw_data, error_message, image_url, checked_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,NOW())
           ON CONFLICT (product_id, marketplace_id) DO UPDATE SET
             country_code=$3, is_reference=$4, exists_in_catalog=$5, title=$6, title_len=$7,
             bullet_count=$8, image_count=$9, has_zoomable_image=$10, has_description=$11,
             has_aplus=$12, best_rank=$13, best_category=$14, issues=$15, issue_count=$16,
             raw_data=$17, error_message=$18, image_url=$19, checked_at=NOW()`,
          [
            product.id, row.marketplaceId, row.countryCode, isReference, row.existsInCatalog,
            row.title, row.base?.titleLen ?? null, row.base?.bulletCount ?? null,
            row.base?.imageCount ?? null, row.base?.hasZoomableImage ?? null,
            row.base?.hasDescription ?? null, row.base?.hasAplus ?? null,
            row.bestRank, row.bestCategory,
            JSON.stringify(issues), issues.length,
            JSON.stringify(row.rawData || {}), row.errorMessage, row.imageUrl ?? null,
          ]
        );
        upserted++;
      }

      // One update per product, not per country — the sweep spends ~6s per
      // product, so this is a negligible write while keeping the bar moving.
      await _setProgress(logId, upserted, progressTotal);
    }
    await _finishLog(logId, "success", { fetched, upserted });
    logger.info("Cross-country listing sync finished", {
      workspaceId, products: products.length, fetched, upserted,
      throttled: throttle.throttled, finalPaceMs: throttle.current,
    });
    return {
      fetched, upserted, products: products.length,
      countries: targets.length, throttled: throttle.throttled,
    };
  } catch (err) {
    await _finishLog(logId, "failed", { fetched, upserted }, { error: err.message });
    throw err;
  }
}

// Fetches one (ASIN, marketplace) pair. Never throws: a 404 is a real finding
// ("not listed here") and any other failure is recorded on the row so a single
// flaky country cannot abort a multi-hour sweep.
async function _fetchOneMarketplaceListing(product, mkt, refreshToken, throttle) {
  const base = {
    marketplaceId: mkt.marketplaceId,
    countryCode: mkt.countryCode,
    existsInCatalog: false,
    title: null,
    bulletPoints: [],
    bestRank: null,
    bestCategory: null,
    base: null,
    imageUrl: null,
    rawData: null,
    errorMessage: null,
  };

  const wasThrottled = (err) => err.status === 429 || /rate limit|QuotaExceeded/i.test(err.message || "");

  let content;
  try {
    content = await getListingContent(product.asin, mkt.marketplaceId, refreshToken);
    throttle.reward();
  } catch (err) {
    // 404 NOT_FOUND is the "no listing in this country" signal, not an error —
    // and it still counts as a healthy response for pacing purposes.
    if (err.status === 404) {
      throttle.reward();
      await throttle.wait();
      return base;
    }
    base.errorMessage = err.message;
    if (wasThrottled(err)) {
      throttle.penalise();
      logger.warn("Cross-country sync throttled — slowing down", {
        asin: product.asin, country: mkt.countryCode, paceMs: throttle.current,
      });
      // _spRequest already retried with Amazon's Retry-After; an extra pause on
      // top lets the token bucket refill before the sweep resumes.
      await _sleep(15000);
    }
    await throttle.wait();
    return base;
  }
  await throttle.wait();

  let hasAplus = false;
  try {
    hasAplus = (await getAplusStatus(product.asin, mkt.marketplaceId, refreshToken)).hasAplus;
    throttle.reward();
  } catch (err) {
    // A+ is one signal among six — degrade to "unknown, treated as absent" and
    // note it rather than discarding an otherwise complete listing check.
    base.errorMessage = `aplus: ${err.message}`;
    if (wasThrottled(err)) {
      throttle.penalise();
      await _sleep(15000);
    }
    logger.warn("Marketplace listing A+ check failed", { asin: product.asin, country: mkt.countryCode, error: err.message });
  }
  await throttle.wait();

  const rank = _bestRank(content.classificationRanks, content.displayGroupRanks);
  return {
    ...base,
    existsInCatalog: true,
    imageUrl: _listingThumbnail(content.images),
    title: content.title,
    bulletPoints: content.bulletPoints,
    bestRank: rank?.rank ?? null,
    bestCategory: rank?.category ?? null,
    base: computeListingIssues({
      title: content.title,
      bulletPoints: content.bulletPoints,
      description: content.description,
      images: content.images,
      hasAplus,
    }),
    rawData: content.rawData,
    errorMessage: base.errorMessage,
  };
}

// Amazon returns each photo at several sizes (typically 75 / 500 / 2208 px).
// The matrix renders it at ~26 px, so the smallest is both sharp enough and the
// cheapest to load across a several-hundred-row table.
//
// MAIN is preferred but is NOT guaranteed: verified on the live account that
// B099ZVM384 carries only PT01–PT08 in BE and SE — 24 images, no MAIN at all.
// Requiring MAIN left those listings with a blank thumbnail, so fall back to the
// lowest-numbered supplementary photo, which is the one Amazon shows first.
function _listingThumbnail(images) {
  const usable = (images || []).filter(i => i.link && Number(i.width) > 0);
  if (!usable.length) return null;
  // "" sorts before "PT01"; the ￿ guard keeps unlabelled variants last.
  const rank = (v) => (v === "MAIN" ? "" : (v || "￿"));
  return usable.slice().sort((a, b) => {
    const ra = rank(a.variant), rb = rank(b.variant);
    if (ra !== rb) return ra < rb ? -1 : 1;
    return Number(a.width) - Number(b.width);
  })[0].link;
}

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = {
  syncBsr, syncInventory, syncOrders, syncFinancials, syncPricing,
  syncListingHealth, syncMarketplaceListings,
  _listingThumbnail,
};
