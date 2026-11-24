/*
 * Fake Pi data for building the UI without a Raspberry Pi.
 * Returns exactly the same shape as GET /api/stats from server.py.
 *
 * Use:  index.html?demo            (normal scenario)
 *       index.html?demo=hot        (pick a scenario)
 * or click "Use demo data" in the connect dialog.
 */
(() => {
  "use strict";

  const GB = 1024 ** 3, MB = 1024 ** 2;
  const INTERVAL = 2;
  const HISTORY = 150;

  // Each scenario tweaks the generated numbers so you can see every UI state.
  const SCENARIOS = {
    normal:    { label: "Normal",                cpu: 22, cpuSwing: 15, temp: 48, mem: 0.32, disk: 24, net: 1 },
    busy:      { label: "Busy (high CPU)",       cpu: 78, cpuSwing: 12, temp: 66, mem: 0.58, disk: 24, net: 6 },
    hot:       { label: "Overheating + throttled", cpu: 92, cpuSwing: 6, temp: 83, mem: 0.61, disk: 24, net: 2,
                 throttled: { raw: "0x80006", active: ["ARM frequency capped", "Currently throttled"], past: ["Throttling has occurred"] } },
    undervolt: { label: "Under-voltage (bad PSU)", cpu: 35, cpuSwing: 20, temp: 52, mem: 0.40, disk: 30, net: 1,
                 throttled: { raw: "0x50000", active: [], past: ["Under-voltage has occurred", "Throttling has occurred"] } },
    full:      { label: "Low memory + disk full", cpu: 40, cpuSwing: 15, temp: 58, mem: 0.95, disk: 97, net: 1, swap: 0.88 },
    idle:      { label: "Idle",                  cpu: 2,  cpuSwing: 2,  temp: 41, mem: 0.12, disk: 12, net: 0.05 },
    eight:     { label: "8 cores, no sensors",   cpu: 35, cpuSwing: 25, temp: null, mem: 0.45, disk: 50, net: 3, cores: 8, noVcgencmd: true },
    offline:   { label: "Offline (API down)",    offline: true },
  };

  let scenario = "normal";
  let t0 = Date.now() / 1000;
  let history = [];
  let last = null;
  const rand = (a, b) => a + Math.random() * (b - a);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const gauss = (m, s) => m + s * (Math.random() + Math.random() + Math.random() - 1.5) * 1.15;

  function gen(now) {
    const s = SCENARIOS[scenario];
    const ncores = s.cores || 4;
    const k = (now - t0) / 20;
    const base = s.cpu + s.cpuSwing * Math.sin(k) + rand(-s.cpuSwing / 3, s.cpuSwing / 3);
    const cores = Array.from({ length: ncores }, () => clamp(base + rand(-12, 15), 0.5, 100));
    const cpu = cores.reduce((a, b) => a + b, 0) / ncores;
    const temp = s.temp == null ? null : +(s.temp + (cpu - s.cpu) * 0.15 + rand(-0.5, 0.5)).toFixed(1);
    const memTotal = 8 * GB;
    const memUsed = Math.round(memTotal * clamp(s.mem + 0.03 * Math.sin(k / 3) + rand(-0.005, 0.005), 0.02, 0.995));
    const rx = Math.abs(s.net * (180e3 + 150e3 * Math.sin(k * 1.7) + rand(-40e3, 90e3)));
    const tx = Math.abs(s.net * (40e3 + 30e3 * Math.sin(k * 1.3) + rand(-10e3, 30e3)));
    const ioR = Math.abs(gauss(200e3, 150e3)) * (s.cpu / 25);
    const ioW = Math.abs(gauss(400e3, 300e3)) * (s.cpu / 25);
    const maxF = 2400, minF = 1500;
    const capped = s.throttled && s.throttled.active.length;
    const freq = cores.map((c) => (capped ? 1000 : c > 50 ? maxF : minF));

    const names = ["python3", "Xorg", "chromium", "node", "pihole-FTL", "dockerd", "sshd",
      "systemd", "lighttpd", "containerd", "bash", "rsyslogd"];
    const top = names.map((n, i) => {
      const rss = Math.round(rand(8, 300) * MB * (s.mem / 0.32));
      return {
        pid: 400 + i * 37, name: n, cpu: +Math.abs(gauss(cpu / (i + 1.5), 2)).toFixed(1), rss,
        mem: +(rss / memTotal * 100).toFixed(1), user: i % 3 ? "pi" : "root",
        cmd: `/usr/bin/${n}${i === 3 ? " /home/pi/app/server.js --port 3000" : ""}`,
      };
    }).sort((a, b) => b.cpu - a.cpu);

    const rootTotal = 59e9, rootUsed = rootTotal * s.disk / 100;
    const swapTotal = 512 * MB, swapUsed = swapTotal * (s.swap || 0.02);

    return {
      time: now,
      interval: INTERVAL,
      info: {
        hostname: "raspberrypi", model: `Raspberry Pi 5 Model B Rev 1.0 (demo: ${s.label})`,
        os: "Debian GNU/Linux 12 (bookworm)", kernel: "6.6.51+rpt-rpi-2712", arch: "aarch64",
        cpu_count: ncores, ips: ["192.168.1.42", "10.0.0.5"], python: "3.11.2",
      },
      cpu: {
        percent: +cpu.toFixed(1), per_core: cores.map((c) => +c.toFixed(1)),
        freq, freq_max: maxF, freq_min: minF,
      },
      temp,
      voltage: s.noVcgencmd ? null : (scenario === "undervolt" ? 0.7812 : 0.8732),
      throttled: s.noVcgencmd ? null : (s.throttled || { raw: "0x0", active: [], past: [] }),
      memory: {
        total: memTotal, used: memUsed, available: memTotal - memUsed, cached: Math.round(memTotal * 0.18),
        percent: +(memUsed / memTotal * 100).toFixed(1),
        swap_total: swapTotal, swap_used: swapUsed, swap_percent: +(swapUsed / swapTotal * 100).toFixed(1),
      },
      disks: [
        { device: "/dev/mmcblk0p2", mount: "/", fs: "ext4", total: rootTotal, used: rootUsed, free: rootTotal - rootUsed, percent: s.disk },
        { device: "/dev/mmcblk0p1", mount: "/boot/firmware", fs: "vfat", total: 535e6, used: 78e6, free: 457e6, percent: 14.6 },
        { device: "/dev/sda1", mount: "/mnt/storage", fs: "ext4", total: 1e12, used: 6.1e11, free: 3.9e11, percent: 61 },
      ],
      disk_io: { read: ioR, write: ioW },
      network: {
        rx_rate: rx, tx_rate: tx, interfaces: [
          { name: "eth0", rx_rate: rx, tx_rate: tx, rx_total: 8.2e9, tx_total: 1.3e9 },
          { name: "wlan0", rx_rate: 0, tx_rate: 0, rx_total: 4.1e6, tx_total: 9.8e5 },
        ],
      },
      load: [+(cpu / 25).toFixed(2), +(cpu / 28).toFixed(2), +(cpu / 33).toFixed(2)],
      procs: { running: Math.max(1, Math.round(cpu / 20)), total: 187, top },
      uptime: 3 * 86400 + 5 * 3600 + (now - t0),
    };
  }

  function point(d) {
    return { t: d.time, cpu: d.cpu.percent, temp: d.temp, mem: d.memory.percent,
      rx: d.network.rx_rate, tx: d.network.tx_rate, io_r: d.disk_io.read, io_w: d.disk_io.write };
  }

  function backfill() {
    history = [];
    const now = Date.now() / 1000;
    for (let i = HISTORY; i > 0; i--) history.push(point(gen(now - i * INTERVAL)));
  }

  window.PiMock = {
    SCENARIOS,
    get scenario() { return scenario; },
    setScenario(name) {
      if (!SCENARIOS[name]) name = "normal";
      scenario = name;
      if (!SCENARIOS[name].offline) backfill();
    },
    // Mimics fetch("/api/stats[?history=1]").json()
    async stats(withHistory) {
      await new Promise((r) => setTimeout(r, 60)); // tiny fake network delay
      if (SCENARIOS[scenario].offline) throw new Error("demo: offline");
      const d = gen(Date.now() / 1000);
      history.push(point(d));
      if (history.length > HISTORY) history.shift();
      last = d;
      return withHistory ? { ...d, history: history.slice() } : d;
    },
  };
  backfill();
})();
