const express = require("express");
const router  = express.Router();
const { requireAuth, requireWorkspace } = require("../middleware/auth");
const { query } = require("../db/pool");
const logger  = require("../config/logger");
const ExcelJS = require("exceljs");

router.use(requireAuth, requireWorkspace);

// ── Shared: fetch metrics, sku config, bsr and build report rows ─────────────
async function buildReportData(wid, start, end) {
  // 1. SKU mapping
  const { rows: skuRows } = await query(
    `SELECT asin, sku, label, product_name,
            cogs_per_unit, shipping_per_unit,
            amazon_fee_pct, vat_pct,
            google_ads_weekly, facebook_ads_weekly, sellable_quota
     FROM sku_mapping
     WHERE workspace_id = $1 AND is_active = true
     ORDER BY label ASC, asin ASC`,
    [wid]
  );

  // 2. Metrics — extract ASIN from campaign name via regex (B0 + 8 alnum chars)
  //    product_ads table is not populated; targets table has no asin column.
  //    Campaign naming convention: "... grib B0XXXXXXXXX" or "AM - SP - B0XXXXXXXXX - ..."
  const { rows: metricsRows } = await query(
    `SELECT
       (regexp_match(c.name, 'B0[A-Z0-9]{8}'))[1] AS asin,
       c.campaign_type,
       SUM(m.cost)        AS spend,
       SUM(m.sales_14d)   AS sales,
       SUM(m.orders_14d)  AS units,
       SUM(m.clicks)      AS clicks,
       SUM(m.impressions) AS impressions
     FROM fact_metrics_daily m
     JOIN campaigns c ON m.entity_id = c.id AND m.entity_type = 'campaign'
     WHERE c.workspace_id = $1
       AND m.date BETWEEN $2 AND $3
       AND m.entity_type = 'campaign'
       AND c.name ~ 'B0[A-Z0-9]{8}'
     GROUP BY (regexp_match(c.name, 'B0[A-Z0-9]{8}'))[1], c.campaign_type`,
    [wid, start, end]
  );

  // 3. Latest BSR per ASIN
  const { rows: bsrRows } = await query(
    `SELECT p.asin, s.best_rank, s.best_category
     FROM products p
     JOIN LATERAL (
       SELECT best_rank, best_category
       FROM bsr_snapshots
       WHERE product_id = p.id
       ORDER BY captured_at DESC LIMIT 1
     ) s ON true
     WHERE p.workspace_id = $1 AND p.is_active = true`,
    [wid]
  );

  // 4. All tracked products (for ASINs without sku_mapping)
  const { rows: productRows } = await query(
    `SELECT asin, title FROM products WHERE workspace_id = $1 AND is_active = true`,
    [wid]
  );

  // 5. Build maps
  const bsrMap = {};
  for (const b of bsrRows) bsrMap[b.asin] = b;

  const productMap = {};
  for (const p of productRows) productMap[p.asin] = p;

  const metricsMap = {};
  for (const m of metricsRows) {
    if (!m.asin) continue;
    if (!metricsMap[m.asin]) {
      metricsMap[m.asin] = { sp:0, sd:0, sb:0, sales:0, units:0, clicks:0, impressions:0 };
    }
    const d = metricsMap[m.asin];
    const spend = parseFloat(m.spend || 0);
    d.sales      += parseFloat(m.sales || 0);
    d.units      += parseInt(m.units || 0);
    d.clicks     += parseInt(m.clicks || 0);
    d.impressions+= parseInt(m.impressions || 0);
    if (m.campaign_type === "sponsoredProducts")     d.sp += spend;
    else if (m.campaign_type === "sponsoredDisplay") d.sd += spend;
    else if (m.campaign_type === "sponsoredBrands")  d.sb += spend;
    else d.sp += spend;
  }

  // 6. Union of: sku_mapping ASINs + metrics ASINs + tracked products
  const skuMap = {};
  for (const s of skuRows) skuMap[s.asin] = s;

  const allAsins = new Set([
    ...skuRows.map(r => r.asin),
    ...Object.keys(metricsMap),
    ...productRows.map(p => p.asin),
  ]);

  const rows = [];
  for (const asin of allAsins) {
    const sku = skuMap[asin] || {};
    const m   = metricsMap[asin] || { sp:0, sd:0, sb:0, sales:0, units:0, clicks:0, impressions:0 };
    const bsr = bsrMap[asin];
    const prod = productMap[asin];

    const sp_spend  = Math.abs(m.sp);
    const sd_spend  = Math.abs(m.sd);
    const sb_spend  = Math.abs(m.sb);
    const total_ads = sp_spend + sd_spend + sb_spend;
    const google    = parseFloat(sku.google_ads_weekly   || 0);
    const fb        = parseFloat(sku.facebook_ads_weekly || 0);
    const total_ext = google + fb;
    const total_spend = total_ads + total_ext;

    const sales         = m.sales;
    const units         = m.units;
    const cogs_per_unit = parseFloat(sku.cogs_per_unit      || 0);
    const ship_per_unit = parseFloat(sku.shipping_per_unit  || 0);
    const amz_fee_pct   = parseFloat(sku.amazon_fee_pct     || -0.15);
    const vat_pct       = parseFloat(sku.vat_pct            || -0.19);

    const amazon_fees = sales * Math.abs(amz_fee_pct);
    const vat         = sales * Math.abs(vat_pct);
    const cogs        = units * cogs_per_unit;
    const shipping    = units * ship_per_unit;

    const gross_profit = sales - total_ads - amazon_fees - vat - cogs - shipping;
    const net_profit   = gross_profit - total_ext;
    const margin       = sales > 0 ? gross_profit / sales * 100 : 0;
    const acos_pct     = sales > 0 ? total_ads   / sales * 100 : 0;
    const real_acos    = sales > 0 ? total_spend / sales * 100 : 0;

    // derive product_name: sku_mapping > products.title > asin
    const rawTitle = sku.product_name || (prod && prod.title) || asin;
    const product_name = rawTitle.length > 80 ? rawTitle.slice(0, 77) + "…" : rawTitle;

    rows.push({
      asin,
      product_name,
      sku:           sku.sku   || "",
      label:         sku.label != null ? sku.label : null,
      units,
      sales,
      sp_spend,
      sd_spend,
      sb_spend,
      total_ads,
      google_ads:   google,
      facebook_ads: fb,
      total_spend,
      acos:        parseFloat(acos_pct.toFixed(2)),
      real_acos:   parseFloat(real_acos.toFixed(2)),
      tacos:       parseFloat(real_acos.toFixed(2)),
      amazon_fees: parseFloat(amazon_fees.toFixed(2)),
      vat:         parseFloat(vat.toFixed(2)),
      cogs:        parseFloat(cogs.toFixed(2)),
      shipping:    parseFloat(shipping.toFixed(2)),
      gross_profit:parseFloat(gross_profit.toFixed(2)),
      net_profit:  parseFloat(net_profit.toFixed(2)),
      margin:      parseFloat(margin.toFixed(2)),
      roi:         0,
      clicks:      m.clicks,
      impressions: m.impressions,
      bsr_rank:    bsr?.best_rank    || null,
      bsr_category:bsr?.best_category|| null,
      // raw config fields for XLSX formulas
      sellable_quota:   sku.sellable_quota   || 0,
      amazon_fee_pct:   amz_fee_pct,
      cogs_per_unit:    cogs_per_unit,
      vat_pct:          vat_pct,
      shipping_per_unit:ship_per_unit,
    });
  }

  rows.sort((a, b) => {
    const la = a.label != null ? a.label : 9999;
    const lb = b.label != null ? b.label : 9999;
    if (la !== lb) return la - lb;
    return b.sales - a.sales;
  });

  // Build label summary
  const labelMap = {};
  for (const row of rows) {
    const key = row.label != null ? String(row.label) : "—";
    if (!labelMap[key]) {
      labelMap[key] = {
        label: key, products:0, units:0, sales:0,
        sp_spend:0, sd_spend:0, sb_spend:0, total_ads:0,
        google_ads:0, facebook_ads:0, total_spend:0,
        gross_profit:0, net_profit:0,
      };
    }
    const g = labelMap[key];
    g.products++;
    g.units       += row.units;
    g.sales       += row.sales;
    g.sp_spend    += row.sp_spend;
    g.sd_spend    += row.sd_spend;
    g.sb_spend    += row.sb_spend;
    g.total_ads   += row.total_ads;
    g.google_ads  += row.google_ads;
    g.facebook_ads+= row.facebook_ads;
    g.total_spend += row.total_spend;
    g.gross_profit+= row.gross_profit;
    g.net_profit  += row.net_profit;
  }

  const summary = Object.values(labelMap).map(g => ({
    ...g,
    tacos:  g.sales > 0 ? parseFloat((g.total_spend / g.sales * 100).toFixed(2)) : 0,
    margin: g.sales > 0 ? parseFloat((g.gross_profit / g.sales * 100).toFixed(2)) : 0,
    acos:   g.sales > 0 ? parseFloat((g.total_ads / g.sales * 100).toFixed(2)) : 0,
  })).sort((a, b) => (Number(a.label) || 9999) - (Number(b.label) || 9999));

  return { rows, summary, skuMap, productMap };
}

