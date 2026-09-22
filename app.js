import { MODEL, MLB_MODEL, ESPN_DEFAULTS, DEFAULT_SPORT } from "./data.js";
import { formatKickoff, statusLabel, teamLogoUrl, readableTeamColor, teamColorHex } from "./espn.js";
import { loadMultiBookLines, formatLinesTimestamp } from "./lines.js";
import {
  fetchSplitsSnapshot,
  mergeSplitsOntoGames,
  formatSplitsTimestamp,
  sharpLeanFor,
} from "./splits.js";
import { loadMlbBoard } from "./mlb.js";
import {
  expectedPoints,
  expectedMlbRuns,
  runSimulation,
  histogram,
  canSimulate,
  moneylineFromGame,
  noVigMoneyline,
} from "./sim.js";
import { drawHistogram, drawWinBar } from "./charts.js";
import {
  computeLeans,
  lineShop,
  fmtLine,
  fmtTotal,
  fmtPct,
  PICK_BOARD_N,
} from "./picks.js";

const $ = (sel) => document.querySelector(sel);

function logoUrl(team) {
  if (!team) return "";
  if (team.logo) return team.logo;
  return teamLogoUrl(null, team.abbr);
}

function teamMark(team, side = "") {
  const url = logoUrl(team);
  const abbr = team?.abbr || "?";
  const name = team?.name || abbr;
  const color = team?.color || readableTeamColor(teamColorHex(team)) || "";
  const style = color ? ` style="color:${color}"` : "";
  if (url) {
    return `<span class="team-mark ${side}"${style}><img class="team-logo" src="${url}" alt="${abbr}" title="${name}" width="36" height="36" loading="lazy" /><span class="abbr-sm">${abbr}</span></span>`;
  }
  return `<span class="team-mark ${side}"${style}><span class="abbr">${abbr}</span></span>`;
}

function setChipLogo(imgEl, team) {
  if (!imgEl) return;
  const url = logoUrl(team);
  if (url) {
    imgEl.src = url;
    imgEl.alt = team?.abbr || "";
    imgEl.hidden = false;
  } else {
    imgEl.removeAttribute("src");
    imgEl.alt = "";
    imgEl.hidden = true;
  }
}



const state = {
  sport: DEFAULT_SPORT, // "nfl" | "mlb"
  games: [],
  gameId: null,
  n: 10000,
  lastResult: null,
  week: null,
  seasonYear: null,
  fetchedAt: null,
  snapshotAt: null,
  liveEspnAt: null,
  loading: false,
  error: null,
  sources: null,
  dateStart: null,
  dateEnd: null,
  view: "pickboard",
  pickFilter: "all",
  /** @type {Map<string, {homeWinPct:number,awayWinPct:number,n:number}>} */
  pickSims: new Map(),
  pickBoardRunning: false,
  /** @type {null | {ok:boolean,matched:number,fetchedAt:string|null,source:string,week:number|null,note:string|null}} */
  splitsMeta: null,
};

function activeModel() {
  return state.sport === "mlb" ? MLB_MODEL : MODEL;
}

function hasTeamRpg(game) {
  return (
    Number.isFinite(Number(game?.away?.rpg)) &&
    Number.isFinite(Number(game?.home?.rpg)) &&
    Number.isFinite(Number(game?.away?.rapg)) &&
    Number.isFinite(Number(game?.home?.rapg))
  );
}

/** Chicago calendar YYYY-MM-DD for "today forward" filtering. */
function chicagoTodayYmd() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function gameDateYmd(g) {
  if (g?.date && /^\d{4}-\d{2}-\d{2}$/.test(g.date)) return g.date;
  if (!g?.kickoffIso) return null;
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Chicago",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(g.kickoffIso));
  } catch {
    return null;
  }
}

function fmtEdgePp(edge) {
  if (edge == null || !Number.isFinite(edge)) return "—";
  const pp = edge * 100;
  const sign = pp > 0 ? "+" : "";
  return `${sign}${pp.toFixed(1)} pp`;
}

function gameCanSim(g) {
  if (!g) return false;
  if (state.sport === "mlb") return canSimulate(g, "mlb");
  return Boolean(g.hasOdds);
}

function unitLabel() {
  return state.sport === "mlb" ? "runs" : "pts";
}

function spreadWord() {
  return state.sport === "mlb" ? "run line" : "spread";
}

function applySportLabels() {
  const mlb = state.sport === "mlb";
  document.querySelectorAll(".sport-tab").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.sport === state.sport);
  });
  const pbTitle = $("#pb-title");
  const pbSub = $("#pb-subtitle");
  if (pbTitle) {
    pbTitle.textContent = mlb
      ? "MLB Pick Board"
      : `Week ${state.week ?? ESPN_DEFAULTS.week} Pick Board`;
  }
  if (pbSub) {
    pbSub.textContent = mlb
      ? "Today + next 7 days · upcoming only · stats model (rpg/rapg + SP ERA) vs books for edge · Action Network splits"
      : "Week 3 + featured remaining Week 2 MNF · consensus lines · quick sims (8k) · transparent lean heuristics";
  }
  const fs = $("#filter-spread");
  if (fs) fs.textContent = mlb ? "Run line leans" : "Spread leans";
  const ls = $("#label-spread");
  if (ls) ls.textContent = mlb ? "Consensus run line" : "Consensus spread";
  const lt = $("#label-total");
  if (lt) lt.textContent = mlb ? "Consensus total" : "Consensus total";
  const lk = $("#label-kickoff");
  if (lk) lk.textContent = mlb ? "First pitch" : "Kickoff";
  const ths = $("#th-spread");
  if (ths) ths.textContent = mlb ? "Run line (home)" : "Spread (home)";
  const tht = $("#th-total");
  if (tht) tht.textContent = "Total";
  const sigma = $("#model-sigma");
  const rho = $("#model-rho");
  const m = activeModel();
  if (sigma) sigma.textContent = String(m.scoreSigma);
  if (rho) rho.textContent = String(m.scoreCorrelation);
  const blurb = $("#model-blurb");
  if (blurb) {
    blurb.innerHTML = mlb
      ? `Expected <strong>runs</strong> are an <strong>independent stats model</strong> (rpg/rapg + SP ERA; optional WHIP/K9 nudge) — <em>can disagree with books</em>.
         Formula: <code>awayExp = 0.5*(away.rpg+home.rapg)+0.35*(leagueERA−homeSP.era)</code>;
         <code>homeExp = 0.5*(home.rpg+away.rapg)+0.35*(leagueERA−awaySP.era)+HFA</code>
         (leagueR≈${m.leagueR}, leagueERA≈${m.leagueERA}, HFA≈${m.hfa}). Missing ERA drops that term. Platoon: lineup-weighted SP OPS-against vs LHB/RHB (switch = opposite hand) → clamp ±${m.platoonClamp}. Clamp means ≈[${m.expClampLo}, ${m.expClampHi}].
         No ties (extras). Books shown for comparison / edge only. σ≈${m.scoreSigma}, ρ≈${m.scoreCorrelation}. Not betting advice.`
      : `Expected points are <strong>market-implied</strong> from the
         <strong>median consensus</strong> home spread and total across DraftKings (via ESPN),
         FanDuel, BetMGM, and Bovada when available. Noise is a bivariate normal around those
         means; scores are rounded to integers and floored at zero. ATS cover rates sit near
         50% by design; win probability is driven by the spread.`;
  }
}

function getGame() {
  return state.games.find((g) => g.id === state.gameId) || state.games[0] || null;
}

const fmtSpread = fmtLine;

function fmtScore(x) {
  return x.toFixed(1);
}

function fmtFetched(iso) {
  return formatLinesTimestamp(iso);
}

function setView(view) {
  state.view = view;
  document.querySelectorAll(".view-tab").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === view);
  });
  const pb = $("#view-pickboard");
  const sim = $("#view-sim");
  if (pb) pb.hidden = view !== "pickboard";
  if (sim) sim.hidden = view !== "sim";
  if (view === "pickboard") renderPickBoard();
}

