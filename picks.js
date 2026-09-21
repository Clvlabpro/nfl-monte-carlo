/**
 * Pick Board lean heuristics (transparent, not a proprietary edge model).
 *
 * Line shop: home spread is home-team perspective (negative = home favored).
 *   Best home ATS number = algebraically largest home spread (lay fewer / get more).
 *   Best away ATS number = algebraically smallest home spread (= largest away points).
 * Shop edge ≥ 0.5 pts vs consensus → ATS lean for that side.
 *
 * ML lean: market-calibrated Monte Carlo win% ≥ 58% home / ≤ 42% away.
 */

export const SHOP_EDGE_PTS = 0.5;
export const ML_HOME_THRESH = 0.58;
export const ML_AWAY_THRESH = 0.42;
export const PICK_BOARD_N = 8000;

/** Format signed line (supports .25 medians). */
export function fmtLine(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n === 0) return "PK";
  const sign = n > 0 ? "+" : "";
  const rounded = Math.round(n * 100) / 100;
  return `${sign}${rounded}`;
}

export function fmtTotal(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  return String(Math.round(n * 100) / 100);
}

export function fmtPct(x) {
  if (x == null || !Number.isFinite(x)) return "—";
  return (x * 100).toFixed(1) + "%";
}

/**
 * Best available home/away spreads across books vs consensus.
 * @param {{ books?: {name:string,spread:number}[], consensus?: {spread:number}, spread?: number }} game
 */
export function lineShop(game) {
  const books = (game.books || []).filter(
    (b) => b && Number.isFinite(Number(b.spread))
  );
  const consensus =
    game.consensus?.spread ??
    (Number.isFinite(game.spread) ? game.spread : null);

  if (!books.length || consensus == null) {
    return {
      consensus,
      bestHome: null,
      bestAway: null,
      homeEdge: 0,
      awayEdge: 0,
    };
  }

  let bestHome = null; // max home spread
  let bestAway = null; // min home spread (best for away)
  for (const b of books) {
    const s = Number(b.spread);
    if (!bestHome || s > bestHome.spread) {
      bestHome = { book: b.name, spread: s, side: "home" };
    }
    if (!bestAway || s < bestAway.homeSpread) {
      bestAway = {
        book: b.name,
        homeSpread: s,
        spread: -s, // away perspective
        side: "away",
      };
    }
  }

  const homeEdge = bestHome ? bestHome.spread - consensus : 0;
  const awayEdge = bestAway ? bestAway.spread - -consensus : 0;

  return {
    consensus,
    bestHome: bestHome
      ? { ...bestHome, edge: homeEdge, better: homeEdge >= SHOP_EDGE_PTS }
      : null,
    bestAway: bestAway
      ? { ...bestAway, edge: awayEdge, better: awayEdge >= SHOP_EDGE_PTS }
      : null,
    homeEdge,
    awayEdge,
  };
}

/**
 * Compute lean recommendations from line shop + quick MC win%.
 * @param {object} game
 * @param {{ homeWinPct: number, awayWinPct: number } | null} sim
 */
export function computeLeans(game, sim) {
  const shop = lineShop(game);
  const why = [];
  const spreadLeans = [];
  const mlLeans = [];

  if (shop.bestHome?.better) {
    const lean = {
      type: "spread",
      side: "home",
      label: `${game.home.abbr} ${fmtLine(shop.bestHome.spread)}`,
      book: shop.bestHome.book,
      edge: shop.bestHome.edge,
    };
    spreadLeans.push(lean);
    why.push(
      `Line shop: ${shop.bestHome.book} offers ${game.home.abbr} ${fmtLine(shop.bestHome.spread)} vs consensus ${fmtLine(shop.consensus)} (+${shop.bestHome.edge.toFixed(2)} pts) → lean ${game.home.abbr} ATS`
    );
  }

  if (shop.bestAway?.better) {
    const lean = {
      type: "spread",
      side: "away",
      label: `${game.away.abbr} ${fmtLine(shop.bestAway.spread)}`,
      book: shop.bestAway.book,
      edge: shop.bestAway.edge,
    };
    spreadLeans.push(lean);
    why.push(
      `Line shop: ${shop.bestAway.book} offers ${game.away.abbr} ${fmtLine(shop.bestAway.spread)} vs consensus ${fmtLine(-shop.consensus)} (+${shop.bestAway.edge.toFixed(2)} pts) → lean ${game.away.abbr} ATS`
    );
  }

  const homeWin = sim?.homeWinPct ?? null;
  const awayWin = sim?.awayWinPct ?? null;

  if (homeWin != null && homeWin >= ML_HOME_THRESH) {
    mlLeans.push({
      type: "ml",
      side: "home",
      label: `${game.home.abbr} ML`,
      winPct: homeWin,
    });
    why.push(
      `ML lean: market-implied home win% ${fmtPct(homeWin)} ≥ ${fmtPct(ML_HOME_THRESH)} → lean ${game.home.abbr} ML`
    );
  } else if (awayWin != null && awayWin >= 1 - ML_AWAY_THRESH) {
    // awayWinPct >= 58% same as homeWinPct <= 42%
    mlLeans.push({
      type: "ml",
      side: "away",
      label: `${game.away.abbr} ML`,
      winPct: awayWin,
    });
    why.push(
      `ML lean: market-implied away win% ${fmtPct(awayWin)} (home ≤ ${fmtPct(ML_AWAY_THRESH)}) → lean ${game.away.abbr} ML`
    );
  } else if (homeWin != null && homeWin <= ML_AWAY_THRESH) {
    mlLeans.push({
      type: "ml",
      side: "away",
      label: `${game.away.abbr} ML`,
      winPct: awayWin ?? 1 - homeWin,
    });
    why.push(
      `ML lean: market-implied home win% ${fmtPct(homeWin)} ≤ ${fmtPct(ML_AWAY_THRESH)} → lean ${game.away.abbr} ML`
    );
  }

  // Prefer stronger shop edge as primary display; else ML; else none
  let primary = null;
  if (spreadLeans.length) {
    primary = spreadLeans.slice().sort((a, b) => b.edge - a.edge)[0];
  } else if (mlLeans.length) {
    primary = mlLeans[0];
  }

  const hasLean = spreadLeans.length > 0 || mlLeans.length > 0;
  if (!hasLean) {
    why.push("No lean — market too tight / no shop edge.");
  }

  return {
    shop,
    spreadLeans,
    mlLeans,
    primary,
    hasLean,
    hasSpreadLean: spreadLeans.length > 0,
    hasMlLean: mlLeans.length > 0,
    why,
    homeWinPct: homeWin,
    awayWinPct: awayWin,
  };
}
