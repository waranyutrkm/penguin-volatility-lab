/* Pure research engine: Pine-compatible BB/KC, conditional event study and an explicit spot-only candidate. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PenguinResearch = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const DAY_MS = 86400000;
  const PERIOD = 20;
  const CONDITIONS = [
    { key: "all", label: "ฐาน · ทุกวัน", rule: "ทุกวันที่มีข้อมูลครบ โดยไม่กรองสถานะ" },
    { key: "squeeze", label: "Compression · diff ≤ 0", rule: "BB แคบกว่าหรือเท่ากับ KC ณ วัน t" },
    { key: "deep", label: "Deep squeeze · percentile ≤ 20", rule: "diff ≤ 0 และ rolling percentile 252 วัน ≤ 20 (ต้องมีอย่างน้อย 60 ค่า)" },
    { key: "release", label: "Release · ข้ามศูนย์ขึ้น", rule: "diff[t−1] ≤ 0 และ diff[t] > 0" },
    { key: "rising", label: "Expansion · diff บวกและเพิ่ม", rule: "diff[t] > 0 และ diff[t] > diff[t−1]" },
    { key: "cooling", label: "Cooling · RSI(diff) ต่ำกว่า SMA7", rule: "diff > 0 และ RSI14(diff) < SMA7 ของ RSI(diff)" },
    { key: "rsiCrossUp", label: "RSI(diff) cross ขึ้น", rule: "RSI14(diff) ตัดขึ้นเหนือ SMA7 ของ RSI(diff)" },
    { key: "rsiCrossDown", label: "RSI(diff) cross ลง", rule: "RSI14(diff) ตัดลงใต้ SMA7 ของ RSI(diff)" },
    { key: "emaBull", label: "EMA momentum บวก · EMA12 > EMA26", rule: "EMA12 ของ close Daily อยู่เหนือ EMA26 ณ แท่งปิด" },
    { key: "emaBear", label: "EMA momentum ลบ · EMA12 < EMA26", rule: "EMA12 ของ close Daily อยู่ใต้ EMA26 ณ แท่งปิด" }
  ];

  function sma(values, length) {
    const out = Array(values.length).fill(null);
    for (let i = length - 1; i < values.length; i++) {
      const w = values.slice(i - length + 1, i + 1);
      if (w.every(Number.isFinite)) out[i] = w.reduce((a, b) => a + b, 0) / length;
    }
    return out;
  }
  function ema(values, length) {
    if (!Number.isInteger(length) || length < 1) throw new Error("EMA length must be a positive integer");
    const out = Array(values.length).fill(null), alpha = 2 / (length + 1);
    let previous = null;
    for (let i = 0; i < values.length; i++) {
      const value = values[i];
      if (value == null || !Number.isFinite(value)) { previous = null; continue; }
      previous = previous == null ? value : alpha * value + (1 - alpha) * previous;
      out[i] = previous;
    }
    return out;
  }
  function rma(values, length) {
    const out = Array(values.length).fill(null);
    let seed = [], prev = null;
    for (let i = 0; i < values.length; i++) {
      const x = values[i];
      if (x == null || !Number.isFinite(x)) { seed = []; prev = null; continue; }
      if (prev == null) {
        seed.push(x);
        if (seed.length === length) {
          prev = seed.reduce((a, b) => a + b, 0) / length;
          out[i] = prev;
        }
      } else {
        prev = (prev * (length - 1) + x) / length;
        out[i] = prev;
      }
    }
    return out;
  }
  function computeSegment(bars) {
    const n = bars.length, close = bars.map(b => b.close), tr = Array(n);
    for (let i = 0; i < n; i++) {
      tr[i] = i === 0
        ? bars[i].high - bars[i].low
        : Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - close[i - 1]), Math.abs(bars[i].low - close[i - 1]));
    }
    const basis = sma(close, PERIOD), sd = Array(n).fill(null), atr = rma(tr, PERIOD);
    const ema12 = ema(close, 12), ema26 = ema(close, 26);
    for (let i = PERIOD - 1; i < n; i++) {
      const w = close.slice(i - PERIOD + 1, i + 1);
      const mean = w.reduce((a, b) => a + b, 0) / PERIOD;
      sd[i] = Math.sqrt(w.reduce((a, b) => a + (b - mean) ** 2, 0) / PERIOD);
    }
    const diff = Array(n).fill(null), atrPct = Array(n).fill(null);
    for (let i = 0; i < n; i++) {
      if (basis[i] == null || sd[i] == null || atr[i] == null) continue;
      const upperBB = basis[i] + 2 * sd[i], upperKC = basis[i] + 2 * atr[i];
      if (upperKC !== 0) diff[i] = (upperBB - upperKC) / upperKC * 100;
      if (close[i] !== 0) atrPct[i] = atr[i] / close[i] * 100;
    }
    const change = diff.map((x, i) => i > 0 && x != null && diff[i - 1] != null ? x - diff[i - 1] : null);
    const gains = change.map(x => x == null ? null : Math.max(x, 0));
    const losses = change.map(x => x == null ? null : Math.max(-x, 0));
    const avgGain = rma(gains, 14), avgLoss = rma(losses, 14), rsi = Array(n).fill(null);
    for (let i = 0; i < n; i++) {
      if (avgGain[i] != null && avgLoss[i] != null) {
        rsi[i] = avgLoss[i] === 0 ? 100 : avgGain[i] === 0 ? 0 : 100 - 100 / (1 + avgGain[i] / avgLoss[i]);
      }
    }
    return { diff, rsi, rsiSmooth: sma(rsi, 7), atrPct, ema12, ema26 };
  }
  function computeIndicators(bars, intervalMs = DAY_MS) {
    const n = bars.length, diff = Array(n).fill(null), rsi = Array(n).fill(null), rsiSmooth = Array(n).fill(null), atrPct = Array(n).fill(null), ema12 = Array(n).fill(null), ema26 = Array(n).fill(null), segment = Array(n).fill(-1);
    let start = 0, segmentNo = 0, gaps = 0;
    for (let i = 1; i <= n; i++) {
      if (i < n && bars[i].time - bars[i - 1].time === intervalMs) continue;
      if (i < n) gaps++;
      const local = computeSegment(bars.slice(start, i));
      for (let j = 0; j < local.diff.length; j++) {
        const k = start + j;
        diff[k] = local.diff[j]; rsi[k] = local.rsi[j]; rsiSmooth[k] = local.rsiSmooth[j]; atrPct[k] = local.atrPct[j];
        ema12[k] = local.ema12[j]; ema26[k] = local.ema26[j]; segment[k] = segmentNo;
      }
      start = i; segmentNo++;
    }
    const percentile = Array(n).fill(null);
    let segStart = 0;
    for (let i = 0; i < n; i++) {
      if (i === 0 || segment[i] !== segment[i - 1]) segStart = i;
      if (diff[i] == null) continue;
      const from = Math.max(segStart, i - 251);
      let count = 0, below = 0;
      for (let j = from; j <= i; j++) {
        if (diff[j] == null) continue;
        count++;
        if (diff[j] <= diff[i]) below++;
      }
      if (count >= 60) percentile[i] = below / count;
    }
    return { diff, rsi, rsiSmooth, atrPct, ema12, ema26, percentile, segment, gaps };
  }
  function classify(diff, previous) {
    if (diff == null) return { key: "na", label: "รอข้อมูล" };
    if (diff <= 0) return { key: "squeeze", label: "บีบตัว" };
    if (previous != null && previous <= 0) return { key: "release", label: "เพิ่ง Release" };
    if (previous != null && diff > previous) return { key: "expand", label: "ขยายต่อ" };
    return { key: "cool", label: "เริ่มชะลอ" };
  }
  function classifyEma(fast, slow) {
    if (!Number.isFinite(fast) || !Number.isFinite(slow)) return { key: "na", label: "รอข้อมูล" };
    if (fast > slow) return { key: "bull", label: "โมเมนตัมบวก" };
    if (fast < slow) return { key: "bear", label: "โมเมนตัมลบ" };
    return { key: "flat", label: "เป็นกลาง" };
  }
  function median(values) {
    if (!values.length) return null;
    const s = [...values].sort((a, b) => a - b), m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  function makeAccumulator() { return { n: 0, persistWins: 0, compressionAtEndWins: 0, expandWins: 0, upWins: 0, forwardRvs: [], sumReturn: 0 }; }
  function addOutcome(acc, outcome) {
    acc.n++;
    acc.persistWins += outcome.persist ? 1 : 0;
    acc.compressionAtEndWins += outcome.compressionAtEnd ? 1 : 0;
    acc.expandWins += outcome.expand ? 1 : 0;
    acc.upWins += outcome.up ? 1 : 0;
    acc.forwardRvs.push(outcome.forwardRV);
    acc.sumReturn += outcome.forwardReturn;
  }
  function eventStudy(bars, ind, horizon = 5) {
    const H = Math.max(1, Math.floor(horizon)), stats = Object.fromEntries(CONDITIONS.map(c => [c.key, makeAccumulator()]));
    const n = bars.length, persistThreshold = Math.ceil(H * 0.6);
    for (let i = 20; i + H < n; i++) {
      if (ind.diff[i] == null) continue;
      const seg = ind.segment[i];
      let valid = true;
      for (let j = i - 20; j <= i + H; j++) {
        if (ind.segment[j] !== seg || (j >= i && ind.diff[j] == null)) { valid = false; break; }
      }
      if (!valid) continue;
      let previousSq = 0, forwardSq = 0, positiveDiffs = 0;
      for (let k = i - 19; k <= i; k++) previousSq += Math.log(bars[k].close / bars[k - 1].close) ** 2;
      for (let k = i + 1; k <= i + H; k++) {
        forwardSq += Math.log(bars[k].close / bars[k - 1].close) ** 2;
        if (ind.diff[k] > 0) positiveDiffs++;
      }
      const priorScaled = Math.sqrt(previousSq * H / 20), forwardRV = Math.sqrt(forwardSq);
      const forwardReturn = bars[i + H].close / bars[i].close - 1;
      const outcome = { persist: positiveDiffs >= persistThreshold, compressionAtEnd: ind.diff[i + H] <= 0, expand: forwardRV > priorScaled, up: forwardReturn > 0, forwardRV, forwardReturn };
      const d = ind.diff[i], p = ind.diff[i - 1], r = ind.rsi[i], rs = ind.rsiSmooth[i];
      addOutcome(stats.all, outcome);
      if (d <= 0) {
        addOutcome(stats.squeeze, outcome);
        if (ind.percentile[i] != null && ind.percentile[i] <= 0.2) addOutcome(stats.deep, outcome);
      }
      if (d > 0 && p != null && p <= 0) addOutcome(stats.release, outcome);
      if (d > 0 && p != null && d > p) addOutcome(stats.rising, outcome);
      if (d > 0 && r != null && rs != null && r < rs) addOutcome(stats.cooling, outcome);
      const priorRsi = ind.rsi[i - 1], priorSmooth = ind.rsiSmooth[i - 1];
      if (r != null && rs != null && priorRsi != null && priorSmooth != null) {
        if (priorRsi <= priorSmooth && r > rs) addOutcome(stats.rsiCrossUp, outcome);
        if (priorRsi >= priorSmooth && r < rs) addOutcome(stats.rsiCrossDown, outcome);
      }
      if (ind.ema12?.[i] != null && ind.ema26?.[i] != null) {
        if (ind.ema12[i] > ind.ema26[i]) addOutcome(stats.emaBull, outcome);
        if (ind.ema12[i] < ind.ema26[i]) addOutcome(stats.emaBear, outcome);
      }
    }
    return stats;
  }
  function summarize(acc) {
    if (!acc || !acc.n) return { n: 0, persistence: null, compressionAtEnd: null, expansion: null, medianRV: null, positive: null, meanReturn: null };
    return {
      n: acc.n,
      persistence: acc.persistWins / acc.n,
      compressionAtEnd: acc.compressionAtEndWins / acc.n,
      expansion: acc.expandWins / acc.n,
      medianRV: median(acc.forwardRvs),
      positive: acc.upWins / acc.n,
      meanReturn: acc.sumReturn / acc.n
    };
  }
  function rankStudies(studies, conditionKey, minSamples = 10) {
    if (!CONDITIONS.some(condition => condition.key === conditionKey)) throw new Error(`Unknown EDA condition: ${conditionKey}`);
    const rows = studies.map(study => {
      const baseline = summarize(study.events?.all), condition = summarize(study.events?.[conditionKey]);
      const lift = baseline.expansion == null || condition.expansion == null ? null : condition.expansion - baseline.expansion;
      return { ...study, sampleN: condition.n, conditionalExpansion: condition.expansion, baselineExpansion: baseline.expansion, lift, persistence: condition.persistence, eligible: condition.n >= minSamples && lift != null };
    }).sort((a, b) => {
      if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
      if (a.eligible && a.lift !== b.lift) return b.lift - a.lift;
      return b.sampleN - a.sampleN || String(a.member?.symbol || a.symbol || "").localeCompare(String(b.member?.symbol || b.symbol || ""));
    });
    let rank = 0;
    return rows.map(row => ({ ...row, rank: row.eligible ? ++rank : null }));
  }
  function analyzeCrossHighLevels(bars, ind, tolerancePct = 0.1) {
    const tolerance = Math.max(0, Number(tolerancePct) || 0) / 100, levels = [];
    for (let i = 1; i < bars.length; i++) {
      const previous = ind.rsi[i - 1], previousSmooth = ind.rsiSmooth[i - 1], current = ind.rsi[i], currentSmooth = ind.rsiSmooth[i];
      if (![previous, previousSmooth, current, currentSmooth].every(Number.isFinite)) continue;
      const crossedUp = previous <= previousSmooth && current > currentSmooth;
      const crossedDown = previous >= previousSmooth && current < currentSmooth;
      if (crossedUp || crossedDown) levels.push({ index: i, time: bars[i].time, price: bars[i].high, direction: crossedUp ? "up" : "down" });
    }
    const upBreaks = [], downBreaks = [], testsBelow = [], testsAbove = [];
    for (let k = 0; k < levels.length; k++) {
      const level = levels[k], end = levels[k + 1]?.index ?? bars.length;
      level.endIndex = end;
      let seenBelow = false, seenAbove = false, broken = false;
      for (let i = level.index + 1; i < end; i++) {
        const previousClose = bars[i - 1].close, close = bars[i].close;
        const rangeTouches = bars[i].high >= level.price * (1 - tolerance) && bars[i].low <= level.price * (1 + tolerance);
        if (!seenBelow && previousClose < level.price && rangeTouches) {
          testsBelow.push({ level, index: i, rejected: close <= level.price }); seenBelow = true;
        }
        if (!seenAbove && previousClose > level.price && rangeTouches) {
          testsAbove.push({ level, index: i, held: close >= level.price }); seenAbove = true;
        }
        if (!broken && previousClose <= level.price && close > level.price * (1 + tolerance)) {
          upBreaks.push({ level, index: i }); broken = true;
        } else if (!broken && previousClose >= level.price && close < level.price * (1 - tolerance)) {
          downBreaks.push({ level, index: i }); broken = true;
        }
      }
    }
    const outcome = (events, horizon, direction) => {
      const valid = events.filter(event => event.index + horizon < bars.length);
      if (!valid.length) return { n: 0, holdRate: null, medianReturn: null, meanReturn: null };
      const sign = direction === "up" ? 1 : -1;
      const returns = valid.map(event => (bars[event.index + horizon].close / bars[event.index].close - 1) * sign);
      const holds = valid.filter(event => direction === "up" ? bars[event.index + horizon].close > event.level.price : bars[event.index + horizon].close < event.level.price).length;
      return { n: valid.length, holdRate: holds / valid.length, medianReturn: median(returns), meanReturn: returns.reduce((sum, value) => sum + value, 0) / valid.length };
    };
    const falseUp = upBreaks.filter(event => event.index + 6 < bars.length);
    const falseUpCount = falseUp.filter(event => bars.slice(event.index + 1, event.index + 7).some(bar => bar.close <= event.level.price)).length;
    const retestEvents = upBreaks.flatMap(event => {
      const end = Math.min(bars.length, event.index + 25);
      for (let i = event.index + 1; i < end; i++) {
        if (bars[i].low <= event.level.price * (1 + tolerance) && bars[i].high >= event.level.price * (1 - tolerance)) return [{ held: bars[i].close >= event.level.price }];
      }
      return [];
    });
    return {
      tolerancePct: tolerance * 100, levels,
      testsBelow: { n: testsBelow.length, rejectedRate: testsBelow.length ? testsBelow.filter(event => event.rejected).length / testsBelow.length : null },
      testsAbove: { n: testsAbove.length, heldRate: testsAbove.length ? testsAbove.filter(event => event.held).length / testsAbove.length : null },
      upBreaks: { n: upBreaks.length, falseBreak6N: falseUp.length, falseBreak6Rate: falseUp.length ? falseUpCount / falseUp.length : null, outcomes: { h6: outcome(upBreaks, 6, "up"), h24: outcome(upBreaks, 24, "up"), h72: outcome(upBreaks, 72, "up") }, supportRetest: { n: retestEvents.length, heldRate: retestEvents.length ? retestEvents.filter(event => event.held).length / retestEvents.length : null } },
      downBreaks: { n: downBreaks.length, outcomes: { h6: outcome(downBreaks, 6, "down"), h24: outcome(downBreaks, 24, "down"), h72: outcome(downBreaks, 72, "down") } }
    };
  }
  function aggregateStudies(records, horizon = 5) {
    const byCondition = Object.fromEntries(CONDITIONS.map(c => [c.key, { descriptor: c, n: 0, coins: [], forwardRvs: [], persistWins: 0, compressionAtEndWins: 0, expandWins: 0, upWins: 0, sumReturn: 0 }]));
    for (const record of records) {
      const ev = record.events || eventStudy(record.dailyBars, record.daily, horizon);
      for (const c of CONDITIONS) {
        const item = ev[c.key];
        if (!item || !item.n) continue;
        const a = byCondition[c.key];
        a.n += item.n; a.persistWins += item.persistWins; a.compressionAtEndWins += item.compressionAtEndWins; a.expandWins += item.expandWins; a.upWins += item.upWins; a.sumReturn += item.sumReturn;
        a.forwardRvs.push(...item.forwardRvs);
        a.coins.push(summarize(item));
      }
    }
    return CONDITIONS.map(c => {
      const a = byCondition[c.key], valid = a.coins.filter(x => x.n >= 10);
      const avg = key => valid.length ? valid.reduce((s, x) => s + x[key], 0) / valid.length : null;
      return {
        key: c.key, label: c.label, rule: c.rule, n: a.n, symbols: a.coins.length, symbolsStable: valid.length,
        pooledPersistence: a.n ? a.persistWins / a.n : null, equalCoinPersistence: avg("persistence"),
        pooledCompressionAtEnd: a.n ? a.compressionAtEndWins / a.n : null, equalCoinCompressionAtEnd: avg("compressionAtEnd"),
        pooledExpansion: a.n ? a.expandWins / a.n : null, equalCoinExpansion: avg("expansion"),
        pooledMedianRV: median(a.forwardRvs), equalCoinMedianRV: avg("medianRV"),
        pooledPositive: a.n ? a.upWins / a.n : null, equalCoinPositive: avg("positive"),
        pooledMeanReturn: a.n ? a.sumReturn / a.n : null
      };
    });
  }
  function costAdjustedReturn(entry, exit, feeBps, slippageBps) {
    const fee = Math.max(0, feeBps) / 10000, slip = Math.max(0, slippageBps) / 10000;
    return (exit / entry) * ((1 - slip) * (1 - fee)) / ((1 + slip) * (1 + fee)) - 1;
  }
  function maxDrawdown(returns) {
    let equity = 1, peak = 1, dd = 0;
    for (const r of returns) {
      equity *= 1 + r;
      peak = Math.max(peak, equity);
      dd = Math.min(dd, equity / peak - 1);
    }
    return dd;
  }
  function runBacktest(bars, ind, options = {}) {
    const H = Math.max(1, Math.floor(options.horizon || 5)), lookback = Math.max(2, Math.floor(options.breakoutLookback || 20));
    const feeBps = Math.max(0, Number(options.feeBps ?? 10)), slippageBps = Math.max(0, Number(options.slippageBps ?? 5));
    const start = Math.max(0, Math.floor(options.startIndex || 0)), end = Math.min(bars.length, Math.floor(options.endIndex ?? bars.length));
    const trades = [];
    let eligibleAt = start;
    for (let i = Math.max(start, lookback); i + H < end; i++) {
      if (i < eligibleAt || ind.diff[i - 1] == null || ind.diff[i] == null || ind.diff[i - 1] > 0 || ind.diff[i] <= 0) continue;
      const seg = ind.segment[i];
      let valid = true, previousHigh = -Infinity;
      for (let j = i - lookback; j <= i + H; j++) {
        if (ind.segment[j] !== seg) { valid = false; break; }
        if (j < i) previousHigh = Math.max(previousHigh, bars[j].high);
      }
      if (!valid || !(bars[i].close > previousHigh)) continue;
      const entryIndex = i + 1, exitIndex = i + H;
      const entry = bars[entryIndex]?.open, exit = bars[exitIndex]?.close;
      if (!(entry > 0 && exit > 0)) continue;
      const grossReturn = exit / entry - 1;
      const netReturn = costAdjustedReturn(entry, exit, feeBps, slippageBps);
      trades.push({ signalIndex: i, entryIndex, exitIndex, signalTime: bars[i].time, entryTime: bars[entryIndex].time, exitTime: bars[exitIndex].closeTime ?? bars[exitIndex].time, entry, exit, grossReturn, netReturn, holdBars: H });
      eligibleAt = exitIndex;
    }
    const net = trades.map(t => t.netReturn), wins = net.filter(x => x > 0), losses = net.filter(x => x < 0);
    const gainSum = wins.reduce((a, b) => a + b, 0), lossSum = -losses.reduce((a, b) => a + b, 0);
    const first = bars[Math.max(0, start)], last = bars[Math.max(0, end - 1)];
    const buyHold = first && last && first.open > 0 ? costAdjustedReturn(first.open, last.close, feeBps, slippageBps) : null;
    return {
      trades, n: trades.length, winRate: net.length ? wins.length / net.length : null,
      meanNet: net.length ? net.reduce((a, b) => a + b, 0) / net.length : null,
      medianNet: median(net), profitFactor: lossSum ? gainSum / lossSum : gainSum ? Infinity : null,
      compounded: net.reduce((e, r) => e * (1 + r), 1) - 1, maxDrawdown: maxDrawdown(net), buyHold,
      startIndex: start, endIndex: end
    };
  }
  function timeSlices(n) {
    const a = Math.floor(n * 0.6), b = Math.floor(n * 0.8);
    return [
      { key: "early", label: "ช่วงต้น · 60%", startIndex: 0, endIndex: a },
      { key: "middle", label: "ช่วงกลาง · 20%", startIndex: a, endIndex: b },
      { key: "late", label: "ช่วงท้าย · 20%", startIndex: b, endIndex: n }
    ];
  }
  function aggregateBacktests(results, splitKey) {
    const available = results.map(r => r.backtests?.[splitKey]).filter(Boolean);
    const trades = available.flatMap(x => x.trades), net = trades.map(t => t.netReturn), wins = net.filter(x => x > 0), losses = net.filter(x => x < 0);
    const gain = wins.reduce((a, b) => a + b, 0), loss = -losses.reduce((a, b) => a + b, 0);
    const traded = available.filter(x => x.n > 0);
    return {
      n: net.length, symbols: traded.length, winRate: net.length ? wins.length / net.length : null,
      meanNet: net.length ? net.reduce((a, b) => a + b, 0) / net.length : null,
      medianNet: median(net), profitFactor: loss ? gain / loss : gain ? Infinity : null,
      equalCoinCompound: traded.length ? traded.reduce((s, x) => s + x.compounded, 0) / traded.length : null,
      positiveCoins: traded.filter(x => x.compounded > 0).length,
      warning: "Pooled trade distribution; not a shared-account portfolio simulation."
    };
  }
  function selfCheck() {
    const assert = (condition, message) => { if (!condition) throw new Error(message); };
    const flat = Array.from({ length: 40 }, (_, i) => ({ time: i * DAY_MS, open: 100, high: 101, low: 99, close: 100, closeTime: (i + 1) * DAY_MS - 1 }));
    const indFlat = computeIndicators(flat, DAY_MS);
    const expected = (100 - 104) / 104 * 100;
    assert(Math.abs(indFlat.diff[19] - expected) < 1e-9, "BB/KC Pine formula mismatch");
    assert(indFlat.rsi[39] === 100, "flat RSI edge mismatch");
    assert(Math.abs(ema([1, 2, 3], 2)[1] - 5 / 3) < 1e-12, "EMA recursion mismatch");
    assert(classifyEma(2, 1).key === "bull" && classifyEma(1, 2).key === "bear", "EMA momentum classification mismatch");
    assert(eventStudy(flat, indFlat, 5).all.n === 15, "5-bar event sample count mismatch");
    const bars = Array.from({ length: 36 }, (_, i) => ({ time: i * DAY_MS, open: 100, high: 101, low: 99, close: 100, closeTime: (i + 1) * DAY_MS - 1 }));
    for (let i = 25; i < bars.length; i++) {
      const close = 102 + i - 25;
      bars[i] = { ...bars[i], open: i === 25 ? 100 : bars[i - 1].close, high: close + 1, low: close - 1, close, closeTime: (i + 1) * DAY_MS - 1 };
    }
    const mockInd = { diff: Array(36).fill(-1), segment: Array(36).fill(0) };
    mockInd.diff[25] = 1;
    const bt = runBacktest(bars, mockInd, { horizon: 5, feeBps: 0, slippageBps: 0 });
    assert(bt.n === 1 && bt.trades[0].entryIndex === 26 && bt.trades[0].exitIndex === 30, "next-open/fixed-horizon backtest timing mismatch");
    assert(bt.trades[0].netReturn > 0, "backtest return calculation mismatch");
    const makeStat = (n, wins) => ({ n, persistWins: 0, compressionAtEndWins: 0, expandWins: wins, upWins: 0, forwardRvs: Array(n).fill(1), sumReturn: 0 });
    const ranked = rankStudies([
      { symbol: "A", events: { all: makeStat(20, 10), release: makeStat(10, 8) } },
      { symbol: "B", events: { all: makeStat(20, 10), release: makeStat(10, 5) } }
    ], "release", 10);
    assert(ranked[0].symbol === "A" && ranked[0].rank === 1 && ranked[0].lift > ranked[1].lift, "EDA interest ranking mismatch");
    const levelBars = Array.from({ length: 100 }, (_, i) => ({ time: i * 3600000, open: 100, high: 101, low: 99, close: 100, volume: 1 }));
    levelBars[30] = { ...levelBars[30], open: 109, high: 110, low: 108, close: 109 };
    levelBars[31] = { ...levelBars[31], open: 109, high: 112, low: 109.9, close: 111 };
    for (let i = 32; i < 100; i++) levelBars[i] = { ...levelBars[i], open: 110.8, high: 112, low: 110.5, close: 111 };
    levelBars[35] = { ...levelBars[35], open: 111, high: 111.2, low: 109.9, close: 110.5 };
    levelBars[70] = { ...levelBars[70], open: 111, high: 120, low: 117, close: 118 };
    const levelInd = { rsi: Array(100).fill(40), rsiSmooth: Array(100).fill(50) };
    for (let i = 30; i < 70; i++) levelInd.rsi[i] = 60;
    const levelCheck = analyzeCrossHighLevels(levelBars, levelInd);
    assert(levelCheck.levels.length === 2 && levelCheck.upBreaks.n === 1 && levelCheck.upBreaks.outcomes.h24.n === 1, "cross-high breakout study mismatch");
    assert(levelCheck.upBreaks.supportRetest.n === 1 && levelCheck.upBreaks.supportRetest.heldRate === 1, "post-break support retest mismatch");
    return "Research engine checks passed: Pine BB/KC, RSI flat edge, EMA, EDA lift ranking, cross-high break/retest, event horizon, next-open and fixed-horizon entry/exit.";
  }
  return { DAY_MS, PERIOD, CONDITIONS, sma, ema, rma, computeIndicators, classify, classifyEma, eventStudy, summarize, rankStudies, analyzeCrossHighLevels, aggregateStudies, runBacktest, timeSlices, aggregateBacktests, selfCheck };
});
