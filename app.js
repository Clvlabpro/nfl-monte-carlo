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
import { expectedPoints, runSimulation, histogram } from "./sim.js";
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
      ? "Today + next 2–3 days · Stats API + ESPN DK · Action Network splits · quick sims (8k) · pitcher-aware model"
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
      ? `Expected <strong>runs</strong> are <strong>market-implied</strong> from consensus run line + total (ESPN DraftKings when present).
         When both probable SPs have season ERA, a modest adjustment
         <code>clamp((awayERA−homeERA)×${m.pitcherEraK}, ±${m.pitcherClamp})</code> shifts means toward the better pitcher.
         Noise σ≈${m.scoreSigma} runs (lower than NFL). Research tool — not betting advice.`
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
    const pick =
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
  if (!g.hasOdds) {
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
    $("#model-exp").textContent = "Load lines to see market-implied expected scores.";
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

  if (g.hasOdds) {
    const exp = expectedPoints(g, activeModel());
    $("#exp-home").textContent = fmtScore(exp.homeExp);
    $("#exp-away").textContent = fmtScore(exp.awayExp);
    $("#exp-margin").textContent =
      (exp.marginExp >= 0 ? "+" : "") + fmtScore(exp.marginExp);
    const sw = spreadWord();
    const pitcherBit =
      state.sport === "mlb"
        ? `
pitcherAdj = clamp((awayERA−homeERA)×${activeModel().pitcherEraK}, ±${activeModel().pitcherClamp}) = ${(exp.pitcherAdj || 0).toFixed(3)}
(applied as ±adj/2 to each side; 0 if either SP ERA missing)`
        : "";
    $("#model-exp").textContent = `Market-implied means (${state.sport === "mlb" ? "ESPN DK / consensus" : "multi-book median consensus"})

${sw} (home) = ${fmtLine(g.spread)}
total         = ${fmtTotal(g.total)}
books         = ${(g.books || []).map((b) => b.name).join(", ") || "—"}

marginExp = −spread = ${(-g.spread).toFixed(2)}
homeExp   = (total − spread) / 2
awayExp   = (total + spread) / 2${pitcherBit}

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
  if (g && !g.hasOdds) {
    el.innerHTML = `
      <div class="card empty-state">
        <strong>No line available</strong>
        No multi-book spread/total for this matchup. Pick another game or refresh later.
      </div>`;
    return;
  }
  const snap = state.snapshotAt ? fmtFetched(state.snapshotAt) : "—";
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
          <div class="label">Tie / push ML</div>
          <div class="value">${fmtPct(result.tiePct)}</div>
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
          <div class="label">${g.home.abbr} covers ${fmtLine(result.spread)}</div>
          <div class="value">${fmtPct(result.homeCoverPct)}</div>
          <div class="sub">away ${fmtPct(result.awayCoverPct)} · push ${fmtPct(result.pushSpreadPct)} · ~50% by design</div>
        </div>
        <div class="stat">
          <div class="label">Over ${fmtTotal(result.totalLine)}</div>
          <div class="value">${fmtPct(result.overPct)}</div>
          <div class="sub">under ${fmtPct(result.underPct)} · push ${fmtPct(result.pushTotalPct)}</div>
        </div>
        <div class="stat">
          <div class="label">Market E[home]</div>
          <div class="value">${fmtScore(result.homeExp)}</div>
          <div class="sub">from consensus</div>
        </div>
        <div class="stat">
          <div class="label">Market E[away]</div>
          <div class="value">${fmtScore(result.awayExp)}</div>
          <div class="sub">from consensus</div>
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
  if (!g?.hasOdds) return;
  const btn = $("#btn-run");
  btn.disabled = true;
  btn.textContent = "Simulating…";

  requestAnimationFrame(() => {
    const t0 = performance.now();
    const result = runSimulation(g, state.n, { model: activeModel() });
    const ms = performance.now() - t0;
    state.lastResult = result;
    renderResults(result, ms);
    updateRunButton();
  });
}

/** Upcoming (non-final) games — pick board candidates. */
function pickBoardGames() {
  return state.games.filter((g) => !g.completed && g.statusState !== "post");
}

function yieldToUI() {
  return new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
}

async function runPickBoardSims({ force = false } = {}) {
  const candidates = pickBoardGames().filter((g) => g.hasOdds);
  const status = $("#pickboard-status");
  const btn = $("#btn-resim-pb");
  if (!candidates.length) {
    if (status) status.textContent = "No upcoming games with consensus lines yet.";
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
    const result = runSimulation(g, PICK_BOARD_N, { model: activeModel() });
    state.pickSims.set(g.id, {
      homeWinPct: result.homeWinPct,
      awayWinPct: result.awayWinPct,
      n: result.n,
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
    status.textContent = state.sport === "mlb"
      ? `MLB Pick Board ready · ${candidates.length} games simmed @ ${PICK_BOARD_N.toLocaleString()} trials`
      : `Pick Board ready · ${candidates.length} games simmed @ ${PICK_BOARD_N.toLocaleString()} trials · Week ${state.week}${featNote}`;
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

function renderSpLine(g) {
  if (state.sport !== "mlb") return "";
  return `<div class="pick-sp muted">SP · ${escapeHtml(fmtPitcher(g.awayPitcher))} @ ${escapeHtml(fmtPitcher(g.homePitcher))}</div>`;
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

function renderPickCard(g) {
  const sim = state.pickSims.get(g.id) || null;
  const leans = g.hasOdds ? computeLeans(g, sim) : null;
  const shop = g.hasOdds ? lineShop(g) : null;

  if (!g.hasOdds) {
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
        <p class="waiting-msg">Waiting on lines — no consensus yet.</p>
        ${renderSplitsSection(g, { compact: true })}
      </article>`;
  }

  const leanClass = leans?.hasLean ? "has-lean" : "no-lean";
  let leanHtml;
  if (!leans?.hasLean) {
    leanHtml = `<div class="lean-badge none">No lean — market too tight / no shop edge</div>`;
  } else {
    const badges = [
      ...leans.spreadLeans.map(
        (l) =>
          `<span class="lean-badge spread ${l.side}">${state.sport === "mlb" ? "RL" : "ATS"} · ${escapeHtml(l.label)} <small>${escapeHtml(l.book)}</small></span>`
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

  const winHome = sim ? fmtPct(sim.homeWinPct) : "…";
  const winAway = sim ? fmtPct(sim.awayWinPct) : "…";

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

      <div class="pick-grid">
        <div class="pick-box">
          <div class="k">Consensus</div>
          <div class="v mono">${g.home.abbr} ${fmtLine(g.spread)} · O/U ${fmtTotal(g.total)}</div>
          <div class="sub">${(g.books || []).length} books · median</div>
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
        </div>
        <div class="pick-box">
          <div class="k">Market-implied win%</div>
          <div class="v mono winpct">
            <span class="away">${g.away.abbr} ${winAway}</span>
            <span class="sep">·</span>
            <span class="home">${g.home.abbr} ${winHome}</span>
          </div>
          <div class="sub">${sim ? `${sim.n.toLocaleString()} sims @ consensus` : "sim pending…"}</div>
        </div>
      </div>

      <div class="pick-lean-row">
        <div class="k">Lean</div>
        ${leanHtml}
      </div>

      <div class="pick-why">
        <div class="k">Why</div>
        <ul>${whyList}</ul>
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

function renderPickBoard() {
  const root = $("#pickboard");
  if (!root) return;

  let games = pickBoardGames();
  const enriched = games.map((g) => {
    const sim = state.pickSims.get(g.id) || null;
    const leans = g.hasOdds ? computeLeans(g, sim) : null;
    return { g, leans };
  });

  const filter = state.pickFilter;
  let filtered = enriched;
  if (filter === "lean") filtered = enriched.filter((x) => x.leans?.hasLean);
  else if (filter === "spread")
    filtered = enriched.filter((x) => x.leans?.hasSpreadLean);
  else if (filter === "ml") filtered = enriched.filter((x) => x.leans?.hasMlLean);

  // Sort: leans first, then kickoff
  filtered.sort((a, b) => {
    const aLean = a.leans?.hasLean ? 1 : 0;
    const bLean = b.leans?.hasLean ? 1 : 0;
    if (aLean !== bLean) return bLean - aLean;
    return (a.g.kickoffMs || 0) - (b.g.kickoffMs || 0);
  });

  if (!filtered.length) {
    root.innerHTML = `
      <div class="card empty-state">
        <strong>No games match this filter</strong>
        Try All, or refresh lines after books post.
      </div>`;
    return;
  }

  root.innerHTML = filtered.map(({ g }) => renderPickCard(g)).join("");

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
      const data = await loadMlbBoard({ daysAhead: 3 });
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
