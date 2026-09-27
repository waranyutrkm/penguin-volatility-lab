#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const CMC_URL = "https://pro-api.coinmarketcap.com/public-api/v3/index/cmc100-latest";
const DATA_DIR = path.join(__dirname, "..", "data");
const OUTPUT_FILE = path.join(DATA_DIR, "cmc100.json");

async function syncDaily() {
  console.log(`[${new Date().toISOString()}] Fetching fresh CMC100 data from: ${CMC_URL}`);
  
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);

  try {
    const response = await fetch(CMC_URL, {
      headers: {
        accept: "application/json",
        "user-agent": "PenguinVolatilityLab/1.0 (+https://github.com/waranyutrkm/penguin-volatility-lab)"
      },
      signal: controller.signal
    });

    clearTimeout(timer);

    if (!response.ok) {
      throw new Error(`CoinMarketCap HTTP ${response.status}: ${response.statusText}`);
    }

    const payload = await response.json();
    const constituents = payload?.data?.constituents;

    if (!Array.isArray(constituents) || constituents.length !== 100) {
      throw new Error(`Invalid constituents payload: expected 100, received ${constituents?.length ?? 0}`);
    }

    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    // Add metadata for sync tracking
    payload.synced_at = new Date().toISOString();
    payload.synced_by = "github-actions-daily-cron";

    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(payload, null, 2), "utf8");
    console.log(`✓ Successfully updated ${OUTPUT_FILE}`);
    console.log(`  Constituents: ${constituents.length}`);
    console.log(`  Index Last Update: ${payload.data.last_update}`);
    console.log(`  Local Sync Time: ${payload.synced_at}`);
  } catch (error) {
    clearTimeout(timer);
    console.error(`✗ Sync failed:`, error.message);
    process.exit(1);
  }
}

syncDaily();
