"use strict";
const E = window.PenguinResearch;
const CMC_API = "/api/cmc100";
const BINANCE_ROOT = "https://data-api.binance.vision/api/v3";
const DAY_MS = E.DAY_MS;
const INTERVALS = { "1d": DAY_MS, "4h": 4 * 3600000, "1h": 3600000 };
const records = new Map();
const fetchErrors = new Map();
let members = [];
let selectedId = null;
let scanBusy = false;
let sortDescending = true;
let priceRangeDays = 180;
let levelLoadBusy = false;
let activeTooltipTarget = null;
let backtestKey = "";
let backtestDone = false;
let cmcUpdated = null;
let exchangeInfoAt = null;

// Multi-select category filters
const filterCategories = {
  bbkc: new Set(["all"]),
  ema: new Set(["all"]),
  rsi: new Set(["all"]),
  spot: new Set(["all"]),
  tier: new Set(["all"])
};

const categoryLabels = {
  bbkc: {
    squeeze: "บีบตัว",
    release: "เพิ่ง Release",
    expand: "ขยายต่อ",
    cool: "เริ่มชะลอ",
    na: "รอสแกน"
  },
  ema: {
    bull: "EMA บวก",
    bear: "EMA ลบ",
    flat: "EMA กลาง",
    na: "รอสแกน"
  },
  rsi: {
    low: "RSI < 30",
    middle: "RSI 30–70",
    high: "RSI > 70",
    na: "รอสแกน"
  },
  spot: {
    available: "มีคู่ USDT",
    unavailable: "ไม่มีคู่ Spot"
  },
  tier: {
    S: "เกรด S",
    A: "เกรด A",
    B: "เกรด B",
    C: "เกรด C"
  }
};

const $ = id => document.getElementById(id);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const hint = text => `<button class="tip" type="button" aria-label="${esc(text)}" data-tip="${esc(text)}">i</button>`;
const fmt = (value, digits = 2, suffix = "") => value == null || !Number.isFinite(value) ? "—" : `${value.toFixed(digits)}${suffix}`;
const pct = (value, digits = 1) => value == null || !Number.isFinite(value) ? "—" : `${(value * 100).toFixed(digits)}%`;
const dateUTC = ms => ms ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "—";
const formatN = n => Number(n || 0).toLocaleString("en-US");
const formatPrice = value => Number.isFinite(value) ? Number(value).toLocaleString("en-US", { maximumSignificantDigits: 8 }) : "—";
const phaseOrder = { release: 0, expand: 1, squeeze: 2, cool: 3, na: 4 };

/* Theme Support */
function initTheme() {
  const saved = localStorage.getItem("pt_theme");
  const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  const theme = saved || (prefersDark ? "dark" : "dark");
  document.documentElement.setAttribute("data-theme", theme);
}
function toggleTheme() {
  const current = document.documentElement.getAttribute("data-theme") || "dark";
  const next = current === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem("pt_theme", next);
}

async function getJSON(url, label = "API") {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt++) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 25000);
    try {
      const response = await fetch(url, { signal: controller.signal, cache: "no-store" });
      clearTimeout(timer);
      if (response.ok) {
        const data = await response.json();
        if (data && data.status && Number(data.status.error_code) !== 0) throw new Error(data.status.error_message || `${label} error`);
        return data;
      }
      const error = new Error(`${label} HTTP ${response.status}`);
      if ([418, 429].includes(response.status) || response.status >= 500) {
        lastError = error; await wait(Math.min(500 * 2 ** attempt, 4000)); continue;
      }
      throw error;
    } catch (error) {
      clearTimeout(timer); lastError = error;
      if (attempt < 3 && (error.name === "AbortError" || error instanceof TypeError || /HTTP (418|429|5\d\d)/.test(error.message))) {
        await wait(Math.min(400 * 2 ** attempt, 3000)); continue;
      }
      if (attempt === 3) break;
      if (!(error.name === "AbortError" || error instanceof TypeError)) break;
    }
  }
  throw new Error(lastError?.name === "AbortError" ? `${label} timeout` : (lastError?.message || `${label} request failed`));
}

async function fetchBars(symbol, interval, wantedBars) {
  const intervalMs = INTERVALS[interval];
  const now = Date.now(), lastClosedOpen = Math.floor(now / intervalMs) * intervalMs - intervalMs;
  const start = Math.max(0, lastClosedOpen - (wantedBars - 1) * intervalMs);
  let cursor = start, all = [];
  while (cursor <= lastClosedOpen) {
    const end = Math.min(lastClosedOpen, cursor + 999 * intervalMs);
    const params = new URLSearchParams({ symbol, interval, startTime: String(cursor), endTime: String(end + intervalMs - 1), limit: "1000" });
    const raw = await getJSON(`${BINANCE_ROOT}/klines?${params}`, `Binance ${symbol}`);
    if (!Array.isArray(raw)) throw new Error(`${symbol}: Kline response is not an array`);
    if (!raw.length) { cursor = end + intervalMs; continue; }
    all.push(...raw.filter(row => Number(row[6]) < now));
    if (raw.length < 1000) { cursor = end + intervalMs; continue; }
    const next = Number(raw[raw.length - 1][0]) + intervalMs;
    if (next <= cursor) throw new Error(`${symbol}: Kline pagination did not advance`);
    cursor = next;
  }
  const unique = new Map();
  for (const row of all) unique.set(Number(row[0]), row);
  return [...unique.values()].sort((a, b) => Number(a[0]) - Number(b[0])).map(row => ({
    time: Number(row[0]), open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]),
    volume: Number(row[5]), closeTime: Number(row[6]), quoteVolume: Number(row[7])
  }));
}

function dailyBarsWanted() {
  const years = $("lookback").value;
  return years === "all" ? Math.ceil((Date.now() - Date.UTC(2017, 0, 1)) / DAY_MS) : Number(years) * 365 + 60;
}

function computeCoinScore(record) {
  if (!record || !record.dailyBars || record.dailyBars.length < 20) {
    return { totalScore: 0, gradeLetter: "C", gradeLabel: "C (ยังไม่สแกน)", tag: "[UNSCANNED]", tagClass: "neutral", breakdown: {} };
  }
  const i = record.dailyBars.length - 1;
  const bars = record.dailyBars;
  const daily = record.daily;
  let score = 0;
  const breakdown = {};

  const diff = daily.diff[i];
  const prevDiff = i > 0 ? daily.diff[i - 1] : null;
  const percentile = daily.percentile ? daily.percentile[i] : null;
  const rsi = daily.rsi ? daily.rsi[i] : null;
  const rsiSmooth = daily.rsiSmooth ? daily.rsiSmooth[i] : null;

  // Track expansion and squeeze duration (Lifespan from EDA)
  let expansionAge = 0;
  if (diff > 0) {
    for (let k = i; k >= 0; k--) {
      if (daily.diff[k] > 0) expansionAge++;
      else break;
    }
  }
  let squeezeAge = 0;
  if (diff <= 0) {
    for (let k = i; k >= 0; k--) {
      if (daily.diff[k] <= 0) squeezeAge++;
      else break;
    }
  }

  // 1. Volatility Regime & Lifespan Timing (Max 30 pts)
  // Ground truth: Expansions average 13.4 days. D1-5 has highest runaway; D13+ has high exhaustion risk.
  let regimePts = 0;
  if (diff > 0 && prevDiff != null && prevDiff <= 0) {
    regimePts = 30; // Fresh Release Day 1
    breakdown.regimeReason = "[FRESH RELEASE] D1 — Runway เฉลี่ย 13.4 วัน";
  } else if (diff > 0 && expansionAge <= 5 && prevDiff != null && diff > prevDiff) {
    regimePts = (rsi != null && rsiSmooth != null && rsi > rsiSmooth) ? 26 : 22;
    breakdown.regimeReason = `[EXPANDING] ต้นรอบขยายตัว (D${expansionAge}) + โมเมนตัมเร่ง`;
  } else if (diff <= 0 && percentile != null && percentile <= 0.20) {
    regimePts = 25; // Deep Squeeze (252D/365D Lookback: 8.10% Forward RV)
    breakdown.regimeReason = `[DEEP SQUEEZE] บีบตัวลึก ${(percentile * 100).toFixed(0)}% รอบปี — สะสมพลัง ${squeezeAge}D`;
  } else if (diff > 0 && expansionAge <= 12) {
    regimePts = 16;
    breakdown.regimeReason = `[MID EXPANSION] กลางรอบขยายตัว (D${expansionAge} ของรอบเฉลี่ย 13.4D)`;
  } else if (diff <= 0) {
    regimePts = 12;
    breakdown.regimeReason = `[SQUEEZE] บีบตัวสะสมพลัง ${squeezeAge}D`;
  } else if (diff > 0 && expansionAge > 12) {
    regimePts = 8;
    breakdown.regimeReason = `[EXTENDED] ขยายตัวนาน (D${expansionAge} เกินค่าเฉลี่ย 13.4D — ระวังแผ่วตัว)`;
  } else {
    regimePts = 5;
    breakdown.regimeReason = "[COOLING] แผ่วตัว / ชะลอความผันผวน";
  }
  breakdown.regime = regimePts;
  score += regimePts;

  // 2. Trend Confluence & Macro Breakout (Max 25 pts)
  // Ground truth: 30D-40D Breakout yielded PF 6.91 & WR 60.0% vs PF 0.91 for 10D/20D.
  let trendPts = 0;
  const isEmaBull = record.emaMomentum?.key === "bull";
  const spread = record.emaSpread ?? 0;
  if (isEmaBull) {
    trendPts += 10;
    if (spread >= 2.0) trendPts += 4;
    else if (spread >= 0.5) trendPts += 2;
  }

  // Check 40-Day and 20-Day Highs
  const lookback40 = Math.max(0, i - 40);
  const lookback20 = Math.max(0, i - 20);
  let high40 = -Infinity, high20 = -Infinity;
  for (let k = lookback40; k < i; k++) {
    if (bars[k].high > high40) high40 = bars[k].high;
    if (k >= lookback20 && bars[k].high > high20) high20 = bars[k].high;
  }
  const close = bars[i].close;

  if (close > high40 && high40 > 0) {
    trendPts += 11;
    breakdown.trendReason = "[BREAKOUT 40D] ทะลุ High 40 วัน (PF 6.91 ในผล Backtest)";
  } else if (high40 > 0 && close >= high40 * 0.98) {
    trendPts += 8;
    breakdown.trendReason = "[NEAR BREAKOUT] จ่อเบรก High 40 วัน (<2%)";
  } else if (close > high20 && high20 > 0) {
    trendPts += 5;
    breakdown.trendReason = "[BREAKOUT 20D] ทะลุ High 20 วัน";
  } else if (isEmaBull) {
    trendPts += 2;
    breakdown.trendReason = `[EMA BULL] Spread +${spread.toFixed(1)}%`;
  } else {
    breakdown.trendReason = `[EMA BEAR] Spread ${spread.toFixed(1)}% (เสี่ยง False Break)`;
  }
  breakdown.trend = trendPts;
  score += trendPts;

  // 3. Historical Statistical EDA Lift & Edge (Max 20 pts)
  let edaPts = 0;
  try {
    let study = record.eventCache?.get(5);
    if (!study) {
      study = E.eventStudy(record.dailyBars, record.daily, 5);
      record.eventCache.set(5, study);
    }
    const allSum = E.summarize(study.all);
    const releaseSum = E.summarize(study.release);
    const lift = (releaseSum.expansion != null && allSum.expansion != null) ? (releaseSum.expansion - allSum.expansion) : 0;
    const persistence = releaseSum.persistence ?? 0;

    if (lift >= 0.20) edaPts += 14;
    else if (lift >= 0.10) edaPts += 10;
    else if (lift >= 0.03) edaPts += 6;
    else if (lift >= 0) edaPts += 2;

    if (persistence >= 0.70) edaPts += 6;
    else if (persistence >= 0.50) edaPts += 4;
    else if (persistence >= 0.35) edaPts += 2;

    breakdown.edaLiftPp = lift;
    breakdown.edaPersistence = persistence;
    breakdown.edaReason = `EDA Lift +${(lift * 100).toFixed(0)}pp · ยืนระยะ ${(persistence * 100).toFixed(0)}%`;
  } catch (_) {
    edaPts = 4;
    breakdown.edaReason = "EDA ฐานข้อมูลสถิติ";
  }
  breakdown.eda = edaPts;
  score += edaPts;

  // 4. Structural S/R & Moving Average Health (Max 15 pts)
  let structPts = 0;
  const sma20 = bars.slice(Math.max(0, i - 19), i + 1).reduce((s, b) => s + b.close, 0) / Math.min(20, i + 1);
  if (close > sma20) structPts += 5;

  let low20 = Infinity;
  for (let k = lookback20; k < i; k++) {
    if (bars[k].low < low20) low20 = bars[k].low;
  }
  if (low20 > 0 && (close - low20) / low20 >= 0.05) structPts += 5;

  let aboveCount = 0;
  for (let k = Math.max(0, i - 4); k <= i; k++) {
    if (bars[k].close >= sma20) aboveCount++;
  }
  if (aboveCount >= 4) structPts += 5;
  else if (aboveCount >= 2) structPts += 2;

  breakdown.structural = structPts;
  score += structPts;

  // 5. Market Quality & Liquidity (Max 10 pts)
  let qualityPts = 0;
  if (record.member?.pair) qualityPts += 5;
  if (bars.length >= 365) qualityPts += 5;
  else if (bars.length >= 180) qualityPts += 3;
  else qualityPts += 1;

  breakdown.quality = qualityPts;
  score += qualityPts;

  const totalScore = Math.min(100, Math.max(0, Math.round(score)));
  let gradeLetter = "C", gradeLabel = "C (Neutral / Avoid)", tag = "[NEUTRAL]", tagClass = "neutral";

  if (totalScore >= 85) {
    gradeLetter = "S";
    gradeLabel = "S (Prime Setup)";
    if (diff > 0 && (close > high40 || close >= high40 * 0.98)) {
      tag = "[ALPHA BUY]";
      tagClass = "alpha-buy";
    } else {
      tag = "[PRIME COIL]";
      tagClass = "prime-coil";
    }
  } else if (totalScore >= 70) {
    gradeLetter = "A";
    gradeLabel = "A (High Quality)";
    if (diff > 0) {
      tag = "[EXPANDING]";
      tagClass = "expanding";
    } else {
      tag = "[COIL A+]";
      tagClass = "coil-a";
    }
  } else if (totalScore >= 55) {
    gradeLetter = "B";
    gradeLabel = "B (Watchlist)";
    tag = "[WATCHLIST]";
    tagClass = "watchlist";
  } else {
    gradeLetter = "C";
    gradeLabel = "C (Neutral / Avoid)";
    if (!isEmaBull && diff > 0) {
      tag = "[BEAR TRAP]";
      tagClass = "bear-trap";
    } else {
      tag = "[NEUTRAL]";
      tagClass = "neutral";
    }
  }

  return { totalScore, gradeLetter, gradeLabel, tag, tagClass, breakdown };
}

function createRecord(member, dailyBars) {
  const daily = E.computeIndicators(dailyBars, DAY_MS), i = dailyBars.length - 1;
  const previous = i > 0 ? daily.diff[i - 1] : null;
  const phase = E.classify(daily.diff[i], previous);
  const ema12 = daily.ema12[i], ema26 = daily.ema26[i];
  const emaSpread = Number.isFinite(ema12) && Number.isFinite(ema26) && ema26 !== 0 ? (ema12 / ema26 - 1) * 100 : null;
  const emaMomentum = E.classifyEma(ema12, ema26);
  const ret20 = i >= 20 && daily.segment[i] === daily.segment[i - 20] ? (dailyBars[i].close / dailyBars[i - 20].close - 1) * 100 : null;
  const delta3 = i >= 3 && daily.diff[i] != null && daily.diff[i - 3] != null && daily.segment[i] === daily.segment[i - 3] ? daily.diff[i] - daily.diff[i - 3] : null;
  const record = { member, dailyBars, daily, phase, emaMomentum, emaSpread, ret20, delta3, bars4h: null, short: null, gaps4h: null, eventCache: new Map(), levelStudies: new Map(), backtests: null, asof: dailyBars[i]?.closeTime || null };
  record.quantScore = computeCoinScore(record);
  return record;
}

async function fetchCmcConstituents() {
  // 1. First attempt: local server / serverless proxy endpoint
  try {
    const data = await getJSON(CMC_API, "CMC100 API Proxy");
    if (Array.isArray(data?.data?.constituents) && data.data.constituents.length === 100) {
      return data;
    }
  } catch (err) {
    console.info("CMC proxy /api/cmc100 not reachable, attempting static snapshot...", err.message);
  }

  // 2. Second attempt: static daily snapshot (for GitHub Pages / static hosting)
  try {
    const staticUrl = new URL("data/cmc100.json", window.location.href).href;
    const data = await getJSON(staticUrl, "CMC100 Daily Snapshot");
    if (Array.isArray(data?.data?.constituents) && data.data.constituents.length === 100) {
      return data;
    }
  } catch (err) {
    console.warn("Static data snapshot failed:", err.message);
  }

  throw new Error("ไม่สามารถโหลดรายชื่อสมาชิก CMC100 ได้จากทั้ง Proxy และ Snapshot");
}

