import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { makeLand, makeEnv, sstAt, mpiOf } from "../js/env.js";
import { simulateStorm, simulateSeason, seasonStats, basinOf, classify, pressureOf } from "../js/sim.js";

const land = makeLand(new Uint8Array(fs.readFileSync(new URL("../data/land.bin", import.meta.url))));
const run = (lat, lon, month, extra = {}) => simulateStorm({ lat, lon, month, land, ...extra });

test("land mask knows continents from oceans", () => {
  assert.equal(land.isLand(35, 105), 1); // China
  assert.equal(land.isLand(-25, 135), 1); // Australia
  assert.equal(land.isLand(15, 140), 0); // Philippine Sea
  assert.equal(land.isLand(25, -90), 0); // Gulf of Mexico
});

test("basins", () => {
  assert.equal(basinOf(15, 140), "WNP");
  assert.equal(basinOf(15, -110), "ENP");
  assert.equal(basinOf(25, -90), "NATL");
  assert.equal(basinOf(12, -80), "NATL"); // Caribbean, east of Central America
  assert.equal(basinOf(15, 88), "NIO");
  assert.equal(basinOf(-15, 60), "SWIO");
  assert.equal(basinOf(-15, 120), "AUS");
  assert.equal(basinOf(-15, -170), "SPAC");
  assert.equal(basinOf(-15, -25), "SATL");
});

test("each basin uses its own intensity scale", () => {
  assert.equal(classify(55, "WNP").name, "超强台风");
  assert.equal(classify(55, "NATL").name, "三级飓风");
  assert.equal(classify(72, "NATL").name, "五级飓风");
  assert.equal(classify(20, "NIO").name, "气旋风暴");
  assert.equal(classify(60, "AUS").name, "五级强烈热带气旋");
  assert.equal(classify(10, "WNP").name, "热带低压");
});

test("pressure falls as wind rises", () => {
  assert.ok(pressureOf(17) > pressureOf(33));
  assert.ok(pressureOf(33) > pressureOf(60));
  assert.ok(pressureOf(60) < 930 && pressureOf(60) > 880);
});

test("ocean climate: warm pool, cold tongues, seasons", () => {
  assert.ok(sstAt(15, 140, 8.5) > 28.5);
  assert.ok(sstAt(-15, -25, 3) < 27, "South Atlantic stays cool");
  assert.ok(sstAt(-15, -90, 3) < 24, "Humboldt current");
  assert.ok(sstAt(30, 135, 8.5) - sstAt(30, 135, 2.5) > 5, "mid-latitude seasonal swing");
  assert.ok(sstAt(0, -130, 6, { enso: 1.5, sst: 0, high: 0, west: 0 }) - sstAt(0, -130, 6) > 1.5, "El Nino warms the east Pacific");
  assert.ok(mpiOf(30) > 70 && mpiOf(24) < 10);
});

test("steering: easterly trades, westerlies poleward, in both hemispheres", () => {
  const env = makeEnv(8.5, undefined, land);
  assert.ok(env.sample("u", 15, 140) < -2);
  assert.ok(env.sample("u", 42, 160) > 5);
  assert.ok(env.sample("u", -15, 70) < -2);
  assert.ok(env.sample("u", -42, 70) > 5);
});

test("a west Pacific August storm becomes a typhoon and hits Asia", () => {
  const storm = run(14, 142, 8.5);
  assert.ok(storm.peak > 40, `peak ${storm.peak}`);
  const landfall = storm.events.find((e) => e.type === "landfall");
  assert.ok(landfall && landfall.lon > 100 && landfall.lon < 128, "landfall on the Asian coast");
  assert.ok(storm.points[48].lon < 142, "moves west");
});

test("southern storms drift poleward too (southward)", () => {
  const storm = run(-13, 72, 2.2);
  assert.ok(storm.peak > 33);
  assert.ok(storm.points[96].lat < -14);
});

test("no storms on the equator or in the South Atlantic", () => {
  assert.equal(run(1, 150, 8.5).named, false);
  assert.equal(run(-15, -25, 3.2).named, false);
});

test("the same storm is weak out of season", () => {
  assert.ok(run(14, 142, 8.5).peak > run(14, 142, 2.5).peak + 15);
});

test("land kills storms", () => {
  const storm = run(22, 118, 8.5);
  const hit = storm.events.find((e) => e.type === "landfall") || { hour: 0 };
  const after = storm.points[Math.min(storm.points.length - 1, hit.hour + 30)];
  assert.ok(after.v < storm.peak * 0.6);
});

test("noisy storms are reproducible from their seed and differ between seeds", () => {
  const a = run(14, 142, 8.5, { noisy: true, seed: 7 });
  const b = run(14, 142, 8.5, { noisy: true, seed: 7 });
  const c = run(14, 142, 8.5, { noisy: true, seed: 8 });
  assert.equal(a.peak, b.peak);
  assert.notEqual(a.peak, c.peak);
});

test("a simulated year looks like the real world's", () => {
  let named = 0;
  const basin = { WNP: 0, NATL: 0, SATL: 0, NIO: 0 };
  const years = 4;
  for (let y = 0; y < years; y += 1) {
    const stats = seasonStats(simulateSeason({ land, seed: 11 + y }));
    named += stats.total.named;
    for (const k of Object.keys(basin)) basin[k] += stats.byBasin[k].named;
  }
  assert.ok(named / years > 65 && named / years < 110, `global ${named / years}`);
  assert.ok(basin.WNP > basin.NATL && basin.NATL > basin.NIO, "WNP is the busiest basin");
  assert.equal(basin.SATL, 0);
});
