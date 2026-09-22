/**
 * MLB lines: mlb-lines.json snapshot + live ESPN DraftKings merge + mlb-splits.json.
 * Consensus = median of available books (currently ESPN DK only in snapshot).
 * Does not invent odds — waiting on lines when RL/total missing.
 */

import { readableTeamColor, teamColorHex, formatKickoff, statusLabel } from "./espn.js";
import { mergeSplitsOntoGames, formatSplitsTimestamp } from "./splits.js";
import { formatLinesTimestamp } from "./lines.js";

function median(vals) {
  const v = vals.filter((x) => Number.isFinite(x)).slice().sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

function gameKey(awayAbbr, homeAbbr) {
  return `${awayAbbr}@${homeAbbr}`;
}

function yyyymmdd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

/** Calendar dates in America/Chicago: today + next 3. */
export function mlbDateWindow(daysAhead = 3) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  // en-CA → YYYY-MM-DD
  const todayStr = fmt.format(new Date());
  const [y, m, d] = todayStr.split("-").map(Number);
  const out = [];
  for (let i = 0; i <= daysAhead; i++) {
    const dt = new Date(Date.UTC(y, m - 1, d + i));
    out.push(yyyymmdd(dt));
  }
  return out;
}

function withConsensus(game) {
  const books = game.books || [];
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

function tintTeam(team) {
  if (!team) return team;
  const raw = team.colorRaw || team.color || null;
  const hex =
    raw && String(raw).startsWith("#")
      ? raw
      : raw
        ? `#${raw}`
        : teamColorHex(team);
  return {
    ...team,
    colorRaw: hex,
    color: readableTeamColor(hex) || team.color || null,
  };
}

export async function fetchMlbLinesSnapshot() {
  const res = await fetch("./mlb-lines.json", { cache: "no-store" });
  if (!res.ok) throw new Error(`mlb-lines.json HTTP ${res.status}`);
  return res.json();
}

export async function fetchMlbSplitsSnapshot() {
  const res = await fetch("./mlb-splits.json", { cache: "no-store" });
  if (!res.ok) throw new Error(`mlb-splits.json HTTP ${res.status}`);
  return res.json();
}

const ESPN_MLB_URLS = [
  "https://site.web.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard",
  "https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard",
];

function parseAmerican(odds) {
  if (odds == null) return null;
  const s = String(odds).trim().replace("−", "-");
  if (!s) return null;
  if (s.toLowerCase() === "even") return 100;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function normalizeEspnMlbEvent(event) {
  const comp = event?.competitions?.[0];
  if (!comp) return null;
  const competitors = comp.competitors || [];
  const homeC = competitors.find((c) => c.homeAway === "home");
  const awayC = competitors.find((c) => c.homeAway === "away");
  if (!homeC || !awayC) return null;

  const statusType = event?.status?.type || {};
  const statusName = statusType.name || "STATUS_SCHEDULED";
  const statusState = statusType.state || "pre";
  const completed =
    Boolean(statusType.completed) || statusName === "STATUS_FINAL";

  const odds0 =
    Array.isArray(comp.odds) && comp.odds.length ? comp.odds[0] : null;
  let spread = null;
  let total = null;
  let book = null;
  let hasOdds = false;
  let mlHome = null;
  let mlAway = null;

  if (odds0 && odds0.spread != null && odds0.overUnder != null) {
    spread = Number(odds0.spread);
    total = Number(odds0.overUnder);
    if (Number.isFinite(spread) && Number.isFinite(total)) {
      hasOdds = true;
      book = odds0.provider?.name || odds0.provider?.displayName || "DraftKings";
    } else {
      spread = null;
      total = null;
    }
  }
  if (odds0?.moneyline) {
    mlHome = parseAmerican(odds0.moneyline?.home?.close?.odds);
    mlAway = parseAmerican(odds0.moneyline?.away?.close?.odds);
  }

  const homeAbbr = homeC.team?.abbreviation || "?";
  const awayAbbr = awayC.team?.abbreviation || "?";
  const homeLogo =
    odds0?.homeTeamOdds?.team?.logo ||
    homeC.team?.logo ||
    `https://a.espncdn.com/i/teamlogos/mlb/500/scoreboard/${String(homeAbbr).toLowerCase()}.png`;
  const awayLogo =
    odds0?.awayTeamOdds?.team?.logo ||
    awayC.team?.logo ||
    `https://a.espncdn.com/i/teamlogos/mlb/500/scoreboard/${String(awayAbbr).toLowerCase()}.png`;

  const dateIso = event.date || comp.date || null;
  return {
    id: String(event.id || `${awayAbbr}-${homeAbbr}`.toLowerCase()),
    key: gameKey(awayAbbr, homeAbbr),
    kickoffIso: dateIso,
    kickoffMs: dateIso ? Date.parse(dateIso) : 0,
    status: statusName,
    statusState,
    statusDetail: statusType.detail || statusType.description || "",
    completed,
    away: {
      abbr: awayAbbr,
      name: awayC.team?.displayName || awayAbbr,
      logo: awayLogo,
      color: readableTeamColor(teamColorHex(awayC.team)),
      colorRaw: teamColorHex(awayC.team),
    },
    home: {
      abbr: homeAbbr,
      name: homeC.team?.displayName || homeAbbr,
      logo: homeLogo,
      color: readableTeamColor(teamColorHex(homeC.team)),
      colorRaw: teamColorHex(homeC.team),
    },
    spread: hasOdds ? spread : null,
    total: hasOdds ? total : null,
    hasOdds,
    book,
    moneyline:
      mlHome != null || mlAway != null
        ? { home: mlHome, away: mlAway }
        : null,
  };
}

export async function fetchEspnMlbScoreboard(datesYmd) {
  let lastErr = null;
  for (const base of ESPN_MLB_URLS) {
    const url = new URL(base);
    url.searchParams.set("dates", String(datesYmd));
    try {
      const res = await fetch(url.toString());
      if (!res.ok) {
        lastErr = new Error(`ESPN MLB HTTP ${res.status}`);
        continue;
      }
      const data = await res.json();
      const games = (data.events || [])
        .map(normalizeEspnMlbEvent)
        .filter(Boolean);
      return {
        games,
        fetchedAt: new Date().toISOString(),
        date: datesYmd,
      };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error("ESPN MLB scoreboard failed");
}

/**
 * Load MLB board: snapshot + live ESPN merge for date window + splits.
 */
export async function loadMlbBoard(opts = {}) {
  const daysAhead = opts.daysAhead ?? 3;

  let snapshot = null;
  let snapshotError = null;
  try {
    snapshot = await fetchMlbLinesSnapshot();
  } catch (err) {
    snapshotError = err.message || String(err);
  }

  const dates = mlbDateWindow(daysAhead);
  const liveGames = [];
  let liveAt = null;
  let liveError = null;
  for (const ymd of dates) {
    try {
      const day = await fetchEspnMlbScoreboard(ymd);
      liveGames.push(...day.games);
      liveAt = day.fetchedAt;
    } catch (err) {
      liveError = err.message || String(err);
    }
  }

  if (!snapshot && !liveGames.length) {
    throw new Error(
      `No MLB lines available (snapshot: ${snapshotError}; ESPN: ${liveError})`
    );
  }

  const byId = new Map();
  const byKeyDate = new Map();

  function put(g) {
    byId.set(g.id, g);
    if (g.date) byKeyDate.set(`${g.date}|${g.key}`, g);
  }

  if (snapshot?.games) {
    for (const raw of snapshot.games) {
      const g = {
        id: String(raw.id || raw.gamePk),
        gamePk: raw.gamePk,
        key: raw.key || gameKey(raw.away?.abbr, raw.home?.abbr),
        date: raw.date || null,
        away: tintTeam({ ...raw.away }),
        home: tintTeam({ ...raw.home }),
        kickoffIso: raw.kickoffIso,
        kickoffMs: raw.kickoffIso ? Date.parse(raw.kickoffIso) : 0,
        completed: Boolean(raw.completed),
        status: raw.completed ? "STATUS_FINAL" : "STATUS_SCHEDULED",
        statusState: raw.statusState || (raw.completed ? "post" : "pre"),
        statusDetail: raw.statusDetail || "",
        books: [...(raw.books || [])],
        moneyline: raw.moneyline || null,
        awayPitcher: raw.awayPitcher || null,
        homePitcher: raw.homePitcher || null,
        label: `${raw.away?.name || raw.away?.abbr} @ ${raw.home?.name || raw.home?.abbr}`,
        sport: "mlb",
      };
      put(g);
    }
  }

  // Merge live ESPN: match by id/gamePk first, then same matchup near same first pitch.
  // Do NOT fall back to "any same key" — that collapses doubleheaders (e.g. TB@NYY twice).
  for (const eg of liveGames) {
    let g =
      byId.get(String(eg.id)) ||
      [...byId.values()].find(
        (x) =>
          x.key === eg.key &&
          !x.completed &&
          Math.abs((x.kickoffMs || 0) - (eg.kickoffMs || 0)) < 3 * 3600 * 1000
      );

    if (!g) {
      g = {
        id: eg.id,
        key: eg.key,
        date: null,
        away: tintTeam(eg.away),
        home: tintTeam(eg.home),
        kickoffIso: eg.kickoffIso,
        kickoffMs: eg.kickoffMs,
        completed: eg.completed,
        status: eg.status,
        statusState: eg.statusState,
        statusDetail: eg.statusDetail,
        books: [],
        moneyline: eg.moneyline,
        awayPitcher: null,
        homePitcher: null,
        label: `${eg.away.name} @ ${eg.home.name}`,
        sport: "mlb",
      };
      put(g);
    } else {
      g.kickoffIso = eg.kickoffIso || g.kickoffIso;
      g.kickoffMs = eg.kickoffMs || g.kickoffMs;
      g.completed = eg.completed;
      g.status = eg.status;
      g.statusState = eg.statusState;
      g.statusDetail = eg.statusDetail;
      g.away = tintTeam({ ...g.away, ...eg.away });
      g.home = tintTeam({ ...g.home, ...eg.home });
      if (eg.moneyline) g.moneyline = eg.moneyline;
    }

    if (eg.hasOdds && eg.spread != null && eg.total != null) {
      g.books = (g.books || []).filter(
        (b) => b.name !== "DraftKings" && b.name !== "ESPN"
      );
      g.books.unshift({
        name: eg.book || "DraftKings",
        spread: eg.spread,
        total: eg.total,
        moneylineHome: eg.moneyline?.home ?? null,
        moneylineAway: eg.moneyline?.away ?? null,
        fetchedAt: liveAt,
        source: "espn-live",
      });
    }
  }

  const games = [...byId.values()]
    .map(withConsensus)
    .sort((a, b) => (a.kickoffMs || 0) - (b.kickoffMs || 0));

  let splitsSnap = null;
  let splitsErr = null;
  try {
    splitsSnap = await fetchMlbSplitsSnapshot();
  } catch (err) {
    splitsErr = err.message || String(err);
  }
  const splitsMeta = mergeSplitsOntoGames(games, splitsSnap);
  if (!splitsSnap) {
    splitsMeta.ok = false;
    splitsMeta.note = splitsErr || "mlb-splits.json missing";
  }

  return {
    sport: "mlb",
    games,
    fetchedAt: liveAt || snapshot?.fetchedAt || new Date().toISOString(),
    snapshotAt: snapshot?.fetchedAt || null,
    liveEspnAt: liveAt,
    dateStart: snapshot?.dateStart || null,
    dateEnd: snapshot?.dateEnd || null,
    sources: snapshot?.sources || null,
    splitsMeta,
    counts: {
      games: games.length,
      withOdds: games.filter((g) => g.hasOdds).length,
      upcoming: games.filter((g) => !g.completed && g.statusState !== "post")
        .length,
    },
    disclaimer:
      snapshot?.disclaimer ||
      "MLB research tool — not betting advice. No invented lines.",
  };
}

export { formatKickoff, statusLabel, formatLinesTimestamp, formatSplitsTimestamp };