async function loadUniverse() {
  setStatus("กำลังโหลดรายชื่อ CMC100 และคู่ Spot ที่เทรดได้…");
  $("refreshUniverseBtn").disabled = true;
  try {
    const [cmc, exchange] = await Promise.all([
      fetchCmcConstituents(),
      getJSON(`${BINANCE_ROOT}/exchangeInfo`, "Binance exchangeInfo")
    ]);
    const constituents = cmc?.data?.constituents;
    if (!Array.isArray(constituents) || constituents.length !== 100) throw new Error(`CMC100 ส่งสมาชิก ${constituents?.length ?? 0} รายการ (ต้องเป็น 100)`);
    if (!Array.isArray(exchange?.symbols)) throw new Error("Binance exchangeInfo รูปแบบไม่ถูกต้อง");
    const pairs = new Map();
    for (const pair of exchange.symbols) {
      if (pair.status !== "TRADING" || pair.quoteAsset !== "USDT" || pair.isSpotTradingAllowed === false) continue;
      const base = String(pair.baseAsset).toUpperCase();
      if (!pairs.has(base)) pairs.set(base, []);
      pairs.get(base).push(pair.symbol);
    }
    members = constituents.map(c => ({
      id: String(c.id), cmcId: Number(c.id), name: String(c.name), symbol: String(c.symbol),
      weight: Number(c.weight), url: String(c.url || ""), pair: (pairs.get(String(c.symbol).toUpperCase()) || []).sort()[0] || null
    })).sort((a, b) => b.weight - a.weight);
    cmcUpdated = cmc.data.last_update || cmc.status?.timestamp || cmc.synced_at || null;
    exchangeInfoAt = Date.now();
    records.clear(); fetchErrors.clear(); backtestDone = false; backtestKey = ""; selectedId = null;
    $("exportTradesBtn").disabled = true;
    $("syncStamp").textContent = `CMC100 อัปเดต ${dateUTC(cmcUpdated ? Date.parse(cmcUpdated) : null)}`;
    $("universeStamp").textContent = `CMC100 · ${formatN(members.length)} constituents · source refresh ${dateUTC(cmcUpdated ? Date.parse(cmcUpdated) : null)}`;
    setStatus(`โหลด CMC100 สำเร็จ · มี Binance Spot USDT ${members.filter(x => x.pair).length}/100 เหรียญ`);
    $("exportBtn").disabled = false;
    renderUniverse(); renderSummary(); renderSelectedPlaceholder();
  } catch (error) {
    setStatus(`โหลด Universe ไม่สำเร็จ: ${error.message}`);
    $("universeStamp").textContent = "ยังโหลดรายชื่อ CMC100 ไม่สำเร็จ";
    $("coinRows").innerHTML = `<tr><td colspan="10" class="empty error">${esc(error.message)}</td></tr>`;
  } finally { $("refreshUniverseBtn").disabled = false; }
}

function setStatus(text) { $("runStatus").textContent = text; }

function renderSummary() {
  const available = members.filter(m => m.pair).length;
  const scanned = records.size;
  const phases = [...records.values()].map(r => r.phase.key);
  $("mUniverse").textContent = members.length ? String(members.length) : "—";
  $("mCoverage").textContent = members.length ? `${available}/100` : "—";
  $("mScanned").textContent = members.length ? `${scanned}/${available}` : "—";
  $("mRelease").textContent = String(phases.filter(x => x === "release").length);
  $("mExpand").textContent = String(phases.filter(x => x === "expand").length);
  $("coverageBar").style.width = `${available ? scanned / available * 100 : 0}%`;
  $("coverageText").textContent = `สแกนแล้ว ${scanned} จาก ${available} คู่ Spot ที่มีใน CMC100`;
  renderMarketBreadth();
}

function renderMarketBreadth() {
  const panel = $("marketBreadthPanel");
  if (!panel) return;
  const scannedRecords = [...records.values()];
  const n = scannedRecords.length;
  if (!n) {
    if ($("breadthRegimeBadge")) $("breadthRegimeBadge").className = "breadth-status-badge waiting";
    if ($("breadthRegimeText")) $("breadthRegimeText").textContent = "รอผลสแกนตลาด (กด 'สแกนคู่ที่ใช้ได้')";
    if ($("breadthBullPct")) { $("breadthBullPct").textContent = "—%"; $("breadthBullPct").className = "breadth-num bull"; }
    if ($("splitBullBar")) $("splitBullBar").style.width = "50%";
    if ($("splitBearBar")) $("splitBearBar").style.width = "50%";
    if ($("breadthBullCount")) $("breadthBullCount").textContent = "▲ Bull: —";
    if ($("breadthBearCount")) $("breadthBearCount").textContent = "▼ Bear: —";
    if ($("breadthSqueezePct")) $("breadthSqueezePct").textContent = "—%";
    if ($("splitSqueezeBar")) $("splitSqueezeBar").style.width = "34%";
    if ($("splitActiveBar")) $("splitActiveBar").style.width = "33%";
    if ($("splitCoolBar")) $("splitCoolBar").style.width = "33%";
    if ($("breadthSqueezeCount")) $("breadthSqueezeCount").textContent = "● Squeeze: —";
    if ($("breadthActiveCount")) $("breadthActiveCount").textContent = "▲ Active: —";
    if ($("breadthCoolCount")) $("breadthCoolCount").textContent = "▼ Cool: —";
    if ($("tierCountS")) $("tierCountS").textContent = "0";
    if ($("tierCountA")) $("tierCountA").textContent = "0";
    if ($("tierCountB")) $("tierCountB").textContent = "0";
    if ($("tierCountC")) $("tierCountC").textContent = "0";
    if ($("breadthActionNote")) $("breadthActionNote").textContent = "กดสแกนคู่ที่ใช้ได้เพื่อประเมิน Market Breadth และ Quant Score ครบทุกคู่";
    return;
  }

  // 1. Trend Momentum Breadth (EMA Bull vs Bear)
  const bullCount = scannedRecords.filter(r => r.emaMomentum?.key === "bull").length;
  const bearCount = scannedRecords.filter(r => r.emaMomentum?.key === "bear").length;
  const bullPct = (bullCount / n) * 100;
  const bearPct = (bearCount / n) * 100;

  if ($("breadthBullPct")) {
    $("breadthBullPct").textContent = `${bullPct.toFixed(0)}%`;
    $("breadthBullPct").className = `breadth-num ${bullPct >= 50 ? "bull" : "bear"}`;
  }
  if ($("splitBullBar")) $("splitBullBar").style.width = `${bullPct.toFixed(1)}%`;
  if ($("splitBearBar")) $("splitBearBar").style.width = `${(100 - bullPct).toFixed(1)}%`;
  if ($("breadthBullCount")) $("breadthBullCount").textContent = `▲ Bull: ${bullCount} (${bullPct.toFixed(0)}%)`;
  if ($("breadthBearCount")) $("breadthBearCount").textContent = `▼ Bear: ${bearCount} (${bearPct.toFixed(0)}%)`;

  // 2. Volatility Regime Breadth
  const squeezeCount = scannedRecords.filter(r => r.phase?.key === "squeeze").length;
  const releaseCount = scannedRecords.filter(r => r.phase?.key === "release").length;
  const expandCount = scannedRecords.filter(r => r.phase?.key === "expand").length;
  const coolCount = scannedRecords.filter(r => r.phase?.key === "cool").length;
  const activeCount = releaseCount + expandCount;

  const squeezePct = (squeezeCount / n) * 100;
  const activePct = (activeCount / n) * 100;
  const coolPct = (coolCount / n) * 100;

  if ($("breadthSqueezePct")) $("breadthSqueezePct").textContent = `${squeezePct.toFixed(0)}%`;
  if ($("splitSqueezeBar")) $("splitSqueezeBar").style.width = `${squeezePct.toFixed(1)}%`;
  if ($("splitActiveBar")) $("splitActiveBar").style.width = `${activePct.toFixed(1)}%`;
  if ($("splitCoolBar")) $("splitCoolBar").style.width = `${coolPct.toFixed(1)}%`;
  if ($("breadthSqueezeCount")) $("breadthSqueezeCount").textContent = `● Squeeze: ${squeezeCount}`;
  if ($("breadthActiveCount")) $("breadthActiveCount").textContent = `▲ Active: ${activeCount}`;
  if ($("breadthCoolCount")) $("breadthCoolCount").textContent = `▼ Cool: ${coolCount}`;

  // 3. Score Tiers
  let sCount = 0, aCount = 0, bCount = 0, cCount = 0;
  scannedRecords.forEach(r => {
    const grade = r.quantScore?.gradeLetter || "C";
    if (grade === "S") sCount++;
    else if (grade === "A") aCount++;
    else if (grade === "B") bCount++;
    else cCount++;
  });
  if ($("tierCountS")) $("tierCountS").textContent = String(sCount);
  if ($("tierCountA")) $("tierCountA").textContent = String(aCount);
  if ($("tierCountB")) $("tierCountB").textContent = String(bCount);
  if ($("tierCountC")) $("tierCountC").textContent = String(cCount);

  // 4. Macro Regime Determination
  const badge = $("breadthRegimeBadge");
  const note = $("breadthActionNote");
  if (badge) {
    if (bullPct >= 55) {
      badge.className = "breadth-status-badge risk-on";
      if ($("breadthRegimeText")) $("breadthRegimeText").textContent = `[RISK-ON] ตลาดกระทิงนำ (Bull Breadth ${bullPct.toFixed(0)}%)`;
      if (note) note.innerHTML = `<b style="color:var(--teal)">สภาวะหนุน Long Breakout:</b> ตลาดส่วนใหญ่เกาะขาขึ้น สัญญาณ Release &amp; Active Expansion มีอัตราสำเร็จสูง เหมาะกับการ Follow Trend`;
    } else if (bullPct >= 40) {
      badge.className = "breadth-status-badge neutral";
      if ($("breadthRegimeText")) $("breadthRegimeText").textContent = `[NEUTRAL] ตลาดไซด์เวย์/คัดเลือกเฉพาะตัว (Bull Breadth ${bullPct.toFixed(0)}%)`;
      if (note) note.innerHTML = `<b style="color:var(--amber)">เลือกเทรดเฉพาะตัวท็อป:</b> ตลาดก้ำกึ่ง ควรเน้นเหรียญเกรด <b>S &amp; A</b> ที่มี Squeeze ชัดเจน หลีกเลี่ยงเหรียญเกรด B/C`;
    } else {
      badge.className = "breadth-status-badge risk-off";
      if ($("breadthRegimeText")) $("breadthRegimeText").textContent = `[RISK-OFF] แรงกดดันขาลงสูง (Bull Breadth ${bullPct.toFixed(0)}%)`;
      if (note) note.innerHTML = `<b style="color:var(--red)">ระวัง False Breakout:</b> ตลาดส่วนใหญ่เป็นขาลง มีความเสี่ยงถูกเทขายใส่สูง ควรเน้นเฝ้ารอ (Watchlist) หรือสะสม Deep Squeeze`;
    }
  }
}

function updateSortIndicators() {
  document.querySelectorAll(".scanner th[data-sort]").forEach(th => {
    const button = th.querySelector(".sort-btn"), active = button?.dataset.sort === $("sortBy").value;
    th.setAttribute("aria-sort", active ? (sortDescending ? "descending" : "ascending") : "none");
    const mark = button?.querySelector(".sort-indicator");
    if (mark) mark.textContent = active ? (sortDescending ? "↓" : "↑") : "↕";
    if (button) {
      button.setAttribute("aria-pressed", String(Boolean(active)));
      button.setAttribute("aria-label", `${button.dataset.label}: ${active ? (sortDescending ? "มากไปน้อย" : "น้อยไปมาก") : "คลิกเพื่อเรียงจากมากไปน้อย"}`);
    }
  });
}

function updateCategoryUI() {
  for (const cat of ["bbkc", "ema", "rsi", "spot", "tier"]) {
    const set = filterCategories[cat];
    const chips = document.querySelectorAll(`#chips-${cat} .filter-chip`);
    chips.forEach(chip => {
      const val = chip.dataset.val;
      if (val === "all") chip.classList.toggle("active", set.has("all"));
      else chip.classList.toggle("active", set.has(val));
    });

    const badge = $(`badge-${cat}`);
    if (badge) {
      if (set.has("all")) {
        badge.textContent = "ทั้งหมด";
        badge.classList.remove("has-filter");
      } else {
        badge.textContent = `เลือก ${set.size}`;
        badge.classList.add("has-filter");
      }
    }
  }

  // Update combo buttons active state
  const isAll = filterCategories.bbkc.has("all") && filterCategories.ema.has("all") && filterCategories.rsi.has("all") && filterCategories.spot.has("all") && filterCategories.tier.has("all");
  document.querySelectorAll("#combosList .combo-btn").forEach(btn => {
    const combo = btn.dataset.combo;
    if (combo === "all") btn.classList.toggle("active", isAll);
    else if (combo === "alpha") btn.classList.toggle("active", filterCategories.tier.size === 2 && filterCategories.tier.has("S") && filterCategories.tier.has("A") && filterCategories.spot.size === 1 && filterCategories.spot.has("available") && filterCategories.bbkc.has("all") && filterCategories.ema.has("all") && filterCategories.rsi.has("all"));
    else if (combo === "prime") btn.classList.toggle("active", filterCategories.tier.size === 2 && filterCategories.tier.has("S") && filterCategories.tier.has("A") && filterCategories.bbkc.has("all") && filterCategories.ema.has("all") && filterCategories.spot.has("all"));
    else if (combo === "marketBreadthLead") btn.classList.toggle("active", filterCategories.tier.size === 2 && filterCategories.tier.has("S") && filterCategories.tier.has("A") && filterCategories.ema.size === 1 && filterCategories.ema.has("bull") && filterCategories.spot.has("available"));
    else if (combo === "squeeze") btn.classList.toggle("active", filterCategories.bbkc.size === 1 && filterCategories.bbkc.has("squeeze") && filterCategories.ema.has("all") && filterCategories.rsi.has("all"));
    else if (combo === "release") btn.classList.toggle("active", filterCategories.bbkc.size === 1 && filterCategories.bbkc.has("release") && filterCategories.ema.has("all") && filterCategories.rsi.has("all"));
    else if (combo === "activeExp") btn.classList.toggle("active", filterCategories.bbkc.size === 2 && filterCategories.bbkc.has("release") && filterCategories.bbkc.has("expand") && filterCategories.ema.has("all") && filterCategories.rsi.has("all"));
    else if (combo === "squeezeBull") btn.classList.toggle("active", filterCategories.bbkc.size === 1 && filterCategories.bbkc.has("squeeze") && filterCategories.ema.size === 1 && filterCategories.ema.has("bull") && filterCategories.rsi.has("all"));
    else if (combo === "bullExp") btn.classList.toggle("active", filterCategories.bbkc.size === 2 && filterCategories.bbkc.has("release") && filterCategories.bbkc.has("expand") && filterCategories.ema.size === 1 && filterCategories.ema.has("bull"));
    else if (combo === "extremes") btn.classList.toggle("active", filterCategories.rsi.size === 2 && filterCategories.rsi.has("low") && filterCategories.rsi.has("high") && filterCategories.bbkc.has("all") && filterCategories.ema.has("all"));
  });
}

function toggleCategoryFilter(cat, val) {
  const set = filterCategories[cat];
  if (!set) return;

  if (val === "all") {
    set.clear();
    set.add("all");
  } else {
    set.delete("all");
    if (set.has(val)) {
      set.delete(val);
    } else {
      set.add(val);
    }
    if (set.size === 0) {
      set.add("all");
    }
  }

  // Update hidden select elements for backward compatibility
  const selectMap = { bbkc: "bbkcFilter", ema: "emaFilter", rsi: "rsiFilter", spot: "universeFilter" };
  const sel = $(selectMap[cat]);
  if (sel) {
    if (set.has("all") || set.size > 1) sel.value = "all";
    else sel.value = [...set][0];
  }

  updateCategoryUI();
  renderUniverse();
}