function setLoading(on, msg) {
  state.loading = on;
  const el = $("#load-status");
  if (!el) return;
  if (on) {
    el.hidden = false;
    el.className = "load-status loading";
    el.textContent = msg || (state.sport === "mlb" ? "Loading MLB board…" : "Loading multi-book lines…");
  } else if (state.error) {
    el.hidden = false;
    el.className = "load-status error";
    el.textContent = state.error;
  } else {
    el.hidden = false;
    el.className = "load-status ok";
    const nOdds = state.games.filter((g) => g.hasOdds).length;
    const snap = state.snapshotAt ? fmtFetched(state.snapshotAt) : "n/a";
    const live = state.liveEspnAt ? fmtFetched(state.liveEspnAt) : "n/a";
    if (state.sport === "mlb") {
      const up = state.games.filter((g) => !g.completed && g.statusState !== "post").length;
      el.textContent = `MLB · ${state.games.length} games (${up} upcoming) · ${nOdds} with lines · snapshot ${snap} · ESPN live ${live}`;
    } else {
      el.textContent = `Week ${state.week} · ${state.games.length} games · ${nOdds} with lines · snapshot ${snap} · ESPN live ${live}`;
    }
  }
}

function populateSelect() {
  const sel = $("#game-select");
  if (!sel) return;
  if (!state.games.length) {
    sel.innerHTML = `<option value="">No games</option>`;
    return;
  }
  sel.innerHTML = state.games
    .map((g) => {
      const nBooks = (g.books || []).length;
      const tag = g.completed
        ? " (final)"
        : g.hasOdds
          ? g.featuredRemaining
            ? ` (W${g.sourceWeek ?? "?"} rem)`
            : ""
          : " (no line)";
      return `<option value="${g.id}">${g.away.abbr} @ ${g.home.abbr}${tag}</option>`;
    })
    .join("");
  if (!state.gameId || !state.games.some((g) => g.id === state.gameId)) {
    const upcoming = pickBoardGames();
    const pick =
      upcoming.find((g) => hasTeamRpg(g)) ||
      upcoming.find((g) => g.hasOdds) ||
      upcoming[0] ||
      state.games.find((g) => g.hasOdds && !g.completed) ||
      state.games.find((g) => g.hasOdds) ||
      state.games[0];
    state.gameId = pick.id;
  }
  sel.value = state.gameId;
}

function updateRunButton() {
  const g = getGame();
  const btn = $("#btn-run");
  if (!btn) return;
  if (!g) {
    btn.disabled = true;
    btn.textContent = "Run Simulation";
    return;
  }
  if (g.completed && state.sport !== "mlb") {
    // NFL: allow counterfactual if lined
  }
  if (!gameCanSim(g)) {
    btn.disabled = true;
    btn.textContent = g.completed ? "Final — no line" : "No stats to sim";
    return;
  }
  if (state.sport === "nfl" && !g.hasOdds) {
    btn.disabled = true;
    btn.textContent = g.completed ? "Final — no line" : "No line available";
    return;
  }
  btn.disabled = state.loading;
  btn.textContent = "Run Simulation";
}

function renderBooksTable(g) {
  const el = $("#books-body");
  if (!el) return;
  if (!g || !(g.books || []).length) {
    el.innerHTML = `<tr><td colspan="3" class="muted">No book lines</td></tr>`;
    return;
  }
  const rows = (g.books || []).map(
    (b) =>
      `<tr>
        <td>${b.name}</td>
        <td class="mono">${fmtLine(b.spread)}</td>
        <td class="mono">${fmtTotal(b.total)}</td>
      </tr>`
  );
  if (g.consensus) {
    rows.push(
      `<tr class="consensus-row">
        <td>Consensus <span class="pill">median</span></td>
        <td class="mono">${fmtLine(g.consensus.spread)}</td>
        <td class="mono">${fmtTotal(g.consensus.total)}</td>
      </tr>`
    );
  }
  el.innerHTML = rows.join("");
}

