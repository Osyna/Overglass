"""RSS 2.0 / RDF RSS / Atom headlines, bounded and rendered as plain text.

DOCTYPE/entity declarations are rejected before XML parsing; external resources,
embedded HTML, feed links and images are never fetched or executed. Max 4,000
XML elements and 20 levels; the shared transport caps the source at 1 MiB.
"""
import re
import xml.etree.ElementTree as ET

from ..datafetch import fetch_text
from ._shared import LABEL, LIMIT, PRIVATE, URL, card, number, parameters, private, required, text

META = {"name": "RSS / Atom", "description": "Plain-text headlines from a real RSS or Atom feed.",
        "category": "news", "default_interval_seconds": 900, "params_schema": [URL, LABEL, LIMIT, PRIVATE]}


def _name(tag):
    return tag.rsplit("}", 1)[-1]


def _parse(source):
    if re.search(r"<!\s*(?:DOCTYPE|ENTITY)\b", source, re.I):
        raise RuntimeError("RSS XML declarations and entities are not allowed")
    parser = ET.XMLPullParser(events=("start", "end"))
    depth = count = 0
    root = None
    try:
        for offset in range(0, len(source), 4096):
            parser.feed(source[offset:offset + 4096])
            for event, node in parser.read_events():
                if event == "start":
                    depth += 1
                    count += 1
                    if root is None:
                        root = node
                    if depth > 20 or count > 4000:
                        raise RuntimeError("RSS XML structure exceeds parser limits")
                else:
                    depth -= 1
        parser.close()
    except ET.ParseError:
        raise RuntimeError("RSS endpoint returned malformed XML") from None
    if root is None or _name(root.tag) not in ("rss", "RDF", "feed"):
        raise RuntimeError("Endpoint is not an RSS or Atom feed")
    return root


def poll(params):
    parameters(params)
    limit = number(params, "limit", 1, 10, 5, integer=True)
    root = _parse(fetch_text(required(params, "url"), allow_private=private(params)))
    channel = next((child for child in root if _name(child.tag) == "channel"), root)
    title = next((text("".join(child.itertext())) for child in channel if _name(child.tag) == "title"), "RSS / Atom")
    headlines = []
    for node in root.iter():
        if _name(node.tag) in ("item", "entry"):
            title_node = next((child for child in node if _name(child.tag) == "title"), None)
            if title_node is not None:
                headline = text("".join(title_node.itertext()), 120)
                if headline:
                    headlines.append(headline)
            if len(headlines) >= limit:
                break
    return card(params.get("label") or title, [{"type": "list", "items": headlines}] if headlines else
                [{"type": "text", "text": "No headlines available", "color": "fg-2"}], "RSS / Atom")
