const express = require('express');
const { query } = require('../db/pool');
const { requireAuth, requireWorkspace } = require('../middleware/auth');
const { pushNegativeKeyword } = require('../services/amazon/writeback');
const { writeAudit } = require('./audit');
const logger = require('../config/logger');

const router = express.Router();
router.use(requireAuth, requireWorkspace);

// ─── GET /api/v1/negative-keywords ───────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const {
      search, page = 1, limit: rawLimit = 100,
      matchType, level, campaignType, sortBy = 'created_at', sortDir = 'desc',
    } = req.query;
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
    if (campaignIds?.length > 0) {
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
    if (matchType) {
      // Accept both camelCase (negativeExact) and snake_case (negative_exact)
      const mtNorm = matchType === 'negativeExact' ? ['negativeExact','negative_exact']
                   : matchType === 'negativePhrase' ? ['negativePhrase','negative_phrase']
                   : matchType === 'negative_exact' ? ['negativeExact','negative_exact']
                   : matchType === 'negative_phrase' ? ['negativePhrase','negative_phrase']
                   : null;
      if (mtNorm) {
        conditions.push(`nk.match_type = ANY($${pi++})`);
        params.push(mtNorm);
      }
    }
    if (level && ['campaign', 'ad_group'].includes(level)) {
      conditions.push(`nk.level = $${pi++}`);
      params.push(level);
    }
    // Campaign type filter via campaigns join
    const typeMap = { SP: 'sponsoredProducts', SB: 'sponsoredBrands', SD: 'sponsoredDisplay' };
    if (campaignType && typeMap[campaignType]) {
      conditions.push(
        `nk.campaign_id IN (SELECT id FROM campaigns WHERE workspace_id = $1 AND campaign_type = $${pi++})`
      );
      params.push(typeMap[campaignType]);
    }

    const validSort = { keyword_text: 'nk.keyword_text', match_type: 'nk.match_type',
      level: 'nk.level', campaign: 'c.name', created_at: 'nk.created_at' };
    const orderField = validSort[sortBy] || 'nk.created_at';
    const orderDir = sortDir === 'asc' ? 'ASC' : 'DESC';
    const where = conditions.join(' AND ');

    const [{ rows }, { rows: countRows }] = await Promise.all([
      query(
        `SELECT nk.id, nk.keyword_text, nk.match_type, nk.level,
                nk.campaign_id, nk.ad_group_id, nk.created_at,
                c.name AS campaign_name, c.campaign_type,
                ag.name AS ad_group_name
         FROM negative_keywords nk
         LEFT JOIN campaigns c  ON c.id = nk.campaign_id
         LEFT JOIN ad_groups ag ON ag.id = nk.ad_group_id
         WHERE ${where}
         ORDER BY ${orderField} ${orderDir}
         LIMIT $${pi} OFFSET $${pi + 1}`,
        [...params, limit, offset]
      ),
      query(`SELECT COUNT(*) as total FROM negative_keywords nk LEFT JOIN campaigns c ON c.id = nk.campaign_id WHERE ${where}`, params),
    ]);

    res.json({
      data: rows,
      pagination: { total: parseInt(countRows[0].total), page: parseInt(page), limit,
        pages: Math.ceil(parseInt(countRows[0].total) / limit) },
    });
  } catch (err) { next(err); }
});

// ─── GET /api/v1/negative-keywords/export.csv ────────────────────────────────
router.get('/export.csv', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT nk.keyword_text, nk.match_type, nk.level,
              c.name AS campaign_name, ag.name AS ad_group_name, nk.created_at
       FROM negative_keywords nk
       LEFT JOIN campaigns c  ON c.id = nk.campaign_id
       LEFT JOIN ad_groups ag ON ag.id = nk.ad_group_id
       WHERE nk.workspace_id = $1
       ORDER BY nk.created_at DESC`,
      [req.workspaceId]
    );
    const header = 'keyword_text,match_type,level,campaign,ad_group,created_at\n';
    const csv = rows.map(r =>
      [r.keyword_text, r.match_type, r.level, r.campaign_name || '', r.ad_group_name || '', r.created_at]
        .map(v => `"${String(v || '').replace(/"/g, '""')}"`)
        .join(',')
    ).join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="negative-keywords.csv"');
    res.send(header + csv);
  } catch (err) { next(err); }
});

