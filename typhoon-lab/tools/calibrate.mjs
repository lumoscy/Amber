// Prints sanity tables for the climate model and the per-basin storm counts of simulated seasons.
// Usage: node tools/calibrate.mjs [years]
import fs from "node:fs";
import { makeLand, makeEnv, sstAt } from "../js/env.js";
import { simulateStorm, simulateSeason, seasonStats, BASINS, GENESIS_RATE, classify } from "../js/sim.js";

const land = makeLand(new Uint8Array(fs.readFileSync(new URL("../data/land.bin", import.meta.url))));
const years = Number(process.argv[2] || 20);

console.log("SST (Feb / Aug):");
for (const [name, lat, lon] of [["WNP 15N140E", 15, 140], ["WNP 30N135E", 30, 135], ["ATL MDR 13N-40", 13, -40], ["Gulf 25N-90", 25, -90], ["ENP 14N-105", 14, -105], ["BoB 15N88E", 15, 88], ["SIO 15S70E", -15, 70], ["Coral 15S150E", -15, 150], ["SATL 15S-25", -15, -25], ["SEP 15S-100", -15, -100], ["Nino3.4", 0, -145]]) {
  console.log(`  ${name.padEnd(16)} ${sstAt(lat, lon, 2.5).toFixed(1)} / ${sstAt(lat, lon, 8.5).toFixed(1)}`);
}
console.log("Steering u,v and shear (Aug | Feb):");
for (const [name, lat, lon] of [["WNP 15N140E", 15, 140], ["WNP 25N128E", 25, 128], ["WNP 32N135E", 32, 135], ["ATL 15N-45", 15, -45], ["ATL 28N-75", 28, -75], ["ENP 15N-110", 15, -110], ["BoB 14N88E", 14, 88], ["SIO 15S70E", -15, 70], ["SIO 25S50E", -25, 50], ["AUS 15S120E", -15, 120], ["SPAC 15S180", -15, 180]]) {
  const f = (m) => { const e = makeEnv(m, undefined, land); return `${e.sample("u", lat, lon).toFixed(1)},${e.sample("v", lat, lon).toFixed(1)} sh${e.sample("shear", lat, lon).toFixed(0)}`; };
  console.log(`  ${name.padEnd(14)} ${f(8.5).padEnd(18)} | ${f(2.5)}`);
}
console.log("Preset storms:");
for (const [name, lat, lon, month] of [["WNP west", 14, 142, 8.5], ["WNP recurve", 16, 150, 9.5], ["ATL CapeVerde", 12, -30, 9.2], ["Gulf", 22, -87, 8.7], ["ENP", 12, -100, 7.5], ["BoB May", 10, 90, 5.3], ["BoB Jul", 14, 88, 7.5], ["Arabian Jun", 12, 66, 6.2], ["SWIO", -13, 72, 2.2], ["AUS NW", -13, 122, 1.5], ["SPAC", -13, 172, 2.5], ["S Atlantic", -15, -25, 3], ["Equator", 1, 150, 8.5]]) {
  const s = simulateStorm({ lat, lon, month, land });
  const lf = s.events.filter((e) => e.type === "landfall").map((e) => `LF ${e.lat.toFixed(0)},${e.lon.toFixed(0)} @${e.v.toFixed(0)}`).join("; ");
  const path = s.points.filter((p) => p.hour % 48 === 0).map((p) => `${p.lat.toFixed(0)},${p.lon.toFixed(0)}`).join(" > ");
  console.log(`  ${name.padEnd(14)} peak ${s.peak.toFixed(0)} ${classify(s.peak, s.basin).short.padEnd(7)} ${String(s.hours).padStart(3)}h ${s.end} | ${lf}\n      ${path}`);
}
const sums = {}; const months = {};
for (let y = 0; y < years; y += 1) {
  const storms = simulateSeason({ land, seed: 100 + y });
  const stats = seasonStats(storms);
  for (const [k, b] of Object.entries(stats.byBasin)) {
    sums[k] = sums[k] || { named: 0, strong: 0, major: 0, landfalls: 0 };
    for (const f of Object.keys(sums[k])) sums[k][f] += b[f];
  }
  for (const s of storms) if (s.named) { months[s.basin] = months[s.basin] || new Array(12).fill(0); months[s.basin][Math.min(11, Math.floor(s.day / 30.4))] += 1; }
}
console.log(`Seasons (mean of ${years} years; rate now -> suggested):`);
let total = 0;
for (const [k, b] of Object.entries(BASINS)) {
  const s = sums[k]; const mean = s.named / years; total += mean;
  const suggest = b.target && mean ? (GENESIS_RATE[k] * b.target / mean).toFixed(2) : "-";
  console.log(`  ${k.padEnd(5)} named ${mean.toFixed(1).padStart(5)} (target ${b.target}) strong ${(s.strong / years).toFixed(1)} super ${(s.major / years).toFixed(1)} landfall ${(s.landfalls / years).toFixed(1)}  rate ${GENESIS_RATE[k]} -> ${suggest}   ${(months[k] || []).map((n) => (n / years).toFixed(1)).join(" ")}`);
}
console.log("  global", total.toFixed(1));
console.log("RATES " + JSON.stringify(Object.fromEntries(Object.entries(BASINS).map(([k, b]) => [k, b.target && sums[k].named ? +(GENESIS_RATE[k] * b.target * years / sums[k].named).toPrecision(3) : GENESIS_RATE[k]]))));
