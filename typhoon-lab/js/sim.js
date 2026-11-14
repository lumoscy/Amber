// Storm life cycle on top of the gridded environment: where it goes, how strong it gets,
// what each basin would call it, and a whole-year global season.

import { makeEnv, wrapLon, DEFAULT_KNOBS, NLON, NLAT } from "./env.js";

const DEG = Math.PI / 180;
const M_PER_DEG = 111195;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const KT = 1.94384;

// ---------- basins and their naming conventions ----------

export const BASINS = {
  WNP: { name: "西北太平洋", storm: "台风", view: [140, 20], target: 26 },
  ENP: { name: "东北太平洋", storm: "飓风", view: [-125, 16], target: 17 },
  NATL: { name: "北大西洋", storm: "飓风", view: [-60, 24], target: 14 },
  NIO: { name: "北印度洋", storm: "气旋风暴", view: [78, 14], target: 5 },
  SWIO: { name: "西南印度洋", storm: "热带气旋", view: [62, -17], target: 10 },
  AUS: { name: "澳大利亚海域", storm: "热带气旋", view: [128, -17], target: 10 },
  SPAC: { name: "南太平洋", storm: "热带气旋", view: [-175, -18], target: 6 },
  SATL: { name: "南大西洋", storm: "热带气旋", view: [-25, -18], target: 0 },
  SEP: { name: "东南太平洋", storm: "热带气旋", view: [-100, -18], target: 0 }
};

export function basinOf(lat, lon) {
  lon = wrapLon(lon);
  if (lat >= 0) {
    if (lon >= 30 && lon < 100) {
      return "NIO";
    }
    if (lon >= 100 || lon < -180 + 0.001) {
      return "WNP";
    }
    // The Americas split the Pacific from the Atlantic along a slanted coast.
    const divide = lat >= 20 ? -100 : lat >= 15 ? -93 : lat >= 10 ? -84.5 : -78;
    return lon < divide ? "ENP" : "NATL";
  }
  if (lon >= 20 && lon < 90) {
    return "SWIO";
  }
  if (lon >= 90 && lon < 160) {
    return "AUS";
  }
  if (lon >= 160 || lon < -120) {
    return "SPAC";
  }
  return lon < -70 ? "SEP" : "SATL";
}

// Each list: [lower bound in knots, short label, full name]. Winds below the first bound are a "low".
const SCALES = {
  CMA: [[0, "TD", "热带低压"], [34, "TS", "热带风暴"], [48, "STS", "强热带风暴"], [64, "TY", "台风"], [81, "STY", "强台风"], [100, "SuperTY", "超强台风"]],
  SSHWS: [[0, "TD", "热带低压"], [34, "TS", "热带风暴"], [64, "C1", "一级飓风"], [83, "C2", "二级飓风"], [96, "C3", "三级飓风"], [113, "C4", "四级飓风"], [137, "C5", "五级飓风"]],
  IMD: [[0, "D", "低压"], [28, "DD", "深低压"], [34, "CS", "气旋风暴"], [48, "SCS", "强气旋风暴"], [64, "VSCS", "特强气旋风暴"], [90, "ESCS", "极强气旋风暴"], [120, "SuCS", "超级气旋风暴"]],
  MFR: [[0, "TD", "热带扰动"], [28, "TD", "热带低压"], [34, "MTS", "中等热带风暴"], [48, "STS", "强热带风暴"], [64, "TC", "热带气旋"], [90, "ITC", "强烈热带气旋"], [116, "VITC", "特强热带气旋"]],
  AUS: [[0, "TL", "热带低压"], [34, "C1", "一级热带气旋"], [48, "C2", "二级热带气旋"], [64, "C3", "三级强烈热带气旋"], [86, "C4", "四级强烈热带气旋"], [108, "C5", "五级强烈热带气旋"]]
};
const BASIN_SCALE = { WNP: "CMA", ENP: "SSHWS", NATL: "SSHWS", NIO: "IMD", SWIO: "MFR", AUS: "AUS", SPAC: "AUS", SATL: "SSHWS", SEP: "SSHWS" };
export const SCALE_NAMES = { CMA: "中国气象局", SSHWS: "萨菲尔-辛普森", IMD: "印度气象局", MFR: "法国气象局（留尼汪）", AUS: "澳大利亚气象局" };

