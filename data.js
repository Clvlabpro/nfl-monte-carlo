/**
 * Simulation model constants.
 * Expected scores come from live market lines (spread/run line + total), not team ratings.
 * See expectedPoints() in sim.js.
 */

/** NFL: per-team score noise ~10–11 pts residual variance. */
export const MODEL = {
  scoreSigma: 10.5,
  scoreCorrelation: 0.18,
  minScore: 0,
};

/**
 * MLB: lower sigma (totals ~7–10 runs). Optional modest ERA pitcher adjust
 * clamped so we don't override the market wildly.
 */
export const MLB_MODEL = {
  scoreSigma: 3.2,
  scoreCorrelation: 0.22,
  minScore: 0,
  /** runs shifted per (awayERA − homeERA); positive ⇒ home SP better ⇒ margin toward home */
  pitcherEraK: 0.12,
  /** absolute max run shift from pitcher adjust */
  pitcherClamp: 0.75,
};

/** Default ESPN NFL scoreboard query (regular season Week 3, 2026). */
export const ESPN_DEFAULTS = {
  seasontype: 2,
  week: 3,
  dates: 2026,
};

/** Default sport on load. */
export const DEFAULT_SPORT = "nfl";
