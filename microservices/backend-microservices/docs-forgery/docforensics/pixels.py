"""Pixel evidence in raster pages: a region copied and pasted inside the same image.

A scanner or camera never records the same thing twice. Two printed copies of
the digit 8 differ in sensor noise and in how they fall on the pixel grid. An
editor's copy and paste repeats them pixel for pixel. So when a textured part
of a scan appears twice, exactly, at two different places, it was pasted.

What the check needs, and what it leaves alone:

- Lossless pixels: PNG, TIFF, BMP and lossless WebP files, and Flate or LZW
  images inside a PDF. A JPEG save erases the exact repeat of a paste and
  creates exact repeats of similar blocks, so JPEG pixels are not judged.
- Noise. In a screenshot or a rendered page every repeated glyph is
  identical, so a large share of the image repeats itself and the image is
  not judged. In a near black-and-white scan some glyphs repeat by chance; a
  region is reported only if it clearly outweighs those chance matches.
- Texture in both directions. A ruled line or a straight border is the same
  at every shift along it, so a patch must vary vertically and horizontally,
  and must hold mid-tones: saturated black-and-white pixels carry no noise.

Which of the two places is the copy cannot be told from the pixels, so both
are reported.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from PIL import Image

from .report import Category, Finding, Severity

PATCH = 7  # patch side in pixels: about a third of a digit at 200 dpi
MIN_CONTRAST = 18  # grey-level spread a patch needs (ink against paper), and the step it needs in each direction
MIN_MIDTONES = 4  # pixels per patch that are neither saturated black nor white
MIN_SHIFT = 8  # matches closer than this overlap themselves
MAX_REPEATS = 6  # a patch seen more often than this is texture or a pattern, not a paste
MIN_REGION = 24  # matched patch positions forming one solid region (chosen on the Find it again! train split)
DOMINANCE = 2.0  # the region must be this many times larger than the image's largest chance match
MIN_CLUSTER = 4  # shifts with fewer matches are ignored entirely
MAX_REPEATED = 0.25  # share of textured patches with an exact twin above which the image repeats itself by nature
# (measured: real scans reach 12%, near black-and-white ones included; a rendered page of text about 50%)
MAX_PIXELS = 50_000_000  # larger images are not judged (about A4 at 850 dpi)
MAX_CANDIDATES = 4_000_000
MAX_PAIRS = 400_000
MAX_SHIFTS = 5_000
STRIP = 1024  # rows per pass, so memory stays bounded on large scans
LOSSLESS_TIFF = {"raw", "tiff_lzw", "tiff_adobe_deflate", "tiff_deflate", "packbits"}


@dataclass
class CopiedRegion:
    first: tuple[int, int, int, int]  # x0, y0, x1, y1 in pixels
    second: tuple[int, int, int, int]
    shift: tuple[int, int]  # dx, dy from first to second
    matched: int  # patch positions that match exactly

    def to_dict(self) -> dict:
        return {"first": list(self.first), "second": list(self.second), "shift": list(self.shift), "matched": self.matched}


class NotJudged(Exception):
    """The image cannot support the check (too large, or too repetitive to tell a paste from chance)."""


def gray(img: Image.Image) -> np.ndarray:
    """8-bit grey levels; transparency is flattened onto white, 16-bit samples are scaled down."""
    if img.mode in ("I;16", "I;16B", "I;16L", "I"):
        a = np.asarray(img, dtype=np.float64)
        top = 65535.0 if img.mode.startswith("I;16") or a.max() > 255 else 255.0
        return np.clip(np.round(a * 255.0 / top), 0, 255).astype(np.uint8)
    if img.mode in ("RGBA", "LA", "PA") or (img.mode == "P" and "transparency" in img.info):
        rgba = img.convert("RGBA")
        img = Image.alpha_composite(Image.new("RGBA", rgba.size, (255, 255, 255, 255)), rgba)
    return np.asarray(img.convert("L"), dtype=np.uint8)


def _box(a: np.ndarray, k: int) -> np.ndarray:
    """Sum over every k x k window (valid positions)."""
    t = np.zeros((a.shape[0] + 1, a.shape[1] + 1), dtype=np.int64)
    t[1:, 1:] = a.cumsum(0, dtype=np.int64).cumsum(1)
    return t[k:, k:] - t[:-k, k:] - t[k:, :-k] + t[:-k, :-k]


def _window_max(a: np.ndarray, kh: int, kw: int) -> np.ndarray:
    """Maximum over every kh x kw window (valid positions), separably."""
    r = a[: a.shape[0] - kh + 1].copy()
    for i in range(1, kh):
        np.maximum(r, a[i: i + r.shape[0]], out=r)
    c = r[:, : r.shape[1] - kw + 1].copy()
    for j in range(1, kw):
        np.maximum(c, r[:, j: j + c.shape[1]], out=c)
    return c


def _candidates(g: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Top-left corners (flat indices into the patch grid) and contents of the patches worth matching."""
    k = PATCH
    h, w = g.shape[0] - k + 1, g.shape[1] - k + 1
    windows = np.lib.stride_tricks.sliding_window_view(g, (k, k))
    positions, keys = [], []
    for r0 in range(0, h, STRIP):
        r1 = min(h, r0 + STRIP)
        s = g[r0: r1 + k - 1]
        si = s.astype(np.int16)
        total, squares = _box(si, k), _box(si.astype(np.int64) ** 2, k)
        spread = squares * k * k - total * total >= (MIN_CONTRAST * k * k) ** 2  # variance >= MIN_CONTRAST**2
        vertical = _window_max(np.abs(np.diff(si, axis=0)), k - 1, k) >= MIN_CONTRAST
        horizontal = _window_max(np.abs(np.diff(si, axis=1)), k, k - 1) >= MIN_CONTRAST
        midtones = _box(((s > 24) & (s < 232)).astype(np.int16), k) >= MIN_MIDTONES
        ys, xs = np.nonzero(spread & vertical & horizontal & midtones)
        ys = ys + r0
        positions.append(ys.astype(np.int64) * w + xs)
        keys.append(windows[ys, xs].reshape(len(ys), k * k))
        if sum(len(p) for p in positions) > MAX_CANDIDATES:
            raise NotJudged("too much texture to compare every patch")
    return np.concatenate(positions), np.concatenate(keys)


