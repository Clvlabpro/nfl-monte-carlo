import { GAMES, MODEL } from "./data.js";
import { expectedPoints, runSimulation, histogram } from "./sim.js";
import { drawHistogram, drawWinBar } from "./charts.js";

const $ = (sel) => document.querySelector(sel);

const state = {
  gameId: GAMES[0].id,
  n: 10000,
  lastResult: null,
};

function getGame() {
  return GAMES.find((g) => g.id === state.gameId) || GAMES[0];
}

function fmtSpread(spread) {
  // Display as home line: negative = home favored
  if (spread === 0) return "PK";
  const sign = spread > 0 ? "+" : "";
  return `${sign}${spread.toFixed(1)}`;
}

function fmtPct(x) {
  return (x * 100).toFixed(1) + "%";
}

function fmtScore(x) {
  return x.toFixed(1);
}

function populateSelect() {
  const sel = $("#game-select");
  sel.innerHTML = GAMES.map(
    (g) =>
      `<option value="${g.id}">${g.away.abbr} @ ${g.home.abbr} — ${g.label}</option>`
  ).join("");
  sel.value = state.gameId;
}

function renderMatchupPreview() {
  const g = getGame();
  const exp = expectedPoints(g);
  $("#chip-away-abbr").textContent = g.away.abbr;
  $("#chip-away-name").textContent = g.away.name;
  $("#chip-home-abbr").textContent = g.home.abbr;
  $("#chip-home-name").textContent = g.home.name;
  $("#line-spread").textContent = `${g.home.abbr} ${fmtSpread(g.spread)}`;
  $("#line-total").textContent = g.total.toFixed(1);
  $("#exp-home").textContent = fmtScore(exp.homeExp);
  $("#exp-away").textContent = fmtScore(exp.awayExp);
  $("#exp-margin").textContent =
    (exp.marginExp >= 0 ? "+" : "") + fmtScore(exp.marginExp);

  const rows = [
    ["Offense", g.away.offense, g.home.offense],
    ["Defense", g.away.defense, g.home.defense],
    ["Form", g.away.form, g.home.form],
  ];
  $("#ratings-body").innerHTML = rows
    .map(
      ([k, a, h]) =>
        `<tr><td>${k}</td><td>${a >= 0 ? "+" : ""}${a.toFixed(1)}</td><td>${
          h >= 0 ? "+" : ""
        }${h.toFixed(1)}</td></tr>`
    )
    .join("");

  $("#model-exp").textContent = `E[away] = ${MODEL.basePoints} + off_away − def_home + form_away
           = ${MODEL.basePoints} + ${g.away.offense} − ${g.home.defense} + ${g.away.form}
           = ${exp.awayExp.toFixed(2)}

E[home] = ${MODEL.basePoints} + off_home − def_away + form_home + HFA
           = ${MODEL.basePoints} + ${g.home.offense} − ${g.away.defense} + ${g.home.form} + ${MODEL.homeFieldAdvantage}
           = ${exp.homeExp.toFixed(2)}`;
}

function setNPills() {
  document.querySelectorAll(".n-pills button").forEach((btn) => {
    btn.classList.toggle("active", Number(btn.dataset.n) === state.n);
  });
}

function showEmpty() {
  $("#results").innerHTML = `
    <div class="card empty-state">
      <strong>Ready to simulate</strong>
      Pick a matchup and hit Run Simulation. Default is 10,000 trials in-browser.
    </div>`;
}

function renderResults(result, ms) {
  const g = getGame();
  const el = $("#results");

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
          <div class="sub">line ${result.totalLine.toFixed(1)}</div>
        </div>
      </div>
      <div class="stat-row" style="margin-top:4px">
        <div class="stat">
          <div class="label">${g.home.abbr} covers ${fmtSpread(result.spread)}</div>
          <div class="value">${fmtPct(result.homeCoverPct)}</div>
          <div class="sub">away ${fmtPct(result.awayCoverPct)} · push ${fmtPct(result.pushSpreadPct)}</div>
        </div>
        <div class="stat">
          <div class="label">Over ${result.totalLine.toFixed(1)}</div>
          <div class="value">${fmtPct(result.overPct)}</div>
          <div class="sub">under ${fmtPct(result.underPct)} · push ${fmtPct(result.pushTotalPct)}</div>
        </div>
        <div class="stat">
          <div class="label">Model E[home]</div>
          <div class="value">${fmtScore(result.homeExp)}</div>
          <div class="sub">pre-noise expected</div>
        </div>
        <div class="stat">
          <div class="label">Model E[away]</div>
          <div class="value">${fmtScore(result.awayExp)}</div>
          <div class="sub">pre-noise expected</div>
        </div>
      </div>
      <div class="charts">
        <div class="chart-card"><canvas id="chart-margin"></canvas></div>
        <div class="chart-card"><canvas id="chart-total"></canvas></div>
      </div>
      <p class="timing">Completed in ${ms.toFixed(0)} ms · model estimates from placeholder ratings — not live market odds</p>
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
  const btn = $("#btn-run");
  btn.disabled = true;
  btn.textContent = "Simulating…";

  // Yield so UI updates, then run sync (fast enough for 25k)
  requestAnimationFrame(() => {
    const t0 = performance.now();
    const result = runSimulation(getGame(), state.n);
    const ms = performance.now() - t0;
    state.lastResult = result;
    renderResults(result, ms);
    btn.disabled = false;
    btn.textContent = "Run Simulation";
  });
}

function init() {
  populateSelect();
  setNPills();
  renderMatchupPreview();
  showEmpty();

  $("#game-select").addEventListener("change", (e) => {
    state.gameId = e.target.value;
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

  window.addEventListener("resize", () => {
    if (!state.lastResult) return;
    const g = getGame();
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
}

init();
