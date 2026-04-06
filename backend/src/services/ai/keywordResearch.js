/**
 * AI Keyword Research — Claude-powered keyword generation and scoring.
 *
 * Two functions:
 *  1. generateSeedKeywords — given product title + target language, generate relevant keywords
 *  2. scoreAndFilterKeywords — score a batch of keywords for relevance and suggest match types
 *
 * Used when: seller doesn't know the target language; expanding beyond what APIs return;
 * scoring/filtering mixed keyword pools from multiple sources.
 */

const Anthropic = require("@anthropic-ai/sdk");
const logger = require("../../config/logger");

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514";

const LOCALE_NAMES = {
  en: "English", de: "German", fr: "French", es: "Spanish",
  it: "Italian", ja: "Japanese", zh: "Chinese (Simplified)", pt: "Portuguese",
  nl: "Dutch", pl: "Polish", sv: "Swedish", tr: "Turkish",
  ar: "Arabic", hi: "Hindi", ko: "Korean",
};

/**
 * Generate seed keywords for a product using Claude.
 * Especially useful for non-native language markets.
 *
 * @param {object} params
 * @param {string} params.productTitle
 * @param {string} [params.productDescription]
 * @param {string} [params.marketplace]    - e.g. "A1PA6795UKMFR9"
 * @param {string} [params.locale]         - e.g. "de"
 * @returns {Promise<Array>}
 */
async function generateSeedKeywords({ productTitle, productDescription, marketplace, locale = "en" }) {
  if (!productTitle) return [];
  const langName = LOCALE_NAMES[locale] || locale;

  const prompt = `You are an expert Amazon PPC keyword researcher. Generate highly relevant Amazon search keywords for this product.

Product: "${productTitle}"${productDescription ? `\nDescription: "${productDescription.slice(0, 500)}"` : ""}
Target language: ${langName}

Generate exactly 30 keywords that Amazon shoppers use when searching for this type of product.
Cover:
1. Exact product name variations (brand + product type)
2. Feature-based queries (material, size, use case)
3. Problem-solving queries ("best X for Y")
4. Category browse terms
5. Competitor/alternative terms

CRITICAL: ALL keywords MUST be written in ${langName}. Never use English if the target language is different.

Respond ONLY with valid JSON, no markdown, no explanation:
{"keywords":[{"text":"keyword","match_type":"exact|phrase|broad","relevance":85}]}

relevance: 90-100 = core product keywords, 70-89 = highly relevant, 50-69 = relevant. Skip below 60.`;

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 2000,
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content[0]?.text?.trim() || "{}";
    // Strip markdown code fences if model wrapped it
    const jsonText = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
    const parsed = JSON.parse(jsonText);

    return (parsed.keywords || [])
      .filter(k => k.text && (k.relevance || 60) >= 60)
      .map(k => ({
        keyword_text: k.text.trim(),
        match_type: k.match_type || "broad",
        suggested_match_types: k.match_type === "exact"
          ? ["exact", "phrase"]
          : k.match_type === "phrase" ? ["phrase", "broad"] : ["exact", "phrase", "broad"],
        relevance_score: k.relevance || 75,
        source: "ai_generated",
      }));
  } catch (e) {
    logger.warn("AI keyword generation failed", { error: e.message, locale });
    return [];
  }
}

/**
 * Score and filter a list of keywords for relevance to a product.
 * Processes in batches of 50 to stay within token limits.
 *
 * @param {object} params
 * @param {Array}  params.keywords      - array of {keyword_text, ...} objects
 * @param {string} params.productTitle
 * @param {string} [params.locale]
 * @returns {Promise<Array>} sorted by relevance_score desc, irrelevant filtered out
 */
async function scoreAndFilterKeywords({ keywords, productTitle, locale = "en" }) {
  if (!keywords?.length || !productTitle) return keywords;
  const langName = LOCALE_NAMES[locale] || locale;

  const results = [];

  // Process in batches of 50
  for (let i = 0; i < keywords.length; i += 50) {
    const batch = keywords.slice(i, i + 50);

    const prompt = `Rate these keywords for relevance to: "${productTitle}" on Amazon (${langName} marketplace).

For each keyword provide:
- relevance_score: 0-100
- suggested_match_types: array from ["exact","phrase","broad"] that make sense for this keyword
- keep: false only if clearly wrong/irrelevant/nonsensical

Keywords:
${batch.map((k, idx) => `${idx + 1}. "${k.keyword_text}"`).join("\n")}

Respond ONLY with valid JSON:
{"scored":[{"index":1,"relevance_score":85,"suggested_match_types":["exact","phrase"],"keep":true}]}`;

    try {
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 3000,
        messages: [{ role: "user", content: prompt }],
      });

      const text = response.content[0]?.text?.trim() || "{}";
      const jsonText = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
      const parsed = JSON.parse(jsonText);

      for (const scored of (parsed.scored || [])) {
        const idx = (scored.index || 1) - 1;
        if (idx < 0 || idx >= batch.length) continue;
        if (scored.keep === false) continue;

        results.push({
          ...batch[idx],
          relevance_score: scored.relevance_score ?? batch[idx].relevance_score ?? 50,
          suggested_match_types: scored.suggested_match_types?.length
            ? scored.suggested_match_types
            : batch[idx].suggested_match_types || [batch[idx].match_type || "broad"],
        });
      }
    } catch (e) {
      // Scoring failed for this batch — keep all with original scores
      logger.warn("AI keyword scoring failed for batch", { error: e.message });
      results.push(...batch);
    }
  }

  return results
    .filter(k => (k.relevance_score ?? 50) >= 50)
    .sort((a, b) => (b.relevance_score || 0) - (a.relevance_score || 0));
}

module.exports = { generateSeedKeywords, scoreAndFilterKeywords };
