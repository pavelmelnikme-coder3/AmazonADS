"use strict";
// isScheduledDue — per-alert delivery schedule gate (e.g. Friday 08:00 Europe/Berlin weekly digest).
jest.mock("../src/db/pool", () => ({ query: jest.fn() }));
jest.mock("../src/config/logger", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock("../src/services/email", () => ({ sendAlertEmail: jest.fn(), sendProductMoversEmail: jest.fn() }));

const { isScheduledDue } = require("../src/services/alerts/evaluate");

// 2026-06-26 is a Friday. 08:30 Berlin (CEST = UTC+2) == 06:30 UTC.
const friday0830berlin = new Date("2026-06-26T06:30:00Z");
const friday0930berlin = new Date("2026-06-26T07:30:00Z"); // 09:30 Berlin
const thursday0830berlin = new Date("2026-06-25T06:30:00Z");
const sched = { weekday: 5, hour: 8, tz: "Europe/Berlin" };

describe("isScheduledDue", () => {
  test("no schedule → always due", () => {
    expect(isScheduledDue({ conditions: {} }, friday0930berlin)).toBe(true);
    expect(isScheduledDue({ conditions: null }, thursday0830berlin)).toBe(true);
  });
  test("fires only during the matching weekday+hour in tz", () => {
    expect(isScheduledDue({ conditions: { schedule: sched } }, friday0830berlin)).toBe(true);   // Fri 08:xx Berlin
    expect(isScheduledDue({ conditions: { schedule: sched } }, friday0930berlin)).toBe(false);  // Fri 09:xx
    expect(isScheduledDue({ conditions: { schedule: sched } }, thursday0830berlin)).toBe(false); // Thu 08:xx
  });
  test("tz matters — UTC schedule differs from Berlin", () => {
    // 06:30 UTC is 08:30 Berlin. A UTC-hour-8 schedule should NOT fire at 06:30 UTC.
    expect(isScheduledDue({ conditions: { schedule: { weekday: 5, hour: 8, tz: "UTC" } } }, friday0830berlin)).toBe(false);
  });
  test("bad timezone → does not block (fail-open)", () => {
    expect(isScheduledDue({ conditions: { schedule: { weekday: 5, hour: 8, tz: "Not/AZone" } } }, friday0930berlin)).toBe(true);
  });
});
