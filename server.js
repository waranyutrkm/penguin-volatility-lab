"use strict";
const http = require("node:http");
const { readFile } = require("node:fs/promises");
const path = require("node:path");

const PORT = Number(process.env.PORT || 8765);
const CMC_URL = "https://pro-api.coinmarketcap.com/public-api/v3/index/cmc100-latest";
const FAPI_BASE = "https://fapi.binance.com";
const CACHE_MS = 5 * 60 * 1000;
const FAPI_EXCHANGE_CACHE_MS = 15 * 60 * 1000;

let cmcCache = null;
let fapiExchangeCache = null;

const assets = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/research.js", ["research.js", "text/javascript; charset=utf-8"]]
]);

function send(res, status, type, body, headers = {}) {
  res.writeHead(status, { "Content-Type": type, "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store", ...headers });
  res.end(body);
}

async function cmc100() {
  if (cmcCache && Date.now() < cmcCache.expiresAt) return cmcCache.body;
  const response = await fetch(CMC_URL, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`CoinMarketCap HTTP ${response.status}`);
  const body = await response.text();
  const parsed = JSON.parse(body);
  if (!Array.isArray(parsed?.data?.constituents) || parsed.data.constituents.length !== 100) throw new Error("CoinMarketCap did not return 100 CMC100 constituents");
  cmcCache = { body, expiresAt: Date.now() + CACHE_MS };
  return body;
}

/* ─── Binance Futures API Proxy ─────────────────────────────── */

async function proxyFapi(pathname, query, res) {
  // Allowed sub-paths (whitelist for safety)
  const allowed = [
    "/fapi/v1/exchangeInfo",
    "/fapi/v1/klines",
    "/fapi/v1/ticker/24hr",
    "/fapi/v1/openInterest",
    "/fapi/v1/fundingRate",
    "/fapi/v1/premiumIndex",
    "/futures/data/openInterestHist",
    "/futures/data/topLongShortAccountRatio",
    "/futures/data/topLongShortPositionRatio",
    "/futures/data/globalLongShortAccountRatio",
    "/futures/data/takerlongshortRatio",
  ];

  // Extract the fapi path from our proxy path: /api/fapi/v1/klines → /fapi/v1/klines
  const fapiPath = pathname.replace(/^\/api/, "");
  if (!allowed.includes(fapiPath)) {
    return send(res, 403, "application/json; charset=utf-8", JSON.stringify({ error: "Endpoint not allowed", path: fapiPath }));
  }

  // Special cache for exchangeInfo (heavy payload, rarely changes)
  if (fapiPath === "/fapi/v1/exchangeInfo" && fapiExchangeCache && Date.now() < fapiExchangeCache.expiresAt) {
    return send(res, 200, "application/json; charset=utf-8", fapiExchangeCache.body, { "X-Cache": "HIT" });
  }

  const url = `${FAPI_BASE}${fapiPath}${query ? "?" + query : ""}`;
  const upstream = await fetch(url, {
    headers: { accept: "application/json", "User-Agent": "PenguinVolatilityLab/1.1" },
    signal: AbortSignal.timeout(30000),
  });

  if (!upstream.ok) {
    const errBody = await upstream.text().catch(() => "");
    return send(res, upstream.status, "application/json; charset=utf-8", errBody || JSON.stringify({ error: `Binance Futures HTTP ${upstream.status}` }));
  }

  const body = await upstream.text();

  // Cache exchangeInfo
  if (fapiPath === "/fapi/v1/exchangeInfo") {
    fapiExchangeCache = { body, expiresAt: Date.now() + FAPI_EXCHANGE_CACHE_MS };
  }

  return send(res, 200, "application/json; charset=utf-8", body, { "X-Cache": "MISS" });
}

/* ─── Data directory serving ────────────────────────────────── */

async function serveDataFile(pathname, res) {
  // Serve files from data/ directory (e.g., /data/cmc100.json)
  const safeName = path.basename(pathname);
  if (!/^[\w.-]+\.json$/.test(safeName)) {
    return send(res, 403, "text/plain; charset=utf-8", "Forbidden");
  }
  try {
    const body = await readFile(path.join(__dirname, "data", safeName));
    return send(res, 200, "application/json; charset=utf-8", body, { "Cache-Control": "max-age=300" });
  } catch {
    return send(res, 404, "text/plain; charset=utf-8", "Not found");
  }
}

/* ─── HTTP Server ───────────────────────────────────────────── */

const server = http.createServer(async (req, res) => {
  if (req.method !== "GET") return send(res, 405, "application/json; charset=utf-8", JSON.stringify({ error: "GET only" }), { Allow: "GET" });
  const parsed = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = parsed.pathname;

  // Health check
  if (pathname === "/api/health") return send(res, 200, "application/json; charset=utf-8", JSON.stringify({ ok: true, service: "penguin-volatility-lab", version: "1.1.0-futures" }));

  // CMC100 proxy
  if (pathname === "/api/cmc100") {
    try { return send(res, 200, "application/json; charset=utf-8", await cmc100()); }
    catch (error) {
      console.error("CMC100 proxy error:", error.message);
      return send(res, 502, "application/json; charset=utf-8", JSON.stringify({ error: "CMC100 data unavailable", detail: error.message }));
    }
  }

  // Binance Futures API proxy
  if (pathname.startsWith("/api/fapi/") || pathname.startsWith("/api/futures/")) {
    try { return await proxyFapi(pathname, parsed.searchParams.toString(), res); }
    catch (error) {
      console.error("FAPI proxy error:", error.message);
      return send(res, 502, "application/json; charset=utf-8", JSON.stringify({ error: "Binance Futures API unavailable", detail: error.message }));
    }
  }

  // Data directory
  if (pathname.startsWith("/data/")) {
    return await serveDataFile(pathname, res);
  }

  if (pathname === "/favicon.ico") return send(res, 204, "image/x-icon", "");

  // Static assets
  const asset = assets.get(pathname);
  if (!asset) return send(res, 404, "text/plain; charset=utf-8", "Not found");
  try {
    const body = await readFile(path.join(__dirname, asset[0]));
    return send(res, 200, asset[1], body, { "Cache-Control": "no-cache" });
  } catch (error) {
    console.error("Static file error:", error.message);
    return send(res, 500, "text/plain; charset=utf-8", "Local file unavailable");
  }
});
server.listen(PORT, "127.0.0.1", () => console.log(`Penguin Volatility Lab v1.1.0-futures listening at http://127.0.0.1:${PORT}`));
