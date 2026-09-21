/**
 * Fetch + normalize NFL scoreboard / DraftKings odds from ESPN's public API.
 * CORS-enabled: safe to call from the browser on GitHub Pages.
 */

import { ESPN_DEFAULTS } from "./data.js";

const SCOREBOARD_URLS = [
  "https://site.web.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard",
  "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard",
];

/**
 * @param {{ seasontype?: number, week?: number, dates?: number }} opts
 * @returns {Promise<{ week: number, seasonYear: number, games: object[], fetchedAt: string }>}
 */
export async function fetchEspnScoreboard(opts = {}) {
  const seasontype = opts.seasontype ?? ESPN_DEFAULTS.seasontype;
  const week = opts.week ?? ESPN_DEFAULTS.week;
  const dates = opts.dates ?? ESPN_DEFAULTS.dates;

  let data = null;
  let lastErr = null;
  for (const base of SCOREBOARD_URLS) {
    const url = new URL(base);
    url.searchParams.set("seasontype", String(seasontype));
    url.searchParams.set("week", String(week));
    url.searchParams.set("dates", String(dates));
    try {
      const res = await fetch(url.toString());
      if (!res.ok) {
        lastErr = new Error(`ESPN scoreboard HTTP ${res.status}`);
        continue;
      }
      data = await res.json();
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (!data) {
    throw lastErr || new Error("ESPN scoreboard failed");
  }
  const weekNumber = data?.week?.number ?? week;
  const seasonYear = data?.season?.year ?? dates;
  const games = (data.events || []).map(normalizeEvent).filter(Boolean);

  // Prefer chronological order (kickoff), finals first among same day is fine via date
  games.sort((a, b) => a.kickoffMs - b.kickoffMs);

  return {
    week: weekNumber,
    seasonYear,
    games,
    fetchedAt: new Date().toISOString(),
    rawWeek: data.week,
  };
}


/** ESPN CDN team logo (scoreboard size). */

/** Primary jersey color from ESPN (#rrggbb). */
export function teamColorHex(team) {
  const c = team?.color || team?.alternateColor;
  if (!c) return null;
  const hex = String(c).replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return null;
  return `#${hex}`;
}

/** Lighten dark jersey colors so labels stay readable on dark UI. */
export function readableTeamColor(hex) {
  if (!hex) return null;
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  if (lum >= 0.45) return `#${h}`;
  // mix toward white
  const mix = 0.45;
  const R = Math.round(r + (255 - r) * mix);
  const G = Math.round(g + (255 - g) * mix);
  const B = Math.round(b + (255 - b) * mix);
  return `#${[R, G, B].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}

export function teamLogoUrl(team, abbr) {
  const fromApi = team?.logo || team?.logos?.[0]?.href;
  if (fromApi) return fromApi;
  const a = String(abbr || "").toLowerCase();
  if (!a || a === "?") return "";
  return `https://a.espncdn.com/i/teamlogos/nfl/500/scoreboard/${a}.png`;
}

function normalizeEvent(event) {
  const comp = event?.competitions?.[0];
  if (!comp) return null;

  const competitors = comp.competitors || [];
  const homeC = competitors.find((c) => c.homeAway === "home");
  const awayC = competitors.find((c) => c.homeAway === "away");
  if (!homeC || !awayC) return null;

  const statusType = event?.status?.type || {};
  const statusName = statusType.name || "STATUS_SCHEDULED";
  const statusState = statusType.state || "pre"; // pre | in | post
  const completed = Boolean(statusType.completed) || statusName === "STATUS_FINAL";

  const odds0 = Array.isArray(comp.odds) && comp.odds.length ? comp.odds[0] : null;
  let spread = null;
  let total = null;
  let book = null;
  let details = null;
  let hasOdds = false;

  if (odds0 && odds0.spread != null && odds0.overUnder != null) {
    spread = Number(odds0.spread);
    total = Number(odds0.overUnder);
    if (Number.isFinite(spread) && Number.isFinite(total)) {
      hasOdds = true;
      book = odds0.provider?.name || odds0.provider?.displayName || "ESPN";
      details = odds0.details || null;
    } else {
      spread = null;
      total = null;
    }
  }

  const homeAbbr = homeC.team?.abbreviation || "?";
  const awayAbbr = awayC.team?.abbreviation || "?";
  const homeScore =
    homeC.score != null && homeC.score !== "" ? Number(homeC.score) : null;
  const awayScore =
    awayC.score != null && awayC.score !== "" ? Number(awayC.score) : null;

  const dateIso = event.date || comp.date || null;
  const kickoffMs = dateIso ? Date.parse(dateIso) : 0;

  return {
    id: String(event.id || `${awayAbbr}-${homeAbbr}`.toLowerCase()),
    label: `${awayC.team?.displayName || awayAbbr} @ ${homeC.team?.displayName || homeAbbr}`,
    weekLabel: statusType.shortDetail || statusType.detail || "",
    kickoffIso: dateIso,
    kickoffMs,
    status: statusName,
    statusState,
    statusDetail: statusType.detail || statusType.description || "",
    completed,
    away: {
      abbr: awayAbbr,
      name: awayC.team?.displayName || awayAbbr,
      score: Number.isFinite(awayScore) ? awayScore : null,
      logo: teamLogoUrl(awayC.team, awayAbbr),
      color: readableTeamColor(teamColorHex(awayC.team)),
      colorRaw: teamColorHex(awayC.team),
    },
    home: {
      abbr: homeAbbr,
      name: homeC.team?.displayName || homeAbbr,
      score: Number.isFinite(homeScore) ? homeScore : null,
      logo: teamLogoUrl(homeC.team, homeAbbr),
      color: readableTeamColor(teamColorHex(homeC.team)),
      colorRaw: teamColorHex(homeC.team),
    },
    /** Home-team point spread (negative = home favored). Null if no line. */
    spread: hasOdds ? spread : null,
    total: hasOdds ? total : null,
    hasOdds,
    book,
    details,
  };
}

/** Format kickoff for America/Chicago display. */
export function formatKickoff(iso) {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago",
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export function statusLabel(game) {
  if (game.completed || game.status === "STATUS_FINAL") return "FINAL";
  if (game.statusState === "in" || game.status === "STATUS_IN_PROGRESS") {
    return game.statusDetail || "In progress";
  }
  return "Scheduled";
}
