(() => {
  "use strict";

  const MAX_POINTS = 150;
  const $ = (id) => document.getElementById(id);
  let history = [];
  let intervalMs = 2000;
  let lastOk = 0;
  let hoverSlot = null; // shared across all strips

  // ------------------------------------------------------------------ format
  const fmtBytes = (b, d = 1) => {
    if (b == null || isNaN(b)) return "–";
    const u = ["B", "KB", "MB", "GB", "TB"];
    let i = 0;
    while (Math.abs(b) >= 1024 && i < u.length - 1) { b /= 1024; i++; }
    return `${b.toFixed(i === 0 ? 0 : d)} ${u[i]}`;
  };
  const fmtRate = (b) => fmtBytes(b) + "/s";
  const fmtUptime = (s) => {
    if (s == null) return "–";
    s = Math.floor(s);
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    return d ? `${d}d ${h}h ${m}m` : h ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
  };
  const fmtMHz = (m) => (m == null ? "–" : m >= 1000 ? `${(m / 1000).toFixed(2)} GHz` : `${Math.round(m)} MHz`);
  const fmtClock = (t) => new Date(t * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const level = (v, warn, bad) => (v == null ? "ok" : v >= bad ? "bad" : v >= warn ? "warn" : "ok");
  const setLevel = (el, lv) => { el.classList.toggle("is-warn", lv === "warn"); el.classList.toggle("is-bad", lv === "bad"); };
  const reducedMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ------------------------------------------------------------------ theme
  const root = document.documentElement;
  // ?theme=light|dark forces a theme (used when the dashboard is embedded in the landing page)
  const urlTheme = new URLSearchParams(location.search).get("theme");
  const storedTheme = (urlTheme === "light" || urlTheme === "dark") ? urlTheme
    : (() => { try { return localStorage.getItem("pi-theme"); } catch (e) { return null; } })();
  const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  root.dataset.theme = storedTheme || (prefersDark ? "dark" : "light");
  $("theme-toggle").addEventListener("click", () => {
    root.dataset.theme = root.dataset.theme === "light" ? "dark" : "light";
    try { localStorage.setItem("pi-theme", root.dataset.theme); } catch (e) { /* ignore */ }
    drawAll();
  });

  // GPIO header pins (identity only)
  $("pins").innerHTML = "<i></i>".repeat(40);

  // ------------------------------------------------------------------ strips
  const STRIPS = {
    cpu:  { series: [{ key: "cpu", color: "--plot-1" }], min: 0, max: 100, fmt: (v) => `${v.toFixed(0)}%`, lv: (v) => level(v, 70, 90) },
    temp: { series: [{ key: "temp", color: "--plot-1" }], min: 30, max: 90, fmt: (v) => `${v.toFixed(1)} °C`, lv: (v) => level(v, 70, 80),
            mark: { at: 80, label: "Slows down at 80 °C" } },
    mem:  { series: [{ key: "mem", color: "--plot-1" }], min: 0, max: 100, fmt: (v) => `${v.toFixed(0)}%`, lv: (v) => level(v, 80, 92) },
    net:  { series: [{ key: "rx", color: "--plot-1" }, { key: "tx", color: "--plot-2" }], min: 0, fmt: fmtRate },
    io:   { series: [{ key: "io_r", color: "--plot-1" }, { key: "io_w", color: "--plot-2" }], min: 0, fmt: fmtRate },
  };

  const slotX = (slot, w) => (slot / (MAX_POINTS - 1)) * w;
  const idxToSlot = (i) => MAX_POINTS - history.length + i;

  class Strip {
    constructor(el, cfg) {
      this.el = el;
      this.cfg = cfg;
      this.plot = el.querySelector(".strip-plot");
      this.canvas = document.createElement("canvas");
      this.plot.appendChild(this.canvas);
      this.ctx = this.canvas.getContext("2d");
      this.vals = cfg.series.map((s) => el.querySelector(`[data-val="${s.key}"]`));
      new ResizeObserver(() => this.draw()).observe(this.plot);
      const move = (clientX) => {
        const r = this.plot.getBoundingClientRect();
        const fx = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
        hoverSlot = Math.round(fx * (MAX_POINTS - 1));
        drawAll();
      };
      this.plot.addEventListener("mousemove", (e) => move(e.clientX));
      this.plot.addEventListener("touchmove", (e) => { move(e.touches[0].clientX); }, { passive: true });
      this.plot.addEventListener("mouseleave", () => { hoverSlot = null; drawAll(); });
      this.plot.addEventListener("touchend", () => { hoverSlot = null; drawAll(); });
    }

    bounds() {
      const c = this.cfg;
      let max = c.max;
      if (max == null) {
        max = 0;
        for (const p of history) for (const s of c.series) if (p[s.key] > max) max = p[s.key];
        max = niceMax(Math.max(max * 1.15, 1024));
      }
      return { min: c.min, max };
    }

    draw() {
      const { canvas, ctx, cfg } = this;
      const dpr = window.devicePixelRatio || 1;
      const w = this.plot.clientWidth, h = this.plot.clientHeight;
      if (!w || !h) return;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const padT = 20, padB = 6;   // keeps the line clear of the scale label
      const ph = h - padT - padB;
      const { min, max } = this.bounds();
      const y = (v) => padT + ph - ((Math.max(min, Math.min(max, v)) - min) / (max - min)) * ph;
      const ink2 = cssVar("--ink-2");
      ctx.font = `500 12px ${cssVar("--font")}`;

      // scale: top value printed at the right edge, one faint midline
      ctx.strokeStyle = cssVar("--rule"); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, Math.round(y((min + max) / 2)) + 0.5); ctx.lineTo(w, Math.round(y((min + max) / 2)) + 0.5); ctx.stroke();
      ctx.fillStyle = ink2; ctx.textAlign = "right"; ctx.textBaseline = "top";
      const topLabel = cfg.max != null && cfg.key !== "net" ? cfg.fmt(max).replace(/\.0(?= |%)/, "") : fmtBytes(max, 0) + "/s";
      ctx.fillText(topLabel, w - 2, 1);

      // reference line (e.g. throttle temperature)
      if (cfg.mark) {
        const my = Math.round(y(cfg.mark.at)) + 0.5;
        ctx.strokeStyle = cssVar("--bad"); ctx.globalAlpha = 0.7; ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.moveTo(0, my); ctx.lineTo(w, my); ctx.stroke();
        ctx.setLineDash([]); ctx.globalAlpha = 1;
      }

      // series
      cfg.series.forEach((s, si) => {
        const pts = [];
        history.forEach((p, i) => { if (p[s.key] != null) pts.push([slotX(idxToSlot(i), w), y(p[s.key])]); });
        if (pts.length < 2) return;
        if (si === 0) {
          ctx.beginPath(); ctx.moveTo(pts[0][0], padT + ph);
          pts.forEach(([px, py]) => ctx.lineTo(px, py));
          ctx.lineTo(pts[pts.length - 1][0], padT + ph); ctx.closePath();
          ctx.fillStyle = cssVar("--plot-fill"); ctx.fill();
        }
        ctx.beginPath();
        pts.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
        ctx.strokeStyle = cssVar(s.color); ctx.lineWidth = si === 0 ? 1.5 : 2; ctx.lineJoin = "round";
        ctx.stroke();
      });

      // reference label drawn last, on a solid backing, so the data line never crosses it
      if (cfg.mark) {
        const my = Math.round(y(cfg.mark.at)) + 0.5;
        ctx.textAlign = "left"; ctx.textBaseline = "middle";
        const tw = ctx.measureText(cfg.mark.label).width;
        ctx.fillStyle = cssVar("--page");
        ctx.fillRect(0, my - 8, tw + 10, 16);
        ctx.fillStyle = cssVar("--bad");
        ctx.fillText(cfg.mark.label, 4, my + 0.5);
      }

      // shared hover line + readouts
      const idx = hoverIndex();
      if (idx != null) {
        const hx = Math.round(slotX(idxToSlot(idx), w)) + 0.5;
        ctx.strokeStyle = ink2; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(hx, 0); ctx.lineTo(hx, h); ctx.stroke();
        cfg.series.forEach((s) => {
          const v = history[idx][s.key];
          if (v == null) return;
          ctx.beginPath(); ctx.arc(hx, y(v), 3.5, 0, Math.PI * 2);
          ctx.fillStyle = cssVar(s.color); ctx.fill();
        });
      }
      const point = idx != null ? history[idx] : history[history.length - 1];
      cfg.series.forEach((s, i) => {
        const el = this.vals[i];
        const v = point ? point[s.key] : null;
        el.textContent = v == null ? (s.key === "temp" ? "No sensor" : "–") : cfg.fmt(v);
        setLevel(el, cfg.lv ? cfg.lv(v) : "ok");
      });
    }
  }

  function hoverIndex() {
    if (hoverSlot == null || !history.length) return null;
    const i = hoverSlot - (MAX_POINTS - history.length);
    return Math.max(0, Math.min(history.length - 1, i));
  }

  function niceMax(v) {
    const exp = Math.pow(10, Math.floor(Math.log10(v)));
    const n = v / exp;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * exp;
  }

  const strips = Object.entries(STRIPS).map(([key, cfg]) => {
    cfg.key = key;
    return new Strip(document.querySelector(`.strip[data-chart="${key}"]`), cfg);
  });

  function drawAxis() {
    const spanMin = ((MAX_POINTS - 1) * intervalMs) / 60000;
    const narrow = $("axis-ticks").clientWidth < 520;
    const ticks = [];
    const step = spanMin > 8 || narrow ? 2 : 1;
    for (let m = Math.floor(spanMin); m >= 1; m -= step) ticks.push(m);
    $("axis-ticks").innerHTML =
      ticks.map((m) => `<span style="left:${(1 - m / spanMin) * 100}%">${m} min${narrow ? "" : " ago"}</span>`).join("") +
      `<span style="left:100%">Now</span>`;
    const idx = hoverIndex();
    $("hover-time").textContent = idx != null ? `Showing ${fmtClock(history[idx].t)}` : "Point at a chart to read any moment";
  }

  function drawAll() {
    strips.forEach((s) => s.draw());
    drawAxis();
  }

  // ------------------------------------------------------------------ board
  function blinkAct() {
    for (const led of [$("act-led"), $("link-led")]) {
      led.classList.remove("dead");
      led.classList.add("on");
      if (!reducedMotion) setTimeout(() => led.classList.remove("on"), 140);
    }
  }

  function render(d) {
    const info = d.info || {};
    const cpu = d.cpu || {};
    const mem = d.memory || {};
    const net = d.network || {};

    $("hostname").textContent = info.hostname || "raspberrypi";
    $("model").textContent = [info.model, info.os].filter(Boolean).join(", running ");
    document.title = `${info.hostname || "Pi"} – Pi Dashboard`;
    $("uptime").textContent = fmtUptime(d.uptime);
    $("ip").textContent = (info.ips && info.ips[0]) || "–";

    // Processor
    const cpuEl = $("cpu-pct");
    cpuEl.textContent = Math.round(cpu.percent || 0);
    setLevel(cpuEl.parentElement, level(cpu.percent, 70, 90));
    if (d.temp != null) {
      $("temp").textContent = d.temp.toFixed(1);
      $("temp-wrap").hidden = false;
      setLevel($("temp-wrap"), level(d.temp, 70, 80));
    } else {
      $("temp-wrap").hidden = true;
    }
    const freqs = (cpu.freq || []).filter((f) => f != null);
    const avgF = freqs.length ? freqs.reduce((a, b) => a + b, 0) / freqs.length : null;
    const load = d.load ? `load ${d.load.map((l) => l.toFixed(2)).join(", ")}` : "";
    $("cpu-sub").textContent = `${info.cpu_count || "?"} cores${avgF ? ` at ${fmtMHz(avgF)}` : ""}${load ? `, ${load}` : ""}`;

    const cores = cpu.per_core || [];
    const coresEl = $("cores");
    coresEl.style.setProperty("--cols", Math.min(cores.length, 8) > 4 ? Math.ceil(cores.length / 2) : cores.length || 4);
    if (coresEl.children.length !== cores.length) {
      coresEl.innerHTML = cores.map((_, i) => `<div class="core" title="Core ${i}"><div class="fill"></div><p class="lbl">Core ${i}<span></span></p></div>`).join("");
    }
    cores.forEach((v, i) => {
      const c = coresEl.children[i];
      c.querySelector(".fill").style.height = `${Math.min(100, v)}%`;
      c.querySelector(".lbl span").textContent = `${Math.round(v)}%`;
      const lv = level(v, 70, 90);
      c.classList.toggle("warn", lv === "warn");
      c.classList.toggle("bad", lv === "bad");
      c.classList.toggle("high", v > 68);   // fill has risen behind the label: switch label to light text
    });

    // Memory
    const memEl = $("mem-pct");
    memEl.textContent = Math.round(mem.percent || 0);
    const mlv = level(mem.percent, 80, 92);
    setLevel(memEl.parentElement, mlv);
    $("mem-sub").textContent = `${fmtBytes(mem.used)} of ${fmtBytes(mem.total)} in use`;
    $("mem-bar").style.width = `${mem.percent || 0}%`;
    setLevel($("mem-bar"), mlv);
    $("swap-sub").textContent = mem.swap_total ? `Swap ${fmtBytes(mem.swap_used)} of ${fmtBytes(mem.swap_total)}` : "Swap is off";

    // SD card (root filesystem)
    const disks = d.disks || [];
    const rootDisk = disks.find((x) => x.mount === "/") || disks[0];
    if (rootDisk) {
      const lv = level(rootDisk.percent, 80, 92);
      $("sd-pct").textContent = Math.round(rootDisk.percent);
      setLevel($("sd-pct").parentElement, lv);
      $("sd-sub").textContent = `${fmtBytes(rootDisk.free)} free`;
      $("sd-bar").style.width = `${rootDisk.percent}%`;
      setLevel($("sd-bar"), lv);
    }
    $("io-r").textContent = fmtRate((d.disk_io || {}).read);
    $("io-w").textContent = fmtRate((d.disk_io || {}).write);

    // USB ports: external drives
    const external = disks.filter((x) => x.device.startsWith("/dev/sd") || x.device.startsWith("/dev/nvme"));
    [0, 1].forEach((i) => {
      const port = $(`usb-${i}`);
      const x = external[i];
      port.classList.toggle("empty", !x);
      port.querySelector(".port-val").innerHTML = x
        ? `<b>${Math.round(x.percent)}%</b> of ${fmtBytes(x.total, 0)}<br>${esc(x.mount)}`
        : "Nothing plugged in";
    });

    // Ethernet
    $("net-rx").textContent = fmtRate(net.rx_rate);
    $("net-tx").textContent = fmtRate(net.tx_rate);

    // Power corner
    const th = d.throttled;
    const pwr = $("pwr-led");
    let text;
    if (!th) {
      text = "Power and throttling status is only available on Raspberry Pi OS.";
      pwr.classList.remove("blink");
    } else if (th.active.length) {
      text = `<b>Slowed down now:</b> ${esc(th.active.join(", ").toLowerCase())}.`;
      pwr.classList.add("blink");
    } else if (th.past.length) {
      text = `<b>Running normally.</b> Since boot: ${esc(th.past.join(", ").toLowerCase())}.`;
      pwr.classList.remove("blink");
    } else {
      text = "Power is good and the processor runs at full speed.";
      pwr.classList.remove("blink");
    }
    if (d.voltage != null) text += ` Core ${d.voltage.toFixed(3)} V.`;
    $("power-text").innerHTML = text;

    // Drives list
    $("disks").innerHTML = disks.map((x) => {
      const lv = level(x.percent, 80, 92);
      const cls = lv === "ok" ? "" : `is-${lv}`;
      return `<li>
        <div class="disk-top"><span class="disk-name">${esc(x.mount)}</span><span class="disk-pct ${cls}">${Math.round(x.percent)}%</span></div>
        <div class="disk-bar"><span class="${cls}" style="width:${x.percent}%"></span></div>
        <p class="disk-sub">${fmtBytes(x.used)} of ${fmtBytes(x.total)} used on ${esc(x.device)} (${esc(x.fs)})</p>
      </li>`;
    }).join("") || `<li class="disk-sub">No drives reported.</li>`;

    // System facts
    const ifaces = (net.interfaces || []).slice(0, 3)
      .map((i) => `${esc(i.name)}: ${fmtBytes(i.rx_total)} in, ${fmtBytes(i.tx_total)} out`).join("<br>");
    $("sysinfo").innerHTML = `
      <dt>Operating system</dt><dd>${esc(info.os || "–")}</dd>
      <dt>Kernel</dt><dd>${esc(info.kernel || "–")} (${esc(info.arch || "?")})</dd>
      <dt>Addresses</dt><dd>${esc((info.ips || []).join(", ") || "–")}</dd>
      <dt>Traffic since boot</dt><dd>${ifaces || "–"}</dd>
      <dt>Clock range</dt><dd>${cpu.freq_min ? `${fmtMHz(cpu.freq_min)} to ${fmtMHz(cpu.freq_max)}` : "–"}</dd>`;

    // Processes
    const procs = d.procs || {};
    $("proc-count").textContent = `${procs.total || 0} running in total, sorted by CPU. 100% is one full core.`;
    $("proc-body").innerHTML = (procs.top || []).map((p) => {
      const lv = level(p.cpu, 50, 90);
      return `<tr>
        <td><span class="pname">${esc(p.name)}</span><span class="pid">${p.pid}</span><span class="pcmd" title="${esc(p.cmd)}">${esc(p.cmd)}</span></td>
        <td class="user">${esc(p.user)}</td>
        <td class="num"><span class="cpu ${lv === "ok" ? "" : "is-" + lv}">${p.cpu.toFixed(1)}%</span></td>
        <td class="num">${fmtBytes(p.rss)}</td>
      </tr>`;
    }).join("");
  }

  // ------------------------------------------------------------------ Pi address
  // "" = same server that served this page; "demo" = fake data from mock.js
  const DEMO = "demo";
  const store = {
    get() { try { return localStorage.getItem("pi-address"); } catch (e) { return null; } },
    set(v) { try { localStorage.setItem("pi-address", v); } catch (e) { /* ignore */ } },
    clear() { try { localStorage.removeItem("pi-address"); } catch (e) { /* ignore */ } },
  };
  const servedByPi = location.protocol.startsWith("http");

  function normalizeAddress(raw) {
    let v = (raw || "").trim().replace(/\/+$/, "");
    if (!v) return null;
    if (!/^https?:\/\//i.test(v)) v = "http://" + v;
    try {
      const u = new URL(v);
      if (!u.port && u.protocol === "http:") u.port = "8080";
      return u.origin;
    } catch (e) { return null; }
  }

  const params = new URLSearchParams(location.search);
  const stored = store.get();
  let apiBase;
  if (params.has("demo")) {
    apiBase = DEMO;
    if (params.get("demo")) window.PiMock.setScenario(params.get("demo"));
  } else {
    apiBase = normalizeAddress(params.get("pi"))
      ?? (stored === DEMO ? DEMO : normalizeAddress(stored))
      ?? (servedByPi ? "" : null);
    if (params.get("pi") && apiBase) store.set(apiBase);
  }
  let primed = false;
  let pollTimer = null;

  const dlg = $("connect");
  function openConnect(errorMsg) {
    $("connect-input").value = apiBase && apiBase !== DEMO ? apiBase.replace(/^http:\/\//, "") : "";
    $("connect-error").hidden = !errorMsg;
    $("connect-error").textContent = errorMsg || "";
    $("connect-same").hidden = !servedByPi || apiBase === "";
    if (!dlg.open) dlg.showModal();
    $("connect-input").focus();
  }
  const embedded = params.has("embed"); // ?embed hides the demo panel (landing page preview)
  function showDemoBar() {
    $("demo-bar").hidden = apiBase !== DEMO || embedded;
    document.body.classList.toggle("demo", apiBase === DEMO);
  }
  function useAddress(base) {
    apiBase = base;
    if (base) store.set(base); else store.clear();
    history = []; primed = false; lastOk = 0; hoverSlot = null;
    showDemoBar();
    setStatus("wait", "Connecting");
    clearTimeout(pollTimer);
    tick();
  }
  $("connect-form").addEventListener("submit", (e) => {
    const base = normalizeAddress($("connect-input").value);
    if (!base) { e.preventDefault(); openConnect("Enter an address like 192.168.1.42 or raspberrypi.local."); return; }
    useAddress(base);
  });
  $("connect-same").addEventListener("click", () => { dlg.close(); useAddress(""); });
  $("connect-demo").addEventListener("click", () => { dlg.close(); useAddress(DEMO); });
  $("status").addEventListener("click", () => openConnect());

  const sel = $("demo-scenario");
  sel.innerHTML = Object.entries(window.PiMock.SCENARIOS)
    .map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join("");
  sel.value = window.PiMock.scenario;
  sel.addEventListener("change", () => { window.PiMock.setScenario(sel.value); useAddress(DEMO); });
  $("demo-exit").addEventListener("click", () => {
    store.clear();
    apiBase = servedByPi ? "" : null;
    showDemoBar();
    clearTimeout(pollTimer);
    setStatus("down", "Not connected");
    openConnect();
  });
  showDemoBar();

  // ------------------------------------------------------------------ polling
  function setStatus(state, text) {
    $("status-text").textContent = text;
    for (const led of [$("act-led"), $("link-led")]) led.classList.toggle("dead", state === "down");
  }
  const sourceName = () => (apiBase === DEMO ? "demo data" : apiBase ? apiBase.replace(/^https?:\/\//, "") : location.host || "this Pi");

  async function poll(first) {
    if (apiBase == null) return false;
    try {
      let d;
      if (apiBase === DEMO) {
        d = await window.PiMock.stats(first);
      } else {
        const res = await fetch(`${apiBase}/api/stats${first ? "?history=1" : ""}`, { cache: "no-store" });
        if (!res.ok) throw new Error(res.status);
        d = await res.json();
      }
      if (d.interval) { intervalMs = d.interval * 1000; $("interval").textContent = d.interval; }
      if (first && d.history) history = d.history.slice(-MAX_POINTS);
      else if (d.time && (!history.length || d.time > history[history.length - 1].t)) {
        history.push({
          t: d.time, cpu: d.cpu.percent, temp: d.temp, mem: d.memory.percent,
          rx: d.network.rx_rate, tx: d.network.tx_rate, io_r: d.disk_io.read, io_w: d.disk_io.write,
        });
        if (history.length > MAX_POINTS) history.shift();
      }
      render(d);
      drawAll();
      lastOk = Date.now();
      setStatus("live", apiBase === DEMO ? "Showing demo data" : `Connected to ${sourceName()}`);
      blinkAct();
      return true;
    } catch (e) {
      const ago = lastOk ? `, last reading ${Math.round((Date.now() - lastOk) / 1000)}s ago` : "";
      setStatus("down", `Can't reach ${sourceName()}${ago}`);
      return false;
    }
  }

  async function tick() {
    const ok = await poll(!primed);
    if (ok) primed = true;
    pollTimer = setTimeout(tick, intervalMs);
  }

  if (apiBase == null) {
    setStatus("down", "Not connected");
    openConnect();
  } else {
    tick().then(() => {
      if (lastOk || apiBase === DEMO) return;
      openConnect(apiBase
        ? `No answer from ${apiBase}. Check that server.py is running on the Pi.`
        : "This server doesn't provide Pi data. Enter your Pi's address.");
    });
  }
})();
