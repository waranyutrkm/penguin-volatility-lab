# Penguin Volatility Lab

> **Institutional-Grade Crypto Volatility Scanner, Market Breadth Cockpit & Quantitative Research Terminal**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Architecture](https://img.shields.io/badge/Stack-Vanilla%20JS%20%7C%20HTML5%20%7C%20Node.js-10b981.svg)]()
[![Design System](https://img.shields.io/badge/Design-DTCG%20Tokens%20%7C%20WCAG%202.2%20AA-06b6d4.svg)](DESIGN.md)
[![Anti-Slop](https://img.shields.io/badge/Doctrine-Zero--Emoji%20Institutional-a855f7.svg)](AGENTS.md)

---

## 1. Executive Summary

**Penguin Volatility Lab** is an open-source quantitative trading terminal designed for systematic cryptocurrency researchers, options traders, and active market participants. It combines:
1. **Volatility Regime Detection:** Bollinger Bands (BB) vs. Keltner Channels (KC) spread dynamics (`diff`).
2. **Multi-Asset Market Breadth:** Real-time macro trend and volatility regime distribution across the **CoinMarketCap 100 (CMC100)** index cohort.
3. **Quant Composite Scoring (0–100):** Multi-factor scoring engine classifying assets into S/A/B/C quality tiers with deterministic signal badges (`[ALPHA BUY]`, `[PRIME COIL]`, `[EXPANDING]`, `[COIL A+]`, `[WATCHLIST]`, `[BEAR TRAP]`).
4. **Forward Volatility Cone (2SD Band):** Monte Carlo & statistical expected price path with $\pm 2\sigma\sqrt{t}$ expanding confidence cones (95.4% confidence interval).
5. **Candidate Long-Only Spot Backtester:** Rigorous execution simulation modeling realistic commission (bps), slippage (bps), next-bar open fills, and trade duration distributions.
6. **Beginner 3-Step Playbook:** Clear, accessible rulebooks answering *When to Buy*, *How Long to Hold*, and *When to Exit*.

Built entirely with **Vanilla JavaScript (ES6+), semantic HTML5, and CSS variables**, the platform requires zero heavy front-end build pipelines, transpilers, or external bundle dependencies.

---

## 2. Core Quantitative Architecture

### 2.1 Volatility Regime (`diff`) Engine
The core volatility indicator evaluates the spread between the Upper Bollinger Band (20, 2.0) and the Upper Keltner Channel (20, 1.5 ATR):
$$\text{diff}_t = \frac{\text{UpperBB}_t - \text{UpperKC}_t}{\text{UpperKC}_t} \times 100$$

- **Squeeze ($\text{diff} \le 0$):** Bollinger Bands compress inside Keltner Channels, indicating severe volatility contraction and energy accumulation.
- **Fresh Release ($\text{diff}_{t-1} \le 0 \land \text{diff}_t > 0$):** First bar where volatility explodes outside the channel (historical average runaway: 13.4 days).
- **Active Expansion ($\text{diff}_t > \text{diff}_{t-1} > 0$):** Accelerating volatility expansion favoring trend continuation.
- **Cooling ($\text{RSI}(\text{diff}) < \text{SMA}_7(\text{RSI}(\text{diff}))$):** Volatility exhaustion and deceleration phase.

### 2.2 Forward Volatility Cone ($\pm 2\sigma$)
The expected price path and probability boundaries are calculated using the asset's annualized historical volatility ($\sigma$) and drift ($\mu$):
$$\text{Upper Band}_t = S_0 \cdot \exp\left(\left(\mu - \frac{1}{2}\sigma^2\right) \cdot \frac{t}{365} + 2\sigma\sqrt{\frac{t}{365}}\right)$$
$$\text{Expected Path}_t = S_0 \cdot \exp\left(\mu \cdot \frac{t}{365}\right)$$
$$\text{Lower Band}_t = S_0 \cdot \exp\left(\left(\mu - \frac{1}{2}\sigma^2\right) \cdot \frac{t}{365} - 2\sigma\sqrt{\frac{t}{365}}\right)$$

### 2.3 Quant Composite Scoring System (0–100)
Every asset in the CMC100 cohort is scored dynamically across 5 quantitative pillars:
1. **Regime & Lifespan Timing (30 pts):** Rewards Day 1 Fresh Releases and Deep Annual Squeezes (Percentile $\le 20\%$); penalizes extended runs ($>13.4$ days).
2. **Trend Momentum & Macro Breakout (25 pts):** Confluence with Daily EMA12/EMA26 spread and breakouts beyond 20-day or 40-day highs (where backtests showed Profit Factor 6.91).
3. **Historical Statistical EDA Lift (20 pts):** Realized volatility expansion probability from empirical asset events.
4. **Price Structure & SMA20 Confluence (15 pts):** Location relative to the 20-day baseline.
5. **Exchange Liquidity & Spot Quality (10 pts):** Verified Binance Spot USDT pair liquidity and historical data depth ($>365$ bars).

| Score Tier | Grade | Label | Typical Setups |
|:---:|:---:|:---|:---|
| **85 – 100** | **S** | Prime Setup | `[ALPHA BUY]` (Release + 40D Breakout), `[PRIME COIL]` (Deep Squeeze near SMA20) |
| **70 – 84** | **A** | High Quality | `[EXPANDING]` (Active Volatility Expansion), `[COIL A+]` (Confirmed Squeeze) |
| **55 – 69** | **B** | Watchlist | `[WATCHLIST]` (Emerging conditions, awaiting confirmation) |
| **< 55** | **C** | Neutral / Avoid | `[BEAR TRAP]` (Release under EMA Bear), `[NEUTRAL]` (Unscanned/Rangebound) |

### 2.4 Market Breadth Cockpit
Provides institutional macro context before executing single-asset trades:
- **Trend Momentum Breadth:** Percentage of coins with $\text{EMA}_{12} > \text{EMA}_{26}$.
  - $\ge 55\%$: `[RISK-ON]` (Strong bull market backing trend breakouts).
  - $40\% - 55\%$: `[NEUTRAL]` (Selective market; stick to Grade S/A).
  - $< 40\%$: `[RISK-OFF]` (High risk of false breakouts).
- **Volatility Energy Breadth:** Squeeze % vs. Active Expansion % vs. Cooling %.

---

## 3. UI/UX Architecture & Standards

This project strictly adheres to **Senior Design Architect** standards (`plugin87/ux-ui-agent-skills` & `designmd.app`):

### 3.1 Strict Design Token Adherence (Ekasit's Law)
All visual styles, colors, border radii, spacings, and elevations are directly bound to tokens defined in [`DESIGN.md`](DESIGN.md):
- **Surfaces:** `--paper` (`#070a10`), `--white` (`#0e1524`), `--card-subtle` (`#121a2c`), `--card-hover` (`#18233c`)
- **Semantic Accents:** Teal (`#10b981`), Cyan (`#06b6d4`), Amber (`#f59e0b`), Crimson (`#f43f5e`), Purple (`#a855f7`)
- **Numerals:** Monospaced tabular numerals (`font-variant-numeric: tabular-nums`) across all tables, badges, and metrics.

### 3.2 Anti-Slop & Zero-Emoji Doctrine
As specified in [`AGENTS.md`](AGENTS.md), quantitative terminals avoid decorative emojis:
- No casual emojis in UI, headers, tags, or status indicators.
- Replaced by structured monospace badges (`[ALPHA BUY]`, `[PRIME COIL]`, `[RISK-ON]`), geometric glyphs (`▲`, `▼`, `●`, `—`), or crisp inline SVGs.

### 3.3 Full-Width Deep-Dive Studio
Designed to eliminate cramped side panels:
- Top view provides a master screener with multi-select categorical filters and market breadth cockpit.
- Bottom view delivers a full-width (100% desktop width) deep-dive studio for the selected cryptocurrency, featuring hero identity metadata, score radar breakdown, KPI cards, and forward projection cones.

---

## 4. Getting Started

### 4.1 Prerequisites
- **Node.js** v18.0.0 or higher
- An active internet connection (to fetch public data from CoinMarketCap and Binance Klines)

### 4.2 Quick Start
1. **Clone the repository:**
   ```bash
   git clone https://github.com/waranyutrkm/penguin-volatility-lab.git
   cd penguin-volatility-lab
   ```

2. **Launch the local terminal server:**
   ```bash
   npm start
   # or run directly:
   node server.js
   ```

3. **Open in your browser:**
   Navigate to [http://127.0.0.1:8765](http://127.0.0.1:8765)

### 4.3 Available Scripts
- `npm start`: Starts the local HTTP proxy server and static asset host.
- `npm test`: Runs JavaScript syntax and integrity checks (`node --check`).

---

## 5. Repository Structure

```
penguin-volatility-lab/
├── index.html              # Main terminal user interface & layouts
├── app.js                  # Frontend state machine, scoring engine & chart renderers
├── research.js             # Mathematical indicator engine, event studies & backtest simulator
├── server.js               # Lightweight Node.js caching proxy for CMC100 API & static server
├── DESIGN.md               # DTCG 3-tier design token definitions & visual foundation
├── AGENTS.md               # AI Agent operating rules & anti-slop doctrine
├── package.json            # Project manifest and scripts
├── LICENSE                 # MIT Open Source License
└── .gitignore              # Standard git exclusions
```

---

## 6. How to Extend & Contribute

Penguin Volatility Lab is designed to be easily extensible by the quant community:
- **Add New Indicators:** Implement new technical or statistical indicators in `research.js` under the `PenguinResearch` module.
- **Tune Quant Scoring Weights:** Adjust factor weights and score thresholds in `computeCoinScore()` inside `app.js`.
- **Integrate Additional Exchanges:** Add support for Bybit, OKX, or Deribit data feeds in `fetchKlines()` in `app.js`.
- **Custom Backtest Rules:** Extend candidate strategies in `runBacktest()` inside `research.js` (e.g., adding dynamic ATR trailing stops, funding rate filters, or multi-horizon scaling).

Contributions, bug reports, and pull requests are warmly welcomed!

---

## 7. Institutional Disclaimer

> **IMPORTANT NOTICE:** This software is for **educational, exploratory, and quantitative research purposes only**. It does not constitute investment advice, financial analysis, or trading recommendations. Historical statistical edges and backtested returns do not guarantee future performance. Cryptocurrencies and derivatives carry substantial market risks. Always conduct independent verification and manage capital responsibly.

---

## 8. License

This project is licensed under the [MIT License](LICENSE).
