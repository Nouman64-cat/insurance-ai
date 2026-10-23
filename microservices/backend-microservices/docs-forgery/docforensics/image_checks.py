"""Metadata checks for image files (JPEG, PNG, WebP, TIFF, HEIC).

Nothing here inspects pixel noise, so JPEG compression, scaling and phone
processing cannot trigger these checks. The one pixel comparison, against the
EXIF thumbnail, uses coarse correlation that compression does not move.
"""

from __future__ import annotations

import io
import struct
from datetime import datetime

import numpy as np
from PIL import Image

from . import xmp
from .knowledge import IMAGE_TOOL_SEVERITY, TOOL_KIND_DESCRIPTION, Severity, ToolKind, identify_tools
from .provenance import check_c2pa, check_source_types, check_text_fields
from .report import Category, Finding

Image.MAX_IMAGE_PIXELS = 200_000_000

_EXIF_SOFTWARE = 0x0131
_EXIF_DATETIME = 0x0132
_EXIF_MAKE = 0x010F
_EXIF_MODEL = 0x0110
_EXIF_DESCRIPTION = 0x010E
_EXIF_ARTIST = 0x013B
_EXIF_HOST = 0x013C
_EXIF_PROCESSING_SOFTWARE = 0x000B
_EXIF_IFD = 0x8769
_EXIF_DATETIME_ORIGINAL = 0x9003
_EXIF_USER_COMMENT = 0x9286
_EXIF_XP_COMMENT = 0x9C9C

_IJG_LUMA = np.array([
    16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55,
    14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
    18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92,
    49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
], dtype=float)

MIME_BY_FORMAT = {"JPEG": "image/jpeg", "PNG": "image/png", "WEBP": "image/webp", "TIFF": "image/tiff",
                  "GIF": "image/gif", "HEIC": "image/heic", "AVIF": "image/avif", "BMP": "image/bmp"}


def jpeg_segments(data: bytes) -> list[tuple[int, bytes]]:
    """(marker, payload) for every header segment before the image data."""
    if not data.startswith(b"\xff\xd8"):
        return []
    out, i = [], 2
    while i + 4 <= len(data):
        if data[i] != 0xFF:
            break
        marker = data[i + 1]
        if marker == 0xFF:
            i += 1
            continue
        if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
            i += 2
            continue
        if marker in (0xDA, 0xD9):
            break
        length = int.from_bytes(data[i + 2:i + 4], "big")
        if length < 2:
            break
        out.append((marker, data[i + 4:i + 2 + length]))
        i += 2 + length
    return out


def _tiff_thumbnail(tiff: bytes) -> bytes | None:
    """The JPEG thumbnail stored in IFD1 of an EXIF TIFF block."""
    if tiff[:2] == b"II":
        e = "<"
    elif tiff[:2] == b"MM":
        e = ">"
    else:
        return None
    try:
        ifd0 = struct.unpack(e + "I", tiff[4:8])[0]
        n0 = struct.unpack(e + "H", tiff[ifd0:ifd0 + 2])[0]
        ifd1 = struct.unpack(e + "I", tiff[ifd0 + 2 + 12 * n0:ifd0 + 6 + 12 * n0])[0]
        if not ifd1 or ifd1 + 2 > len(tiff):
            return None
        n1 = struct.unpack(e + "H", tiff[ifd1:ifd1 + 2])[0]
        offset = count = None
        for k in range(n1):
            entry = tiff[ifd1 + 2 + 12 * k:ifd1 + 14 + 12 * k]
            tag, typ = struct.unpack(e + "HH", entry[:4])
            value = struct.unpack(e + "H", entry[8:10])[0] if typ == 3 else struct.unpack(e + "I", entry[8:12])[0]
            if tag == 0x0201:
                offset = value
            elif tag == 0x0202:
                count = value
    except struct.error:
        return None
    if offset is None or not count or offset + count > len(tiff):
        return None
    thumb = tiff[offset:offset + count]
    return thumb if thumb.startswith(b"\xff\xd8") else None


def exif_thumbnail(data: bytes) -> bytes | None:
    for marker, payload in jpeg_segments(data):
        if marker == 0xE1 and payload.startswith(b"Exif\x00\x00"):
            return _tiff_thumbnail(payload[6:])
    return None


