/**
 * Public betting splits (Action Network snapshot in splits.json).
 * Match pick-board games by away@home abbrs. Not betting advice.
 */

import { formatLinesTimestamp } from "./lines.js";

const SHARP_THRESHOLD = 10;

function gameKey(awayAbbr, homeAbbr) {
  return `${awayAbbr}@${homeAbbr}`;
}

/**
 * Load baked splits.json (relative to site root).
 * @returns {Promise<object|null>}
 */
export async function fetchSplitsSnapshot() {
  const res = await fetch("./splits.json", { cache: "no-store" });
  if (!res.ok) throw new Error(`splits.json HTTP ${res.status}`);
  return res.json();
}

/**
 * Attach splits onto each game (mutates games). Returns meta for UI stamp.
 * @param {Array} games
 * @param {object|null} snapshot
 */
export function mergeSplitsOntoGames(games, snapshot) {
  const byKey = snapshot?.byKey || {};
  if (snapshot?.games && !Object.keys(byKey).length) {
    for (const g of snapshot.games) {
      const k = g.key || gameKey(g.away, g.home);
      byKey[k] = g;
    }
  }

  let matched = 0;
  for (const g of games || []) {
    const key = g.key || gameKey(g.away?.abbr, g.home?.abbr);
    const split = byKey[key] || null;
    g.splits = split;
    if (split) matched += 1;
  }

  return {
    ok: Boolean(snapshot),
    matched,
    total: (games || []).length,
    fetchedAt: snapshot?.fetchedAt || null,
    source: snapshot?.source || "Action Network public betting",
    week: snapshot?.week ?? null,
    note: snapshot?.note || null,
    disclaimer: snapshot?.disclaimer || null,
    sharpThreshold: snapshot?.sharpThreshold ?? SHARP_THRESHOLD,
  };
}

export function formatSplitsTimestamp(iso) {
  return formatLinesTimestamp(iso);
}

/**
 * Whether a market row should show a sharp lean badge.
 * @param {{sharpLean?:string, homeMoney?:number, homeTickets?:number, awayMoney?:number, awayTickets?:number, overMoney?:number, overTickets?:number, underMoney?:number, underTickets?:number}} mkt
 * @param {"spread"|"moneyline"|"total"} kind
 */
export function sharpLeanFor(mkt, kind) {
  if (!mkt) return null;
  if (mkt.sharpLean) {
    const gapKey =
      mkt.sharpLean === "home"
        ? "homeSharpGap"
        : mkt.sharpLean === "away"
          ? "awaySharpGap"
          : mkt.sharpLean === "over"
            ? "overSharpGap"
            : mkt.sharpLean === "under"
              ? "underSharpGap"
              : null;
    const gap = gapKey != null ? mkt[gapKey] : mkt.sharpGap;
    return { side: mkt.sharpLean, gap: gap ?? mkt.sharpGap ?? null };
  }

  // Client-side fallback: lean side where money exceeds tickets by ≥ threshold
  const pairs =
    kind === "total"
      ? [
          ["over", mkt.overMoney, mkt.overTickets],
          ["under", mkt.underMoney, mkt.underTickets],
        ]
      : [
          ["home", mkt.homeMoney, mkt.homeTickets],
          ["away", mkt.awayMoney, mkt.awayTickets],
        ];
  let best = null;
  for (const [side, money, tickets] of pairs) {
    if (money == null || tickets == null) continue;
    const gap = money - tickets;
    if (gap < SHARP_THRESHOLD) continue;
    if (!best || gap > best.gap) best = { side, gap };
  }
  return best;
}

export { SHARP_THRESHOLD, gameKey };
