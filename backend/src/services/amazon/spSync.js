const crypto = require("crypto");
const pool = require("../../db/pool");
const logger = require("../../config/logger");
const {
  getCatalogItem,
  getInventory,
  getOrders,
  getOrderItems,
  getFinancialEvents,
  getCompetitivePricing,
} = require("./spClient");

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function _startLog(workspaceId, marketplaceId, syncType) {
  const { rows } = await pool.query(
    `INSERT INTO sp_sync_log (workspace_id, marketplace_id, sync_type, status)
     VALUES ($1, $2, $3, 'running') RETURNING id`,
    [workspaceId, marketplaceId, syncType]
  );
  return rows[0].id;
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
          `UPDATE products SET title=$1, brand=$2, image_url=$3, updated_at=NOW() WHERE id=$4`,
          [data.title, data.brand, data.imageUrl, product.id]
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
          inv.totalQuantity?.quantity || null,
          inv.fulfillableQuantity || null,
          (inv.reservedQuantity?.totalReservedQuantity) || null,
          inv.pendingCustomsQuantity || null,
          inv.inboundWorkingQuantity?.quantity || null,
          inv.inboundShippedQuantity?.quantity || null,
          inv.inboundReceivingQuantity?.quantity || null,
          (rs.totalResearchingQuantity?.quantity) || null,
          inv.unfulfillableQuantity?.totalUnfulfillableQuantity || null,
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
    // Incremental: start from last known order date
    if (!options.createdAfter) {
      const { rows } = await pool.query(
        `SELECT MAX(purchase_date) AS last FROM sp_orders WHERE workspace_id=$1 AND marketplace_id=$2`,
        [workspaceId, marketplaceId]
      );
      if (rows[0].last) options.createdAfter = rows[0].last.toISOString();
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

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { syncBsr, syncInventory, syncOrders, syncFinancials, syncPricing };
