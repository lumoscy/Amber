import { makeLand, makeEnv, LAYERS } from "./env.js";
import {
  simulateStorm, simulateSeason, seasonStats, BASINS, classify, SCALE_NAMES,
  colorOf, INTENSITY_STEPS, KT
} from "./sim.js";
import { createGlobe, rampCss } from "./globe.js";

const $ = (id) => document.getElementById(id);
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const MAX_WIND = 85;

const state = {
  month: 8.5,
  knobs: { enso: 0, sst: 0, high: 0, west: 0 },
  layer: "sst",
  land: null,
  env: null,
  storm: null,
  origin: null,
  hour: 0,
  season: null,
  day: 0,
  playing: false,
  placing: true,
  yearPlaying: false,
  history: null,
  tracks: null
};
let globe = null;

// ---------- small helpers ----------

const fmtLat = (lat) => `${Math.abs(lat).toFixed(1)}°${lat >= 0 ? "N" : "S"}`;
const fmtLon = (lon) => `${Math.abs(lon).toFixed(1)}°${lon >= 0 ? "E" : "W"}`;
const monthLabel = (m) => {
  const whole = Math.floor(m);
  return `${((whole - 1) % 12) + 1} 月${["上", "中", "下"][Math.min(2, Math.floor((m - whole) * 3))]}旬`;
};
const dayLabel = (hour) => `第 ${Math.floor(hour / 24) + 1} 天 ${String(Math.floor(hour % 24)).padStart(2, "0")} 时`;
const COMPASS = ["东", "东北", "北", "西北", "西", "西南", "南", "东南"];
const heading = (u, v) => COMPASS[Math.round(((Math.atan2(v, u) * 180) / Math.PI + 360) / 45) % 8];

let toastTimer = 0;
function toast(text, ms = 2600) {
  const el = $("toast");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  if (ms) {
    toastTimer = setTimeout(() => {
      el.hidden = true;
    }, ms);
  }
}

// ---------- environment ----------

function refreshEnv() {
  state.env = makeEnv(state.month, state.knobs, state.land);
  const info = LAYERS[state.layer];
  globe.setEnv(state.env, state.layer, info ? [info.min, info.max] : [0, 1]);
  $("monthOut").textContent = monthLabel(state.month);
  $("legend").hidden = !info;
  if (info) {
    $("legendName").textContent = info.name;
    $("legendUnit").textContent = info.unit;
    $("legendBar").style.background = rampCss(state.layer);
    const mid = (info.min + info.max) / 2;
    $("legendTicks").innerHTML = [info.min, mid, info.max].map((v) => `<span>${state.layer === "gp" ? ["低", "", "高"][[info.min, mid, info.max].indexOf(v)] : Math.round(v)}</span>`).join("");
    $("layerDesc").textContent = info.desc;
  } else {
    $("layerDesc").textContent = "只看地球和风。";
  }
}

let rerunTimer = 0;
function environmentChanged() {
  refreshEnv();
  if (state.origin && !state.yearPlaying) {
    clearTimeout(rerunTimer);
    rerunTimer = setTimeout(() => launch(state.origin, { keepTime: true, quiet: true }), 120);
  }
}

// ---------- one storm ----------

function launch(origin, { keepTime = false, quiet = false } = {}) {
  state.origin = origin;
  const storm = simulateStorm({
    lat: origin.lat, lon: origin.lon, month: state.month, knobs: state.knobs, land: state.land,
    size: Number($("size").value), noisy: $("noisy").checked, seed: origin.seed || 1
  });
  state.storm = storm;
  state.season = null;
  globe.scene.season = null;
  $("seasonOut").hidden = true;
  globe.scene.storm = storm;
  state.hour = keepTime ? Math.min(state.hour, storm.hours) : 0;
  $("time").max = String(storm.hours);
  $("time").step = "1";
  $("dock").hidden = false;
  $("reroll").disabled = false;
  renderEvents();
  renderStorm();
  if (!keepTime) {
    setPlaying(true);
  }
  if (!quiet) {
    const cls = classify(storm.peak, storm.basin);
    toast(storm.named
      ? `${BASINS[storm.basin].name}：最强长到「${cls.name}」，${storm.end}`
      : "这个扰动没能发展起来——看看右边写的原因");
  }
}

