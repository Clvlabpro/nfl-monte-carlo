#!/usr/bin/env python3
"""
Fetch NFL Week 3 (2026) spread + total lines from free public book endpoints.
Also merges any remaining (not final) Week 2 games with live odds — e.g. MNF
NYG@LAR — as featuredRemaining onto the Week 3 board.
Writes ../lines.json for the static site (GitHub Pages cannot CORS most books).

Books attempted:
  - ESPN scoreboard (DraftKings provider) — always
  - FanDuel NJ sbapi content-managed-page
  - BetMGM IL cds-api fixtures
  - Bovada coupon events

Skipped / blocked when last run from this box:
  - DraftKings sportsbook API (HTTP 403)
  - Caesars / americanwagering (HTTP 403)
  - ESPN BET hostname unresolved

Consensus = median of available books per game (spread and total separately).
Home-team spread convention: negative = home favored.
"""

from __future__ import annotations

import json
import re
import statistics
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)

# Canonical abbreviation from ESPN; aliases for book name matching.
TEAM_ALIASES: dict[str, str] = {
    "arizona cardinals": "ARI",
    "cardinals": "ARI",
    "atlanta falcons": "ATL",
    "falcons": "ATL",
    "baltimore ravens": "BAL",
    "ravens": "BAL",
    "buffalo bills": "BUF",
    "bills": "BUF",
    "carolina panthers": "CAR",
    "panthers": "CAR",
    "chicago bears": "CHI",
    "bears": "CHI",
    "cincinnati bengals": "CIN",
    "bengals": "CIN",
    "cleveland browns": "CLE",
    "browns": "CLE",
    "dallas cowboys": "DAL",
    "cowboys": "DAL",
    "denver broncos": "DEN",
    "broncos": "DEN",
    "detroit lions": "DET",
    "lions": "DET",
    "green bay packers": "GB",
    "packers": "GB",
    "houston texans": "HOU",
    "texans": "HOU",
    "indianapolis colts": "IND",
    "colts": "IND",
    "jacksonville jaguars": "JAX",
    "jaguars": "JAX",
    "kansas city chiefs": "KC",
    "chiefs": "KC",
    "las vegas raiders": "LV",
    "raiders": "LV",
    "los angeles chargers": "LAC",
    "chargers": "LAC",
    "los angeles rams": "LAR",
    "rams": "LAR",
    "miami dolphins": "MIA",
    "dolphins": "MIA",
    "minnesota vikings": "MIN",
    "vikings": "MIN",
    "new england patriots": "NE",
    "patriots": "NE",
    "new orleans saints": "NO",
    "saints": "NO",
    "new york giants": "NYG",
    "giants": "NYG",
    "new york jets": "NYJ",
    "jets": "NYJ",
    "philadelphia eagles": "PHI",
    "eagles": "PHI",
    "pittsburgh steelers": "PIT",
    "steelers": "PIT",
    "san francisco 49ers": "SF",
    "49ers": "SF",
    "seattle seahawks": "SEA",
    "seahawks": "SEA",
    "tampa bay buccaneers": "TB",
    "buccaneers": "TB",
    "tennessee titans": "TEN",
    "titans": "TEN",
    "washington commanders": "WSH",
    "commanders": "WSH",
}

WEEK = 3
SEASON = 2026
OUT = Path(__file__).resolve().parent.parent / "lines.json"


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def fetch_json(url: str, headers: dict[str, str] | None = None, timeout: int = 45) -> Any:
    hdrs = {"User-Agent": UA, "Accept": "application/json, text/plain, */*"}
    if headers:
        hdrs.update(headers)
    req = urllib.request.Request(url, headers=hdrs)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
        return json.loads(raw.decode("utf-8"))


def abbr_from_name(name: str | None) -> str | None:
    if not name:
        return None
    key = name.strip().lower()
    if key in TEAM_ALIASES:
        return TEAM_ALIASES[key]
    # try last word (e.g. "Falcons")
    parts = key.split()
    if parts and parts[-1] in TEAM_ALIASES:
        return TEAM_ALIASES[parts[-1]]
    return None


