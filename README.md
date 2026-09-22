# clvpro

Browser-side **Pick Board** + simulator for **NFL** and **MLB**.

**Branding: clvpro only.** Live: [https://clvlabpro.github.io/nfl-monte-carlo/](https://clvlabpro.github.io/nfl-monte-carlo/)

**Not betting advice.** Lines move — hit Refresh.

## Views

- **Pick Board** — upcoming games only (today forward; hide final/completed). **Edge Play of the Day** (largest model−book ML edge) featured at top.
- **Sim** — deep dive one matchup with histograms.

### NFL

Market-calibrated from consensus spread + total (multi-book median). Books drive means.

### MLB (independent — can disagree with books)

Expected runs are **stats-based**, not taken from run line + total:

```
leagueR ≈ 4.25 · leagueERA ≈ 4.10 · HFA ≈ 0.12

awayExp = 0.5*(away.rpg + home.rapg) + 0.35*(leagueERA − homeSP.era)
homeExp = 0.5*(home.rpg + away.rapg) + 0.35*(leagueERA − awaySP.era) + HFA
```

- Missing SP ERA → drop that pitcher’s term (0). Clamp each side ≈ `[1.5, 7.5]`.
- Optional WHIP/K9 nudge vs opposing SP (±0.15 max).
- **Platoon / handedness** (real splits, not W–L):
  - SP throwing hand (LHP/RHP)
  - SP OPS-against vs LHB / vs RHB (MLB Stats API `sitCodes=vl,vr`)
  - Opposing bat mix: posted lineup if available, else **active roster mix (lineup TBD)**
  - Switch-hitters bat opposite of pitcher hand
  - `facedOPS` = lineup-weighted vsL/vsR OPS; `neutralOPS` = 0.5*(vsL+vsR)
  - `platoonAdj = clamp((facedOPS − neutralOPS) × 2.0, ±0.30)` added to that offense’s expected runs
- **No ties** — extras until scores differ.
- σ ≈ 3.0 runs · ρ ≈ 0.20
- Books (ESPN DraftKings) stay for **comparison / edge only**: model win% vs no-vig ML implied, ATS/OU vs posted RL/total.

**Do not calibrate win% to match the moneyline.**

## Edge Play of the Day

Among upcoming games with both model win% and book ML:

`edge_pp = (modelWinPct − bookImpliedWinPct) × 100`

Featured card = largest **positive** edge on today / next slate day with lines. Honest label: model edge vs market — not guaranteed profit / not betting advice.

## Quick start

```bash
cd /workspace/nfl-monte-carlo
python3 scripts/fetch-lines.py
python3 scripts/fetch-splits.py
python3 scripts/fetch-mlb-lines.py   # schedule + ESPN odds + rpg/rapg + SP ERA/WHIP/K9 + platoon splits + bat mix
python3 scripts/fetch-mlb-splits.py
python3 -m http.server 8080 --bind 127.0.0.1
```

## Data sources (free)

| Sport | Source | Notes |
|-------|--------|--------|
| MLB | Stats API schedule, team rpg/rapg, last-10, SP ERA/WHIP/K9 | Snapshot |
| MLB | Stats API pitcher `vl`/`vr` OPS splits + pitch hand | Platoon |
| MLB | Stats API roster batSide (or live battingOrder when posted) | Lineup / roster mix |
| MLB | ESPN scoreboard DraftKings RL/total/ML | Comparison only |
| MLB | Action Network → `mlb-splits.json` | Bets vs Money |
| NFL | ESPN DK + FD/MGM/Bovada snapshot | Market means |
| NFL | Action Network → `splits.json` | Bets vs Money |

## Lean heuristics (transparent)

1. Line shop ≥ 0.5 pts vs consensus → ATS/RL lean  
2. Model win% ≥ 58% / ≤ 42% → ML lean  
3. Sharp lean display: money% − tickets% ≥ 10  
4. Else: no lean  

## Caveats

- MLB model is independent of books and can be wrong; edge ≠ EV guarantee.
- Roster bat mix is used when lineup is TBD.
- Snapshot books/splits lag until fetch scripts re-run and redeploy.
- Public splits ≠ proven sharps.