function explain(p, storm) {
  const sst = p.sst.toFixed(1);
  const shear = p.shear.toFixed(0);
  if (p.land) {
    return "已经在陆地上：断了海洋的水汽和热量，地面摩擦又大，所以迅速减弱。";
  }
  if (p.stage === "extratropical") {
    return `闯进了冷水区（海温 ${sst} °C）和西风带，暖心结构保不住，正在变性为温带气旋。`;
  }
  if (Math.abs(p.lat) < 5) {
    return "离赤道太近。这里地球自转带来的偏转力几乎为零，气流转不成涡旋——所以赤道上没有台风。";
  }
  if (p.sst < 26) {
    return `脚下海温只有 ${sst} °C。没有 26.5 °C 以上的暖水供能，对流撑不起来。${storm.basin === "SATL" || storm.basin === "SEP" ? "这片海常年被寒流和上升流冷却，所以几乎不出热带气旋。" : ""}`;
  }
  if (p.shear > 16) {
    return `风切变 ${shear} m/s，太大了。高低空的风差得多，暖心被吹歪吹散，海再暖也长不动。`;
  }
  if (p.v < p.potential * 0.88) {
    return `海温 ${sst} °C、切变 ${shear} m/s：环境允许它长到约 ${p.potential.toFixed(0)} m/s，现在还在往上长。`;
  }
  if (p.v > p.potential * 1.08) {
    return `环境变差了（海温 ${sst} °C、切变 ${shear} m/s），只撑得起约 ${p.potential.toFixed(0)} m/s，正在减弱。`;
  }
  return `已经长到这片海能支撑的上限附近（约 ${p.potential.toFixed(0)} m/s）。再强需要更暖的水或更小的切变。`;
}

function renderStorm() {
  const storm = state.storm;
  if (!storm) {
    return;
  }
  const hour = clamp(Math.round(state.hour), 0, storm.points.length - 1);
  const p = storm.points[hour];
  globe.scene.hour = state.hour;
  const cls = classify(p.v, p.basin);
  const badge = $("badge");
  badge.textContent = p.stage === "extratropical" ? "温带气旋" : cls.name;
  badge.style.background = colorOf(p.v);
  badge.style.color = "#06121f";
  $("agency").textContent = `${BASINS[p.basin].name} · ${SCALE_NAMES[cls.scaleId]}`;
  $("vNow").textContent = p.v.toFixed(0);
  $("vAlt").innerHTML = `${Math.round(p.v * 3.6)} km/h<br>${Math.round(p.v * KT)} kt`;
  $("meterFill").style.width = `${clamp(p.v / MAX_WIND, 0, 1) * 100}%`;
  $("meterFill").style.background = colorOf(p.v);
  $("meterCap").style.left = `${clamp(p.potential / MAX_WIND, 0, 1) * 100}%`;
  $("kP").textContent = `${p.p} hPa`;
  $("kPos").textContent = `${fmtLat(p.lat)} ${fmtLon(p.lon)}`;
  const mu = p.us + p.bu;
  const mv = p.vs + p.bv;
  $("kMove").textContent = `向${heading(mu, mv)} ${Math.round(Math.hypot(mu, mv) * 3.6)} km/h`;
  $("kSstNow").textContent = p.land ? "陆地" : `${p.sst.toFixed(1)} °C`;
  $("kShear").textContent = `${p.shear.toFixed(0)} m/s`;
  const later = storm.points[Math.min(storm.points.length - 1, hour + 24)];
  const trend = later.v - p.v;
  $("kTrend").textContent = `${trend >= 0 ? "+" : "−"}${Math.abs(trend).toFixed(0)} m/s`;
  $("why").textContent = explain(p, storm);
  $("time").value = String(state.hour);
  $("clock").textContent = dayLabel(hour);
  document.querySelectorAll("#events li[data-hour]").forEach((li) => {
    li.classList.toggle("is-now", Number(li.dataset.hour) <= hour);
  });
  drawChart();
}