// GET /analytics-report/download?startDate=2026-03-02&endDate=2026-03-08
router.get("/download", async (req, res, next) => {
  try {
    const { startDate, endDate } = req.query;
    const start = startDate || new Date(Date.now() - 7 * 86400000).toISOString().split("T")[0];
    const end   = endDate   || new Date().toISOString().split("T")[0];
    const wid   = req.workspaceId;

    const { rows: reportRows, skuMap } = await buildReportData(wid, start, end);


    // ── 6. Build XLSX ─────────────────────────────────────────────────────────
    const wb = new ExcelJS.Workbook();
    wb.creator = "AdsFlow";
    wb.created = new Date();

    // Style helpers
    const headerFill = { type:"pattern", pattern:"solid", fgColor:{ argb:"FF2D3748" } };
    const headerFont = { bold:true, color:{ argb:"FFFFFFFF" }, size:9, name:"Arial" };
    const dataFont   = { size:9, name:"Arial" };
    const numFmt2    = "#,##0.00";
    const numFmt0    = "#,##0";

    // ── Sheet 1: per-SKU detail ───────────────────────────────────────────────
    const ws1 = wb.addWorksheet("Sheet_1");

    const HEADERS = [
      "Product","ASIN","SKU","Label","Units","Refunds","Sales","Promo",
      "Ads","Sponsored Products","Sponsored Display","Sponsored Brands","Sponsored Brands Day",
      "Google Ads","Facebook Ads","% Refunds","Sellable Quota","Refund cost",
      "Amazon fees","Cost of Goods","VAT","Shipping",
      "Gross profit","Net profit","Estimated payout","Expenses",
      "Margin","ROI","BSR","Real ACOS","Sessions","Unit Session %",
    ];

    ws1.addRow(HEADERS);
    const headerRow = ws1.getRow(1);
    headerRow.eachCell(cell => {
      cell.fill = headerFill;
      cell.font = headerFont;
      cell.alignment = { vertical:"middle", horizontal:"center", wrapText:true };
    });
    headerRow.height = 36;

    const colWidths = [40,14,14,7,7,8,10,8,10,12,12,12,12,10,10,9,9,10,10,10,8,8,10,10,12,10,8,8,8,9,8,9];
    colWidths.forEach((w, i) => { ws1.getColumn(i + 1).width = w; });

    reportRows.forEach((row, idx) => {
      const r = idx + 2;
      const shippingCost = -Math.abs(row.shipping_per_unit);

      ws1.addRow([
        row.product_name,
        row.asin,
        row.sku,
        row.label != null ? row.label : "",
        row.units,
        0,           // refunds
        row.sales,
        0,           // promo
        { formula: `=J${r}+K${r}+L${r}` },
        -Math.abs(row.sp_spend),
        -Math.abs(row.sd_spend),
        -Math.abs(row.sb_spend),
        0,
        row.google_ads  ? -Math.abs(row.google_ads)  : 0,
        row.facebook_ads? -Math.abs(row.facebook_ads): 0,
        { formula: `=IF(G${r}>0,F${r}/E${r},0)` },
        row.sellable_quota || 0,
        0,
        { formula: `=G${r}*${row.amazon_fee_pct}` },
        { formula: `=E${r}*${-Math.abs(row.cogs_per_unit)}` },
        { formula: `=G${r}*${row.vat_pct}` },
        { formula: `=E${r}*${shippingCost}` },
        { formula: `=G${r}+S${r}+T${r}+U${r}+V${r}+I${r}+H${r}+R${r}` },
        { formula: `=W${r}` },
        { formula: `=G${r}+S${r}+T${r}+U${r}+V${r}` },
        { formula: `=I${r}+H${r}` },
        { formula: `=IF(G${r}>0,W${r}/G${r}*100,0)` },
        { formula: `=IF(ABS(T${r}+U${r}+V${r}+S${r}+R${r})>0,W${r}/ABS(T${r}+U${r}+V${r}+S${r}+R${r})*100,0)` },
        row.bsr_rank || "",
        { formula: `=IF(G${r}<>0,I${r}/G${r}*100,0)` },
        0,
        0,
      ]);

      const dataRow = ws1.getRow(r);
      dataRow.eachCell({ includeEmpty: true }, (cell, colNum) => {
        cell.font = dataFont;
        if ([5,6,17,18,29,31,32].includes(colNum)) cell.numFmt = numFmt0;
        else if ([7,8,9,10,11,12,13,14,15,18,19,20,21,22,23,24,25,26].includes(colNum)) cell.numFmt = numFmt2;
        else if ([27,28,30].includes(colNum)) cell.numFmt = "0.00";
        if ([19,20,21,22].includes(colNum)) {
          cell.fill = { type:"pattern", pattern:"solid", fgColor:{ argb:"FFFFF9C4" } };
        }
      });
      if (idx % 2 === 1) {
        dataRow.eachCell({ includeEmpty:true }, cell => {
          if (!cell.fill || cell.fill.fgColor?.argb === "00000000") {
            cell.fill = { type:"pattern", pattern:"solid", fgColor:{ argb:"FFF7FAFC" } };
          }
        });
      }
    });

    ws1.views = [{ state:"frozen", xSplit:0, ySplit:1 }];
    ws1.autoFilter = { from:"A1", to:"AF1" };

    // ── Sheet 2: Лист1 — summary by label ────────────────────────────────────
    const ws2 = wb.addWorksheet("Лист1");
    ws2.addRow(["Name","Label","Total Sales","Units","PPC Spend","TACOS","Profit","",
                "Total Sales","Units","PPC Spend"]);
    ws2.getRow(1).eachCell(cell => {
      cell.fill = headerFill; cell.font = headerFont;
      cell.alignment = { horizontal:"center", vertical:"middle" };
    });

    const labelGroups = {};
    for (const row of reportRows) {
      const key = row.label || "—";
      if (!labelGroups[key]) {
        labelGroups[key] = { label:key, name:"", sales:0, units:0, sp:0, sd:0, sb:0, google:0, fb:0 };
      }
      const g = labelGroups[key];
      g.sales  += row.sales;
      g.units  += row.units;
      g.sp     += Math.abs(row.sp_spend);
      g.sd     += Math.abs(row.sd_spend);
      g.sb     += Math.abs(row.sb_spend);
      g.google += Math.abs(row.google_ads);
      g.fb     += Math.abs(row.facebook_ads);
      if (!g.name) g.name = row.product_name.split(" ").slice(0, 4).join(" ");
    }

    const labelArr = Object.values(labelGroups).sort((a,b) => (Number(a.label)||999) - (Number(b.label)||999));
    labelArr.forEach((g, idx) => {
      const ppcSpend = g.sp + g.sd + g.sb + g.google + g.fb;
      const tacos  = g.sales > 0 ? (ppcSpend / g.sales * 100) : 0;
      const profit = g.sales - ppcSpend;
      ws2.addRow([
        g.name, g.label,
        g.sales, g.units, -ppcSpend, parseFloat(tacos.toFixed(2)), profit,
        "",
        g.sales, g.units, -ppcSpend,
      ]);
      const dataRow = ws2.getRow(idx + 2);
      dataRow.eachCell(cell => { cell.font = dataFont; cell.numFmt = numFmt2; });
    });

    ws2.getColumn(1).width = 35;
    ws2.getColumn(2).width = 8;
    [3,4,5,6,7,9,10,11].forEach(c => { ws2.getColumn(c).width = 12; });

    // ── Sheet 3: Лист2 — ASIN reference ──────────────────────────────────────
    const ws3 = wb.addWorksheet("Лист2");
    ws3.addRow(["ASIN","SKU","Label"]);
    ws3.getRow(1).eachCell(cell => {
      cell.fill = headerFill; cell.font = headerFont;
      cell.alignment = { horizontal:"center" };
    });
    reportRows.forEach(row => {
      ws3.addRow([row.asin, row.sku, row.label]);
      ws3.lastRow.eachCell(cell => { cell.font = dataFont; });
    });
    ws3.getColumn(1).width = 14;
    ws3.getColumn(2).width = 16;
    ws3.getColumn(3).width = 8;

    // ── Send file ─────────────────────────────────────────────────────────────
    const filename = `${start.replace(/-/g,"_")}-${end.replace(/-/g,"_")}.xlsx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    await wb.xlsx.write(res);
    res.end();

  } catch (err) {
    next(err);
  }
});

// GET /analytics-report/config — get SKU mapping for workspace
router.get("/config", async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, asin, sku, label, product_name,
              cogs_per_unit, shipping_per_unit,
              amazon_fee_pct, vat_pct,
              google_ads_weekly, facebook_ads_weekly, sellable_quota
       FROM sku_mapping WHERE workspace_id = $1 AND is_active = true
       ORDER BY label ASC, asin ASC`,
      [req.workspaceId]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// POST /analytics-report/config — upsert one SKU mapping row
router.post("/config", async (req, res, next) => {
  try {
    const {
      asin, sku, label, product_name,
      cogs_per_unit = 0, shipping_per_unit = 0,
      amazon_fee_pct = -0.15, vat_pct = -0.19,
      google_ads_weekly = 0, facebook_ads_weekly = 0,
      sellable_quota = 0,
    } = req.body;

    if (!asin) return res.status(400).json({ error: "asin required" });

    const { rows: [row] } = await query(
      `INSERT INTO sku_mapping
         (workspace_id, asin, sku, label, product_name,
          cogs_per_unit, shipping_per_unit, amazon_fee_pct, vat_pct,
          google_ads_weekly, facebook_ads_weekly, sellable_quota)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (workspace_id, asin)
       DO UPDATE SET
         sku=EXCLUDED.sku, label=EXCLUDED.label, product_name=EXCLUDED.product_name,
         cogs_per_unit=EXCLUDED.cogs_per_unit, shipping_per_unit=EXCLUDED.shipping_per_unit,
         amazon_fee_pct=EXCLUDED.amazon_fee_pct, vat_pct=EXCLUDED.vat_pct,
         google_ads_weekly=EXCLUDED.google_ads_weekly, facebook_ads_weekly=EXCLUDED.facebook_ads_weekly,
         sellable_quota=EXCLUDED.sellable_quota, updated_at=NOW()
       RETURNING *`,
      [req.workspaceId, asin, sku, label, product_name,
       cogs_per_unit, shipping_per_unit, amazon_fee_pct, vat_pct,
       google_ads_weekly, facebook_ads_weekly, sellable_quota]
    );
    res.json(row);
  } catch (err) { next(err); }
});

// GET /analytics-report/data — interactive JSON report
router.get("/data", async (req, res, next) => {
  try {
    const { startDate, endDate } = req.query;
    const start = startDate || new Date(Date.now() - 30 * 86400000).toISOString().split("T")[0];
    const end   = endDate   || new Date().toISOString().split("T")[0];
    const { rows, summary } = await buildReportData(req.workspaceId, start, end);
    res.json({ rows, summary, start, end });
  } catch (err) {
    next(err);
  }
});

// POST /analytics-report/sync-products — seed sku_mapping from products table (only new ASINs)
router.post("/sync-products", async (req, res, next) => {
  try {
    const wid = req.workspaceId;
    const { rows: products } = await query(
      `SELECT asin, title FROM products WHERE workspace_id = $1 AND is_active = true`,
      [wid]
    );
    let inserted = 0;
    for (const p of products) {
      const name = (p.title || p.asin).slice(0, 120);
      const { rowCount } = await query(
        `INSERT INTO sku_mapping (workspace_id, asin, product_name, amazon_fee_pct, vat_pct)
         VALUES ($1, $2, $3, -0.15, -0.19)
         ON CONFLICT (workspace_id, asin) DO NOTHING`,
        [wid, p.asin, name]
      );
      inserted += rowCount || 0;
    }
    res.json({ synced: products.length, inserted });
  } catch (err) {
    next(err);
  }
});

// POST /analytics-report/config/bulk — bulk upsert rows
router.post("/config/bulk", async (req, res, next) => {
  try {
    const { rows } = req.body;
    if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: "rows array required" });

    let inserted = 0;
    for (const r of rows) {
      if (!r.asin) continue;
      await query(
        `INSERT INTO sku_mapping
           (workspace_id, asin, sku, label, product_name,
            cogs_per_unit, shipping_per_unit, amazon_fee_pct, vat_pct,
            google_ads_weekly, facebook_ads_weekly, sellable_quota)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (workspace_id, asin)
         DO UPDATE SET
           sku=EXCLUDED.sku, label=EXCLUDED.label, product_name=EXCLUDED.product_name,
           cogs_per_unit=EXCLUDED.cogs_per_unit, shipping_per_unit=EXCLUDED.shipping_per_unit,
           amazon_fee_pct=EXCLUDED.amazon_fee_pct, vat_pct=EXCLUDED.vat_pct,
           updated_at=NOW()`,
        [req.workspaceId, r.asin, r.sku, r.label, r.product_name,
         r.cogs_per_unit||0, r.shipping_per_unit||0,
         r.amazon_fee_pct||-0.15, r.vat_pct||-0.19,
         r.google_ads_weekly||0, r.facebook_ads_weekly||0, r.sellable_quota||0]
      );
      inserted++;
    }
    res.json({ inserted });
  } catch (err) { next(err); }
});

module.exports = router;
