"""iCalendar VEVENT agenda with UTC, TZID (IANA), all-day and floating times.

Floating timestamps use the server's local timezone. Cancelled events are omitted.
Recurrence rules are displayed as series definitions (original DTSTART), never
expanded into invented occurrences; publish an expanded feed for a full agenda.
Only SUMMARY/DTSTART/DTEND/LOCATION/STATUS/RRULE/RDATE are read, never attachments,
URLs or alarms. Sources are capped at 1 MiB, 20,000 lines, 1,000 events, depth 8.
"""
import re
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from ..datafetch import fetch_text
from ._shared import LABEL, LIMIT, PRIVATE, URL, card, number, parameters, private, required, text

META = {"name": "Calendar", "description": "Real iCalendar events. Recurring series show their original start; occurrences are not expanded.",
        "category": "calendar", "default_interval_seconds": 900, "params_schema": [URL, LABEL, LIMIT, PRIVATE]}


def _unescape(value):
    return re.sub(r"\\([nN,;\\])", lambda match: " " if match[1] in "nN" else match[1], value)


def _date(value, options):
    all_day = options.get("VALUE") == "DATE" or re.fullmatch(r"[0-9]{8}", value) is not None
    if all_day:
        date = datetime.strptime(value, "%Y%m%d")
        label = date.strftime("%d %b %Y") + " (all day)"
    elif value.endswith("Z"):
        date = datetime.strptime(value, "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)
        label = date.strftime("%d %b %H:%M UTC")
    else:
        date = datetime.strptime(value, "%Y%m%dT%H%M%S")
        tzid = options.get("TZID")
        if tzid:
            date = date.replace(tzinfo=ZoneInfo(tzid))
        label = date.strftime("%d %b %H:%M") + (" " + tzid if tzid else " local")
    return date.astimezone(timezone.utc), label, all_day


def _events(source):
    lines = source.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    if len(lines) > 20000:
        raise RuntimeError("Calendar exceeds the line limit")
    unfolded = []
    for line in lines:
        if line.startswith((" ", "\t")) and unfolded:
            unfolded[-1] += line[1:]
        else:
            unfolded.append(line)
    stack, events, current = [], [], None
    try:
        for line in unfolded:
            if not line:
                continue
            name, sep, value = line.partition(":")
            if not sep:
                raise ValueError
            if name.upper() == "BEGIN":
                stack.append(value.upper())
                if len(stack) > 8 or (len(stack) == 1 and stack[0] != "VCALENDAR"):
                    raise ValueError
                if stack[-1] == "VEVENT":
                    if current is not None:
                        raise ValueError
                    current = {}
            elif name.upper() == "END":
                if not stack or stack[-1] != value.upper():
                    raise ValueError
                if stack[-1] == "VEVENT":
                    events.append(current)
                    current = None
                    if len(events) > 1000:
                        raise ValueError
                stack.pop()
            elif stack and stack[-1] == "VEVENT":
                fields = name.split(";")
                key = fields[0].upper()
                if key in ("DTSTART", "DTEND", "SUMMARY", "LOCATION", "STATUS", "RRULE", "RDATE"):
                    options = dict(field.split("=", 1) for field in fields[1:])
                    options = {key.upper(): value.strip('"') for key, value in options.items()}
                    current[key] = (value, options)
        if stack or not any(line.upper() == "BEGIN:VCALENDAR" for line in unfolded):
            raise ValueError
        result = []
        now = datetime.now(timezone.utc)
        for event in events:
            if event.get("STATUS", ("", {}))[0].upper() == "CANCELLED":
                continue
            start, label, all_day = _date(*event["DTSTART"])
            end = _date(*event["DTEND"])[0] if "DTEND" in event else start + (timedelta(days=1) if all_day else timedelta())
            recurring = "RRULE" in event or "RDATE" in event
            if end < now and not recurring:
                continue
            summary = _unescape(event.get("SUMMARY", ("Untitled event", {}))[0])
            location = _unescape(event.get("LOCATION", ("", {}))[0])
            line = ("Series starts " if recurring else "") + label + " — " + summary
            if location:
                line += " · " + location
            result.append((start, text(line, 120)))
        return [line for _, line in sorted(result)]
    except (ValueError, KeyError, TypeError, ZoneInfoNotFoundError, OverflowError):
        raise RuntimeError("Calendar returned malformed or unsupported event data") from None


def poll(params):
    parameters(params)
    limit = number(params, "limit", 1, 10, 5, integer=True)
    events = _events(fetch_text(required(params, "url"), allow_private=private(params)))[:limit]
    return card(params.get("label") or "Calendar", [{"type": "list", "items": events}] if events else
                [{"type": "text", "text": "No upcoming events", "color": "fg-2"}], "iCalendar")