def game_key(away: str, home: str) -> str:
    return f"{away}@{home}"


def median(vals: list[float]) -> float | None:
    vals = [v for v in vals if v is not None and isinstance(v, (int, float))]
    if not vals:
        return None
    return float(statistics.median(vals))


# ── ESPN (DraftKings) ────────────────────────────────────────────────────────

def fetch_espn(week: int = WEEK, *, remaining_only: bool = False) -> tuple[list[dict], dict]:
    """Fetch ESPN scoreboard for a week. If remaining_only, keep non-final games."""
    url = (
        "https://site.web.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard"
        f"?seasontype=2&week={week}&dates={SEASON}"
    )
    data = fetch_json(url)
    fetched_at = now_iso()
    games = []
    for event in data.get("events") or []:
        comp = (event.get("competitions") or [None])[0]
        if not comp:
            continue
        competitors = comp.get("competitors") or []
        home_c = next((c for c in competitors if c.get("homeAway") == "home"), None)
        away_c = next((c for c in competitors if c.get("homeAway") == "away"), None)
        if not home_c or not away_c:
            continue
        home_abbr = home_c.get("team", {}).get("abbreviation")
        away_abbr = away_c.get("team", {}).get("abbreviation")
        home_name = home_c.get("team", {}).get("displayName") or home_abbr
        away_name = away_c.get("team", {}).get("displayName") or away_abbr
        odds0 = (comp.get("odds") or [None])[0]
        spread = total = None
        book_name = "DraftKings"
        if odds0 and odds0.get("spread") is not None and odds0.get("overUnder") is not None:
            spread = float(odds0["spread"])
            total = float(odds0["overUnder"])
            book_name = (
                (odds0.get("provider") or {}).get("name")
                or (odds0.get("provider") or {}).get("displayName")
                or "DraftKings"
            )
        status = (event.get("status") or {}).get("type") or {}
        completed = bool(status.get("completed")) or status.get("name") == "STATUS_FINAL"
        if remaining_only and completed:
            continue
        games.append(
            {
                "id": str(event.get("id") or f"{away_abbr}-{home_abbr}".lower()),
                "key": game_key(away_abbr, home_abbr),
                "away": {"abbr": away_abbr, "name": away_name},
                "home": {"abbr": home_abbr, "name": home_name},
                "kickoffIso": event.get("date") or comp.get("date"),
                "completed": completed,
                "sourceWeek": week,
                "featuredRemaining": bool(remaining_only),
                "books": (
                    [
                        {
                            "name": book_name,
                            "spread": spread,
                            "total": total,
                            "fetchedAt": fetched_at,
                            "source": "espn",
                        }
                    ]
                    if spread is not None and total is not None
                    else []
                ),
            }
        )
    meta = {
        "week": (data.get("week") or {}).get("number", week),
        "seasonYear": (data.get("season") or {}).get("year", SEASON),
        "ok": True,
        "count": sum(1 for g in games if g["books"]),
        "remainingOnly": remaining_only,
    }
    return games, meta


# ── FanDuel ──────────────────────────────────────────────────────────────────

