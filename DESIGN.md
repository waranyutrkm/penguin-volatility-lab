---
version: "1.0.0"
design_system: "Obsidian Quant Terminal"
author: "Antigravity & plugin87/ux-ui-agent-skills"
standards:
  accessibility: "WCAG 2.2 AA"
  token_format: "DTCG (Design Tokens Community Group)"
  anti_slop: true

tokens:
  color:
    primitive:
      navy-950: "#070a10"
      navy-900: "#0a0f1d"
      navy-850: "#0e1524"
      navy-800: "#121a2c"
      navy-750: "#162035"
      navy-700: "#1e2c48"
      slate-500: "#64748b"
      slate-400: "#94a3b8"
      slate-200: "#e2e8f0"
      slate-100: "#f1f5f9"
      white: "#ffffff"
      emerald-400: "#34d399"
      emerald-500: "#10b981"
      emerald-600: "#059669"
      cyan-400: "#22d3ee"
      cyan-500: "#06b6d4"
      cyan-600: "#0891b2"
      purple-400: "#c084fc"
      purple-500: "#a855f7"
      purple-600: "#7c3aed"
      amber-400: "#fbbf24"
      amber-500: "#f59e0b"
      amber-600: "#d97706"
      rose-400: "#fb7185"
      rose-500: "#f43f5e"
      rose-600: "#e11d48"

    semantic:
      surface:
        canvas: "var(--navy-950)"
        card: "var(--navy-850)"
        card-subtle: "var(--navy-800)"
        card-hover: "var(--navy-750)"
        overlay: "rgba(10, 15, 29, 0.85)"
      text:
        primary: "var(--slate-100)"
        secondary: "var(--slate-400)"
        muted: "var(--slate-500)"
        accent-teal: "var(--emerald-400)"
        accent-cyan: "var(--cyan-400)"
        accent-purple: "var(--purple-400)"
        accent-amber: "var(--amber-400)"
        accent-rose: "var(--rose-400)"
      border:
        subtle: "rgba(255, 255, 255, 0.08)"
        highlight: "rgba(255, 255, 255, 0.05)"
        focus: "var(--cyan-500)"
        teal: "rgba(16, 185, 129, 0.35)"
        blue: "rgba(6, 182, 212, 0.35)"
        amber: "rgba(245, 158, 11, 0.35)"
        rose: "rgba(244, 63, 94, 0.35)"
      intent:
        bull: "var(--emerald-500)"
        bear: "var(--rose-500)"
        squeeze: "var(--cyan-500)"
        expansion: "var(--emerald-400)"
        cooling: "var(--purple-500)"
        warning: "var(--amber-500)"

  typography:
    font_family:
      sans: "-apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', Roboto, sans-serif"
      mono: "ui-monospace, 'SF Mono', 'JetBrains Mono', Menlo, Consolas, monospace"
    font_size:
      xs: "10px"
      sm: "11.5px"
      base: "13px"
      md: "15px"
      lg: "18px"
      xl: "22px"
      "2xl": "30px"
    font_weight:
      regular: 400
      medium: 550
      semibold: 650
      bold: 750
      extrabold: 850
      black: 900
    line_height:
      tight: 1.15
      normal: 1.45
      relaxed: 1.6

  spacing:
    "1": "4px"
    "2": "8px"
    "3": "12px"
    "4": "16px"
    "5": "20px"
    "6": "24px"
    "8": "32px"
    "12": "48px"

  radii:
    sm: "6px"
    md: "10px"
    lg: "14px"
    full: "9999px"

  shadows:
    sm: "0 2px 8px rgba(0, 0, 0, 0.3)"
    md: "0 4px 16px rgba(0, 0, 0, 0.45)"
    lg: "0 8px 32px rgba(0, 0, 0, 0.6)"
    glow-teal: "0 0 16px rgba(16, 185, 129, 0.25)"
    glow-cyan: "0 0 16px rgba(6, 182, 212, 0.25)"
    glow-purple: "0 0 16px rgba(168, 85, 247, 0.25)"
---

# DESIGN.md — Obsidian Quant Terminal Design System

This file serves as the single source of truth for the UX/UI of the Bitcoin Options & Volatility Quant Terminal.
AI coding agents (Antigravity, Claude, Cursor) must strictly follow the tokens and design doctrine defined here.

## 1. System Philosophy: High-Density Institutional Fintech
The interface is designed for algorithmic researchers and active crypto traders. It emphasizes:
- **High Information Density**: Maximum data throughput with zero unnecessary whitespace bloat.
- **Tabular Precision**: Monospaced figures (`tabular-nums`) for all numbers, prices, timestamps, and percentages.
- **Cognitive Clarity**: Directional colors (Teal for Bullish, Crimson for Bearish, Cyan for Squeeze) applied strictly by intent.
- **Dark-First Immersion**: Zinc/Obsidian deep background with luminous neon glows for critical signal states.

## 2. Anti-Slop & Professionalism Standards (ux-ui-agent-skills)
1. **Zero Random Emoji in UI**:
   - Never use cartoon emojis (🚀, 💎, 🔮, 📊, 🛑, 🔥) as decorative fillers in UI components, headers, or status tags.
   - Use clean, SVG icons, subtle glyphs (▲, ▼, ●), or semantic text badges (`[ALPHA BUY]`, `[PRIME COIL]`, `[SMA20 EXIT]`).
2. **Strict Design Token Adherence**:
   - All CSS rules must reference `var(--token)`.
   - Never insert ad-hoc hex values (e.g. `#123456`) or arbitrary pixel values.
   - If a new token is genuinely required, prompt the user for confirmation before altering `DESIGN.md`.
3. **POUR Accessibility**:
   - Contrast ratio must exceed 4.5:1 for body copy and 3:1 for large graphical elements against dark surfaces.
   - Keyboard navigable (`tabindex="0"`, visible focus rings with `var(--cyan-500)`).
   - Touch/click target size minimum 36px x 36px.
