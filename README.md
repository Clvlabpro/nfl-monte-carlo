# NFL Monte Carlo (clvpro)

Browser-side **Pick Board** + Monte Carlo NFL simulator calibrated to a **multi-book median consensus** of spread + total.

**Not betting advice.** Lines move — hit Refresh.

Live site: [https://clvlabpro.github.io/nfl-monte-carlo/](https://clvlabpro.github.io/nfl-monte-carlo/)

## Views

- **Pick Board** (default) — upcoming Week 3 games with consensus lines, best book numbers, quick MC win%, and transparent lean heuristics (line shop ≥0.5 pts; market-implied ML ≥58%/≤42%).
- **Sim** — deep dive one matchup with histograms (existing simulator).

## Quick start

```bash
cd /workspace/nfl-monte-carlo
python3 scripts/fetch-lines.py   # optional: refresh lines.json
python3 -m http.server 8080 --bind 127.0.0.1
```

Open: [http://127.0.0.1:8080](http://127.0.0.1:8080)

## Lean rules (transparent)

1. **Line shop ATS**: best book spread for a side ≥ 0.5 pts better than consensus → lean that side ATS (cite book + numbers).
2. **ML**: quick MC home win% ≥ 58% → home ML; ≤ 42% → away ML (labeled market-implied).
3. Else: “No lean — market too tight / no shop edge.”

## Data sources

| Book | How | Browser live? |
|------|-----|---------------|
| **DraftKings** | ESPN scoreboard `odds[0]` | Yes (CORS OK) |
| **FanDuel / BetMGM / Bovada** | `lines.json` snapshot | Snapshot only |

Home-team spread: **negative = home favored**. Consensus = **median**.

## Files

- `index.html` / `styles.css` — UI (Pick Board + Sim tabs)
- `picks.js` — lean heuristics + line shop
- `lines.json` / `lines.js` / `espn.js` / `sim.js` / `app.js`

## Caveats

- Market-calibrated ≠ predictive edge; the sim embeds the consensus line.
- Snapshot books can lag until you re-run `scripts/fetch-lines.py`.
- Leans are heuristics, not a proprietary edge model.