function renderEvents() {
  const storm = state.storm;
  const rows = [[0, `在 ${fmtLat(storm.origin.lat)} ${fmtLon(storm.origin.lon)} 生成（${BASINS[storm.basin].name}，${monthLabel(storm.origin.month)}）`]];
  for (const e of storm.events) {
    if (e.type === "upgrade") {
      rows.push([e.hour, `加强为${e.name}（${e.v.toFixed(0)} m/s）`]);
    } else if (e.type === "landfall") {
      rows.push([e.hour, `登陆 ${fmtLat(e.lat)} ${fmtLon(e.lon)}，登陆时 ${e.v.toFixed(0)} m/s`]);
    } else if (e.type === "transition") {
      rows.push([e.hour, "进入冷水和西风带，开始变性"]);
    }
  }
  rows.push([storm.hours, `${storm.end}。一生 ${(storm.hours / 24).toFixed(1)} 天，巅峰 ${storm.peak.toFixed(0)} m/s / ${storm.pmin} hPa`]);
  $("events").innerHTML = rows
    .map(([hour, text]) => `<li data-hour="${hour}"><time>D${Math.floor(hour / 24) + 1} ${String(hour % 24).padStart(2, "0")}时</time><span>${text}</span></li>`)
    .join("");
}

// ---------- intensity chart in the dock ----------

function drawChart() {
  const canvas = $("chart");
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  if (canvas.width !== Math.round(rect.width * dpr)) {
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
  }
  const ctx = canvas.getContext("2d");
  const w = rect.width;
  const h = rect.height - 14;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);

  if (state.season) {
    // Storms alive on each day of the year.
    const bins = new Array(122).fill(0);
    for (const s of state.season) {
      if (s.named) {
        for (let d = Math.floor(s.day / 3); d <= Math.min(121, Math.floor((s.day + s.hours / 24) / 3)); d += 1) {
          bins[d] += 1;
        }
      }
    }
    const top = Math.max(4, ...bins);
    const bw = w / bins.length;
    bins.forEach((n, i) => {
      ctx.fillStyle = i * 3 <= state.day ? "rgba(95,227,208,0.8)" : "rgba(160,190,255,0.22)";
      ctx.fillRect(i * bw, h - (n / top) * h, Math.max(1, bw - 1), (n / top) * h);
    });
    return;
  }
  const storm = state.storm;
  if (!storm) {
    return;
  }
  const pts = storm.points;
  const x = (hour) => (hour / Math.max(1, storm.hours)) * w;
  const y = (v) => h - clamp(v / MAX_WIND, 0, 1) * h;
  for (const [bound] of INTENSITY_STEPS.slice(1, 6)) {
    ctx.strokeStyle = "rgba(160,190,255,0.1)";
    ctx.beginPath();
    ctx.moveTo(0, y(bound));
    ctx.lineTo(w, y(bound));
    ctx.stroke();
  }
  ctx.setLineDash([3, 4]);
  ctx.strokeStyle = "rgba(255,255,255,0.3)";
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(x(p.hour), y(p.potential)) : ctx.moveTo(x(p.hour), y(p.potential))));
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.lineWidth = 2.2;
  ctx.lineJoin = "round";
  for (let i = 1; i < pts.length; i += 1) {
    ctx.strokeStyle = colorOf(pts[i].v);
    ctx.globalAlpha = pts[i].hour <= state.hour ? 1 : 0.35;
    ctx.beginPath();
    ctx.moveTo(x(pts[i - 1].hour), y(pts[i - 1].v));
    ctx.lineTo(x(pts[i].hour), y(pts[i].v));
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  for (const e of storm.events) {
    if (e.type === "landfall") {
      ctx.fillStyle = "#fff";
      ctx.beginPath();
      ctx.moveTo(x(e.hour), y(e.v) - 9);
      ctx.lineTo(x(e.hour) + 4, y(e.v) - 3);
      ctx.lineTo(x(e.hour) - 4, y(e.v) - 3);
      ctx.fill();
    }
  }
  ctx.strokeStyle = "rgba(255,255,255,0.7)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x(state.hour), 0);
  ctx.lineTo(x(state.hour), h);
  ctx.stroke();
}