function renderMatchupPreview() {
  const g = getGame();
  if (!g) {
    $("#chip-away-abbr").textContent = "—";
    $("#chip-away-name").textContent = "Away";
    $("#chip-home-abbr").textContent = "—";
    $("#chip-home-name").textContent = "Home";
    setChipLogo($("#chip-away-logo"), null);
    setChipLogo($("#chip-home-logo"), null);
    const awayAbbrEl = $("#chip-away-abbr");
    const homeAbbrEl = $("#chip-home-abbr");
    if (awayAbbrEl) awayAbbrEl.style.color = "";
    if (homeAbbrEl) homeAbbrEl.style.color = "";
    $("#line-spread").textContent = "—";
    $("#line-total").textContent = "—";
    $("#line-book").textContent = "—";
    $("#line-kickoff").textContent = "—";
    $("#line-status").textContent = "—";
    $("#exp-home").textContent = "—";
    $("#exp-away").textContent = "—";
    $("#exp-margin").textContent = "—";
    $("#meta-body").innerHTML = "";
    renderBooksTable(null);
    const splitsHost = $("#sim-splits");
    if (splitsHost) splitsHost.innerHTML = "";
    const spRow = $("#mlb-sp-row");
    if (spRow) { spRow.hidden = true; spRow.innerHTML = ""; }
    $("#model-exp").textContent = state.sport === "mlb"
      ? "Load MLB board to see stats-model expected runs."
      : "Load lines to see market-implied expected scores.";
    updateRunButton();
    return;
  }

  $("#chip-away-abbr").textContent = g.away.abbr;
  $("#chip-away-name").textContent = g.away.name;
  $("#chip-home-abbr").textContent = g.home.abbr;
  $("#chip-home-name").textContent = g.home.name;
  setChipLogo($("#chip-away-logo"), g.away);
  setChipLogo($("#chip-home-logo"), g.home);
  const awayAbbrEl = $("#chip-away-abbr");
  const homeAbbrEl = $("#chip-home-abbr");
  if (awayAbbrEl) awayAbbrEl.style.color = g.away.color || "";
  if (homeAbbrEl) homeAbbrEl.style.color = g.home.color || "";

  $("#line-spread").textContent = g.hasOdds
    ? `${g.home.abbr} ${fmtLine(g.spread)}`
    : "N/A";
  $("#line-total").textContent = g.hasOdds ? fmtTotal(g.total) : "N/A";
  $("#line-book").textContent = g.hasOdds
    ? `consensus · ${(g.books || []).length} books`
    : "—";
  $("#line-kickoff").textContent = formatKickoff(g.kickoffIso);
  $("#line-status").textContent = statusLabel(g);

  const metaRows = [];
  metaRows.push([
    "Lines scraped",
    state.snapshotAt ? fmtFetched(state.snapshotAt) : "snapshot missing",
  ]);
  metaRows.push([
    "ESPN DK live",
    state.liveEspnAt ? fmtFetched(state.liveEspnAt) : "unavailable",
  ]);
  metaRows.push(["Consensus", "median of available books"]);
  if (g.completed && g.home.score != null && g.away.score != null) {
    metaRows.push([
      "Final score",
      `${g.away.abbr} ${g.away.score} – ${g.home.abbr} ${g.home.score}`,
    ]);
  }
  metaRows.push(["Status", g.statusDetail || statusLabel(g)]);
  $("#meta-body").innerHTML = metaRows
    .map(([k, v]) => `<tr><td>${k}</td><td colspan="2">${v}</td></tr>`)
    .join("");

  renderBooksTable(g);

  const splitsHost = $("#sim-splits");
  if (splitsHost) {
    splitsHost.innerHTML = renderSplitsSection(g);
  }

  const spRow = $("#mlb-sp-row");
  if (spRow) {
    if (state.sport === "mlb") {
      spRow.hidden = false;
      const a = g.awayPitcher;
      const h = g.homePitcher;
      spRow.innerHTML = `<div class="mlb-sp"><span class="k">Probable SPs</span>
        <span>${escapeHtml(fmtPitcher(a))} <span class="muted">vs</span> ${escapeHtml(fmtPitcher(h))}</span></div>`;
    } else {
      spRow.hidden = true;
      spRow.innerHTML = "";
    }
  }

  if (state.sport === "mlb") {
    const exp = expectedMlbRuns(g, activeModel());
    $("#exp-home").textContent = fmtScore(exp.homeExp);
    $("#exp-away").textContent = fmtScore(exp.awayExp);
    $("#exp-margin").textContent =
      (exp.marginExp >= 0 ? "+" : "") + fmtScore(exp.marginExp);
    const m = activeModel();
    const thin = exp.thinData ? "\nthinData = true (missing rpg/rapg → leagueR fallback)" : "";
    const bookBit = g.hasOdds
      ? `\nBook RL ${fmtLine(g.spread)} · O/U ${fmtTotal(g.total)} (comparison only — not used for means)`
      : "\nNo book RL/total yet (model still runnable)";
    const ml = moneylineFromGame(g);
    const mkt = noVigMoneyline(ml.home, ml.away);
    const mlBit =
      mkt.home != null
        ? `\nBook ML no-vig home ≈ ${(mkt.home * 100).toFixed(1)}% (away ${(mkt.away * 100).toFixed(1)}%)`
        : "";
    $("#model-exp").textContent = `Stats model means (independent of books)

awayExp = 0.5*(away.rpg + home.rapg) + ${m.eraCoeff}*(leagueERA − homeSP.era)
homeExp = 0.5*(home.rpg + away.rapg) + ${m.eraCoeff}*(leagueERA − awaySP.era) + HFA
leagueR=${m.leagueR}  leagueERA=${m.leagueERA}  HFA=${m.hfa}

away rpg/rapg = ${exp.inputs.awayRpg.toFixed(2)} / ${exp.inputs.awayRapg.toFixed(2)}
home rpg/rapg = ${exp.inputs.homeRpg.toFixed(2)} / ${exp.inputs.homeRapg.toFixed(2)}
awaySP ERA = ${exp.inputs.awaySpEra != null ? exp.inputs.awaySpEra.toFixed(2) : "n/a"} → homePitcherTerm ${exp.homePitcherTerm.toFixed(3)}
homeSP ERA = ${exp.inputs.homeSpEra != null ? exp.inputs.homeSpEra.toFixed(2) : "n/a"} → awayPitcherTerm ${exp.awayPitcherTerm.toFixed(3)}
WHIP/K9 nudge away ${exp.awayWhipAdj.toFixed(3)} · home ${exp.homeWhipAdj.toFixed(3)} (clamp ±${m.whipK9Clamp})
platoon away ${exp.awayPlatoon?.adj?.toFixed(3) ?? "0"} (facedOPS ${exp.awayPlatoon?.facedOPS != null ? exp.awayPlatoon.facedOPS.toFixed(3) : "n/a"} vs neutral ${exp.awayPlatoon?.neutralOPS != null ? exp.awayPlatoon.neutralOPS.toFixed(3) : "n/a"})
platoon home ${exp.homePlatoon?.adj?.toFixed(3) ?? "0"} (clamp ±${m.platoonClamp}; k=${m.platoonK})

homeExp   = ${exp.homeExp.toFixed(2)}
awayExp   = ${exp.awayExp.toFixed(2)}
no ties (extras)${thin}${bookBit}${mlBit}`;
  } else if (g.hasOdds) {
    const exp = expectedPoints(g, activeModel());
    $("#exp-home").textContent = fmtScore(exp.homeExp);
    $("#exp-away").textContent = fmtScore(exp.awayExp);
    $("#exp-margin").textContent =
      (exp.marginExp >= 0 ? "+" : "") + fmtScore(exp.marginExp);
    const sw = spreadWord();
    $("#model-exp").textContent = `Market-implied means (multi-book median consensus)

${sw} (home) = ${fmtLine(g.spread)}
total         = ${fmtTotal(g.total)}
books         = ${(g.books || []).map((b) => b.name).join(", ") || "—"}

marginExp = −spread = ${(-g.spread).toFixed(2)}
homeExp   = (total − spread) / 2
awayExp   = (total + spread) / 2

homeExp   = ${exp.homeExp.toFixed(2)}
awayExp   = ${exp.awayExp.toFixed(2)}`;
  } else {
    $("#exp-home").textContent = "N/A";
    $("#exp-away").textContent = "N/A";
    $("#exp-margin").textContent = "N/A";
    $("#model-exp").textContent = g.completed
      ? "Final game with no posted odds — simulation / ATS / totals disabled."
      : "No odds posted for this game yet — cannot simulate.";
  }

  updateRunButton();
}

function setNPills() {
  document.querySelectorAll(".n-pills button").forEach((btn) => {
    btn.classList.toggle("active", Number(btn.dataset.n) === state.n);
  });
}

function showEmpty() {
  const g = getGame();
  const el = $("#results");
  if (!el) return;
  if (g?.completed && g.home.score != null) {
    el.innerHTML = `
      <div class="card empty-state">
        <strong>Final: ${g.away.abbr} ${g.away.score} @ ${g.home.abbr} ${g.home.score}</strong>
        ${
          g.hasOdds
            ? "You can still run a counterfactual sim against the consensus line."
            : "No consensus line for this game — ATS / over-under sim unavailable."
        }
      </div>`;
    return;
  }
  if (g && state.sport === "nfl" && !g.hasOdds) {
    el.innerHTML = `
      <div class="card empty-state">
        <strong>No line available</strong>
        No multi-book spread/total for this matchup. Pick another game or refresh later.
      </div>`;
    return;
  }
  const snap = state.snapshotAt ? fmtFetched(state.snapshotAt) : "—";
  if (state.sport === "mlb") {
    el.innerHTML = `
      <div class="card empty-state">
        <strong>Ready to simulate</strong>
        Stats model (rpg/rapg + SP ERA) — can disagree with books · no ties · default 10,000 trials.<br/>
        <span class="muted">Snapshot ${snap}. Books shown for comparison / edge only when posted.</span>
      </div>`;
    return;
  }
  el.innerHTML = `
    <div class="card empty-state">
      <strong>Ready to simulate</strong>
      Multi-book median consensus · market-implied expected scores · default 10,000 trials.<br/>
      <span class="muted">Lines last scraped: ${snap}. Refresh reloads snapshot + live ESPN DraftKings (other books are snapshot-only — not CORS-friendly from GitHub Pages).</span>
    </div>`;
}

