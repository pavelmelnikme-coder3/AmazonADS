/**
 * Amazon organic rank scraper.
 *
 * Searches Amazon for a keyword, scans up to 7 pages, and returns
 * the organic position of the given ASIN.
 *
 * Safety measures:
 *  - Randomised User-Agent from a realistic pool
 *  - 5-12 s delay between pages, 20-50 s between keywords
 *  - CAPTCHA / block detection → stops the batch immediately
 *  - Skips clearly sponsored slots (data-component-type="s-sponsored-result")
 */

const axios   = require("axios");
const https   = require("https");
const logger  = require("../../config/logger");

// When proxy is used, skip TLS cert validation (proxy may do SSL inspection on port 80)
const proxyHttpsAgent = new https.Agent({ rejectUnauthorized: false });

// ScraperAPI support — set SCRAPERAPI_KEY=your_key in .env to route through ScraperAPI.
// Free tier: 5000 requests/month. Sign up at scraperapi.com (no credit card needed).
const SCRAPERAPI_KEY = process.env.SCRAPERAPI_KEY || null;
if (SCRAPERAPI_KEY) logger.info("rankScraper: using ScraperAPI");

// Optional HTTP proxy fallback (used only when SCRAPERAPI_KEY is not set).
// Set RANK_PROXY_URL=http://user:pass@host:port in .env to enable.
let proxyConfig = null;
if (!SCRAPERAPI_KEY && process.env.RANK_PROXY_URL) {
  try {
    const u = new URL(process.env.RANK_PROXY_URL);
    const proxyPort = u.port || (u.protocol === "https:" ? "443" : "80");
    proxyConfig = {
      host: u.hostname,
      port: parseInt(proxyPort),
      protocol: u.protocol.replace(":", ""),
      ...(u.username ? { auth: { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) } } : {}),
    };
    logger.info("rankScraper: proxy configured", { host: u.hostname, port: parseInt(proxyPort) });
  } catch (e) {
    logger.warn("rankScraper: invalid RANK_PROXY_URL, scraping without proxy", { err: e.message });
  }
}

const MARKETPLACE = {
  A1PA6795UKMFR9: { domain: "amazon.de",     lang: "de-DE,de;q=0.9,en;q=0.8", scraperCountry: "eu" },
  ATVPDKIKX0DER:  { domain: "amazon.com",    lang: "en-US,en;q=0.9",           scraperCountry: "us" },
  A1F83G8C2ARO7P: { domain: "amazon.co.uk",  lang: "en-GB,en;q=0.9",           scraperCountry: "eu" },
  A13V1IB3VIYZZH: { domain: "amazon.fr",     lang: "fr-FR,fr;q=0.9,en;q=0.8", scraperCountry: "eu" },
  APJ6JRA9NG5V4:  { domain: "amazon.it",     lang: "it-IT,it;q=0.9,en;q=0.8", scraperCountry: "eu" },
  A1RKKUPIHCS9HS: { domain: "amazon.es",     lang: "es-ES,es;q=0.9,en;q=0.8", scraperCountry: "eu" },
};

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_3_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.4; rv:124.0) Gecko/20100101 Firefox/124.0",
];

const sleep    = ms => new Promise(r => setTimeout(r, ms));
const randInt  = (min, max) => Math.floor(min + Math.random() * (max - min));
const randSleep = (min, max) => sleep(randInt(min, max));
const pickUA   = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

function isBlocked(html) {
  return (
    html.includes("Type the characters you see in this image") ||
    html.includes("Enter the characters you see below") ||
    html.includes("api-services-support@amazon.com") ||
    html.includes("To discuss automated access to Amazon data") ||
    html.length < 5000
  );
}

/**
 * Extract organic (non-sponsored) ASINs from Amazon search HTML in order.
 * We split on sponsored boundaries and collect only organic result ASINs.
 */
function extractOrganicAsins(html) {
  const asins = [];
  const seen  = new Set();

  // Split HTML into blocks at each search-result/sponsored-result boundary
  const blockRe = /data-component-type="(s-search-result|s-sponsored-result)"([^>]*)>/g;
  let m;
  let lastIdx = 0;
  const blocks = [];

  while ((m = blockRe.exec(html)) !== null) {
    blocks.push({ type: m[1], idx: m.index, content: "" });
  }

  for (let i = 0; i < blocks.length; i++) {
    const start = blocks[i].idx;
    const end   = i + 1 < blocks.length ? blocks[i + 1].idx : html.length;
    blocks[i].content = html.slice(start, end);
  }

  for (const block of blocks) {
    if (block.type !== "s-search-result") continue;
    const asinM = block.content.match(/data-asin="([A-Z0-9]{10})"/);
    if (asinM && !seen.has(asinM[1])) {
      seen.add(asinM[1]);
      asins.push(asinM[1]);
    }
  }

  // Fallback: if the block approach yielded nothing (page layout change),
  // fall back to all data-asin values to avoid missing data
  if (asins.length === 0) {
    const allM = [...html.matchAll(/data-asin="([A-Z0-9]{10})"/g)];
    for (const am of allM) {
      if (!seen.has(am[1])) {
        seen.add(am[1]);
        asins.push(am[1]);
      }
    }
  }

  return asins;
}

