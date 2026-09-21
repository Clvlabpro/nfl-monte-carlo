/**
 * Multi-book lines: bake snapshot (lines.json) + live ESPN DraftKings merge.
 * Consensus = median of available books. FanDuel/BetMGM/Bovada are not CORS-friendly
 * from github.io, so Refresh reloads the snapshot and re-fetches ESPN only.
 */

import { ESPN_DEFAULTS } from "./data.js";
import { fetchEspnScoreboard } from "./espn.js";

function median(vals) {
  const v = vals.filter((x) => Number.isFinite(x)).slice().sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

function gameKey(awayAbbr, homeAbbr) {
  return `${awayAbbr}@${homeAbbr}`;
}

function dedupeBooks(books) {
  const seen = new Set();
  const out = [];
  for (const b of books) {
    if (!b?.name || seen.has(b.name)) continue;
    seen.add(b.name);
    out.push(b);
  }
  return out;
}

function withConsensus(game) {
  const books = dedupeBooks(game.books || []);
  const spreads = books.map((b) => Number(b.spread)).filter(Number.isFinite);
  const totals = books.map((b) => Number(b.total)).filter(Number.isFinite);
  const spread = median(spreads);
  const total = median(totals);
  const hasOdds = spread != null && total != null;
  return {
    ...game,
    books,
    consensus: hasOdds ? { spread, total, method: "median" } : null,
    spread: hasOdds ? spread : null,
    total: hasOdds ? total : null,
    hasOdds,
    book: hasOdds ? `consensus (${books.length} books)` : null,
  };
}

/**
 * Load baked lines.json (relative to site root).
 */
export async function fetchLinesSnapshot() {
  const res = await fetch("./lines.json", { cache: "no-store" });
  if (!res.ok) throw new Error(`lines.json HTTP ${res.status}`);
  const data = await res.json();
  return data;
}

/**
 * Merge live ESPN DraftKings into snapshot books; recompute median consensus.
 */
export async function loadMultiBookLines(opts = {}) {
  const week = opts.week ?? ESPN_DEFAULTS.week;
  const dates = opts.dates ?? ESPN_DEFAULTS.dates;

  let snapshot = null;
  let snapshotError = null;
  try {
    snapshot = await fetchLinesSnapshot();
  } catch (err) {
    snapshotError = err.message || String(err);
  }

  let espn = null;
  let espnError = null;
  try {
    espn = await fetchEspnScoreboard({ week, dates, seasontype: 2 });
  } catch (err) {
    espnError = err.message || String(err);
  }

  if (!snapshot && !espn) {
    throw new Error(
      `No lines available (snapshot: ${snapshotError}; ESPN: ${espnError})`
    );
  }

  const byKey = new Map();

  // Seed from snapshot
  if (snapshot?.games) {
    for (const g of snapshot.games) {
      const key = g.key || gameKey(g.away.abbr, g.home.abbr);
      byKey.set(key, {
        id: g.id,
        key,
        away: g.away,
        home: g.home,
        kickoffIso: g.kickoffIso,
        kickoffMs: g.kickoffIso ? Date.parse(g.kickoffIso) : 0,
        completed: Boolean(g.completed),
        status: g.completed ? "STATUS_FINAL" : "STATUS_SCHEDULED",
        statusState: g.completed ? "post" : "pre",
        statusDetail: g.completed ? "Final" : "",
        books: [...(g.books || [])],
        label: `${g.away.name} @ ${g.home.name}`,
      });
    }
  }

  // Overlay / merge ESPN live (status, scores, DraftKings book)
  if (espn?.games) {
    for (const eg of espn.games) {
      const key = gameKey(eg.away.abbr, eg.home.abbr);
      let g = byKey.get(key);
      if (!g) {
        g = {
          id: eg.id,
          key,
          away: eg.away,
          home: eg.home,
          kickoffIso: eg.kickoffIso,
          kickoffMs: eg.kickoffMs,
          completed: eg.completed,
          status: eg.status,
          statusState: eg.statusState,
          statusDetail: eg.statusDetail,
          books: [],
          label: eg.label,
        };
        byKey.set(key, g);
      } else {
        g.id = eg.id || g.id;
        g.kickoffIso = eg.kickoffIso || g.kickoffIso;
        g.kickoffMs = eg.kickoffMs || g.kickoffMs;
        g.completed = eg.completed;
        g.status = eg.status;
        g.statusState = eg.statusState;
        g.statusDetail = eg.statusDetail;
        g.away = { ...g.away, ...eg.away };
        g.home = { ...g.home, ...eg.home };
        g.label = eg.label || g.label;
      }

      if (eg.hasOdds && eg.spread != null && eg.total != null) {
        // Replace any existing DraftKings / ESPN book with live DK
        g.books = g.books.filter(
          (b) => b.name !== "DraftKings" && b.name !== "ESPN"
        );
        g.books.unshift({
          name: eg.book || "DraftKings",
          spread: eg.spread,
          total: eg.total,
          fetchedAt: espn.fetchedAt,
          source: "espn-live",
        });
      }
    }
  }

  const games = [...byKey.values()]
    .map(withConsensus)
    .sort((a, b) => (a.kickoffMs || 0) - (b.kickoffMs || 0));

  const snapshotAt = snapshot?.fetchedAt || null;
  const liveAt = espn?.fetchedAt || null;

  return {
    week: espn?.week ?? snapshot?.week ?? week,
    seasonYear: espn?.seasonYear ?? snapshot?.seasonYear ?? dates,
    games,
    fetchedAt: liveAt || snapshotAt || new Date().toISOString(),
    snapshotAt,
    liveEspnAt: liveAt,
    consensusMethod: "median",
    sources: {
      snapshot: snapshot
        ? { ok: true, books: snapshot.sources, fetchedAt: snapshotAt }
        : { ok: false, error: snapshotError },
      espnLive: espn
        ? { ok: true, fetchedAt: liveAt }
        : { ok: false, error: espnError },
    },
    disclaimer:
      snapshot?.disclaimer ||
      "Multi-book lines; consensus is median. Not betting advice.",
  };
}

export function formatLinesTimestamp(iso) {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      timeZoneName: "short",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}
