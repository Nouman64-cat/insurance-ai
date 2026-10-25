"""Namespace-tolerant XMP packet parsing.

XMP can state the same property as an attribute or as a child element, and tools
mix both styles, so values are collected from either form under a stable
``prefix:name`` key.
"""

from __future__ import annotations

import re
from collections import defaultdict
from dataclasses import dataclass, field

from defusedxml import ElementTree as SafeET

NAMESPACES = {
    "http://ns.adobe.com/xap/1.0/": "xmp",
    "http://ns.adobe.com/pdf/1.3/": "pdf",
    "http://ns.adobe.com/xap/1.0/mm/": "xmpMM",
    "http://ns.adobe.com/xap/1.0/sType/ResourceEvent#": "stEvt",
    "http://ns.adobe.com/xap/1.0/sType/ResourceRef#": "stRef",
    "http://ns.adobe.com/photoshop/1.0/": "photoshop",
    "http://iptc.org/std/Iptc4xmpExt/2008-02-29/": "Iptc4xmpExt",
    "http://purl.org/dc/elements/1.1/": "dc",
    "http://ns.adobe.com/exif/1.0/": "exif",
    "http://ns.adobe.com/tiff/1.0/": "tiff",
    "http://ns.adobe.com/camera-raw-settings/1.0/": "crs",
    "http://ns.google.com/photos/1.0/creations/": "GCreations",
    "http://www.w3.org/1999/02/22-rdf-syntax-ns#": "rdf",
}
RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#"

_PACKET = re.compile(rb"<x:x[am]pmeta\b.*?</x:x[am]pmeta\s*>", re.DOTALL)
_MAX_PACKET = 4 * 1024 * 1024


@dataclass
class XmpData:
    props: dict[str, list[str]] = field(default_factory=lambda: defaultdict(list))
    history: list[dict[str, str]] = field(default_factory=list)

    def first(self, key: str) -> str | None:
        values = self.props.get(key)
        return values[0] if values else None

    def all(self, key: str) -> list[str]:
        return list(self.props.get(key, []))

    def has_prefix(self, prefix: str) -> bool:
        return any(k.startswith(prefix + ":") for k in self.props)


def _key(qname: str) -> str:
    if qname.startswith("{"):
        uri, local = qname[1:].split("}", 1)
        return f"{NAMESPACES.get(uri, uri)}:{local}"
    return qname


def _text(el) -> str:
    return (el.text or "").strip()


def find_packets(data: bytes) -> list[bytes]:
    return [m.group(0) for m in _PACKET.finditer(data) if len(m.group(0)) <= _MAX_PACKET]


def parse_packet(packet: bytes) -> XmpData | None:
    try:
        root = SafeET.fromstring(packet)
    except Exception:
        return None
    out = XmpData()
    for el in root.iter():
        key = _key(el.tag)
        if key.startswith("rdf:") or key.startswith("x:") or key.startswith("adobe:ns:meta/"):
            pass
        else:
            resource = el.attrib.get(f"{{{RDF}}}resource")
            if resource:
                out.props[key].append(resource)
            elif len(el) == 0 and _text(el):
                out.props[key].append(_text(el))
            else:
                # rdf:Seq / rdf:Bag / rdf:Alt containers hold their values in rdf:li children
                for li in el.iter(f"{{{RDF}}}li"):
                    if len(li) == 0 and _text(li):
                        out.props[key].append(_text(li))
        for attr, value in el.attrib.items():
            akey = _key(attr)
            if not akey.startswith("rdf:") and value.strip():
                out.props[akey].append(value.strip())
    for hist in root.iter(f"{{{_uri('xmpMM')}}}History"):
        for li in hist.iter(f"{{{RDF}}}li"):
            event: dict[str, str] = {}
            for node in [li, *li.iter()]:
                for attr, value in node.attrib.items():
                    k = _key(attr)
                    if k.startswith("stEvt:"):
                        event[k[6:]] = value.strip()
                k = _key(node.tag)
                if k.startswith("stEvt:") and _text(node):
                    event[k[6:]] = _text(node)
            if event:
                out.history.append(event)
    return out


def _uri(prefix: str) -> str:
    return next(uri for uri, p in NAMESPACES.items() if p == prefix)


def parse_all(data: bytes) -> list[XmpData]:
    return [x for x in (parse_packet(p) for p in find_packets(data)) if x is not None]


def merge(packets: list[XmpData]) -> XmpData:
    merged = XmpData()
    for x in packets:
        for k, values in x.props.items():
            for v in values:
                if v not in merged.props[k]:
                    merged.props[k].append(v)
        merged.history.extend(x.history)
    return merged
