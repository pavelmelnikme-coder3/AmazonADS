// Listing health scoring — mirrors the 6 checkable criteria from Amazon's own
// "Listing improvement recommendations" (Ads console → ad group). That feature
// has no public API (confirmed against Amazon's docs), so this recomputes the
// same checks from SP-API Catalog Items + A+ Content data we already have
// access to. A 7th Amazon criterion — search terms — is not included here: it
// requires the Listings Items API + a seller ID (Merchant Token) we don't have
// authorized yet.
const TITLE_MIN = 25;
const TITLE_MAX = 200;
const MIN_IMAGES = 4;
const MIN_ZOOM_PX = 1000;
const MIN_BULLETS = 3;

function computeListingIssues({ title, bulletPoints = [], description, images = [], hasAplus }) {
  const issues = [];

  const titleLen = (title || "").trim().length;
  if (!title || titleLen < TITLE_MIN || titleLen > TITLE_MAX) {
    issues.push({ code: "title", value: titleLen });
  }

  const bulletCount = (bulletPoints || []).filter(Boolean).length;
  if (bulletCount < MIN_BULLETS) {
    issues.push({ code: "bullets", value: bulletCount });
  }

  const hasDescription = !!(description && description.trim().length > 0);
  // A+ content supersedes the plain product-description section on the Amazon listing
  // page, so a missing description is only a real gap when there is ALSO no A+ content.
  if (!hasDescription && !hasAplus) {
    issues.push({ code: "description" });
  }

  // Catalog Items returns one entry per (variant, size) — e.g. MAIN at 1000px,
  // 500px and 75px are three list entries for the same photo. Distinct variant
  // labels (MAIN, PT01, PT02...) is the actual photo count Amazon means.
  const variantSet = new Set((images || []).map(img => img.variant).filter(Boolean));
  const imageCount = variantSet.size;
  if (imageCount < MIN_IMAGES) {
    issues.push({ code: "images_count", value: imageCount });
  }

  // Amazon enables zoom once the LONGEST side reaches 1000px, not both sides
  // (confirmed against Amazon's seller documentation) — a 1200x900 image
  // qualifies for zoom even though its shorter side is under 1000px.
  const hasZoomableImage = (images || []).some(img => (img.width || 0) >= MIN_ZOOM_PX || (img.height || 0) >= MIN_ZOOM_PX);
  if (!hasZoomableImage) {
    issues.push({ code: "images_zoom" });
  }

  if (!hasAplus) {
    issues.push({ code: "aplus" });
  }

  return {
    titleLen, bulletCount, imageCount, hasZoomableImage, hasDescription,
    hasAplus: !!hasAplus,
    issues,
    issueCount: issues.length,
  };
}

// ─── Cross-country checks ────────────────────────────────────────────────────
// Run on top of the six single-listing checks above when the same ASIN is
// compared across marketplaces. These catch the failure modes that only exist
// once a listing is expanded abroad: it was never created, or it was created by
// copying the home marketplace verbatim and never localized.
//
// `reference` is the listing in the product's home marketplace (DE here). The
// reference listing itself gets no cross-country issues — it is what everything
// else is measured against.

// Titles/bullets are compared case- and whitespace-insensitively: Amazon's own
// EU listing-copy tooling reproduces the source text exactly, so an exact match
// after normalization is what "never translated" actually looks like. Anything
// looser would flag genuinely-translated NL/DE or BE/FR pairs that share brand
// names and units.
function _norm(s) {
  return (s || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function computeCrossCountryIssues({ target, reference, existsInCatalog }) {
  // Not listed at all — every content check below would be meaningless noise,
  // so this one issue replaces them entirely.
  if (!existsInCatalog) return { issues: [{ code: "not_listed" }], replacesBase: true };

  const issues = [];
  if (!reference) return { issues, replacesBase: false };

  const drop = new Set();

  const tNorm = _norm(target.title);
  if (tNorm && tNorm === _norm(reference.title)) {
    issues.push({ code: "title_not_localized" });
  }

  const tBullets = (target.bulletPoints || []).map(_norm).filter(Boolean);
  const rBullets = (reference.bulletPoints || []).map(_norm).filter(Boolean);
  if (tBullets.length && tBullets.length === rBullets.length && tBullets.every((b, i) => b === rBullets[i])) {
    issues.push({ code: "bullets_not_localized" });
  }

  if (reference.hasAplus && !target.hasAplus) {
    issues.push({ code: "aplus_missing_vs_ref" });
    // Strictly stronger than the plain "no A+ content" check — showing both
    // would list the same gap twice in the UI.
    drop.add("aplus");
  }

  if (reference.imageCount > 0 && target.imageCount < reference.imageCount) {
    issues.push({ code: "fewer_images_vs_ref", value: target.imageCount, reference: reference.imageCount });
  }

  // Listed, but Amazon assigns no sales rank — in practice no sales history in
  // that store. Distinct from "not listed": the listing exists and can be fixed
  // with traffic rather than created from scratch.
  if (target.bestRank == null) {
    issues.push({ code: "no_bsr" });
  }

  return { issues, replacesBase: false, drop };
}

module.exports = {
  computeListingIssues,
  computeCrossCountryIssues,
  TITLE_MIN, TITLE_MAX, MIN_IMAGES, MIN_ZOOM_PX, MIN_BULLETS,
};