// ─── POST /api/v1/negative-keywords ──────────────────────────────────────────
router.post('/', async (req, res, next) => {
  try {
    const { campaignId, adGroupId, keywordText, matchType = 'negativeExact' } = req.body;
    if (!campaignId || !keywordText) {
      return res.status(400).json({ error: 'campaignId and keywordText required' });
    }

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
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (profile_id, amazon_neg_keyword_id) DO NOTHING
       RETURNING id, keyword_text, match_type, level, created_at`,
      [req.workspaceId, camp.profile_id, campaignId, adGroupId || null,
       fakeAmazonId, keywordText.trim(), matchType, level]
    );
    const inserted = rows[0] || null;

    if (inserted) {
      pushNegativeKeyword({
        localId: inserted.id, connectionId: camp.connection_id,
        profileId: camp.amazon_profile_id?.toString(), marketplaceId: camp.marketplace_id,
        campaignType: camp.campaign_type, amazonCampaignId: camp.amazon_campaign_id,
        amazonAdGroupId: camp.amazon_ad_group_id || null,
        keywordText: keywordText.trim(), matchType, level,
      }).catch(e => logger.warn('negative keyword write-back error', { error: e.message }));
    }

    res.json({ data: inserted });
  } catch (err) { next(err); }
});

// ─── POST /api/v1/negative-keywords/bulk — add multiple KWs × campaigns ─────
router.post('/bulk', async (req, res, next) => {
  try {
    const { keywords, campaignIds, matchType = 'negativeExact' } = req.body;
    // keywords: [{keywordText, matchType?}] OR [string]
    // campaignIds: [uuid, ...]
    if (!keywords?.length || !campaignIds?.length) {
      return res.status(400).json({ error: 'keywords and campaignIds required' });
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

      for (const kw of keywords) {
        const kwText = typeof kw === 'string' ? kw.trim() : kw.keywordText?.trim();
        const kwType = (typeof kw === 'object' && kw.matchType) ? kw.matchType : matchType;
        if (!kwText) continue;

        const fakeId = `manual_neg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const { rows } = await query(
          `INSERT INTO negative_keywords
             (workspace_id, profile_id, campaign_id, amazon_neg_keyword_id, keyword_text, match_type, level)
           VALUES ($1,$2,$3,$4,$5,$6,'campaign')
           ON CONFLICT (profile_id, amazon_neg_keyword_id) DO NOTHING
           RETURNING id`,
          [req.workspaceId, camp.profile_id, campId, fakeId, kwText, kwType]
        );
        if (rows[0]) {
          added++;
          pushNegativeKeyword({
            localId: rows[0].id, connectionId: camp.connection_id,
            profileId: camp.amazon_profile_id?.toString(), marketplaceId: camp.marketplace_id,
            campaignType: camp.campaign_type, amazonCampaignId: camp.amazon_campaign_id,
            amazonAdGroupId: null, keywordText: kwText, matchType: kwType, level: 'campaign',
          }).catch(() => {});
        } else { skipped++; }
      }
    }

    res.json({ success: true, added, skipped, errors });
  } catch (err) { next(err); }
});

// ─── PATCH /api/v1/negative-keywords/:id — edit keyword text or match type ──
router.patch('/:id', async (req, res, next) => {
  try {
    const { keywordText, matchType } = req.body;
    if (!keywordText && !matchType) return res.status(400).json({ error: 'Nothing to update' });

    const sets = [], vals = [req.params.id, req.workspaceId];
    let pi = 3;
    if (keywordText) { sets.push(`keyword_text = $${pi++}`); vals.push(keywordText.trim()); }
    if (matchType && ['negativeExact', 'negativePhrase', 'negative_exact', 'negative_phrase'].includes(matchType)) {
      sets.push(`match_type = $${pi++}`); vals.push(matchType);
    }

    const { rows } = await query(
      `UPDATE negative_keywords SET ${sets.join(', ')}, updated_at = NOW()
       WHERE id = $1 AND workspace_id = $2
       RETURNING id, keyword_text, match_type, level`,
      vals
    );
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });

    await writeAudit({
      orgId: req.orgId, workspaceId: req.workspaceId,
      actorId: req.user.id, actorName: req.user.name,
      action: 'negative_keyword.updated', entityType: 'negative_keyword',
      entityId: req.params.id, entityName: rows[0].keyword_text,
      afterData: { keyword_text: rows[0].keyword_text, match_type: rows[0].match_type },
      source: 'ui',
    });

    res.json({ data: rows[0] });
  } catch (err) { next(err); }
});

// ─── DELETE /api/v1/negative-keywords/bulk — bulk delete ─────────────────────
router.delete('/bulk', async (req, res, next) => {
  try {
    const { ids } = req.body;
    if (!ids?.length) return res.status(400).json({ error: 'ids required' });

    const { rowCount } = await query(
      'DELETE FROM negative_keywords WHERE id = ANY($1::uuid[]) AND workspace_id = $2',
      [ids, req.workspaceId]
    );

    res.json({ success: true, deleted: rowCount });
  } catch (err) { next(err); }
});

// ─── DELETE /api/v1/negative-keywords/:id ────────────────────────────────────
router.delete('/:id', async (req, res, next) => {
  try {
    await query('DELETE FROM negative_keywords WHERE id = $1 AND workspace_id = $2',
      [req.params.id, req.workspaceId]);
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
