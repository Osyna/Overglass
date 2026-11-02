"""Current-matchday football scores and goal events from the public, key-free OpenLigaDB API."""
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
MAX_GOALS_SHOWN = 6  # for the featured (first) match only
TIMEOUT = 8
LEAGUE_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,39}")
CREST_RE = re.compile(r"https://[^\s\"'<>]+")

META = {
    "name": "Football Scoreboard",
    "description": "Live scores, crests and goal-by-goal events for a league's current matchday.",
    "category": "sports",
    "params_schema": [
        {"key": "league", "label": "League", "type": "select", "default": "bl1", "choices": [
            {"value": "bl1", "label": "Bundesliga"}, {"value": "bl2", "label": "2. Bundesliga"},
            {"value": "bl3", "label": "3. Liga"}, {"value": "dfb", "label": "DFB-Pokal"}]},
    ],
    "default_interval_seconds": 90,
}


def _now_utc():
    return datetime.now(timezone.utc)


def _kickoff(match):
    kickoff = datetime.fromisoformat(match["matchDateTimeUTC"].replace("Z", "+00:00"))
    if kickoff.tzinfo is None:
        raise ValueError("kickoff must include its timezone")
    return kickoff


def _score(match):
    results = match["matchResults"]
    if not isinstance(results, list) or not all(isinstance(result, dict) for result in results):
        raise ValueError("matchResults must be a list of results")
    if not results:
        return None
    if not all(type(result["resultOrderID"]) is int for result in results):
        raise ValueError("resultOrderID must be an integer")
    result = max(results, key=lambda item: item["resultOrderID"])
    home, away = result["pointsTeam1"], result["pointsTeam2"]
    if not all(type(score) is int and score >= 0 for score in (home, away)):
        raise ValueError("scores must be nonnegative integers")
    return home, away


def _state_badge(match):
    """(badge text, badge tone). FT/LIVE are inferred from matchIsFinished and the real kickoff time --
    OpenLigaDB has no explicit "live" flag or running clock, so no minute is ever shown or invented."""
    finished = match["matchIsFinished"]
    if not isinstance(finished, bool):
        raise ValueError("matchIsFinished must be a boolean")
    score = _score(match)
    if finished:
        return "FULL TIME", "info", score
    if score is not None and _kickoff(match) <= _now_utc():
        return "LIVE", "success", score
    return _kickoff(match).strftime("%d %b %H:%M UTC"), None, None


def _crest(team):
    url = team.get("teamIconUrl")
    return url if isinstance(url, str) and len(url) <= 500 and CREST_RE.fullmatch(url) else None


def _team_row(team, align):
    children = []
    crest = _crest(team)
    if crest:
        children.append({"type": "image", "src": crest, "shape": "circle"})
    children.append({"type": "text", "text": team["teamName"], "size": "s", "weight": "strong"})
    if align == "end":
        children.reverse()
    return children


def _match_row(match):
    label, tone, score = _state_badge(match)
    badge_text = ("%d - %d" % score) if score is not None else label
    row = [{"type": "row", "gap": 10, "align": "center", "children": _team_row(match["team1"], "start")},
           {"type": "badge", "text": badge_text, "tone": tone} if tone else {"type": "badge", "text": badge_text},
           {"type": "row", "gap": 10, "align": "center", "children": _team_row(match["team2"], "end")}]
    return {"type": "row", "gap": 14, "align": "center", "children": row}


def _goal_line(goal, team1, team2):
    if not isinstance(goal.get("matchMinute"), int) or not isinstance(goal.get("goalGetterName"), str):
        raise ValueError("goal must have matchMinute and goalGetterName")
    tags = []
    if goal.get("isPenalty"):
        tags.append("pen.")
    if goal.get("isOwnGoal"):
        tags.append("OG")
    team = team1 if goal.get("scoringTeamId") == team1["teamId"] else team2
    scorer = goal["goalGetterName"] + (" (" + ", ".join(tags) + ")" if tags else "")
    return "%d' %s \u2014 %s" % (goal["matchMinute"], scorer, team.get("shortName") or team["teamName"])


def poll(params: dict) -> dict:
    """Build a rich scoreboard: crests, status/score badges per match, goal events for the first match.
    No TV or pairing configuration is needed to poll; only --show/the refresh thread needs one."""
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
        header = matches[0]["leagueName"] if matches else league.upper()
        group = matches[0].get("group", {}).get("groupName") if matches else None
        head_children = [{"type": "text", "text": header, "size": "l", "weight": "strong"}]
        if isinstance(group, str) and group:
            head_children.append({"type": "text", "text": group, "size": "xs", "color": "fg-2"})
        children = [{"type": "stack", "gap": 2, "children": head_children}]
        for index, match in enumerate(matches[:MAX_MATCHES]):
            children.append({"type": "divider"})
            children.append(_match_row(match))
            if index == 0:
                goals = match.get("goals")
                if isinstance(goals, list) and goals:
                    lines = [_goal_line(goal, match["team1"], match["team2"]) for goal in goals[:MAX_GOALS_SHOWN]]
                    children.append({"type": "list", "items": lines, "style": "plain"})
        if not matches:
            children.append({"type": "divider"})
            children.append({"type": "text", "text": "No matches available", "color": "fg-2"})
        elif len(matches) > MAX_MATCHES:
            children.append({"type": "text", "text": "Showing %d of %d matches" % (MAX_MATCHES, len(matches)),
                             "size": "xs", "color": "fg-2"})
        return notify.check_overlay_request({"size": "l", "root": {"type": "stack", "gap": 14,
                                                                    "children": children}})
    except (KeyError, TypeError, ValueError, AttributeError):
        raise RuntimeError("OpenLigaDB returned malformed football data") from None
