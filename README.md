# NFL Monte Carlo

Browser-side Monte Carlo NFL game simulator. Pick a sample matchup, run thousands of trials, and inspect win probabilities, mean scores, margin/total histograms, and cover/over rates against synthetic lines.

**Sample data & model estimates only — not betting advice.**

## Quick start

From this directory, serve the static files (ES modules require HTTP):

```bash
cd /workspace/nfl-monte-carlo
python3 -m http.server 8080 --bind 127.0.0.1
```

Open: [http://127.0.0.1:8080](http://127.0.0.1:8080)

Any static file server works (`npx serve`, `php -S`, etc.). No build step, no backend, no paid APIs.

## What’s included

| Feature | Detail |
|--------|--------|
| Matchup picker | 12 sample NFL games with offense / defense / form ratings |
| Home field | +2.4 pts baked into home expected score |
| Simulation sizes | 1k / 5k / 10k / 25k (default 10k) |
| Results | Win %, tie rate, mean scores, mean margin & total |
| Distributions | Canvas histograms for margin and total points |
| ATS / totals | P(cover) vs sample spread, P(over) vs sample total |
| Model panel | Equations + live E[home]/E[away] from selected game |

## Generative model (short)

```
E[away] = 22.5 + off_away − def_home + form_away
E[home] = 22.5 + off_home − def_away + form_home + 2.4
scores  ~ bivariate normal (σ = 9.8, ρ = 0.18), then round ≥ 0
```

Implemented in `sim.js` with typed arrays for speed.

## Files

- `index.html` — UI shell
- `styles.css` — dark sports-analytics theme
- `data.js` — sample games + model constants
- `sim.js` — Monte Carlo engine + histogram helper
- `charts.js` — canvas charts (no chart library)
- `app.js` — wiring / interactions

## Caveats

- Ratings and lines are **synthetic** for critique/demo.
- Fonts load from Google Fonts when online; layout still works offline after cache or without them (system fonts).
- Not calibrated to real NFL scoring distributions; useful as an explainable mockup, not a production pricing model.
