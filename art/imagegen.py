"""Thin wrapper over the OpenAI Images API for the Battle Drones art pipeline.

Uses the newest GPT Image model available (gpt-image-2.5-sunburst, released
2026-09-08 — "our most capable model for image generation and editing"),
which supports native transparent backgrounds, so sprites need no chroma-key
step. Reads OPENAI_API_KEY from the environment.
"""

from __future__ import annotations

import base64
import io
import random
import time
from pathlib import Path

from openai import APIError, OpenAI, RateLimitError
from PIL import Image

MODEL = "gpt-image-2.5-sunburst"

_client: OpenAI | None = None


def client() -> OpenAI:
    global _client
    if _client is None:
        _client = OpenAI(max_retries=0, timeout=300)
    return _client


def generate(
    prompt: str,
    *,
    size: str = "1024x1024",
    quality: str = "high",
    transparent: bool = True,
    images: list[Path] | None = None,
    attempts: int = 5,
) -> Image.Image:
    """Generate (or, with reference `images`, edit) one image; returns RGBA."""
    kw: dict = dict(
        model=MODEL,
        prompt=prompt,
        size=size,
        quality=quality,
        output_format="png",
        background="transparent" if transparent else "opaque",
    )
    delay = 4.0
    for attempt in range(1, attempts + 1):
        try:
            if images:
                handles = [open(p, "rb") for p in images]
                try:
                    r = client().images.edit(image=handles, **kw)
                finally:
                    for h in handles:
                        h.close()
            else:
                r = client().images.generate(**kw)
            data = base64.b64decode(r.data[0].b64_json)
            return Image.open(io.BytesIO(data)).convert("RGBA")
        except (RateLimitError, APIError) as e:  # transient: back off and retry
            status = getattr(e, "status_code", None)
            if status is not None and 400 <= status < 500 and status != 429:
                raise
            if attempt == attempts:
                raise
            wait = delay + random.random() * 2
            print(f"  retry {attempt}/{attempts - 1} in {wait:.0f}s: {e}")
            time.sleep(wait)
            delay = min(delay * 2, 60)
    raise RuntimeError("unreachable")
