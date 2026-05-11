"use strict";
// Shared constants for all integration tests

const PG_CONTAINER = "adsflow-integration-pg";
const PG_PORT      = 5433;
const TEST_DB_URL  = `postgresql://postgres:testpass@localhost:${PG_PORT}/adsflow_test`;

// Fixed UUIDs — deterministic across runs (valid UUID v4 format)
const IDS = {
  org:        "00000001-0000-4000-8000-000000000001",
  user:       "00000002-0000-4000-8000-000000000002",
  workspace:  "00000003-0000-4000-8000-000000000003",
  connection: "00000004-0000-4000-8000-000000000004",
  profile:    "00000005-0000-4000-8000-000000000005",
  campManual: "00000010-0000-4000-8000-000000000010",
  campAuto:   "00000011-0000-4000-8000-000000000011",
  agManual:   "00000020-0000-4000-8000-000000000020",
  agAuto:     "00000021-0000-4000-8000-000000000021",
  kwExact1:   "00000030-0000-4000-8000-000000000030",  // exact, enabled, bid=1.00
  kwPhrase1:  "00000031-0000-4000-8000-000000000031",  // phrase, enabled, bid=0.80
  kwBroad1:   "00000032-0000-4000-8000-000000000032",  // broad, enabled, bid=0.50
  kwPaused1:  "00000033-0000-4000-8000-000000000033",  // exact, paused, bid=1.00
  kwAuto1:    "00000034-0000-4000-8000-000000000034",  // in auto campaign, exact, enabled
  tgt1:       "00000040-0000-4000-8000-000000000040",  // enabled target
};

// Amazon IDs (TEXT) used in fact_metrics_daily
const AZ_IDS = {
  kwExact1:  "AZ-KW-EXACT-001",
  kwPhrase1: "AZ-KW-PHRASE-001",
  kwBroad1:  "AZ-KW-BROAD-001",
  kwPaused1: "AZ-KW-PAUSED-001",
  kwAuto1:   "AZ-KW-AUTO-001",
  tgt1:      "AZ-TGT-001",
};

module.exports = { PG_CONTAINER, PG_PORT, TEST_DB_URL, IDS, AZ_IDS };