function renderResults(result, ms) {
  const g = getGame();
  const el = $("#results");
  const bookLabel = `consensus · ${(g.books || []).length} books`;

  el.innerHTML = `
    <div class="card results-grid">
      <h2>Simulation results · ${result.n.toLocaleString()} trials</h2>
      <div class="winbar-wrap" id="winbar"></div>
      <div class="stat-row">
        <div class="stat away">
          <div class="label">${g.away.abbr} win</div>
          <div class="value">${fmtPct(result.awayWinPct)}</div>
          <div class="sub">mean ${fmtScore(result.meanAway)} ${unitLabel()}</div>
        </div>
        <div class="stat home">
          <div class="label">${g.home.abbr} win</div>
          <div class="value">${fmtPct(result.homeWinPct)}</div>
          <div class="sub">mean ${fmtScore(result.meanHome)} ${unitLabel()}</div>
        </div>
        <div class="stat">
          <div class="label">${state.sport === "mlb" ? "Extras (no ties)" : "Tie / push ML"}</div>
          <div class="value">${state.sport === "mlb" ? "0%" : fmtPct(result.tiePct)}</div>
          <div class="sub">mean margin ${result.meanMargin >= 0 ? "+" : ""}${fmtScore(result.meanMargin)}</div>
        </div>
        <div class="stat accent">
          <div class="label">Mean total</div>
          <div class="value">${fmtScore(result.meanTotal)}</div>
          <div class="sub">line ${fmtTotal(result.totalLine)}</div>
        </div>
      </div>
      <div class="stat-row" style="margin-top:4px">
        <div class="stat">
          <div class="label">${g.home.abbr} covers ${result.spread != null ? fmtLine(result.spread) : "—"}</div>
          <div class="value">${result.homeCoverPct != null ? fmtPct(result.homeCoverPct) : "—"}</div>
          <div class="sub">${result.homeCoverPct != null ? `away ${fmtPct(result.awayCoverPct)} · push ${fmtPct(result.pushSpreadPct)}${state.sport === "mlb" ? " · vs book RL" : " · ~50% by design"}` : "no book RL"}</div>
        </div>
        <div class="stat">
          <div class="label">Over ${result.totalLine != null ? fmtTotal(result.totalLine) : "—"}</div>
          <div class="value">${result.overPct != null ? fmtPct(result.overPct) : "—"}</div>
          <div class="sub">${result.overPct != null ? `under ${fmtPct(result.underPct)} · push ${fmtPct(result.pushTotalPct)}` : "no book total"}</div>
        </div>
        <div class="stat">
          <div class="label">${state.sport === "mlb" ? "Model E[home]" : "Market E[home]"}</div>
          <div class="value">${fmtScore(result.homeExp)}</div>
          <div class="sub">${state.sport === "mlb" ? "stats model" : "from consensus"}</div>
        </div>
        <div class="stat">
          <div class="label">${state.sport === "mlb" ? "Model E[away]" : "Market E[away]"}</div>
          <div class="value">${fmtScore(result.awayExp)}</div>
          <div class="sub">${state.sport === "mlb"
            ? (result.marketHomeWinPct != null
                ? `book home ${fmtPct(result.marketHomeWinPct)} · edge ${fmtEdgePp(result.edge)}`
                : "no book ML")
            : "from consensus"}</div>
        </div>
      </div>
      <div class="charts">
        <div class="chart-card"><canvas id="chart-margin"></canvas></div>
        <div class="chart-card"><canvas id="chart-total"></canvas></div>
      </div>
      <p class="timing">Completed in ${ms.toFixed(0)} ms · ${bookLabel} · not betting advice · lines move</p>
    </div>
  `;

  drawWinBar(
    $("#winbar"),
    result.homeWinPct,
    result.awayWinPct,
    result.tiePct,
    g.home.abbr,
    g.away.abbr
  );

  const binW = state.sport === "mlb" ? 1 : 2;
  const marginHist = histogram(result.margins, binW);
  const totalHist = histogram(result.totals, binW);

  const u = unitLabel();
  const sw = spreadWord();
  drawHistogram($("#chart-margin"), marginHist, {
    title: "Margin distribution (home − away)",
    color: "#5b8cff",
    zeroLine: true,
    marker: -result.spread,
    markerLabel: sw,
    xLabel: u,
  });

  drawHistogram($("#chart-total"), totalHist, {
    title: state.sport === "mlb" ? "Total runs distribution" : "Total points distribution",
    color: "#3dd68c",
    marker: result.totalLine,
    markerLabel: "O/U",
    xLabel: u,
  });
}

function run() {
  const g = getGame();
  if (!gameCanSim(g)) return;
  const btn = $("#btn-run");
  btn.disabled = true;
  btn.textContent = "Simulating…";

  requestAnimationFrame(() => {
    const t0 = performance.now();
    const result = runSimulation(g, state.n, {
      model: activeModel(),
      sport: state.sport,
    });
    const ms = performance.now() - t0;
    state.lastResult = result;
    renderResults(result, ms);
    updateRunButton();
  });
}

/** Upcoming (non-final) games — pick board candidates. Today forward; hide finals. */
function pickBoardGames() {
  const today = chicagoTodayYmd();
  return state.games.filter((g) => {
    if (g.completed) return false;
    if (g.statusState === "post") return false;
    if (g.status === "STATUS_FINAL") return false;
    // Prefer pre/scheduled; hide in-progress on pick board for "upcoming only"
    if (g.statusState === "in") return false;
    const ymd = gameDateYmd(g);
    if (ymd && ymd < today) return false;
    return true;
  });
}

function yieldToUI() {
  return new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
}

async function runPickBoardSims({ force = false } = {}) {
  const upcoming = pickBoardGames();
  // MLB: sim any upcoming game (stats model); prioritize full rpg/rapg.
  // NFL: still need consensus lines.
  let candidates =
    state.sport === "mlb"
      ? upcoming.slice().sort((a, b) => {
          const as = hasTeamRpg(a) ? 1 : 0;
          const bs = hasTeamRpg(b) ? 1 : 0;
          if (as !== bs) return bs - as;
          return (a.kickoffMs || 0) - (b.kickoffMs || 0);
        })
      : upcoming.filter((g) => g.hasOdds);
  const status = $("#pickboard-status");
  const btn = $("#btn-resim-pb");
  if (!candidates.length) {
    if (status) {
      status.textContent = upcoming.length
        ? `Showing ${upcoming.length} upcoming games — waiting on lines / stats.`
        : "No upcoming games yet.";
    }
    renderPickBoard();
    return;
  }

  state.pickBoardRunning = true;
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Simulating…";
  }

  let done = 0;
  for (const g of candidates) {
    if (!force && state.pickSims.has(g.id)) {
      done++;
      continue;
    }
    if (status) {
      status.textContent = `Running quick sims (${PICK_BOARD_N.toLocaleString()} each)… ${done + 1}/${candidates.length} · ${g.away.abbr} @ ${g.home.abbr}`;
    }
    await yieldToUI();
    const result = runSimulation(g, PICK_BOARD_N, {
      model: activeModel(),
      sport: state.sport,
    });
    state.pickSims.set(g.id, {
      homeWinPct: result.homeWinPct,
      awayWinPct: result.awayWinPct,
      n: result.n,
      meanHome: result.meanHome,
      meanAway: result.meanAway,
      marketHomeWinPct: result.marketHomeWinPct,
      marketAwayWinPct: result.marketAwayWinPct,
      edge: result.edge,
      edgeAway: result.edgeAway,
      thinData: result.thinData,
      source: result.source,
      homeExp: result.homeExp,
      awayExp: result.awayExp,
    });
    done++;
    renderPickBoard();
  }

  state.pickBoardRunning = false;
  if (btn) {
    btn.disabled = false;
    btn.textContent = "Re-run sims";
  }
  if (status) {
    const nFeat = candidates.filter((g) => g.featuredRemaining).length;
    const featNote = nFeat ? ` · +${nFeat} prior-week remaining` : "";
    const upcomingN = upcoming.length;
    const withRpg = candidates.filter((g) => hasTeamRpg(g)).length;
    const waitingN = Math.max(0, upcomingN - candidates.filter((g) => g.hasOdds).length);
    status.textContent = state.sport === "mlb"
      ? `MLB · ${upcomingN} upcoming · ${candidates.length} simmed (${withRpg} full rpg/rapg) · ${waitingN} waiting on book lines · stats model vs books`
      : `NFL Week ${state.week} · ${upcomingN} upcoming · ${candidates.length} simmed${featNote}`;
  }
  renderPickBoard();
}

function openInSim(gameId) {
  state.gameId = gameId;
  state.lastResult = null;
  populateSelect();
  renderMatchupPreview();
  showEmpty();
  setView("sim");
}

function pctLabel(n) {
  return n == null || !Number.isFinite(n) ? "—" : `${Math.round(n)}%`;
}

function sideLabel(g, side) {
  if (side === "home") return g?.home?.abbr || "Home";
  if (side === "away") return g?.away?.abbr || "Away";
  if (side === "over") return "Over";
  if (side === "under") return "Under";
  return side || "?";
}

/**
 * Dual tickets/money bars for one market.
 */
