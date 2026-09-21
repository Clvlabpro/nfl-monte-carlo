/**
 * Simulation model constants.
 * Expected scores come from live market lines (spread + total), not team ratings.
 * See expectedPoints() in sim.js.
 */
export const MODEL = {
  /** Per-team score noise (points). ~10–11 matches NFL residual variance. */
  scoreSigma: 10.5,
  /** Corr(home score, away score); pace/weather/blowout effects. */
  scoreCorrelation: 0.18,
  minScore: 0,
};

/** Default ESPN scoreboard query (regular season Week 3, 2026). */
export const ESPN_DEFAULTS = {
  seasontype: 2,
  week: 3,
  dates: 2026,
};