// ---------- playback ----------

function setPlaying(on) {
  state.playing = on;
  $("play").textContent = on ? "❚❚" : "▶";
  $("play").setAttribute("aria-label", on ? "暂停" : "播放");
}

let lastTick = performance.now();
function tick(now) {
  const dt = Math.min(0.1, (now - lastTick) / 1000);
  lastTick = now;
  const speed = Number($("speed").value);
  if (state.yearPlaying) {
    state.month += dt * 1.1;
    if (state.month >= 12.95) {
      state.month = 12.95;
      state.yearPlaying = false;
      $("yearPlay").textContent = "▶ 让四季流转一遍";
    }
    $("month").value = String(state.month);
    refreshEnv();
  }
  if (state.playing && state.season) {
    state.day += dt * 16 * speed;
    if (state.day >= 372) {
      state.day = 372;
      setPlaying(false);
    }
    renderSeasonClock();
  } else if (state.playing && state.storm) {
    state.hour += dt * 18 * speed;
    if (state.hour >= state.storm.hours) {
      state.hour = state.storm.hours;
      setPlaying(false);
    }
    renderStorm();
  }
  requestAnimationFrame(tick);
}

// ---------- a whole year ----------

function renderSeasonClock() {
  globe.scene.day = state.day;
  $("time").value = String(state.day);
  const day = Math.min(364, state.day);
  const month = 1 + day / 30.42;
  $("clock").textContent = `${Math.floor(month)} 月 ${Math.floor((month % 1) * 30) + 1} 日`;
  // The ocean and the winds move through the year along with the storms.
  const snapped = Math.round(month * 4) / 4;
  if (Math.abs(snapped - state.month) >= 0.25) {
    state.month = clamp(snapped, 1, 12.95);
    $("month").value = String(state.month);
    refreshEnv();
  }
  drawChart();
}

function runSeason() {
  toast("正在把全球一整年的风暴都跑一遍…", 0);
  $("seasonRun").disabled = true;
  setTimeout(() => {
    const storms = simulateSeason({ knobs: state.knobs, land: state.land, seed: Math.floor(Math.random() * 1e9) + 1 });
    const stats = seasonStats(storms);
    state.season = storms;
    state.storm = null;
    state.origin = null;
    state.history = null;
    globe.scene.storm = null;
    globe.scene.history = null;
    globe.scene.season = storms;
    state.day = 0;
    $("time").max = "372";
    $("time").step = "0.5";
    $("dock").hidden = false;
    $("reroll").disabled = true;
    $("histInfo").hidden = true;
    $("badge").textContent = "全球台风季";
    $("badge").style.background = "";
    $("badge").style.color = "";
    $("agency").textContent = "";
    $("vNow").textContent = String(stats.total.named);
    $("vAlt").textContent = "个命名风暴";
    $("why").textContent = stats.strongest
      ? `这一年最强的是${stats.strongest.label}，巅峰 ${stats.strongest.peak.toFixed(0)} m/s。注意看：北半球夏秋热闹，南半球要等到年初年尾；南大西洋和东南太平洋几乎一片空白。`
      : "这一年没有命名风暴。";
    $("events").innerHTML = '<li class="muted">全年模式下不显示单个风暴的经历。</li>';
    $("seasonTiles").innerHTML = [
      [stats.total.named, "命名风暴"],
      [stats.total.strong, "台风 / 飓风级"],
      [stats.total.major, "超强（≥51 m/s）"]
    ].map(([n, label]) => `<div class="tile"><b>${n}</b><span>${label}</span></div>`).join("");
    $("seasonTable").innerHTML = `<tr><th>洋盆</th><th>模拟</th><th>常年</th><th>登陆</th></tr>${
      Object.entries(BASINS).map(([key, b]) => {
        const s = stats.byBasin[key];
        return `<tr><td>${b.name}</td><td>${s.named}</td><td><small>${b.target ? `≈${b.target}` : "≈0"}</small></td><td>${s.landfalls}</td></tr>`;
      }).join("")}`;
    $("seasonOut").hidden = false;
    $("seasonRun").disabled = false;
    $("seasonRun").textContent = "再模拟一年";
    globe.flyTo(globe.view.lon, 8, 0.92, 1.4);
    setPlaying(true);
    toast(`这一年全球生成了 ${stats.total.named} 个命名风暴`);
  }, 60);
}

