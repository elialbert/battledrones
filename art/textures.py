#!/usr/bin/env python3
"""Ship the biome rock materials the 3D terrain textures its rocks with.

The same painted rock materials art/terrain.py paints every map's outcrops
with (art/raw/tex-<biome>-rock.webp: granite with lichen, red sandstone with
layered strata, dark basalt with snow in its cracks, black obsidian) become
small tileable textures: the game projects them onto the cliff walls and the
crags standing on the outcrops, so the walls and crags are the same stone as
the painted tops.

    public/assets/textures/rock-<biome>.webp   512 x 512, seamless

Usage:  python3 art/textures.py      (also run at the end of art/terrain.py)

Needs Pillow and numpy only. Deterministic: same raws -> same output.

Per biome: the raw is made seamless the way art/terrain.py does it (blended
with itself rolled half-way round, along a noisy seam), its low-frequency
light is flattened out so the repeat doesn't show as a pattern of bright
and dark patches, and it's resampled to SIZE from a 3 x 3 tiling (so the
filter wraps and the result still tiles). WebP quality: the highest of
WEBP_QUALITY that fits BUDGET.
"""

from __future__ import annotations

import io
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "art" / "raw"
OUT = ROOT / "public" / "assets" / "textures"

BIOMES = ("temperate", "desert", "arctic", "volcanic")
SIZE = 512
WEBP_QUALITY = (88, 84, 80, 76, 72, 68, 64, 60)  # highest that fits the budget wins
BUDGET = 150 * 1024                                # bytes per texture
FLATTEN = 0.6                                      # 0 keeps the raw's light, 1 flattens it all


def sstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def lum(c: np.ndarray) -> np.ndarray:
    return c[..., 0] * 0.299 + c[..., 1] * 0.587 + c[..., 2] * 0.114


def blur_wrap(a: np.ndarray, sigma: float) -> np.ndarray:
    """Gaussian blur of a 2D field that wraps round its edges (exact, via the FFT)."""
    f0 = np.fft.fftfreq(a.shape[0])[:, None]
    f1 = np.fft.rfftfreq(a.shape[1])[None, :]
    g = np.exp(-2.0 * (np.pi * sigma) ** 2 * (f0 * f0 + f1 * f1))
    return np.fft.irfft2(np.fft.rfft2(a) * g, s=a.shape).astype(np.float32)


def periodic_noise(N: int, sigma: float, rng) -> np.ndarray:
    g = blur_wrap(rng.standard_normal((N, N)).astype(np.float32), sigma)
    return g / (g.std() + 1e-6)


def vp_blend(A, B, w, m):
    """Variance-preserving blend (keeps contrast inside the transition)."""
    w = w[..., None]
    return m + ((A - m) * w + (B - m) * (1.0 - w)) / np.sqrt(w * w + (1.0 - w) ** 2)


def make_seamless(a: np.ndarray, rng) -> np.ndarray:
    """Blend with itself rolled half-way round: its old edges meet in the middle along a noisy seam."""
    N = a.shape[0]
    m = a.mean((0, 1))
    idx = np.arange(N, dtype=np.float32)
    d = np.minimum(idx, N - idx) / (N / 2.0)
    for axis in (1, 0):
        nz = np.clip(periodic_noise(N, N / 24, rng), -1.5, 1.5)
        f = (d[None, :] if axis == 1 else d[:, None]) + 0.17 * nz
        w = sstep(0.44, 0.56, f)
        a = vp_blend(a, np.roll(a, N // 2, axis=axis), w, m)
    return np.clip(a, 0.0, 1.0)


def flatten(a: np.ndarray, strength: float) -> np.ndarray:
    """Remove low-frequency light so the repeat is less obvious."""
    L = lum(a)
    low = blur_wrap(L, a.shape[0] / 12)
    ratio = (L.mean() / np.maximum(low, 1e-3)) ** strength
    return np.clip(a * ratio[..., None], 0.0, 1.0)


def rock_texture(biome: str) -> Image.Image:
    src = np.asarray(Image.open(RAW / f"tex-{biome}-rock.webp").convert("RGB"), np.float32) / 255.0
    rng = np.random.default_rng([ord(c) for c in biome + "rock"])
    a = flatten(make_seamless(src, rng), FLATTEN)
    big = Image.fromarray((np.tile(a, (3, 3, 1)) * 255 + 0.5).astype(np.uint8), "RGB")
    big = big.resize((3 * SIZE, 3 * SIZE), Image.LANCZOS)
    return big.crop((SIZE, SIZE, 2 * SIZE, 2 * SIZE))


def write_rock_textures() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for biome in BIOMES:
        im = rock_texture(biome)
        for q in WEBP_QUALITY:
            b = io.BytesIO()
            im.save(b, "WEBP", quality=q, method=6)
            if b.tell() <= BUDGET:
                break
        (OUT / f"rock-{biome}.webp").write_bytes(b.getvalue())
        print(f"rock-{biome}: {SIZE}x{SIZE}, {b.tell() / 1024:.0f} KB at q{q}")


if __name__ == "__main__":
    write_rock_textures()