def fetch_fanduel() -> tuple[dict[str, dict], dict]:
    """Return map game_key -> {spread, total, fetchedAt}."""
    url = (
        "https://sbapi.nj.sportsbook.fanduel.com/api/content-managed-page"
        "?page=CUSTOM&customPageId=nfl&_ak=FhMFpcPWXMeyZxOx"
        "&timezone=America%2FNew_York"
    )
    data = fetch_json(url)
    fetched_at = now_iso()
    atts = data.get("attachments") or {}
    events = atts.get("events") or {}
    markets = atts.get("markets") or {}

    by_event: dict[Any, list] = {}
    for m in markets.values():
        by_event.setdefault(m.get("eventId"), []).append(m)

    out: dict[str, dict] = {}
    for eid, ms in by_event.items():
        ev = events.get(str(eid)) or events.get(eid)
        if not ev:
            continue
        name = ev.get("name") or ""
        if " @ " not in name:
            continue
        away_name, home_name = name.split(" @ ", 1)
        away = abbr_from_name(away_name)
        home = abbr_from_name(home_name)
        if not away or not home:
            continue
        # Include remaining Week 2 MNF (~2026-09-21/22) through Week 3 (~2026-09-30)
        open_date = (ev.get("openDate") or "")[:10]
        if open_date and (open_date < "2026-09-21" or open_date > "2026-09-30"):
            continue

        spread = total = None
        for m in ms:
            mtype = m.get("marketType")
            runners = m.get("runners") or []
            if mtype == "MATCH_HANDICAP_(2-WAY)":
                for r in runners:
                    rname = r.get("runnerName") or ""
                    hd = r.get("handicap")
                    if hd is None:
                        continue
                    if abbr_from_name(rname) == home or home_name.lower() in rname.lower():
                        spread = float(hd)
                        break
                if spread is None and len(runners) >= 2:
                    # second runner often home in FD? Prefer explicit match
                    for r in runners:
                        if abbr_from_name(r.get("runnerName")) == home:
                            spread = float(r["handicap"])
                            break
            elif mtype == "TOTAL_POINTS_(OVER/UNDER)":
                for r in runners:
                    if (r.get("runnerName") or "").lower().startswith("over"):
                        if r.get("handicap") is not None:
                            total = float(r["handicap"])
                            break
        if spread is not None and total is not None:
            out[game_key(away, home)] = {
                "name": "FanDuel",
                "spread": spread,
                "total": total,
                "fetchedAt": fetched_at,
                "source": "fanduel",
            }
    return out, {"ok": True, "count": len(out)}


# ── BetMGM ───────────────────────────────────────────────────────────────────

def fetch_betmgm() -> tuple[dict[str, dict], dict]:
    access = "ZTg4YWEwMTgtZTlhYy00MWRkLWIzYWYtZjMzODI5ZDE0Mjc5"
    url = (
        "https://www.il.betmgm.com/cds-api/bettingoffer/fixtures"
        f"?x-bwin-accessid={access}"
        "&lang=en-us&country=US&userCountry=US&subdivision=US-Illinois"
        "&fixtureTypes=Standard&state=Latest&offerMapping=Filtered"
        "&offerCategories=Gridable&fixtureCategories=Gridable"
        "&competitionIds=35&isPriceBoost=false"
    )
    data = fetch_json(url)
    fetched_at = now_iso()
    out: dict[str, dict] = {}

    for fx in data.get("fixtures") or []:
        home = away = None
        for p in fx.get("participants") or []:
            props = p.get("properties") or {}
            n = p.get("name", {}).get("value") if isinstance(p.get("name"), dict) else p.get("name")
            if props.get("type") == "HomeTeam":
                home = n
            elif props.get("type") == "AwayTeam":
                away = n
        if not home or not away:
            fname = (fx.get("name") or {}).get("value") or ""
            if " @ " in fname:
                away, home = fname.split(" @ ", 1)
            else:
                continue
        away_a = abbr_from_name(away)
        home_a = abbr_from_name(home)
        if not away_a or not home_a:
            continue

        spread_cands = []
        total_cands = []
        for om in fx.get("optionMarkets") or []:
            oname = (om.get("name") or {}).get("value")
            opts = om.get("options") or []
            if oname == "Spread" and len(opts) >= 2:
                aos = [(o.get("price") or {}).get("americanOdds") for o in opts[:2]]
                if any(a is None for a in aos):
                    continue
                juice = sum(abs(a + 110) for a in aos)
                hs = None
                for o in opts:
                    on = o.get("name", {}).get("value") or ""
                    m = re.search(r"([+-]?\d+(?:\.\d+)?)\s*$", on)
                    team = re.sub(r"\s*[+-]?\d+(?:\.\d+)?\s*$", "", on).strip()
                    if home.lower() == team.lower() or home.split()[-1].lower() in team.lower():
                        hs = float(m.group(1)) if m else None
                if hs is not None:
                    spread_cands.append((juice, abs(aos[0] - aos[1]), hs))
            if oname == "Totals" and len(opts) >= 2:
                aos = [(o.get("price") or {}).get("americanOdds") for o in opts[:2]]
                if any(a is None for a in aos):
                    continue
                juice = sum(abs(a + 110) for a in aos)
                tot = None
                for o in opts:
                    on = o.get("name", {}).get("value") or ""
                    if "Over" in on:
                        m = re.search(r"(\d+(?:\.\d+)?)\s*$", on)
                        tot = float(m.group(1)) if m else None
                if tot is not None:
                    total_cands.append((juice, abs(aos[0] - aos[1]), tot))

        spread_cands.sort()
        total_cands.sort()
        if not spread_cands or not total_cands:
            continue
        out[game_key(away_a, home_a)] = {
            "name": "BetMGM",
            "spread": spread_cands[0][2],
            "total": total_cands[0][2],
            "fetchedAt": fetched_at,
            "source": "betmgm",
        }
    return out, {"ok": True, "count": len(out)}