export function classify(v, basin) {
  const scaleId = BASIN_SCALE[basin] || "SSHWS";
  const scale = SCALES[scaleId];
  const kt = v * KT;
  let level = 0;
  for (let i = 0; i < scale.length; i += 1) {
    if (kt >= scale[i][0]) {
      level = i;
    }
  }
  return { scaleId, level, short: scale[level][1], name: scale[level][2] };
}

// One colour ramp for every basin, by wind speed, so tracks are comparable across the globe.
export const INTENSITY_STEPS = [
  [0, "#7fb2ff", "低压"],
  [17.2, "#4fd6c4", "风暴"],
  [24.5, "#f6dd5c", "强风暴"],
  [32.7, "#ff9d3c", "台风 / 飓风"],
  [41.5, "#ff5d4f", "强"],
  [51, "#ff4fb6", "超强"],
  [70, "#e9e2ff", "顶级"]
];
export const colorOf = (v) => {
  let c = INTENSITY_STEPS[0][1];
  for (const [bound, colour] of INTENSITY_STEPS) {
    if (v >= bound) {
      c = colour;
    }
  }
  return c;
};

export const pressureOf = (v) => Math.round(1010 - Math.pow(Math.max(0, v * KT) / 6.7, 1 / 0.644));

// ---------- random numbers (seeded, so a storm can be replayed) ----------

export function makeRng(seed) {
  let s = seed >>> 0 || 1;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const normal = () => Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next());
  return { next, normal };
}

// ---------- one storm ----------

const EFFICIENCY = 0.66;

const landFraction = (land, lat, lon) => {
  if (!land) {
    return 0;
  }
  let n = 0;
  const r = 0.8;
  const offsets = [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r], [r * 0.7, r * 0.7], [-r * 0.7, r * 0.7], [r * 0.7, -r * 0.7], [-r * 0.7, -r * 0.7]];
  for (const [dy, dx] of offsets) {
    n += land.isLand(lat + dy, lon + dx / Math.max(0.3, Math.cos(lat * DEG)));
  }
  return n / offsets.length;
};

// Breaks the forces on the storm at one place into the pieces the UI explains.
export function diagnose(env, lat, lon, v, size = 300, noise = null) {
  const h = lat >= 0 ? 1 : -1;
  const us = env.sample("u", lat, lon) + (noise ? noise.u : 0);
  const vs = env.sample("v", lat, lon) + (noise ? noise.v : 0);
  // Beta drift: a vortex on a rotating sphere drifts poleward and westward on its own.
  const beta = (1.1 + 0.9 * (size / 300)) * clamp(v / 25, 0.45, 1);
  const bu = -0.72 * beta;
  const bv = 0.72 * beta * h;
  const sst = env.sample("sst", lat, lon);
  const shear = Math.max(1, env.sample("shear", lat, lon) + (noise ? noise.sh : 0));
  const mpi = env.sample("mpi", lat, lon);
  const onLand = env.land ? env.land.isLand(lat, lon) === 1 : false;
  const coast = landFraction(env.land, lat, lon);
  const shearFactor = clamp(1 - (shear - 7) / 21, 0.05, 1);
  const spin = clamp((Math.abs(lat) - 2) / 5, 0, 1);
  // Real storms rarely reach the thermodynamic ceiling: dry air, eyewall cycles, their own cold wake.
  const potential = Math.min(mpi * 1.02, mpi * EFFICIENCY * shearFactor * spin * (1 - 0.45 * coast) * (noise ? noise.pot : 1));
  return { us, vs, bu, bv, mu: us + bu, mv: vs + bv, sst, shear, mpi, onLand, coast, shearFactor, spin, potential };
}

