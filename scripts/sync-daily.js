#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const CMC_URL = "https://pro-api.coinmarketcap.com/public-api/v3/index/cmc100-latest";
const DATA_DIR = path.join(__dirname, "..", "data");
const OUTPUT_FILE = path.join(DATA_DIR, "cmc100.json");

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fetchWithRetry(url, maxAttempts = 4) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      console.log(`[${new Date().toISOString()}] Attempt ${attempt}/${maxAttempts} fetching ${url}...`);
      const response = await fetch(url, {
        headers: {
          accept: "application/json",
          "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
        },
        signal: controller.signal
      });
      clearTimeout(timer);
      if (response.ok) {
        return await response.json();
      }
      const err = new Error(`HTTP ${response.status}: ${response.statusText}`);
      if (response.status === 429 || response.status >= 500) {
        console.warn(`Rate limit / Server error (${response.status}), waiting before retry...`);
        lastError = err;
        await wait(attempt * 5000);
        continue;
      }
      throw err;
    } catch (err) {
      clearTimeout(timer);
      lastError = err;
      if (attempt < maxAttempts) {
        await wait(attempt * 4000);
      }
    }
  }
  throw lastError;
}

const FAPI_EXCHANGE_URL = "https://fapi.binance.com/fapi/v1/exchangeInfo";
const FUTURES_OUTPUT_FILE = path.join(DATA_DIR, "futures_exchange.json");

async function syncDaily() {
  const now = new Date();
  const thaiLabel = new Intl.DateTimeFormat("th-TH-u-ca-gregory", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(now) + " น. (เวลาไทย)";

  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  // 1. Sync CMC100 index
  try {
    const payload = await fetchWithRetry(CMC_URL);
    const constituents = payload?.data?.constituents;

    if (Array.isArray(constituents) && constituents.length === 100) {
      payload.synced_at = now.toISOString();
      payload.synced_by = "github-actions-daily-cron";
      payload.synced_label_th = thaiLabel;
      fs.writeFileSync(OUTPUT_FILE, JSON.stringify(payload, null, 2), "utf8");
      console.log(`✓ Successfully updated ${OUTPUT_FILE} (100 constituents)`);
    }
  } catch (error) {
    console.error(`✗ CMC100 fetch failed:`, error.message);
  }

  // 2. Sync Binance Futures exchangeInfo
  try {
    const fapiData = await fetchWithRetry(FAPI_EXCHANGE_URL);
    if (Array.isArray(fapiData?.symbols) && fapiData.symbols.length > 0) {
      fapiData.synced_at = now.toISOString();
      fapiData.synced_label_th = thaiLabel;
      fs.writeFileSync(FUTURES_OUTPUT_FILE, JSON.stringify(fapiData), "utf8");
      console.log(`✓ Successfully updated ${FUTURES_OUTPUT_FILE} (${fapiData.symbols.length} symbols)`);
    }
  } catch (error) {
    console.error(`✗ Binance Futures exchangeInfo fetch failed:`, error.message);
  }
}

syncDaily();
