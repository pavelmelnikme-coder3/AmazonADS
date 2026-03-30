const express = require('express');
const { query } = require('../db/pool');
const { requireAuth, requireWorkspace } = require('../middleware/auth');
const { pushNegativeKeyword } = require('../services/amazon/writeback');
const logger = require('../config/logger');

const router = express.Router();
router.use(requireAuth, requireWorkspace);

// GET /api/v1/negative-keywords
router.get('/', async (req, res, next) => {
  try {
    const { search, page = 1, limit: rawLimit = 100 } = req.query;
    const limit = Math.min(parseInt(rawLimit) || 100, 500);
    const offset = (parseInt(page) - 1) * limit;

    const conditions = ['nk.workspace_id = $1'];
    const params = [req.workspaceId];
    let pi = 2;

    const rawCampaignIds = req.query['campaignIds[]'] || req.query.campaignIds;
    const campaignIds = rawCampaignIds
      ? (Array.isArray(rawCampaignIds) ? rawCampaignIds : rawCampaignIds.split(','))
          .filter(id => id && id.trim())
      : null;
    if (campaignIds && campaignIds.length > 0) {
      conditions.push(`nk.campaign_id = ANY($${pi++})`);
      params.push(campaignIds);
    }

    if (req.query.campaignId) {
      conditions.push(`nk.campaign_id = $${pi++}`);
      params.push(req.query.campaignId);
    }

    if (search) {
      conditions.push(`nk.keyword_text ILIKE $${pi++}`);
      params.push(`%${search}%`);
    }

    const where = conditions.join(' AND ');
    const { rows } = await query(
      `SELECT nk.id, nk.keyword_text, nk.match_type, nk.level,
              nk.created_at, c.name as campaign_name
       FROM negative_keywords nk
       LEFT JOIN campaigns c ON c.id = nk.campaign_id
       WHERE ${where}
       ORDER BY nk.created_at DESC
       LIMIT $${pi} OFFSET $${pi + 1}`,
      [...params, limit, offset]
    );

    const { rows: countRows } = await query(
      `SELECT COUNT(*) as total FROM negative_keywords nk WHERE ${where}`,
      params
    );

    res.json({
      data: rows,
      pagination: {
        total: parseInt(countRows[0].total),
        page: parseInt(page),
        limit,
        pages: Math.ceil(parseInt(countRows[0].total) / limit),
      },
    });
  } catch (err) { next(err); }
});

// POST /api/v1/negative-keywords
router.post('/', async (req, res, next) => {
  try {
    const { campaignId, adGroupId, keywordText, matchType = 'negativeExact' } = req.body;
    if (!campaignId || !keywordText) {
      return res.status(400).json({ error: 'campaignId and keywordText required' });
    }

    // Get campaign info + connection details
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
    const fakeAmazonId = `manual_neg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const { rows } = await query(
      `INSERT INTO negative_keywords
         (workspace_id, profile_id, campaign_id, ad_group_id, amazon_neg_keyword_id,
          keyword_text, match_type, level)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (profile_id, amazon_neg_keyword_id) DO NOTHING
       RETURNING id, keyword_text, match_type, level, created_at`,
      [req.workspaceId, camp.profile_id, campaignId, adGroupId || null,
       fakeAmazonId, keywordText.trim(), matchType, level]
    );

    const inserted = rows[0] || null;

    // Amazon write-back (non-fatal, fire-and-forget)
    if (inserted) {
      pushNegativeKeyword({
        localId:          inserted.id,
        connectionId:     camp.connection_id,
        profileId:        camp.amazon_profile_id?.toString(),
        marketplaceId:    camp.marketplace_id,
        campaignType:     camp.campaign_type,
        amazonCampaignId: camp.amazon_campaign_id,
        amazonAdGroupId:  camp.amazon_ad_group_id || null,
        keywordText:      keywordText.trim(),
        matchType,
        level,
      }).catch(e => logger.warn("negative keyword write-back error", { error: e.message }));
    }

    res.json({ data: inserted });
  } catch (err) { next(err); }
});

// DELETE /api/v1/negative-keywords/:id
router.delete('/:id', async (req, res, next) => {
  try {
    await query(
      'DELETE FROM negative_keywords WHERE id = $1 AND workspace_id = $2',
      [req.params.id, req.workspaceId]
    );
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
