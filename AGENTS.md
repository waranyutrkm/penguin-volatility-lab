# AI Agent Operating Guidelines & UX/UI Mandate (AGENTS.md)

This project strictly adheres to the **Senior Design Architect** standards defined in `DESIGN.md` and inspired by **plugin87/ux-ui-agent-skills** and **designmd.app**.

## 1. Strict Design Token Adherence (Ekasit's Law)
- **Mandate**: All CSS styles, colors, typography, paddings, margins, border radii, and shadows MUST be derived directly from the design tokens declared in `DESIGN.md`.
- **Prohibition**: Do NOT hallucinate or insert arbitrary one-off hex colors (e.g. `#2b3345`), random pixel sizes (e.g. `margin: 17px`), or unapproved gradients.
- **Exception Procedure**: If a design challenge genuinely requires a new token not present in `DESIGN.md`, you MUST state the rationale and **explicitly ask the user for confirmation** before defining or applying it.

## 2. Anti-Slop & Zero-Emoji Doctrine
- Serious quantitative finance and options trading terminals do not use casual emojis (e.g. 🔮, 📊, 🟢, 💎, 🛑, 🚀) as decorations, bullets, or status dots in the UI.
- Use structured semantic badges (`[ALPHA BUY]`, `[PRIME COIL]`, `[SMA20 EXIT]`), geometric indicator glyphs (`▲`, `▼`, `●`), or crisp inline SVGs.
- Maintain institutional-grade clarity, typographic hierarchy, and tabular numerical alignment (`tabular-nums`).

## 3. Accessibility & Usability (WCAG 2.2 AA)
- Ensure all text contrasts meet at least 4.5:1 against card backgrounds.
- Provide clear visible focus states on all interactive controls (`outline: 2px solid var(--border-focus)`).
- Ensure zero horizontal viewport overflow on viewports down to 320px width.
