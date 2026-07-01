/**
 * Pure, dependency-free helpers for the visual email-campaign block editor:
 *   - compileBlocksToHtml: block list -> email-client-safe HTML (inline styles, table
 *     layout — no <style> blocks, no classes, so it renders identically everywhere).
 *   - buildPreviewDoc: wraps HTML in a standalone document for an isolated iframe preview.
 *   - buildUtmUrl: merges UTM params into a URL without duplicating existing ones.
 * No React/DOM dependency here on purpose — keeps this trivially unit-testable later.
 */

let _uid = 0;
function genId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  _uid += 1;
  return `blk-${Date.now()}-${_uid}`;
}

export const BLOCK_DEFAULTS = {
  text: () => ({ html: "<p>Your text here…</p>" }),
  image: () => ({ src: "", alt: "", width: 600, align: "center", link: "" }),
  button: () => ({ text: "Click here", link: "", bgColor: "#2563EB", textColor: "#ffffff", align: "center", radius: 6 }),
  divider: () => ({ color: "#e2e8f0", thickness: 1, marginY: 16 }),
  spacer: () => ({ height: 24 }),
};

export function newBlock(type) {
  const make = BLOCK_DEFAULTS[type];
  if (!make) throw new Error(`Unknown block type: ${type}`);
  return { id: genId(), type, ...make() };
}

export const EMPTY_BLOCKS = { version: 1, blocks: [] };

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function compileBlock(b) {
  switch (b.type) {
    case "text":
      return `<tr><td style="padding:0 24px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:15px;line-height:1.6;color:#1f2937;">${b.html || ""}</td></tr>`;

    case "image": {
      const img = `<img src="${esc(b.src)}" width="${parseInt(b.width, 10) || 600}" alt="${esc(b.alt)}" style="display:block;max-width:100%;height:auto;border:0;outline:none;text-decoration:none;" />`;
      const inner = b.link ? `<a href="${esc(b.link)}" target="_blank" rel="noopener">${img}</a>` : img;
      return `<tr><td align="${b.align || "center"}" style="padding:8px 24px;">${inner}</td></tr>`;
    }

    case "button": {
      // "Bulletproof button": a 1-cell table with the background on the <td>, not the <a>.
      // Outlook desktop renders HTML mail with Word's engine, which ignores padding/
      // border-radius on anchors but reliably respects table-cell background + sizing.
      const radius = parseInt(b.radius, 10) || 0;
      return `<tr><td align="${b.align || "center"}" style="padding:12px 24px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
          <td style="border-radius:${radius}px;background:${esc(b.bgColor)};">
            <a href="${esc(b.link)}" target="_blank" rel="noopener" style="display:inline-block;padding:12px 28px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:15px;font-weight:600;color:${esc(b.textColor)};text-decoration:none;border-radius:${radius}px;">${esc(b.text)}</a>
          </td>
        </tr></table>
      </td></tr>`;
    }

    case "divider":
      return `<tr><td style="padding:${parseInt(b.marginY, 10) || 0}px 24px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
          <td style="border-top:${parseInt(b.thickness, 10) || 1}px solid ${esc(b.color)};font-size:0;line-height:0;">&nbsp;</td>
        </tr></table>
      </td></tr>`;

    case "spacer": {
      const h = parseInt(b.height, 10) || 0;
      return `<tr><td style="height:${h}px;line-height:${h}px;font-size:0;">&nbsp;</td></tr>`;
    }

    default:
      return "";
  }
}

export function compileBlocksToHtml(contentBlocks) {
  const blocks = contentBlocks?.blocks || [];
  const rows = blocks.map(compileBlock).join("\n");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;margin:0 auto;background:#ffffff;">
${rows}
</table>`;
}

// Substitutes {{first_name}} etc. with sample values, purely for the live preview —
// mirrors the backend's applyMergeTags collapse-unknown-to-empty behavior.
export function previewMergeTags(html) {
  return String(html || "")
    .replace(/\{\{\s*first_name\s*\}\}/g, "Pavel")
    .replace(/\{\{\s*\w+\s*\}\}/g, "");
}

// Wraps compiled/raw HTML in a standalone document for an isolated <iframe srcDoc>
// preview — deliberately does NOT inherit any of AdsFlow's own app-level <style> block.
export function buildPreviewDoc(html) {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:14px;background:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
${previewMergeTags(html)}
</body></html>`;
}

export function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "") || "campaign";
}

// Merges UTM params into a URL via URLSearchParams — overwrites existing utm_* values
// (never duplicates them) and leaves any other query params untouched.
export function buildUtmUrl(rawUrl, utm = {}) {
  if (!rawUrl) return "";
  let u;
  try { u = new URL(rawUrl); }
  catch { try { u = new URL("https://" + rawUrl); } catch { return rawUrl; } }
  const p = u.searchParams;
  Object.entries(utm).forEach(([k, v]) => { if (v) p.set(k, v); else p.delete(k); });
  u.search = p.toString();
  return u.toString();
}
