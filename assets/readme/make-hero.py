#!/usr/bin/env python3
"""Rebuild the metadata-free README hero and social preview with Pillow."""

from pathlib import Path
from PIL import Image, ImageDraw, ImageFont


def font(size):
    candidates = (
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "DejaVuSans.ttf",
    )
    for candidate in candidates:
        try:
            return ImageFont.truetype(candidate, size)
        except OSError:
            continue
    raise RuntimeError("Install Arial or DejaVu Sans to reproduce the hero")


def main():
    directory = Path(__file__).resolve().parent
    hero = Image.new("RGB", (1600, 800), "#0b1424")
    draw = ImageDraw.Draw(hero)
    draw.text((100, 112), "errmeter", font=font(108), fill="#edf3fc")
    draw.text((106, 258), "A shout that is never lost.", font=font(42), fill="#b7c8df")
    centers = (245, 615, 985, 1355)
    draw.line((centers[0], 530, centers[-1], 530), fill="#4e6e96", width=5)
    for x in (430, 800, 1170):
        draw.polygon(((x + 13, 530), (x - 8, 519), (x - 8, 541)), fill="#89a9d1")
    for x, label in zip(centers, ("emit", "spool", "sink", "watch")):
        draw.rounded_rectangle((x - 115, 443, x + 115, 617), radius=26,
                               fill="#14243a", outline="#55759a", width=3)
        draw.ellipse((x - 9, 474, x + 9, 492), fill="#ffbf68")
        draw.text((x, 532), label, font=font(38), anchor="mm", fill="#edf3fc")
    hero.save(directory / "hero.png", format="PNG")
    preview = hero.resize((1280, 640), Image.Resampling.LANCZOS)
    preview.save(directory / "social-preview.jpg", format="JPEG", quality=94)
    for filename, expected in (("hero.png", (1600, 800)),
                               ("social-preview.jpg", (1280, 640))):
        with Image.open(directory / filename) as image:
            assert image.size == expected
            assert not image.getexif()
            assert not any(key.lower() in ("text", "comment", "software", "exif")
                           for key in image.info)
            assert not getattr(image, "text", {})
            print("%s: %s; metadata=%s; EXIF=0" %
                  (filename, image.size, sorted(image.info)))


if __name__ == "__main__":
    main()
