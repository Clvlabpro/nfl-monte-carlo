# clvpro

Browser-side **Pick Board** + simulator calibrated to market consensus lines.

**Sports:** **NFL** (default) and **MLB** — switch with the top **NFL | MLB** tabs.

**Not betting advice.** Lines move — hit Refresh. Branding: **clvpro** only.

Live site: [https://clvlabpro.github.io/nfl-monte-carlo/](https://clvlabpro.github.io/nfl-monte-carlo/)

## Views

Within each sport:

- **Pick Board** (default) — upcoming games with consensus lines, best book numbers, Action Network bets-vs-money splits, quick sim win%, transparent lean heuristics.
- **Sim** — deep dive one matchup with margin/total histograms.

### NFL

Week 3 (2026) + featured remaining Week 2 MNF (e.g. NYG@LAR). Multi-book median consensus (DraftKings via ESPN + FanDuel / BetMGM / Bovada snapshot).

### MLB

Schedule window: **today + next 2–3 days** (America/Chicago) so quiet nights still show a board. Probable SPs + season ERA/WHIP from MLB Stats API. Run line / total / ML from ESPN DraftKings when posted. Public splits from Action Network when the page has that slate.

## Quick start

```bash
cd /workspace/nfl-monte-carlo
python3 scripts/fetch-lines.py       # NFL lines.json
python3 scripts/fetch-splits.py      # NFL splits.json
python3 scripts/fetch-mlb-lines.py   # MLB mlb-lines.json
python3 scripts/fetch-mlb-splits.py  # MLB mlb-splits.json
python3 -m http.server 8080 --bind 127.0.0.1
```

Open: [http://127.0.0.1:8080](http://127.0.0.1:8080) → use **NFL | MLB** tabs.

## Lean rules (transparent)

1. **Line shop** (spread / run line): best book number for a side ≥ 0.5 better than consensus → lean that side.
2. **ML**: quick sim home win% ≥ 58% → home ML; ≤ 42% → away ML (labeled market-implied).
3. **Sharp lean** (display): Action Network money% − tickets% ≥ 10 on a side (public sample ≠ proven sharps).
4. Else: “No lean — market too tight / no shop edge.”

## Model

### NFL

```
marginExp = −spread
homeExp   = (total − spread) / 2
awayExp   = (total + spread) / 2
σ ≈ 10.5 pts · ρ ≈ 0.18
```

### MLB

Same market algebra on **run line + total**. Then optional pitcher adjust when **both** probable SPs have season ERA:

```
pitcherAdj = clamp((awayERA − homeERA) × 0.12, −0.75, +0.75)
homeExp   += pitcherAdj / 2
awayExp   −= pitcherAdj / 2
σ ≈ 3.2 runs · ρ ≈ 0.22
```

Integer runs ≥ 0. Pick Board uses 8k sims; Sim default 10k. Does **not** invent odds — cards show “Waiting on lines” when RL/total are missing.

## Data sources

| Sport | Source | Browser live? |
|-------|--------|---------------|
| NFL | ESPN scoreboard DraftKings | Yes |
| NFL | FanDuel / BetMGM / Bovada → `lines.json` | Snapshot |
| NFL | Action Network → `splits.json` | Snapshot |
| MLB | MLB Stats API schedule + SP/team context → `mlb-lines.json` | Snapshot (+ enrich) |
| MLB | ESPN MLB scoreboard DK odds | Yes (merge on Refresh) |
| MLB | Action Network → `mlb-splits.json` | Snapshot |
| MLB multi-book (FD/MGM/Bovada) | — | **Not adapted** (gap) |

Home-team spread / run line: **negative = home favored**. Consensus = **median**.

## Files

- `mlb-lines.json` / `scripts/fetch-mlb-lines.py`
- `mlb-splits.json` / `scripts/fetch-mlb-splits.py`
- `mlb.js` — load/merge MLB board
- `splits.json` / `scripts/fetch-splits.py` — NFL public betting
- `lines.json` / `scripts/fetch-lines.py` — NFL multi-book
- `index.html` / `styles.css` / `app.js` / `sim.js` / `picks.js` / `charts.js`

## Caveats

- Market-calibrated ≠ predictive edge; the sim embeds the consensus line (plus a small MLB pitcher nudge).
- Snapshot books/splits can lag until you re-run fetch scripts and redeploy.
- Public betting splits are a sample — not a guarantee of sharp action.
- Leans are heuristics, not a proprietary edge model.
