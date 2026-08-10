"""Generate the Windows icon from the workbench logo without third-party packages."""
from __future__ import annotations

import argparse
import math
import struct
from pathlib import Path


SCALE = 4
SIZE = 256
N = SIZE * SCALE


def paint(canvas, x, y, color):
    if 0 <= x < N and 0 <= y < N:
        canvas[y * N + x] = color


def rounded_rect(canvas, left, top, right, bottom, radius, color):
    left, top, right, bottom, radius = [round(v * SCALE) for v in (left, top, right, bottom, radius)]
    for y in range(max(0, top), min(N, bottom + 1)):
        for x in range(max(0, left), min(N, right + 1)):
            cx = min(max(x, left + radius), right - radius)
            cy = min(max(y, top + radius), bottom - radius)
            if (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2:
                paint(canvas, x, y, color)


def polygon(canvas, points, color):
    points = [(round(x * SCALE), round(y * SCALE)) for x, y in points]
    min_x = max(0, min(x for x, _ in points))
    max_x = min(N - 1, max(x for x, _ in points))
    min_y = max(0, min(y for _, y in points))
    max_y = min(N - 1, max(y for _, y in points))
    for y in range(min_y, max_y + 1):
        for x in range(min_x, max_x + 1):
            inside = False
            j = len(points) - 1
            for i, (px, py) in enumerate(points):
                qx, qy = points[j]
                if ((py > y) != (qy > y)) and x < (qx - px) * (y - py) / (qy - py) + px:
                    inside = not inside
                j = i
            if inside:
                paint(canvas, x, y, color)


def circle(canvas, cx, cy, radius, color):
    cx, cy, radius = [round(v * SCALE) for v in (cx, cy, radius)]
    for y in range(max(0, cy - radius), min(N, cy + radius + 1)):
        for x in range(max(0, cx - radius), min(N, cx + radius + 1)):
            if (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2:
                paint(canvas, x, y, color)


def line(canvas, start, end, width, color):
    x1, y1 = [v * SCALE for v in start]
    x2, y2 = [v * SCALE for v in end]
    radius = width * SCALE / 2
    min_x, max_x = math.floor(min(x1, x2) - radius), math.ceil(max(x1, x2) + radius)
    min_y, max_y = math.floor(min(y1, y2) - radius), math.ceil(max(y1, y2) + radius)
    dx, dy = x2 - x1, y2 - y1
    length_sq = dx * dx + dy * dy or 1
    for y in range(max(0, min_y), min(N, max_y + 1)):
        for x in range(max(0, min_x), min(N, max_x + 1)):
            t = max(0, min(1, ((x - x1) * dx + (y - y1) * dy) / length_sq))
            px, py = x1 + t * dx, y1 + t * dy
            if (x - px) ** 2 + (y - py) ** 2 <= radius ** 2:
                paint(canvas, x, y, color)


def render():
    blue = (91, 106, 191, 255)
    indigo = (63, 76, 154, 255)
    white = (255, 255, 255, 255)
    paper = (244, 246, 255, 255)
    green = (52, 199, 89, 255)
    canvas = [(0, 0, 0, 0)] * (N * N)
    rounded_rect(canvas, 0, 0, 256, 256, 62, blue)
    polygon(canvas, [(63, 72), (86, 91), (128, 49), (170, 91), (193, 72), (185, 130), (71, 130)], white)
    polygon(canvas, [(71, 126), (185, 126), (178, 190), (78, 190)], paper)
    line(canvas, (91, 151), (133, 151), 10, (102, 116, 200, 255))
    line(canvas, (91, 170), (116, 170), 10, (102, 116, 200, 255))
    line(canvas, (146, 163), (156, 173), 11, green)
    line(canvas, (156, 173), (178, 149), 11, green)
    circle(canvas, 86, 72, 8, green)
    circle(canvas, 170, 72, 8, green)
    line(canvas, (78, 201), (178, 201), 10, indigo)
    return canvas


def downsample(canvas):
    result = []
    for y in range(SIZE):
        for x in range(SIZE):
            pixels = [canvas[(y * SCALE + sy) * N + x * SCALE + sx] for sy in range(SCALE) for sx in range(SCALE)]
            alpha = sum(p[3] for p in pixels) // len(pixels)
            if alpha == 0:
                result.append((0, 0, 0, 0))
            else:
                total = max(1, sum(p[3] for p in pixels))
                result.append(tuple(sum(p[i] * p[3] for p in pixels) // total for i in range(3)) + (alpha,))
    return result


def write_ico(path: Path):
    pixels = downsample(render())
    xor = bytearray()
    for y in range(SIZE - 1, -1, -1):
        for x in range(SIZE):
            r, g, b, a = pixels[y * SIZE + x]
            xor.extend((b, g, r, a))
    row_bytes = ((SIZE + 31) // 32) * 4
    and_mask = bytes(row_bytes * SIZE)
    dib = struct.pack('<IiiHHIIiiII', 40, SIZE, SIZE * 2, 1, 32, 0, len(xor), 0, 0, 0, 0) + xor + and_mask
    header = struct.pack('<HHH', 0, 1, 1)
    entry = struct.pack('<BBBBHHII', 0, 0, 0, 0, 1, 32, len(dib), 22)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(header + entry + dib)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', type=Path, required=True)
    write_ico(parser.parse_args().out)
