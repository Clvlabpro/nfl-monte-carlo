/**
 * Simulation model constants.
 * NFL: expected scores from market lines (spread + total).
 * MLB: independent stats model (rpg/rapg + SP ERA) — can disagree with books.
 */

/** NFL: per-team score noise ~10–11 pts residual variance. */
export const MODEL = {
  scoreSigma: 10.5,
  scoreCorrelation: 0.18,
  minScore: 0,
};

/**
 * MLB independent expected-runs model.
 * Means come from team rpg/rapg + starter ERA (optional WHIP/K9 nudge).
 * Books are used only for ATS/OU comparison and ML implied win% / edge.
 */
export const MLB_MODEL = {
  mode: "stats",
  scoreSigma: 3.0,
  scoreCorrelation: 0.2,
  minScore: 0,
  /** MLB has no ties — force extras when integer scores equal */
  noTies: true,
  leagueR: 4.25,
  leagueERA: 4.1,
  hfa: 0.12,
  /** Coefficient on (leagueERA − opposing SP ERA) */
  eraCoeff: 0.35,
  expClampLo: 1.5,
  expClampHi: 7.5,
  /** Optional small WHIP / K9 tweak (±whipK9Clamp max per side) */
  leagueWHIP: 1.3,
  leagueK9: 8.5,
  whipCoeff: 0.1,
  k9Coeff: 0.03,
  whipK9Clamp: 0.15,
  /** Platoon: weighted OPS-against faced by lineup mix vs SP's L/R neutral */
  leagueOPS: 0.720,
  platoonK: 2.0,
  platoonClamp: 0.30,
};

/** Default ESPN NFL scoreboard query (regular season Week 3, 2026). */
export const ESPN_DEFAULTS = {
  seasontype: 2,
  week: 3,
  dates: 2026,
};

/** Default sport on load. */
export const DEFAULT_SPORT = "nfl";
