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
  if (!hasDescription) {
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

module.exports = { computeListingIssues, TITLE_MIN, TITLE_MAX, MIN_IMAGES, MIN_ZOOM_PX, MIN_BULLETS };
