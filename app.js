import { MODEL, ESPN_DEFAULTS } from "./data.js";
import { formatKickoff, statusLabel, teamLogoUrl } from "./espn.js";
import { loadMultiBookLines, formatLinesTimestamp } from "./lines.js";
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
  if (url) {
    return `<span class="team-mark ${side}"><img class="team-logo" src="${url}" alt="${abbr}" title="${name}" width="36" height="36" loading="lazy" /><span class="abbr-sm">${abbr}</span></span>`;
  }
  return `<span class="team-mark ${side}"><span class="abbr">${abbr}</span></span>`;
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
  view: "pickboard",
  pickFilter: "all",
  /** @type {Map<string, {homeWinPct:number,awayWinPct:number,n:number}>} */
  pickSims: new Map(),
  pickBoardRunning: false,
};

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
    el.textContent = msg || "Loading multi-book lines…";
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
    el.textContent = `Week ${state.week} · ${state.games.length} games · ${nOdds} with lines · snapshot ${snap} · ESPN live ${live}`;
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

  if (g.hasOdds) {
    const exp = expectedPoints(g);
    $("#exp-home").textContent = fmtScore(exp.homeExp);
    $("#exp-away").textContent = fmtScore(exp.awayExp);
    $("#exp-margin").textContent =
      (exp.marginExp >= 0 ? "+" : "") + fmtScore(exp.marginExp);
    $("#model-exp").textContent = `Market-implied means (multi-book median consensus)

spread (home) = ${fmtLine(g.spread)}
total         = ${fmtTotal(g.total)}
books         = ${(g.books || []).map((b) => b.name).join(", ") || "—"}

marginExp = −spread = ${(-g.spread).toFixed(2)}
homeExp   = (total − spread) / 2 = ${exp.homeExp.toFixed(2)}
awayExp   = (total + spread) / 2 = ${exp.awayExp.toFixed(2)}`;
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
          <div class="sub">mean ${fmtScore(result.meanAway)} pts</div>
        </div>
        <div class="stat home">
          <div class="label">${g.home.abbr} win</div>
          <div class="value">${fmtPct(result.homeWinPct)}</div>
          <div class="sub">mean ${fmtScore(result.meanHome)} pts</div>
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

  const marginHist = histogram(result.margins, 2);
  const totalHist = histogram(result.totals, 2);

  drawHistogram($("#chart-margin"), marginHist, {
    title: "Margin distribution (home − away)",
    color: "#5b8cff",
    zeroLine: true,
    marker: -result.spread,
    markerLabel: "spread",
    xLabel: "points",
  });

  drawHistogram($("#chart-total"), totalHist, {
    title: "Total points distribution",
    color: "#3dd68c",
    marker: result.totalLine,
    markerLabel: "O/U",
    xLabel: "points",
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
    const result = runSimulation(g, state.n);
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
    const result = runSimulation(g, PICK_BOARD_N);
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
    status.textContent = `Pick Board ready · ${candidates.length} games simmed @ ${PICK_BOARD_N.toLocaleString()} trials · Week ${state.week}${featNote}`;
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
        <p class="waiting-msg">Waiting on lines — no consensus yet.</p>
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
          `<span class="lean-badge spread ${l.side}">ATS · ${escapeHtml(l.label)} <small>${escapeHtml(l.book)}</small></span>`
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

      <div class="pick-grid">
        <div class="pick-box">
          <div class="k">Consensus</div>
          <div class="v mono">${g.home.abbr} ${fmtLine(g.spread)} · O/U ${fmtTotal(g.total)}</div>
          <div class="sub">${(g.books || []).length} books · median</div>
        </div>
        <div class="pick-box line-shop">
          <div class="k">Best home spread</div>
          <div class="v mono ${bestHomeCls}">${shop?.bestHome ? `${fmtLine(shop.bestHome.spread)} <small>${escapeHtml(shop.bestHome.book)}</small>` : "—"}</div>
          <div class="sub">vs cons ${fmtLine(shop?.consensus)}${shop?.bestHome ? ` · Δ ${(shop.homeEdge >= 0 ? "+" : "") + shop.homeEdge.toFixed(2)}` : ""}</div>
        </div>
        <div class="pick-box line-shop">
          <div class="k">Best away spread</div>
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
  setLoading(true, "Fetching snapshot + live ESPN DraftKings…");

  try {
    const data = await loadMultiBookLines({
      week: ESPN_DEFAULTS.week,
      dates: ESPN_DEFAULTS.dates,
    });
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

    const badge = $("#badge-source");
    if (badge) {
      const nBooks = new Set(
        data.games.flatMap((g) => (g.books || []).map((b) => b.name))
      ).size;
      badge.textContent = `Multi-book · ${nBooks} sources · Week ${data.week}`;
    }

    const stamp = $("#lines-updated");
    if (stamp) {
      stamp.textContent = `Lines updated: ${fmtFetched(data.snapshotAt || data.fetchedAt)} (snapshot) · ESPN DK live merge ${data.liveEspnAt ? fmtFetched(data.liveEspnAt) : "off"} · consensus = median · not betting advice`;
    }

    renderPickBoard();
    await runPickBoardSims({ force: true });
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

function init() {
  setNPills();
  const sigma = $("#model-sigma");
  const rho = $("#model-rho");
  if (sigma) sigma.textContent = String(MODEL.scoreSigma);
  if (rho) rho.textContent = String(MODEL.scoreCorrelation);

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
    const marginHist = histogram(r.margins, 2);
    const totalHist = histogram(r.totals, 2);
    const cm = $("#chart-margin");
    const ct = $("#chart-total");
    if (cm)
      drawHistogram(cm, marginHist, {
        title: "Margin distribution (home − away)",
        color: "#5b8cff",
        zeroLine: true,
        marker: -r.spread,
        markerLabel: "spread",
        xLabel: "points",
      });
    if (ct)
      drawHistogram(ct, totalHist, {
        title: "Total points distribution",
        color: "#3dd68c",
        marker: r.totalLine,
        markerLabel: "O/U",
        xLabel: "points",
      });
  });

  setView("pickboard");
  loadLines();
}

init();
