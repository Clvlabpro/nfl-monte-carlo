/**
 * Score generator (Gaussian market-calibrated sims) for NFL and MLB.
 *
 * Market-calibrated means from spread/run line + total:
 *   marginExp = −spread          // expected home − away
 *   homeExp   = (total − spread) / 2
 *   awayExp   = (total + spread) / 2
 *
 * MLB optional pitcher adjust (when both SPs have ERA):
 *   eraDiff = awayERA − homeERA
 *   pitcherAdj = clamp(eraDiff * pitcherEraK, −pitcherClamp, +pitcherClamp)
 *   homeExp += pitcherAdj / 2;  awayExp -= pitcherAdj / 2
 *
 * Correlated Gaussian noise → integer scores ≥ 0.
 */

import { MODEL } from "./data.js";

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

/**
 * Expected points/runs implied by the sportsbook line (+ optional pitcher adj).
 * @param {{ spread: number, total: number, awayPitcher?: object, homePitcher?: object }} game
 * @param {object} model
 */
export function expectedPoints(game, model = MODEL) {
  const spread = Number(game.spread);
  const total = Number(game.total);
  if (!Number.isFinite(spread) || !Number.isFinite(total)) {
    throw new Error("expectedPoints requires finite spread and total");
  }
  let marginExp = -spread;
  let homeExp = (total + marginExp) / 2; // (total - spread) / 2
  let awayExp = (total - marginExp) / 2; // (total + spread) / 2

  let pitcherAdj = 0;
  const k = model.pitcherEraK;
  const lim = model.pitcherClamp;
  if (k != null && lim != null) {
    const aEra = game.awayPitcher?.stats?.era;
    const hEra = game.homePitcher?.stats?.era;
    if (
      aEra != null &&
      hEra != null &&
      Number.isFinite(Number(aEra)) &&
      Number.isFinite(Number(hEra))
    ) {
      const eraDiff = Number(aEra) - Number(hEra);
      pitcherAdj = clamp(eraDiff * k, -lim, lim);
      homeExp += pitcherAdj / 2;
      awayExp -= pitcherAdj / 2;
      marginExp = homeExp - awayExp;
    }
  }

  return {
    homeExp,
    awayExp,
    marginExp,
    totalExp: homeExp + awayExp,
    pitcherAdj,
  };
}

/** Box-Muller → two independent N(0,1) samples */
function gauss2(rng) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  const r = Math.sqrt(-2 * Math.log(u));
  const theta = 2 * Math.PI * v;
  return [r * Math.cos(theta), r * Math.sin(theta)];
}

/** Mulberry32 PRNG for reproducibility option */
export function mulberry32(seed) {
  let t = seed >>> 0;
  return function () {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Run N simulations. Returns typed arrays + aggregates.
 * Pass opts.model = MLB_MODEL for baseball sigma / pitcher adjust.
 */
export function runSimulation(game, n, opts = {}) {
  if (game.spread == null || game.total == null) {
    throw new Error("Cannot simulate without spread and total");
  }
  const model = { ...MODEL, ...(opts.model || {}) };
  const rng = opts.seed != null ? mulberry32(opts.seed) : Math.random;
  const { homeExp, awayExp, pitcherAdj } = expectedPoints(game, model);
  const sigma = model.scoreSigma;
  const rho = model.scoreCorrelation;
  const sqrt1r2 = Math.sqrt(1 - rho * rho);
  const minS = model.minScore;

  const homeScores = new Int16Array(n);
  const awayScores = new Int16Array(n);
  const margins = new Int16Array(n);
  const totals = new Int16Array(n);

  let homeWins = 0;
  let awayWins = 0;
  let ties = 0;
  let homeCover = 0;
  let awayCover = 0;
  let pushesSpread = 0;
  let overs = 0;
  let unders = 0;
  let pushTotal = 0;
  let sumHome = 0;
  let sumAway = 0;

  const spread = game.spread;
  const totalLine = game.total;

  for (let i = 0; i < n; i++) {
    const [z1, z2] = gauss2(rng);
    const awayRaw = awayExp + sigma * z1;
    const homeRaw = homeExp + sigma * (rho * z1 + sqrt1r2 * z2);

    let h = Math.round(homeRaw);
    let a = Math.round(awayRaw);
    if (h < minS) h = minS;
    if (a < minS) a = minS;

    homeScores[i] = h;
    awayScores[i] = a;
    const m = h - a;
    const t = h + a;
    margins[i] = m;
    totals[i] = t;
    sumHome += h;
    sumAway += a;

    if (m > 0) homeWins++;
    else if (m < 0) awayWins++;
    else ties++;

    const ats = m + spread;
    if (ats > 0) homeCover++;
    else if (ats < 0) awayCover++;
    else pushesSpread++;

    if (t > totalLine) overs++;
    else if (t < totalLine) unders++;
    else pushTotal++;
  }

  return {
    n,
    homeExp,
    awayExp,
    pitcherAdj: pitcherAdj || 0,
    homeScores,
    awayScores,
    margins,
    totals,
    homeWins,
    awayWins,
    ties,
    homeWinPct: homeWins / n,
    awayWinPct: awayWins / n,
    tiePct: ties / n,
    meanHome: sumHome / n,
    meanAway: sumAway / n,
    meanMargin: (sumHome - sumAway) / n,
    meanTotal: (sumHome + sumAway) / n,
    homeCoverPct: homeCover / n,
    awayCoverPct: awayCover / n,
    pushSpreadPct: pushesSpread / n,
    overPct: overs / n,
    underPct: unders / n,
    pushTotalPct: pushTotal / n,
    spread,
    totalLine,
    model,
  };
}

/** Build histogram bins from Int16Array */
export function histogram(values, binWidth = 1, minOverride, maxOverride) {
  let min = minOverride;
  let max = maxOverride;
  if (min == null || max == null) {
    min = Infinity;
    max = -Infinity;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  const start = Math.floor(min / binWidth) * binWidth;
  const end = Math.ceil(max / binWidth) * binWidth;
  const count = Math.max(1, Math.round((end - start) / binWidth) + 1);
  const counts = new Float64Array(count);
  const centers = new Float64Array(count);
  for (let b = 0; b < count; b++) {
    centers[b] = start + b * binWidth;
  }
  for (let i = 0; i < values.length; i++) {
    const b = Math.round((values[i] - start) / binWidth);
    if (b >= 0 && b < count) counts[b]++;
  }
  return { centers, counts, binWidth, start, end };
}
