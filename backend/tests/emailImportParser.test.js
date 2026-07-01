"use strict";
/**
 * Contacts-file import parser — column auto-detection + row extraction for .csv/.xlsx.
 */
const ExcelJS = require("exceljs");
const { parseContactsFile } = require("../src/services/email/importParser");

describe("parseContactsFile — CSV", () => {
  test("auto-detects semicolon delimiter and EN/DE column names", async () => {
    const csv = "CONTACT_ID;EMAIL;NACHNAME;VORNAME;JOB_TITLE\n"
      + "1;a.boettger@example.com;Ernst;Anna;Manager\n"
      + "2;bad-email;Denk;Peter;\n"
      + "3;;Empty;Row;\n";
    const r = await parseContactsFile(Buffer.from(csv, "utf8"), "contacts.csv");
    expect(r.detected).toEqual({ email: "EMAIL", first_name: "VORNAME", last_name: "NACHNAME" });
    // the blank-email row is dropped; the invalid-looking address is still passed through
    // (validity is enforced by the caller, same as pasted-email import)
    expect(r.contacts).toEqual([
      { email: "a.boettger@example.com", first_name: "Anna", last_name: "Ernst", attributes: { contact_id: "1", job_title: "Manager" } },
      { email: "bad-email", first_name: "Peter", last_name: "Denk", attributes: { contact_id: "2" } },
    ]);
  });

  test("throws when no email column is found", async () => {
    await expect(parseContactsFile(Buffer.from("NAME,PHONE\nAnna,123\n"), "c.csv"))
      .rejects.toThrow(/email column/i);
  });
});

describe("parseContactsFile — XLSX", () => {
  test("reads hyperlink-style email cells and Date cells", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Sheet1");
    ws.addRow(["CONTACT_ID", "EMAIL", "NACHNAME", "VORNAME", "ADDED_TIME"]);
    const row = ws.addRow([24846, null, "Ernst-Barlach", "Anna", new Date("2026-02-23")]);
    row.getCell(2).value = { text: "a.boettger@example.com", hyperlink: "mailto:a.boettger@example.com" };
    const buf = await wb.xlsx.writeBuffer();

    const r = await parseContactsFile(Buffer.from(buf), "contacts.xlsx");
    expect(r.contacts).toEqual([{
      email: "a.boettger@example.com", first_name: "Anna", last_name: "Ernst-Barlach",
      attributes: { contact_id: "24846", added_time: "2026-02-23" },
    }]);
  });
});