export function simulateStorm(options) {
  const {
    lat: lat0, lon: lon0, month, knobs = DEFAULT_KNOBS, land = null,
    size = 300, v0 = 11, seed = 0, noisy = false, maxHours = 22 * 24
  } = options;
  const env = makeEnv(month, knobs, land);
  const rng = makeRng(seed || 1);
  const noise = noisy ? { u: rng.normal() * 1.2, v: rng.normal() * 1.0, sh: rng.normal() * 2.5, pot: 1 } : null;
  // Most real storms fall well short of the ceiling and spin up at very different paces.
  const potMean = noisy ? -0.12 : 0;
  let potLog = noisy ? potMean + rng.normal() * 0.4 : 0;
  const growth = (0.8 / 24) * (noisy ? Math.exp(-0.1 + rng.normal() * 0.45) : 1);
  let lat = lat0;
  let lon = lon0;
  let v = v0;
  let peak = v0;
  let stage = "tropical";
  let weakHours = 0;
  let overLand = env.land ? env.land.isLand(lat, lon) === 1 : false;
  const points = [];
  const events = [];
  let end = "消散";

  for (let hour = 0; hour <= maxHours; hour += 1) {
    if (noise) {
      // Slowly wandering weather on top of the climate: troughs, ridges, bursts of convection.
      const k = 1 / 36;
      noise.u += -noise.u * k + rng.normal() * 1.7 * Math.sqrt(2 * k);
      noise.v += -noise.v * k + rng.normal() * 1.4 * Math.sqrt(2 * k);
      noise.sh += -noise.sh * k + rng.normal() * 3.2 * Math.sqrt(2 * k);
      potLog += -(potLog - potMean) / 48 + rng.normal() * 0.25 * Math.sqrt(2 / 48);
      noise.pot = Math.exp(potLog);
    }
    const d = diagnose(env, lat, lon, v, size, noise);
    const basin = basinOf(lat, lon);

    if (d.onLand !== overLand) {
      overLand = d.onLand;
      if (overLand && v >= 17.2) {
        events.push({ hour, type: "landfall", lat, lon, v, basin });
      }
    }
    if (stage === "tropical" && (d.sst < 21.5 || Math.abs(lat) > 46) && !d.onLand) {
      stage = "extratropical";
      events.push({ hour, type: "transition", lat, lon, v, basin });
    }

    let dv;
    if (d.onLand) {
      dv = -(v - 8) / 11;
    } else if (stage === "extratropical") {
      dv = -(v - 14) / 60;
    } else if (v < d.potential) {
      dv = growth * v * (1 - v / Math.max(d.potential, 1));
    } else {
      dv = -(v - d.potential) / 18;
    }

    points.push({
      hour, lat, lon, v, p: pressureOf(v), basin, stage, land: d.onLand,
      sst: d.sst, shear: d.shear, mpi: d.mpi, potential: d.potential, dv: dv * 24,
      us: d.us, vs: d.vs, bu: d.bu, bv: d.bv
    });

    v = Math.max(5, v + dv);
    if (v > peak) {
      const before = classify(peak, basin).level;
      peak = v;
      const now = classify(peak, basin);
      if (now.level > before) {
        events.push({ hour, type: "upgrade", lat, lon, v, basin, name: now.name });
      }
    }

    const speed = Math.hypot(d.mu, d.mv);
    const cap = speed > 22 ? 22 / speed : 1;
    lat += (d.mv * cap * 3600) / M_PER_DEG;
    lon = wrapLon(lon + (d.mu * cap * 3600) / (M_PER_DEG * Math.max(0.2, Math.cos(lat * DEG))));

    weakHours = v < 10.5 ? weakHours + 1 : 0;
    if (weakHours >= 12 && hour >= 24) {
      end = d.onLand ? "登陆后消散" : peak < 17.2 ? "没能发展起来" : "减弱消散";
      break;
    }
    if (Math.abs(lat) > 62) {
      end = "并入西风带";
      break;
    }
    if (stage === "extratropical" && v < 16) {
      end = "变性为温带气旋";
      break;
    }
  }

  const peakPoint = points.reduce((best, p) => (p.v > best.v ? p : best), points[0]);
  return {
    points, events, end, peak: peakPoint.v, peakHour: peakPoint.hour, pmin: pressureOf(peakPoint.v),
    origin: { lat: lat0, lon: lon0, month }, basin: basinOf(lat0, lon0), size, seed, noisy,
    hours: points[points.length - 1].hour, named: peakPoint.v >= 17.2
  };
}

