#!/usr/bin/env python3
"""Precompute the card-recognition index used by the native helper.

Reads the official card art in assets/cards/*.png (from RoyaleAPI/cr-api-assets)
plus the card metadata in assets/cards.json (from RoyaleAPI/cr-api-data), and
emits assets/card-index.json: one normalized grayscale feature vector per card,
alongside its elixir cost and type.

At runtime the helper crops each on-screen card slot, builds the same feature
vector, and picks the card with the highest normalized cross-correlation. This
is deterministic and runs in microseconds, unlike an LLM vision call.

Run this only when the card assets change:  python3 tools/build_card_index.py
"""

import json
import math
import os
from glob import glob

from PIL import Image

# Feature grid size. 24x24 keeps enough structure to separate ~200 cards while
# staying small enough that the helper can score every card on every frame.
N = 24

# The on-screen card slot shows only the inner art, cropped inside the card's
# border and above the elixir badge. Crop the reference art to the same region
# so the two feature vectors describe the same thing.
REF_CROP = (0.10, 0.067, 0.90, 0.678)  # left, top, right, bottom (fractions)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def feature_vector(img: Image.Image) -> list[float]:
    """Grayscale, downsample, then z-normalize.

    Z-normalization is what makes the match invariant to the overall brightness
    and contrast shift Clash Royale applies when a card is unaffordable and gets
    rendered desaturated.
    """
    gray = img.convert("L").resize((N, N), Image.BILINEAR)
    pixels = list(gray.getdata())
    mean = sum(pixels) / len(pixels)
    variance = sum((p - mean) ** 2 for p in pixels) / len(pixels)
    std = math.sqrt(variance) or 1.0
    return [round((p - mean) / std, 4) for p in pixels]


def main() -> None:
    meta_path = os.path.join(ROOT, "assets", "cards.json")
    with open(meta_path) as fh:
        meta = {c["key"]: c for c in json.load(fh)}

    entries = []
    missing_meta = []
    for path in sorted(glob(os.path.join(ROOT, "assets", "cards", "*.png"))):
        key = os.path.basename(path)[:-4]
        if key.startswith("_"):
            continue

        img = Image.open(path).convert("RGB")
        w, h = img.size
        box = (
            int(REF_CROP[0] * w),
            int(REF_CROP[1] * h),
            int(REF_CROP[2] * w),
            int(REF_CROP[3] * h),
        )

        info = meta.get(key)
        if info is None:
            # Evolutions, hero variants and skins have art but no metadata row.
            # Keep them out of the index: we can't reason about a card whose
            # elixir cost we don't know, and they'd only add false matches.
            missing_meta.append(key)
            continue

        entries.append(
            {
                "key": key,
                "name": info["name"],
                "elixir": info["elixir"],
                "type": info["type"],
                "rarity": info.get("rarity", ""),
                "vector": feature_vector(img.crop(box)),
            }
        )

    out_path = os.path.join(ROOT, "assets", "card-index.json")
    with open(out_path, "w") as fh:
        json.dump({"gridSize": N, "cards": entries}, fh)

    size_kb = os.path.getsize(out_path) / 1024
    print(f"indexed {len(entries)} cards -> assets/card-index.json ({size_kb:.0f} KB)")
    if missing_meta:
        print(f"skipped {len(missing_meta)} art files with no metadata row "
              f"(evolutions/heroes/skins): {', '.join(missing_meta[:6])}...")


if __name__ == "__main__":
    main()
