import { MODEL } from "./data.js";
import { formatKickoff, statusLabel } from "./espn.js";
import { loadMultiBookLines, formatLinesTimestamp } from "./lines.js";
import { expectedPoints, runSimulation, histogram } from "./sim.js";
import { drawHistogram, drawWinBar } from "./charts.js";

const $ = (sel) => document.querySelector(sel);

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
};

function getGame() {
  return state.games.find((g) => g.id === state.gameId) || state.games[0] || null;
}

/** Format home spread / any signed line (supports .25 median). */
function fmtLine(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n === 0) return "PK";
  const sign = n > 0 ? "+" : "";
  const rounded = Math.round(n * 100) / 100;
  return `${sign}${rounded}`;
}
const fmtSpread = fmtLine;


function fmtTotal(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  const rounded = Math.round(n * 100) / 100;
  return String(rounded);
}

function fmtPct(x) {
  return (x * 100).toFixed(1) + "%";
}

function fmtScore(x) {
  return x.toFixed(1);
}

function fmtFetched(iso) {
  return formatLinesTimestamp(iso);
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
  if (!state.games.length) {
    sel.innerHTML = `<option value="">No games</option>`;
    return;
  }
  sel.innerHTML = state.games
    .map((g) => {
      const nBooks = (g.books || []).length;
      const tag = g.completed
        ? "FINAL"
        : g.hasOdds
          ? `consensus · ${nBooks}b`
          : "no line";
      return `<option value="${g.id}">${g.away.abbr} @ ${g.home.abbr} — ${tag}</option>`;
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
  if (g?.completed && g.home.score != null) {
    $("#results").innerHTML = `
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
    $("#results").innerHTML = `
      <div class="card empty-state">
        <strong>No line available</strong>
        No multi-book spread/total for this matchup. Pick another game or refresh later.
      </div>`;
    return;
  }
  const snap = state.snapshotAt ? fmtFetched(state.snapshotAt) : "—";
  $("#results").innerHTML = `
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

async function loadLines() {
  const btnRefresh = $("#btn-refresh");
  if (btnRefresh) btnRefresh.disabled = true;
  state.error = null;
  setLoading(true, "Fetching snapshot + live ESPN DraftKings…");

  try {
    const data = await loadMultiBookLines({ week: 2, dates: 2026 });
    state.games = data.games;
    state.week = data.week;
    state.seasonYear = data.seasonYear;
    state.fetchedAt = data.fetchedAt;
    state.snapshotAt = data.snapshotAt;
    state.liveEspnAt = data.liveEspnAt;
    state.sources = data.sources;
    state.error = null;

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
  } catch (err) {
    console.error(err);
    state.error = `Failed to load lines: ${err.message || err}`;
    setLoading(false);
    $("#results").innerHTML = `
      <div class="card empty-state">
        <strong>Could not load lines</strong>
        ${state.error}. Check your network and hit Refresh lines.
      </div>`;
  } finally {
    if (btnRefresh) btnRefresh.disabled = false;
    updateRunButton();
  }
}

function init() {
  setNPills();
  $("#model-sigma").textContent = String(MODEL.scoreSigma);
  $("#model-rho").textContent = String(MODEL.scoreCorrelation);

  $("#game-select").addEventListener("change", (e) => {
    state.gameId = e.target.value;
    state.lastResult = null;
    renderMatchupPreview();
    showEmpty();
  });

  document.querySelectorAll(".n-pills button").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.n = Number(btn.dataset.n);
      setNPills();
    });
  });

  $("#btn-run").addEventListener("click", run);
  $("#btn-refresh").addEventListener("click", () => loadLines());

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

  loadLines();
}

init();
