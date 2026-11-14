"""Builds the static data files in ../data.

  land.bin    1440x720 land mask, 0.25 degree cells, 1 bit per cell, row 0 = 90N, col 0 = 180W
  coast.json  coastline polylines as flat [lon, lat, ...] arrays in 0.05 degree integer units
  wnp.json    western North Pacific best tracks (compacted from an IBTrACS extract)

Usage: python3 build_data.py <world-atlas land-50m.json> [ibtracs_wp.json]
Land source: Natural Earth 1:50m via the world-atlas npm package (public domain).
"""
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "data"
W, H = 1440, 720


def decode_arcs(topo):
    sx, sy = topo["transform"]["scale"]
    tx, ty = topo["transform"]["translate"]
    arcs = []
    for arc in topo["arcs"]:
        x = y = 0
        pts = []
        for dx, dy in arc:
            x += dx
            y += dy
            pts.append((x * sx + tx, y * sy + ty))
        arcs.append(pts)
    return arcs


def ring_points(ring, arcs):
    pts = []
    for index in ring:
        arc = arcs[index] if index >= 0 else arcs[~index][::-1]
        pts.extend(arc[1:] if pts else arc)
    return pts


def polygons(topo, arcs):
    geom = topo["objects"]["land"]
    geoms = geom["geometries"] if geom["type"] == "GeometryCollection" else [geom]
    for g in geoms:
        polys = g["arcs"] if g["type"] == "MultiPolygon" else [g["arcs"]]
        for poly in polys:
            yield [ring_points(ring, arcs) for ring in poly]


def build_land(path):
    topo = json.loads(Path(path).read_text())
    arcs = decode_arcs(topo)
    scale = 4  # supersample, then threshold at half coverage
    img = Image.new("L", (W * scale, H * scale), 0)
    draw = ImageDraw.Draw(img)
    to_px = lambda p: ((p[0] + 180) / 360 * W * scale, (90 - p[1]) / 180 * H * scale)
    coast = []
    for rings in polygons(topo, arcs):
        for i, ring in enumerate(rings):
            draw.polygon([to_px(p) for p in ring], fill=255 if i == 0 else 0)
            line = []
            for lon, lat in ring:
                q = (round(lon * 20), round(lat * 20))
                if not line or line[-1] != q:
                    line.append(q)
            # Skip specks and the seam Natural Earth draws along the antimeridian and the poles.
            if len(line) >= 8:
                flat = []
                for (a, b) in line:
                    flat += [a, b]
                coast.append(flat)
    small = img.resize((W, H), Image.BOX)
    bits = bytearray(W * H // 8)
    px = small.load()
    land = 0
    for y in range(H):
        for x in range(W):
            if px[x, y] >= 128:
                bits[(y * W + x) >> 3] |= 1 << ((y * W + x) & 7)
                land += 1
    (OUT / "land.bin").write_bytes(bits)
    (OUT / "coast.json").write_text(json.dumps(coast, separators=(",", ":")))
    print(f"land.bin: {len(bits)} bytes, {land / (W * H):.1%} land cells; coast.json: {len(coast)} lines")


def build_tracks(path):
    src = json.loads(Path(path).read_text())
    storms = []
    for s in src["storms"]:
        if not s.get("peak") or s["peak"] < 17.2:
            continue
        pts = [[p[0], round(p[1], 1), round(p[2], 1), p[3], p[4]] for p in s["pts"] if p[3] is not None]
        if len(pts) < 4:
            continue
        storms.append({"id": s["sid"], "name": s["name"], "year": s["season"], "start": s["start"],
                       "peak": s["peak"], "pmin": s["pmin"], "pts": pts})
    out = {"source": src["source"], "fields": ["hour", "lon", "lat", "wind_ms", "pressure_hpa"], "storms": storms}
    (OUT / "wnp.json").write_text(json.dumps(out, separators=(",", ":"), ensure_ascii=False))
    print(f"wnp.json: {len(storms)} storms")


if __name__ == "__main__":
    build_land(sys.argv[1])
    if len(sys.argv) > 2:
        build_tracks(sys.argv[2])
