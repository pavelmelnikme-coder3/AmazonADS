/**
 * Parse an uploaded contacts file (.xlsx or .csv) into { email, first_name, last_name, attributes }
 * rows for email_contacts import. Column names vary a lot between CRM/list-manager exports
 * (EMAIL/E-Mail, VORNAME/First Name, NACHNAME/Last Name, ...), so columns are auto-detected
 * from the header row by regex rather than requiring an exact schema.
 */
const ExcelJS = require("exceljs");
const { Readable } = require("stream");

const EMAIL_RE = /e-?mail/i;
const FIRST_NAME_RE = /(vorname|first.?name|given.?name|prename)/i;
const LAST_NAME_RE = /(nachname|last.?name|surname|family.?name)/i;

// Cell values can be plain strings, numbers, Dates, or rich objects (hyperlinks, rich text,
// formula results) — Excel commonly stores email columns as `mailto:` hyperlink cells.
function cellText(v) {
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    if (v.text != null) return String(v.text);
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join("");
    if (v.result != null) return String(v.result);
    return "";
  }
  return String(v).trim();
}

// Auto-detect the field delimiter from the header line (European exports often use ';').
function detectDelimiter(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] || "";
  return [",", ";", "\t"].reduce((best, d) =>
    firstLine.split(d).length > firstLine.split(best).length ? d : best, ",");
}

async function loadWorksheet(buffer, filename) {
  const ext = (filename.split(".").pop() || "").toLowerCase();
  const workbook = new ExcelJS.Workbook();
  if (ext === "csv" || ext === "txt") {
    const text = buffer.toString("utf8");
    return workbook.csv.read(Readable.from(text), { parserOptions: { delimiter: detectDelimiter(text) } });
  }
  await workbook.xlsx.load(buffer);
  return workbook.worksheets[0];
}

/**
 * @returns {Promise<{ contacts: Array<{email,first_name,last_name,attributes}>, detected: {email,first_name,last_name} }>}
 */
async function parseContactsFile(buffer, filename) {
  const worksheet = await loadWorksheet(buffer, filename);
  if (!worksheet || worksheet.rowCount < 1) throw new Error("No data found in file");

  const headers = [];
  worksheet.getRow(1).eachCell({ includeEmpty: true }, (cell, colNumber) => {
    headers[colNumber] = cellText(cell.value);
  });

  let emailCol = null, firstNameCol = null, lastNameCol = null;
  for (let i = 1; i < headers.length; i++) {
    const h = headers[i];
    if (!h) continue;
    if (emailCol == null && EMAIL_RE.test(h)) emailCol = i;
    else if (firstNameCol == null && FIRST_NAME_RE.test(h)) firstNameCol = i;
    else if (lastNameCol == null && LAST_NAME_RE.test(h)) lastNameCol = i;
  }
  if (emailCol == null) throw new Error("Could not find an email column in the file header");

  const contacts = [];
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const email = cellText(row.getCell(emailCol).value).toLowerCase();
    if (!email) return;
    const attributes = {};
    for (let i = 1; i < headers.length; i++) {
      if (!headers[i] || i === emailCol || i === firstNameCol || i === lastNameCol) continue;
      const v = cellText(row.getCell(i).value);
      if (v) attributes[headers[i].toLowerCase().trim().replace(/\s+/g, "_")] = v;
    }
    contacts.push({
      email,
      first_name: firstNameCol ? cellText(row.getCell(firstNameCol).value) : "",
      last_name: lastNameCol ? cellText(row.getCell(lastNameCol).value) : "",
      attributes,
    });
  });

  return {
    contacts,
    detected: {
      email: headers[emailCol],
      first_name: firstNameCol ? headers[firstNameCol] : null,
      last_name: lastNameCol ? headers[lastNameCol] : null,
    },
  };
}

module.exports = { parseContactsFile };
