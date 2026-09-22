/**
 * Score generator for NFL (market-calibrated) and MLB (independent stats).
 *
 * NFL:
 *   marginExp = −spread
 *   homeExp   = (total − spread) / 2
 *   awayExp   = (total + spread) / 2
 *
 * MLB (independent — does NOT use spread+total for means):
 *   awayExp = 0.5*(away.rpg + home.rapg) + 0.35*(homeSP.era − leagueERA)
 *   homeExp = 0.5*(home.rpg + away.rapg) + 0.35*(awaySP.era − leagueERA) + HFA
 *   Missing SP ERA → drop that pitcher's term (0). Clamp ≈ [1.5, 7.5].
 *   Optional WHIP/K9 nudge (±0.15 max). No ties (extras until not tied).
 *   ERA sign: worse opposing SP (higher ERA) → more runs for this side (matches WHIP/K9).
 *
 * Books still used for ATS/OU vs posted lines and ML implied % / edge.
 */

import { MODEL, MLB_MODEL } from "./data.js";

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

function numOrNull(x) {
  if (x == null || x === "") return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

/** American odds → raw implied probability (with vig). */
export function americanToImpliedProb(odds) {
  const o = numOrNull(odds);
  if (o == null || o === 0) return null;
  if (o < 0) return (-o) / (-o + 100);
  return 100 / (o + 100);
}

/** Two-way no-vig probabilities from American ML. */
export function noVigMoneyline(homeOdds, awayOdds) {
  const h = americanToImpliedProb(homeOdds);
  const a = americanToImpliedProb(awayOdds);
  if (h == null || a == null) return { home: null, away: null, rawHome: h, rawAway: a };
  const s = h + a;
  if (!(s > 0)) return { home: null, away: null, rawHome: h, rawAway: a };
  return { home: h / s, away: a / s, rawHome: h, rawAway: a };
}

export function moneylineFromGame(game) {
  if (game?.moneyline?.home != null || game?.moneyline?.away != null) {
    return {
      home: numOrNull(game.moneyline.home),
      away: numOrNull(game.moneyline.away),
    };
  }
  const b = (game?.books || []).find(
    (x) => x && (x.moneylineHome != null || x.moneylineAway != null)
  );
  if (!b) return { home: null, away: null };
  return {
    home: numOrNull(b.moneylineHome),
    away: numOrNull(b.moneylineAway),
  };
}

/**
 * Expected points/runs implied by the sportsbook line (NFL / legacy).
 * @param {{ spread: number, total: number }} game
 * @param {object} model
 */
export function expectedPoints(game, model = MODEL) {
  const spread = Number(game.spread);
  const total = Number(game.total);
  if (!Number.isFinite(spread) || !Number.isFinite(total)) {
    throw new Error("expectedPoints requires finite spread and total");
  }
  const marginExp = -spread;
  const homeExp = (total + marginExp) / 2;
  const awayExp = (total - marginExp) / 2;
  return {
    homeExp,
    awayExp,
    marginExp,
    totalExp: homeExp + awayExp,
    pitcherAdj: 0,
    thinData: false,
    source: "market",
  };
}

/**
 * Optional ±whipK9Clamp nudge from opposing SP WHIP / K/9.
 * Better opposing SP (low WHIP, high K9) → fewer runs for this offense.
 */
function whipK9Nudge(opposingPitcher, model) {
  // Better opposing SP (low WHIP, high K9) → fewer runs for this offense.
  const lim = model.whipK9Clamp ?? 0.15;
  const whipC = model.whipCoeff ?? 0.1;
  const k9C = model.k9Coeff ?? 0.03;
  const leagueWHIP = model.leagueWHIP ?? 1.3;
  const leagueK9 = model.leagueK9 ?? 8.5;
  const whip = numOrNull(opposingPitcher?.stats?.whip);
  const k9 =
    numOrNull(opposingPitcher?.stats?.strikeoutsPer9Inn) ??
    numOrNull(opposingPitcher?.stats?.k9);
  let better = 0;
  if (whip != null) better += (leagueWHIP - whip) * whipC;
  if (k9 != null) better += (k9 - leagueK9) * k9C;
  return clamp(-better, -lim, lim);
}

/**
 * Independent MLB expected runs from rpg/rapg + SP ERA (+ optional WHIP/K9).
 * Does NOT use spread or total.
 */

/**
 * Effective LHB/RHB faced counts. Switch-hitters bat opposite of pitcher hand
 * (S vs LHP → R; S vs RHP → L).
 */
export function effectiveBatCounts(batMix, pitchHand) {
  const lhb = Number(batMix?.lhb) || 0;
  const rhb = Number(batMix?.rhb) || 0;
  const shb = Number(batMix?.shb) || 0;
  const hand = (pitchHand || batMix?.pitchHand || "").toUpperCase();
  let effL = lhb;
  let effR = rhb;
  if (hand === "L") {
    effR += shb; // S bats R vs LHP
  } else if (hand === "R") {
    effL += shb; // S bats L vs RHP
  } else {
    // unknown hand: split switchers 50/50
    effL += shb * 0.5;
    effR += shb * 0.5;
  }
  return { effL, effR, total: effL + effR, lhb, rhb, shb, pitchHand: hand || null };
}

/**
 * Platoon run adjustment for the batting side facing opposingSP.
 * facedOPS = lineup-weighted SP OPS-against (vsL/vsR).
 * neutralOPS = 0.5*(vsL+vsR) when both exist, else overall opsAgainst, else leagueOPS.
 * adj = clamp((facedOPS − neutralOPS) * platoonK, ±platoonClamp)
 * Strong vs lineup's handedness → negative (cut runs); weak → positive.
 */
export function platoonRunAdjust(battingBatMix, opposingPitcher, model = MLB_MODEL) {
  const st = opposingPitcher?.stats || {};
  const pitchHand =
    opposingPitcher?.pitchHand ||
    st.pitchHand ||
    null;
  const vsL = numOrNull(st.vsLhb?.ops);
  const vsR = numOrNull(st.vsRhb?.ops);
  if (vsL == null && vsR == null) {
    return {
      adj: 0,
      facedOPS: null,
      neutralOPS: null,
      effL: null,
      effR: null,
      pitchHand,
      reason: "no SP vs L/R OPS splits",
    };
  }
  const counts = effectiveBatCounts(battingBatMix, pitchHand);
  if (!(counts.total > 0)) {
    return {
      adj: 0,
      facedOPS: null,
      neutralOPS: null,
      ...counts,
      reason: "no bat mix",
    };
  }
  const useL = vsL != null ? vsL : vsR;
  const useR = vsR != null ? vsR : vsL;
  const facedOPS =
    (counts.effL * useL + counts.effR * useR) / counts.total;
  let neutralOPS;
  if (vsL != null && vsR != null) neutralOPS = 0.5 * (vsL + vsR);
  else neutralOPS = numOrNull(st.opsAgainst) ?? (model.leagueOPS ?? 0.72);

  const k = model.platoonK ?? 2.0;
  const lim = model.platoonClamp ?? 0.3;
  const adj = clamp((facedOPS - neutralOPS) * k, -lim, lim);
  return {
    adj,
    facedOPS,
    neutralOPS,
    vsLhbOPS: vsL,
    vsRhbOPS: vsR,
    pitchHand,
    effL: counts.effL,
    effR: counts.effR,
    lhb: counts.lhb,
    rhb: counts.rhb,
    shb: counts.shb,
    source: battingBatMix?.source || null,
    reason: null,
  };
}

export function expectedMlbRuns(game, model = MLB_MODEL) {
  const leagueR = model.leagueR ?? 4.25;
  const leagueERA = model.leagueERA ?? 4.1;
  const hfa = model.hfa ?? 0.12;
  const eraK = model.eraCoeff ?? 0.35;
  const lo = model.expClampLo ?? 1.5;
  const hi = model.expClampHi ?? 7.5;

  let thinData = false;
  const awayRpg = numOrNull(game.away?.rpg);
  const homeRapg = numOrNull(game.home?.rapg);
  const homeRpg = numOrNull(game.home?.rpg);
  const awayRapg = numOrNull(game.away?.rapg);

  const aOff = awayRpg != null ? awayRpg : ((thinData = true), leagueR);
  const hDef = homeRapg != null ? homeRapg : ((thinData = true), leagueR);
  const hOff = homeRpg != null ? homeRpg : ((thinData = true), leagueR);
  const aDef = awayRapg != null ? awayRapg : ((thinData = true), leagueR);

  const homeSpEra = numOrNull(game.homePitcher?.stats?.era);
  const awaySpEra = numOrNull(game.awayPitcher?.stats?.era);

  // Pitcher term: worse opposing SP (higher ERA vs league) → more runs for this side
  // (same direction as WHIP/K9 nudge; prior build had this sign inverted)
  const awayPitcherTerm =
    homeSpEra != null ? eraK * (homeSpEra - leagueERA) : 0;
  const homePitcherTerm =
    awaySpEra != null ? eraK * (awaySpEra - leagueERA) : 0;

  let awayExp = 0.5 * (aOff + hDef) + awayPitcherTerm;
  let homeExp = 0.5 * (hOff + aDef) + homePitcherTerm + hfa;

  const awayWhipAdj = whipK9Nudge(game.homePitcher, model);
  const homeWhipAdj = whipK9Nudge(game.awayPitcher, model);
  awayExp += awayWhipAdj;
  homeExp += homeWhipAdj;

  // Platoon: batting team batMix vs opposing SP hand + vsL/vsR OPS
  const awayPlatoon = platoonRunAdjust(game.away?.batMix, game.homePitcher, model);
  const homePlatoon = platoonRunAdjust(game.home?.batMix, game.awayPitcher, model);
  awayExp += awayPlatoon.adj;
  homeExp += homePlatoon.adj;

  awayExp = clamp(awayExp, lo, hi);
  homeExp = clamp(homeExp, lo, hi);

  return {
    homeExp,
    awayExp,
    marginExp: homeExp - awayExp,
    totalExp: homeExp + awayExp,
    pitcherAdj: homePitcherTerm - awayPitcherTerm,
    awayPitcherTerm,
    homePitcherTerm,
    awayWhipAdj,
    homeWhipAdj,
    awayPlatoon,
    homePlatoon,
    thinData,
    source: "stats",
    inputs: {
      awayRpg: aOff,
      homeRapg: hDef,
      homeRpg: hOff,
      awayRapg: aDef,
      homeSpEra,
      awaySpEra,
      leagueR,
      leagueERA,
      hfa,
      eraK,
    },
  };
}

/** True if this game can be simulated under the active model. */
export function canSimulate(game, sport = "nfl") {
  if (!game) return false;
  if (sport === "mlb") {
    // Stats model: need at least one side's rpg/rapg, or allow thin league-avg fallback
    return true; // always can fall back to leagueR; thinData flagged
  }
  return (
    game.hasOdds &&
    Number.isFinite(Number(game.spread)) &&
    Number.isFinite(Number(game.total))
  );
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
 * Force extras until scores are not tied (MLB has no ties).
 * Adds half-inning-ish run draws; guarantees progress.
 */
function forceExtras(h, a, homeExp, awayExp, rng) {
  let guard = 0;
  while (h === a && guard < 40) {
    guard++;
    const [z1, z2] = gauss2(rng);
    // ~one extra half-inning of offense each, floored at 0
    let aAdd = Math.round(Math.max(0, awayExp / 9 + 0.85 * z1));
    let hAdd = Math.round(Math.max(0, homeExp / 9 + 0.85 * z2));
    if (aAdd === 0 && hAdd === 0) {
      if (rng() < 0.5) aAdd = 1;
      else hAdd = 1;
    }
    a += aAdd;
    h += hAdd;
  }
  if (h === a) {
    // last resort coin flip
    if (rng() < 0.5) a += 1;
    else h += 1;
  }
  return [h, a];
}

/**
 * Run N simulations. Returns typed arrays + aggregates.
 * Pass opts.sport = "mlb" (or model.mode === "stats") for independent MLB means + no ties.
 */
export function runSimulation(game, n, opts = {}) {
  const sport = opts.sport || (opts.model?.mode === "stats" ? "mlb" : "nfl");
  const base = sport === "mlb" ? MLB_MODEL : MODEL;
  const model = { ...base, ...(opts.model || {}) };
  const rng = opts.seed != null ? mulberry32(opts.seed) : Math.random;

  const isMlbStats = sport === "mlb" || model.mode === "stats";

  let exp;
  if (isMlbStats) {
    exp = expectedMlbRuns(game, model);
  } else {
    if (game.spread == null || game.total == null) {
      throw new Error("Cannot simulate without spread and total");
    }
    exp = expectedPoints(game, model);
  }

  const { homeExp, awayExp } = exp;
  const sigma = model.scoreSigma;
  const rho = model.scoreCorrelation;
  const sqrt1r2 = Math.sqrt(1 - rho * rho);
  const minS = model.minScore;
  const noTies = Boolean(model.noTies) || isMlbStats;

  const hasSpread = Number.isFinite(Number(game.spread));
  const hasTotal = Number.isFinite(Number(game.total));
  const spread = hasSpread ? Number(game.spread) : null;
  const totalLine = hasTotal ? Number(game.total) : null;

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

  for (let i = 0; i < n; i++) {
    const [z1, z2] = gauss2(rng);
    const awayRaw = awayExp + sigma * z1;
    const homeRaw = homeExp + sigma * (rho * z1 + sqrt1r2 * z2);

    let h = Math.round(homeRaw);
    let a = Math.round(awayRaw);
    if (h < minS) h = minS;
    if (a < minS) a = minS;

    if (noTies && h === a) {
      [h, a] = forceExtras(h, a, homeExp, awayExp, rng);
    }

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

    if (hasSpread) {
      const ats = m + spread;
      if (ats > 0) homeCover++;
      else if (ats < 0) awayCover++;
      else pushesSpread++;
    }

    if (hasTotal) {
      if (t > totalLine) overs++;
      else if (t < totalLine) unders++;
      else pushTotal++;
    }
  }

  const homeWinPct = homeWins / n;
  const awayWinPct = awayWins / n;

  const ml = moneylineFromGame(game);
  const market = noVigMoneyline(ml.home, ml.away);
  const marketHomeWinPct = market.home;
  const marketAwayWinPct = market.away;
  const edge =
    marketHomeWinPct != null ? homeWinPct - marketHomeWinPct : null;
  const edgeAway =
    marketAwayWinPct != null ? awayWinPct - marketAwayWinPct : null;

  return {
    n,
    homeExp,
    awayExp,
    pitcherAdj: exp.pitcherAdj || 0,
    thinData: Boolean(exp.thinData),
    source: exp.source || (isMlbStats ? "stats" : "market"),
    exp,
    homeScores,
    awayScores,
    margins,
    totals,
    homeWins,
    awayWins,
    ties,
    homeWinPct,
    awayWinPct,
    tiePct: ties / n,
    meanHome: sumHome / n,
    meanAway: sumAway / n,
    meanMargin: (sumHome - sumAway) / n,
    meanTotal: (sumHome + sumAway) / n,
    homeCoverPct: hasSpread ? homeCover / n : null,
    awayCoverPct: hasSpread ? awayCover / n : null,
    pushSpreadPct: hasSpread ? pushesSpread / n : null,
    overPct: hasTotal ? overs / n : null,
    underPct: hasTotal ? unders / n : null,
    pushTotalPct: hasTotal ? pushTotal / n : null,
    spread,
    totalLine,
    marketHomeWinPct,
    marketAwayWinPct,
    edge,
    edgeAway,
    moneyline: ml,
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
