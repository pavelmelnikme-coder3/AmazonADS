/**
 * Helpers for the visual email-campaign block editor:
 *   - compileBlocksToHtml: block list -> email-client-safe HTML (inline styles, table
 *     layout — no <style> blocks, no classes, so it renders identically everywhere).
 *   - htmlToBlocks: best-effort reverse — parses arbitrary/messy campaign HTML (Word,
 *     Newsletter2Go/Brevo drag-drop exports, etc.) into editable blocks.
 *   - unpackStandaloneHtml: some design-tool exports are a self-executing JS "bundle"
 *     (the real markup only exists after a script unpacks it in a real browser) rather
 *     than flat HTML — runs that script in an isolated sandboxed iframe and captures the
 *     resulting DOM.
 *   - buildPreviewDoc: wraps HTML in a standalone document for an isolated iframe preview.
 *   - buildUtmUrl: merges UTM params into a URL without duplicating existing ones.
 * Everything except htmlToBlocks/unpackStandaloneHtml is pure/dependency-free (no DOM) on
 * purpose, so it's trivially unit-testable. The other two need a real DOM/browser and only
 * ever run client-side when the user explicitly asks to convert/import — never during
 * compile/send.
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
      if (child.nodeType === 8) { node.removeChild(child); return; } // strip comment nodes —
      // Outlook-only markup is commonly hidden as <!--[if mso]>...VML...<![endif]--> and
      // would otherwise leak its literal (unparsed) contents straight into the text block.
      if (child.nodeType !== 1) return; // text nodes pass through untouched
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

// Walks up the ancestor chain checking each element's own `style` attribute for
// display:none — catches the standard hidden-preheader pattern (a <div> wrapping the
// inbox-preview snippet text) without needing a live/attached document for getComputedStyle.
function isHiddenByInlineStyle(el) {
  for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
    if (/display\s*:\s*none/i.test(node.getAttribute("style") || "")) return true;
  }
  return false;
}

// Newsletter2Go/Outlook table templates pepper layout cells with invisible filler
// characters (soft hyphen, zero-width space/joiners) purely to control spacing — these
// must not count as "real" text or every such filler <td> becomes a spurious blank block.
const INVISIBLE_RE = /[\u00ad\u200b\u200c\u200d\ufeff]/g;
const hasRealText = (el) => el.textContent.replace(INVISIBLE_RE, "").trim().length > 0;

/**
 * Best-effort HTML -> blocks conversion for switching a legacy raw-HTML campaign into the
 * visual editor. Inherently heuristic — arbitrary email templates (nested tables, VML
 * button fallbacks, mso- conditional markup) can't be perfectly reconstructed as a
 * single-column block list. Extracts, in document order: images, button-like links,
 * and text — anything else (layout tables, spacer cells, the <style> block itself) is
 * dropped since none of it survives into the compiled output anyway. Returns a single
 * default text block if nothing recognizable was found.
 */
const BLOCK_LEVEL_SELECTOR = "p, div, td, th, li, h1, h2, h3, h4, table";

export function htmlToBlocks(html) {
  const doc = new DOMParser().parseFromString(html || "", "text/html");
  doc.querySelectorAll("style, script").forEach((el) => el.remove());

  const blocks = [];
  const seenImgSrc = new Set();
  const seenText = new Set();

  doc.body.querySelectorAll(`img, a, ${BLOCK_LEVEL_SELECTOR}`).forEach((el) => {
    // Skip anything sitting inside a display:none container — almost always the hidden
    // "preheader" trick (invisible text used only for the inbox preview snippet). Since
    // the compiler always renders text blocks visibly, importing it as-is would turn
    // previously-invisible content into a visible regression.
    if (isHiddenByInlineStyle(el)) return;
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
    // Text-bearing element. TABLE itself is never a text leaf (it's only in the selector so
    // the "does this have a nested block descendant" check below can see table boundaries).
    if (el.tagName === "TABLE") return;
    // DIV/TD/TH are common alternatives to <p> for paragraph text (Mailchimp classic,
    // hand-built table templates, ...) — only treat them as a leaf when they have no
    // nested block-level descendant, otherwise the ancestor would duplicate whatever its
    // descendant already contributes (e.g. a <td> wrapping a <p> should yield just the <p>).
    if (["DIV", "TD", "TH"].includes(el.tagName) && el.querySelector(BLOCK_LEVEL_SELECTOR)) return;
    if (el.closest("a") && looksLikeButton(el.closest("a"))) return; // it's a button's own label
    if (el.querySelector("img")) return; // pure image wrapper
    if ([...el.querySelectorAll("a")].some(looksLikeButton)) return; // wraps a button (+ its mso/VML fallback comments)
    if (!hasRealText(el)) return; // empty / spacer (e.g. <p><br></p>, "&nbsp;", soft-hyphen filler cells)
    const cleaned = cleanInlineHtml(el.innerHTML);
    if (!cleaned || seenText.has(cleaned)) return;
    seenText.add(cleaned);
    if (el.tagName === "LI") {
      blocks.push({ ...newBlock("text"), html: `<ul><li>${cleaned}</li></ul>` });
    } else {
      blocks.push({ ...newBlock("text"), html: `<p>${cleaned}</p>` }); // compiled output only supports <p>-level text
    }
  });

  return blocks.length ? blocks : [newBlock("text")];
}