function renderSplitMarketRow(g, title, mkt, kind) {
  if (!mkt) return "";
  const isTotal = kind === "total";
  const leftSide = isTotal ? "over" : "away";
  const rightSide = isTotal ? "under" : "home";
  const leftTickets = isTotal ? mkt.overTickets : mkt.awayTickets;
  const leftMoney = isTotal ? mkt.overMoney : mkt.awayMoney;
  const rightTickets = isTotal ? mkt.underTickets : mkt.homeTickets;
  const rightMoney = isTotal ? mkt.underMoney : mkt.homeMoney;
  const leftName = sideLabel(g, leftSide);
  const rightName = sideLabel(g, rightSide);

  const lean = sharpLeanFor(mkt, kind);
  let leanHtml = "";
  if (lean?.side) {
    const gap = lean.gap != null ? ` · money ${lean.gap > 0 ? "+" : ""}${lean.gap} vs tickets` : "";
    leanHtml = `<span class="sharp-lean">Sharp lean · ${escapeHtml(sideLabel(g, lean.side))}${gap}</span>`;
  }

  let lineBit = "";
  if (kind === "spread" && mkt.line != null) {
    lineBit = `<span class="split-line mono">${escapeHtml(g.home?.abbr || "Home")} ${fmtLine(mkt.line)}</span>`;
  } else if (kind === "total" && mkt.line != null) {
    lineBit = `<span class="split-line mono">O/U ${fmtTotal(mkt.line)}</span>`;
  }

  const bar = (tickets, money, sideCls) => {
    const t = Math.max(0, Math.min(100, Number(tickets) || 0));
    const m = Math.max(0, Math.min(100, Number(money) || 0));
    return `
      <div class="split-bars ${sideCls}">
        <div class="split-bar-row" title="Tickets ${pctLabel(tickets)}">
          <span class="split-bar-label">Tix</span>
          <div class="split-bar-track"><div class="split-bar-fill tickets" style="width:${t}%"></div></div>
          <span class="split-bar-pct mono">${pctLabel(tickets)}</span>
        </div>
        <div class="split-bar-row" title="Money ${pctLabel(money)}">
          <span class="split-bar-label">$</span>
          <div class="split-bar-track"><div class="split-bar-fill money" style="width:${m}%"></div></div>
          <span class="split-bar-pct mono">${pctLabel(money)}</span>
        </div>
      </div>`;
  };

  return `
    <div class="split-market">
      <div class="split-market-head">
        <span class="split-market-title">${escapeHtml(title)}</span>
        ${lineBit}
        ${leanHtml}
      </div>
      <div class="split-sides">
        <div class="split-side">
          <div class="split-side-name">${escapeHtml(leftName)}</div>
          ${bar(leftTickets, leftMoney, leftSide)}
        </div>
        <div class="split-side">
          <div class="split-side-name">${escapeHtml(rightName)}</div>
          ${bar(rightTickets, rightMoney, rightSide)}
        </div>
      </div>
    </div>`;
}

function renderSplitsSection(g, { compact = false } = {}) {
  const split = g?.splits;
  const meta = state.splitsMeta;
  if (!split) {
    if (compact) return "";
    return `
      <div class="splits-section empty">
        <div class="splits-head">
          <span class="k">Bets vs Money</span>
        </div>
        <p class="splits-empty muted">No public splits matched for this game (snapshot may still be prior week).</p>
      </div>`;
  }

  const stamp = meta?.fetchedAt
    ? formatSplitsTimestamp(meta.fetchedAt)
    : "—";
  const rows = [
    renderSplitMarketRow(g, state.sport === "mlb" ? "Run line" : "Spread", split.spread, "spread"),
    renderSplitMarketRow(g, "ML", split.moneyline, "moneyline"),
    renderSplitMarketRow(g, "Total", split.total, "total"),
  ]
    .filter(Boolean)
    .join("");

  const numBets =
    split.numBets != null
      ? `<span class="splits-bets">${Number(split.numBets).toLocaleString()} bets</span>`
      : "";

  return `
    <div class="splits-section">
      <div class="splits-head">
        <span class="k">Bets vs Money</span>
        ${numBets}
      </div>
      ${rows}
      <p class="splits-foot muted">
        Splits: Action Network · updated ${escapeHtml(stamp)}.
        Public sample (tickets % vs money %); money−tickets gap ≥10 often read as sharper lean — not a guarantee of sharp action · not betting advice.
      </p>
    </div>`;
}


function fmtPitcher(pp) {
  if (!pp) return "TBD";
  const era = pp.stats?.era;
  const eraBit = era != null && Number.isFinite(Number(era)) ? ` (ERA ${Number(era).toFixed(2)})` : "";
  return `${pp.name || "TBD"}${eraBit}`;
}

function fmtPitcherPlatoon(pp) {
  if (!pp) return "";
  const st = pp.stats || {};
  const hand = pp.pitchHand || st.pitchHand;
  const handBit = hand ? ` ${hand}HP` : "";
  const vl = st.vsLhb?.ops;
  const vr = st.vsRhb?.ops;
  const splitBit =
    vl != null || vr != null
      ? ` · vsLHB OPS ${vl != null ? Number(vl).toFixed(3) : "—"} / vsRHB ${vr != null ? Number(vr).toFixed(3) : "—"}`
      : "";
  return `${handBit}${splitBit}`;
}

function fmtBatMix(team) {
  const m = team?.batMix;
  if (!m) return "";
  const src = m.source || "roster mix (lineup TBD)";
  return `Lineup: ${m.lhb || 0} LHB / ${m.rhb || 0} RHB / ${m.shb || 0} S · ${src}`;
}

function renderSpLine(g) {
  if (state.sport !== "mlb") return "";
  const aMix = fmtBatMix(g.away);
  const hMix = fmtBatMix(g.home);
  return `<div class="pick-sp muted">SP · ${escapeHtml(fmtPitcher(g.awayPitcher))}${escapeHtml(fmtPitcherPlatoon(g.awayPitcher))} @ ${escapeHtml(fmtPitcher(g.homePitcher))}${escapeHtml(fmtPitcherPlatoon(g.homePitcher))}</div>
    ${aMix || hMix ? `<div class="pick-batmix muted">${escapeHtml(g.away.abbr)} ${escapeHtml(aMix || "—")} · ${escapeHtml(g.home.abbr)} ${escapeHtml(hMix || "—")}</div>` : ""}`;
}

function renderMlBox(g) {
  const ml = g.moneyline;
  if (!ml || (ml.home == null && ml.away == null)) {
    return `<div class="sub">ML —</div>`;
  }
  const fmt = (n) => {
    if (n == null) return "—";
    return n > 0 ? `+${n}` : String(n);
  };
  return `<div class="sub">ML ${escapeHtml(g.away.abbr)} ${fmt(ml.away)} · ${escapeHtml(g.home.abbr)} ${fmt(ml.home)}</div>`;
}

function modelWinBox(g, sim) {
  const mlb = state.sport === "mlb";
  const winHome = sim ? fmtPct(sim.homeWinPct) : "…";
  const winAway = sim ? fmtPct(sim.awayWinPct) : "…";
  const bookHome = sim?.marketHomeWinPct != null ? fmtPct(sim.marketHomeWinPct) : null;
  const bookAway = sim?.marketAwayWinPct != null ? fmtPct(sim.marketAwayWinPct) : null;
  const edgeHome = sim?.edge;
  const edgeAway = sim?.edgeAway;
  const bestEdge =
    edgeHome != null && edgeAway != null
      ? edgeHome >= edgeAway
        ? { side: "home", edge: edgeHome }
        : { side: "away", edge: edgeAway }
      : edgeHome != null
        ? { side: "home", edge: edgeHome }
        : edgeAway != null
          ? { side: "away", edge: edgeAway }
          : null;

  const thin = sim?.thinData
    ? `<div class="sub thin-flag">Thin data — league-avg fallback</div>`
    : "";

  if (mlb) {
    const bookRow =
      bookHome != null
        ? `<div class="sub">Book implied · ${escapeHtml(g.away.abbr)} ${bookAway} · ${escapeHtml(g.home.abbr)} ${bookHome}</div>
           <div class="sub edge-line ${bestEdge && bestEdge.edge > 0 ? "pos" : ""}">Edge · ${
             bestEdge
               ? `${escapeHtml(bestEdge.side === "home" ? g.home.abbr : g.away.abbr)} ${fmtEdgePp(bestEdge.edge)}`
               : "—"
           } <span class="muted">(model − book)</span></div>`
        : `<div class="sub muted">No book ML yet — model only</div>`;
    return `
      <div class="pick-box model-win">
        <div class="k">Model win%</div>
        <div class="v mono winpct">
          <span class="away">${escapeHtml(g.away.abbr)} ${winAway}</span>
          <span class="sep">·</span>
          <span class="home">${escapeHtml(g.home.abbr)} ${winHome}</span>
        </div>
        <div class="sub">${sim ? `${sim.n.toLocaleString()} sims · stats model` : "sim pending…"}</div>
        ${bookRow}
        ${thin}
      </div>`;
  }

  return `
    <div class="pick-box">
      <div class="k">Model win% <span class="muted">(market-calibrated)</span></div>
      <div class="v mono winpct">
        <span class="away">${escapeHtml(g.away.abbr)} ${winAway}</span>
        <span class="sep">·</span>
        <span class="home">${escapeHtml(g.home.abbr)} ${winHome}</span>
      </div>
      <div class="sub">${sim ? `${sim.n.toLocaleString()} sims @ consensus` : "sim pending…"}
        ${bookHome != null ? ` · book ${escapeHtml(g.home.abbr)} ${bookHome}` : ""}</div>
    </div>`;
}

