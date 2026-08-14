// EU marketplaces the cross-country listing check covers.
//
// Verified 2026-07-31 against SP-API `GET /sellers/v1/marketplaceParticipations`
// on the live account: all nine are returned with isParticipating=true and are
// reachable with the single EU refresh token (an SP-API refresh token is bound
// to one region, so NA/FE would need a separate authorization).
//
// The account also participates in IE, TR, AE and SA. They are intentionally
// excluded: TR reports hasSuspendedListings=true, and IE/AE/SA have no Amazon
// Ads profile, so a listing report on them would have nothing to act on.
// Amazon's "si-prod*" Business/store participations are excluded for the same
// reason — they are storefront variants of the same catalog, not real countries.
const EU_MARKETPLACES = [
  { marketplaceId: "A1PA6795UKMFR9", countryCode: "DE", domain: "amazon.de",     currency: "EUR" },
  { marketplaceId: "A13V1IB3VIYZZH", countryCode: "FR", domain: "amazon.fr",     currency: "EUR" },
  { marketplaceId: "APJ6JRA9NG5V4",  countryCode: "IT", domain: "amazon.it",     currency: "EUR" },
  { marketplaceId: "A1RKKUPIHCS9HS", countryCode: "ES", domain: "amazon.es",     currency: "EUR" },
  { marketplaceId: "A1805IZSGTT6HS", countryCode: "NL", domain: "amazon.nl",     currency: "EUR" },
  { marketplaceId: "AMEN7PMS3EDWL",  countryCode: "BE", domain: "amazon.com.be", currency: "EUR" },
  { marketplaceId: "A1C3SOZRARQ6R3", countryCode: "PL", domain: "amazon.pl",     currency: "PLN" },
  { marketplaceId: "A2NODRKZP88ZB9", countryCode: "SE", domain: "amazon.se",     currency: "SEK" },
  { marketplaceId: "A1F83G8C2ARO7P", countryCode: "GB", domain: "amazon.co.uk",  currency: "GBP" },
];

const EU_MARKETPLACE_IDS = EU_MARKETPLACES.map(m => m.marketplaceId);

const BY_ID = new Map(EU_MARKETPLACES.map(m => [m.marketplaceId, m]));

function marketplaceById(marketplaceId) {
  return BY_ID.get(marketplaceId) || null;
}

function countryCodeFor(marketplaceId) {
  return BY_ID.get(marketplaceId)?.countryCode || null;
}

function listingUrl(asin, marketplaceId) {
  const domain = BY_ID.get(marketplaceId)?.domain;
  return domain ? `https://www.${domain}/dp/${asin}` : null;
}

module.exports = {
  EU_MARKETPLACES,
  EU_MARKETPLACE_IDS,
  marketplaceById,
  countryCodeFor,
  listingUrl,
};