function renderUniverse() {
  if (!members.length) return;
  const q = $("coinSearch").value.trim().toLowerCase();
  const sort = $("sortBy").value;

  const minDiffVal = $("minDiff")?.value !== "" && !isNaN(parseFloat($("minDiff")?.value)) ? parseFloat($("minDiff").value) : null;
  const maxDiffVal = $("maxDiff")?.value !== "" && !isNaN(parseFloat($("maxDiff")?.value)) ? parseFloat($("maxDiff").value) : null;
  const minEmaVal = $("minEma")?.value !== "" && !isNaN(parseFloat($("minEma")?.value)) ? parseFloat($("minEma").value) : null;
  const maxEmaVal = $("maxEma")?.value !== "" && !isNaN(parseFloat($("maxEma")?.value)) ? parseFloat($("maxEma").value) : null;
  const minRsiVal = $("minRsi")?.value !== "" && !isNaN(parseFloat($("minRsi")?.value)) ? parseFloat($("minRsi").value) : null;
  const maxRsiVal = $("maxRsi")?.value !== "" && !isNaN(parseFloat($("maxRsi")?.value)) ? parseFloat($("maxRsi").value) : null;

  let visible = members.filter(m => {
    const r = records.get(m.id);
    const phase = r?.phase?.key || "na";
    const ema = r?.emaMomentum?.key || "na";
    const d = r?.daily.diff.at(-1);
    const rsi = r?.daily.rsi.at(-1);

    // 1. Search Query
    if (q && !`${m.name} ${m.symbol} ${m.pair || ""}`.toLowerCase().includes(q)) return false;

    // 2. Spot Coverage (Category 4)
    if (!filterCategories.spot.has("all")) {
      const isAvail = Boolean(m.pair);
      let passSpot = false;
      if (isAvail && filterCategories.spot.has("available")) passSpot = true;
      if (!isAvail && filterCategories.spot.has("unavailable")) passSpot = true;
      if (!passSpot) return false;
    }

    // 3. BB/KC Regime (Category 1: OR inside category)
    if (!filterCategories.bbkc.has("all")) {
      if (!filterCategories.bbkc.has(phase)) return false;
    }

    // 4. EMA Momentum (Category 2: OR inside category)
    if (!filterCategories.ema.has("all")) {
      if (!filterCategories.ema.has(ema)) return false;
    }

    // 5. RSI(diff) (Category 3: OR inside category)
    if (!filterCategories.rsi.has("all")) {
      let passRsi = false;
      if (!Number.isFinite(rsi) && filterCategories.rsi.has("na")) passRsi = true;
      else if (Number.isFinite(rsi)) {
        if (rsi < 30 && filterCategories.rsi.has("low")) passRsi = true;
        if (rsi >= 30 && rsi <= 70 && filterCategories.rsi.has("middle")) passRsi = true;
        if (rsi > 70 && filterCategories.rsi.has("high")) passRsi = true;
      }
      if (!passRsi) return false;
    }

    // 6. Quant Score Tier (Category 5: OR inside category)
    if (!filterCategories.tier.has("all")) {
      const gl = r?.quantScore?.gradeLetter || "C";
      if (!filterCategories.tier.has(gl)) return false;
    }

    // 7. Advanced Numeric Range Filters
    if (minDiffVal !== null && !(Number.isFinite(d) && d >= minDiffVal)) return false;
    if (maxDiffVal !== null && !(Number.isFinite(d) && d <= maxDiffVal)) return false;
    if (minEmaVal !== null && !(Number.isFinite(r?.emaSpread) && r.emaSpread >= minEmaVal)) return false;
    if (maxEmaVal !== null && !(Number.isFinite(r?.emaSpread) && r.emaSpread <= maxEmaVal)) return false;
    if (minRsiVal !== null && !(Number.isFinite(rsi) && rsi >= minRsiVal)) return false;
    if (maxRsiVal !== null && !(Number.isFinite(rsi) && rsi <= maxRsiVal)) return false;

    return true;
  });

  // Build descriptive active filters summary
  const activeTags = [];
  if (q) activeTags.push(`ค้นหา: "${q}"`);
  if (!filterCategories.spot.has("all")) {
    const labels = [...filterCategories.spot].map(k => categoryLabels.spot[k] || k).join(", ");
    activeTags.push(`Spot: [${labels}]`);
  }
  if (!filterCategories.bbkc.has("all")) {
    const labels = [...filterCategories.bbkc].map(k => categoryLabels.bbkc[k] || k).join(", ");
    activeTags.push(`BB/KC: [${labels}]`);
  }
  if (!filterCategories.ema.has("all")) {
    const labels = [...filterCategories.ema].map(k => categoryLabels.ema[k] || k).join(", ");
    activeTags.push(`EMA: [${labels}]`);
  }
  if (!filterCategories.rsi.has("all")) {
    const labels = [...filterCategories.rsi].map(k => categoryLabels.rsi[k] || k).join(", ");
    activeTags.push(`RSI: [${labels}]`);
  }
  if (!filterCategories.tier.has("all")) {
    const labels = [...filterCategories.tier].map(k => categoryLabels.tier[k] || k).join(", ");
    activeTags.push(`เกรด: [${labels}]`);
  }
  if (minDiffVal !== null) activeTags.push(`diff ≥ ${minDiffVal}%`);
  if (maxDiffVal !== null) activeTags.push(`diff ≤ ${maxDiffVal}%`);
  if (minEmaVal !== null) activeTags.push(`EMA spread ≥ ${minEmaVal}%`);
  if (maxEmaVal !== null) activeTags.push(`EMA spread ≤ ${maxEmaVal}%`);
  if (minRsiVal !== null) activeTags.push(`RSI ≥ ${minRsiVal}`);
  if (maxRsiVal !== null) activeTags.push(`RSI ≤ ${maxRsiVal}`);

  $("filterSummary").textContent = `${visible.length}/${members.length} เหรียญ${activeTags.length ? ` · ${activeTags.join(" · ")}` : " · ไม่ได้กรอง"}`;

  const valueFor = member => {
    const r = records.get(member.id);
    if (sort === "score") return r?.quantScore?.totalScore;
    if (sort === "weight") return member.weight;
    if (sort === "ema") return r?.emaSpread;
    if (sort === "diff") return r?.daily.diff.at(-1);
    if (sort === "rsi") return r?.daily.rsi.at(-1);
    if (sort === "bars") return r?.dailyBars.length;
    return null;
  };
  if (sort === "phase") visible.sort((a, b) => (phaseOrder[records.get(a.id)?.phase.key || "na"] - phaseOrder[records.get(b.id)?.phase.key || "na"]) || b.weight - a.weight);
  else visible.sort((a, b) => {
    const av = valueFor(a), bv = valueFor(b);
    if (!Number.isFinite(av) && !Number.isFinite(bv)) return b.weight - a.weight;
    if (!Number.isFinite(av)) return 1;
    if (!Number.isFinite(bv)) return -1;
    return (sortDescending ? bv - av : av - bv) || b.weight - a.weight;
  });
  updateSortIndicators();

  if (!visible.length) {
    $("coinRows").innerHTML = '<tr><td colspan="10" class="empty">ไม่พบเหรียญตามตัวกรองที่เลือก</td></tr>';
    return;
  }

  $("coinRows").innerHTML = visible.map(m => {
    const r = records.get(m.id), d = r?.daily.diff.at(-1), rsi = r?.daily.rsi.at(-1), phase = r?.phase;
    const bbkc = phase ? `<span class="phase phase-${phase.key}">${phase.key === "release" ? "▲ " : phase.key === "expand" ? "▲ " : phase.key === "squeeze" ? "● " : phase.key === "cool" ? "▼ " : ""}${esc(phase.label)}</span>` : (fetchErrors.has(m.id) ? '<span class="phase phase-na">Fetch error</span>' : '<span class="phase phase-na">รอสแกน</span>');
    const ema = r ? `<span class="phase phase-${r.emaMomentum.key}"><i class="phase-arrow">${r.emaMomentum.key === "bull" ? "▲" : r.emaMomentum.key === "bear" ? "▼" : "●"}</i>${esc(r.emaMomentum.label)}</span><small>${r.emaSpread > 0 ? "+" : ""}${fmt(r.emaSpread, 2, "%")}</small>` : '<span class="phase phase-na">รอสแกน</span>';
    const pairLabel = m.pair ? `<span class="pair yes">${esc(m.pair)} <a class="ext-link" href="https://www.binance.com/en/trade/${esc(m.pair)}" target="_blank" rel="noreferrer" title="เปิด Binance Spot">↗</a></span>` : '<span class="pair no">ไม่มี Spot USDT</span>';
    const selected = selectedId === m.id;
    const diffText = r ? `<span class="diff-val ${d > 0 ? "pos" : d < 0 ? "neg" : "zero"}">${d > 0 ? "+" : ""}${fmt(d, 2, "%")}</span>` : "—";
    const rsiText = r ? `<span class="rsi-val ${rsi > 70 ? "high" : rsi < 30 ? "low" : "mid"}">${fmt(rsi, 1)}</span>` : "—";
    const weightBarW = Math.min(100, Math.max(2, (m.weight / 60) * 100));

    const qs = r?.quantScore;
    let scoreCellHtml = "";
    if (qs && Number.isFinite(qs.totalScore)) {
      const gl = qs.gradeLetter.toLowerCase();
      const tooltip = `คะแนน ${qs.totalScore}/100 [เกรด ${qs.gradeLetter}]\n• Regime: ${qs.breakdown.regime}/30 (${qs.breakdown.regimeReason})\n• Momentum: ${qs.breakdown.trend}/25 (${qs.breakdown.trendReason})\n• EDA Lift: ${qs.breakdown.eda}/20 (${qs.breakdown.edaReason})\n• Structure: ${qs.breakdown.structural}/15\n• Quality: ${qs.breakdown.quality}/10`;
      scoreCellHtml = `<div class="score-badge-wrap" title="${esc(tooltip)}">
        <span class="score-grade grade-${gl}">${qs.gradeLetter}</span>
        <div class="score-num-group">
          <div style="display:flex;align-items:center;gap:4px">
            <span class="score-val">${qs.totalScore}</span>
            <span class="score-tag tag-${qs.tagClass}">${qs.tag}</span>
          </div>
          <div class="score-bar-bg"><div class="score-bar-fill fill-${gl}" style="width:${qs.totalScore}%"></div></div>
        </div>
      </div>`;
    } else {
      scoreCellHtml = `<div class="score-badge-wrap" title="รอสแกนข้อมูล Daily"><span class="score-grade grade-na">—</span><span class="score-val" style="color:var(--muted)">—</span></div>`;
    }

    return `<tr class="${selected ? "selected" : ""}" aria-selected="${selected}">
      <td class="rank">${members.indexOf(m) + 1}</td>
      <td><button class="coin-select" type="button" data-id="${esc(m.id)}" aria-pressed="${selected}" ${scanBusy ? "disabled" : ""}><strong>${esc(m.symbol)}</strong><span>${esc(m.name)}</span></button></td>
      <td class="score-cell">${scoreCellHtml}</td>
      <td class="num weight-cell"><span>${fmt(m.weight, 2, "%")}</span><div class="weight-bar-bg"><div class="weight-bar-fill" style="width:${weightBarW.toFixed(1)}%"></div></div></td>
      <td>${pairLabel}</td><td>${bbkc}</td><td>${ema}</td>
      <td class="num">${diffText}</td><td class="num">${rsiText}</td><td class="num">${r ? formatN(r.dailyBars.length) : fetchErrors.has(m.id) ? "error" : "—"}</td>
    </tr>`;
  }).join("");
  document.querySelectorAll(".coin-select").forEach(button => button.addEventListener("click", () => selectMember(button.dataset.id)));
}

function getDailyWindowBars() {
  const wanted = dailyBarsWanted();
  return Math.min(wanted, Math.ceil((Date.now() - Date.UTC(2017, 0, 1)) / DAY_MS));
}

async function getOrLoadDaily(member) {
  if (records.has(member.id)) return records.get(member.id);
  if (!member.pair) return null;
  const bars = await fetchBars(member.pair, "1d", getDailyWindowBars());
  if (bars.length < 40) throw new Error(`${member.symbol}: มีแท่ง Daily น้อยเกินไป (ต้อง ≥40)`);
  const record = createRecord(member, bars);
  records.set(member.id, record); fetchErrors.delete(member.id);
  return record;
}

async function load4h(record) {
  if (record.bars4h || record.loading4h) return;
  record.loading4h = true;
  try {
    const bars = await fetchBars(record.member.pair, "4h", 90 * 6);
    if (bars.length < 40) throw new Error("มีแท่ง 4H น้อยเกินไปสำหรับ RSI(diff)");
    const short = E.computeIndicators(bars, INTERVALS["4h"]);
    record.bars4h = bars; record.short = short; record.gaps4h = short.gaps;
  } catch (error) {
    record.error4h = error.message;
  } finally { record.loading4h = false; }
}

async function selectMember(id) {
  const member = members.find(m => m.id === String(id));
  if (!member) return;
  selectedId = member.id; renderUniverse(); renderSelectedPlaceholder();
  $("selectedPanelSection")?.scrollIntoView({ behavior: "smooth", block: "start" });
  if (!member.pair) {
    renderUnavailable(member); renderResearch(); renderStrategy(); renderForecast(); return;
  }
  let record = records.get(member.id);
  if (!record) {
    setStatus(`กำลังโหลด Daily ของ ${member.symbol} จาก Binance…`);
    try { record = await getOrLoadDaily(member); }
    catch (error) { fetchErrors.set(member.id, error.message); renderUniverse(); renderSelectedError(member, error); renderResearch(); renderStrategy(); renderForecast(); setStatus(`${member.symbol}: ${error.message}`); return; }
  }
  renderSummary(); renderUniverse(); renderSelected(record);
  if (!record.bars4h && !record.loading4h) {
    setStatus(`กำลังโหลด RSI(diff) 4H ของ ${member.symbol}…`);
    await load4h(record);
    if (selectedId === member.id) renderSelected(record);
  }
  if (selectedId === member.id) setStatus(`${member.symbol} · Daily ${formatN(record.dailyBars.length)} bars · 4H ${record.bars4h ? formatN(record.bars4h.length) + " bars" : (record.error4h || "กำลังโหลด")}`);
  renderUniverse(); renderSummary(); renderResearch(); renderStrategy(); renderForecast();
}

