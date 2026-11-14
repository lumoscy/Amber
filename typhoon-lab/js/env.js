// A hand-built global climate for the simulator. Nothing here is reanalysis data: every field
// is an analytic sketch of the real climatology (zonal structure + the well-known regional
// features), tuned so that storms behave plausibly in every basin. See README for the limits.

export const NLON = 360;
export const NLAT = 181;
const DEG = Math.PI / 180;
const G = 9.81;
const OMEGA = 7.292e-5;
const M_PER_DEG = 111195;

export const DEFAULT_KNOBS = { enso: 0, sst: 0, high: 0, west: 0 };

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const sigmoid = (x) => 1 / (1 + Math.exp(-x));
export const wrapLon = (lon) => ((((lon + 180) % 360) + 360) % 360) - 180;
const dLon = (a, b) => wrapLon(a - b);

const bump = (lon, lat, lon0, lat0, sx, sy) => {
  const dx = dLon(lon, lon0) / sx;
  const dy = (lat - lat0) / sy;
  return Math.exp(-dx * dx - dy * dy);
};

// month is a float: 1.0 = 1 Jan, 8.5 = mid August. Returns +1 at the northern peak, -1 half a year later.
const seasonOf = (month, peak) => Math.cos((2 * Math.PI * (month - peak)) / 12);
export const oceanSeason = (month) => seasonOf(month, 9.1);
export const airSeason = (month) => seasonOf(month, 8.3);

// ---------- land mask ----------

export const LAND_W = 1440;
export const LAND_H = 720;

export function makeLand(bytes) {
  const isLand = (lat, lon) => {
    const x = Math.floor(((wrapLon(lon) + 180) / 360) * LAND_W) % LAND_W;
    const y = clamp(Math.floor(((90 - lat) / 180) * LAND_H), 0, LAND_H - 1);
    const i = y * LAND_W + x;
    return (bytes[i >> 3] >> (i & 7)) & 1;
  };
  return { bytes, isLand };
}

// ---------- sea surface temperature ----------

export function sstAt(lat, lon, month, knobs = DEFAULT_KNOBS) {
  const s = oceanSeason(month);
  // The thermal equator sits a little north of the equator and follows the sun.
  const eff = Math.abs(lat - 3 - 6 * s);
  let t = -1.8 + 30.8 * Math.exp(-Math.pow(eff / 44, 3));
  const north = clamp((s + 1) / 2, 0, 1);
  const south = 1 - north;

  // Warm pool and the summer warm pools east of each continent.
  t += 1.3 * bump(lon, lat, 140, 5, 50, 20);
  t += 1.6 * north * bump(lon, lat, 132, 24, 22, 10);
  t += 1.4 * north * bump(lon, lat, -78, 26, 22, 9);
  t += 1.2 * north * bump(lon, lat, -102, 14, 16, 6);
  t += 1.0 * bump(lon, lat, 88, 12, 14, 9);
  t += 1.0 * south * bump(lon, lat, 60, -14, 30, 8);
  t += 1.0 * south * bump(lon, lat, 135, -13, 30, 7);
  t += 1.0 * south * bump(lon, lat, -175, -15, 30, 8);

  // Cold tongues and eastern-boundary upwelling. These are why the southeast Pacific and
  // the South Atlantic have essentially no tropical cyclones.
  t -= 3.6 * bump(lon, lat, -105, -1, 38, 5);
  t -= 6.0 * bump(lon, lat, -84, -18, 20, 17);
  t -= 2.5 * bump(lon, lat, -110, -22, 30, 12);
  t -= 4.5 * bump(lon, lat, -121, 30, 12, 11);
  t -= 2.0 * bump(lon, lat, -140, 22, 22, 8);
  t -= 3.2 * bump(lon, lat, -19, 24, 10, 10);
  t -= 5.0 * bump(lon, lat, 9, -20, 12, 14);
  t -= 2.6 * bump(lon, lat, -15, -12, 26, 12);
  t -= 2.0 * bump(lon, lat, -8, -1, 16, 4);
  t -= 2.5 * bump(lon, lat, 108, -28, 9, 10);
  // Somali upwelling under the summer monsoon jet.
  t -= 3.0 * clamp(airSeason(month), 0, 1) * bump(lon, lat, 54, 11, 8, 7);
  // Warm western boundary currents.
  t += 2.0 * bump(lon, lat, -68, 36, 12, 5);
  t += 1.5 * bump(lon, lat, 143, 34, 10, 5);

  // ENSO: warm (El Nino) or cool (La Nina) central-eastern equatorial Pacific.
  t += knobs.enso * (1.7 * bump(lon, lat, -135, 0, 45, 9) - 0.35 * bump(lon, lat, 135, 8, 30, 14));
  return clamp(t + knobs.sst, -1.8, 33);
}

// Potential intensity: the strongest wind the ocean underneath can sustain (m/s).
export const mpiOf = (sst) => 88 * sigmoid((sst - 26.7) / 1.15);

// ---------- 500 hPa height, which the steering flow is derived from ----------

const ridgeLat = (h, month) => 27 + 5 * airSeason(month) * h;

