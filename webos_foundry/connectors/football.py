"""Current-matchday football scores from the public, key-free OpenLigaDB API."""
import json
import re
import urllib.error
import urllib.request
from datetime import datetime, timezone
from http.client import HTTPException

from .. import notify
from ..errors import ValidationError

API_URL = "https://api.openligadb.de/getmatchdata/"
MAX_MATCHES = 6
TIMEOUT = 8
LEAGUE_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,39}")


def _status(match):
    results = match["matchResults"]
    if not isinstance(results, list) or not all(isinstance(result, dict) for result in results):
        raise ValueError("matchResults must be a list of results")
    if results:
        if not all(type(result["resultOrderID"]) is int for result in results):
            raise ValueError("resultOrderID must be an integer")
        result = max(results, key=lambda item: item["resultOrderID"])
        home, away = result["pointsTeam1"], result["pointsTeam2"]
        if not all(type(score) is int and score >= 0 for score in (home, away)):
            raise ValueError("scores must be nonnegative integers")
        return "%d : %d" % (home, away)
    kickoff = datetime.fromisoformat(match["matchDateTimeUTC"].replace("Z", "+00:00"))
    if kickoff.tzinfo is None:
        raise ValueError("kickoff must include its timezone")
    return kickoff.astimezone(timezone.utc).strftime("%d %b %H:%M UTC")


def poll(params: dict) -> dict:
    """Build a compact scoreboard; no TV or pairing configuration is needed."""
    if not isinstance(params, dict):
        raise ValidationError("Football parameters must be an object")
    league = params.get("league", "bl1")
    if not isinstance(league, str) or not LEAGUE_RE.fullmatch(league):
        raise ValidationError("League must be a shortcut of 1-40 letters, numbers, underscores or hyphens")
    try:
        with urllib.request.urlopen(API_URL + league, timeout=TIMEOUT) as response:
            matches = json.load(response)
    except (urllib.error.URLError, OSError, HTTPException) as error:
        raise RuntimeError("Could not fetch OpenLigaDB football data: %s" % error) from None
    except ValueError:
        raise RuntimeError("OpenLigaDB returned malformed football data") from None

    try:
        if not isinstance(matches, list):
            raise ValueError("expected a list of matches")
        children = [{"type": "text", "text": matches[0]["leagueName"] if matches else league.upper(),
                     "size": "l", "weight": "strong"}]
        for index, match in enumerate(matches[:MAX_MATCHES]):
            if index:
                children.append({"type": "divider"})
            children.append({"type": "row", "gap": 12, "align": "center", "children": [
                {"type": "text", "text": match["team1"]["teamName"], "size": "s"},
                {"type": "badge", "text": _status(match)},
                {"type": "text", "text": match["team2"]["teamName"], "size": "s"},
            ]})
        if not matches:
            children.append({"type": "text", "text": "No matches available", "color": "fg-2"})
        elif len(matches) > MAX_MATCHES:
            children.append({"type": "text", "text": "Showing %d of %d matches" % (MAX_MATCHES, len(matches)),
                             "size": "xs", "color": "fg-2"})
        return notify.check_overlay_request({"size": "l", "root": {"type": "stack", "gap": 12,
                                                                    "children": children}})
    except (KeyError, TypeError, ValueError, AttributeError):
        raise RuntimeError("OpenLigaDB returned malformed football data") from None
