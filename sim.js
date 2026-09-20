/**
 * Monte Carlo NFL score generator.
 * Model: correlated Gaussian scores around expected points,
 * then floored/rounded to integer points.
 */

import { MODEL } from "./data.js";

/**
 * Expected points for each side from ratings.
 * homeExp = base + off_home - def_away + form_home + HFA
 * awayExp = base + off_away - def_home + form_away
 */
export function expectedPoints(game, model = MODEL) {
  const hfa = model.homeFieldAdvantage;
  const homeExp =
    model.basePoints +
    game.home.offense -
    game.away.defense +
    game.home.form +
    hfa;
  const awayExp =
    model.basePoints +
    game.away.offense -
    game.home.defense +
    game.away.form;
  return { homeExp, awayExp, marginExp: homeExp - awayExp, totalExp: homeExp + awayExp };
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
 * Optimized for browser: Float64Array buffers, tight loop.
 */
export function runSimulation(game, n, opts = {}) {
  const model = { ...MODEL, ...(opts.model || {}) };
  const rng = opts.seed != null ? mulberry32(opts.seed) : Math.random;
  const { homeExp, awayExp } = expectedPoints(game, model);
  const sigma = model.scoreSigma;
  const rho = model.scoreCorrelation;
  const sqrt1r2 = Math.sqrt(1 - rho * rho);
  const minS = model.minScore;

  const homeScores = new Int16Array(n);
  const awayScores = new Int16Array(n);
  const margins = new Int16Array(n); // home - away
  const totals = new Int16Array(n);

  let homeWins = 0;
  let awayWins = 0;
  let ties = 0;
  let homeCover = 0; // home covers spread (home - away > -spread? wait)
  // Convention: spread is from home perspective (negative = home favored).
  // Home covers if (homeScore - awayScore) + spread > 0
  // e.g. KC -2.5: home covers if margin > 2.5 i.e. margin + (-2.5)? 
  // Standard: bettor takes home at -2.5 → home must win by 3+.
  // Home covers when homeScore + spread > awayScore, i.e. margin > -spread when spread negative...
  // homeScore - awayScore + spread > 0  →  margin + spread > 0
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
    // Correlated: away uses z1, home uses rho*z1 + sqrt(1-rho^2)*z2
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
  // Align to binWidth
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
