# NFL Monte Carlo

Browser-side Monte Carlo NFL game simulator calibrated to **live DraftKings lines** from ESPN’s free, CORS-enabled scoreboard API. Pick a Week 2 matchup, run thousands of trials, and inspect win probabilities, mean scores, and margin/total histograms.

**Not betting advice.** Lines move — hit Refresh.

Live site: [https://clvlabpro.github.io/nfl-monte-carlo/](https://clvlabpro.github.io/nfl-monte-carlo/)

## Quick start

```bash
cd /workspace/nfl-monte-carlo
python3 -m http.server 8080 --bind 127.0.0.1
```

Open: [http://127.0.0.1:8080](http://127.0.0.1:8080)

No build step, no backend, no paid odds APIs.

## Data source

```
https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?seasontype=2&week=2&dates=2026
```

- `odds[0].spread` — **home** point spread (negative = home favored)
- `odds[0].overUnder` — total
- `odds[0].provider.name` — e.g. DraftKings
- Finals without odds (e.g. DET @ BUF) are listed with actual scores; ATS sim is disabled

## Generative model

Market-implied means, then correlated Gaussian noise:

```
marginExp = −spread
homeExp   = (total − spread) / 2
awayExp   = (total + spread) / 2
scores    ~ bivariate normal (σ ≈ 10.5, ρ ≈ 0.18), round ≥ 0
```

ATS cover ≈ 50% by construction; win% comes from the spread. Implemented in `sim.js`.

## What’s included

| Feature | Detail |
|--------|--------|
| Live lines | ESPN fetch on load + Refresh button |
| Matchup picker | All Week 2 games (scheduled + final) |
| Simulation sizes | 1k / 5k / 10k / 25k (default 10k) |
| Results | Win %, means, margin & total histograms |
| ATS / totals | vs live spread & O/U when posted |
| Finals | Score shown; no-odds games skip ATS |

## Files

- `index.html` / `styles.css` — UI
- `data.js` — model constants only
- `espn.js` — fetch + normalize scoreboard/odds
- `sim.js` — Monte Carlo engine
- `charts.js` — canvas charts
- `app.js` — wiring / loading states

## Caveats

- Market-calibrated ≠ predictive edge; the sim *embeds* the line.
- ESPN may omit odds for completed games or early in the week.
- Not calibrated beyond a simple Gaussian residual model.
