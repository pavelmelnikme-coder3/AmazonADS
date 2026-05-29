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

// Hard exclusion rules for organic-listing keywords. Shared by generation and
// scoring prompts. These categories either violate Amazon policy (brand terms)
// or hurt conversion/relevance, so they must never appear in the listing.
const KEYWORD_EXCLUSIONS = `STRICTLY FORBIDDEN — these keywords must NEVER appear:
- Competitor brand names — a direct violation of Amazon's policy that can get the listing suppressed or blocked.
- The seller's OWN brand name — it is already indexed automatically, so it only wastes valuable keyword space.
- Subjective / promotional claims: best, cheapest, amazing, premium, on sale, top, #1, guaranteed, luxury — and their equivalents in the target language.
- ASIN codes (e.g. B0XXXXXXXX) or any product identifiers.
- Misleading terms not related to the actual product — they hurt conversion and listing relevance.`;

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
async function generateSeedKeywords({ productTitle, productDescription, marketplace, locale = "" }) {
  if (!productTitle) return [];
  const langName = locale ? (LOCALE_NAMES[locale] || locale) : null;

  const langInstruction = langName
    ? `Target language: ${langName}. ALL keywords MUST be in ${langName} — the language shoppers actually type.`
    : `Use the most natural language(s) for this product and marketplace.`;

  const germanTip = locale === "de"
    ? `\nGerman-specific: include BOTH compound and spaced forms (e.g. "Thermobehälter für Essen" AND "Thermo Behälter Essen"). Regional synonyms (Henkelmann, Speisegefäß, Vesperdose) are valuable.`
    : "";

  const prompt = `You are an Amazon SEO specialist optimizing product listings for organic ranking on Amazon's A9/A10 algorithm.

Product description:
"${productTitle}"

${langInstruction}${germanTip}

Goal: identify keywords that maximize organic discoverability. These keywords will be placed in the Amazon listing (title, bullet points, backend search terms, description) to rank organically — NOT for PPC ads.

Amazon A9 ranking weight by section:
- TITLE: highest weight (2×) — use highest-volume, most-searched exact terms
- BULLETS: strong secondary signal — feature/benefit/use-case queries
- BACKEND: indexed but hidden — synonyms, long-tail, alternative names, misspellings
- DESCRIPTION: semantic context — storytelling phrases, problem-solution queries

Generate exactly 40 keywords covering ALL of these categories:
1. CORE product category terms (what IS this product — primary search queries)
2. FEATURE keywords (material, capacity, size, technical specs)
3. USE-CASE keywords (who uses it + when/where: für Kinder, fürs Büro, zum Wandern, für die Schule...)
4. BENEFIT keywords (leakproof/auslaufsicher, dishwasher-safe/spülmaschinenfest, insulated/isoliert...)
5. SYNONYM / ALTERNATIVE NAMES (different words for the same product type)
6. LONG-TAIL combinations (specific phrases with lower competition but clear buyer intent)
7. PROBLEM-SOLUTION queries ("Essen warm halten unterwegs", "thermobehälter ohne auslaufen"...)

${KEYWORD_EXCLUSIONS}
Do NOT generate any keyword that falls into the categories above.

For each keyword assign placement:
- "title" — if it would be a primary search a buyer uses to find exactly this product (highest volume)
- "bullets" — feature/benefit/use-case specific
- "backend" — long-tail, synonyms, regional terms, misspellings
- "description" — contextual phrases, semantic enrichment

Respond ONLY with valid JSON, no markdown:
{"keywords":[{"text":"keyword","match_type":"exact|phrase|broad","placement":"title|bullets|backend|description","relevance":90}]}

relevance: 90-100=critical for title, 75-89=important for bullets/backend, 60-74=useful for backend. Omit below 60.`;

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

    const VALID_PLACEMENTS = new Set(["title", "bullets", "backend", "description"]);
    return (parsed.keywords || [])
      .filter(k => k.text && (k.relevance || 60) >= 60)
      .map(k => ({
        keyword_text: k.text.trim(),
        match_type: k.match_type || "broad",
        suggested_match_types: k.match_type === "exact"
          ? ["exact", "phrase"]
          : k.match_type === "phrase" ? ["phrase", "broad"] : ["exact", "phrase", "broad"],
        relevance_score: k.relevance || 75,
        placement_hint: VALID_PLACEMENTS.has(k.placement) ? k.placement : null,
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
async function scoreAndFilterKeywords({ keywords, productTitle, locale = "" }) {
  if (!keywords?.length || !productTitle) return keywords;
  const langName = locale ? (LOCALE_NAMES[locale] || locale) : null;

  const results = [];

  // Process in batches of 50
  for (let i = 0; i < keywords.length; i += 50) {
    const batch = keywords.slice(i, i + 50);
    const marketplaceDesc = langName ? `${langName} marketplace` : "Amazon marketplace";

    const prompt = `You are an Amazon SEO specialist. Rate these keywords for organic listing relevance for: "${productTitle}" on Amazon (${marketplaceDesc}).

For each keyword provide:
- relevance_score: 0-100 (how likely a buyer searching this keyword wants exactly this product)
- suggested_match_types: array from ["exact","phrase","broad"]
- placement: where in the listing this keyword belongs: "title" (high-volume core terms), "bullets" (feature/use-case), "backend" (long-tail/synonyms), "description" (contextual phrases)
- keep: false if completely irrelevant or wrong product category, OR if it is a forbidden keyword (see below)

${KEYWORD_EXCLUSIONS}
Set keep:false for ANY keyword that falls into the forbidden categories above.

Keywords:
${batch.map((k, idx) => `${idx + 1}. "${k.keyword_text}"`).join("\n")}

Respond ONLY with valid JSON:
{"scored":[{"index":1,"relevance_score":85,"suggested_match_types":["exact","phrase"],"placement":"title","keep":true}]}`;

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

        const VALID_PL = new Set(["title", "bullets", "backend", "description"]);
        results.push({
          ...batch[idx],
          relevance_score: scored.relevance_score ?? batch[idx].relevance_score ?? 50,
          suggested_match_types: scored.suggested_match_types?.length
            ? scored.suggested_match_types
            : batch[idx].suggested_match_types || [batch[idx].match_type || "broad"],
          placement_hint: batch[idx].placement_hint
            || (VALID_PL.has(scored.placement) ? scored.placement : null),
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
