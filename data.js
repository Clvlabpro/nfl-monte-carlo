/**
 * Sample NFL matchup data — synthetic ratings for demo only.
 * Ratings are relative: 0 = league average.
 * offense: expected scoring edge vs avg defense
 * defense: points-suppression edge (higher = better D, lowers opponent score)
 * form: recent-form adjustment baked into expected points
 * hfa: home-field advantage points added to home expected score
 */

export const MODEL = {
  basePoints: 22.5,
  homeFieldAdvantage: 2.4,
  scoreSigma: 9.8,
  scoreCorrelation: 0.18,
  /** Soft floor so rare ultra-low draws don't go negative after rounding */
  minScore: 0,
};

export const GAMES = [
  {
    id: "kc-buf",
    label: "Buffalo @ Kansas City",
    week: "Week 3",
    away: { abbr: "BUF", name: "Buffalo Bills", offense: 4.8, defense: 2.1, form: 1.2 },
    home: { abbr: "KC", name: "Kansas City Chiefs", offense: 5.2, defense: 1.4, form: 0.8 },
    spread: -2.5, // home favored by 2.5
    total: 48.5,
  },
  {
    id: "phi-dal",
    label: "Dallas @ Philadelphia",
    week: "Week 3",
    away: { abbr: "DAL", name: "Dallas Cowboys", offense: 3.1, defense: -0.5, form: -0.4 },
    home: { abbr: "PHI", name: "Philadelphia Eagles", offense: 4.0, defense: 2.8, form: 1.5 },
    spread: -6.5,
    total: 47.0,
  },
  {
    id: "sf-sea",
    label: "San Francisco @ Seattle",
    week: "Week 3",
    away: { abbr: "SF", name: "San Francisco 49ers", offense: 3.6, defense: 3.2, form: 0.6 },
    home: { abbr: "SEA", name: "Seattle Seahawks", offense: 1.8, defense: 0.4, form: 0.9 },
    spread: 2.5, // home underdog
    total: 44.5,
  },
  {
    id: "det-gb",
    label: "Detroit @ Green Bay",
    week: "Week 3",
    away: { abbr: "DET", name: "Detroit Lions", offense: 5.5, defense: 0.2, form: 1.8 },
    home: { abbr: "GB", name: "Green Bay Packers", offense: 2.4, defense: 0.8, form: 0.3 },
    spread: 3.0,
    total: 49.5,
  },
  {
    id: "bal-cin",
    label: "Baltimore @ Cincinnati",
    week: "Week 3",
    away: { abbr: "BAL", name: "Baltimore Ravens", offense: 4.2, defense: 1.6, form: 0.5 },
    home: { abbr: "CIN", name: "Cincinnati Bengals", offense: 3.9, defense: -1.2, form: -0.8 },
    spread: -1.5,
    total: 51.5,
  },
  {
    id: "mia-nyj",
    label: "Miami @ New York Jets",
    week: "Week 3",
    away: { abbr: "MIA", name: "Miami Dolphins", offense: 2.0, defense: -0.8, form: -1.0 },
    home: { abbr: "NYJ", name: "New York Jets", offense: 0.5, defense: 1.9, form: 0.2 },
    spread: -3.0,
    total: 41.5,
  },
  {
    id: "lar-ari",
    label: "LA Rams @ Arizona",
    week: "Week 3",
    away: { abbr: "LAR", name: "Los Angeles Rams", offense: 2.8, defense: 1.1, form: 0.7 },
    home: { abbr: "ARI", name: "Arizona Cardinals", offense: 1.2, defense: -0.3, form: 0.4 },
    spread: -1.0,
    total: 45.5,
  },
  {
    id: "tb-atl",
    label: "Tampa Bay @ Atlanta",
    week: "Week 3",
    away: { abbr: "TB", name: "Tampa Bay Buccaneers", offense: 2.6, defense: 0.6, form: 0.1 },
    home: { abbr: "ATL", name: "Atlanta Falcons", offense: 2.2, defense: 0.0, form: 0.5 },
    spread: -2.0,
    total: 46.0,
  },
  {
    id: "min-chi",
    label: "Minnesota @ Chicago",
    week: "Week 3",
    away: { abbr: "MIN", name: "Minnesota Vikings", offense: 1.5, defense: 2.4, form: 0.0 },
    home: { abbr: "CHI", name: "Chicago Bears", offense: 0.8, defense: 0.5, form: 1.1 },
    spread: -1.5,
    total: 42.5,
  },
  {
    id: "hou-ind",
    label: "Houston @ Indianapolis",
    week: "Week 3",
    away: { abbr: "HOU", name: "Houston Texans", offense: 2.9, defense: 2.0, form: 0.9 },
    home: { abbr: "IND", name: "Indianapolis Colts", offense: 1.6, defense: -0.6, form: -0.2 },
    spread: 3.5,
    total: 44.0,
  },
  {
    id: "den-lv",
    label: "Denver @ Las Vegas",
    week: "Week 3",
    away: { abbr: "DEN", name: "Denver Broncos", offense: 1.0, defense: 2.7, form: 1.4 },
    home: { abbr: "LV", name: "Las Vegas Raiders", offense: 0.2, defense: -1.0, form: -1.2 },
    spread: 4.5,
    total: 40.5,
  },
  {
    id: "pit-cle",
    label: "Pittsburgh @ Cleveland",
    week: "Week 3",
    away: { abbr: "PIT", name: "Pittsburgh Steelers", offense: 0.6, defense: 2.2, form: 0.3 },
    home: { abbr: "CLE", name: "Cleveland Browns", offense: -0.4, defense: 1.5, form: -0.6 },
    spread: -2.5,
    total: 38.5,
  },
];