def _pairs(positions: np.ndarray, keys: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """(first, second) flat positions of every pair of identical patches."""
    void = np.ascontiguousarray(keys).view(np.dtype((np.void, keys.shape[1]))).ravel()
    order = np.argsort(void, kind="stable")
    same = void[order][1:] == void[order][:-1]
    edges = np.diff(np.concatenate([[0], same.astype(np.int8), [0]]))
    starts, ends = np.nonzero(edges == 1)[0], np.nonzero(edges == -1)[0] + 1  # each run of equal patches
    sizes = ends - starts
    keep = sizes <= MAX_REPEATS
    starts, sizes = starts[keep], sizes[keep]
    firsts, seconds = [], []
    for i in range(MAX_REPEATS):
        for j in range(i + 1, MAX_REPEATS):
            run = starts[sizes > j]
            firsts.append(positions[order[run + i]])
            seconds.append(positions[order[run + j]])
    first, second = np.concatenate(firsts), np.concatenate(seconds)
    if len(first) > MAX_PAIRS:
        raise NotJudged("too many repeated patches to tell a paste from chance")
    return first, second


def _largest_component(points: set[tuple[int, int]]) -> list[tuple[int, int]]:
    best: list[tuple[int, int]] = []
    seen: set[tuple[int, int]] = set()
    for start in points:
        if start in seen:
            continue
        seen.add(start)
        stack, component = [start], []
        while stack:
            y, x = stack.pop()
            component.append((y, x))
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    q = (y + dy, x + dx)
                    if q in points and q not in seen:
                        seen.add(q)
                        stack.append(q)
        if len(component) > len(best):
            best = component
    return best


def copied_regions(g: np.ndarray) -> list[CopiedRegion]:
    """Regions of ``g`` that appear twice, pixel for pixel. Raises ``NotJudged`` when the image cannot tell."""
    if g.size > MAX_PIXELS:
        raise NotJudged(f"image too large to compare ({g.size / 1e6:.0f} megapixels)")
    if min(g.shape) < 4 * PATCH:
        return []
    w = g.shape[1] - PATCH + 1
    positions, keys = _candidates(g)
    if len(positions) < 2:
        return []
    first, second = _pairs(positions, keys)
    y1, x1, y2, x2 = first // w, first % w, second // w, second % w
    dy, dx = y2 - y1, x2 - x1
    flip = (dy < 0) | ((dy == 0) & (dx < 0))  # one direction per shift; keep the upper (or left) place as "first"
    y1, x1, dy, dx = np.where(flip, y2, y1), np.where(flip, x2, x1), np.where(flip, -dy, dy), np.where(flip, -dx, dx)
    far = (np.abs(dy) >= MIN_SHIFT) | (np.abs(dx) >= MIN_SHIFT)
    if not far.any():
        return []
    repeated = np.unique(np.concatenate([first[far], second[far]])).size / len(positions)
    if repeated > MAX_REPEATED:
        raise NotJudged(f"{repeated:.0%} of its textured patches repeat exactly, as in a rendered page or a screenshot, "
                        "where every copy of a character is identical; a pasted region cannot stand out from that")
    y1, x1, dy, dx = y1[far], x1[far], dy[far], dx[far]
    shift_key = dy * (2 * g.shape[1] + 1) + (dx + g.shape[1])
    shifts, inverse, counts = np.unique(shift_key, return_inverse=True, return_counts=True)
    busy = np.nonzero(counts >= MIN_CLUSTER)[0]
    if len(busy) > MAX_SHIFTS:
        raise NotJudged("too many repeated patterns to tell a paste from chance")
    by_shift = np.argsort(inverse, kind="stable")
    ends = np.cumsum(counts)
    found = []
    for s in busy:
        members = by_shift[ends[s] - counts[s]: ends[s]]
        component = np.array(_largest_component(set(zip(y1[members].tolist(), x1[members].tolist()))))
        found.append((len(component), int(dy[members[0]]), int(dx[members[0]]), component))
    chance = max((n for n, *_ in found if n < MIN_REGION), default=0)
    out = []
    for n, sy, sx, component in sorted(found, key=lambda f: -f[0]):
        if n < MIN_REGION or n < DOMINANCE * chance:
            continue
        top, left = int(component[:, 0].min()), int(component[:, 1].min())
        bottom, right = int(component[:, 0].max()) + PATCH, int(component[:, 1].max()) + PATCH
        out.append(CopiedRegion((left, top, right, bottom), (left + sx, top + sy, right + sx, bottom + sy), (sx, sy), n))
    return out


def is_lossless(img: Image.Image, data: bytes = b"") -> bool:
    fmt = (img.format or "").upper()
    if fmt in ("PNG", "BMP"):
        return True
    if fmt == "TIFF":
        return img.info.get("compression", "raw") in LOSSLESS_TIFF
    if fmt == "WEBP":
        return b"VP8L" in data[:4096] and b"VP8 " not in data[:4096]
    return False


def check_copy_move(img: Image.Image, where: str) -> tuple[list[Finding], list[str]]:
    """Report regions pasted inside ``img`` (whose pixels must be lossless)."""
    try:
        regions = copied_regions(gray(img))
    except NotJudged as exc:
        return [Finding("COPY_MOVE_NOT_CHECKED", Severity.INFO, Category.CONTEXT,
                        f"Copied regions were not checked ({where})", f"Not checked: {exc}.", {"reason": str(exc)})], []
    except MemoryError:
        return [], [f"copy-move ({where}): not enough memory"]
    if not regions:
        return [], []
    return [Finding(
        "REGION_COPIED", Severity.HIGH, Category.TAMPERING,
        f"Part of the image appears twice, pixel for pixel ({where})",
        f"{len(regions)} region(s) of the image are exact copies of another place in it. A scanner or camera never "
        "records the same thing twice: even two prints of the same digit differ in noise. An editor's copy and "
        "paste does, which is how a digit or an amount is changed by copying one from elsewhere on the page. "
        "Which of the two places is the pasted one cannot be told from the pixels.",
        {"regions": [r.to_dict() for r in regions[:10]], "image_size": [img.width, img.height],
         "method": f"exact {PATCH}x{PATCH} patch matches forming one solid region"},
    )], []
