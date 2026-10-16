"""Make Coffer's placeholder icons: a strongbox glyph.

Tray icons: white on transparent, locked (lid shut, keyhole) and unlocked
(lid open), at 16, 20, 24 and 32 px (100 %, 125 %, 150 % and 200 % scale).
App icons: the locked glyph on a dark red tile (icon.ico, icon.png and the PNG
sizes tauri.conf.json lists). A designer may replace all of them.

Run: python src-tauri/icons/make_icons.py  (needs Pillow)
"""

import math
from pathlib import Path

from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent
SS = 16  # supersampling factor per grid unit
GRID = 16.0  # the glyph is drawn on a 16 x 16 grid
WHITE = (255, 255, 255, 255)
CLEAR = (0, 0, 0, 0)
TILE = (127, 29, 29, 255)  # dark red tile for the app icon


def rot(points, cx, cy, deg):
    a = math.radians(deg)
    c, s = math.cos(a), math.sin(a)
    return [(cx + (x - cx) * c - (y - cy) * s, cy + (x - cx) * s + (y - cy) * c) for x, y in points]


def glyph(unlocked: bool, px: int = 256) -> Image.Image:
    """The glyph as an RGBA mask (white on clear), px x px."""
    u = px / GRID
    big = Image.new("RGBA", (px, px), CLEAR)
    d = ImageDraw.Draw(big)

    def box(x0, y0, x1, y1, r, fill):
        d.rounded_rectangle([x0 * u, y0 * u, x1 * u, y1 * u], radius=r * u, fill=fill)

    # Body.
    body_top = 7.4
    box(1.3, body_top, 14.7, 14.6, 1.3, WHITE)
    # Keyhole cut into the body.
    cx, cy, r = 8.0, 10.1, 1.45
    d.ellipse([(cx - r) * u, (cy - r) * u, (cx + r) * u, (cy + r) * u], fill=CLEAR)
    d.polygon([((cx - 0.7) * u, cy * u), ((cx + 0.7) * u, cy * u), ((cx + 0.9) * u, 13.0 * u), ((cx - 0.9) * u, 13.0 * u)], fill=CLEAR)

    if not unlocked:
        # Lid shut, with a gap line above the body.
        box(1.3, 2.2, 14.7, 6.3, 1.3, WHITE)
        # Hasp: a short tab from the lid over the gap.
        box(6.6, 5.0, 9.4, 8.2, 0.6, WHITE)
        d.rectangle([6.6 * u, body_top * u, 9.4 * u, 8.2 * u], fill=WHITE)
    else:
        # Lid open: hinged at the back-left top of the body, tilted up.
        hinge_x, hinge_y = 1.6, 6.6
        lid = [(hinge_x, hinge_y - 3.0), (14.4, hinge_y - 3.0), (14.4, hinge_y), (hinge_x, hinge_y)]
        lid = rot(lid, hinge_x, hinge_y, -16)
        d.polygon([(x * u, y * u) for x, y in lid], fill=WHITE)
        # Hinge knuckle joining the lid to the body.
        d.ellipse([(hinge_x - 0.4) * u, (hinge_y - 0.2) * u, (hinge_x + 1.2) * u, (body_top + 0.8) * u], fill=WHITE)
    return big


def render(unlocked: bool, size: int) -> Image.Image:
    return glyph(unlocked, size * SS).resize((size, size), Image.LANCZOS)


def app_icon(size: int) -> Image.Image:
    big = size * 4
    tile = Image.new("RGBA", (big, big), CLEAR)
    ImageDraw.Draw(tile).rounded_rectangle([0, 0, big - 1, big - 1], radius=big * 0.22, fill=TILE)
    g = glyph(False, int(big * 0.64))
    off = (big - g.width) // 2
    tile.alpha_composite(g, (off, off))
    return tile.resize((size, size), Image.LANCZOS)


def main() -> None:
    tray = HERE / "tray"
    tray.mkdir(exist_ok=True)
    for size in (16, 20, 24, 32):
        render(False, size).save(tray / f"locked-{size}.png")
        render(True, size).save(tray / f"unlocked-{size}.png")

    app_icon(32).save(HERE / "32x32.png")
    app_icon(128).save(HERE / "128x128.png")
    app_icon(256).save(HERE / "128x128@2x.png")
    app_icon(512).save(HERE / "icon.png")
    ico_sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
    app_icon(256).save(HERE / "icon.ico", sizes=[(s, s) for s in ico_sizes])

    # Preview sheet (not committed): every tray icon at 8x, on a dark taskbar grey.
    sheet = Image.new("RGBA", (8 * (16 + 20 + 24 + 32 + 40), 8 * 70), (32, 32, 32, 255))
    x = 8
    for size in (16, 20, 24, 32):
        for row, unlocked in enumerate((False, True)):
            img = render(unlocked, size).resize((size * 8, size * 8), Image.NEAREST)
            sheet.alpha_composite(img, (x, 8 + row * 8 * 34))
        x += size * 8 + 8 * 8
    sheet.save(HERE / "tray" / "_preview.png")


if __name__ == "__main__":
    main()