// ---------- real typhoons ----------

const ZH = {
  Mangkhut: "山竹", Haiyan: "海燕", Lekima: "利奇马", Meranti: "莫兰蒂", Hato: "天鸽", Rammasun: "威马逊",
  Saomai: "桑美", Morakot: "莫拉克", Megi: "鲇鱼", "In-fa": "烟花", Doksuri: "杜苏芮", Yagi: "摩羯",
  Hagibis: "海贝思", Usagi: "天兔", Fitow: "菲特", Chanthu: "灿都", Hinnamnor: "轩岚诺", Saola: "苏拉",
  Bebinca: "贝碧嘉", Goni: "天鹅", Rai: "雷伊", Nepartak: "尼伯特", Soudelor: "苏迪罗", Mujigae: "彩虹",
  Vicente: "韦森特", Hagupit: "黑格比", Jebi: "飞燕", Maria: "玛莉亚", Trami: "潭美", Muifa: "梅花",
  Khanun: "卡努", Haikui: "海葵", Koinu: "小犬", Gaemi: "格美", Nida: "妮妲", Talim: "泰利"
};
const NOTABLES = [["Mangkhut", 2018], ["Haiyan", 2013], ["Lekima", 2019], ["Meranti", 2016], ["Hato", 2017], ["Rammasun", 2014], ["Hagibis", 2019], ["Saomai", 2006], ["Morakot", 2009], ["Doksuri", 2023]];
const titleOf = (s) => `${ZH[s.name] ? `${ZH[s.name]} ` : ""}${s.name} ${s.year}`;

async function loadTracks() {
  try {
    const data = await (await fetch("data/wnp.json")).json();
    state.tracks = data.storms.filter((s) => s.name && s.name !== "UNNAMED" && s.name !== "NOT_NAMED");
    $("histList").innerHTML = state.tracks.map((s) => `<option value="${titleOf(s)}"></option>`).join("");
    $("notables").innerHTML = NOTABLES
      .filter(([name, year]) => state.tracks.some((s) => s.name === name && s.year === year))
      .map(([name, year]) => `<button class="chip" type="button" data-name="${name}" data-year="${year}">${ZH[name] || name} ${year}</button>`)
      .join("");
  } catch (_) {
    $("histSearch").placeholder = "历史路径没能加载";
    $("histSearch").disabled = true;
  }
}

function showHistory(track) {
  const start = new Date(`${track.start}:00Z`);
  const month = start.getUTCMonth() + 1 + (start.getUTCDate() - 1) / 31;
  const first = track.pts[0];
  state.month = clamp(month, 1, 12.95);
  $("month").value = String(state.month);
  state.yearPlaying = false;
  refreshEnv();
  state.history = track;
  globe.scene.history = track.pts.map(([hour, lon, lat, v]) => ({ hour: hour - first[0], lon, lat, v }));
  $("noisy").checked = false;
  launch({ lat: first[2], lon: first[1], seed: 1 }, { quiet: true });
  const sim = state.storm;
  const landfall = sim.events.find((e) => e.type === "landfall");
  $("histInfo").hidden = false;
  $("histInfo").innerHTML = `
    <b>${titleOf(track)}</b>　白边路径是实况，另一条是模型从同一地点、同一日期出发的结果。
    <table class="table">
      <tr><th></th><th>实况</th><th>模拟</th></tr>
      <tr><td>巅峰风速</td><td>${track.peak.toFixed(0)} m/s</td><td>${sim.peak.toFixed(0)} m/s</td></tr>
      <tr><td>最低气压</td><td>${track.pmin} hPa</td><td>${sim.pmin} hPa</td></tr>
      <tr><td>持续</td><td>${((track.pts[track.pts.length - 1][0] - first[0]) / 24).toFixed(1)} 天</td><td>${(sim.hours / 24).toFixed(1)} 天</td></tr>
      <tr><td>模拟登陆</td><td colspan="2">${landfall ? `${fmtLat(landfall.lat)} ${fmtLon(landfall.lon)}` : "没有登陆"}</td></tr>
    </table>
    模型只知道"这个月份通常是什么样"，不知道那几天真实的天气（高空槽、相邻台风、副高的进退）。两条路差得越远，说明当时的大气越不寻常。`;
  const mid = track.pts[Math.floor(track.pts.length / 2)];
  globe.flyTo(mid[1], mid[2], 1.9);
  toast(`${titleOf(track)}：实况 ${track.peak.toFixed(0)} m/s，模拟 ${sim.peak.toFixed(0)} m/s`);
}