# ── Bovada ───────────────────────────────────────────────────────────────────

def fetch_bovada() -> tuple[dict[str, dict], dict]:
    url = (
        "https://www.bovada.lv/services/sports/event/coupon/events/A/description/"
        "football/nfl?marketFilterId=def&preMatchOnly=true&lang=en"
    )
    data = fetch_json(url)
    fetched_at = now_iso()
    out: dict[str, dict] = {}

    events = []
    if isinstance(data, list):
        for block in data:
            events.extend(block.get("events") or [])
    elif isinstance(data, dict):
        events = data.get("events") or []

    for ev in events:
        comps = ev.get("competitors") or []
        if len(comps) < 2:
            continue
        # Prefer explicit home flag (awayTeamFirst only affects display order).
        flagged_home = next((c for c in comps if c.get("home") is True), None)
        flagged_away = next((c for c in comps if c.get("home") is False), None)
        if flagged_home and flagged_away:
            home_c, away_c = flagged_home, flagged_away
        elif bool(ev.get("awayTeamFirst")):
            # Display order away, home
            away_c, home_c = comps[0], comps[1]
        else:
            home_c, away_c = comps[0], comps[1]

        home_name = home_c.get("name")
        away_name = away_c.get("name")
        home_a = abbr_from_name(home_name)
        away_a = abbr_from_name(away_name)
        if not home_a or not away_a:
            continue

        spread = total = None
        for dg in ev.get("displayGroups") or []:
            if (dg.get("description") or "") != "Game Lines":
                continue
            for mkt in dg.get("markets") or []:
                desc = mkt.get("description") or ""
                outcomes = mkt.get("outcomes") or []
                if desc == "Point Spread":
                    for o in outcomes:
                        oname = o.get("description") or ""
                        hd = (o.get("price") or {}).get("handicap")
                        if hd is None:
                            continue
                        try:
                            hd_f = float(str(hd).replace("+", ""))
                        except ValueError:
                            continue
                        if abbr_from_name(oname) == home_a or (home_name and home_name in oname):
                            spread = hd_f
                            break
                elif desc == "Total":
                    for o in outcomes:
                        if (o.get("description") or "").lower().startswith("over"):
                            hd = (o.get("price") or {}).get("handicap")
                            if hd is not None:
                                total = float(str(hd).replace("+", ""))
                                break
        if spread is not None and total is not None:
            out[game_key(away_a, home_a)] = {
                "name": "Bovada",
                "spread": spread,
                "total": total,
                "fetchedAt": fetched_at,
                "source": "bovada",
            }
    return out, {"ok": True, "count": len(out)}


def try_book(name: str, fn):
    try:
        result, meta = fn()
        print(f"[ok] {name}: {meta.get('count', '?')} games", file=sys.stderr)
        return result, {**meta, "error": None}
    except Exception as e:
        print(f"[skip] {name}: {e}", file=sys.stderr)
        return None, {"ok": False, "count": 0, "error": str(e)}