// ---------- a whole year, everywhere ----------

// Scales the relative genesis potential to named storms per year in each basin, so the global
// season lands near the observed long-term averages. Found with tools/calibrate.mjs.
export const GENESIS_RATE = { WNP: 0.0131, ENP: 0.011, NATL: 0.0134, NIO: 0.0085, SWIO: 0.009, AUS: 0.00757, SPAC: 0.00346, SATL: 0.01, SEP: 0.003 };

const poisson = (mean, rng) => {
  if (mean <= 0) {
    return 0;
  }
  const limit = Math.exp(-mean);
  let k = 0;
  let p = 1;
  do {
    k += 1;
    p *= rng.next();
  } while (p > limit && k < 500);
  return k - 1;
};

export function simulateSeason({ knobs = DEFAULT_KNOBS, land = null, seed = 1, rates = GENESIS_RATE } = {}) {
  const rng = makeRng(seed);
  const storms = [];
  for (let m = 1; m <= 12; m += 1) {
    const month = m + 0.5;
    const env = makeEnv(month, knobs, land);
    const gp = env.fields.gp;
    const weights = new Float64Array(NLON * NLAT);
    let total = 0;
    for (let j = 30; j < NLAT - 30; j += 1) {
      const lat = j - 90;
      const area = Math.cos(lat * DEG);
      for (let i = 0; i < NLON; i += 1) {
        const k = j * NLON + i;
        if (gp[k] > 0.001) {
          total += gp[k] * area * (rates[basinOf(lat, i - 180)] || 0);
        }
        weights[k] = total;
      }
    }
    const count = poisson(total, rng);
    for (let n = 0; n < count; n += 1) {
      const target = rng.next() * total;
      let lo = 0;
      let hi = weights.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (weights[mid] < target) {
          lo = mid + 1;
        } else {
          hi = mid;
        }
      }
      const lat = Math.floor(lo / NLON) - 90 + rng.next() - 0.5;
      const lon = (lo % NLON) - 180 + rng.next() - 0.5;
      const storm = simulateStorm({
        lat, lon, month, knobs, land, noisy: true,
        seed: Math.floor(rng.next() * 2 ** 31) + 1, size: 200 + rng.next() * 260
      });
      storm.day = (m - 1) * 30.4 + rng.next() * 30.4;
      storms.push(storm);
    }
  }
  storms.sort((a, b) => a.day - b.day);
  const counters = {};
  for (const storm of storms) {
    if (storm.named) {
      counters[storm.basin] = (counters[storm.basin] || 0) + 1;
      storm.label = `${BASINS[storm.basin].name} ${String(counters[storm.basin]).padStart(2, "0")} 号`;
    }
  }
  return storms;
}

export function seasonStats(storms) {
  const byBasin = {};
  for (const key of Object.keys(BASINS)) {
    byBasin[key] = { named: 0, strong: 0, major: 0, landfalls: 0, ace: 0 };
  }
  let strongest = null;
  for (const storm of storms) {
    if (!storm.named) {
      continue;
    }
    const b = byBasin[storm.basin];
    b.named += 1;
    b.strong += storm.peak >= 32.7 ? 1 : 0;
    b.major += storm.peak >= 51 ? 1 : 0;
    b.landfalls += storm.events.some((e) => e.type === "landfall") ? 1 : 0;
    // Accumulated cyclone energy: sum of squared 6-hourly winds (kt) over 34 kt, in 10^4 kt^2.
    for (const p of storm.points) {
      if (p.hour % 6 === 0 && p.v >= 17.2 && p.stage === "tropical") {
        b.ace += Math.pow(p.v * KT, 2) / 1e4;
      }
    }
    if (!strongest || storm.peak > strongest.peak) {
      strongest = storm;
    }
  }
  const total = Object.values(byBasin).reduce((sum, b) => ({
    named: sum.named + b.named, strong: sum.strong + b.strong, major: sum.major + b.major,
    landfalls: sum.landfalls + b.landfalls, ace: sum.ace + b.ace
  }), { named: 0, strong: 0, major: 0, landfalls: 0, ace: 0 });
  return { byBasin, total, strongest };
}
