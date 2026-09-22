#!/usr/bin/env python3
"""
Fetch MLB schedule + context from MLB Stats API and odds from ESPN (DraftKings).
Writes ../mlb-lines.json for the static site.

Order: schedule (fast) → ESPN odds → pitcher/team enrichment (so odds aren't
lost to rate-limits during the slow stats loop).

Does not invent odds. Multi-book MLB scrapers not adapted (ESPN DK only).
"""

from __future__ import annotations

import json
import sys
import time
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)
DAYS_AHEAD = 7
SEASON = 2026
OUT = Path(__file__).resolve().parent.parent / "mlb-lines.json"
ESPN_HEADERS = {
    "User-Agent": UA,
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.espn.com/",
    "Origin": "https://www.espn.com",
}


def now_iso() -> str:
    return (
        datetime.now(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


def fetch_json(url: str, headers: dict[str, str] | None = None, timeout: int = 45) -> Any:
    hdrs = {"User-Agent": UA, "Accept": "application/json, text/plain, */*"}
    if headers:
        hdrs.update(headers)
    req = urllib.request.Request(url, headers=hdrs)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def fetch_json_retry(url: str, headers: dict[str, str] | None = None, tries: int = 4) -> Any:
    last: Exception | None = None
    for i in range(tries):
        try:
            return fetch_json(url, headers=headers)
        except Exception as e:
            last = e
            time.sleep(1.2 * (i + 1))
    raise last  # type: ignore[misc]


def game_key(away: str, home: str) -> str:
    return f"{away}@{home}"


def parse_american(odds: str | None) -> int | None:
    if odds is None:
        return None
    s = str(odds).strip().replace("−", "-")
    if not s:
        return None
    if s.lower() == "even":
        return 100
    try:
        return int(float(s))
    except (TypeError, ValueError):
        return None


def mlb_logo(team_id: int | None, abbr: str | None = None) -> str:
    if team_id:
        return f"https://www.mlbstatic.com/team-logos/{team_id}.svg"
    if abbr:
        return f"https://a.espncdn.com/i/teamlogos/mlb/500/scoreboard/{abbr.lower()}.png"
    return ""


def _f(v: Any) -> float | None:
    if v is None or v == "":
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _i(v: Any) -> int | None:
    if v is None or v == "":
        return None
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def _norm_abbr(a: str) -> str:
    m = {
        "AZ": "ARI", "CWS": "CHW", "WAS": "WSH", "SFG": "SF",
        "SDP": "SD", "TBR": "TB", "KCR": "KC",
    }
    return m.get(a.upper(), a.upper())


_pitcher_cache: dict[int, dict | None] = {}
_team_cache: dict[int, dict | None] = {}


def _ops_from_stat(s: dict) -> float | None:
    ops = _f(s.get("ops"))
    if ops is not None:
        return ops
    obp = _f(s.get("obp"))
    slg = _f(s.get("slg"))
    if obp is not None and slg is not None:
        return round(obp + slg, 3)
    return None


def fetch_pitcher_hand(person_id: int) -> str | None:
    try:
        data = fetch_json(f"https://statsapi.mlb.com/api/v1/people/{person_id}")
        people = data.get("people") or []
        if not people:
            return None
        code = ((people[0].get("pitchHand") or {}).get("code") or "").upper()
        return code if code in ("L", "R") else None
    except Exception:
        return None


def fetch_pitcher_platoon_splits(person_id: int) -> dict:
    """OPS/BA/OBP/SLG/WHIP vs LHB (vl) and vs RHB (vr) from statsapi sitCodes."""
    out: dict[str, Any] = {"vsLhb": None, "vsRhb": None}
    url = (
        f"https://statsapi.mlb.com/api/v1/people/{person_id}/stats"
        f"?stats=statSplits&group=pitching&season={SEASON}&sitCodes=vl,vr"
    )
    try:
        data = fetch_json(url)
        for block in data.get("stats") or []:
            for sp in block.get("splits") or []:
                split = sp.get("split") or {}
                code = (split.get("code") or "").lower()
                st = sp.get("stat") or {}
                blob = {
                    "ops": _ops_from_stat(st),
                    "avg": _f(st.get("avg")),
                    "obp": _f(st.get("obp")),
                    "slg": _f(st.get("slg")),
                    "whip": _f(st.get("whip")),
                    "atBats": _i(st.get("atBats")),
                    "battersFaced": _i(st.get("battersFaced")),
                    "inningsPitched": st.get("inningsPitched"),
                    "strikeOuts": _i(st.get("strikeOuts")),
                    "homeRuns": _i(st.get("homeRuns")),
                }
                if code == "vl":
                    out["vsLhb"] = blob
                elif code == "vr":
                    out["vsRhb"] = blob
    except Exception as e:
        print(f"  pitcher {person_id} platoon splits fail: {e}", file=sys.stderr)
    return out


def fetch_pitcher_stats(person_id: int) -> dict | None:
    if person_id in _pitcher_cache:
        return _pitcher_cache[person_id]
    url = (
        f"https://statsapi.mlb.com/api/v1/people/{person_id}/stats"
        f"?stats=season&group=pitching&season={SEASON}"
    )
    try:
        data = fetch_json(url)
        splits = []
        for block in data.get("stats") or []:
            splits = block.get("splits") or []
            if splits:
                break
        if not splits:
            _pitcher_cache[person_id] = None
            return None
        s = splits[0].get("stat") or {}
        out = {
            "era": _f(s.get("era")),
            "whip": _f(s.get("whip")),
            "inningsPitched": s.get("inningsPitched"),
            "strikeOuts": _i(s.get("strikeOuts")),
            "strikeoutsPer9Inn": _f(s.get("strikeoutsPer9Inn")),
            "wins": _i(s.get("wins")),
            "losses": _i(s.get("losses")),
            "gamesStarted": _i(s.get("gamesStarted")),
            "opsAgainst": _ops_from_stat(s),
            "avgAgainst": _f(s.get("avg")),
        }
        # Platoon splits + throwing hand (not W-L primary)
        platoon = fetch_pitcher_platoon_splits(person_id)
        out["vsLhb"] = platoon.get("vsLhb")
        out["vsRhb"] = platoon.get("vsRhb")
        out["pitchHand"] = fetch_pitcher_hand(person_id)
        _pitcher_cache[person_id] = out
        return out
    except Exception as e:
        print(f"  pitcher {person_id} stats fail: {e}", file=sys.stderr)
        _pitcher_cache[person_id] = None
        return None


def _split_stat(payload: dict | None) -> dict:
    try:
        return ((payload.get("stats") or [{}])[0].get("splits") or [{}])[0].get("stat") or {}
    except Exception:
        return {}


def fetch_team_context(team_id: int) -> dict | None:
    """Season rpg/rapg + last-10 runs + W-L from MLB Stats API (no paid APIs)."""
    if team_id in _team_cache:
        return _team_cache[team_id]
    try:
        hit = fetch_json(
            f"https://statsapi.mlb.com/api/v1/teams/{team_id}/stats"
            f"?stats=season&group=hitting&season={SEASON}"
        )
        pitch = fetch_json(
            f"https://statsapi.mlb.com/api/v1/teams/{team_id}/stats"
            f"?stats=season&group=pitching&season={SEASON}"
        )
        hs = _split_stat(hit)
        ps = _split_stat(pitch)
        gp = _i(hs.get("gamesPlayed")) or _i(ps.get("gamesPlayed"))
        rs = _f(hs.get("runs"))
        ra = _f(ps.get("runs"))
        out: dict[str, Any] = {
            "gamesPlayed": gp,
            "runsScored": rs,
            "runsAllowed": ra,
            "rpg": round(rs / gp, 2) if gp and rs is not None else None,
            "rapg": round(ra / gp, 2) if gp and ra is not None else None,
            "wins": _i(hs.get("wins")) or _i(ps.get("wins")),
            "losses": _i(hs.get("losses")) or _i(ps.get("losses")),
            "last10Rpg": None,
            "last10Rapg": None,
            "last10Record": None,
        }
        # Last 10 games — widely available via statsapi (skip quietly if unavailable)
        try:
            l10h = fetch_json(
                f"https://statsapi.mlb.com/api/v1/teams/{team_id}/stats"
                f"?stats=lastTenGames&group=hitting&season={SEASON}"
            )
            l10p = fetch_json(
                f"https://statsapi.mlb.com/api/v1/teams/{team_id}/stats"
                f"?stats=lastTenGames&group=pitching&season={SEASON}"
            )
            lhs = _split_stat(l10h)
            lps = _split_stat(l10p)
            lgp = _i(lhs.get("gamesPlayed")) or _i(lps.get("gamesPlayed")) or 10
            lrs = _f(lhs.get("runs"))
            lra = _f(lps.get("runs"))
            if lgp and lrs is not None:
                out["last10Rpg"] = round(lrs / lgp, 2)
            if lgp and lra is not None:
                out["last10Rapg"] = round(lra / lgp, 2)
            lw = _i(lhs.get("wins")) or _i(lps.get("wins"))
            ll = _i(lhs.get("losses")) or _i(lps.get("losses"))
            if lw is not None and ll is not None:
                out["last10Record"] = f"{lw}-{ll}"
        except Exception as e:
            print(f"  team {team_id} last10 skip: {e}", file=sys.stderr)
        _team_cache[team_id] = out
        return out
    except Exception as e:
        print(f"  team {team_id} stats fail: {e}", file=sys.stderr)
        _team_cache[team_id] = None
        return None


def pitcher_blob(raw: dict | None, enrich: bool) -> dict | None:
    if not raw or not raw.get("id"):
        return None
    pid = int(raw["id"])
    stats = fetch_pitcher_stats(pid) if enrich else None
    return {
        "id": pid,
        "name": raw.get("fullName") or raw.get("lastFirstName") or f"#{pid}",
        "pitchHand": (stats or {}).get("pitchHand") if stats else None,
        "stats": stats,
    }


def fetch_schedule(start: date, days: int, *, enrich: bool = False) -> list[dict]:
    """Fetch schedule. If enrich=False, skip pitcher/team season stats (fast)."""
    games: list[dict] = []
    seen: set[int] = set()
    for i in range(days + 1):
        d = start + timedelta(days=i)
        url = (
            "https://statsapi.mlb.com/api/v1/schedule"
            f"?sportId=1&date={d.isoformat()}&hydrate=probablePitcher,team,linescore"
        )
        print(f"  schedule {d.isoformat()} …", file=sys.stderr)
        data = fetch_json(url)
        for day in data.get("dates") or []:
            for g in day.get("games") or []:
                pk = g.get("gamePk")
                if pk in seen:
                    continue
                seen.add(pk)
                away_t = (g.get("teams") or {}).get("away") or {}
                home_t = (g.get("teams") or {}).get("home") or {}
                away_team = away_t.get("team") or {}
                home_team = home_t.get("team") or {}
                away_abbr = _norm_abbr(
                    away_team.get("abbreviation")
                    or (away_team.get("teamCode") or "").upper()
                )
                home_abbr = _norm_abbr(
                    home_team.get("abbreviation")
                    or (home_team.get("teamCode") or "").upper()
                )
                if not away_abbr or not home_abbr:
                    continue
                status = g.get("status") or {}
                detailed = status.get("detailedState") or ""
                abstract = status.get("abstractGameState") or ""
                completed = abstract == "Final" or detailed in (
                    "Final",
                    "Game Over",
                    "Completed Early",
                )
                away_id = away_team.get("id")
                home_id = home_team.get("id")
                away_ctx = fetch_team_context(int(away_id)) if (enrich and away_id) else None
                home_ctx = fetch_team_context(int(home_id)) if (enrich and home_id) else None
                games.append(
                    {
                        "id": str(pk),
                        "gamePk": pk,
                        "key": game_key(away_abbr, home_abbr),
                        "date": d.isoformat(),
                        "kickoffIso": g.get("gameDate"),
                        "completed": completed,
                        "statusDetail": detailed,
                        "statusState": (
                            "post"
                            if completed
                            else ("in" if abstract == "Live" else "pre")
                        ),
                        "away": {
                            "abbr": away_abbr,
                            "name": away_team.get("name") or away_abbr,
                            "id": away_id,
                            "logo": mlb_logo(away_id, away_abbr),
                            "rpg": (away_ctx or {}).get("rpg"),
                            "rapg": (away_ctx or {}).get("rapg"),
                        },
                        "home": {
                            "abbr": home_abbr,
                            "name": home_team.get("name") or home_abbr,
                            "id": home_id,
                            "logo": mlb_logo(home_id, home_abbr),
                            "rpg": (home_ctx or {}).get("rpg"),
                            "rapg": (home_ctx or {}).get("rapg"),
                        },
                        "awayPitcher": pitcher_blob(away_t.get("probablePitcher"), enrich),
                        "homePitcher": pitcher_blob(home_t.get("probablePitcher"), enrich),
                        "books": [],
                        "moneyline": None,
                        "spread": None,
                        "total": None,
                    }
                )
    return games


def enrich_games(games: list[dict]) -> None:
    """Fill pitcher season stats + team RPG for non-final games (and finals with SPs)."""
    print("Enriching pitcher/team season stats…", file=sys.stderr)
    for g in games:
        for side, key in (("away", "awayPitcher"), ("home", "homePitcher")):
            pp = g.get(key)
            if pp and pp.get("id") and not pp.get("stats"):
                pp["stats"] = fetch_pitcher_stats(int(pp["id"]))
                time.sleep(0.04)
        for side in ("away", "home"):
            tid = g[side].get("id")
            if tid and (g[side].get("rpg") is None or g[side].get("last10Rpg") is None):
                ctx = fetch_team_context(int(tid))
                if ctx:
                    if g[side].get("rpg") is None:
                        g[side]["rpg"] = ctx.get("rpg")
                        g[side]["rapg"] = ctx.get("rapg")
                    g[side]["wins"] = ctx.get("wins")
                    g[side]["losses"] = ctx.get("losses")
                    g[side]["last10Rpg"] = ctx.get("last10Rpg")
                    g[side]["last10Rapg"] = ctx.get("last10Rapg")
                    g[side]["last10Record"] = ctx.get("last10Record")
                time.sleep(0.04)



_roster_bat_cache: dict[int, dict] = {}


def fetch_roster_bat_mix(team_id: int) -> dict:
    """Active roster non-pitcher batSide counts (L/R/S). Fallback when lineup TBD."""
    if team_id in _roster_bat_cache:
        return _roster_bat_cache[team_id]
    out = {
        "lhb": 0,
        "rhb": 0,
        "shb": 0,
        "source": "roster mix (lineup TBD)",
        "nHitters": 0,
    }
    try:
        roster = fetch_json(
            f"https://statsapi.mlb.com/api/v1/teams/{team_id}/roster"
            f"?rosterType=active&season={SEASON}"
        )
        ids: list[int] = []
        for e in roster.get("roster") or []:
            pos = ((e.get("position") or {}).get("abbreviation") or "").upper()
            if pos in ("P", "TWP"):
                continue
            pid = (e.get("person") or {}).get("id")
            if pid:
                ids.append(int(pid))
        # Batch people (max ~25 per call)
        for i in range(0, len(ids), 25):
            chunk = ids[i : i + 25]
            people = fetch_json(
                "https://statsapi.mlb.com/api/v1/people?personIds="
                + ",".join(str(x) for x in chunk)
            )
            for p in people.get("people") or []:
                code = ((p.get("batSide") or {}).get("code") or "").upper()
                if code == "L":
                    out["lhb"] += 1
                elif code == "R":
                    out["rhb"] += 1
                elif code == "S":
                    out["shb"] += 1
                else:
                    continue
                out["nHitters"] += 1
            time.sleep(0.05)
    except Exception as e:
        print(f"  roster bat mix team {team_id} fail: {e}", file=sys.stderr)
    _roster_bat_cache[team_id] = out
    return out


def fetch_game_lineup_bat_mix(game_pk: int) -> dict | None:
    """If batting order posted on live feed, count batSides; else None."""
    try:
        feed = fetch_json(f"https://statsapi.mlb.com/api/v1.1/game/{game_pk}/feed/live")
    except Exception:
        return None
    gd = feed.get("gameData") or {}
    players = gd.get("players") or {}
    ld = feed.get("liveData") or {}
    box = ld.get("boxscore") or {}
    teams = box.get("teams") or {}
    result: dict[str, Any] = {}
    for side in ("away", "home"):
        t = teams.get(side) or {}
        order = t.get("battingOrder") or []
        if not order:
            continue
        counts = {"lhb": 0, "rhb": 0, "shb": 0, "nHitters": 0, "source": "projected/posted lineup"}
        for pid in order:
            key = f"ID{pid}" if not str(pid).startswith("ID") else str(pid)
            # battingOrder entries can be int ids
            p = players.get(key) or players.get(f"ID{pid}") or players.get(str(pid))
            if not p:
                # try scan
                for pk, pv in players.items():
                    if pv.get("id") == int(pid):
                        p = pv
                        break
            if not p:
                continue
            code = ((p.get("batSide") or {}).get("code") or "").upper()
            if code == "L":
                counts["lhb"] += 1
            elif code == "R":
                counts["rhb"] += 1
            elif code == "S":
                counts["shb"] += 1
            else:
                continue
            counts["nHitters"] += 1
        if counts["nHitters"] > 0:
            result[side] = counts
    return result or None


def enrich_platoon(games: list[dict]) -> None:
    """Pitcher hand + vs LHB/RHB OPS splits + lineup/roster bat mix. Not W-L."""
    print("Enriching platoon (SP hand/splits + lineup/roster bats)…", file=sys.stderr)
    for g in games:
        if g.get("completed"):
            continue
        # Pitchers: ensure stats include platoon + hand
        for key in ("awayPitcher", "homePitcher"):
            pp = g.get(key)
            if not pp or not pp.get("id"):
                continue
            st = pp.get("stats") or {}
            need = st.get("vsLhb") is None or st.get("pitchHand") is None
            if need or not st:
                fresh = fetch_pitcher_stats(int(pp["id"]))
                if fresh:
                    pp["stats"] = fresh
                    pp["pitchHand"] = fresh.get("pitchHand")
                time.sleep(0.06)
            else:
                pp["pitchHand"] = st.get("pitchHand") or pp.get("pitchHand")

        lineup = None
        if g.get("gamePk"):
            try:
                lineup = fetch_game_lineup_bat_mix(int(g["gamePk"]))
                time.sleep(0.05)
            except Exception as e:
                print(f"  lineup {g.get('gamePk')} skip: {e}", file=sys.stderr)

        for side in ("away", "home"):
            if lineup and side in lineup:
                g[side]["batMix"] = lineup[side]
            else:
                tid = g[side].get("id")
                if tid:
                    g[side]["batMix"] = fetch_roster_bat_mix(int(tid))
                    time.sleep(0.04)


def fetch_espn_day(ymd: str) -> list[dict]:
    urls = [
        f"https://site.web.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates={ymd}",
        f"https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates={ymd}",
    ]
    data = None
    last_err = None
    for url in urls:
        try:
            data = fetch_json_retry(url, headers=ESPN_HEADERS, tries=3)
            break
        except Exception as e:
            last_err = e
    if data is None:
        print(f"  ESPN {ymd} FAIL: {last_err}", file=sys.stderr)
        return []

    out = []
    for event in data.get("events") or []:
        comp = (event.get("competitions") or [None])[0]
        if not comp:
            continue
        competitors = comp.get("competitors") or []
        home_c = next((c for c in competitors if c.get("homeAway") == "home"), None)
        away_c = next((c for c in competitors if c.get("homeAway") == "away"), None)
        if not home_c or not away_c:
            continue
        home_abbr = _norm_abbr(home_c.get("team", {}).get("abbreviation") or "")
        away_abbr = _norm_abbr(away_c.get("team", {}).get("abbreviation") or "")
        odds0 = (comp.get("odds") or [None])[0]
        spread = total = None
        ml_home = ml_away = None
        book_name = "DraftKings"
        if odds0:
            if odds0.get("spread") is not None:
                try:
                    spread = float(odds0["spread"])
                except (TypeError, ValueError):
                    spread = None
            if odds0.get("overUnder") is not None:
                try:
                    total = float(odds0["overUnder"])
                except (TypeError, ValueError):
                    total = None
            book_name = (
                (odds0.get("provider") or {}).get("name")
                or (odds0.get("provider") or {}).get("displayName")
                or "DraftKings"
            )
            ml = odds0.get("moneyline") or {}
            ml_home = parse_american(((ml.get("home") or {}).get("close") or {}).get("odds"))
            ml_away = parse_american(((ml.get("away") or {}).get("close") or {}).get("odds"))
        home_logo = (
            ((odds0 or {}).get("homeTeamOdds") or {}).get("team", {}).get("logo")
            or mlb_logo(None, home_abbr)
        )
        away_logo = (
            ((odds0 or {}).get("awayTeamOdds") or {}).get("team", {}).get("logo")
            or mlb_logo(None, away_abbr)
        )
        home_color = home_c.get("team", {}).get("color")
        away_color = away_c.get("team", {}).get("color")

        def colorize(c):
            if not c:
                return None
            return f"#{c}" if not str(c).startswith("#") else c

        status = (event.get("status") or {}).get("type") or {}
        completed = bool(status.get("completed")) or status.get("name") == "STATUS_FINAL"
        iso = event.get("date") or comp.get("date")
        # Derive calendar date in ET for matching StatsAPI officialDate
        day = None
        if iso:
            try:
                from zoneinfo import ZoneInfo
                day = (
                    datetime.fromisoformat(iso.replace("Z", "+00:00"))
                    .astimezone(ZoneInfo("America/New_York"))
                    .date()
                    .isoformat()
                )
            except Exception:
                day = iso[:10]
        books = []
        if spread is not None and total is not None:
            books.append(
                {
                    "name": book_name,
                    "spread": spread,
                    "total": total,
                    "moneylineHome": ml_home,
                    "moneylineAway": ml_away,
                    "source": "espn",
                }
            )
        out.append(
            {
                "id": str(event.get("id")),
                "key": game_key(away_abbr, home_abbr),
                "date": day,
                "away": {
                    "abbr": away_abbr,
                    "name": away_c.get("team", {}).get("displayName") or away_abbr,
                    "logo": away_logo,
                    "color": colorize(away_color),
                },
                "home": {
                    "abbr": home_abbr,
                    "name": home_c.get("team", {}).get("displayName") or home_abbr,
                    "logo": home_logo,
                    "color": colorize(home_color),
                },
                "kickoffIso": iso,
                "completed": completed,
                "books": books,
                "moneyline": {"home": ml_home, "away": ml_away} if (ml_home or ml_away) else None,
            }
        )
    return out


def merge_espn(games: list[dict], start: date, days: int) -> dict:
    espn_all: list[dict] = []
    days_ok = 0
    for i in range(days + 1):
        d = start + timedelta(days=i)
        ymd = d.strftime("%Y%m%d")
        print(f"  ESPN {ymd} …", file=sys.stderr)
        day_games = fetch_espn_day(ymd)
        n_books = sum(1 for g in day_games if g.get("books"))
        print(f"    → {len(day_games)} events, {n_books} with odds", file=sys.stderr)
        if day_games:
            days_ok += 1
        # If events exist but zero odds, one more retry after pause
        if day_games and n_books == 0 and i > 0:
            time.sleep(2)
            retry = fetch_espn_day(ymd)
            n2 = sum(1 for g in retry if g.get("books"))
            if n2 > n_books:
                print(f"    retry → {n2} with odds", file=sys.stderr)
                day_games = retry
        espn_all.extend(day_games)
        time.sleep(0.4)

    # Index: prefer date|key, then key (first with books wins for bare key)
    by_date_key: dict[str, dict] = {}
    by_key: dict[str, dict] = {}
    for eg in espn_all:
        if eg.get("date"):
            by_date_key[f"{eg['date']}|{eg['key']}"] = eg
        prev = by_key.get(eg["key"])
        if prev is None or (eg.get("books") and not prev.get("books")):
            by_key[eg["key"]] = eg

    matched = 0
    with_odds = 0
    for g in games:
        eg = by_date_key.get(f"{g.get('date')}|{g['key']}") or by_key.get(g["key"])
        if not eg:
            continue
        matched += 1
        for side in ("away", "home"):
            if eg[side].get("logo"):
                g[side]["logo"] = eg[side]["logo"]
            if eg[side].get("color"):
                g[side]["color"] = eg[side]["color"]
            if eg[side].get("name"):
                g[side]["name"] = eg[side]["name"]
        if eg.get("books"):
            # Don't overwrite if already has books from a better match (DH)
            if not g.get("books"):
                g["books"] = list(eg["books"])
                g["spread"] = eg["books"][0]["spread"]
                g["total"] = eg["books"][0]["total"]
                with_odds += 1
        if eg.get("moneyline") and not g.get("moneyline"):
            g["moneyline"] = eg["moneyline"]
        if eg.get("id"):
            g["espnId"] = eg["id"]

    return {
        "espnDaysOk": days_ok,
        "espnMatched": matched,
        "espnWithOdds": with_odds,
        "espnGamesSeen": len(espn_all),
    }


def with_consensus(g: dict) -> dict:
    books = g.get("books") or []
    spreads = [float(b["spread"]) for b in books if b.get("spread") is not None]
    totals = [float(b["total"]) for b in books if b.get("total") is not None]
    spread = total = None
    if spreads:
        ss = sorted(spreads)
        n = len(ss)
        spread = ss[n // 2] if n % 2 else (ss[n // 2 - 1] + ss[n // 2]) / 2
    if totals:
        tt = sorted(totals)
        n = len(tt)
        total = tt[n // 2] if n % 2 else (tt[n // 2 - 1] + tt[n // 2]) / 2
    has_odds = spread is not None and total is not None
    g = dict(g)
    g["consensus"] = (
        {"spread": spread, "total": total, "method": "median"} if has_odds else None
    )
    g["spread"] = spread
    g["total"] = total
    g["hasOdds"] = has_odds
    return g


def main() -> int:
    try:
        from zoneinfo import ZoneInfo
        today = datetime.now(ZoneInfo("America/Chicago")).date()
    except Exception:
        today = date.today()

    print(f"MLB lines fetch · start={today} · +{DAYS_AHEAD} days", file=sys.stderr)

    print("1) MLB Stats API schedule (fast, no enrichment)…", file=sys.stderr)
    games = fetch_schedule(today, DAYS_AHEAD, enrich=False)
    print(f"   schedule games: {len(games)}", file=sys.stderr)

    print("2) ESPN MLB scoreboard odds…", file=sys.stderr)
    espn_meta = merge_espn(games, today, DAYS_AHEAD)
    print(f"   ESPN meta: {espn_meta}", file=sys.stderr)

    print("3) Pitcher + team season context…", file=sys.stderr)
    enrich_games(games)

    enrich_platoon(games)

    games_out = [with_consensus(g) for g in games]
    games_out.sort(key=lambda g: g.get("kickoffIso") or "")

    fetched_at = now_iso()
    n_odds = sum(1 for g in games_out if g.get("hasOdds"))
    n_pp = sum(1 for g in games_out if g.get("awayPitcher") and g.get("homePitcher"))

    payload = {
        "fetchedAt": fetched_at,
        "sport": "mlb",
        "season": SEASON,
        "dateStart": today.isoformat(),
        "dateEnd": (today + timedelta(days=DAYS_AHEAD)).isoformat(),
        "daysAhead": DAYS_AHEAD,
        "sources": {
            "mlbStatsApi": {"ok": True, "games": len(games_out)},
            "espnDraftKings": {"ok": espn_meta["espnDaysOk"] > 0, **espn_meta},
            "multiBook": {
                "ok": False,
                "note": "FanDuel/BetMGM/Bovada MLB scrapers not adapted; ESPN DK only.",
            },
        },
        "disclaimer": (
            "Research tool — not betting advice. Odds from ESPN DraftKings when present; "
            "schedule/pitchers/team context from MLB Stats API. No invented lines."
        ),
        "games": games_out,
        "counts": {
            "games": len(games_out),
            "withOdds": n_odds,
            "withBothPitchers": n_pp,
        },
    }

    OUT.write_text(json.dumps(payload, indent=2) + "\n")
    print(
        f"Wrote {OUT} ({len(games_out)} games, {n_odds} with odds, {n_pp} with both SPs)",
        file=sys.stderr,
    )
    for g in games_out:
        if g.get("hasOdds") or g.get("date") == today.isoformat():
            ap = (g.get("awayPitcher") or {}).get("name", "?")
            hp = (g.get("homePitcher") or {}).get("name", "?")
            era_a = ((g.get("awayPitcher") or {}).get("stats") or {}).get("era")
            era_h = ((g.get("homePitcher") or {}).get("stats") or {}).get("era")
            print(
                f"  {g['key']} {g.get('date')} odds={g.get('hasOdds')} "
                f"RL={g.get('spread')} O/U={g.get('total')} "
                f"SP {ap}({era_a}) / {hp}({era_h})",
                file=sys.stderr,
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
