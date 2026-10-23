"""Provenance markers that AI generators and editors embed: C2PA, IPTC source type, prompts.

Presence of these markers is near-certain evidence. Absence proves nothing:
screenshots, re-saves and messaging apps strip them.
"""

from __future__ import annotations

import io
import json
import re
from typing import Any

from .knowledge import IMAGE_TOOL_SEVERITY, ToolKind, digital_source_type, identify_tools
from .report import Category, Finding, Severity

# Actions that change what the content shows, as opposed to crop/resize/colour.
_CONTENT_EDIT_ACTIONS = {"c2pa.edited", "c2pa.drawing", "c2pa.placed", "c2pa.removed", "c2pa.filtered", "c2pa.converted"}
_TAMPER_CODE = re.compile(r"mismatch|\.hash\.|dataHash|boxesHash|bmffHash|collectionHash|altered", re.IGNORECASE)

# Prompt metadata written by Stable Diffusion front-ends into PNG text chunks or EXIF comments.
_SD_PARAMETERS = re.compile(r"(negative prompt:|\bsteps:\s*\d+.*\bsampler:|\bcfg scale:)", re.IGNORECASE | re.DOTALL)
_AI_TEXT_KEYS = {"parameters", "prompt", "workflow", "invokeai_metadata", "sd-metadata", "dream", "generation_data", "ai_metadata"}


def check_c2pa(data: bytes, mime: str, where: str) -> tuple[list[Finding], list[str]]:
    """Read a C2PA manifest store from the file, if there is one."""
    try:
        import c2pa
    except ImportError:
        return [], ["c2pa: library not installed, content credentials not checked"]
    try:
        with c2pa.Reader(mime, io.BytesIO(data)) as reader:
            store = json.loads(reader.json())
    except Exception as exc:  # the library signals "no manifest" with an exception too
        message = str(exc)
        if re.search(r"not\s*found|no\s+manifest|ManifestNotFound|JumbfNotFound", message, re.IGNORECASE):
            return [], []
        if b"c2pa" in data and b"jumb" in data:
            return [Finding(
                "C2PA_UNREADABLE", Severity.LOW, Category.METADATA,
                f"Content credentials present but unreadable ({where})",
                "The file contains C2PA data that could not be parsed. Inspect it with a C2PA viewer.",
                {"error": message[:300]},
            )], []
        return [], [f"c2pa ({where}): {message[:300]}"]
    return _interpret_c2pa(store, where), []


def _agent_name(agent: Any) -> str:
    if isinstance(agent, dict):
        return " ".join(str(agent.get(k, "")) for k in ("name", "version")).strip()
    return str(agent or "")


