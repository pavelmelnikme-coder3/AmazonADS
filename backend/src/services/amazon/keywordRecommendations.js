/**
 * Amazon Ads API — Keyword Recommendations
 * POST /sp/targets/keywords/recommendations
 *
 * Returns ranked keyword suggestions for given ASINs or ad group.
 * Requires SP account with active campaigns.
 */

const { post } = require("./adsClient");
const logger = require("../../config/logger");

// Amazon marketplace ID → locale string for keyword recommendations
const MARKETPLACE_LOCALE = {
  ATVPDKIKX0DER: "en_US",  // US
  A2EUQ1WTGCTBG2: "en_CA", // CA
  A1AM78C64UM0Y8: "es_MX", // MX
  A1F83G8C2ARO7P: "en_GB", // UK
  A1PA6795UKMFR9: "de_DE", // DE
  APJ6JRA9NG5V4:  "it_IT", // IT
  A13V1IB3VIYZZH: "fr_FR", // FR
  A1RKKUPIHCS9HS: "es_ES", // ES
  A1MNDV6DTONNN6: "nl_NL", // NL
  A2NODRKZP88ZB9: "sv_SE", // SE
  A1C3SOZRARQ6R3: "pl_PL", // PL
  A33AVAJ2PDY3EV: "tr_TR", // TR
  A17E79C6D8DWNP: "ar_SA", // SA
  A2VIGQ35RCS4UG: "ar_AE", // AE
  A39IBJ37TRP1C6: "en_AU", // AU
  A1VC38T7YXB528: "ja_JP", // JP
  A21TJRUUN4KGV:  "en_IN", // IN
  A19VAU5U5O7RUS: "en_SG", // SG
};

/**
 * @param {object} params
 * @param {string} params.connectionId
 * @param {string} params.profileId          - Amazon numeric profile ID
 * @param {string} params.marketplaceId
 * @param {string[]} [params.asins]          - ASINs to get recommendations for
 * @param {string}  [params.amazonAdGroupId] - if set, use KEYWORD_FOR_ADGROUP mode
 * @param {string}  [params.amazonCampaignId]
 * @param {number}  [params.maxRecommendations=200]
 * @returns {Promise<Array>}
 */
async function getAmazonKeywordRecommendations({
  connectionId, profileId, marketplaceId,
  asins, amazonAdGroupId, amazonCampaignId,
  maxRecommendations = 200,
}) {
  if (!connectionId || !profileId) return [];

  try {
    const locale = MARKETPLACE_LOCALE[marketplaceId] || "en_US";
    const useAdGroup = amazonAdGroupId && amazonCampaignId;

    // Amazon v3 uses plural: KEYWORDS_FOR_ASINS / KEYWORDS_FOR_ADGROUP
    const body = {
      recommendationType: useAdGroup ? "KEYWORDS_FOR_ADGROUP" : "KEYWORDS_FOR_ASINS",
      maxRecommendations,
      sortDimension: "DEFAULT",
      bidsEnabled: true,
      locale,
    };

    if (useAdGroup) {
      body.adGroupId = amazonAdGroupId;
      body.campaignId = amazonCampaignId;
    } else if (asins?.length) {
      body.asins = asins.slice(0, 10); // Amazon accepts up to 10
    } else {
      return []; // Nothing to query
    }

    const result = await post({
      connectionId,
      profileId: profileId.toString(),
      marketplace: marketplaceId,
      path: "/sp/targets/keywords/recommendations",
      data: body,
      group: "keywords",
    });

    // Amazon v3 response: { keywordTargetList: [{ keyword, matchType, bidInfo: { bid, range }, searchTermImpressionShare }] }
    const recommendations = result?.keywordTargetList || [];

    return recommendations.map(kw => ({
      keyword_text: kw.keyword,
      match_type: (kw.matchType || "BROAD").toLowerCase(),
      suggested_match_types: [(kw.matchType || "BROAD").toLowerCase()],
      bid_suggested: kw.bidInfo?.bid ?? null,
      bid_range_low:  kw.bidInfo?.range?.low  ?? null,
      bid_range_high: kw.bidInfo?.range?.high ?? null,
      impressions_share: kw.searchTermImpressionShare ?? null,
      impressions_rank:  kw.searchTermImpressionRank  ?? null,
      relevance_score: 80, // Amazon recommendations are highly relevant by definition
      source: "amazon_ads",
    })).filter(k => k.keyword_text);
  } catch (e) {
    logger.warn("Amazon keyword recommendations failed (non-fatal)", { profileId, error: e.message });
    return [];
  }
}

module.exports = { getAmazonKeywordRecommendations };