def _trim_borders(img: Image.Image) -> Image.Image:
    """Remove the black/white letterbox bars some cameras add to fixed-size thumbnails."""
    gray = np.asarray(img.convert("L"), dtype=float)
    content = (gray > 18) & (gray < 237)
    rows, cols = np.where(content.any(axis=1))[0], np.where(content.any(axis=0))[0]
    if rows.size == 0 or cols.size == 0:
        return img
    box = (int(cols[0]), int(rows[0]), int(cols[-1]) + 1, int(rows[-1]) + 1)
    if (box[2] - box[0]) * (box[3] - box[1]) < 0.5 * img.width * img.height:
        return img
    return img.crop(box)


def compare_thumbnail(main: Image.Image, thumb_bytes: bytes) -> dict | None:
    """Correlate the EXIF thumbnail with the main image. None when not comparable."""
    try:
        thumb = Image.open(io.BytesIO(thumb_bytes))
        thumb.load()
    except Exception:
        return None
    if min(thumb.size) < 24:
        return None
    thumb = _trim_borders(thumb)
    ar_thumb, ar_main = thumb.width / thumb.height, main.width / main.height
    if abs(ar_thumb - ar_main) / ar_main > 0.06:
        return {"comparable": False, "thumbnail_aspect": round(ar_thumb, 3), "image_aspect": round(ar_main, 3)}
    size = (48, 48)
    a = np.asarray(main.convert("L").resize(size, Image.Resampling.BOX), dtype=float).ravel()
    b = np.asarray(thumb.convert("L").resize(size, Image.Resampling.BOX), dtype=float).ravel()
    if a.std() < 2 or b.std() < 2:
        return None
    corr = float(np.corrcoef(a, b)[0, 1])
    return {"comparable": True, "correlation": round(corr, 3)}


def estimate_jpeg_quality(img: Image.Image) -> int | None:
    tables = getattr(img, "quantization", None)
    if not tables or 0 not in tables or len(tables[0]) != 64:
        return None
    # Pillow returns tables in zigzag order; the mean ratio is order-independent.
    scale = float(np.mean(np.asarray(tables[0], dtype=float) / _IJG_LUMA)) * 100
    quality = (200 - scale) / 2 if scale <= 100 else 5000 / scale
    return max(1, min(100, round(quality)))


def _decode_user_comment(raw) -> str:
    if isinstance(raw, str):
        return raw
    if not isinstance(raw, (bytes, bytearray)):
        return str(raw)
    head, body = bytes(raw[:8]), bytes(raw[8:])
    if head.startswith(b"UNICODE"):
        for enc in ("utf-16-be", "utf-16-le"):
            try:
                return body.decode(enc).strip("\x00 ")
            except UnicodeDecodeError:
                continue
    return body.decode("utf-8", "replace").strip("\x00 ")


def _parse_exif_dt(value) -> datetime | None:
    try:
        return datetime.strptime(str(value).strip()[:19], "%Y:%m:%d %H:%M:%S")
    except ValueError:
        return None


def tool_findings(fields: dict[str, str], where: str) -> list[Finding]:
    """Classify software named in metadata fields."""
    findings, seen = [], set()
    for field_name, value in fields.items():
        for tool in identify_tools(value):
            severity = IMAGE_TOOL_SEVERITY[tool.kind]
            if severity < Severity.LOW or tool.name in seen:
                continue
            seen.add(tool.name)
            category = Category.AI_GENERATION if tool.kind is ToolKind.AI_GENERATOR else Category.EDITING_SOFTWARE
            findings.append(Finding(
                "IMAGE_SOFTWARE_" + tool.kind.name, severity, category,
                f"Image was processed with {tool.name} ({where})",
                f"The {field_name} field reads '{value[:120]}', which is {TOOL_KIND_DESCRIPTION[tool.kind]}.",
                {"field": field_name, "value": value[:300], "tool": tool.name, "tool_kind": tool.kind.value},
            ))
    return findings