// ---------- scenarios ----------

const PRESETS = [
  ["🌀", "西行登陆华南", "西北太平洋 · 8 月。副高挡在北边，一路向西", 14, 142, 8.5, "WNP"],
  ["↩️", "转向北上", "西北太平洋 · 9 月。绕着副高西缘拐弯", 16, 150, 9.5, "WNP"],
  ["🌊", "佛得角型飓风", "北大西洋 · 9 月。横渡整个大西洋的长跑选手", 12, -30, 9.2, "NATL"],
  ["🛢️", "墨西哥湾飓风", "北大西洋 · 8 月底。暖水上的短促冲刺", 23, -86, 8.7, "NATL"],
  ["🌮", "东太平洋飓风", "东北太平洋 · 7 月。生得多，登陆得少", 12, -100, 7.5, "ENP"],
  ["🌧️", "孟加拉湾风暴", "北印度洋 · 11 月。季风退去后的第二个季节", 10, 90, 11.2, "NIO"],
  ["🏝️", "袭向马达加斯加", "西南印度洋 · 2 月。南半球的风暴顺时针转", -13, 72, 2.2, "SWIO"],
  ["🦘", "澳大利亚西北", "澳大利亚海域 · 1 月", -13, 122, 1.5, "AUS"],
  ["🥥", "南太平洋气旋", "南太平洋 · 2 月", -13, 172, 2.5, "SPAC"],
  ["🧊", "为什么南大西洋没有台风", "实验：把扰动放在巴西以东", -15, -25, 3.2, "SATL"],
  ["⚖️", "为什么赤道上没有台风", "实验：把扰动放在赤道上", 1, 150, 8.5, "WNP"]
];

function runPreset(index) {
  const [, , , lat, lon, month, basin] = PRESETS[index];
  state.month = month;
  $("month").value = String(month);
  state.yearPlaying = false;
  state.history = null;
  globe.scene.history = null;
  $("histInfo").hidden = true;
  $("noisy").checked = false;
  refreshEnv();
  globe.flyTo(BASINS[basin].view[0], BASINS[basin].view[1], 1.8);
  setPlacing(false);
  launch({ lat, lon, seed: 1 });
}

function setPlacing(on) {
  state.placing = on;
  globe.scene.placing = on;
  $("globe").classList.toggle("is-placing", on);
  $("place").classList.toggle("is-on", on);
  $("place").textContent = on ? "在海面上点一下…" : "✛ 放置扰动";
}

// ---------- wiring ----------

function padGlobe() {
  const wide = window.innerWidth > 1080;
  const host = $("globe");
  host.dataset.padLeft = wide ? "348" : "0";
  host.dataset.padRight = wide ? "348" : "0";
  host.dataset.padBottom = wide ? "84" : "76";
  globe?.relayout();
}

