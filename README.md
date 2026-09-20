# NFL Monte Carlo

Browser-side Monte Carlo NFL game simulator calibrated to a **multi-book median consensus** of spread + total. Pick a Week 2 (2026) matchup, run thousands of trials, and inspect win probabilities, mean scores, and margin/total histograms.

**Not betting advice.** Lines move — hit Refresh.

Live site: [https://clvlabpro.github.io/nfl-monte-carlo/](https://clvlabpro.github.io/nfl-monte-carlo/)

## Quick start

```bash
cd /workspace/nfl-monte-carlo
python3 scripts/fetch-lines.py   # refresh lines.json from free book endpoints
python3 -m http.server 8080 --bind 127.0.0.1
```

Open: [http://127.0.0.1:8080](http://127.0.0.1:8080)

No build step, no backend, no paid odds APIs.

## Data sources

| Book | How | Browser live? |
|------|-----|---------------|
| **DraftKings** | ESPN scoreboard `odds[0]` (`site.web.api.espn.com`) | Yes (CORS OK) |
| **FanDuel** | `sbapi.*.sportsbook.fanduel.com` content-managed-page | Snapshot only |
| **BetMGM** | `www.il.betmgm.com/cds-api/bettingoffer/fixtures` | Snapshot only |
| **Bovada** | `bovada.lv` coupon events API | Snapshot only |
| DraftKings direct API | Blocked (HTTP 403) | — |
| Caesars | Blocked (HTTP 403) | — |

Refresh on the site: reloads baked `lines.json` and merges **live ESPN DraftKings**. Re-run `scripts/fetch-lines.py` on a machine that can reach the book XHR APIs to update FanDuel / BetMGM / Bovada.

Home-team spread convention: **negative = home favored**. Consensus = **median** of available books (spread and total separately).

## Generative model

```
marginExp = −spread
homeExp   = (total − spread) / 2
awayExp   = (total + spread) / 2
scores    ~ bivariate normal (σ ≈ 10.5, ρ ≈ 0.18), round ≥ 0
```

ATS cover ≈ 50% by construction; win% comes from the spread. Implemented in `sim.js`.

## Files

- `index.html` / `styles.css` — UI (per-book table + consensus)
- `lines.json` — baked multi-book snapshot (+ timestamp)
- `scripts/fetch-lines.py` — free scrapers → `lines.json`
- `lines.js` — snapshot load + ESPN live merge + median
- `espn.js` — ESPN scoreboard normalize
- `data.js` / `sim.js` / `charts.js` / `app.js`

## Caveats

- Market-calibrated ≠ predictive edge; the sim *embeds* the consensus line.
- Snapshot books can lag until you re-run the fetch script.
- Not calibrated beyond a simple Gaussian residual model.