function renderPickCard(g) {
  const sim = state.pickSims.get(g.id) || null;
  const leans = g.hasOdds ? computeLeans(g, sim) : null;
  const shop = g.hasOdds ? lineShop(g) : null;
  const mlb = state.sport === "mlb";

  // MLB: still show a card when waiting on books if we have a model sim
  if (!g.hasOdds && !(mlb && sim)) {
    return `
      <article class="pick-card waiting${g.featuredRemaining ? " featured-remaining" : ""}" data-id="${g.id}">
        <div class="pick-card-head">
          <div class="pick-matchup">
            ${teamMark(g.away, "away")}
            <span class="at">@</span>
            ${teamMark(g.home, "home")}
          </div>
          <div class="pick-meta">
            <span>${formatKickoff(g.kickoffIso)}</span>
            ${
              g.featuredRemaining
                ? `<span class="featured-pill">Week ${g.sourceWeek ?? "?"} remaining</span>`
                : ""
            }
            <span class="status-pill">${statusLabel(g)}</span>
          </div>
        </div>
        ${renderSpLine(g)}
        <p class="waiting-msg">${mlb ? "Waiting on book lines — stats model can still sim after refresh." : "Waiting on lines — no consensus yet."}</p>
        ${renderSplitsSection(g, { compact: true })}
      </article>`;
  }

  const leanClass = leans?.hasLean ? "has-lean" : "no-lean";
  let leanHtml;
  if (!g.hasOdds) {
    leanHtml = `<div class="lean-badge none">Waiting on books — model edge pending ML</div>`;
  } else if (!leans?.hasLean) {
    leanHtml = `<div class="lean-badge none">No lean — market too tight / no shop edge</div>`;
  } else {
    const badges = [
      ...leans.spreadLeans.map(
        (l) =>
          `<span class="lean-badge spread ${l.side}">${mlb ? "RL" : "ATS"} · ${escapeHtml(l.label)} <small>${escapeHtml(l.book)}</small></span>`
      ),
      ...leans.mlLeans.map(
        (l) =>
          `<span class="lean-badge ml ${l.side}">ML · ${escapeHtml(l.label)}</span>`
      ),
    ];
    leanHtml = `<div class="lean-badges">${badges.join("")}</div>`;
  }

  const bestHomeCls = shop?.bestHome?.better ? "best" : "";
  const bestAwayCls = shop?.bestAway?.better ? "best" : "";

  const whyList = (leans?.why || [])
    .map((w) => `<li>${escapeHtml(w)}</li>`)
    .join("");

  const rpgLine = mlb
    ? `<div class="pick-rpg muted">rpg/rapg · ${escapeHtml(g.away.abbr)} ${Number(g.away.rpg).toFixed(2)}/${Number(g.away.rapg).toFixed(2)} · ${escapeHtml(g.home.abbr)} ${Number(g.home.rpg).toFixed(2)}/${Number(g.home.rapg).toFixed(2)}</div>`
    : "";

  const consensusBox = g.hasOdds
    ? `<div class="pick-box">
          <div class="k">Consensus <span class="muted">(book)</span></div>
          <div class="v mono">${escapeHtml(g.home.abbr)} ${fmtLine(g.spread)} · O/U ${fmtTotal(g.total)}</div>
          <div class="sub">${(g.books || []).length} books · median · comparison only</div>
          ${renderMlBox(g)}
        </div>
        <div class="pick-box line-shop">
          <div class="k">Best home ${spreadWord()}</div>
          <div class="v mono ${bestHomeCls}">${shop?.bestHome ? `${fmtLine(shop.bestHome.spread)} <small>${escapeHtml(shop.bestHome.book)}</small>` : "—"}</div>
          <div class="sub">vs cons ${fmtLine(shop?.consensus)}${shop?.bestHome ? ` · Δ ${(shop.homeEdge >= 0 ? "+" : "") + shop.homeEdge.toFixed(2)}` : ""}</div>
        </div>
        <div class="pick-box line-shop">
          <div class="k">Best away ${spreadWord()}</div>
          <div class="v mono ${bestAwayCls}">${shop?.bestAway ? `${fmtLine(shop.bestAway.spread)} <small>${escapeHtml(shop.bestAway.book)}</small>` : "—"}</div>
          <div class="sub">vs cons ${fmtLine(shop?.consensus != null ? -shop.consensus : null)}${shop?.bestAway ? ` · Δ ${(shop.awayEdge >= 0 ? "+" : "") + shop.awayEdge.toFixed(2)}` : ""}</div>
        </div>`
    : `<div class="pick-box">
          <div class="k">Books</div>
          <div class="v">Waiting on lines</div>
          <div class="sub">Model still independent</div>
        </div>`;

  return `
    <article class="pick-card ${leanClass}${g.featuredRemaining ? " featured-remaining" : ""}" data-id="${g.id}">
      <div class="pick-card-head">
        <div class="pick-matchup">
          ${teamMark(g.away, "away")}
          <span class="at">@</span>
          ${teamMark(g.home, "home")}
        </div>
        <div class="pick-meta">
          <span>${formatKickoff(g.kickoffIso)}</span>
          ${
            g.featuredRemaining
              ? `<span class="featured-pill">Week ${g.sourceWeek ?? "?"} remaining</span>`
              : ""
          }
          <span class="status-pill">${statusLabel(g)}</span>
        </div>
      </div>

      ${renderSpLine(g)}
      ${rpgLine}

      <div class="pick-grid">
        ${consensusBox}
        ${modelWinBox(g, sim)}
      </div>

      <div class="pick-lean-row">
        <div class="k">Lean</div>
        ${leanHtml}
      </div>

      <div class="pick-why">
        <div class="k">Why</div>
        <ul>${whyList || '<li class="muted">Stats model vs books when ML posts.</li>'}</ul>
      </div>

      ${renderSplitsSection(g, { compact: true })}

      <div class="pick-card-foot">
        <button type="button" class="btn-link" data-open-sim="${g.id}">Open in Sim →</button>
      </div>
    </article>`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}


/**
 * Top-N positive model−book edges among upcoming games with both model + no-vig ML.
 * Prefers games starting today (Chicago); else earliest slate day with candidates.
 * Ranked by largest edge. Returns [] if none.
 */
