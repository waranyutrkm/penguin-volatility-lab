---
name: ux-ui-design
description: >-
  Senior Design Architect skill based on plugin87/ux-ui-agent-skills and designmd.app standards.
  Enforces 3-tier DTCG design tokens (Primitive -> Semantic -> Component), WCAG 2.2 AA/AAA accessibility,
  anti-slop doctrine (zero random emoji, deliberate visual variance), and strict DESIGN.md adherence.
---

# Senior UX/UI Design Architect & Design System Skill

Derived from the **plugin87/ux-ui-agent-skills** framework by Thientan Soparat and the **DESIGN.md** standard (Google Labs Stitch / designmd.app).

## 1. Decision Framework (Hierarchy of Priorities)

When making any design or UI implementation decision, strictly follow this hierarchy:
1. **User Needs** — Does this serve the user's objective? Is the primary trading/quant task frictionless?
2. **Accessibility (POUR)** — Perceivable, Operable, Understandable, Robust. WCAG 2.2 AA contrast (4.5:1 text, 3:1 graphical).
3. **Consistency** — Strictly follow established `DESIGN.md` design tokens. No arbitrary one-off styles.
4. **Aesthetics & Taste** — Intentional hierarchy, micro-interactions, editorial typographic scale, polished borders.
5. **Developer Experience** — Clean modular CSS/JS, zero unnecessary external dependencies.

*Rule:* Never sacrifice a higher priority for a lower one. (e.g. Aesthetics never overrides Accessibility or Consistency).

---

## 2. Core Non-Negotiables

### A. Strict Token Adherence (Ekasit's Law)
- Always resolve colors, spacing, typography, radii, and shadows from `DESIGN.md` tokens.
- **NEVER invent arbitrary hex values or ad-hoc margins/paddings.**
- If a new token is genuinely required, **explicitly prompt the user for confirmation** before adding it to `DESIGN.md`.

### B. Anti-Slop Doctrine (Zero Random Emoji)
- Do not use casual emojis (e.g., 🚀, 💎, 🔮, 📊, 🛑, 🔥) as decorative fillers or status indicators in serious fintech/data products.
- Instead use:
  1. Semantic badges (`ALPHA BUY`, `PRIME COIL`, `COOLING`)
  2. Tabular status indicators (`● Bullish`, `▲ +4.8%`, `▼ -1.2%`)
  3. Clean inline SVGs (Lucide-style icons with `currentColor`)

### C. 3-Tier DTCG Token Architecture
1. **Primitive Tokens**: Base palette values (`--slate-900`, `--teal-500`, `--font-mono`)
2. **Semantic Tokens**: Intent-based aliases (`--surface-bg`, `--text-primary`, `--border-subtle`, `--accent-bull`)
3. **Component Tokens**: Scoped to specific UI elements (`--card-header-bg`, `--score-badge-border`)

---

## 3. Financial & Quant Data Display Standards
- **Tabular Figures**: Always use `font-variant-numeric: tabular-nums` for prices, percentages, timestamps, and scores to prevent layout jitter.
- **Directional Clarity**:
  - Positive / Bullish: Emerald/Teal tone (`--color-bull`)
  - Negative / Bearish: Crimson/Rose tone (`--color-bear`)
  - Compression / Squeeze: Cyan tone (`--color-squeeze`)
  - Neutral / Exhaustion: Muted Slate / Amber (`--color-neutral`, `--color-warning`)
- **Responsive Grid**: Minimum 320px viewport support without horizontal body overflow.
