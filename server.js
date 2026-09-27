"use strict";
const http = require("node:http");
const { readFile } = require("node:fs/promises");
const path = require("node:path");

const PORT = Number(process.env.PORT || 8765);
const CMC_URL = "https://pro-api.coinmarketcap.com/public-api/v3/index/cmc100-latest";
const CACHE_MS = 5 * 60 * 1000;
let cmcCache = null;
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
const server = http.createServer(async (req, res) => {
  if (req.method !== "GET") return send(res, 405, "application/json; charset=utf-8", JSON.stringify({ error: "GET only" }), { Allow: "GET" });
  const pathname = new URL(req.url, `http://${req.headers.host || "localhost"}`).pathname;
  if (pathname === "/api/health") return send(res, 200, "application/json; charset=utf-8", JSON.stringify({ ok: true, service: "penguin-volatility-local" }));
  if (pathname === "/api/cmc100") {
    try { return send(res, 200, "application/json; charset=utf-8", await cmc100()); }
    catch (error) {
      console.error("CMC100 proxy error:", error.message);
      return send(res, 502, "application/json; charset=utf-8", JSON.stringify({ error: "CMC100 data unavailable", detail: error.message }));
    }
  }
  if (pathname === "/favicon.ico") return send(res, 204, "image/x-icon", "");
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
server.listen(PORT, "127.0.0.1", () => console.log(`Penguin Volatility Lab listening at http://127.0.0.1:${PORT}`));