function computeTopEdgePlays(n = 3) {
  const upcoming = pickBoardGames();
  const today = chicagoTodayYmd();
  const rows = [];
  for (const g of upcoming) {
    const sim = state.pickSims.get(g.id);
    if (!sim) continue;
    if (sim.marketHomeWinPct == null || sim.marketAwayWinPct == null) continue;
    if (sim.homeWinPct == null || sim.awayWinPct == null) continue;

    const homeEdge = sim.homeWinPct - sim.marketHomeWinPct;
    const awayEdge = sim.awayWinPct - sim.marketAwayWinPct;
    const pick =
      homeEdge >= awayEdge
        ? {
            side: "home",
            team: g.home,
            modelWinPct: sim.homeWinPct,
            bookWinPct: sim.marketHomeWinPct,
            edge: homeEdge,
          }
        : {
            side: "away",
            team: g.away,
            modelWinPct: sim.awayWinPct,
            bookWinPct: sim.marketAwayWinPct,
            edge: awayEdge,
          };
    if (!(pick.edge > 0)) continue;

    const ymd = gameDateYmd(g) || today;
    rows.push({ g, sim, pick, ymd });
  }
  if (!rows.length) return [];

  const days = [...new Set(rows.map((r) => r.ymd))].sort();
  const focusDay = days.find((d) => d >= today) || days[0];
  const pool = rows.filter((r) => r.ymd === focusDay);
  pool.sort((a, b) => b.pick.edge - a.pick.edge || (a.g.kickoffMs || 0) - (b.g.kickoffMs || 0));

  return pool.slice(0, n).map((best, i) => {
    const why = buildEdgeWhyShort(best);
    return { ...best, focusDay, rank: i + 1, why };
  });
}

/** Short why bullets for an edge play (SP / platoon / lineup when available). */
function buildEdgeWhyShort(best) {
  const why = [];
  why.push(
    `Model ${fmtPct(best.pick.modelWinPct)} vs book no-vig ${fmtPct(best.pick.bookWinPct)} → ${fmtEdgePp(best.pick.edge)}.`
  );
  if (state.sport === "mlb") {
    const ap = best.g.awayPitcher;
    const hp = best.g.homePitcher;
    if (ap?.name || hp?.name || ap?.stats?.era != null || hp?.stats?.era != null) {
      const aHand = ap?.pitchHand || ap?.stats?.pitchHand || "";
      const hHand = hp?.pitchHand || hp?.stats?.pitchHand || "";
      why.push(
        `SP: ${ap?.name || "TBD"}${aHand ? ` ${aHand}HP` : ""}${ap?.stats?.era != null ? ` ERA ${Number(ap.stats.era).toFixed(2)}` : ""} @ ${hp?.name || "TBD"}${hHand ? ` ${hHand}HP` : ""}${hp?.stats?.era != null ? ` ERA ${Number(hp.stats.era).toFixed(2)}` : ""}.`
      );
    }
    const aMix = best.g.away?.batMix;
    const hMix = best.g.home?.batMix;
    if (aMix || hMix) {
      const aSrc = aMix?.source === "lineup" ? "lineup" : "roster mix";
      const hSrc = hMix?.source === "lineup" ? "lineup" : "roster mix";
      why.push(
        `Bat mix: ${best.g.away.abbr} ${aMix ? `${aMix.lhb}L/${aMix.rhb}R/${aMix.shb}S (${aSrc})` : "—"} · ${best.g.home.abbr} ${hMix ? `${hMix.lhb}L/${hMix.rhb}R/${hMix.shb}S (${hSrc})` : "—"}.`
      );
    }
  } else {
    why.push("NFL sim is market-calibrated from consensus spread/total — edge vs ML is informational.");
  }

  const mlSplit = best.g.splits?.moneyline;
  if (mlSplit) {
    const gapHome =
      mlSplit.homeMoney != null && mlSplit.homeTickets != null
        ? mlSplit.homeMoney - mlSplit.homeTickets
        : null;
    const gapAway =
      mlSplit.awayMoney != null && mlSplit.awayTickets != null
        ? mlSplit.awayMoney - mlSplit.awayTickets
        : null;
    const agreeGap = best.pick.side === "home" ? gapHome : gapAway;
    if (agreeGap != null && agreeGap >= 10) {
      why.push(`AN money−tickets +${agreeGap} on ${best.pick.team.abbr}.`);
    } else if (agreeGap != null && agreeGap <= -10) {
      why.push(`Public tickets lean ${best.pick.team.abbr} more than money (gap ${agreeGap}).`);
    }
  }
  return why;
}

function renderTopEdgePlays(eps) {
  if (!eps?.length) return "";
  const focusDay = eps[0].focusDay;
  const cards = eps.map((ep) => renderEdgePlayCard(ep)).join("");
  return `
    <section class="top-edge-plays" aria-label="Top Edge Plays">
      <div class="top-edge-header">
        <span class="ep-kicker">Top Edge Plays</span>
        <span class="ep-day mono">${escapeHtml(focusDay)} · model−book ML</span>
      </div>
      <div class="top-edge-grid">
        ${cards}
      </div>
      <p class="ep-disclaimer muted">Honest label: model edge vs market — not guaranteed profit / not betting advice.</p>
    </section>`;
}

function renderEdgePlayCard(ep) {
  if (!ep) return "";
  const { g, pick, why, rank } = ep;
  const sideTeam = pick.team;
  const other = pick.side === "home" ? g.away : g.home;
  const edgePct = (pick.edge * 100).toFixed(1);
  const whyLis = why.map((w) => `<li>${escapeHtml(w)}</li>`).join("");
  const sp =
    state.sport === "mlb"
      ? `<div class="ep-stat">SP · ${escapeHtml(fmtPitcher(g.awayPitcher))} @ ${escapeHtml(fmtPitcher(g.homePitcher))}</div>`
      : "";

  return `
    <article class="edge-play-card" data-id="${g.id}" data-rank="${rank}">
      <div class="edge-play-banner">
        <span class="ep-rank">#${rank}</span>
        <span class="ep-side-label">Play · <strong>${escapeHtml(sideTeam.abbr)}</strong> ML</span>
      </div>
      <div class="edge-play-body">
        <div class="edge-play-matchup">
          ${teamMark(g.away, "away")}
          <span class="at">@</span>
          ${teamMark(g.home, "home")}
        </div>
        <div class="edge-play-pick">
          <div class="ep-edge">+${edgePct}%</div>
          <div class="ep-compare mono">
            Model ${fmtPct(pick.modelWinPct)} · Book ${fmtPct(pick.bookWinPct)}
            <span class="muted"> · vs ${escapeHtml(other.abbr)}</span>
          </div>
        </div>
      </div>
      ${sp}
      <ul class="ep-why">${whyLis}</ul>
      <div class="pick-card-foot">
        <button type="button" class="btn-link" data-open-sim="${g.id}">Open in Sim →</button>
      </div>
    </article>`;
}

function renderPickBoard() {
  const root = $("#pickboard");
  if (!root) return;

  let games = pickBoardGames();
  // MLB: prioritize games with full rpg/rapg for display order among non-leans
  const enriched = games.map((g) => {
    const sim = state.pickSims.get(g.id) || null;
    const leans = g.hasOdds ? computeLeans(g, sim) : null;
    return { g, leans, sim };
  });

  const filter = state.pickFilter;
  let filtered = enriched;
  if (filter === "lean") filtered = enriched.filter((x) => x.leans?.hasLean);
  else if (filter === "spread")
    filtered = enriched.filter((x) => x.leans?.hasSpreadLean);
  else if (filter === "ml") filtered = enriched.filter((x) => x.leans?.hasMlLean);

  filtered.sort((a, b) => {
    const aLean = a.leans?.hasLean ? 1 : 0;
    const bLean = b.leans?.hasLean ? 1 : 0;
    if (aLean !== bLean) return bLean - aLean;
    if (state.sport === "mlb") {
      const as = hasTeamRpg(a.g) ? 1 : 0;
      const bs = hasTeamRpg(b.g) ? 1 : 0;
      if (as !== bs) return bs - as;
    }
    return (a.g.kickoffMs || 0) - (b.g.kickoffMs || 0);
  });

  const eps = filter === "all" ? computeTopEdgePlays(3) : [];
  const epHtml = eps.length ? renderTopEdgePlays(eps) : "";

  if (!filtered.length && !eps.length) {
    root.innerHTML = `
      <div class="card empty-state">
        <strong>No games match this filter</strong>
        Try All, or refresh lines after books post.
      </div>`;
    return;
  }

  root.innerHTML =
    epHtml + filtered.map(({ g }) => renderPickCard(g)).join("");

  root.querySelectorAll("[data-open-sim]").forEach((btn) => {
    btn.addEventListener("click", () => openInSim(btn.getAttribute("data-open-sim")));
  });
}

