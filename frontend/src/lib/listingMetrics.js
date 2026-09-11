/**
 * Listing-row totals on the Products page, summed across a variation family.
 *
 * Kept out of App.jsx so they can be tested: both used to overstate what the row claimed, and
 * both went wrong the same way — a thing shared by several variations was counted once per
 * variation instead of once.
 */

/**
 * Orders over the listing's VISIBLE variations within the selected period.
 *
 * `periodOrders` is the /products/period-orders response. Its per-ASIN counts are each
 * deduplicated, but an order holding two variations appears under both, so a plain sum counts it
 * twice. `multi_asin_orders` lists exactly those shared orders (as ASIN sets), which makes the
 * count right for any subset of the family — including one a filter has cut down, where the
 * backend's own per-listing total no longer matches the rows on screen.
 *
 * Seen on 2026-09-11: a listing reported 100 orders where its visible variations had 98.
 */
export function listingPeriodOrders(childAsins, periodOrders) {
  if (!periodOrders) return 0;
  const visible = new Set(childAsins);
  let orders = 0;
  for (const asin of visible) orders += periodOrders.by_asin?.[asin]?.orders || 0;
  for (const asins of periodOrders.multi_asin_orders || []) {
    const hits = asins.filter(a => visible.has(a)).length;
    if (hits > 1) orders -= hits - 1;
  }
  return orders;
}

/**
 * Campaigns advertising any of the listing's visible variations, counted once each.
 *
 * Every product row carries `ad_campaign_keys` / `ad_campaign_live_keys` — per-response integer
 * ids of its campaigns. Summing per-variation counts instead showed "6/60" for a listing whose
 * six variations all sat in the same live campaign: really 1 live of 20.
 */
export function listingCampaignCounts(children) {
  const all = new Set();
  const live = new Set();
  for (const c of children || []) {
    for (const k of c.ad_campaign_keys || []) all.add(k);
    for (const k of c.ad_campaign_live_keys || []) live.add(k);
  }
  return { total: all.size, live: live.size };
}
