const express = require('express');
const { query } = require('../db/pool');
const { requireAuth, requireWorkspace } = require('../middleware/auth');
const { pushNegativeAsin } = require('../services/amazon/writeback');
const logger = require('../config/logger');

const router = express.Router();
router.use(requireAuth, requireWorkspace);

// ─── GET /api/v1/negative-asins ──────────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const {
      search, page = 1, limit: rawLimit = 100,
      campaignType, sortBy = 'created_at', sortDir = 'desc',
    } = req.query;
    const limit = Math.min(parseInt(rawLimit) || 100, 500);
    const offset = (parseInt(page) - 1) * limit;

    const conditions = ['nt.workspace_id = $1'];
    const params = [req.workspaceId];
    let pi = 2;

    const rawCampaignIds = req.query['campaignIds[]'] || req.query.campaignIds;
    const campaignIds = rawCampaignIds
      ? (Array.isArray(rawCampaignIds) ? rawCampaignIds : rawCampaignIds.split(','))
          .filter(id => id && id.trim())
      : null;
    if (campaignIds?.length > 0) {
      conditions.push(`nt.campaign_id = ANY($${pi++})`);
      params.push(campaignIds);
    }
    if (req.query.campaignId) {
      conditions.push(`nt.campaign_id = $${pi++}`);
      params.push(req.query.campaignId);
    }
    if (search) {
      conditions.push(`nt.expression::text ILIKE $${pi++}`);
      params.push(`%${search}%`);
    }
    const typeMap = { SP: 'sponsoredProducts', SB: 'sponsoredBrands', SD: 'sponsoredDisplay' };
    if (campaignType && typeMap[campaignType]) {
      conditions.push(
        `nt.campaign_id IN (SELECT id FROM campaigns WHERE workspace_id = $1 AND campaign_type = $${pi++})`
      );
      params.push(typeMap[campaignType]);
    }

    const validSort = { asin: 'nt.expression', campaign: 'c.name', level: 'nt.level', created_at: 'nt.created_at' };
    const orderField = validSort[sortBy] || 'nt.created_at';
    const orderDir = sortDir === 'asc' ? 'ASC' : 'DESC';
    const where = conditions.join(' AND ');

    const [{ rows }, { rows: countRows }] = await Promise.all([
      query(
        `SELECT nt.id, nt.expression, nt.level, nt.campaign_id, nt.ad_group_id, nt.ad_type, nt.created_at,
                c.name AS campaign_name, c.campaign_type,
                ag.name AS ad_group_name
         FROM negative_targets nt
         LEFT JOIN campaigns c  ON c.id = nt.campaign_id
         LEFT JOIN ad_groups ag ON ag.id = nt.ad_group_id
         WHERE ${where}
         ORDER BY ${orderField} ${orderDir}
         LIMIT $${pi} OFFSET $${pi + 1}`,
        [...params, limit, offset]
      ),
      query(
        `SELECT COUNT(*) as total FROM negative_targets nt
         LEFT JOIN campaigns c ON c.id = nt.campaign_id
         WHERE ${where}`,
        params
      ),
    ]);

    const data = rows.map(r => ({
      ...r,
      asin: r.expression?.[0]?.value || null,
    }));

    res.json({
      data,
      pagination: {
        total: parseInt(countRows[0].total), page: parseInt(page), limit,
        pages: Math.ceil(parseInt(countRows[0].total) / limit),
      },
    });
  } catch (err) { next(err); }
});