// Fraction of a document's characters that live inside <script> tags — used to detect
// design-tool "standalone preview" bundles (real markup only exists after a script
// unpacks it in a real browser) as opposed to flat, ready-to-send HTML.
export function scriptRatio(html) {
  const text = html || "";
  if (!text.length) return 0;
  const scriptChars = [...text.matchAll(/<script[\s\S]*?<\/script>/gi)].reduce((s, m) => s + m[0].length, 0);
  return scriptChars / text.length;
}
export const LOOKS_LIKE_BUNDLE = (html) => (html || "").length > 2000 && scriptRatio(html) > 0.5;

/**
 * Runs a self-executing HTML "bundle" (script-heavy design-tool export) inside a fully
 * sandboxed, off-screen iframe and captures the DOM it produces once it settles.
 *
 * Safety: `sandbox="allow-scripts"` with NO `allow-same-origin` puts the iframe's content
 * in a unique, opaque origin — it can run its own script, but cannot read/write our
 * cookies, localStorage or any of our DOM, cannot navigate the parent window, cannot open
 * popups, and any fetch() it makes carries none of our session credentials (it's a
 * different origin as far as the browser's same-origin credential rules are concerned).
 * The only channel out is postMessage, which we only accept from this exact iframe
 * instance (`event.source === iframe.contentWindow`). This is the same technique
 * CodePen/JSFiddle-style sandboxed previews use to run untrusted script safely.
 *
 * Detection of "done unpacking" is a generic heuristic (no bundler-specific hooks): a
 * MutationObserver on the whole document, considered settled once nothing has changed
 * for ~700ms after load, with a hard timeout so a bundle that never settles doesn't hang
 * the import forever.
 *
 * @returns {Promise<string|null>} the captured `documentElement.outerHTML`, or null on timeout/failure.
 */
export function unpackStandaloneHtml(rawHtml, { settleMs = 700, timeoutMs = 10000 } = {}) {
  return new Promise((resolve) => {
    const captureScript = `<script>(function(){
      var lastChange = Date.now();
      var obs = new MutationObserver(function(){ lastChange = Date.now(); });
      obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
      var start = Date.now();
      function tick() {
        var settled = Date.now() - lastChange > ${settleMs};
        var timedOut = Date.now() - start > ${timeoutMs - 500};
        if (settled || timedOut) {
          obs.disconnect();
          try { window.parent.postMessage({ __adsflowUnpack: true, html: document.documentElement.outerHTML, timedOut: timedOut && !settled }, "*"); }
          catch (e) {}
          return;
        }
        setTimeout(tick, 150);
      }
      if (document.readyState === "complete") setTimeout(tick, 300);
      else window.addEventListener("load", function () { setTimeout(tick, 300); });
    })();</script>`;

    const doc = rawHtml.includes("</body>")
      ? rawHtml.replace("</body>", captureScript + "</body>")
      : rawHtml + captureScript;

    const iframe = document.createElement("iframe");
    iframe.setAttribute("sandbox", "allow-scripts");
    iframe.style.cssText = "position:fixed;top:-9999px;left:-9999px;width:800px;height:600px;border:0;visibility:hidden;";

    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      window.removeEventListener("message", onMessage);
      clearTimeout(hardTimeout);
      if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
      resolve(result);
    };
    const onMessage = (e) => {
      if (e.source !== iframe.contentWindow || !e.data || !e.data.__adsflowUnpack) return;
      finish(e.data.timedOut ? null : e.data.html);
    };
    const hardTimeout = setTimeout(() => finish(null), timeoutMs);

    window.addEventListener("message", onMessage);
    iframe.srcdoc = doc;
    document.body.appendChild(iframe);
  });
}

// A bundler that lazy-loads images via URL.createObjectURL() leaves `blob:` src
// references in the unpacked DOM — these only resolve inside that exact (now-destroyed)
// document and are meaningless anywhere else, so they must be stripped rather than sent
// as-is (they'd just render as a broken image for every recipient). Blanking the src
// keeps the surrounding layout/alt-text intact so the gap is easy to spot and re-fill.
export function stripBlobUrls(html) {
  let count = 0;
  const cleaned = (html || "").replace(/\ssrc=(["'])blob:[^"']*\1/gi, () => { count += 1; return ' src=""'; });
  return { html: cleaned, strippedCount: count };
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