def main() -> int:
    sources: dict[str, Any] = {}
    blocked = {
        "DraftKings (direct API)": "HTTP 403 from sportsbook.draftkings.com",
        "Caesars": "HTTP 403 from api.americanwagering.com",
        "ESPN BET": "hostname unresolved / not probed successfully",
    }

    espn_games, espn_meta = try_book("ESPN/DraftKings", fetch_espn)
    if not espn_games:
        print("FATAL: ESPN scoreboard required as skeleton", file=sys.stderr)
        return 1
    sources["espn_draftkings"] = espn_meta

    # Featured remaining from prior week (e.g. Week 2 MNF NYG@LAR) on the Week 3 board
    prior_week = WEEK - 1
    featured: list[dict] = []
    if prior_week >= 1:
        prior_games, prior_meta = try_book(
            f"ESPN/DraftKings Week {prior_week} remaining",
            lambda: fetch_espn(prior_week, remaining_only=True),
        )
        sources[f"espn_draftkings_week{prior_week}_remaining"] = prior_meta
        if prior_games:
            week3_keys = {g["key"] for g in espn_games}
            for g in prior_games:
                if g["key"] in week3_keys:
                    continue
                # Prefer games that still have a market; skip odds-less leftovers
                if not g.get("books"):
                    print(f"  skip remaining {g['key']}: no odds yet", file=sys.stderr)
                    continue
                featured.append(g)
            print(
                f"[ok] featured remaining Week {prior_week}: "
                f"{len(featured)} games → {[g['key'] for g in featured]}",
                file=sys.stderr,
            )

    espn_games = featured + espn_games

    fd_map, fd_meta = try_book("FanDuel", fetch_fanduel)
    sources["fanduel"] = fd_meta

    mgm_map, mgm_meta = try_book("BetMGM", fetch_betmgm)
    sources["betmgm"] = mgm_meta

    bov_map, bov_meta = try_book("Bovada", fetch_bovada)
    sources["bovada"] = bov_meta

    fetched_at = now_iso()
    games_out = []
    for g in espn_games:
        books = list(g.get("books") or [])
        key = g["key"]
        for book_map in (fd_map, mgm_map, bov_map):
            if not book_map:
                continue
            if key in book_map:
                books.append(dict(book_map[key]))

        # Dedupe by book name (prefer first)
        seen = set()
        deduped = []
        for b in books:
            n = b.get("name")
            if n in seen:
                continue
            seen.add(n)
            deduped.append(b)
        books = deduped

        spreads = [b["spread"] for b in books if b.get("spread") is not None]
        totals = [b["total"] for b in books if b.get("total") is not None]
        cons_spread = median(spreads)
        cons_total = median(totals)
        has_odds = cons_spread is not None and cons_total is not None

        games_out.append(
            {
                "id": g["id"],
                "key": key,
                "away": g["away"],
                "home": g["home"],
                "kickoffIso": g.get("kickoffIso"),
                "completed": g.get("completed", False),
                "sourceWeek": g.get("sourceWeek", WEEK),
                "featuredRemaining": bool(g.get("featuredRemaining")),
                "books": books,
                "consensus": (
                    {"spread": cons_spread, "total": cons_total, "method": "median"}
                    if has_odds
                    else None
                ),
                "spread": cons_spread,
                "total": cons_total,
                "hasOdds": has_odds,
            }
        )

    payload = {
        "week": WEEK,
        "seasonYear": SEASON,
        "fetchedAt": fetched_at,
        "consensusMethod": "median",
        "sources": sources,
        "blocked": blocked,
        "disclaimer": (
            "Multi-book lines scraped from public book endpoints for education only. "
            "Not betting advice. Lines move; consensus is the median of available books."
        ),
        "games": games_out,
    }

    OUT.write_text(json.dumps(payload, indent=2) + "\n")
    print(f"Wrote {OUT} ({len(games_out)} games)", file=sys.stderr)

    # Summary
    for g in games_out[:5]:
        c = g.get("consensus") or {}
        names = ", ".join(b["name"] for b in g["books"])
        print(
            f"  {g['away']['abbr']}@{g['home']['abbr']}: "
            f"cons {c.get('spread')}/{c.get('total')} [{names}]",
            file=sys.stderr,
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
