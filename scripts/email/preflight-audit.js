// Everything, end to end, inside the running container with the deployed code and env.
const fs = require("fs");
const crypto = require("crypto");
const http = require("http");
const https = require("https");
const { connectDB, query } = require("/app/src/db/pool");
const { renderHtmlForContact, applyMergeTags, contactFields } = require("/app/src/services/email/render");
const { classifyAddress } = require("/app/src/services/email/address");
const { resolveRecipientIds, DAILY_CAP } = require("/app/src/services/email/dispatch");

let failures = 0;
const check = (ok, label, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? "  — " + detail : ""}`);
};

const fetchStatus = (url) => new Promise((res) => {
  const lib = url.startsWith("https") ? https : http;
  const r = lib.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (x) => {
    x.resume(); res({ code: x.statusCode, len: x.headers["content-length"], type: x.headers["content-type"] });
  });
  r.on("error", (e) => res({ code: 0, err: e.message }));
  r.setTimeout(20000, () => { r.destroy(); res({ code: 0, err: "timeout" }); });
});

(async () => {
  await connectDB();
  const { rows: [c] } = await query("SELECT * FROM email_campaigns WHERE name='asian_b2b'");

  console.log("\n── 1. the campaign row ───────────────────────────────────────");
  check(c.status === "draft", "status is draft", c.status);
  check(c.recipients === 0 && c.sent === 0, "nothing queued or sent", `recipients=${c.recipients} sent=${c.sent}`);
  check(!!c.segment_id, "points at a segment (not 'all contacts')");
  const { rows: [{ n: sendRows }] } = await query(
    "SELECT COUNT(*)::int AS n FROM email_sends WHERE campaign_id=$1", [c.id]);
  check(sendRows === 0, "no send rows exist yet", String(sendRows));
  check(!!c.from_email && !!c.reply_to, "from and reply-to set", `${c.from_name} <${c.from_email}> reply→${c.reply_to}`);
  check(c.content_blocks === null, "stored as raw HTML, not block-editor JSON");

  console.log("\n── 2. the stored body is exactly the reviewed file ───────────");
  const local = fs.readFileSync("/tmp/campaign_new.html", "utf8");
  const sha = (x) => crypto.createHash("sha256").update(x, "utf8").digest("hex").slice(0, 16);
  check(sha(local) === sha(c.html_body), "DB body matches the file byte for byte",
    `${sha(local)} vs ${sha(c.html_body)}`);
  check(c.html_body.trim().endsWith("</html>"), "body is a complete document");

  console.log("\n── 3. the audience ──────────────────────────────────────────");
  const ids = await resolveRecipientIds(c);
  const { rows: contacts } = await query(
    "SELECT * FROM email_contacts WHERE id = ANY($1::uuid[])", [ids]);
  check(ids.length > 0, "audience resolves", `${ids.length} recipients`);
  const bad = contacts.filter((x) => !classifyAddress(x.email).ok);
  check(bad.length === 0, "every address passes the rules", bad.slice(0, 3).map((x) => x.email).join(", "));
  const noName = contacts.filter((x) => !x.first_name || !x.first_name.trim());
  check(noName.length === 0, "every contact has a name to merge", `${noName.length} without`);
  const dupes = contacts.length - new Set(contacts.map((x) => x.email.toLowerCase())).size;
  check(dupes === 0, "no duplicate addresses", String(dupes));
  console.log(`    at ${DAILY_CAP}/day this campaign takes ${Math.ceil(ids.length / DAILY_CAP)} days`);

  console.log("\n── 4. rendering, across the awkward cases ───────────────────");
  const pick = (pred, n = 1) => contacts.filter(pred).slice(0, n);
  const sample = [
    ...pick((x) => x.first_name.includes("&")),
    ...pick((x) => x.first_name.length > 34),
    ...pick((x) => x.first_name.length < 4),
    ...pick((x) => /[äöüßÄÖÜ]/.test(x.first_name)),
    ...contacts.slice(Math.floor(contacts.length / 2), Math.floor(contacts.length / 2) + 2),
  ];
  let firstHtml = null;
  for (const ct of sample) {
    const subject = applyMergeTags(c.subject || "", contactFields(ct), { escape: false });
    const html = renderHtmlForContact(c.html_body, ct, { campaignId: c.id });
    firstHtml = firstHtml || html;
    const low = html.toLowerCase();
    const bodyEnd = low.lastIndexOf("</body>");
    const ok =
      !/\{\{/.test(html) && !/\{\{/.test(subject) &&
      !/&amp;|&quot;|&lt;/.test(subject) &&
      subject.length <= 78 &&
      html.indexOf("/unsubscribe/" + ct.unsubscribe_token) > -1 &&
      html.indexOf("/unsubscribe/" + ct.unsubscribe_token) < bodyEnd &&
      html.includes("EVOCAMP – West &amp; East GmbH") &&
      html.indexOf("EVOCAMP – West &amp; East GmbH") < bodyEnd &&
      /Geschäftsadresse/.test(html) && !/angemeldet haben/.test(html) &&
      html.slice(low.lastIndexOf("</html>") + 7).trim() === "";
    check(ok, `${ct.email}`, `“${ct.first_name}” → ${subject.length} chars`);
    if (!ok) console.log(`      subject: ${subject}`);
  }

  console.log("\n── 5. the numbers in the mail ───────────────────────────────");
  for (const [label, needle] of [
    ["0,84 € (minimum order tier)", "0,84 €"], ["0,79 € (pallet)", "0,79 €"],
    ["0,67 € (full truck)", "0,67 €"], ["23,37 € per carton", "23,37 €"],
    ["9,40 € retail comparison", "9,40 €"],
    ["MOQ stated", "Mindestabnahme 20 Kartons (560 Stück)"],
    ["VAT + shipping stated", "inkl. gesetzlicher USt., zzgl. Versand"],
  ]) check(firstHtml.includes(needle), label);
  check(!firstHtml.includes("1,19 €"), "the old retail figure is gone");

  console.log("\n── 6. every link and image, fetched ─────────────────────────");
  const urls = [...new Set([
    ...[...firstHtml.matchAll(/href="([^"]+)"/g)].map((m) => m[1]),
    ...[...firstHtml.matchAll(/<img[^>]+src="([^"]+)"/g)].map((m) => m[1]),
  ])].map((u) => u.replace(/&amp;/g, "&"));
  let totalImg = 0;
  for (const u of urls) {
    if (u.startsWith("mailto:") || u.startsWith("tel:")) { console.log(`    n/a  ${u.slice(0, 70)}`); continue; }
    // NEVER fetch a real unsubscribe token: that endpoint unsubscribes on GET, by design — a
    // human clicking the link in a mail client sends a GET. An earlier run of this very script
    // fetched it "to check it returns 200" and unsubscribed a live contact. Swap in a token
    // that belongs to nobody, which exercises the same route and changes nothing.
    const safe = u.replace(/\/unsubscribe\/.+$/, "/unsubscribe/audit-does-not-exist");
    if (safe !== u) console.log("    (unsubscribe checked with a throwaway token, not a real one)");
    const r = await fetchStatus(safe);
    const isImg = /\/uploads\/images\//.test(u);
    if (isImg) totalImg += parseInt(r.len || 0, 10);
    check(r.code === 200, `HTTP ${r.code || r.err}  ${u.replace(/\?.*/, "").slice(0, 62)}`,
      isImg ? `${Math.round((r.len || 0) / 1024)} KB` : "");
  }
  const external = urls.filter((u) => /^https?:\/\/(?!159\.69)/.test(u));
  const noUtm = external.filter((u) => !/utm_source=.+utm_medium=.+utm_campaign=.+utm_content=/.test(u));
  check(noUtm.length === 0, `all ${external.length} external links carry full UTM`, noUtm.join(", "));
  const slots = external.map((u) => (u.match(/utm_content=([^&]+)/) || [])[1]);
  check(new Set(slots).size === slots.length, "every UTM slot is distinct", slots.join(", "));

  console.log("\n── 7. size ──────────────────────────────────────────────────");
  const kb = Buffer.byteLength(firstHtml, "utf8") / 1024;
  check(kb < 102, `rendered HTML ${kb.toFixed(1)} KB — under Gmail's 102 KB clipping limit`);
  check(totalImg / 1024 < 600, `images total ${(totalImg / 1024).toFixed(0)} KB`);

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error("FAILED:", e.message, e.stack); process.exit(1); });
