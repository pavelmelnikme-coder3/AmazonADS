/**
 * Helpers for the visual email-campaign block editor:
 *   - compileBlocksToHtml: block list -> email-client-safe HTML (inline styles, table
 *     layout — no <style> blocks, no classes, so it renders identically everywhere).
 *   - htmlToBlocks: best-effort reverse — parses arbitrary/messy campaign HTML (Word,
 *     Newsletter2Go/Brevo drag-drop exports, etc.) into editable blocks.
 *   - buildPreviewDoc: wraps HTML in a standalone document for an isolated iframe preview.
 *   - buildUtmUrl: merges UTM params into a URL without duplicating existing ones.
 * Everything except htmlToBlocks is pure/dependency-free (no DOM) on purpose, so it's
 * trivially unit-testable. htmlToBlocks needs a real DOM (DOMParser) and only ever runs
 * client-side when the user explicitly asks to convert — never during compile/send.
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

// Strips an element down to a small safe allow-list of inline tags (a/b/strong/i/em/u/br),
// discarding everything else (spans carrying font/mso styling, classes, div wrappers) but
// keeping their text content and nesting position — used by htmlToBlocks so converted text
// blocks don't drag along the original template's class-based styling (the actual source of
// the "looks fine in Gmail, broken in the editor" bug this whole feature exists to fix).
const INLINE_ALLOW = new Set(["A", "B", "STRONG", "I", "EM", "U", "BR"]);
function cleanInlineHtml(html) {
  const container = document.createElement("div");
  container.innerHTML = html;
  const unwrap = (node) => {
    [...node.childNodes].forEach((child) => {
      if (child.nodeType !== 1) return; // text/comment nodes pass through untouched
      unwrap(child);
      if (INLINE_ALLOW.has(child.tagName)) {
        const href = child.tagName === "A" ? child.getAttribute("href") : null;
        [...child.attributes].forEach((attr) => child.removeAttribute(attr.name));
        if (href) child.setAttribute("href", href);
      } else {
        while (child.firstChild) node.insertBefore(child.firstChild, child);
        node.removeChild(child);
      }
    });
  };
  unwrap(container);
  return container.innerHTML.trim();
}

function looksLikeButton(a) {
  const cls = (a.className || "").toLowerCase();
  if (cls.includes("button") || cls.includes("btn")) return true;
  const style = (a.getAttribute("style") || "").toLowerCase();
  return /background(-color)?\s*:/.test(style) && /display\s*:\s*(inline-block|block)/.test(style);
}

/**
 * Best-effort HTML -> blocks conversion for switching a legacy raw-HTML campaign into the
 * visual editor. Inherently heuristic — arbitrary email templates (nested tables, VML
 * button fallbacks, mso- conditional markup) can't be perfectly reconstructed as a
 * single-column block list. Extracts, in document order: images, button-like links,
 * and paragraph/heading/list text — anything else (layout tables, spacer cells, the
 * <style> block itself) is dropped since none of it survives into the compiled output
 * anyway. Returns a single default text block if nothing recognizable was found.
 */
export function htmlToBlocks(html) {
  const doc = new DOMParser().parseFromString(html || "", "text/html");
  doc.querySelectorAll("style, script").forEach((el) => el.remove());

  const blocks = [];
  const seenImgSrc = new Set();
  const seenText = new Set();

  doc.body.querySelectorAll("img, a, p, h1, h2, h3, h4, li").forEach((el) => {
    if (el.tagName === "IMG") {
      const src = el.getAttribute("src");
      if (!src || seenImgSrc.has(src)) return;
      seenImgSrc.add(src);
      const parentLink = el.closest("a");
      blocks.push({
        ...newBlock("image"), src,
        alt: el.getAttribute("alt") || "",
        width: parseInt(el.getAttribute("width"), 10) || 600,
        link: parentLink ? parentLink.getAttribute("href") || "" : "",
      });
      return;
    }
    if (el.tagName === "A") {
      if (!looksLikeButton(el)) return;
      const text = el.textContent.trim();
      if (!text) return;
      const style = el.getAttribute("style") || "";
      const bg = style.match(/background(?:-color)?\s*:\s*([^;]+)/i);
      const color = style.match(/(?:^|;)\s*color\s*:\s*([^;]+)/i);
      blocks.push({
        ...newBlock("button"), text, link: el.getAttribute("href") || "",
        bgColor: bg ? bg[1].trim() : "#2563EB", textColor: color ? color[1].trim() : "#ffffff",
      });
      return;
    }
    // Text-bearing element: skip if it's button text (already captured above), just wraps
    // an image, or is an empty spacer paragraph (e.g. <p><br></p> used for vertical gaps).
    if (el.closest("a") && looksLikeButton(el.closest("a"))) return;
    if (el.querySelector("img")) return;
    if (!el.textContent.trim()) return;
    const cleaned = cleanInlineHtml(el.innerHTML);
    if (!cleaned || seenText.has(cleaned)) return;
    seenText.add(cleaned);
    const tag = /^H[1-4]$/.test(el.tagName) ? "p" : (el.tagName === "LI" ? "li" : "p"); // compiled output only supports <p>-level text
    blocks.push({ ...newBlock("text"), html: `<${tag}>${cleaned}</${tag}>` });
  });

  return blocks.length ? blocks : [newBlock("text")];
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