const HIGHS = [
  // lon, hemisphere, amplitude, sx, sy, lat offset from the ridge, responds to the "west" knob
  [172, 1, 40, 28, 13, 0, 1],
  [-140, 1, 34, 28, 13, 2, 0],
  [-42, 1, 40, 30, 13, 1, 1],
  [-104, 1, 22, 16, 9, 3, 0],
  // Western lobe over Indochina: its west flank carries Bay of Bengal storms north.
  [104, 1, 30, 15, 12, -7, 0],
  [72, -1, 36, 32, 13, 1, 0],
  [-100, -1, 34, 34, 13, 1, 0],
  [-172, -1, 22, 24, 12, 0, 0],
  [-10, -1, 34, 28, 13, 1, 0],
  [128, -1, 16, 20, 10, 2, 0]
];

const TROUGHS = [
  // lon, lat, winter amplitude, summer amplitude, sx, sy
  [130, 43, -70, -42, 24, 14],
  [-72, 48, -65, -30, 22, 14],
  [25, 48, -30, -15, 22, 14],
  [60, -48, -35, -45, 30, 12],
  [150, -48, -35, -45, 30, 12],
  [-60, -50, -35, -40, 30, 12]
];

export function heightAt(lat, lon, month, knobs = DEFAULT_KNOBS) {
  const h = lat >= 0 ? 1 : -1;
  const a = Math.abs(lat);
  const summer = airSeason(month) * h;
  const ridge = ridgeLat(h, month);
  let z;
  if (a <= ridge) {
    const x = (ridge - a) / 16;
    z = 5880 - 30 * (1 - Math.exp(-x * x));
  } else {
    const x = (a - ridge) / 22;
    z = 5880 - (560 - 60 * summer) * (1 - Math.exp(-x * x));
  }
  const strength = (0.62 + 0.38 * summer) * (1 + knobs.high / 40);
  for (const [lon0, hh, amp, sx, sy, off, west] of HIGHS) {
    if (hh !== h) {
      continue;
    }
    // El Nino pulls the west Pacific high back east.
    const centre = lon0 - (west ? knobs.west : 0) + (west && lon0 > 0 ? 6 * knobs.enso : 0);
    z += amp * strength * bump(lon, a, centre, ridge + off, sx, sy);
  }
  for (const [lon0, lat0, winter, summerAmp, sx, sy] of TROUGHS) {
    if ((lat0 >= 0 ? 1 : -1) !== h) {
      continue;
    }
    const amp = winter + (summerAmp - winter) * (summer + 1) / 2;
    z += amp * bump(lon, lat, lon0, lat0, sx, sy);
  }
  return z;
}

// ---------- vertical wind shear (850-200 hPa, m/s) ----------

export function shearAt(lat, lon, month, knobs = DEFAULT_KNOBS) {
  const h = lat >= 0 ? 1 : -1;
  const a = Math.abs(lat);
  const air = airSeason(month);
  const summer = air * h;
  // Quiet deep tropics; the subtropical jet sits closer to the equator in winter.
  const jetEdge = 25 + 9 * summer;
  let sh = 6 + 30 * sigmoid((a - jetEdge) / 4.5);
  // Winter-hemisphere tropics are sheared too.
  sh += 5 * clamp(-summer, 0, 1) * sigmoid((a - 8) / 3);
  // The Atlantic is the most sheared tropical ocean; El Nino makes it worse.
  sh += (4.5 + 3.5 * knobs.enso) * bump(lon, lat, -62, 15, 30, 9);
  sh += 17 * bump(lon, lat, -20, -15, 38, 14);
  // Tropical easterly jet over the north Indian Ocean during the summer monsoon:
  // the reason that basin has two short seasons instead of one.
  sh += 22 * clamp(air - 0.25, 0, 1) * bump(lon, lat, 76, 14, 26, 9);
  // East Pacific: sheared west of 140W, calmer in El Nino.
  sh += 9 * bump(lon, lat, -152, 16, 20, 9) - 2.5 * knobs.enso * bump(lon, lat, -140, 12, 35, 8);
  sh += 2.5 * knobs.enso * bump(lon, lat, 125, 16, 20, 8);
  // Southeast Pacific and the equatorial belt.
  sh += 10 * bump(lon, lat, -105, -15, 30, 12);
  return clamp(sh, 2, 50);
}

// ---------- genesis potential (relative; the simulator scales it per basin) ----------