// ─── POST /api/v1/negative-asins ─────────────────────────────────────────────
router.post('/', async (req, res, next) => {
  try {
    const { campaignId, adGroupId, asin } = req.body;
    if (!campaignId || !asin) {
      return res.status(400).json({ error: 'campaignId and asin required' });
    }
    const asinClean = asin.trim().toUpperCase();

    const { rows: campRows } = await query(
      `SELECT c.profile_id, c.campaign_type, c.amazon_campaign_id,
              p.profile_id AS amazon_profile_id, p.marketplace_id, p.connection_id,
              ag.amazon_ag_id AS amazon_ad_group_id
       FROM campaigns c
       JOIN amazon_profiles p ON p.id = c.profile_id
       LEFT JOIN ad_groups ag ON ag.id = $3::uuid AND ag.campaign_id = c.id
       WHERE c.id = $1 AND c.workspace_id = $2`,
      [campaignId, req.workspaceId, adGroupId || null]
    );
    if (!campRows[0]) return res.status(404).json({ error: 'Campaign not found' });
    const camp = campRows[0];

    const level = adGroupId ? 'ad_group' : 'campaign';
    const expression = [{ type: 'asinSameAs', value: asinClean }];
    const fakeId = `manual_neg_asin_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const { rows } = await query(
      `INSERT INTO negative_targets
         (workspace_id, profile_id, campaign_id, ad_group_id, amazon_neg_target_id,
          ad_type, expression, expression_type, level)
       VALUES ($1,$2,$3,$4,$5,'SP',$6,'manual',$7)
       ON CONFLICT (profile_id, amazon_neg_target_id) DO NOTHING
       RETURNING id, expression, level, created_at`,
      [req.workspaceId, camp.profile_id, campaignId, adGroupId || null,
       fakeId, JSON.stringify(expression), level]
    );
    const inserted = rows[0] || null;

    if (inserted) {
      pushNegativeAsin({
        localId: inserted.id, connectionId: camp.connection_id,
        profileId: camp.amazon_profile_id?.toString(), marketplaceId: camp.marketplace_id,
        campaignType: camp.campaign_type, amazonCampaignId: camp.amazon_campaign_id,
        amazonAdGroupId: camp.amazon_ad_group_id || null,
        asinValue: asinClean, level,
      }).catch(e => logger.warn('negative ASIN write-back error', { error: e.message }));
    }

    res.json({ data: inserted ? { ...inserted, asin: asinClean } : null });
  } catch (err) { next(err); }
});

// ─── POST /api/v1/negative-asins/bulk ────────────────────────────────────────
router.post('/bulk', async (req, res, next) => {
  try {
    const { asins, campaignIds } = req.body;
    if (!asins?.length || !campaignIds?.length) {
      return res.status(400).json({ error: 'asins and campaignIds required' });
    }

    let added = 0, skipped = 0;
    const errors = [];

    for (const campId of campaignIds) {
      const { rows: campRows } = await query(
        `SELECT c.profile_id, c.campaign_type, c.amazon_campaign_id,
                p.profile_id AS amazon_profile_id, p.marketplace_id, p.connection_id
         FROM campaigns c JOIN amazon_profiles p ON p.id = c.profile_id
         WHERE c.id = $1 AND c.workspace_id = $2`,
        [campId, req.workspaceId]
      );
      if (!campRows[0]) { errors.push({ campaignId: campId, error: 'not found' }); continue; }
      const camp = campRows[0];

      for (const asin of asins) {
        const asinClean = (typeof asin === 'string' ? asin : asin?.value || '').trim().toUpperCase();
        if (!asinClean) continue;

        const expression = [{ type: 'asinSameAs', value: asinClean }];
        const fakeId = `manual_neg_asin_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

        const { rows } = await query(
          `INSERT INTO negative_targets
             (workspace_id, profile_id, campaign_id, amazon_neg_target_id,
              ad_type, expression, expression_type, level)
           VALUES ($1,$2,$3,$4,'SP',$5,'manual','campaign')
           ON CONFLICT (profile_id, amazon_neg_target_id) DO NOTHING
           RETURNING id`,
          [req.workspaceId, camp.profile_id, campId, fakeId, JSON.stringify(expression)]
        );
        if (rows[0]) {
          added++;
          pushNegativeAsin({
            localId: rows[0].id, connectionId: camp.connection_id,
            profileId: camp.amazon_profile_id?.toString(), marketplaceId: camp.marketplace_id,
            campaignType: camp.campaign_type, amazonCampaignId: camp.amazon_campaign_id,
            amazonAdGroupId: null, asinValue: asinClean, level: 'campaign',
          }).catch(() => {});
        } else { skipped++; }
      }
    }

    res.json({ success: true, added, skipped, errors });
  } catch (err) { next(err); }
});

// ─── DELETE /api/v1/negative-asins/bulk ──────────────────────────────────────
router.delete('/bulk', async (req, res, next) => {
  try {
    const { ids } = req.body;
    if (!ids?.length) return res.status(400).json({ error: 'ids required' });
    const { rowCount } = await query(
      'DELETE FROM negative_targets WHERE id = ANY($1::uuid[]) AND workspace_id = $2',
      [ids, req.workspaceId]
    );
    res.json({ success: true, deleted: rowCount });
  } catch (err) { next(err); }
});

// ─── DELETE /api/v1/negative-asins/:id ───────────────────────────────────────
router.delete('/:id', async (req, res, next) => {
  try {
    await query('DELETE FROM negative_targets WHERE id = $1 AND workspace_id = $2',
      [req.params.id, req.workspaceId]);
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
