#!/usr/bin/env python3
"""Render the app icons without any image library.

Run from the repo root:  python3 scripts/make_icons.py
Produces icons/icon.svg and the PNG variants referenced by the manifest.
"""
import math
import os
import struct
import zlib

OUT = os.path.join(os.path.dirname(__file__), '..', 'icons')

BG_A = (0x6D, 0x5D, 0xFC)  # violet
BG_B = (0xFF, 0x6B, 0x9D)  # pink
BAR = (255, 255, 255)
BAR_HEIGHTS = [0.32, 0.58, 0.86, 1.0, 0.72, 0.5, 0.28]


def lerp(a, b, t):
    return a + (b - a) * t


def bg_color(u, v):
    t = min(1.0, max(0.0, (u + v) / 2))
    return tuple(int(round(lerp(BG_A[i], BG_B[i], t))) for i in range(3))


def rounded_rect_alpha(x, y, size, radius):
    """1 inside a rounded square of `size`, 0 outside (sharp; we supersample)."""
    cx = min(max(x, radius), size - radius)
    cy = min(max(y, radius), size - radius)
    return 1.0 if (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius else 0.0


def capsule_hit(px, py, cx, y0, y1, half_w):
    """Is the point inside a vertical capsule centred on x=cx from y0 to y1?"""
    qy = min(max(py, y0), y1)
    return (px - cx) ** 2 + (py - qy) ** 2 <= half_w * half_w


def render(size, rounded, content_scale=1.0, supersample=2):
    ss = supersample
    big = size * ss
    radius = big * 0.22 if rounded else 0.0
    # Bars layout, in the supersampled space.
    n = len(BAR_HEIGHTS)
    span = big * 0.60 * content_scale
    gap = span / (n - 1)
    half_w = gap * 0.30
    max_h = big * 0.50 * content_scale
    centre = big / 2
    bars = []
    for i, h in enumerate(BAR_HEIGHTS):
        cx = centre - span / 2 + i * gap
        bh = max_h * h
        bars.append((cx, centre - bh / 2, centre + bh / 2, half_w))

    rows = []
    for y in range(size):
        row = bytearray()
        for x in range(size):
            r = g = b = a = 0.0
            for sy in range(ss):
                for sx in range(ss):
                    px = x * ss + sx + 0.5
                    py = y * ss + sy + 0.5
                    alpha = rounded_rect_alpha(px, py, big, radius) if rounded else 1.0
                    if alpha <= 0:
                        continue
                    col = bg_color(px / big, py / big)
                    # Only the nearest bar by x can contain the sample.
                    idx = int(round((px - (centre - span / 2)) / gap))
                    if 0 <= idx < n:
                        cx, y0, y1, hw = bars[idx]
                        if capsule_hit(px, py, cx, y0, y1, hw):
                            col = BAR
                    r += col[0]
                    g += col[1]
                    b += col[2]
                    a += 255
            k = ss * ss
            if a > 0:
                # Un-premultiply so edge pixels keep the right colour.
                cov = a / (255 * k)
                row += bytes((int(r / a * 255), int(g / a * 255), int(b / a * 255), int(cov * 255)))
            else:
                row += b'\x00\x00\x00\x00'
        rows.append(bytes(row))
    return rows


def write_png(path, size, rows):
    def chunk(tag, data):
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)

    raw = b''.join(b'\x00' + row for row in rows)
    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(raw, 9))
    png += chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(png)


SVG = '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#6d5dfc"/>
      <stop offset="1" stop-color="#ff6b9d"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="112" fill="url(#g)"/>
  <g stroke="#fff" stroke-width="30" stroke-linecap="round">
    {bars}
  </g>
</svg>
'''


def write_svg(path):
    n = len(BAR_HEIGHTS)
    span = 512 * 0.60
    gap = span / (n - 1)
    max_h = 512 * 0.50
    lines = []
    for i, h in enumerate(BAR_HEIGHTS):
        cx = 256 - span / 2 + i * gap
        bh = max_h * h
        lines.append(f'<line x1="{cx:.1f}" y1="{256 - bh / 2:.1f}" x2="{cx:.1f}" y2="{256 + bh / 2:.1f}"/>')
    with open(path, 'w') as f:
        f.write(SVG.replace('{bars}', '\n    '.join(lines)))


def main():
    os.makedirs(OUT, exist_ok=True)
    write_svg(os.path.join(OUT, 'icon.svg'))
    jobs = [
        ('icon-192.png', 192, True, 1.0),
        ('icon-512.png', 512, True, 1.0),
        ('icon-512-maskable.png', 512, False, 0.8),
        ('apple-touch-icon.png', 180, False, 1.0),
    ]
    for name, size, rounded, scale in jobs:
        rows = render(size, rounded, scale)
        write_png(os.path.join(OUT, name), size, rows)
        print('wrote', name)


if __name__ == '__main__':
    main()