function genesisAt(lat, lon, month, sst, shear, knobs) {
  const h = lat >= 0 ? 1 : -1;
  const a = Math.abs(lat);
  const summer = airSeason(month) * h;
  const coriolis = clamp((a - 4) / 6, 0, 1);
  const warm = sigmoid((sst - 27.3) / 0.6);
  const calm = Math.exp(-Math.pow(shear / 11, 2));
  // Storms are born along the monsoon trough / ITCZ, which is active in the summer hemisphere.
  const troughLat = 10 + 4.5 * clamp(summer, 0, 1);
  const trough = Math.exp(-Math.pow((a - troughLat) / 6.5, 2));
  // The season follows the ocean more than the sun, so it runs late: August to October, not June to August.
  const late = seasonOf(month, 8.9) * h;
  // The north Indian Ocean is the exception: its trough is in place either side of the monsoon.
  const indian = lat > 0 && lon > 45 && lon < 100;
  const active = 0.02 + 0.98 * sigmoid((late - (indian ? -0.35 : 0.3)) * 5);
  let regional = 1;
  // El Nino pulls Pacific genesis east and toward the equator; La Nina does the opposite.
  regional *= 1 + 0.5 * knobs.enso * (bump(lon, lat, 165, 8, 22, 8) - bump(lon, lat, 122, 17, 14, 8));
  return coriolis * warm * calm * trough * active * Math.max(0, regional);
}

// ---------- gridded environment for one month ----------

const cache = new Map();

export function makeEnv(month, knobs = DEFAULT_KNOBS, land = null) {
  const key = `${month.toFixed(2)}|${knobs.enso}|${knobs.sst}|${knobs.high}|${knobs.west}`;
  if (cache.has(key)) {
    return cache.get(key);
  }
  const n = NLON * NLAT;
  const sst = new Float32Array(n);
  const z = new Float32Array(n);
  const u = new Float32Array(n);
  const v = new Float32Array(n);
  const shear = new Float32Array(n);
  const mpi = new Float32Array(n);
  const gp = new Float32Array(n);

  for (let j = 0; j < NLAT; j += 1) {
    const lat = j - 90;
    for (let i = 0; i < NLON; i += 1) {
      const lon = i - 180;
      const k = j * NLON + i;
      sst[k] = sstAt(lat, lon, month, knobs);
      z[k] = heightAt(lat, lon, month, knobs);
      shear[k] = shearAt(lat, lon, month, knobs);
      mpi[k] = mpiOf(sst[k]);
      const ocean = land ? !land.isLand(lat, lon) : true;
      gp[k] = ocean ? genesisAt(lat, lon, month, sst[k], shear[k], knobs) : 0;
    }
  }

  // Geostrophic wind from the height field. The Coriolis parameter is held at its 12 degree
  // value inside the tropics, and the flow relaxes to light easterlies on the equator.
  const fMin = 2 * OMEGA * Math.sin(12 * DEG);
  for (let j = 1; j < NLAT - 1; j += 1) {
    const lat = j - 90;
    const f = 2 * OMEGA * Math.sin(lat * DEG);
    const fReg = (lat >= 0 ? 1 : -1) * Math.max(Math.abs(f), fMin);
    const cos = Math.max(0.05, Math.cos(lat * DEG));
    const eq = clamp(Math.abs(lat) / 7, 0, 1);
    for (let i = 0; i < NLON; i += 1) {
      const k = j * NLON + i;
      const e = j * NLON + ((i + 1) % NLON);
      const w = j * NLON + ((i + NLON - 1) % NLON);
      const dzdy = (z[k + NLON] - z[k - NLON]) / (2 * M_PER_DEG);
      const dzdx = (z[e] - z[w]) / (2 * M_PER_DEG * cos);
      const ug = (-G / fReg) * dzdy;
      const vg = (G / fReg) * dzdx;
      u[k] = eq * ug + (1 - eq) * -3.2;
      v[k] = eq * vg;
    }
  }

  const fields = { sst, z, u, v, shear, mpi, gp };
  const sample = (name, lat, lon) => {
    const grid = fields[name];
    const y = clamp(lat + 90, 0, NLAT - 1.001);
    const x = (((lon + 180) % 360) + 360) % 360;
    const j = Math.floor(y);
    const i = Math.floor(x);
    const fy = y - j;
    const fx = x - i;
    const i1 = (i + 1) % NLON;
    const a = grid[j * NLON + i] * (1 - fx) + grid[j * NLON + i1] * fx;
    const b = grid[(j + 1) * NLON + i] * (1 - fx) + grid[(j + 1) * NLON + i1] * fx;
    return a * (1 - fy) + b * fy;
  };
  const env = { month, knobs, fields, sample, land };
  cache.set(key, env);
  if (cache.size > 80) {
    cache.delete(cache.keys().next().value);
  }
  return env;
}

export const LAYERS = {
  sst: { name: "海表温度", unit: "°C", min: 0, max: 32, desc: "台风的燃料。一般要 26.5 °C 以上的暖水才能养出台风。" },
  mpi: { name: "潜在强度", unit: "m/s", min: 0, max: 88, desc: "脚下这片海水最多能支撑多强的风。台风的强度上限。" },
  shear: { name: "风切变", unit: "m/s", min: 0, max: 40, desc: "高低空风的差别。超过 12 m/s 左右，台风的暖心会被吹歪，难以增强。" },
  z: { name: "500 hPa 高度", unit: "gpm", min: 5300, max: 5930, desc: "副热带高压在哪里。台风沿着高压的边缘走，引导气流由它算出。" },
  gp: { name: "生成潜势", unit: "", min: 0, max: 1, desc: "哪里容易生出台风：暖水、低切变、离赤道够远、有季风槽。" }
};
