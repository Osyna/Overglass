"""Football matches and league tables from the public, key-free OpenLigaDB API.

Tables use /getbltable/{league}/{season}. OpenLigaDB does not publish lineups:
view='lineups' requires lineup_url to a real, user-supplied JSON provider.
The provider schema is {match: str, home: {name: str, players: [{name: str,
number?: int, position?: str}], formation?: str}, away: <same>}. Each team
has 1-30 actual players, rendered in provider order; no squad is inferred.
Optional lineup_token uses a Bearer header; private providers require opt-in.
"""
import re
import time
from datetime import datetime, timezone

from .. import notify
from ..errors import ValidationError
from ..datafetch import fetch_json
from ._shared import PRIVATE, card, number, private, text

API_URL = "https://api.openligadb.de/getmatchdata/"
MAX_MATCHES = 6
MAX_GOALS_SHOWN = 6  # for the featured (first) match only
MAX_TABLE_TEAMS = 20
LEAGUE_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,39}")
CREST_RE = re.compile(r"https://[^\s\"'<>]+")

META = {
    "name": "Football Scoreboard",
    "description": "OpenLigaDB scores and real league tables; lineups require your own genuine JSON source.",
    "category": "sports",
    "params_schema": [
        {"key": "league", "label": "League", "type": "select", "default": "bl1", "choices": [
            {"value": "bl1", "label": "Bundesliga"}, {"value": "bl2", "label": "2. Bundesliga"},
            {"value": "bl3", "label": "3. Liga"}, {"value": "dfb", "label": "DFB-Pokal"}]},
        {"key": "view", "label": "View", "type": "select", "default": "matches", "choices": [
            {"value": "matches", "label": "Matches"}, {"value": "table", "label": "League table"},
            {"value": "lineups", "label": "Lineups (your JSON provider)"}]},
        {"key": "season", "label": "Season start year (required for table)", "type": "number", "min": 1900, "max": 2200, "step": 1},
        {"key": "lineup_url", "label": "Real per-match lineup JSON URL", "type": "string",
         "description": "OpenLigaDB has no lineups. Supply {match,home:{name,players:[{name,number?,position?}]},away:{name,players:[...]}}."},
        {"key": "lineup_token", "label": "Lineup provider Bearer token (optional)", "type": "secret"},
        PRIVATE,
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


def _goal_event(goal, team1, team2):
    if not isinstance(goal.get("matchMinute"), int) or not isinstance(goal.get("goalGetterName"), str):
        raise ValueError("goal must have matchMinute and goalGetterName")
    tags = []
    if goal.get("isPenalty"):
        tags.append("pen.")
    if goal.get("isOwnGoal"):
        tags.append("OG")
    team = team1 if goal.get("scoringTeamId") == team1["teamId"] else team2
    scorer = goal["goalGetterName"] + (" (" + ", ".join(tags) + ")" if tags else "")
    tone = "alert" if goal.get("isOwnGoal") else "warning" if goal.get("isPenalty") else "accent"
    return {"type": "event", "time": "%d'" % goal["matchMinute"], "icon": "ball", "tone": tone,
            "text": "%s \u2014 %s" % (scorer, team.get("shortName") or team["teamName"])}


def poll(params: dict) -> dict:
    """Build a rich scoreboard: header facts, crests and status/score badges per match, the featured
    match's goals as timed events, and a data-source row with the latency this poll actually measured.
    No TV or pairing configuration is needed to poll; only --show/the refresh thread needs one."""
    if not isinstance(params, dict):
        raise ValidationError("Football parameters must be an object")
    league = params.get("league", "bl1")
    if not isinstance(league, str) or not LEAGUE_RE.fullmatch(league):
        raise ValidationError("League must be a shortcut of 1-40 letters, numbers, underscores or hyphens")
    view = params.get("view", "matches")
    if view not in ("matches", "table", "lineups"):
        raise ValidationError("Football view must be matches, table or lineups")
    season = params.get("season")
    if season not in (None, ""):
        season = number(params, "season", 1900, 2200, integer=True)
    else:
        season = None
    if view == "table":
        if season is None:
            raise ValidationError("A season start year is required for the league table")
        return _table(league, season)
    if view == "lineups":
        return _lineups(params)
    started = time.monotonic()
    try:
        matches = fetch_json(API_URL + league + ("/%d" % season if season is not None else ""))
    except ValueError:
        raise RuntimeError("OpenLigaDB returned malformed football data") from None
    except RuntimeError as error:
        if str(error) == "Data endpoint returned malformed JSON":
            raise RuntimeError("OpenLigaDB returned malformed football data") from None
        raise RuntimeError("Could not fetch OpenLigaDB football data") from None
    latency_ms = int((time.monotonic() - started) * 1000)

    try:
        if not isinstance(matches, list):
            raise ValueError("expected a list of matches")
        header = matches[0]["leagueName"] if matches else league.upper()
        group = matches[0].get("group", {}).get("groupName") if matches else None
        facts = [{"label": "Matchday", "value": group}] if isinstance(group, str) and group else []
        facts.append({"label": "Matches", "value": str(len(matches))})
        facts.append({"label": "Updated", "value": _now_utc().strftime("%H:%M UTC"), "icon": "clock"})
        board = []  # one stack for the matches, so the root stays well inside the 20-children cap
        for index, match in enumerate(matches[:MAX_MATCHES]):
            board.append({"type": "divider"})
            board.append(_match_row(match))
            if index == 0:
                goals = match.get("goals")
                if isinstance(goals, list) and goals:
                    events = [_goal_event(goal, match["team1"], match["team2"]) for goal in goals[:MAX_GOALS_SHOWN]]
                    board.append({"type": "stack", "gap": 8, "children":
                                  [{"type": "section", "title": "Goals", "icon": "ball"}] + events})
        if not matches:
            board.append({"type": "divider"})
            board.append({"type": "text", "text": "No matches available", "color": "fg-2"})
        elif len(matches) > MAX_MATCHES:
            board.append({"type": "text", "text": "Showing %d of %d matches" % (MAX_MATCHES, len(matches)),
                          "size": "xs", "color": "fg-2"})
        children = [{"type": "text", "text": header, "size": "l", "weight": "strong"},
                    {"type": "meta", "items": facts},
                    {"type": "stack", "gap": 14, "children": board},
                    {"type": "divider"},
                    {"type": "status", "label": "OpenLigaDB", "state": "online", "detail": "%d ms" % latency_ms}]
        return notify.check_overlay_request({"size": "l", "root": {"type": "stack", "gap": 14,
                                                                    "children": children}})
    except (KeyError, TypeError, ValueError, AttributeError):
        raise RuntimeError("OpenLigaDB returned malformed football data") from None


def _table(league, season):
    data = fetch_json("https://api.openligadb.de/getbltable/%s/%d" % (league, season))
    try:
        if not isinstance(data, list):
            raise ValueError
        rows = []
        for rank, team in enumerate(data[:MAX_TABLE_TEAMS], 1):
            name = text(team["teamName"], 50)
            fields = [team[key] for key in ("points", "matches", "won", "draw", "lost", "goals", "opponentGoals")]
            if not all(type(value) is int and value >= 0 for value in fields):
                raise ValueError
            points, played, won, draw, lost, goals, against = fields
            rows.append(text("%d. %s · %d pts · P%d W%d D%d L%d · %d:%d" %
                        (rank, name, points, played, won, draw, lost, goals, against), 120))
        children = [{"type": "list", "items": rows[start:start + 10]} for start in range(0, len(rows), 10)]
        if not rows:
            children = [{"type": "text", "text": "No league table available", "color": "fg-2"}]
        if len(data) > MAX_TABLE_TEAMS:
            children.append({"type": "text", "text": "Showing %d of %d teams" % (MAX_TABLE_TEAMS, len(data)), "size": "s"})
        return card("%s · %d/%d" % (league.upper(), season, season + 1), children, "OpenLigaDB · ODbL 1.0")
    except (KeyError, TypeError, ValueError, AttributeError, RuntimeError):
        raise RuntimeError("OpenLigaDB returned malformed league table data") from None


def _lineups(params):
    url = params.get("lineup_url")
    token = params.get("lineup_token", "")
    if not isinstance(url, str) or not url:
        raise ValidationError("OpenLigaDB has no lineups; provide a genuine per-match lineup_url")
    if not isinstance(token, str):
        raise ValidationError("lineup_token must be text")
    data = fetch_json(url, headers={"Authorization": "Bearer " + token} if token else None, allow_private=private(params))
    try:
        title = text(data["match"])
        children = []
        for side in ("home", "away"):
            team = data[side]
            name = text(team["name"], 80)
            if "formation" in team:
                name += " · " + text(team["formation"], 30)
            players = team["players"]
            if not isinstance(players, list) or not 1 <= len(players) <= 30:
                raise ValueError
            rows = []
            for player in players:
                name_player = text(player["name"], 60)
                if "number" in player:
                    if type(player["number"]) is not int or not 0 <= player["number"] <= 999:
                        raise ValueError
                    name_player = "%d · %s" % (player["number"], name_player)
                if "position" in player:
                    name_player += " · " + text(player["position"], 30)
                rows.append(name_player)
            children.append({"type": "section", "title": text(name, 40), "icon": "ball"})
            children.extend({"type": "list", "items": rows[start:start + 10]} for start in range(0, len(rows), 10))
        return card(title, children, "User-supplied lineup provider")
    except (KeyError, TypeError, ValueError, AttributeError, RuntimeError):
        raise RuntimeError("Lineup provider returned malformed per-match data") from None