/**
 * Scrape organic rank for `asin` when searching `keyword` on Amazon.
 * @returns {{ position: number|null, page: number|null, found: boolean, blocked: boolean }}
 */
async function scrapeRank(asin, keyword, marketplaceId = "A1PA6795UKMFR9") {
  const { domain, lang, scraperCountry } = MARKETPLACE[marketplaceId] || MARKETPLACE["A1PA6795UKMFR9"];
  const ua = pickUA();
  let overallPosition = 0;

  for (let pageNum = 1; pageNum <= 7; pageNum++) {
    const amazonUrl = `https://www.${domain}/s?k=${encodeURIComponent(keyword)}&page=${pageNum}`;
    const url = SCRAPERAPI_KEY
      ? `http://api.scraperapi.com/?api_key=${SCRAPERAPI_KEY}&url=${encodeURIComponent(amazonUrl)}&country_code=${scraperCountry}`
      : amazonUrl;

    try {
      const resp = await axios.get(url, {
        ...(proxyConfig ? { proxy: proxyConfig, httpsAgent: proxyHttpsAgent } : {}),
        headers: SCRAPERAPI_KEY ? {} : {
          "User-Agent": ua,
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
          "Accept-Language": lang,
          "Accept-Encoding": "gzip, deflate, br",
          "Connection": "keep-alive",
          "Upgrade-Insecure-Requests": "1",
          "Sec-Fetch-Dest": "document",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Site": "none",
        },
        timeout: 30000,
        maxRedirects: 5,
      });

      if (isBlocked(resp.data)) {
        logger.warn("rankScraper: blocked by Amazon", { asin, keyword, page: pageNum });
        return { position: null, page: null, found: false, blocked: true };
      }

      const organicAsins = extractOrganicAsins(resp.data);

      const idx = organicAsins.indexOf(asin);
      if (idx !== -1) {
        return { position: overallPosition + idx + 1, page: pageNum, found: true, blocked: false };
      }

      overallPosition += organicAsins.length;

      if (pageNum < 7) await randSleep(SCRAPERAPI_KEY ? 500 : 5000, SCRAPERAPI_KEY ? 1500 : 12000);

    } catch (err) {
      const status = err.response?.status;
      if (status === 503 || status === 429 || status === 402 || status === 403) {
        logger.warn("rankScraper: rate limited or quota exceeded", { asin, keyword, status });
        return { position: null, page: null, found: false, blocked: true };
      }
      if (err.message?.includes("redirect")) {
        logger.warn("rankScraper: proxy redirect error (proxy may be unreliable)", { asin, keyword, error: err.message });
        return { position: null, page: null, found: false, blocked: true };
      }
      logger.error("rankScraper: request failed", { asin, keyword, error: err.message });
      return { position: null, page: null, found: false, blocked: false };
    }
  }

  // Not found in top 7 pages (~112 results)
  return { position: null, page: null, found: false, blocked: false };
}

/**
 * Run rank checks for all active tracked keywords in a workspace.
 * Stops early if Amazon blocks the scraper.
 */
async function scrapeWorkspaceRanks(workspaceId, db) {
  const { rows: keywords } = await db.query(
    `SELECT id, asin, keyword, marketplace_id
     FROM tracked_keywords
     WHERE workspace_id = $1 AND is_active = TRUE
     ORDER BY created_at ASC`,
    [workspaceId]
  );

  const results = [];
  for (let i = 0; i < keywords.length; i++) {
    const kw = keywords[i];
    logger.info("rankScraper: checking", { asin: kw.asin, keyword: kw.keyword });

    const result = await scrapeRank(kw.asin, kw.keyword, kw.marketplace_id);

    await db.query(
      `INSERT INTO keyword_rank_snapshots
         (tracked_keyword_id, position, page, found, blocked)
       VALUES ($1, $2, $3, $4, $5)`,
      [kw.id, result.position, result.page, result.found, result.blocked]
    );

    results.push({ keyword: kw.keyword, asin: kw.asin, ...result });

    if (result.blocked) {
      logger.warn("rankScraper: blocked — stopping batch early", { workspaceId, checkedSoFar: i + 1 });
      break;
    }

    // Delay between keywords
    if (i < keywords.length - 1) await randSleep(SCRAPERAPI_KEY ? 1000 : 20000, SCRAPERAPI_KEY ? 3000 : 50000);
  }

  return results;
}

module.exports = { scrapeRank, scrapeWorkspaceRanks };
