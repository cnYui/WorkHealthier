"""Generate the WorkHealthier pixel-art icon.

The art is a 32x32 grid drawn with a few primitives, then scaled with nearest
neighbour so every pixel stays a hard square.  Output goes to docs/icon/.

    python docs/tools/gen_icon.py
"""
from pathlib import Path

from PIL import Image

OUT = Path(__file__).resolve().parent.parent / "icon"
SIZE = 32

PALETTE = {
    ".": None,
    "K": (4, 12, 6, 255),        # background
    "S": (8, 26, 12, 255),       # screen / soft shadow
    "D": (15, 70, 30, 255),      # dark green
    "M": (31, 160, 58, 255),     # mid green
    "G": (64, 255, 94, 255),     # bright green (the app's accent)
    "W": (196, 255, 210, 255),   # glint
}

grid = [["." for _ in range(SIZE)] for _ in range(SIZE)]


def put(x, y, c):
    if 0 <= x < SIZE and 0 <= y < SIZE:
        grid[y][x] = c


def rect(x0, y0, x1, y1, c):
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            put(x, y, c)


def frame(x0, y0, x1, y1, c):
    for x in range(x0, x1 + 1):
        put(x, y0, c)
        put(x, y1, c)
    for y in range(y0, y1 + 1):
        put(x0, y, c)
        put(x1, y, c)


def disc(cx, cy, r, c):
    for y in range(SIZE):
        for x in range(SIZE):
            if (x - cx) ** 2 + (y - cy) ** 2 <= r * r:
                put(x, y, c)


# --- background: rounded square with a one-pixel border -------------------
rect(0, 0, 31, 31, "K")
frame(0, 0, 31, 31, "D")
for x, y in ((0, 0), (31, 0), (0, 31), (31, 31)):
    put(x, y, ".")
for x, y in ((1, 0), (0, 1), (30, 0), (31, 1), (0, 30), (1, 31), (31, 30), (30, 31)):
    put(x, y, "K")
for x, y in ((1, 1), (30, 1), (1, 30), (30, 30)):
    put(x, y, "D")

# --- posture plumb line: dashed vertical guide behind the person ----------
for y in range(4, 28):
    if y % 3 != 2:
        put(5, y, "D")

# --- person, side profile facing right, sitting upright -------------------
# head
disc(11, 9, 4.6, "G")
for y in range(6, 12):
    put(7, y, "M")
put(8, 5, "M")
put(8, 12, "M")
# glasses: dark frame bar with a lit lens, temple arm back to the ear
rect(11, 8, 16, 10, "K")
rect(12, 9, 15, 9, "W")
put(10, 9, "K")
put(9, 9, "K")
# nose and chin
put(16, 11, "G")
put(15, 13, "G")
# neck
rect(9, 14, 11, 16, "M")
# shoulders, straight back, lap
rect(8, 17, 13, 18, "G")
rect(8, 19, 12, 26, "M")
rect(12, 19, 12, 26, "G")
rect(8, 27, 16, 28, "G")
rect(8, 29, 9, 29, "M")
rect(15, 29, 16, 29, "M")

# --- monitor on the right --------------------------------------------------
frame(20, 5, 28, 15, "G")
rect(21, 6, 27, 14, "S")
for i, h in enumerate((2, 4, 3, 5)):
    rect(22 + i + i, 13 - h, 22 + i + i, 13, "M")
rect(23, 16, 25, 17, "M")
rect(21, 18, 27, 18, "G")

# --- distance arrow under the monitor ------------------------------------
rect(15, 23, 27, 23, "G")
put(14, 23, "G")
put(15, 22, "G")
put(15, 24, "G")
put(28, 23, "G")
put(27, 22, "G")
put(27, 24, "G")
for x in (18, 21, 24):
    put(x, 25, "M")

img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
for y in range(SIZE):
    for x in range(SIZE):
        c = PALETTE[grid[y][x]]
        if c:
            img.putpixel((x, y), c)

OUT.mkdir(parents=True, exist_ok=True)
img.save(OUT / "workhealthier-32.png")
for px in (64, 128, 256, 512):
    img.resize((px, px), Image.NEAREST).save(OUT / f"workhealthier-{px}.png")
print("wrote", sorted(p.name for p in OUT.glob("*.png")))