def _interpret_c2pa(store: dict[str, Any], where: str) -> list[Finding]:
    findings: list[Finding] = []
    manifests = store.get("manifests") or {}
    generators, ai_sources, edits = set(), [], []
    for label, manifest in manifests.items():
        generator = manifest.get("claim_generator") or ""
        infos = manifest.get("claim_generator_info") or []
        generator = generator or ", ".join(_agent_name(i) for i in infos)
        issuer = (manifest.get("signature_info") or {}).get("issuer") or ""
        generators.add(" / ".join(x for x in (generator, issuer) if x))
        for assertion in manifest.get("assertions") or []:
            if not str(assertion.get("label", "")).startswith("c2pa.actions"):
                continue
            for action in (assertion.get("data") or {}).get("actions") or []:
                name = action.get("action", "")
                agent = _agent_name(action.get("softwareAgent")) or generator
                source = action.get("digitalSourceType")
                mapped = digital_source_type(source) if source else None
                if mapped and mapped[1] >= Severity.HIGH:
                    ai_sources.append({"manifest": label, "action": name, "source_type": mapped[0], "meaning": mapped[2], "agent": agent, "issuer": issuer})
                elif name in _CONTENT_EDIT_ACTIONS:
                    edits.append({"manifest": label, "action": name, "agent": agent})

    failures = []
    for status in store.get("validation_status") or []:
        failures.append(status)
    for results in (store.get("validation_results") or {}).values():
        if isinstance(results, dict):
            failures.extend(results.get("failure") or [])
        elif isinstance(results, list):
            for r in results:
                failures.extend((r or {}).get("failure") or [])
    tamper = [f for f in failures if _TAMPER_CODE.search(str(f.get("code", "")))]

    for src in ai_sources:
        sev = digital_source_type(src["source_type"])[1]
        findings.append(Finding(
            "C2PA_AI_GENERATED", sev, Category.AI_GENERATION,
            f"Content credentials declare AI involvement ({where})",
            f"The signed C2PA manifest records this content as {src['meaning']} "
            f"(tool: {src['agent'] or 'unknown'}).",
            src,
        ))
    if tamper:
        findings.append(Finding(
            "C2PA_HASH_MISMATCH", Severity.HIGH, Category.TAMPERING,
            f"Content changed after its credentials were signed ({where})",
            "The C2PA manifest's content hash no longer matches the file, so the content was altered after signing.",
            {"failures": [{"code": f.get("code"), "explanation": f.get("explanation")} for f in tamper][:10]},
        ))
    if edits and not ai_sources:
        findings.append(Finding(
            "C2PA_EDITED", Severity.MEDIUM, Category.EDITING_SOFTWARE,
            f"Content credentials record edits ({where})",
            "The C2PA manifest records content-changing edits: "
            + "; ".join(sorted({f"{e['action']} by {e['agent'] or 'unknown'}" for e in edits})),
            {"edits": edits[:20]},
        ))
    if manifests and not findings:
        findings.append(Finding(
            "C2PA_PRESENT", Severity.INFO, Category.CONTEXT,
            f"Content credentials present ({where})",
            "C2PA manifest found with no AI or edit declarations. Issued by: " + "; ".join(sorted(g for g in generators if g)),
            {"generators": sorted(generators)},
        ))
    return findings


def check_source_types(values: list[str], where: str) -> list[Finding]:
    """IPTC DigitalSourceType values found in XMP."""
    findings = []
    for value in dict.fromkeys(values):
        mapped = digital_source_type(value)
        if not mapped:
            continue
        term, severity, meaning = mapped
        if severity >= Severity.HIGH:
            category, code = Category.AI_GENERATION, "IPTC_AI_SOURCE_TYPE"
        elif severity >= Severity.LOW:
            category, code = Category.EDITING_SOFTWARE, "IPTC_EDITED_SOURCE_TYPE"
        else:
            category, code = Category.CONTEXT, "IPTC_SOURCE_TYPE"
        findings.append(Finding(
            code, severity, category,
            f"Metadata declares the content as {meaning} ({where})",
            f"The IPTC DigitalSourceType field is '{term}'. Generators such as Google, Midjourney, "
            "Meta and Adobe Firefly write this field on AI output.",
            {"digital_source_type": value},
        ))
    return findings


def check_text_fields(fields: dict[str, str], where: str) -> list[Finding]:
    """PNG text chunks, EXIF comments and similar free-text fields."""
    findings = []
    for key, value in fields.items():
        if not isinstance(value, str) or not value.strip():
            continue
        k = key.strip().lower()
        ai_marker = None
        if k in _AI_TEXT_KEYS and (_SD_PARAMETERS.search(value) or "class_type" in value or '"nodes"' in value or k in {"invokeai_metadata", "sd-metadata", "dream"}):
            ai_marker = f"'{key}' field holds AI generation settings"
        elif _SD_PARAMETERS.search(value):
            ai_marker = f"'{key}' field holds Stable Diffusion prompt parameters"
        if ai_marker:
            findings.append(Finding(
                "AI_GENERATION_PARAMETERS", Severity.CRITICAL, Category.AI_GENERATION,
                f"AI generation settings embedded in the file ({where})",
                f"The {ai_marker}. Only AI image generators write these.",
                {"field": key, "excerpt": value[:300]},
            ))
            continue
        for tool in identify_tools(value) if k in {"software", "source", "creator", "creatortool", "comment", "description", "author"} else []:
            if tool.kind is ToolKind.AI_GENERATOR:
                findings.append(Finding(
                    "AI_GENERATOR_NAMED", IMAGE_TOOL_SEVERITY[tool.kind], Category.AI_GENERATION,
                    f"Metadata names an AI generator: {tool.name} ({where})",
                    f"The '{key}' field reads '{value[:120]}'.",
                    {"field": key, "value": value[:300], "tool": tool.name},
                ))
    return findings