async function loadLines() {
  const btnRefresh = $("#btn-refresh");
  const btnRefreshPb = $("#btn-refresh-pb");
  if (btnRefresh) btnRefresh.disabled = true;
  if (btnRefreshPb) btnRefreshPb.disabled = true;
  state.error = null;
  applySportLabels();
  setLoading(
    true,
    state.sport === "mlb"
      ? "Fetching MLB Stats snapshot + live ESPN…"
      : "Fetching snapshot + live ESPN DraftKings…"
  );

  try {
    if (state.sport === "mlb") {
      const data = await loadMlbBoard({ daysAhead: 7 });
      state.games = data.games;
      state.week = null;
      state.seasonYear = null;
      state.fetchedAt = data.fetchedAt;
      state.snapshotAt = data.snapshotAt;
      state.liveEspnAt = data.liveEspnAt;
      state.sources = data.sources;
      state.dateStart = data.dateStart;
      state.dateEnd = data.dateEnd;
      state.splitsMeta = data.splitsMeta;
      state.error = null;
      state.pickSims.clear();
      state.gameId = null;

      populateSelect();
      renderMatchupPreview();
      showEmpty();
      setLoading(false);
      applySportLabels();

      const badge = $("#badge-source");
      if (badge) {
        badge.textContent = `MLB · ${data.counts.withOdds}/${data.counts.games} lined · ESPN DK`;
      }
      const stamp = $("#lines-updated");
      if (stamp) {
        const sm = state.splitsMeta;
        const splitsBit = sm?.ok
          ? ` · Splits: Action Network · ${fmtFetched(sm.fetchedAt)} (${sm.matched}/${sm.total} matched)`
          : " · Splits: unavailable / unmatched";
        stamp.textContent = `Data as of: lines ${fmtFetched(data.snapshotAt || data.fetchedAt)} · ESPN live ${data.liveEspnAt ? fmtFetched(data.liveEspnAt) : "off"} · window ${data.dateStart || "?"}→${data.dateEnd || "?"}${splitsBit} · not betting advice`;
      }
      renderPickBoard();
      await runPickBoardSims({ force: true });
    } else {
      const data = await loadMultiBookLines({
        week: ESPN_DEFAULTS.week,
        dates: ESPN_DEFAULTS.dates,
      });

      let splitsSnap = null;
      let splitsErr = null;
      try {
        splitsSnap = await fetchSplitsSnapshot();
      } catch (err) {
        splitsErr = err.message || String(err);
        console.warn("splits.json:", splitsErr);
      }
      state.splitsMeta = mergeSplitsOntoGames(data.games, splitsSnap);
      if (!splitsSnap) {
        state.splitsMeta = {
          ok: false,
          matched: 0,
          total: data.games.length,
          fetchedAt: null,
          source: "Action Network public betting",
          week: null,
          note: splitsErr || "splits.json missing",
        };
      }

      state.games = data.games;
      state.week = data.week;
      state.seasonYear = data.seasonYear;
      state.fetchedAt = data.fetchedAt;
      state.snapshotAt = data.snapshotAt;
      state.liveEspnAt = data.liveEspnAt;
      state.sources = data.sources;
      state.error = null;
      state.pickSims.clear();

      populateSelect();
      renderMatchupPreview();
      showEmpty();
      setLoading(false);
      applySportLabels();

      const badge = $("#badge-source");
      if (badge) {
        const nBooks = new Set(
          data.games.flatMap((g) => (g.books || []).map((b) => b.name))
        ).size;
        badge.textContent = `Multi-book · ${nBooks} sources · Week ${data.week}`;
      }

      const stamp = $("#lines-updated");
      if (stamp) {
        const sm = state.splitsMeta;
        const splitsBit = sm?.ok
          ? ` · Splits: Action Network · ${fmtFetched(sm.fetchedAt)} (${sm.matched}/${sm.total} matched)`
          : " · Splits: unavailable";
        stamp.textContent = `Lines updated: ${fmtFetched(data.snapshotAt || data.fetchedAt)} (snapshot) · ESPN DK live merge ${data.liveEspnAt ? fmtFetched(data.liveEspnAt) : "off"} · consensus = median${splitsBit} · not betting advice`;
      }

      renderPickBoard();
      await runPickBoardSims({ force: true });
    }
  } catch (err) {
    console.error(err);
    state.error = `Failed to load lines: ${err.message || err}`;
    setLoading(false);
    const results = $("#results");
    if (results) {
      results.innerHTML = `
      <div class="card empty-state">
        <strong>Could not load lines</strong>
        ${state.error}. Check your network and hit Refresh lines.
      </div>`;
    }
    const pb = $("#pickboard");
    if (pb) {
      pb.innerHTML = `<div class="card empty-state"><strong>Could not load lines</strong>${state.error}</div>`;
    }
  } finally {
    if (btnRefresh) btnRefresh.disabled = false;
    if (btnRefreshPb) btnRefreshPb.disabled = false;
    updateRunButton();
  }
}

function setSport(sport) {
  if (sport !== "nfl" && sport !== "mlb") return;
  if (state.sport === sport && state.games.length) {
    applySportLabels();
    return;
  }
  state.sport = sport;
  state.gameId = null;
  state.lastResult = null;
  state.pickSims.clear();
  state.games = [];
  applySportLabels();
  setView(state.view);
  loadLines();
}

function init() {
  setNPills();
  applySportLabels();

  document.querySelectorAll(".sport-tab").forEach((btn) => {
    btn.addEventListener("click", () => setSport(btn.dataset.sport));
  });

  document.querySelectorAll(".view-tab").forEach((btn) => {
    btn.addEventListener("click", () => setView(btn.dataset.view));
  });

  document.querySelectorAll("#pick-filters button").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.pickFilter = btn.dataset.filter;
      document.querySelectorAll("#pick-filters button").forEach((b) => {
        b.classList.toggle("active", b.dataset.filter === state.pickFilter);
      });
      renderPickBoard();
    });
  });

  const sel = $("#game-select");
  if (sel) {
    sel.addEventListener("change", (e) => {
      state.gameId = e.target.value;
      state.lastResult = null;
      renderMatchupPreview();
      showEmpty();
    });
  }

  document.querySelectorAll(".n-pills button").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.n = Number(btn.dataset.n);
      setNPills();
    });
  });

  const btnRun = $("#btn-run");
  if (btnRun) btnRun.addEventListener("click", run);
  const btnRefresh = $("#btn-refresh");
  if (btnRefresh) btnRefresh.addEventListener("click", () => loadLines());
  const btnRefreshPb = $("#btn-refresh-pb");
  if (btnRefreshPb) btnRefreshPb.addEventListener("click", () => loadLines());
  const btnResim = $("#btn-resim-pb");
  if (btnResim) {
    btnResim.addEventListener("click", () => runPickBoardSims({ force: true }));
  }

  window.addEventListener("resize", () => {
    if (!state.lastResult) return;
    const r = state.lastResult;
    const binW = state.sport === "mlb" ? 1 : 2;
    const marginHist = histogram(r.margins, binW);
    const totalHist = histogram(r.totals, binW);
    const cm = $("#chart-margin");
    const ct = $("#chart-total");
    if (cm)
      drawHistogram(cm, marginHist, {
        title: "Margin distribution (home − away)",
        color: "#5b8cff",
        zeroLine: true,
        marker: -r.spread,
        markerLabel: spreadWord(),
        xLabel: unitLabel(),
      });
    if (ct)
      drawHistogram(ct, totalHist, {
        title: state.sport === "mlb" ? "Total runs distribution" : "Total points distribution",
        color: "#3dd68c",
        marker: r.totalLine,
        markerLabel: "O/U",
        xLabel: unitLabel(),
      });
  });

  setView("pickboard");
  loadLines();
}

init();