def check_image(data: bytes, where: str = "image", fmt_hint: str | None = None) -> tuple[list[Finding], list[str], bool]:
    """Run every image metadata check. Returns (findings, errors, parsed)."""
    findings: list[Finding] = []
    errors: list[str] = []
    software: dict[str, str] = {}
    text_fields: dict[str, str] = {}
    props: dict[str, object] = {}

    try:
        img = Image.open(io.BytesIO(data))
        fmt = img.format or fmt_hint or "unknown"
        props.update(format=fmt, width=img.width, height=img.height, mode=img.mode)
    except Exception as exc:
        img, fmt = None, fmt_hint or "unknown"
        errors.append(f"image decode ({where}): {exc}")

    # EXIF
    if img is not None:
        try:
            exif = img.getexif()
            for tag, label in ((_EXIF_SOFTWARE, "EXIF Software"), (_EXIF_PROCESSING_SOFTWARE, "EXIF ProcessingSoftware"),
                               (_EXIF_HOST, "EXIF HostComputer")):
                if exif.get(tag):
                    software[label] = str(exif[tag]).strip("\x00 ")
            for tag, label in ((_EXIF_DESCRIPTION, "description"), (_EXIF_ARTIST, "author")):
                if exif.get(tag):
                    text_fields[label] = str(exif[tag])
            make, model = exif.get(_EXIF_MAKE), exif.get(_EXIF_MODEL)
            if make or model:
                props["camera"] = " ".join(str(x).strip("\x00 ") for x in (make, model) if x)
            sub = exif.get_ifd(_EXIF_IFD)
            if sub.get(_EXIF_USER_COMMENT):
                text_fields["EXIF UserComment"] = _decode_user_comment(sub[_EXIF_USER_COMMENT])
            if exif.get(_EXIF_XP_COMMENT):
                raw = exif[_EXIF_XP_COMMENT]
                text_fields["EXIF XPComment"] = bytes(raw).decode("utf-16-le", "replace").strip("\x00") if isinstance(raw, (bytes, tuple)) else str(raw)
            modified, captured = _parse_exif_dt(exif.get(_EXIF_DATETIME)), _parse_exif_dt(sub.get(_EXIF_DATETIME_ORIGINAL))
            if modified and captured:
                gap = (modified - captured).total_seconds()
                if gap > 60:
                    findings.append(Finding(
                        "IMAGE_MODIFIED_AFTER_CAPTURE", Severity.MEDIUM, Category.METADATA,
                        f"Image was re-saved after it was taken ({where})",
                        f"Captured {captured:%Y-%m-%d %H:%M:%S}, last modified {modified:%Y-%m-%d %H:%M:%S} "
                        f"({_human_gap(gap)} later). Phones write identical times unless the photo is edited.",
                        {"captured": str(captured), "modified": str(modified)},
                    ))
                elif gap < -60:
                    findings.append(Finding(
                        "IMAGE_DATES_INCONSISTENT", Severity.LOW, Category.METADATA,
                        f"Image modification time precedes capture time ({where})",
                        "EXIF DateTime is earlier than DateTimeOriginal, which suggests the dates were rewritten.",
                        {"captured": str(captured), "modified": str(modified)},
                    ))
        except Exception as exc:
            errors.append(f"exif ({where}): {exc}")

    # PNG/WebP text chunks
    if img is not None:
        info_text = getattr(img, "text", None) or {}
        if not info_text:
            info_text = {k: v for k, v in img.info.items() if isinstance(v, str)}
        for key, value in info_text.items():
            if not isinstance(value, str):
                continue
            if key.lower() in {"software", "creator", "creatortool", "source"}:
                software[f"PNG {key}"] = value
            text_fields[key] = value

    # JPEG header segments
    segments = jpeg_segments(data)
    for marker, payload in segments:
        if marker == 0xEC and payload.startswith(b"Ducky"):
            findings.append(Finding(
                "PHOTOSHOP_SAVE_FOR_WEB", Severity.HIGH, Category.EDITING_SOFTWARE,
                f"Saved with Photoshop's 'Save for Web' ({where})",
                "The file has an APP12 'Ducky' segment, which only Adobe's Save for Web export writes.",
                {"segment": "APP12 Ducky"},
            ))
        elif marker == 0xED and payload.startswith(b"Photoshop 3.0") and b"8BIM" in payload:
            findings.append(Finding(
                "PHOTOSHOP_RESOURCES", Severity.MEDIUM, Category.EDITING_SOFTWARE,
                f"Photoshop resource block present ({where})",
                "The file has an APP13 'Photoshop 3.0' segment. Photoshop writes it on save; "
                "a few photo-management apps also use it for captions.",
                {"segment": "APP13 Photoshop 3.0"},
            ))
        elif marker == 0xFE and payload.strip():
            comment = payload.decode("utf-8", "replace").strip("\x00 ")
            software["JPEG comment"] = comment
            text_fields["comment"] = comment

    # XMP
    packets = xmp.parse_all(data)
    if packets:
        x = xmp.merge(packets)
        for key in ("xmp:CreatorTool", "pdf:Producer", "photoshop:History"):
            for i, value in enumerate(x.all(key)):
                software[f"XMP {key}" + (f"[{i}]" if i else "")] = value
        agents = [e.get("softwareAgent") for e in x.history if e.get("softwareAgent")]
        for i, agent in enumerate(dict.fromkeys(agents)):
            software[f"XMP history agent[{i}]"] = agent
        findings += check_source_types(x.all("Iptc4xmpExt:DigitalSourceType"), where)
        for key in ("dc:description", "exif:UserComment", "xmp:Label"):
            if x.first(key):
                text_fields[key] = x.first(key)
        ancestors = x.all("photoshop:DocumentAncestors")
        if ancestors:
            findings.append(Finding(
                "PHOTOSHOP_PASTED_CONTENT", Severity.MEDIUM, Category.TAMPERING,
                f"Content was pasted in from {len(ancestors)} other file(s) ({where})",
                "XMP photoshop:DocumentAncestors lists documents whose layers were pasted or placed into this image.",
                {"ancestor_ids": ancestors[:20]},
            ))
        if x.history:
            props["xmp_history"] = x.history[:20]

    findings += tool_findings(software, where)
    findings += check_text_fields(text_fields, where)

    # C2PA (only call the library when the file can contain a manifest)
    if b"c2pa" in data or b"jumb" in data:
        c2pa_findings, c2pa_errors = check_c2pa(data, MIME_BY_FORMAT.get(fmt.upper(), "image/jpeg"), where)
        findings += c2pa_findings
        errors += c2pa_errors

    # EXIF thumbnail
    if img is not None and fmt.upper() == "JPEG":
        props["jpeg_quality_estimate"] = estimate_jpeg_quality(img)
        thumb = exif_thumbnail(data)
        if thumb:
            try:
                img.draft("RGB", (img.width // 8 or 1, img.height // 8 or 1))
                result = compare_thumbnail(img, thumb)
            except Exception as exc:
                result = None
                errors.append(f"thumbnail ({where}): {exc}")
            if result and result["comparable"]:
                corr = result["correlation"]
                if corr < 0.5:
                    findings.append(Finding(
                        "THUMBNAIL_MISMATCH", Severity.HIGH, Category.TAMPERING,
                        f"Embedded thumbnail shows a different picture ({where})",
                        f"The EXIF preview thumbnail correlates only {corr:.2f} with the image. The editor "
                        "changed the image but kept the original capture's thumbnail.",
                        result,
                    ))
                elif corr < 0.85:
                    findings.append(Finding(
                        "THUMBNAIL_DIFFERS", Severity.MEDIUM, Category.TAMPERING,
                        f"Embedded thumbnail differs from the image ({where})",
                        f"The EXIF preview thumbnail correlates {corr:.2f} with the image, "
                        "below what re-compression alone produces (typically above 0.95).",
                        result,
                    ))
            elif result and not result["comparable"]:
                findings.append(Finding(
                    "THUMBNAIL_FRAMING_DIFFERS", Severity.LOW, Category.METADATA,
                    f"Image was cropped after the thumbnail was made ({where})",
                    "The EXIF thumbnail has a different aspect ratio from the image, so the image was "
                    "cropped or resized by a tool that kept the old thumbnail.",
                    result,
                ))

    findings.append(Finding(
        "IMAGE_PROPERTIES", Severity.INFO, Category.CONTEXT, f"Image properties ({where})",
        ", ".join(f"{k}: {v}" for k, v in props.items() if k != "xmp_history" and v is not None),
        {**props, "software_fields": software},
    ))
    return findings, errors, img is not None


def _human_gap(seconds: float) -> str:
    if seconds < 3600:
        return f"{seconds / 60:.0f} minutes"
    if seconds < 172800:
        return f"{seconds / 3600:.1f} hours"
    return f"{seconds / 86400:.0f} days"
