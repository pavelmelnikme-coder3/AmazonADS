/**
 * Marketing-email provider selector. Keeps dispatch.js / routes provider-agnostic so
 * switching between Brevo (SMTP relay) and Amazon SES is a single env flip.
 *
 *   EMAIL_PROVIDER = brevo (default) | ses
 *
 * Both adapters expose the same surface: isConfigured() + sendBulkEmail(...).
 */
const brevo = require("./brevo");
const ses = require("./ses");

function active() {
  return (process.env.EMAIL_PROVIDER || "brevo").toLowerCase() === "ses" ? ses : brevo;
}

function name() {
  return (process.env.EMAIL_PROVIDER || "brevo").toLowerCase() === "ses" ? "ses" : "brevo";
}

module.exports = {
  name,
  isConfigured: (...a) => active().isConfigured(...a),
  sendBulkEmail: (...a) => active().sendBulkEmail(...a),
};
