#!/usr/bin/env python3
"""
Fetch NFL public betting splits from Action Network and write ../splits.json.

Parses __NEXT_DATA__ → props.pageProps.scoreboardResponse.games.
Prefers book id 15 (consensus-style) for moneyline / spread / total.

sharpGap = money% − tickets% (positive ⇒ money heavier than tickets on that side).
|sharpGap| ≥ 10 ⇒ sharpLean on the higher-money side (honestly labeled; not advice).

Week logic:
  - Prefer Week TARGET (3) slate when present on the page.
  - Always include Week TARGET-1 Monday Night Football if present.
  - If Week TARGET is absent, keep the prior-week slate so featured MNF still matches.
"""

from __future__ import annotations

import json
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)

URL = "https://www.actionnetwork.com/nfl/public-betting"
BOOK_ID = "15"
TARGET_WEEK = 3
PRIOR_WEEK = TARGET_WEEK - 1
SHARP_THRESHOLD = 10
OUT = Path(__file__).resolve().parent.parent / "splits.json"

# Action Network abbr → ESPN / pick-board abbr
ABBR_MAP = {
    "JAC": "JAX",
    "LA": "LAR",
    "WSH": "WSH",
    "WAS": "WSH",
}


def now_iso() -> str:
    return (
        datetime.now(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


def norm_abbr(abbr: str | None) -> str | None:
    if not abbr:
        return None
    a = abbr.strip().upper()
    return ABBR_MAP.get(a, a)


def game_key(away: str, home: str) -> str:
    return f"{away}@{home}"


def fetch_html(url: str, timeout: int = 60) -> str:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": UA,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        raise SystemExit(f"FATAL: Action Network HTTP {e.code} for {url}") from e
    except urllib.error.URLError as e:
        raise SystemExit(f"FATAL: Action Network fetch failed: {e}") from e


def parse_next_data(html: str) -> dict:
    m = re.search(
        r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>',
        html,
        re.DOTALL,
    )
    if not m:
        raise SystemExit("FATAL: __NEXT_DATA__ not found on Action Network page")
    try:
        return json.loads(m.group(1))
    except json.JSONDecodeError as e:
        raise SystemExit(f"FATAL: invalid __NEXT_DATA__ JSON: {e}") from e


def pct(outcome: dict | None, kind: str) -> int | None:
    if not outcome:
        return None
    bi = outcome.get("bet_info") or {}
    node = bi.get(kind) or {}
    val = node.get("percent")
    if val is None:
        return None
    try:
        return int(round(float(val)))
    except (TypeError, ValueError):
        return None


def side_map(outcomes: list[dict]) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for o in outcomes or []:
        side = (o.get("side") or "").lower()
        if side:
            out[side] = o
    return out


def sharp_fields(
    a_tickets: int | None,
    a_money: int | None,
    b_tickets: int | None,
    b_money: int | None,
    a_name: str,
    b_name: str,
) -> dict[str, Any]:
    """Compute sharpGap and optional sharpLean for two opposing sides.

    sharpGap = money% − tickets% (positive ⇒ money heavier than tickets).
    sharpLean = side with money heavier than tickets by ≥ SHARP_THRESHOLD.
    """
    result: dict[str, Any] = {}
    a_gap = None
    b_gap = None
    if a_money is not None and a_tickets is not None:
        a_gap = a_money - a_tickets
        result[f"{a_name}SharpGap"] = a_gap
    if b_money is not None and b_tickets is not None:
        b_gap = b_money - b_tickets
        result[f"{b_name}SharpGap"] = b_gap

    candidates = []
    if a_gap is not None and a_gap >= SHARP_THRESHOLD:
        candidates.append((a_name, a_gap))
    if b_gap is not None and b_gap >= SHARP_THRESHOLD:
        candidates.append((b_name, b_gap))
    if candidates:
        # Prefer larger positive gap (usually only one side is positive)
        lean, lean_gap = max(candidates, key=lambda x: x[1])
        result["sharpLean"] = lean
        result["sharpGap"] = lean_gap
    return result


def parse_spread(event: dict) -> dict | None:
    sm = side_map(event.get("spread") or [])
    home_o, away_o = sm.get("home"), sm.get("away")
    if not home_o and not away_o:
        return None
    home_t, home_m = pct(home_o, "tickets"), pct(home_o, "money")
    away_t, away_m = pct(away_o, "tickets"), pct(away_o, "money")
    line = None
    if home_o and home_o.get("value") is not None:
        try:
            line = float(home_o["value"])
        except (TypeError, ValueError):
            line = None
    out: dict[str, Any] = {
        "homeTickets": home_t,
        "homeMoney": home_m,
        "awayTickets": away_t,
        "awayMoney": away_m,
        "line": line,
    }
    out.update(sharp_fields(home_t, home_m, away_t, away_m, "home", "away"))
    return out


def parse_moneyline(event: dict) -> dict | None:
    sm = side_map(event.get("moneyline") or [])
    home_o, away_o = sm.get("home"), sm.get("away")
    if not home_o and not away_o:
        return None
    home_t, home_m = pct(home_o, "tickets"), pct(home_o, "money")
    away_t, away_m = pct(away_o, "tickets"), pct(away_o, "money")
    out: dict[str, Any] = {
        "homeTickets": home_t,
        "homeMoney": home_m,
        "awayTickets": away_t,
        "awayMoney": away_m,
    }
    out.update(sharp_fields(home_t, home_m, away_t, away_m, "home", "away"))
    return out


def parse_total(event: dict) -> dict | None:
    sm = side_map(event.get("total") or [])
    over_o, under_o = sm.get("over"), sm.get("under")
    if not over_o and not under_o:
        return None
    over_t, over_m = pct(over_o, "tickets"), pct(over_o, "money")
    under_t, under_m = pct(under_o, "tickets"), pct(under_o, "money")
    line = None
    for o in (over_o, under_o):
        if o and o.get("value") is not None:
            try:
                line = float(o["value"])
                break
            except (TypeError, ValueError):
                pass
    out: dict[str, Any] = {
        "overTickets": over_t,
        "overMoney": over_m,
        "underTickets": under_t,
        "underMoney": under_m,
        "line": line,
    }
    out.update(sharp_fields(over_t, over_m, under_t, under_m, "over", "under"))
    return out


def is_monday_night(start_time: str | None) -> bool:
    if not start_time:
        return False
    try:
        # AN times are ISO with offset or Z
        dt = datetime.fromisoformat(start_time.replace("Z", "+00:00"))
        local = dt.astimezone(ZoneInfo("America/New_York"))
        return local.weekday() == 0  # Monday
    except Exception:
        return False


def extract_game(raw: dict) -> dict | None:
    teams = raw.get("teams") or []
    by_id = {t.get("id"): t for t in teams}
    home_t = by_id.get(raw.get("home_team_id"))
    away_t = by_id.get(raw.get("away_team_id"))
    if not home_t or not away_t:
        return None
    away = norm_abbr(away_t.get("abbr"))
    home = norm_abbr(home_t.get("abbr"))
    if not away or not home:
        return None

    markets = raw.get("markets") or {}
    book = markets.get(BOOK_ID) or markets.get(int(BOOK_ID))  # type: ignore[arg-type]
    if not isinstance(book, dict):
        # fallback: first book with event.moneyline
        for v in markets.values():
            if isinstance(v, dict) and isinstance(v.get("event"), dict):
                if v["event"].get("moneyline") or v["event"].get("spread"):
                    book = v
                    break
    if not isinstance(book, dict):
        return None
    event = book.get("event") or {}
    if not isinstance(event, dict):
        return None

    spread = parse_spread(event)
    moneyline = parse_moneyline(event)
    total = parse_total(event)
    if not spread and not moneyline and not total:
        return None

    week = raw.get("week")
    try:
        week_i = int(week) if week is not None else None
    except (TypeError, ValueError):
        week_i = None

    return {
        "key": game_key(away, home),
        "away": away,
        "home": home,
        "week": week_i,
        "numBets": raw.get("num_bets"),
        "startTime": raw.get("start_time"),
        "status": raw.get("status") or raw.get("real_status"),
        "spread": spread,
        "moneyline": moneyline,
        "total": total,
        "mondayNight": is_monday_night(raw.get("start_time")),
    }


def select_slate(parsed: list[dict]) -> tuple[list[dict], int, str]:
    """Return (games, board_week, note)."""
    w3 = [g for g in parsed if g.get("week") == TARGET_WEEK]
    w2 = [g for g in parsed if g.get("week") == PRIOR_WEEK]
    mnf = [g for g in w2 if g.get("mondayNight")]

    if w3:
        # Deduplicate by key; week 3 wins over MNF collision
        by_key: dict[str, dict] = {g["key"]: g for g in mnf}
        for g in w3:
            by_key[g["key"]] = g
        games = sorted(by_key.values(), key=lambda g: g.get("startTime") or "")
        note = f"Week {TARGET_WEEK} slate + {len(mnf)} Week {PRIOR_WEEK} MNF"
        return games, TARGET_WEEK, note

    if w2:
        note = (
            f"Action Network page has no Week {TARGET_WEEK} yet; "
            f"using Week {PRIOR_WEEK} slate ({len(w2)} games, {len(mnf)} MNF)"
        )
        return sorted(w2, key=lambda g: g.get("startTime") or ""), PRIOR_WEEK, note

    # Any other weeks present
    if parsed:
        weeks = sorted({g.get("week") for g in parsed if g.get("week") is not None})
        note = f"Unexpected weeks on page: {weeks}; keeping all parsed games"
        wk = weeks[-1] if weeks else TARGET_WEEK
        return sorted(parsed, key=lambda g: g.get("startTime") or ""), wk, note

    raise SystemExit("FATAL: no games with public-betting markets on Action Network page")


def main() -> int:
    print(f"Fetching {URL} …", file=sys.stderr)
    html = fetch_html(URL)
    data = parse_next_data(html)
    try:
        games_raw = data["props"]["pageProps"]["scoreboardResponse"]["games"]
    except (KeyError, TypeError) as e:
        raise SystemExit(
            f"FATAL: scoreboardResponse.games missing in NEXT_DATA ({e})"
        ) from e

    if not isinstance(games_raw, list) or not games_raw:
        raise SystemExit("FATAL: scoreboardResponse.games empty")

    parsed: list[dict] = []
    for raw in games_raw:
        g = extract_game(raw)
        if g:
            parsed.append(g)
        else:
            print(f"  skip game id={raw.get('id')}: missing teams/markets", file=sys.stderr)

    games, board_week, note = select_slate(parsed)
    print(f"[ok] {note}", file=sys.stderr)

    # Strip helper flag from output
    games_out = []
    for g in games:
        item = {k: v for k, v in g.items() if k != "mondayNight"}
        games_out.append(item)

    by_key = {g["key"]: g for g in games_out}
    fetched_at = now_iso()
    payload = {
        "fetchedAt": fetched_at,
        "source": "Action Network public betting",
        "sourceUrl": URL,
        "bookId": int(BOOK_ID),
        "week": board_week,
        "targetWeek": TARGET_WEEK,
        "sharpThreshold": SHARP_THRESHOLD,
        "note": note,
        "disclaimer": (
            "Public betting sample from Action Network (tickets % vs money %). "
            "A money−tickets gap is often read as a sharper lean — not a guarantee "
            "of sharp action and not betting advice. Snapshot only; re-run this script to refresh."
        ),
        "games": games_out,
        "byKey": by_key,
    }

    OUT.write_text(json.dumps(payload, indent=2) + "\n")
    print(f"Wrote {OUT} ({len(games_out)} games)", file=sys.stderr)
    for g in games_out[:4]:
        sp = g.get("spread") or {}
        ml = g.get("moneyline") or {}
        tot = g.get("total") or {}
        print(
            f"  {g['key']} w{g.get('week')}: "
            f"ML h {ml.get('homeTickets')}/{ml.get('homeMoney')} "
            f"spread h {sp.get('homeTickets')}/{sp.get('homeMoney')} "
            f"tot u {tot.get('underTickets')}/{tot.get('underMoney')} "
            f"leans={[m.get('sharpLean') for m in (sp, ml, tot) if m and m.get('sharpLean')]}",
            file=sys.stderr,
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