function renderSelectedPlaceholder() {
  const member = members.find(m => m.id === selectedId);
  if (!member) {
    $("selectedPanel").innerHTML = `<div class="empty-studio-placeholder">
      <div class="empty-icon-wrap"><div class="empty-radar-ping"></div><svg class="empty-big-icon" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--cyan-400)" stroke-width="1.8"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/><line x1="12" y1="2" x2="12" y2="12"/></svg></div>
      <h3 class="empty-title">คลิกเลือกเหรียญจากตารางสแกนเนอร์ด้านบน</h3>
      <p class="empty-desc">ระบบจะเปิด "ห้องวิเคราะห์เจาะลึกเต็มจอ (Deep-Dive Studio)" แสดงกราฟแท่งเทียน Candlestick, คะแนนความพร้อม 5 เสาหลัก (Quant Composite Score 0–100), คำแนะนำเทรดสำหรับมือใหม่ และสถิติความผันผวน 4H/Daily ทันที</p>
      <button type="button" class="btn btn-sm primary" id="emptyScrollUpBtn">↑ เลื่อนไปดูตารางเหรียญ CMC100</button>
    </div>`;
    $("emptyScrollUpBtn")?.addEventListener("click", () => {
      $("scannerSection")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    return;
  }
  $("selectedPanel").innerHTML = `<div class="studio-hero">
    <div class="studio-hero-left">
      <div class="studio-avatar">${esc(member.symbol.slice(0, 4))}</div>
      <div class="studio-identity">
        <div class="studio-title-row">
          <span class="studio-symbol">${esc(member.symbol)}</span>
          <span class="studio-rank-badge">CMC #${members.indexOf(member) + 1}</span>
        </div>
        <div class="studio-name-row">
          <span class="studio-fullname">${esc(member.name)} · index weight ${fmt(member.weight, 2, "%")}</span>
        </div>
      </div>
    </div>
    <div class="studio-hero-right">
      <button type="button" class="btn btn-sm secondary" id="scrollToTableBtnHero">↑ ตารางสแกนเนอร์</button>
    </div>
  </div>
  <div class="empty">${scanBusy ? "กำลังสแกนทั้ง universe…" : member.pair ? "กำลังโหลดข้อมูลปิดแล้วและคำนวณ indicator…" : "เหรียญนี้เป็นสมาชิก CMC100 แต่ไม่พบคู่ Binance Spot USDT ที่ active"}</div>`;
  $("scrollToTableBtnHero")?.addEventListener("click", () => {
    $("scannerSection")?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

function renderUnavailable(member) {
  $("selectedPanel").innerHTML = `<div class="studio-hero">
    <div class="studio-hero-left">
      <div class="studio-avatar">${esc(member.symbol.slice(0, 4))}</div>
      <div class="studio-identity">
        <div class="studio-title-row">
          <span class="studio-symbol">${esc(member.symbol)}</span>
          <span class="phase phase-na">ไม่มี Binance Spot USDT</span>
          <span class="studio-rank-badge">CMC #${members.indexOf(member) + 1}</span>
        </div>
        <div class="studio-name-row"><span class="studio-fullname">${esc(member.name)}</span></div>
      </div>
    </div>
    <div class="studio-hero-right">
      <button type="button" class="btn btn-sm secondary" id="scrollToTableBtnHero">↑ ตารางสแกนเนอร์</button>
    </div>
  </div>
  <div class="empty-studio-placeholder" style="padding: 28px 16px;">
    <div class="empty-big-icon"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--amber)" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg></div>
    <h3 class="empty-title">ไม่พบคู่เทรด Binance Spot USDT สำหรับ ${esc(member.symbol)}</h3>
    <p class="empty-desc">ยังคงแสดงสมาชิกครบ 100 เหรียญตามเกณฑ์ CMC100 แต่ไม่มีแท่งราคาจากคู่ Spot USDT บน Binance สำหรับทำ EDA และวิเคราะห์ จึงไม่ถูกรวมในการคำนวณ Binance cohort</p>
    <a class="btn btn-sm primary" href="${esc(member.url)}" target="_blank" rel="noreferrer">ดูข้อมูลบน CoinMarketCap ↗</a>
  </div>`;
  $("scrollToTableBtnHero")?.addEventListener("click", () => {
    $("scannerSection")?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

function renderSelectedError(member, error) {
  $("selectedPanel").innerHTML = `<div class="studio-hero">
    <div class="studio-hero-left">
      <div class="studio-avatar">${esc(member.symbol.slice(0, 4))}</div>
      <div class="studio-identity">
        <div class="studio-title-row">
          <span class="studio-symbol">${esc(member.symbol)}</span>
          <span class="studio-rank-badge">CMC #${members.indexOf(member) + 1}</span>
        </div>
        <div class="studio-name-row"><span class="studio-fullname">${esc(member.name)} · ${esc(member.pair)}</span></div>
      </div>
    </div>
    <div class="studio-hero-right">
      <button type="button" class="btn btn-sm secondary" id="scrollToTableBtnHero">↑ ตารางสแกนเนอร์</button>
    </div>
  </div>
  <div class="empty error" style="padding: 32px 16px;">
    <h3>เกิดข้อผิดพลาดในการโหลดข้อมูล</h3>
    <p>${esc(error.message)}</p>
    <button type="button" class="btn btn-sm secondary" id="retryLoadBtn">ลองโหลดใหม่อีกครั้ง</button>
  </div>`;
  $("retryLoadBtn")?.addEventListener("click", () => selectMember(member.id));
  $("scrollToTableBtnHero")?.addEventListener("click", () => {
    $("scannerSection")?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

function chartSVG(series, kind, secondary = null, label = "") {
  const width = 700, height = 130, left = kind === "price" ? 82 : 6, right = 6, top = 8, bottom = 8;
  const start = Math.max(0, series.length - 140), main = series.slice(start);
  const all = main.filter(Number.isFinite).concat(secondary ? secondary.slice(start).filter(Number.isFinite) : []);
  if (!all.length) return '<div class="chart-empty">ข้อมูลไม่พอแสดงกราฟ</div>';
  let min = kind === "rsi" ? 0 : kind === "price" ? Math.min(...all) : Math.min(0, ...all);
  let max = kind === "rsi" ? 100 : kind === "price" ? Math.max(...all) : Math.max(0, ...all);
  if (max - min < (kind === "price" ? 1e-12 : 1e-8)) {
    const pad = kind === "price" ? Math.max(Math.abs(max) * 0.01, 1e-12) : 1;
    max += pad; min -= pad;
  }
  if (kind !== "rsi") { const padding = (max - min) * 0.12; min -= padding; max += padding; }
  const xAt = i => left + (width - left - right) * (i / (main.length - 1 || 1));
  const yAt = v => top + (height - top - bottom) * (1 - (v - min) / (max - min));
  const path = values => {
    let d = "", drawing = false;
    for (let i = 0; i < values.length; i++) {
      const value = values[i];
      if (!Number.isFinite(value)) { drawing = false; continue; }
      d += `${drawing ? "L" : "M"}${xAt(i).toFixed(1)},${yAt(value).toFixed(1)} `; drawing = true;
    }
    return d;
  };
  const grid = [0.25, 0.5, 0.75].map(q => `<line class="chart-grid" x1="${left}" x2="${width - right}" y1="${(top + (height - top - bottom) * q).toFixed(1)}" y2="${(top + (height - top - bottom) * q).toFixed(1)}"/>`).join("");

  let thresholds = "";
  let areaFill = "";
  if (kind === "rsi") {
    const y70 = yAt(70).toFixed(1), y30 = yAt(30).toFixed(1);
    const corridor = `<rect x="${left}" y="${y70}" width="${width - left - right}" height="${Math.abs(y30 - y70)}" fill="var(--line)" opacity="0.4"/>`;
    thresholds = corridor + [30, 70].map(v => `<line class="chart-threshold" x1="${left}" x2="${width - right}" y1="${yAt(v).toFixed(1)}" y2="${yAt(v).toFixed(1)}"/><text x="${width - right - 2}" y="${(yAt(v) - 3).toFixed(1)}" text-anchor="end" fill="var(--muted)" font-size="8.5">${v}</text>`).join("");
  } else if (kind === "diff") {
    const y0 = yAt(0);
    thresholds = `<line class="chart-zero" x1="${left}" x2="${width - right}" y1="${y0.toFixed(1)}" y2="${y0.toFixed(1)}"/><text x="${left + 4}" y="${(y0 - 3).toFixed(1)}" fill="var(--blue)" font-size="8.5">0 (Compression | Expansion)</text>`;
    let dArea = "";
    let lastValidX = left;
    for (let i = 0; i < main.length; i++) {
      const v = main[i];
      if (Number.isFinite(v)) {
        const x = xAt(i);
        if (!dArea) dArea = `M${x.toFixed(1)},${y0.toFixed(1)} L${x.toFixed(1)},${yAt(v).toFixed(1)} `;
        else dArea += `L${x.toFixed(1)},${yAt(v).toFixed(1)} `;
        lastValidX = x;
      }
    }
    if (dArea) {
      dArea += `L${lastValidX.toFixed(1)},${y0.toFixed(1)} Z`;
      areaFill = `<defs><linearGradient id="diffAreaGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="var(--teal)" stop-opacity="0.25"/><stop offset="100%" stop-color="var(--blue)" stop-opacity="0.1"/></linearGradient></defs><path d="${dArea}" fill="url(#diffAreaGrad)"/>`;
    }
  }

  const axisLabels = kind === "price" ? [0.25, 0.5, 0.75].map(q => {
    const value = max - (max - min) * q, y = top + (height - top - bottom) * q + 3;
    return `<text x="0" y="${y.toFixed(1)}" fill="var(--muted)" font-size="10">${esc(formatPrice(value))}</text>`;
  }).join("") : "";
  const second = secondary ? `<path class="chart-line secondary" d="${path(secondary.slice(start))}"/>` : "";
  const mainClass = kind === "price" ? "chart-line secondary" : "chart-line";
  return `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(label)}">${grid}${thresholds}${areaFill}${axisLabels}${second}<path class="${mainClass}" d="${path(main)}"/></svg>`;
}

function candleChart(bars, days, symbol, indicators = null) {
  const visible = days > 0 ? bars.slice(-days) : bars;
  if (!visible.length) return { bars: [], html: '<div class="chart-empty">ข้อมูลไม่พอแสดงกราฟ</div>', startIndex: 0 };
  const start = days > 0 ? Math.max(0, bars.length - days) : 0;
  const width = 760, height = 320, left = 14, right = 74, top = 12, priceBottom = 224, volumeTop = 246, volumeBottom = 288;
  const plotWidth = width - left - right, slot = plotWidth / visible.length;
  let low = Infinity, high = -Infinity, maxVolume = 0;
  for (let i = 0; i < visible.length; i++) {
    const bar = visible[i];
    low = Math.min(low, bar.low);
    high = Math.max(high, bar.high);
    maxVolume = Math.max(maxVolume, bar.volume || 0);
    const e12 = indicators?.ema12?.[start + i];
    const e26 = indicators?.ema26?.[start + i];
    if (Number.isFinite(e12)) { low = Math.min(low, e12); high = Math.max(high, e12); }
    if (Number.isFinite(e26)) { low = Math.min(low, e26); high = Math.max(high, e26); }
  }
  const pad = Math.max((high - low) * 0.05, Math.abs(high) * 0.0005, 1e-12);
  low -= pad; high += pad;
  const y = price => top + (priceBottom - top) * (1 - (price - low) / (high - low));
  const candleWidth = Math.max(1, Math.min(8, slot * 0.68));
  const grid = Array.from({ length: 5 }, (_, i) => {
    const fraction = i / 4, py = top + (priceBottom - top) * fraction, price = high - (high - low) * fraction;
    return `<line class="chart-grid" x1="${left}" x2="${width - right}" y1="${py.toFixed(2)}" y2="${py.toFixed(2)}"/><text class="price-axis-label" x="${width - 4}" y="${(py + 3).toFixed(2)}" text-anchor="end">${esc(formatPrice(price))}</text>`;
  }).join("");
  const candles = visible.map((bar, i) => {
    const x = left + slot * (i + 0.5), yOpen = y(bar.open), yClose = y(bar.close), bullish = bar.close >= bar.open;
    const bodyY = Math.min(yOpen, yClose), bodyH = Math.max(1, Math.abs(yOpen - yClose));
    const volHeight = maxVolume ? (bar.volume || 0) / maxVolume * (volumeBottom - volumeTop) : 0;
    const volY = volumeBottom - volHeight, klass = bullish ? "up" : "down";
    return `<g class="candle ${klass}"><line class="candle-wick" x1="${x.toFixed(2)}" x2="${x.toFixed(2)}" y1="${y(bar.high).toFixed(2)}" y2="${y(bar.low).toFixed(2)}"/><rect class="candle-body" x="${(x - candleWidth / 2).toFixed(2)}" y="${bodyY.toFixed(2)}" width="${candleWidth.toFixed(2)}" height="${bodyH.toFixed(2)}"/><rect class="volume-bar" x="${(x - candleWidth / 2).toFixed(2)}" y="${volY.toFixed(2)}" width="${candleWidth.toFixed(2)}" height="${Math.max(0.5, volHeight).toFixed(2)}"/></g>`;
  }).join("");

  let d12 = "", d26 = "", drawing12 = false, drawing26 = false;
  if (indicators?.ema12 && indicators?.ema26) {
    for (let i = 0; i < visible.length; i++) {
      const x = left + slot * (i + 0.5);
      const e12 = indicators.ema12[start + i];
      const e26 = indicators.ema26[start + i];
      if (Number.isFinite(e12)) {
        d12 += `${drawing12 ? "L" : "M"}${x.toFixed(1)},${y(e12).toFixed(1)} `;
        drawing12 = true;
      } else drawing12 = false;
      if (Number.isFinite(e26)) {
        d26 += `${drawing26 ? "L" : "M"}${x.toFixed(1)},${y(e26).toFixed(1)} `;
        drawing26 = true;
      } else drawing26 = false;
    }
  }
  const emaLines = `${d12 ? `<path class="chart-ema12" d="${d12}"/>` : ""}${d26 ? `<path class="chart-ema26" d="${d26}"/>` : ""}`;

  const last = visible.at(-1), lastY = y(last.close), lastLine = `<line class="last-price-line" x1="${left}" x2="${width - right}" y1="${lastY.toFixed(2)}" y2="${lastY.toFixed(2)}"/><text class="last-price-label" x="${width - 4}" y="${(lastY + 3).toFixed(2)}" text-anchor="end">${esc(formatPrice(last.close))}</text>`;
  const dateAt = index => new Date(visible[index].time).toISOString().slice(0, 10);
  const dates = [0, Math.floor((visible.length - 1) / 2), visible.length - 1].map(index => {
    const x = left + slot * (index + 0.5);
    return `<text class="price-date-label" x="${x.toFixed(2)}" y="310" text-anchor="middle">${dateAt(index)}</text>`;
  }).join("");
  const svg = `<svg id="priceChartSvg" class="price-chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(symbol)} ${visible.length} แท่ง Daily candlestick พร้อม volume และ EMA 12/26; เลื่อน pointer เพื่อดู OHLCV">
    ${grid}<line class="volume-separator" x1="${left}" x2="${width - right}" y1="${volumeTop - 5}" y2="${volumeTop - 5}"/>${candles}${emaLines}${lastLine}${dates}
    <line id="priceCrossV" class="price-crosshair" x1="0" x2="0" y1="${top}" y2="${volumeBottom}"/>
    <line id="priceCrossH" class="price-crosshair" x1="${left}" x2="${width - right}" y1="0" y2="0"/>
  </svg>`;
  return { bars: visible, html: svg, startIndex: start };
}

function barSummary(bar, e12 = null, e26 = null) {
  let s = `${new Date(bar.time).toISOString().slice(0, 10)}  O ${formatPrice(bar.open)}  H ${formatPrice(bar.high)}  L ${formatPrice(bar.low)}  C ${formatPrice(bar.close)}  V ${formatN(bar.volume)}`;
  if (Number.isFinite(e12) && Number.isFinite(e26)) {
    s += `  EMA12 ${formatPrice(e12)}  EMA26 ${formatPrice(e26)}`;
  }
  return s;
}

function bindCandleChart(bars, indicators = null, startIndex = 0) {
  const svg = $("priceChartSvg");
  if (!svg || !bars.length) return;
  const vertical = $("priceCrossV"), horizontal = $("priceCrossH"), width = 760, left = 14, right = 74, top = 12, priceBottom = 224, volumeBottom = 288;
  const slot = (width - left - right) / bars.length;
  svg.addEventListener("pointermove", event => {
    const rect = svg.getBoundingClientRect(), x = (event.clientX - rect.left) / rect.width * width, y = (event.clientY - rect.top) / rect.height * 320;
    if (x < left || x > width - right || y < top || y > volumeBottom) return;
    const index = Math.max(0, Math.min(bars.length - 1, Math.floor((x - left) / slot)));
    const crossX = left + slot * (index + 0.5), crossY = Math.max(top, Math.min(priceBottom, y));
    vertical.setAttribute("x1", crossX); vertical.setAttribute("x2", crossX); vertical.style.display = "block";
    horizontal.setAttribute("y1", crossY); horizontal.setAttribute("y2", crossY); horizontal.style.display = "block";
    const e12 = indicators?.ema12?.[startIndex + index];
    const e26 = indicators?.ema26?.[startIndex + index];
    $("priceOhlc").textContent = barSummary(bars[index], e12, e26);
  });
  svg.addEventListener("pointerleave", () => {
    vertical.style.display = "none"; horizontal.style.display = "none";
    const lastIdx = bars.length - 1;
    const e12 = indicators?.ema12?.[startIndex + lastIdx];
    const e26 = indicators?.ema26?.[startIndex + lastIdx];
    $("priceOhlc").textContent = barSummary(bars[lastIdx], e12, e26);
  });
}

function renderSelected(record) {
  const member = record.member, i = record.dailyBars.length - 1;
  const dailyDiff = record.daily.diff[i], dailyRsi = record.daily.rsi[i], shortI = record.bars4h?.length - 1;
  const rsi4h = shortI >= 0 ? record.short.rsi[shortI] : null;
  const diff4h = shortI >= 0 ? record.short.diff[shortI] : null;
  const phase4h = shortI >= 0 ? E.classify(diff4h, shortI > 0 ? record.short.diff[shortI - 1] : null) : null;
  const percentile = record.daily.percentile[i], ema12 = record.daily.ema12[i], ema26 = record.daily.ema26[i];
  const candles = candleChart(record.dailyBars, priceRangeDays, member.symbol, record.daily);
  const dailyChart = chartSVG(record.daily.diff, "diff", null, `${member.symbol} daily BB-KC diff`);
  const rsiChart = record.bars4h ? chartSVG(record.short.rsi, "rsi", record.short.rsiSmooth, `${member.symbol} RSI of diff on 4 hour`) : '<div class="chart-empty">RSI(diff) 4H จะโหลดเมื่อเลือกเหรียญ</div>';
  const gapsText = `Daily missing intervals: ${record.daily.gaps}. 4H missing intervals: ${record.gaps4h ?? "not loaded"}. No missing candles are interpolated; indicator warm-up resets after gaps.`;
  const emaHelp = "EMA momentum คำนวณจาก close Daily ด้วย EMA12 เทียบ EMA26 ตามค่าเริ่มต้นของ Pine: EMA12>EMA26 = โมเมนตัมบวก, EMA12<EMA26 = โมเมนตัมลบ. เป็นสถานะแนวโน้ม ไม่ใช่คำทำนายราคา; seed เริ่มจากข้อมูลแรกของแต่ละช่วงต่อเนื่อง.";
  const binanceUrl = member.pair ? `https://www.binance.com/en/trade/${esc(member.pair)}` : null;
  const qs = record.quantScore;
  let beginnerAdvice = "";
  if (qs) {
    if (qs.tagClass === "alpha-buy") {
      beginnerAdvice = `<div class="beginner-advice advice-buy"><b>[ALPHA BUY] จุดซื้อตามโมเมนตัม:</b> ผ่านเกณฑ์เบรกเอาต์ 40 วัน + แท่งเทียนกระทิง (สถิติ PF 6.91, Win Rate 60%) · <b>ควรถือนาน:</b> 7–13 วัน (แบ่งขายครึ่งหนึ่งแถววันที่ 7) · <b>จุดคัตทันที:</b> เมื่อแท่งวันปิดต่ำกว่าเส้น SMA20</div>`;
    } else if (qs.tagClass === "prime-coil") {
      beginnerAdvice = `<div class="beginner-advice advice-coil"><b>[PRIME COIL] จุดดักสะสมต้นน้ำ:</b> บีบอัดตัวแน่นในโซนแนวรับ (Deep Squeeze) · <b>คำแนะนำ:</b> ทยอยตั้งรับ ไม่ต้องไล่ราคา · <b>รอขาย:</b> เมื่อข้ามสู่ Fresh Release แล้วรัน 13 วัน · <b>จุดคัต:</b> หลุดแนวรับ Low 20 วัน</div>`;
    } else if (qs.tagClass === "expanding") {
      beginnerAdvice = `<div class="beginner-advice advice-buy"><b>[EXPANDING] อยู่ในคลื่นขยายตัว:</b> โมเมนตัมกำลังส่งผล (ช่วง Day 2–5) · <b>คำแนะนำ:</b> ถือรันเทรนด์ได้ แต่ระวังอย่าไล่ราคาสูงเกินไป · <b>จุดล็อกกำไร:</b> ขยับ Trailing Stop ตามเส้น SMA20</div>`;
    } else if (qs.tagClass === "coil-a") {
      beginnerAdvice = `<div class="beginner-advice advice-coil"><b>[COIL A+] ทรงสะสมพลังแข็งแกร่ง:</b> โครงสร้างราคาเหนียวแน่น · <b>คำแนะนำ:</b> แบ่งไม้เล็กสะสม รอยืนยันสัญญาณ Release เพื่อใส่เพิ่ม</div>`;
    } else if (qs.tagClass === "bear-trap") {
      beginnerAdvice = `<div class="beginner-advice advice-danger"><b>[BEAR TRAP] ระวังกับดักสัญญาณหลอก:</b> แม้ค่า diff จะบวกแต่ EMA เป็นแนวโน้มขาลง (EMA Bear) หรือยืดเกิน 13 วัน · <b>คำแนะนำ:</b> ห้ามไล่ซื้อเด็ดขาด สถิติชี้ว่าอัตราล้มเหลวเกิน 65%</div>`;
    } else if (qs.tagClass === "watchlist") {
      beginnerAdvice = `<div class="beginner-advice advice-watch"><b>[WATCHLIST] เฝ้าติดตาม:</b> เริ่มมีสัญญาณดีขึ้นแต่คะแนนยังไม่ครบ 5 เสาหลัก · <b>คำแนะนำ:</b> รอให้คะแนนแตะ 70+ หรือเกิดแท็ก Alpha Buy ก่อนเข้าเทรด</div>`;
    } else {
      beginnerAdvice = `<div class="beginner-advice advice-neutral"><b>[NEUTRAL] ยังไม่น่าสนใจ:</b> โครงสร้างยังไร้ทิศทางชัดเจน · <b>คำแนะนำ:</b> ข้ามไปก่อน มองหาเหรียญเกรด S หรือ A ที่มีไฟเขียว</div>`;
    }
  }

  const scoreCardHtml = qs ? `
  <div class="studio-score-stage">
    <div class="studio-scorecard-box">
      <div class="scorecard-top">
        <div class="scorecard-badge grade-${qs.gradeLetter.toLowerCase()}">${qs.gradeLetter}</div>
        <div class="scorecard-meta">
          <div class="scorecard-total"><span class="score-num">${qs.totalScore}</span><span class="score-denom">/ 100</span></div>
          <div class="scorecard-grade-label">${esc(qs.gradeLabel)}</div>
        </div>
      </div>
      <div class="scorecard-bar-bg"><div class="scorecard-bar-fill fill-${qs.gradeLetter.toLowerCase()}" style="width:${qs.totalScore}%"></div></div>
      <div class="scorecard-tag-row">
        <span class="score-tag tag-${qs.tagClass}">${qs.tag}</span>
        <span class="scorecard-hint">${qs.totalScore >= 70 ? "● สัญญาณเข้าเกณฑ์ระบบ" : "○ รอสัญญาณคอนเฟิร์ม"}</span>
      </div>
    </div>
    <div class="studio-pillars-box">
      <div class="studio-pillar-item">
        <div class="pillar-top"><span class="pillar-label">1. REGIME</span><b class="pillar-score">${qs.breakdown.regime}/30</b></div>
        <div class="pillar-bar"><div class="pillar-bar-fill" style="width:${(qs.breakdown.regime/30*100).toFixed(0)}%"></div></div>
        <div class="pillar-reason">${esc(qs.breakdown.regimeReason || "—")}</div>
        <div class="pillar-sub">การบีบอัดตัว BB/KC Daily</div>
      </div>
      <div class="studio-pillar-item">
        <div class="pillar-top"><span class="pillar-label">2. MOMENTUM</span><b class="pillar-score">${qs.breakdown.trend}/25</b></div>
        <div class="pillar-bar"><div class="pillar-bar-fill" style="width:${(qs.breakdown.trend/25*100).toFixed(0)}%"></div></div>
        <div class="pillar-reason">${esc(qs.breakdown.trendReason || "—")}</div>
        <div class="pillar-sub">EMA12 vs EMA26 spread</div>
      </div>
      <div class="studio-pillar-item">
        <div class="pillar-top"><span class="pillar-label">3. EDA LIFT</span><b class="pillar-score">${qs.breakdown.eda}/20</b></div>
        <div class="pillar-bar"><div class="pillar-bar-fill" style="width:${(qs.breakdown.eda/20*100).toFixed(0)}%"></div></div>
        <div class="pillar-reason">${esc(qs.breakdown.edaReason || "—")}</div>
        <div class="pillar-sub">Realized Vol Lift ในอดีต</div>
      </div>
      <div class="studio-pillar-item">
        <div class="pillar-top"><span class="pillar-label">4. STRUCTURE</span><b class="pillar-score">${qs.breakdown.structural}/15</b></div>
        <div class="pillar-bar"><div class="pillar-bar-fill" style="width:${(qs.breakdown.structural/15*100).toFixed(0)}%"></div></div>
        <div class="pillar-reason">${record.dailyBars[i]?.close >= (record.daily.sma20?.[i] || 0) ? "ยืนเหนือ SMA20" : "หลุดต่ำกว่า SMA20"}</div>
        <div class="pillar-sub">Support &amp; 20-Day Low</div>
      </div>
      <div class="studio-pillar-item">
        <div class="pillar-top"><span class="pillar-label">5. QUALITY</span><b class="pillar-score">${qs.breakdown.quality}/10</b></div>
        <div class="pillar-bar"><div class="pillar-bar-fill" style="width:${(qs.breakdown.quality/10*100).toFixed(0)}%"></div></div>
        <div class="pillar-reason">${record.member.pair ? "Active Binance Spot" : "ไม่มี Spot"}</div>
        <div class="pillar-sub">${formatN(record.dailyBars.length)} แท่งประวัติ</div>
      </div>
    </div>
  </div>` : "";

  const studioHeroHtml = `
  <div class="studio-hero">
    <div class="studio-hero-left">
      <div class="studio-avatar">${esc(member.symbol.slice(0, 4))}</div>
      <div class="studio-identity">
        <div class="studio-title-row">
          <span class="studio-symbol">${esc(member.symbol)}</span>
          <span class="studio-pair-badge">${member.pair ? esc(member.pair) : "No Spot Pair"}</span>
          <span class="studio-rank-badge">CMC #${members.indexOf(member) + 1}</span>
        </div>
        <div class="studio-name-row">
          <span class="studio-fullname">${esc(member.name)}</span>
          <span class="studio-dot">·</span>
          <span class="studio-weight">Index Weight: <b>${fmt(member.weight, 2, "%")}</b></span>
        </div>
      </div>
    </div>
    <div class="studio-hero-center">
      <div class="studio-state-tags">
        <span class="phase phase-${record.phase.key}">${record.phase.key === "release" ? "● " : record.phase.key === "expand" ? "▲ " : record.phase.key === "squeeze" ? "■ " : record.phase.key === "cool" ? "▼ " : ""}BB/KC 1D: ${esc(record.phase.label)}</span>
        <span class="phase phase-${record.emaMomentum.key}"><i class="phase-arrow">${record.emaMomentum.key === "bull" ? "▲" : record.emaMomentum.key === "bear" ? "▼" : "●"}</i>EMA: ${esc(record.emaMomentum.label)}</span>
        <span class="phase phase-${phase4h?.key || "na"}">4H Cycle: ${phase4h ? esc(phase4h.label) : record.error4h ? "ไม่สำเร็จ" : "กำลังโหลด"}</span>
      </div>
    </div>
    <div class="studio-hero-right">
      <div class="studio-asof-meta">
        <span class="asof-label">แท่ง Daily ปิดล่าสุด</span>
        <b class="asof-val">${dateUTC(record.asof)}</b>
      </div>
      <div class="studio-hero-actions">
        ${member.pair ? `<a class="btn btn-sm btn-binance" href="${binanceUrl}" target="_blank" rel="noreferrer">Spot Trade ↗</a>` : ""}
        <button type="button" class="btn btn-sm secondary" id="scrollToTableBtnHero">↑ ตารางสแกนเนอร์</button>
      </div>
    </div>
  </div>`;

  const kpiHtml = `
  <div class="studio-kpis">
    <div class="kpi-card">
      <div class="kpi-label"><span>diff 1D</span> ${hint("(upperBB − upperKC) / upperKC × 100. diff ≤ 0 คือ BB อยู่ใน KC (บีบอัด); diff > 0 คือ BB กว้างกว่า KC")}</div>
      <div class="kpi-val ${dailyDiff > 0 ? "pos" : dailyDiff < 0 ? "neg" : ""}">${fmt(dailyDiff, 3, "%")}</div>
      <div class="kpi-sub">${dailyDiff > 0 ? "▲ Bollinger กว้างกว่า Keltner (Expansion)" : "● Bollinger บีบใน Keltner (Squeeze)"}</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label"><span>RSI(diff) 1D</span> ${hint("Wilder RSI 14 ของการเปลี่ยนแปลง diff ไม่ใช่ RSI ราคา; 0–100 แสดงโมเมนตัมของ spread")}</div>
      <div class="kpi-val ${dailyRsi >= 70 ? "high" : dailyRsi <= 30 ? "low" : ""}">${fmt(dailyRsi, 1)}</div>
      <div class="kpi-sub">${dailyRsi >= 70 ? "▲ โมเมนตัมพุ่งแรง (>70)" : dailyRsi <= 30 ? "▼ ชะลอตัวลึก (<30)" : "● สมดุล (30–70)"}</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label"><span>RSI(diff) 4H</span> ${hint("Wilder RSI 14 ของ diff 4 ชั่วโมง ใช้ดูรอบสั้น ไม่ใช่สัญญาณซื้อขาย")}</div>
      <div class="kpi-val ${rsi4h >= 70 ? "high" : rsi4h <= 30 ? "low" : ""}">${fmt(rsi4h, 1)}</div>
      <div class="kpi-sub">${rsi4h ? (rsi4h >= 70 ? "รอบ 4H ร้อนแรง" : rsi4h <= 30 ? "รอบ 4H เย็นตัว" : "รอบ 4H ปกติ") : "รอข้อมูล 4H"}</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label"><span>EMA Spread</span> ${hint(emaHelp)}</div>
      <div class="kpi-val ${record.emaSpread > 0 ? "pos" : "neg"}">${record.emaSpread > 0 ? "+" : ""}${fmt(record.emaSpread, 2, "%")}</div>
      <div class="kpi-sub">EMA12: ${fmt(ema12, 2)} vs EMA26: ${fmt(ema26, 2)}</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label"><span>Diff Percentile 252D</span> ${hint("อันดับของ diff ปัจจุบันเทียบกับ 252 ค่า Daily ล่าสุด")}</div>
      <div class="kpi-val">${pct(percentile, 0)}</div>
      <div class="kpi-sub">เทียบกับประวัติ 1 ปี</div>
    </div>
  </div>`;

  const chartsGridHtml = `
  <div class="studio-charts-grid">
    <div class="studio-main-chart">
      <div class="chart-block price-block">
        <div class="chart-head">
          <div>
            <b>ราคา · Daily Candlesticks + EMA 12/26 + Volume</b>
            <div style="font-size:10.5px;color:var(--muted);margin-top:2px">${esc(formatPrice(record.dailyBars[i]?.close))} USDT · ${formatN(candles.bars.length)} แท่งล่าสุด</div>
          </div>
          <div id="priceChartRanges" class="chart-ranges" role="group" aria-label="ช่วงข้อมูลกราฟราคา">
            ${[[30,"1M"],[90,"3M"],[180,"6M"],[365,"1Y"],[0,"All"]].map(([days,label]) => `<button type="button" data-days="${days}" aria-pressed="${priceRangeDays === days}">${label}</button>`).join("")}
          </div>
        </div>
        <div id="priceOhlc" class="ohlc-summary">${esc(barSummary(record.dailyBars[i], ema12, ema26))}</div>
        ${candles.html}
        <div class="legend price-legend">
          <span><i class="candle-up-key"></i>Close ≥ Open</span>
          <span><i class="candle-down-key"></i>Close &lt; Open</span>
          <span><i class="volume-key"></i>Volume</span>
          <span><i class="ema12-key"></i>EMA 12</span>
          <span><i class="ema26-key"></i>EMA 26</span>
          <span class="muted">เลื่อนเมาส์บนกราฟเพื่อดู OHLCV + EMAs</span>
        </div>
      </div>
    </div>

    <div class="studio-sub-charts">
      <div class="chart-block">
        <div class="chart-head">
          <b>BB–KC diff · Daily</b>
          <span>เส้นศูนย์ = compression | expansion ${hint("ค่าบวกบอกว่า Bollinger upper band อยู่เหนือ Keltner upper channel")}</span>
        </div>
        ${dailyChart}
      </div>
      <div class="chart-block">
        <div class="chart-head">
          <b>RSI ของ diff · 4H</b>
          <span>RSI 14 + SMA 7 · 90 วัน ${hint("สัญญาณสั้นคำนวณจาก diff ของ 4H และแท่งที่ปิดแล้วเท่านั้น")}</span>
        </div>
        ${rsiChart}
        <div class="legend">
          <span><i></i>RSI(diff) 14</span>
          <span><i class="blue"></i>SMA 7</span>
          <span><i class="amber"></i>ช่วงปกติ 30–70</span>
        </div>
      </div>
      <div class="quality ${record.daily.gaps || record.gaps4h ? "warn" : ""}">
        <b>Data Integrity:</b> ${formatN(record.dailyBars.length)} Daily bars · ${record.bars4h ? formatN(record.bars4h.length) + " 4H bars" : "4H loading"} · ${esc(dateUTC(record.dailyBars[0]?.time))} → ${esc(dateUTC(record.asof))}<br>
        <small>${esc(gapsText)}</small>
      </div>
    </div>
  </div>`;

  $("selectedPanel").innerHTML = `${studioHeroHtml}
  ${scoreCardHtml}
  ${beginnerAdvice ? `<div class="studio-advice-container">${beginnerAdvice}</div>` : ""}
  ${kpiHtml}
  ${chartsGridHtml}`;

  $("scrollToTableBtnHero")?.addEventListener("click", () => {
    $("scannerSection")?.scrollIntoView({ behavior: "smooth", block: "start" });
  });

  document.querySelectorAll("#priceChartRanges button").forEach(button => button.addEventListener("click", () => {
    priceRangeDays = Number(button.dataset.days);
    const focusDays = button.dataset.days;
    renderSelected(record);
    document.querySelector(`#priceChartRanges button[data-days="${focusDays}"]`)?.focus();
  }));
  bindCandleChart(candles.bars, record.daily, candles.startIndex);
}

function crossHighChartSVG(bars, levels, symbol) {
  const width = 760, height = 230, left = 14, right = 74, top = 10, bottom = 28, start = Math.max(0, bars.length - 336), shown = bars.slice(start);
  if (!shown.length) return '<div class="chart-empty">ยังไม่มีแท่ง 1H</div>';
  const lastIndex = bars.length - 1, plotW = width - left - right, plotH = height - top - bottom;
  let low = Infinity, high = -Infinity;
  for (const bar of shown) { low = Math.min(low, bar.low); high = Math.max(high, bar.high); }
  const displayed = levels.slice(-5).filter(level => level.endIndex > start && level.index <= lastIndex);
  for (const level of displayed) { low = Math.min(low, level.price); high = Math.max(high, level.price); }
  const padding = Math.max((high - low) * 0.06, Math.abs(high) * 0.0005, 1e-12); low -= padding; high += padding;
  const y = price => top + (high - price) / (high - low) * plotH;
  const x = index => left + (index - start) / Math.max(1, shown.length - 1) * plotW;
  const grid = Array.from({ length: 4 }, (_, i) => {
    const q = i / 3, py = top + plotH * q, price = high - (high - low) * q;
    return `<line class="chart-grid" x1="${left}" x2="${width - right}" y1="${py.toFixed(2)}" y2="${py.toFixed(2)}"/><text class="price-axis-label" x="${width - 4}" y="${(py + 3).toFixed(2)}" text-anchor="end">${esc(formatPrice(price))}</text>`;
  }).join("");
  const path = shown.map((bar, i) => `${i ? "L" : "M"}${x(start + i).toFixed(2)},${y(bar.close).toFixed(2)}`).join(" ");
  const lines = displayed.map(level => {
    const x1 = x(Math.max(start, level.index)), x2 = x(Math.min(lastIndex, level.endIndex - 1));
    if (x2 < x1) return "";
    return `<line class="level-line ${level.direction === "up" ? "bull" : "bear"}" x1="${x1.toFixed(2)}" x2="${x2.toFixed(2)}" y1="${y(level.price).toFixed(2)}" y2="${y(level.price).toFixed(2)}"/><text class="level-label" x="${width - 4}" y="${(y(level.price) - 3).toFixed(2)}" text-anchor="end">${esc(formatPrice(level.price))}</text>`;
  }).join("");
  const dates = [shown[0], shown.at(-1)].map((bar, i) => `<text class="price-date-label" x="${i ? width - right : left}" y="${height - 4}" text-anchor="${i ? "end" : "start"}">${new Date(bar.time).toISOString().slice(0, 16).replace("T", " ")}</text>`).join("");
  return `<svg class="level-chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(symbol)} 1H price close and last five RSI diff cross-high levels">${grid}<path class="level-price-path" d="${path}"/>${lines}${dates}</svg>`;
}

function renderLevelStudy(record = selectedId ? records.get(selectedId) : null) {
  const body = $("levelStudyResults");
  if (!record) { body.innerHTML = '<div class="empty">เลือกเหรียญและโหลดข้อมูล Daily ก่อน</div>'; return; }
  const days = Number($("levelLookback").value), study = record.levelStudies.get(days);
  if (!study) { body.innerHTML = '<div class="empty">กด “Run 1H level EDA” เพื่อดึงข้อมูล 1H ของเหรียญที่เลือก; โหลดแยกต่อเหรียญเพื่อไม่ยิง API ทั้ง CMC100 พร้อมกัน</div>'; return; }
  const { bars, result } = study, up = result.upBreaks, down = result.downBreaks;
  const row = (label, n, rate, outcomes) => `<tr><td>${label}</td><td class="num">${formatN(n)}</td><td class="num">${pct(rate)}</td>${["h6","h24","h72"].map(key => {
    const o = outcomes?.[key]; return `<td class="num">${o?.n ? `${pct(o.holdRate)}<small>hold · ${pct(o.medianReturn, 2)} directional move · n=${formatN(o.n)}</small>` : "—"}</td>`;
  }).join("")}</tr>`;
  const currentLevels = result.levels.slice(-5).reverse();
  const chart = crossHighChartSVG(bars, result.levels, record.member.symbol);
  body.innerHTML = `<div class="level-chart-wrap">${chart}<div class="legend"><span><i class="level-blue-key"></i>Pine bullish cross-high</span><span><i class="level-amber-key"></i>Pine bearish cross-high</span><span class="muted">เส้นระดับ = high ของแท่ง RSI(diff)/SMA7 cross</span></div></div>
    <div class="level-current"><b>5 เส้นล่าสุดตาม Pine</b>${currentLevels.length ? currentLevels.map(level => `<span class="level-chip"><i class="${level.direction === "up" ? "blue" : "amber"}"></i>${esc(dateUTC(bars[level.index]?.time))} · ${esc(formatPrice(level.price))} USDT</span>`).join("") : '<span class="muted">ยังไม่พบ cross</span>'}</div>
    <div class="table-wrap"><table class="research-table"><thead><tr><th>เหตุการณ์ต่อระดับ</th><th class="num">N</th><th class="num">อัตรา / ผล</th><th class="num">6H</th><th class="num">24H</th><th class="num">72H</th></tr></thead><tbody>
      ${row("ทดสอบระดับจากด้านล่าง · resistance candidate · ปิดไม่เหนือระดับ = rejection", result.testsBelow.n, result.testsBelow.rejectedRate)}
      ${row("ทดสอบระดับจากด้านบน · support candidate · ปิดไม่ต่ำกว่าระดับ = hold", result.testsAbove.n, result.testsAbove.heldRate)}
      ${row("Close breakout เหนือระดับเกิน 0.10%", up.n, up.falseBreak6Rate, up.outcomes)}
      ${row("หลัง breakout ขึ้น · retest กลับมารับที่ระดับภายใน 24H", up.supportRetest.n, up.supportRetest.heldRate)}
      ${row("Close breakdown ต่ำกว่าระดับเกิน 0.10%", down.n, null, down.outcomes)}
    </tbody></table></div>
    <div class="table-foot">${formatN(bars.length)} แท่ง 1H · ${esc(dateUTC(bars[0]?.time))} → ${esc(dateUTC(bars.at(-1)?.closeTime || bars.at(-1)?.time))} · tolerance ${fmt(result.tolerancePct, 2, "%")}. Hold = ปิดยังอยู่ด้าน break ณ horizon; directional move เป็นผลตอบแทนในทิศทางของ break ก่อนต้นทุน. False-break rate ของ breakout ขึ้นนับการปิดกลับที่/ใต้ระดับภายใน 6H (ตัวอย่างที่มีข้อมูลครบ ${formatN(up.falseBreak6N)}). ใช้แต่ละ level ถึง cross ถัดไปตามเส้น Pine; ทดสอบเริ่มจากแท่งถัดจาก cross. OHLC ไม่บอกลำดับการเคลื่อนไหวในแท่งเดียว, event ซ้อนกันและไม่อิสระ.</div>`;
}

async function loadLevelStudy() {
  const record = selectedId ? records.get(selectedId) : null, days = Number($("levelLookback").value);
  if (!record) { $("levelStudyStatus").textContent = "เลือกเหรียญและโหลด Daily ก่อน"; return; }
  if (record.levelStudies.has(days)) { renderLevelStudy(record); $("levelStudyStatus").textContent = `${days} วัน · cached`; return; }
  levelLoadBusy = true; $("loadLevelStudyBtn").disabled = true;
  $("levelStudyStatus").textContent = `กำลังโหลด ${record.member.symbol} 1H · ${days} วัน…`;
  try {
    const bars = await fetchBars(record.member.pair, "1h", days * 24);
    if (bars.length < 100) throw new Error(`1H bars ไม่พอ (${bars.length})`);
    const indicators = E.computeIndicators(bars, INTERVALS["1h"]);
    const result = E.analyzeCrossHighLevels(bars, indicators, 0.1);
    record.levelStudies.set(days, { bars, indicators, result });
    if (selectedId === record.member.id) {
      renderLevelStudy(record);
      $("levelStudyStatus").textContent = `${record.member.symbol} · ${formatN(bars.length)} แท่งปิด · พบ ${result.levels.length} cross-high levels`;
    }
  } catch (error) {
    if (selectedId === record.member.id) {
      $("levelStudyStatus").textContent = `โหลด 1H ไม่สำเร็จ: ${error.message}`;
      $("levelStudyResults").innerHTML = '<div class="empty error">ตรวจ network หรือ refresh แล้วลองอีกครั้ง</div>';
    }
  } finally { levelLoadBusy = false; $("loadLevelStudyBtn").disabled = false; }
}

function getEvents(record, horizon) {
  if (!record.eventCache.has(horizon)) record.eventCache.set(horizon, E.eventStudy(record.dailyBars, record.daily, horizon));
  return record.eventCache.get(horizon);
}

function renderEdaRanking(loaded, horizon) {
  const conditionKey = $("rankCondition").value, descriptor = E.CONDITIONS.find(item => item.key === conditionKey);
  if (!loaded.length) {
    $("edaRankRows").innerHTML = '<tr><td colspan="7" class="empty">สแกนเหรียญก่อน</td></tr>';
    $("edaRankCoverage").textContent = "ยังไม่มีข้อมูล";
    return;
  }
  const ranked = E.rankStudies(loaded.map(record => ({ member: record.member, events: getEvents(record, horizon) })), conditionKey, 10);
  const eligible = ranked.filter(row => row.eligible).length;
  $("edaRankCoverage").textContent = `${descriptor.label} · Forward ${horizon}D · จัดอันดับได้ ${eligible}/${loaded.length} เหรียญที่โหลด`;
  $("edaRankNote").textContent = `เรียงตาม lift = P(RV ขยาย | ${descriptor.label}) − P(RV ขยาย | ทุกวัน) ของเหรียญเดียวกัน; ต้องมี N≥10 จึงได้ rank. เทียบเพื่อ shortlist เท่านั้น: samples ทับซ้อน, ยังไม่ปรับ multiple testing/ตลาดสัมพันธ์กัน และไม่ใช่ forecast หรือ P&L.`;
  $("edaRankRows").innerHTML = ranked.map(row => {
    const member = row.member, selected = selectedId === member.id;
    const liftText = row.lift == null ? "—" : `${row.lift > 0 ? "+" : ""}${fmt(row.lift * 100, 1, " pp")}`;
    const liftClass = row.lift > 0 ? "diff-val pos" : row.lift < 0 ? "diff-val neg" : "diff-val zero";
    return `<tr><td class="rank">${row.rank ?? "—"}</td><td><button class="rank-coin" type="button" data-id="${esc(member.id)}" aria-pressed="${selected}"><strong>${esc(member.symbol)}</strong><small>${esc(member.name)}</small></button></td><td class="num">${formatN(row.sampleN)}</td><td class="num">${pct(row.conditionalExpansion)}</td><td class="num">${pct(row.baselineExpansion)}</td><td class="num"><b class="${liftClass}">${liftText}</b></td><td class="num">${pct(row.persistence)}</td></tr>`;
  }).join("");
  document.querySelectorAll("#edaRankRows .rank-coin").forEach(button => button.addEventListener("click", () => selectMember(button.dataset.id)));
}

function renderResearch() {
  const horizon = Number($("horizon").value), loaded = [...records.values()];
  $("horizonLabel").textContent = `${horizon} แท่ง Daily`;
  const member = members.find(m => m.id === selectedId), record = selectedId ? records.get(selectedId) : null;
  renderEdaRanking(loaded, horizon);
  renderLevelStudy(record);
  if (!record) $("levelStudyStatus").textContent = member ? `${member.symbol}: เลือก Run 1H level EDA เพื่อโหลดช่วงข้อมูล` : "โหลดแยกต่อเหรียญเมื่อกดปุ่ม";
  else if (!record.levelStudies.has(Number($("levelLookback").value)) && !levelLoadBusy) $("levelStudyStatus").textContent = `${record.member.symbol}: เลือก Run 1H level EDA เพื่อโหลดช่วงข้อมูล`;
  if (!loaded.length) {
    $("aggregateRows").innerHTML = '<tr><td colspan="8" class="empty">สแกนอย่างน้อยหนึ่งเหรียญก่อน</td></tr>';
    $("selectedEventRows").innerHTML = '<tr><td colspan="7" class="empty">เลือกเหรียญที่มีข้อมูล</td></tr>';
    $("researchCoverage").textContent = "ยังไม่มีข้อมูล";
    return;
  }
  const aggregate = E.aggregateStudies(loaded.map(r => ({ ...r, events: getEvents(r, horizon) })), horizon);
  $("researchCoverage").textContent = `Binance cohort ${loaded.length} เหรียญ · ${formatN(aggregate[0].n)} coin-days ที่มี outcome ครบ · CMC100 current members only`;
  $("aggregateRows").innerHTML = aggregate.map(r => `<tr>
    <td><strong>${esc(r.label)}</strong><small>${esc(r.rule)}</small></td>
    <td class="num">${formatN(r.n)}</td><td class="num">${r.symbols}/${loaded.length}<small>coins · ≥10 samples: ${r.symbolsStable}</small></td>
    <td class="num"><b>${pct(r.pooledExpansion)}</b><small>pooled · ${pct(r.equalCoinExpansion)} equal-coin</small></td>
    <td class="num">${pct(r.pooledPersistence)}<small>pooled · ${pct(r.equalCoinPersistence)} equal-coin</small></td>
    <td class="num">${pct(r.pooledCompressionAtEnd)}<small>pooled · ${pct(r.equalCoinCompressionAtEnd)} equal-coin</small></td>
    <td class="num">${fmt(r.pooledMedianRV == null ? null : r.pooledMedianRV * 100, 2, "%")}<small>coin-median mean ${fmt(r.equalCoinMedianRV == null ? null : r.equalCoinMedianRV * 100, 2, "%")}</small></td>
    <td class="num">${pct(r.pooledPositive)}<small>pooled · ${pct(r.equalCoinPositive)} equal-coin</small></td>
  </tr>`).join("");
  $("selectedEventTitle").textContent = member ? `${member.symbol} · Conditional outcomes` : "Conditional outcomes · เหรียญที่เลือก";
  if (!record) {
    $("selectedEventRows").innerHTML = '<tr><td colspan="7" class="empty">เลือกเหรียญที่โหลดข้อมูลแล้วจากหน้า “ตลาดรวม”</td></tr>';
    return;
  }
  const rows = E.CONDITIONS.map(c => {
    const s = E.summarize(getEvents(record, horizon)[c.key]);
    return `<tr><td><strong>${esc(c.label)}</strong><small>${esc(c.rule)}</small></td><td class="num">${formatN(s.n)}</td><td class="num"><b>${pct(s.expansion)}</b></td><td class="num">${pct(s.persistence)}</td><td class="num">${pct(s.compressionAtEnd)}</td><td class="num">${fmt(s.medianRV == null ? null : s.medianRV * 100, 2, "%")}</td><td class="num">${pct(s.positive)}</td></tr>`;
  }).join("");
  $("selectedEventRows").innerHTML = rows;
}

function strategyOptions() {
  const bounded = (id, fallback) => {
    const value = Number($(id).value);
    return Number.isFinite(value) ? Math.max(0, Math.min(500, value)) : fallback;
  };
  return { horizon: Number($("horizon").value), feeBps: bounded("feeBps", 10), slippageBps: bounded("slipBps", 5), breakoutLookback: 20 };
}

function currentBacktestKey() {
  const o = strategyOptions(); return `${o.horizon}|${o.feeBps}|${o.slippageBps}|${records.size}|${[...records.keys()].sort().join(",")}`;
}

function globalDateSlices(allRecords) {
  const first = Math.min(...allRecords.map(r => r.dailyBars[0]?.time).filter(Number.isFinite));
  const last = Math.max(...allRecords.map(r => r.dailyBars.at(-1)?.time).filter(Number.isFinite)) + DAY_MS;
  const c1 = Math.floor(first + (last - first) * 0.6), c2 = Math.floor(first + (last - first) * 0.8);
  return [
    { key: "early", label: "ต้น · 60%", startTime: first, endTime: c1 },
    { key: "middle", label: "กลาง · 20%", startTime: c1, endTime: c2 },
    { key: "late", label: "ท้าย · 20%", startTime: c2, endTime: last }
  ];
}

function lowerBoundTime(bars, time) {
  let low = 0, high = bars.length;
  while (low < high) { const mid = (low + high) >>> 1; if (bars[mid].time < time) low = mid + 1; else high = mid; }
  return low;
}

function runAllBacktests() {
  const loaded = [...records.values()], options = strategyOptions();
  if (!loaded.length) return;
  const slices = globalDateSlices(loaded);
  for (const record of loaded) {
    record.backtests = { all: E.runBacktest(record.dailyBars, record.daily, options) };
    for (const slice of slices) {
      const startIndex = lowerBoundTime(record.dailyBars, slice.startTime), endIndex = lowerBoundTime(record.dailyBars, slice.endTime);
      record.backtests[slice.key] = { ...E.runBacktest(record.dailyBars, record.daily, { ...options, startIndex, endIndex }), startTime: slice.startTime, endTime: slice.endTime, actualStart: record.dailyBars[startIndex]?.time ?? null, actualEnd: record.dailyBars[Math.max(startIndex, endIndex - 1)]?.time ?? null };
    }
  }
  backtestKey = currentBacktestKey(); backtestDone = true;
  $("exportTradesBtn").disabled = false;
  renderStrategy();
}

function profitFactorText(value) { return value === Infinity ? "∞" : fmt(value, 2); }

function strategyPeriodRows() {
  const loaded = [...records.values()];
  return [{ key: "all", label: "ทั้งช่วง · pooled" }, { key: "early", label: "ต้น · 60%" }, { key: "middle", label: "กลาง · 20%" }, { key: "late", label: "ท้าย · 20% · pseudo-OOS" }].map(period => {
    const a = E.aggregateBacktests(loaded, period.key);
    return `<tr><td><strong>${esc(period.label)}</strong></td><td class="num">${formatN(a.n)}</td><td class="num">${formatN(a.symbols)}<small>coins with trades</small></td><td class="num">${pct(a.winRate)}</td><td class="num">${pct(a.meanNet)}</td><td class="num">${profitFactorText(a.profitFactor)}</td><td class="num">${pct(a.equalCoinCompound)}</td></tr>`;
  }).join("");
}

function equityChartSVG(trades, symbol) {
  if (!trades || !trades.length) return '<div class="chart-empty">ไม่พบ trade สำหรับเหรียญนี้ภายใต้เงื่อนไขปัจจุบัน</div>';
  const width = 760, height = 150, left = 50, right = 15, top = 12, bottom = 22;
  const plotW = width - left - right, plotH = height - top - bottom;
  const sorted = [...trades].sort((a, b) => a.exitTime - b.exitTime);
  let cum = 1.0;
  const points = [{ time: sorted[0].entryTime, equity: 0, win: null }];
  for (const t of sorted) {
    cum *= (1 + t.netReturn);
    points.push({ time: t.exitTime, equity: (cum - 1) * 100, win: t.netReturn > 0 });
  }
  const minEq = Math.min(0, ...points.map(p => p.equity));
  const maxEq = Math.max(0, ...points.map(p => p.equity));
  const pad = Math.max((maxEq - minEq) * 0.15, 2);
  const min = minEq - pad, max = maxEq + pad;
  const yAt = eq => top + plotH * (1 - (eq - min) / (max - min));
  const xAt = i => left + plotW * (i / (points.length - 1 || 1));
  const y0 = yAt(0);

  const grid = [0.2, 0.5, 0.8].map(q => {
    const eq = max - (max - min) * q, y = top + plotH * q;
    return `<line class="chart-grid" x1="${left}" x2="${width - right}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}"/><text class="price-axis-label" x="${left - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end">${eq > 0 ? "+" : ""}${eq.toFixed(1)}%</text>`;
  }).join("");
  const zeroLine = `<line class="chart-zero" x1="${left}" x2="${width - right}" y1="${y0.toFixed(1)}" y2="${y0.toFixed(1)}"/><text class="price-axis-label" x="${left - 6}" y="${(y0 + 3).toFixed(1)}" text-anchor="end">0.0%</text>`;

  let pathD = `M${xAt(0).toFixed(1)},${yAt(points[0].equity).toFixed(1)} `;
  for (let i = 1; i < points.length; i++) pathD += `L${xAt(i).toFixed(1)},${yAt(points[i].equity).toFixed(1)} `;

  const areaD = `${pathD} L${xAt(points.length - 1).toFixed(1)},${y0.toFixed(1)} L${xAt(0).toFixed(1)},${y0.toFixed(1)} Z`;

  const dots = points.slice(1).map((p, i) => {
    const x = xAt(i + 1), y = yAt(p.equity);
    const color = p.win ? "var(--teal)" : "var(--red)";
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="${color}"/>`;
  }).join("");

  const startDate = new Date(points[0].time).toISOString().slice(0, 10);
  const endDate = new Date(points.at(-1).time).toISOString().slice(0, 10);
  const dates = `<text class="price-date-label" x="${left}" y="${height - 4}" text-anchor="start">${startDate}</text><text class="price-date-label" x="${width - right}" y="${height - 4}" text-anchor="end">${endDate}</text>`;

  const netRet = points.at(-1).equity;
  const netRetText = `${netRet > 0 ? "+" : ""}${netRet.toFixed(2)}%`;
  const badgeClass = netRet >= 0 ? "phase-expand" : "phase-bear";

  return `<div class="equity-chart-head"><span><b>Cumulative Return Curve · ${esc(symbol)}</b> (Trade-by-trade compounded net)</span><span class="phase ${badgeClass}">Net: ${netRetText} (${trades.length} trades)</span></div>
  <svg class="equity-chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Equity curve ${esc(symbol)}">
    <defs><linearGradient id="eqGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="var(--teal)" stop-opacity="0.3"/><stop offset="100%" stop-color="var(--teal)" stop-opacity="0.02"/></linearGradient></defs>
    ${grid}${zeroLine}<path d="${areaD}" fill="url(#eqGrad)"/><path d="${pathD}" fill="none" stroke="var(--teal)" stroke-width="2"/>${dots}${dates}
  </svg>`;
}

function renderStrategy() {
  const loaded = [...records.values()];
  const eqBox = $("selectedStrategyEquityCurve");
  if (!loaded.length) {
    $("exportTradesBtn").disabled = true;
    $("strategyAggregateRows").innerHTML = '<tr><td colspan="7" class="empty">สแกนข้อมูลก่อนเริ่ม backtest</td></tr>';
    $("strategyCoinRows").innerHTML = '<tr><td colspan="8" class="empty">ยังไม่มีเหรียญที่สแกนแล้ว</td></tr>';
    $("selectedStrategyRows").innerHTML = '<tr><td colspan="8" class="empty">เลือกเหรียญเพื่อดู split ของเหรียญนั้น</td></tr>';
    if (eqBox) eqBox.style.display = "none";
    return;
  }
  if (!backtestDone || currentBacktestKey() !== backtestKey) {
    $("exportTradesBtn").disabled = true;
    $("strategyState").textContent = "ยังไม่ได้คำนวณด้วยค่าปัจจุบัน — กด “Run candidate backtest”";
    $("strategyAggregateRows").innerHTML = '<tr><td colspan="7" class="empty">ยังไม่มีผล backtest สำหรับค่าพารามิเตอร์ปัจจุบัน</td></tr>';
    $("strategyCoinRows").innerHTML = '<tr><td colspan="8" class="empty">กด Run candidate backtest เพื่อคำนวณทุกเหรียญที่โหลดแล้ว</td></tr>';
    $("selectedStrategyRows").innerHTML = '<tr><td colspan="8" class="empty">รอผล backtest</td></tr>';
    if (eqBox) eqBox.style.display = "none";
    return;
  }
  const options = strategyOptions();
  $("exportTradesBtn").disabled = false;
  $("strategyState").textContent = `ผลล่าสุด · ถือ ${options.horizon} วัน · fee ${options.feeBps} bps/side · slippage ${options.slippageBps} bps/side · breakout 20 วัน`;
  $("strategyAggregateRows").innerHTML = strategyPeriodRows();
  const sorted = [...loaded].sort((a, b) => (b.backtests?.late?.n || 0) - (a.backtests?.late?.n || 0) || b.member.weight - a.member.weight);
  $("strategyCoinRows").innerHTML = sorted.map(r => {
    const all = r.backtests.all, late = r.backtests.late;
    return `<tr><td>${members.indexOf(r.member) + 1}</td><td><button class="coin-select compact" type="button" data-id="${esc(r.member.id)}"><strong>${esc(r.member.symbol)}</strong><span>${esc(r.member.pair)}</span></button></td><td class="num">${formatN(all.n)}</td><td class="num">${pct(all.compounded)}</td><td class="num">${formatN(late.n)}</td><td class="num">${pct(late.winRate)}</td><td class="num">${pct(late.meanNet)}</td><td class="num">${profitFactorText(late.profitFactor)}</td></tr>`;
  }).join("");
  document.querySelectorAll("#strategyCoinRows .coin-select").forEach(button => button.addEventListener("click", () => {
    selectMember(button.dataset.id).then(() => renderStrategy());
  }));

  const selected = selectedId ? records.get(selectedId) : null;
  if (!selected) {
    $("selectedStrategyTitle").textContent = "เหรียญที่เลือก";
    $("selectedStrategyRows").innerHTML = '<tr><td colspan="8" class="empty">เลือกเหรียญที่สแกนแล้ว</td></tr>';
    if (eqBox) eqBox.style.display = "none";
    return;
  }
  $("selectedStrategyTitle").textContent = `${selected.member.symbol} · per-coin results`;
  if (eqBox) {
    const trades = selected.backtests?.all?.trades || [];
    eqBox.innerHTML = equityChartSVG(trades, selected.member.symbol);
    eqBox.style.display = "block";
  }
  $("selectedStrategyRows").innerHTML = [
    { key: "all", label: "ทั้งช่วง" }, { key: "early", label: "ต้น · 60%" }, { key: "middle", label: "กลาง · 20%" }, { key: "late", label: "ท้าย · 20% · pseudo-OOS" }
  ].map(period => {
    const x = selected.backtests[period.key];
    const dates = period.key === "all" ? `${dateUTC(selected.dailyBars[0].time)} – ${dateUTC(selected.dailyBars.at(-1).time)}` : `${dateUTC(x.actualStart)} – ${dateUTC(x.actualEnd)}`;
    return `<tr><td><strong>${period.label}</strong><small>${dates}</small></td><td class="num">${formatN(x.n)}</td><td class="num">${pct(x.winRate)}</td><td class="num">${pct(x.meanNet)}</td><td class="num">${profitFactorText(x.profitFactor)}</td><td class="num">${pct(x.compounded)}</td><td class="num">${pct(x.maxDrawdown)}</td><td class="num">${pct(x.buyHold)}</td></tr>`;
  }).join("");
}

function forecastConeChartSVG(bars, projections, currentPrice, symbol) {
  const width = 860, height = 300, left = 75, right = 110, top = 25, bottom = 28;
  const plotW = width - left - right, plotH = height - top - bottom;

  const histBars = bars.slice(-30);
  const nHist = histBars.length;
  const nProj = projections.length;
  const totalSteps = nHist + nProj - 1;

  const xAt = index => left + plotW * (index / totalSteps);
  const splitIndex = nHist - 1;
  const xSplit = xAt(splitIndex);

  const allPrices = [
    ...histBars.map(b => b.close),
    ...histBars.map(b => b.high),
    ...histBars.map(b => b.low),
    ...projections.map(p => p.upper2SD),
    ...projections.map(p => p.lower2SD)
  ];
  let minP = Math.min(...allPrices);
  let maxP = Math.max(...allPrices);
  const pad = (maxP - minP) * 0.08 || 1;
  minP -= pad; maxP += pad;

  const yAt = price => top + plotH * (1 - (price - minP) / (maxP - minP));

  const gridLines = [0.15, 0.5, 0.85].map(q => {
    const p = maxP - (maxP - minP) * q;
    const y = top + plotH * q;
    return `<line class="chart-grid" x1="${left}" x2="${width - right}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}"/><text class="price-axis-label" x="${left - 8}" y="${(y + 3).toFixed(1)}" text-anchor="end">${formatPrice(p)}</text>`;
  }).join("");

  let histD = `M${xAt(0).toFixed(1)},${yAt(histBars[0].close).toFixed(1)} `;
  for (let i = 1; i < nHist; i++) {
    histD += `L${xAt(i).toFixed(1)},${yAt(histBars[i].close).toFixed(1)} `;
  }

  let cone2SD = `M${xSplit.toFixed(1)},${yAt(currentPrice).toFixed(1)} `;
  for (let i = 0; i < nProj; i++) {
    cone2SD += `L${xAt(splitIndex + i + 1).toFixed(1)},${yAt(projections[i].upper2SD).toFixed(1)} `;
  }
  for (let i = nProj - 1; i >= 0; i--) {
    cone2SD += `L${xAt(splitIndex + i + 1).toFixed(1)},${yAt(projections[i].lower2SD).toFixed(1)} `;
  }
  cone2SD += "Z";

  let cone1SD = `M${xSplit.toFixed(1)},${yAt(currentPrice).toFixed(1)} `;
  for (let i = 0; i < nProj; i++) {
    cone1SD += `L${xAt(splitIndex + i + 1).toFixed(1)},${yAt(projections[i].upper1SD).toFixed(1)} `;
  }
  for (let i = nProj - 1; i >= 0; i--) {
    cone1SD += `L${xAt(splitIndex + i + 1).toFixed(1)},${yAt(projections[i].lower1SD).toFixed(1)} `;
  }
  cone1SD += "Z";

  let up2SDLine = `M${xSplit.toFixed(1)},${yAt(currentPrice).toFixed(1)} `;
  let meanLine = `M${xSplit.toFixed(1)},${yAt(currentPrice).toFixed(1)} `;
  let low2SDLine = `M${xSplit.toFixed(1)},${yAt(currentPrice).toFixed(1)} `;

  for (let i = 0; i < nProj; i++) {
    const x = xAt(splitIndex + i + 1);
    up2SDLine += `L${x.toFixed(1)},${yAt(projections[i].upper2SD).toFixed(1)} `;
    meanLine += `L${x.toFixed(1)},${yAt(projections[i].center).toFixed(1)} `;
    low2SDLine += `L${x.toFixed(1)},${yAt(projections[i].lower2SD).toFixed(1)} `;
  }

  const todayLine = `<line x1="${xSplit.toFixed(1)}" x2="${xSplit.toFixed(1)}" y1="${top}" y2="${height - bottom}" stroke="var(--muted)" stroke-width="1.5" stroke-dasharray="4,3"/><text x="${xSplit.toFixed(1)}" y="${top - 6}" text-anchor="middle" fill="var(--muted)" font-size="10" font-weight="bold">วันนี้ / ปัจจุบัน</text>`;

  const lastP = projections.at(-1);
  const xEnd = xAt(totalSteps);
  const tagUp = `<text x="${xEnd + 6}" y="${(yAt(lastP.upper2SD) + 3).toFixed(1)}" fill="var(--teal)" font-size="10" font-family="monospace" font-weight="bold">+2SD: ${formatPrice(lastP.upper2SD)}</text>`;
  const tagMean = `<text x="${xEnd + 6}" y="${(yAt(lastP.center) + 3).toFixed(1)}" fill="#eab308" font-size="10" font-family="monospace" font-weight="bold">Mean: ${formatPrice(lastP.center)}</text>`;
  const tagLow = `<text x="${xEnd + 6}" y="${(yAt(lastP.lower2SD) + 3).toFixed(1)}" fill="#f97316" font-size="10" font-family="monospace" font-weight="bold">-2SD: ${formatPrice(lastP.lower2SD)}</text>`;

  const dStart = new Date(histBars[0].time).toISOString().slice(5, 10);
  const dToday = new Date(histBars.at(-1).time).toISOString().slice(5, 10);
  const dEnd = new Date(projections.at(-1).time).toISOString().slice(5, 10);

  const dates = `
    <text class="price-date-label" x="${left}" y="${height - 6}" text-anchor="start">${dStart}</text>
    <text class="price-date-label" x="${xSplit.toFixed(1)}" y="${height - 6}" font-weight="bold" fill="var(--ink)" text-anchor="middle">${dToday}</text>
    <text class="price-date-label" x="${xEnd}" y="${height - 6}" text-anchor="end">${dEnd} (+${nProj}D)</text>
  `;

  return `<svg class="forecast-chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Forward Volatility Cone for ${esc(symbol)}">
    <defs>
      <linearGradient id="cone2SDGrad" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="var(--teal)" stop-opacity="0.25"/>
        <stop offset="100%" stop-color="var(--teal)" stop-opacity="0.06"/>
      </linearGradient>
      <linearGradient id="cone1SDGrad" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="var(--teal)" stop-opacity="0.4"/>
        <stop offset="100%" stop-color="var(--teal)" stop-opacity="0.12"/>
      </linearGradient>
    </defs>
    ${gridLines}
    <path d="${cone2SD}" fill="url(#cone2SDGrad)"/>
    <path d="${cone1SD}" fill="url(#cone1SDGrad)"/>
    <path d="${histD}" fill="none" stroke="var(--ink)" stroke-width="2"/>
    <path d="${up2SDLine}" fill="none" stroke="var(--teal)" stroke-width="1.8"/>
    <path d="${meanLine}" fill="none" stroke="#eab308" stroke-width="2" stroke-dasharray="5,4"/>
    <path d="${low2SDLine}" fill="none" stroke="#f97316" stroke-width="1.8"/>
    ${todayLine}
    ${tagUp}
    ${tagMean}
    ${tagLow}
    ${dates}
  </svg>`;
}

function renderForecast() {
  const coinSel = $("forecastCoinSelect");
  if (coinSel && members.length) {
    const loadedMembers = members.filter(m => records.has(m.id));
    const currentVal = coinSel.value || selectedId || (loadedMembers[0]?.id ?? "");
    coinSel.innerHTML = loadedMembers.length
      ? loadedMembers.map(m => `<option value="${m.id}" ${m.id === currentVal ? "selected" : ""}>${esc(m.symbol)} (${esc(m.name)})</option>`).join("")
      : '<option value="">-- ยังไม่มีเหรียญที่สแกนแล้ว --</option>';
    if (currentVal && coinSel.value !== currentVal) coinSel.value = currentVal;
  }

  const targetId = coinSel?.value || selectedId;
  const record = targetId ? records.get(targetId) : null;
  const member = targetId ? members.find(m => m.id === targetId) : null;

  if (!record || !record.dailyBars || record.dailyBars.length < 20) {
    $("fcCurrentPrice").textContent = "—";
    $("fcDailyVol").textContent = "—";
    $("fcMeanPrice").textContent = "—";
    $("fcUpper2SD").textContent = "—";
    $("fcLower2SD").textContent = "—";
    $("fcCoinSymbol").textContent = member ? `${member.symbol}: รอสแกนข้อมูล Daily` : "กรุณาสแกนข้อมูล";
    $("forecastChartWrap").innerHTML = '<div class="chart-empty">กรุณาเลือกเหรียญที่โหลดข้อมูลแล้วเพื่อดูกราฟพยากรณ์</div>';
    $("forecastMilestoneRows").innerHTML = '<tr><td colspan="6" class="empty">ไม่มีข้อมูล Daily bars สำหรับเหรียญนี้</td></tr>';
    return;
  }

  const bars = record.dailyBars;
  const currentPrice = bars.at(-1).close;
  const horizonDays = Number($("forecastHorizon")?.value || 30);
  const mode = $("forecastMode")?.value || "momentum";

  const n = bars.length;
  const lookback = Math.min(20, n - 1);
  const logReturns = [];
  for (let i = n - lookback; i < n; i++) {
    logReturns.push(Math.log(bars[i].close / bars[i - 1].close));
  }
  const meanR = logReturns.reduce((a, b) => a + b, 0) / logReturns.length;
  const variance = logReturns.reduce((a, r) => a + (r - meanR) ** 2, 0) / (logReturns.length - 1 || 1);
  const sigma = Math.sqrt(variance);
  const annualizedVol = sigma * Math.sqrt(365) * 100;

  let drift = 0;
  if (mode === "momentum") {
    drift = Math.max(-0.004, Math.min(0.004, meanR));
  }

  const projections = [];
  const DAY_MS = 86400000;
  const lastTime = bars.at(-1).closeTime || bars.at(-1).time;

  for (let d = 1; d <= horizonDays; d++) {
    const time = lastTime + d * DAY_MS;
    const center = currentPrice * Math.exp(drift * d);
    const bandWidth1SD = sigma * Math.sqrt(d);
    const bandWidth2SD = 2 * sigma * Math.sqrt(d);

    const upper2SD = center * Math.exp(+bandWidth2SD);
    const lower2SD = center * Math.exp(-bandWidth2SD);
    const upper1SD = center * Math.exp(+bandWidth1SD);
    const lower1SD = center * Math.exp(-bandWidth1SD);

    projections.push({
      day: d,
      time,
      center,
      upper2SD,
      lower2SD,
      upper1SD,
      lower1SD,
      changeCenterPct: (center / currentPrice - 1) * 100,
      changeUpper2SDPct: (upper2SD / currentPrice - 1) * 100,
      changeLower2SDPct: (lower2SD / currentPrice - 1) * 100
    });
  }

  const lastProj = projections.at(-1);

  $("fcCurrentPrice").textContent = formatPrice(currentPrice) + " USDT";
  $("fcCoinSymbol").textContent = `${member.symbol} · ${member.name}`;
  $("fcDailyVol").textContent = fmt(sigma * 100, 2, "%");
  $("fcAnnualVol").textContent = `ต่อวัน (Annualized ${fmt(annualizedVol, 1, "%")})`;

  $("fcMeanPrice").textContent = formatPrice(lastProj.center) + " USDT";
  $("fcMeanChange").textContent = `+${horizonDays} วัน: ${lastProj.changeCenterPct > 0 ? "+" : ""}${fmt(lastProj.changeCenterPct, 1, "%")}`;

  $("fcUpper2SD").textContent = formatPrice(lastProj.upper2SD) + " USDT";
  $("fcUpperChange").textContent = `+${horizonDays} วัน: +${fmt(lastProj.changeUpper2SDPct, 1, "%")}`;

  $("fcLower2SD").textContent = formatPrice(lastProj.lower2SD) + " USDT";
  $("fcLowerChange").textContent = `+${horizonDays} วัน: ${fmt(lastProj.changeLower2SDPct, 1, "%")}`;

  $("fcChartTitle").textContent = `กรวยความน่าจะเป็นของราคา ${member.symbol} (${horizonDays} วันข้างหน้า)`;
  $("fcChartSubtitle").textContent = `ราคาปิดล่าสุด: ${formatPrice(currentPrice)} USDT · Volatility: ${fmt(sigma * 100, 2, "%")}/วัน · สมมติฐาน: ${mode === "momentum" ? "Momentum Drift" : "Neutral Martingale (μ=0)"}`;

  $("forecastChartWrap").innerHTML = forecastConeChartSVG(bars, projections, currentPrice, member.symbol);

  const milestones = [1, 3, 7, 14, 21, 30, 45, 60].filter(d => d <= horizonDays);
  if (!milestones.includes(horizonDays)) milestones.push(horizonDays);
  milestones.sort((a, b) => a - b);

  $("forecastMilestoneRows").innerHTML = milestones.map(d => {
    const p = projections[d - 1];
    if (!p) return "";
    const spreadPct = (p.upper2SD / p.lower2SD - 1) * 100;
    return `<tr>
      <td><strong>${dateUTC(p.time)}</strong></td>
      <td class="num"><b>+${p.day} วัน</b></td>
      <td class="num font-mono"><span style="color:#f97316;font-weight:700">${formatPrice(p.lower2SD)}</span> <small class="diff-val neg">(${fmt(p.changeLower2SDPct, 1, "%")})</small></td>
      <td class="num font-mono"><span style="color:#eab308;font-weight:700">${formatPrice(p.center)}</span> <small class="${p.changeCenterPct >= 0 ? "diff-val pos" : "diff-val neg"}">(${p.changeCenterPct > 0 ? "+" : ""}${fmt(p.changeCenterPct, 1, "%")})</small></td>
      <td class="num font-mono"><span style="color:var(--teal);font-weight:700">${formatPrice(p.upper2SD)}</span> <small class="diff-val pos">(+${fmt(p.changeUpper2SDPct, 1, "%")})</small></td>
      <td class="num font-mono">${fmt(spreadPct, 1, "%")}</td>
    </tr>`;
  }).join("");
}

async function runScanAll() {
  if (!members.length) { await loadUniverse(); if (!members.length) return; }
  const candidates = members.filter(m => m.pair);
  if (!candidates.length) return;
  records.clear(); fetchErrors.clear(); backtestDone = false; backtestKey = ""; scanBusy = true;
  $("exportTradesBtn").disabled = true;
  $("scanAllBtn").disabled = true; $("refreshUniverseBtn").disabled = true; $("exportBtn").disabled = true;
  $("scanProgress").hidden = false; $("scanProgressBar").value = 0;
  renderUniverse(); renderSummary(); renderSelectedPlaceholder();
  let completed = 0;
  const queue = [...candidates];
  const worker = async () => {
    while (queue.length) {
      const member = queue.shift();
      try { const record = await getOrLoadDaily(member); if (record) records.set(member.id, record); }
      catch (error) { fetchErrors.set(member.id, error.message); }
      completed++;
      $("scanProgressBar").value = completed / candidates.length * 100;
      $("scanProgressLabel").textContent = `${completed}/${candidates.length} · ${member.symbol}`;
      $("coverageBar").style.width = `${completed / candidates.length * 100}%`;
      setStatus(`CMC100 scan · ${completed}/${candidates.length} · ${records.size} loaded · ${fetchErrors.size} errors`);
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(6, candidates.length) }, worker));
    $("exportBtn").disabled = false;
    $("syncStamp").textContent = `Binance klines ดึง ${dateUTC(Date.now())}`;
    setStatus(`สแกนเสร็จ · ${records.size}/${candidates.length} pairs · ${fetchErrors.size} errors · แท่งล่าสุดที่ยังไม่ปิดถูกตัดออก`);
  } finally {
    scanBusy = false; $("scanAllBtn").disabled = false; $("refreshUniverseBtn").disabled = false;
    $("scanProgress").hidden = true; renderSummary(); renderUniverse();
    const target = members.find(m => m.id === selectedId && records.has(m.id)) || members.find(m => m.pair && records.has(m.id)) || null;
    if (target) await selectMember(target.id);
    renderResearch(); renderStrategy(); renderForecast();
  }
}

function csvCell(value) { return `"${String(value ?? "").replace(/"/g, '""')}"`; }

function exportCSV() {
  if (!members.length) return;
  const rows = [["cmc100_rank_by_weight", "name", "cmc_symbol", "cmc_weight_pct", "quant_score", "quant_grade", "binance_spot_usdt_pair", "scan_status", "phase_1d", "diff_1d_pct", "rsi_diff_1d", "rsi_diff_4h", "diff_percentile_252d", "atr20_pct", "return20_pct", "daily_bars", "daily_gaps", "asof_utc", "error"]];
  for (const member of members) {
    const r = records.get(member.id), i = r?.dailyBars.length - 1, j = r?.bars4h?.length - 1;
    const qs = r?.quantScore;
    rows.push([members.indexOf(member) + 1, member.name, member.symbol, member.weight, qs ? qs.totalScore : "", qs ? qs.gradeLetter : "", member.pair || "", r ? "loaded" : member.pair ? (fetchErrors.has(member.id) ? "error" : "not_scanned") : "no_binance_usdt_spot", r?.phase.label || "", r ? r.daily.diff[i] : "", r ? r.daily.rsi[i] : "", j >= 0 ? r.short.rsi[j] : "", r ? r.daily.percentile[i] : "", r ? r.daily.atrPct[i] : "", r ? r.ret20 : "", r ? r.dailyBars.length : "", r ? r.daily.gaps : "", r ? dateUTC(r.asof) : "", fetchErrors.get(member.id) || ""]);
  }
  const csv = rows.map(row => row.map(csvCell).join(",")).join("\n");
  const blob = new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" }), url = URL.createObjectURL(blob);
  const link = document.createElement("a"); link.href = url; link.download = `penguin-cmc100-${new Date().toISOString().slice(0, 10)}.csv`; link.click(); URL.revokeObjectURL(url);
}

function exportTradeLedger() {
  if (!backtestDone || currentBacktestKey() !== backtestKey) return;
  const options = strategyOptions();
  const iso = ms => ms == null ? "" : new Date(ms).toISOString();
  const rows = [["cmc100_rank_by_current_weight", "cmc_id", "name", "cmc_symbol", "binance_pair", "side", "signal_time_utc", "entry_time_utc", "exit_time_utc", "entry_price", "exit_price", "gross_return_pct", "net_return_pct", "hold_bars", "fee_bps_per_side", "slippage_bps_per_side"]];
  for (const record of records.values()) {
    for (const trade of record.backtests?.all?.trades || []) {
      rows.push([members.indexOf(record.member) + 1, record.member.cmcId, record.member.name, record.member.symbol, record.member.pair, "long", iso(trade.signalTime), iso(trade.entryTime), iso(trade.exitTime), trade.entry, trade.exit, trade.grossReturn * 100, trade.netReturn * 100, trade.holdBars, options.feeBps, options.slippageBps]);
    }
  }
  const csv = rows.map(row => row.map(csvCell).join(",")).join("\n");
  const blob = new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" }), url = URL.createObjectURL(blob);
  const link = document.createElement("a"); link.href = url; link.download = `penguin-candidate-trades-${new Date().toISOString().slice(0, 10)}.csv`; link.click(); URL.revokeObjectURL(url);
}

function updateAllResearch() { renderResearch(); renderStrategy(); }

function placeTooltip(target) {
  const box = $("floatingTooltip");
  if (!box || box.hidden) return;
  const anchor = target.getBoundingClientRect(), tip = box.getBoundingClientRect(), margin = 12, gap = 8;
  const left = Math.max(margin, Math.min(anchor.left + (anchor.width - tip.width) / 2, innerWidth - tip.width - margin));
  const above = anchor.top - tip.height - gap;
  const top = above >= margin ? above : Math.min(anchor.bottom + gap, innerHeight - tip.height - margin);
  box.style.left = `${left}px`; box.style.top = `${Math.max(margin, top)}px`;
}

function showTooltip(target) {
  const box = $("floatingTooltip"), text = target?.dataset.tip || target?.getAttribute("aria-label");
  if (!box || !text) return;
  if (activeTooltipTarget && activeTooltipTarget !== target) activeTooltipTarget.removeAttribute("aria-describedby");
  activeTooltipTarget = target; box.textContent = text; box.hidden = false;
  target.setAttribute("aria-describedby", "floatingTooltip");
  placeTooltip(target);
}

function hideTooltip(target = activeTooltipTarget) {
  if (!activeTooltipTarget || (target && activeTooltipTarget !== target)) return;
  activeTooltipTarget.removeAttribute("aria-describedby"); activeTooltipTarget = null;
  $("floatingTooltip").hidden = true;
}

function installTooltips() {
  document.querySelectorAll(".tip[title]").forEach(button => button.removeAttribute("title"));
  document.addEventListener("pointerover", event => {
    const target = event.target instanceof Element ? event.target.closest(".tip") : null;
    if (target && !target.contains(event.relatedTarget)) showTooltip(target);
  });
  document.addEventListener("pointerout", event => {
    const target = event.target instanceof Element ? event.target.closest(".tip") : null;
    if (target && !target.contains(event.relatedTarget)) hideTooltip(target);
  });
  document.addEventListener("focusin", event => {
    const target = event.target instanceof Element ? event.target.closest(".tip") : null;
    if (target) showTooltip(target);
  });
  document.addEventListener("focusout", event => {
    const target = event.target instanceof Element ? event.target.closest(".tip") : null;
    if (target) hideTooltip(target);
  });
  document.addEventListener("click", event => {
    const target = event.target instanceof Element ? event.target.closest(".tip") : null;
    if (target) showTooltip(target); else hideTooltip();
  });
  document.addEventListener("keydown", event => { if (event.key === "Escape") hideTooltip(); });
  window.addEventListener("resize", () => { if (activeTooltipTarget) placeTooltip(activeTooltipTarget); });
  window.addEventListener("scroll", () => { if (activeTooltipTarget) placeTooltip(activeTooltipTarget); }, true);
}

function bindUI() {
  initTheme();
  installTooltips();
  $("themeToggleBtn")?.addEventListener("click", toggleTheme);
  $("refreshUniverseBtn").addEventListener("click", loadUniverse);
  $("scanAllBtn").addEventListener("click", runScanAll);
  $("exportBtn").addEventListener("click", exportCSV);
  $("coinSearch").addEventListener("input", renderUniverse);

  // Hidden selects fallback listeners
  $("universeFilter")?.addEventListener("change", () => {
    filterCategories.spot = new Set([$("universeFilter").value]);
    updateCategoryUI();
    renderUniverse();
  });
  for (const id of ["bbkcFilter", "emaFilter", "rsiFilter"]) {
    $(id)?.addEventListener("change", () => {
      const cat = id.replace("Filter", "");
      filterCategories[cat] = new Set([$(id).value]);
      updateCategoryUI();
      renderUniverse();
    });
  }

  // Category filter chips (Multi-select)
  document.querySelectorAll(".filter-chip").forEach(button => {
    button.addEventListener("click", () => {
      toggleCategoryFilter(button.dataset.cat, button.dataset.val);
    });
  });

  // Quick combo recipes
  document.querySelectorAll("#combosList .combo-btn").forEach(button => {
    button.addEventListener("click", () => {
      const combo = button.dataset.combo;
      if (combo === "all") {
        $("coinSearch").value = "";
        filterCategories.bbkc = new Set(["all"]);
        filterCategories.ema = new Set(["all"]);
        filterCategories.rsi = new Set(["all"]);
        filterCategories.spot = new Set(["all"]);
        filterCategories.tier = new Set(["all"]);
      } else if (combo === "alpha") {
        $("coinSearch").value = "";
        filterCategories.bbkc = new Set(["all"]);
        filterCategories.ema = new Set(["all"]);
        filterCategories.rsi = new Set(["all"]);
        filterCategories.spot = new Set(["available"]);
        filterCategories.tier = new Set(["S", "A"]);
        if ($("sortBy")) $("sortBy").value = "score";
        sortDescending = true;
      } else if (combo === "prime") {
        filterCategories.bbkc = new Set(["all"]);
        filterCategories.ema = new Set(["all"]);
        filterCategories.rsi = new Set(["all"]);
        filterCategories.spot = new Set(["all"]);
        filterCategories.tier = new Set(["S", "A"]);
        if ($("sortBy")) $("sortBy").value = "score";
        sortDescending = true;
      } else if (combo === "marketBreadthLead") {
        filterCategories.bbkc = new Set(["all"]);
        filterCategories.ema = new Set(["bull"]);
        filterCategories.rsi = new Set(["all"]);
        filterCategories.spot = new Set(["available"]);
        filterCategories.tier = new Set(["S", "A"]);
      } else if (combo === "squeeze") {
        filterCategories.bbkc = new Set(["squeeze"]);
        filterCategories.ema = new Set(["all"]);
        filterCategories.rsi = new Set(["all"]);
        filterCategories.tier = new Set(["all"]);
      } else if (combo === "release") {
        filterCategories.bbkc = new Set(["release"]);
        filterCategories.ema = new Set(["all"]);
        filterCategories.rsi = new Set(["all"]);
        filterCategories.tier = new Set(["all"]);
      } else if (combo === "activeExp") {
        filterCategories.bbkc = new Set(["release", "expand"]);
        filterCategories.ema = new Set(["all"]);
        filterCategories.rsi = new Set(["all"]);
        filterCategories.tier = new Set(["all"]);
      } else if (combo === "squeezeBull") {
        filterCategories.bbkc = new Set(["squeeze"]);
        filterCategories.ema = new Set(["bull"]);
        filterCategories.rsi = new Set(["all"]);
        filterCategories.tier = new Set(["all"]);
      } else if (combo === "bullExp") {
        filterCategories.bbkc = new Set(["release", "expand"]);
        filterCategories.ema = new Set(["bull"]);
        filterCategories.rsi = new Set(["all"]);
        filterCategories.tier = new Set(["all"]);
      } else if (combo === "extremes") {
        filterCategories.bbkc = new Set(["all"]);
        filterCategories.ema = new Set(["all"]);
        filterCategories.rsi = new Set(["low", "high"]);
        filterCategories.tier = new Set(["all"]);
      }
      updateCategoryUI();
      renderUniverse();
    });
  });

  // Advanced numeric filters toggle & inputs
  $("toggleAdvancedFiltersBtn")?.addEventListener("click", () => {
    const adv = $("advancedFilters");
    if (!adv) return;
    adv.hidden = !adv.hidden;
    $("toggleAdvancedFiltersBtn").setAttribute("aria-expanded", String(!adv.hidden));
  });

  // Beginner Playbook toggle
  $("togglePlaybookBtn")?.addEventListener("click", () => {
    const content = $("playbookContent");
    const icon = $("playbookToggleIcon");
    if (!content) return;
    const isHidden = content.hidden;
    content.hidden = !isHidden;
    icon?.classList.toggle("collapsed", !isHidden);
  });

  $("resetNumericFiltersBtn")?.addEventListener("click", () => {
    for (const id of ["minDiff", "maxDiff", "minEma", "maxEma", "minRsi", "maxRsi"]) {
      const el = $(id); if (el) el.value = "";
    }
    renderUniverse();
  });

  for (const id of ["minDiff", "maxDiff", "minEma", "maxEma", "minRsi", "maxRsi"]) {
    $(id)?.addEventListener("input", renderUniverse);
  }

  // Clear all filters
  $("clearFiltersBtn").addEventListener("click", () => {
    $("coinSearch").value = "";
    filterCategories.bbkc = new Set(["all"]);
    filterCategories.ema = new Set(["all"]);
    filterCategories.rsi = new Set(["all"]);
    filterCategories.spot = new Set(["all"]);
    filterCategories.tier = new Set(["all"]);
    for (const id of ["minDiff", "maxDiff", "minEma", "maxEma", "minRsi", "maxRsi"]) {
      const el = $(id); if (el) el.value = "";
    }
    updateCategoryUI();
    renderUniverse();
  });

  // Market Breadth quick filter buttons
  $("filterBreadthBestBtn")?.addEventListener("click", () => {
    filterCategories.bbkc = new Set(["all"]);
    filterCategories.ema = new Set(["bull"]);
    filterCategories.rsi = new Set(["all"]);
    filterCategories.spot = new Set(["all"]);
    filterCategories.tier = new Set(["S", "A"]);
    updateCategoryUI();
    renderUniverse();
  });
  $("filterBreadthSqueezeBtn")?.addEventListener("click", () => {
    filterCategories.bbkc = new Set(["squeeze"]);
    filterCategories.ema = new Set(["all"]);
    filterCategories.rsi = new Set(["all"]);
    filterCategories.spot = new Set(["all"]);
    filterCategories.tier = new Set(["S", "A"]);
    updateCategoryUI();
    renderUniverse();
  });
  $("filterBreadthLeadersBtn")?.addEventListener("click", () => {
    filterCategories.bbkc = new Set(["release", "expand"]);
    filterCategories.ema = new Set(["bull"]);
    filterCategories.rsi = new Set(["all"]);
    filterCategories.spot = new Set(["all"]);
    filterCategories.tier = new Set(["all"]);
    updateCategoryUI();
    renderUniverse();
  });

  $("sortBy").addEventListener("change", () => { sortDescending = true; renderUniverse(); });
  document.querySelectorAll(".sort-btn").forEach(button => button.addEventListener("click", () => {
    if ($("sortBy").value === button.dataset.sort) sortDescending = !sortDescending;
    else { $("sortBy").value = button.dataset.sort; sortDescending = true; }
    renderUniverse();
  }));
  $("scrollToTableBtn")?.addEventListener("click", () => {
    $("scannerSection")?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  $("rankCondition").addEventListener("change", renderResearch);
  $("levelLookback").addEventListener("change", () => renderLevelStudy());
  $("loadLevelStudyBtn").addEventListener("click", loadLevelStudy);
  $("horizon").addEventListener("change", () => { updateAllResearch(); renderStrategy(); });
  for (const id of ["feeBps", "slipBps"]) $(id).addEventListener("change", renderStrategy);
  $("runBacktestBtn").addEventListener("click", () => {
    const loaded = [...records.values()];
    if (!loaded.length) { setStatus("สแกนข้อมูลก่อนทำ backtest"); return; }
    $("runBacktestBtn").disabled = true;
    $("strategyState").textContent = "กำลังคำนวณ candidate ทุกเหรียญ…";
    setTimeout(() => { try { runAllBacktests(); setStatus(`Backtest เสร็จ · ${records.size} เหรียญ · pooled trades แสดงแยกจาก portfolio`); } finally { $("runBacktestBtn").disabled = false; } }, 20);
  });
  $("exportTradesBtn").addEventListener("click", exportTradeLedger);

  // Forecast View Listeners
  $("forecastCoinSelect")?.addEventListener("change", () => {
    const newId = $("forecastCoinSelect").value;
    if (newId) selectMember(newId).then(() => renderForecast());
  });
  $("forecastHorizon")?.addEventListener("change", renderForecast);
  $("forecastMode")?.addEventListener("change", renderForecast);

  document.querySelectorAll("[data-view]").forEach(button => button.addEventListener("click", () => {
    document.querySelectorAll("[data-view]").forEach(b => { b.classList.toggle("active", b === button); b.setAttribute("aria-pressed", b === button ? "true" : "false"); });
    document.querySelectorAll(".view").forEach(view => { view.hidden = view.id !== button.dataset.view; });
    if (button.dataset.view === "researchView") renderResearch();
    if (button.dataset.view === "strategyView") renderStrategy();
    if (button.dataset.view === "forecastView") renderForecast();
  }));
}

bindUI();
try { console.info(E.selfCheck()); } catch (error) { console.error(error); setStatus(`Research engine self-check failed: ${error.message}`); }
loadUniverse();