async function main() {
  const [landBuffer, coast] = await Promise.all([
    fetch("data/land.bin").then((r) => r.arrayBuffer()),
    fetch("data/coast.json").then((r) => r.json())
  ]);
  state.land = makeLand(new Uint8Array(landBuffer));
  padGlobe();
  globe = createGlobe($("globe"), { land: state.land, coast });
  padGlobe();
  $("loading").hidden = true;

  $("basins").innerHTML = Object.entries(BASINS)
    .filter(([, b]) => b.target)
    .map(([key, b]) => `<button class="chip" type="button" data-basin="${key}">${b.name}</button>`).join("");
  $("layers").innerHTML = [...Object.entries(LAYERS).map(([key, l]) => [key, l.name]), ["none", "不显示"]]
    .map(([key, name]) => `<button type="button" data-layer="${key}" aria-pressed="${key === state.layer}">${name}</button>`).join("");
  $("presets").innerHTML = PRESETS
    .map(([icon, name, desc], i) => `<button class="preset" type="button" data-preset="${i}"><i>${icon}</i><b>${name}</b><span>${desc}</span></button>`).join("");
  $("scale").innerHTML = INTENSITY_STEPS.slice(0, 6)
    .map(([bound, colour, label]) => `<span><i style="background:${colour}"></i>${label}${bound ? ` ≥${bound}` : ""}</span>`).join("");

  refreshEnv();
  setPlacing(true);

  globe.on("pick", (ll) => {
    if (!state.placing) {
      return;
    }
    if (state.land.isLand(ll.lat, ll.lon)) {
      toast("这里是陆地。台风生在暖洋面上，换片海试试");
      return;
    }
    state.history = null;
    globe.scene.history = null;
    $("histInfo").hidden = true;
    setPlacing(false);
    launch({ lat: ll.lat, lon: ll.lon, seed: Math.floor(Math.random() * 1e9) + 1 });
  });

  globe.on("hover", (ll, x, y) => {
    const probe = $("probe");
    if (!ll || !state.env) {
      probe.hidden = true;
      return;
    }
    probe.hidden = false;
    probe.style.left = `${x}px`;
    probe.style.top = `${y}px`;
    const where = `${fmtLat(ll.lat)} ${fmtLon(ll.lon)}`;
    if (state.land.isLand(ll.lat, ll.lon)) {
      probe.innerHTML = `${where} · 陆地`;
      return;
    }
    const e = state.env;
    const u = e.sample("u", ll.lat, ll.lon);
    const v = e.sample("v", ll.lat, ll.lon);
    probe.innerHTML = `${where}<br>海温 <b>${e.sample("sst", ll.lat, ll.lon).toFixed(1)}</b> °C · 切变 <b>${e.sample("shear", ll.lat, ll.lon).toFixed(0)}</b> m/s<br>引导气流 向${heading(u, v)} <b>${Math.hypot(u, v).toFixed(1)}</b> m/s`;
  });

  $("basins").addEventListener("click", (event) => {
    const key = event.target.dataset?.basin;
    if (key) {
      globe.flyTo(BASINS[key].view[0], BASINS[key].view[1], 1.5);
    }
  });
  $("layers").addEventListener("click", (event) => {
    const key = event.target.dataset?.layer;
    if (key) {
      state.layer = key;
      document.querySelectorAll("#layers button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.layer === key)));
      refreshEnv();
    }
  });
  $("presets").addEventListener("click", (event) => {
    const button = event.target.closest("[data-preset]");
    if (button) {
      runPreset(Number(button.dataset.preset));
    }
  });
  $("month").addEventListener("input", () => {
    state.month = Number($("month").value);
    state.yearPlaying = false;
    $("yearPlay").textContent = "▶ 让四季流转一遍";
    globe.stopSpin();
    environmentChanged();
  });
  $("yearPlay").addEventListener("click", () => {
    state.yearPlaying = !state.yearPlaying;
    if (state.yearPlaying && state.month >= 12.9) {
      state.month = 1;
    }
    $("yearPlay").textContent = state.yearPlaying ? "❚❚ 暂停" : "▶ 让四季流转一遍";
  });
  $("windOn").addEventListener("change", () => globe.setWind($("windOn").checked));

  const knobText = {
    kEnso: (v) => (v > 0.4 ? `厄尔尼诺 +${v.toFixed(1)}` : v < -0.4 ? `拉尼娜 ${v.toFixed(1)}` : "中性"),
    kSst: (v) => `${v > 0 ? "+" : v < 0 ? "−" : "±"}${Math.abs(v).toFixed(1)} °C`,
    kHigh: (v) => (v ? `${v > 0 ? "偏强 +" : "偏弱 "}${v}` : "常年"),
    kWest: (v) => (v ? `${v > 0 ? "西伸" : "东退"} ${Math.abs(v)}°` : "常年")
  };
  const knobKeys = { kEnso: "enso", kSst: "sst", kHigh: "high", kWest: "west" };
  const outputs = { kEnso: "oEnso", kSst: "oSst", kHigh: "oHigh", kWest: "oWest" };
  const syncKnobs = () => {
    for (const [id, key] of Object.entries(knobKeys)) {
      const value = Number($(id).value);
      state.knobs = { ...state.knobs, [key]: value };
      $(outputs[id]).textContent = knobText[id](value);
    }
  };
  for (const id of Object.keys(knobKeys)) {
    $(id).addEventListener("input", () => {
      syncKnobs();
      globe.stopSpin();
      environmentChanged();
    });
  }
  $("knobReset").addEventListener("click", () => {
    for (const id of Object.keys(knobKeys)) {
      $(id).value = "0";
    }
    syncKnobs();
    environmentChanged();
  });

  $("place").addEventListener("click", () => setPlacing(!state.placing));
  $("reroll").addEventListener("click", () => {
    if (state.origin) {
      $("noisy").checked = true;
      launch({ ...state.origin, seed: Math.floor(Math.random() * 1e9) + 1 });
    }
  });
  $("noisy").addEventListener("change", () => state.origin && launch(state.origin));
  $("size").addEventListener("input", () => {
    $("oSize").textContent = `${$("size").value} km`;
    if (state.origin) {
      launch(state.origin, { keepTime: true, quiet: true });
    }
  });

  $("play").addEventListener("click", () => {
    if (!state.playing) {
      if (state.season && state.day >= 372) {
        state.day = 0;
      } else if (state.storm && state.hour >= state.storm.hours) {
        state.hour = 0;
      }
    }
    setPlaying(!state.playing);
  });
  $("time").addEventListener("input", () => {
    setPlaying(false);
    if (state.season) {
      state.day = Number($("time").value);
      renderSeasonClock();
    } else {
      state.hour = Number($("time").value);
      renderStorm();
    }
  });

  $("seasonRun").addEventListener("click", runSeason);
  $("seasonClear").addEventListener("click", () => {
    state.season = null;
    globe.scene.season = null;
    $("seasonOut").hidden = true;
    $("dock").hidden = true;
    $("badge").textContent = "等待扰动";
    $("vNow").textContent = "—";
    $("vAlt").textContent = "";
    $("why").textContent = "点「放置扰动」，然后在地球的海面上点一下。";
    setPlaying(false);
  });

  const pickHistory = (name, year) => {
    const track = state.tracks?.find((s) => s.name === name && s.year === year);
    if (track) {
      setPlacing(false);
      showHistory(track);
    }
  };
  $("notables").addEventListener("click", (event) => {
    const d = event.target.dataset;
    if (d?.name) {
      pickHistory(d.name, Number(d.year));
    }
  });
  $("histSearch").addEventListener("change", () => {
    const q = $("histSearch").value.trim().toLowerCase();
    if (!q || !state.tracks) {
      return;
    }
    const match = state.tracks.find((s) => titleOf(s).toLowerCase() === q) ||
      [...state.tracks].reverse().find((s) => titleOf(s).toLowerCase().includes(q));
    if (match) {
      pickHistory(match.name, match.year);
    } else {
      toast("没找到这个台风。试试英文名或年份");
    }
  });

  window.addEventListener("resize", () => {
    padGlobe();
    drawChart();
  });
  document.addEventListener("keydown", (event) => {
    if (event.code === "Space" && !/INPUT|SELECT|BUTTON|TEXTAREA/.test(event.target.tagName) && !$("dock").hidden) {
      event.preventDefault();
      $("play").click();
    }
    if (event.key === "Escape") {
      setPlacing(false);
    }
  });

  requestAnimationFrame(tick);
  toast("在海面上点一下，放下一个热带扰动", 5000);
  loadTracks();
}

main().catch((error) => {
  $("loading").textContent = `加载失败：${error.message}。请通过网页服务器打开（见 README）。`;
});
