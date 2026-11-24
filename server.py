#!/usr/bin/env python3
"""
Raspberry Pi system dashboard.

Zero-dependency (Python 3.7+ standard library only). Reads metrics straight
from /proc and /sys, samples them on a background thread, and serves a web
dashboard plus a JSON API.

    python3 server.py                 # http://<pi-ip>:8080
    python3 server.py --port 9000
    python3 server.py --demo          # fake data (for trying it on a non-Linux machine)
"""

import argparse
import json
import math
import os
import platform
import random
import shutil
import socket
import subprocess
import threading
import time
from collections import deque
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(ROOT, "static")
HISTORY_LEN = 150          # samples kept for charts
SAMPLE_INTERVAL = 2.0      # seconds between samples


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def read(path, default=None):
    try:
        with open(path, "r") as f:
            return f.read()
    except (OSError, IOError):
        return default


def read_int(path, default=None):
    raw = read(path)
    try:
        return int(raw.strip())
    except (AttributeError, ValueError):
        return default


CLK_TCK = os.sysconf("SC_CLK_TCK") if hasattr(os, "sysconf") else 100
PAGE_SIZE = os.sysconf("SC_PAGE_SIZE") if hasattr(os, "sysconf") else 4096


# --------------------------------------------------------------------------- #
# Static-ish system info (read once, refreshed occasionally)
# --------------------------------------------------------------------------- #
def get_os_name():
    data = read("/etc/os-release", "")
    for line in data.splitlines():
        if line.startswith("PRETTY_NAME="):
            return line.split("=", 1)[1].strip().strip('"')
    return platform.platform()


def get_model():
    model = read("/proc/device-tree/model") or read("/sys/firmware/devicetree/base/model")
    if model:
        return model.replace("\x00", "").strip()
    for line in (read("/proc/cpuinfo", "") or "").splitlines():
        if line.lower().startswith(("model name", "hardware")):
            return line.split(":", 1)[1].strip()
    return platform.machine()


def get_ip_addresses():
    ips = []
    try:
        out = subprocess.run(["hostname", "-I"], capture_output=True, text=True, timeout=2).stdout
        ips = [ip for ip in out.split() if ":" not in ip]
    except Exception:
        pass
    if not ips:
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(("10.255.255.255", 1))
            ips = [s.getsockname()[0]]
            s.close()
        except Exception:
            pass
    return ips


def get_system_info():
    return {
        "hostname": socket.gethostname(),
        "model": get_model(),
        "os": get_os_name(),
        "kernel": platform.release(),
        "arch": platform.machine(),
        "cpu_count": os.cpu_count() or 1,
        "ips": get_ip_addresses(),
        "python": platform.python_version(),
    }


# --------------------------------------------------------------------------- #
# Dynamic readings
# --------------------------------------------------------------------------- #
def read_cpu_times():
    """Return list of (idle, total) for [aggregate, cpu0, cpu1, ...]."""
    result = []
    for line in (read("/proc/stat", "") or "").splitlines():
        if not line.startswith("cpu"):
            break
        parts = line.split()
        vals = [int(v) for v in parts[1:]]
        idle = vals[3] + (vals[4] if len(vals) > 4 else 0)   # idle + iowait
        total = sum(vals[:8])                                 # exclude guest (already in user)
        result.append((idle, total))
    return result


def read_cpu_freqs():
    freqs = []
    i = 0
    while True:
        base = "/sys/devices/system/cpu/cpu%d/cpufreq/" % i
        if not os.path.isdir("/sys/devices/system/cpu/cpu%d" % i):
            break
        cur = read_int(base + "scaling_cur_freq")
        freqs.append(cur / 1000.0 if cur else None)  # MHz
        i += 1
    max_f = read_int("/sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq")
    min_f = read_int("/sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_min_freq")
    return freqs, (max_f / 1000.0 if max_f else None), (min_f / 1000.0 if min_f else None)


def read_temperature():
    """CPU/SoC temperature in °C."""
    # Prefer the zone typed as cpu/soc, else zone0
    best = None
    base = "/sys/class/thermal"
    try:
        zones = sorted(z for z in os.listdir(base) if z.startswith("thermal_zone"))
    except OSError:
        zones = []
    for z in zones:
        ztype = (read(os.path.join(base, z, "type"), "") or "").strip().lower()
        t = read_int(os.path.join(base, z, "temp"))
        if t is None:
            continue
        if best is None or "cpu" in ztype or "soc" in ztype:
            best = t / 1000.0
            if "cpu" in ztype or "soc" in ztype:
                break
    return best


def read_meminfo():
    info = {}
    for line in (read("/proc/meminfo", "") or "").splitlines():
        key, _, rest = line.partition(":")
        try:
            info[key] = int(rest.strip().split()[0]) * 1024
        except (IndexError, ValueError):
            pass
    total = info.get("MemTotal", 0)
    avail = info.get("MemAvailable", info.get("MemFree", 0))
    cached = info.get("Cached", 0) + info.get("SReclaimable", 0) + info.get("Buffers", 0)
    swap_total = info.get("SwapTotal", 0)
    swap_free = info.get("SwapFree", 0)
    return {
        "total": total,
        "used": total - avail,
        "available": avail,
        "cached": cached,
        "percent": round((total - avail) / total * 100, 1) if total else 0,
        "swap_total": swap_total,
        "swap_used": swap_total - swap_free,
        "swap_percent": round((swap_total - swap_free) / swap_total * 100, 1) if swap_total else 0,
    }


SKIP_FS = {"proc", "sysfs", "devtmpfs", "devpts", "tmpfs", "cgroup", "cgroup2", "securityfs",
           "pstore", "debugfs", "tracefs", "configfs", "fusectl", "mqueue", "hugetlbfs",
           "bpf", "autofs", "binfmt_misc", "rpc_pipefs", "overlay", "squashfs", "ramfs",
           "efivarfs", "nsfs", "fuse.gvfsd-fuse", "fuse.portal"}


def read_disks():
    disks = []
    seen = set()
    for line in (read("/proc/mounts", "") or "").splitlines():
        parts = line.split()
        if len(parts) < 3:
            continue
        dev, mnt, fs = parts[0], parts[1].replace("\\040", " "), parts[2]
        if fs in SKIP_FS or not dev.startswith("/dev/") or dev in seen:
            continue
        seen.add(dev)
        try:
            usage = shutil.disk_usage(mnt)
        except OSError:
            continue
        if usage.total == 0:
            continue
        disks.append({
            "device": dev,
            "mount": mnt,
            "fs": fs,
            "total": usage.total,
            "used": usage.used,
            "free": usage.free,
            "percent": round(usage.used / usage.total * 100, 1),
        })
    disks.sort(key=lambda d: (d["mount"] != "/", d["mount"]))
    return disks


def read_net_counters():
    """{iface: (rx_bytes, tx_bytes)} excluding loopback."""
    out = {}
    for line in (read("/proc/net/dev", "") or "").splitlines()[2:]:
        name, _, rest = line.partition(":")
        name = name.strip()
        if name == "lo":
            continue
        fields = rest.split()
        if len(fields) >= 9:
            out[name] = (int(fields[0]), int(fields[8]))
    return out


def read_disk_io():
    """Total (read_bytes, write_bytes) across whole physical disks."""
    rd = wr = 0
    for line in (read("/proc/diskstats", "") or "").splitlines():
        p = line.split()
        if len(p) < 10:
            continue
        name = p[2]
        # whole disks only: mmcblk0, sda, nvme0n1 (not partitions, loop, ram)
        if name.startswith(("loop", "ram", "zram", "dm-")):
            continue
        if name.startswith("mmcblk") and "p" in name[6:]:
            continue
        if name.startswith("nvme") and "p" in name[4:]:
            continue
        if name.startswith("sd") and name[-1].isdigit():
            continue
        rd += int(p[5]) * 512
        wr += int(p[9]) * 512
    return rd, wr


def read_uptime():
    raw = read("/proc/uptime")
    return float(raw.split()[0]) if raw else None


def read_loadavg():
    raw = read("/proc/loadavg")
    if not raw:
        return [0, 0, 0], 0, 0
    p = raw.split()
    running, total = p[3].split("/")
    return [float(p[0]), float(p[1]), float(p[2])], int(running), int(total)


THROTTLE_FLAGS = {
    0: "Under-voltage detected",
    1: "ARM frequency capped",
    2: "Currently throttled",
    3: "Soft temperature limit active",
    16: "Under-voltage has occurred",
    17: "ARM frequency capping has occurred",
    18: "Throttling has occurred",
    19: "Soft temperature limit has occurred",
}


def read_throttled():
    """Uses vcgencmd (Raspberry Pi only). Returns None when unavailable."""
    if not shutil.which("vcgencmd"):
        return None
    try:
        out = subprocess.run(["vcgencmd", "get_throttled"], capture_output=True,
                             text=True, timeout=2).stdout.strip()
        value = int(out.split("=")[1], 16)
    except Exception:
        return None
    active = [msg for bit, msg in THROTTLE_FLAGS.items() if bit < 16 and value & (1 << bit)]
    past = [msg for bit, msg in THROTTLE_FLAGS.items() if bit >= 16 and value & (1 << bit)]
    return {"raw": hex(value), "active": active, "past": past}


def read_voltage():
    if not shutil.which("vcgencmd"):
        return None
    try:
        out = subprocess.run(["vcgencmd", "measure_volts", "core"], capture_output=True,
                             text=True, timeout=2).stdout.strip()
        return float(out.split("=")[1].rstrip("V"))
    except Exception:
        return None


def read_processes():
    """{pid: (name, cpu_ticks, rss_bytes, user_uid)}"""
    procs = {}
    try:
        pids = [p for p in os.listdir("/proc") if p.isdigit()]
    except OSError:
        return procs
    for pid in pids:
        stat = read("/proc/%s/stat" % pid)
        if not stat:
            continue
        try:
            lpar = stat.index("(")
            rpar = stat.rindex(")")
            name = stat[lpar + 1:rpar]
            fields = stat[rpar + 2:].split()
            ticks = int(fields[11]) + int(fields[12])      # utime + stime
            rss = int(fields[21]) * PAGE_SIZE
        except (ValueError, IndexError):
            continue
        cmd = read("/proc/%s/cmdline" % pid, "") or ""
        cmd = cmd.replace("\x00", " ").strip()
        procs[int(pid)] = (name, ticks, rss, cmd)
    return procs


_USER_CACHE = {}


def pid_user(pid):
    try:
        uid = os.stat("/proc/%d" % pid).st_uid
    except OSError:
        return "?"
    if uid not in _USER_CACHE:
        try:
            import pwd
            _USER_CACHE[uid] = pwd.getpwuid(uid).pw_name
        except Exception:
            _USER_CACHE[uid] = str(uid)
    return _USER_CACHE[uid]


# --------------------------------------------------------------------------- #
# Sampler
# --------------------------------------------------------------------------- #
class Sampler(object):
    def __init__(self, interval=SAMPLE_INTERVAL):
        self.interval = interval
        self.lock = threading.Lock()
        self.history = deque(maxlen=HISTORY_LEN)
        self.latest = {}
        self.info = get_system_info()
        self._prev_cpu = None
        self._prev_net = None
        self._prev_io = None
        self._prev_procs = None
        self._prev_time = None
        self._tick = 0

    def start(self):
        t = threading.Thread(target=self._run, daemon=True)
        t.start()

    def _run(self):
        while True:
            try:
                self.sample()
            except Exception as exc:  # keep sampling no matter what
                print("sampler error:", exc)
            time.sleep(self.interval)

    def sample(self):
        now = time.time()
        dt = (now - self._prev_time) if self._prev_time else None

        # CPU
        cpu_times = read_cpu_times()
        cpu_pct = []
        total_cpu_ticks = 0
        if self._prev_cpu and len(self._prev_cpu) == len(cpu_times):
            for (i0, t0), (i1, t1) in zip(self._prev_cpu, cpu_times):
                dtot = t1 - t0
                cpu_pct.append(round(100.0 * (1 - (i1 - i0) / dtot), 1) if dtot > 0 else 0.0)
            total_cpu_ticks = cpu_times[0][1] - self._prev_cpu[0][1]
        else:
            cpu_pct = [0.0] * len(cpu_times)
        self._prev_cpu = cpu_times

        freqs, fmax, fmin = read_cpu_freqs()

        # Network
        net = read_net_counters()
        rx_rate = tx_rate = 0.0
        ifaces = []
        if self._prev_net and dt:
            for name, (rx, tx) in net.items():
                prx, ptx = self._prev_net.get(name, (rx, tx))
                r = max(0, rx - prx) / dt
                t = max(0, tx - ptx) / dt
                rx_rate += r
                tx_rate += t
                ifaces.append({"name": name, "rx_rate": r, "tx_rate": t, "rx_total": rx, "tx_total": tx})
        else:
            ifaces = [{"name": n, "rx_rate": 0, "tx_rate": 0, "rx_total": rx, "tx_total": tx}
                      for n, (rx, tx) in net.items()]
        ifaces.sort(key=lambda i: -(i["rx_total"] + i["tx_total"]))
        self._prev_net = net

        # Disk I/O
        io = read_disk_io()
        io_read = io_write = 0.0
        if self._prev_io and dt:
            io_read = max(0, io[0] - self._prev_io[0]) / dt
            io_write = max(0, io[1] - self._prev_io[1]) / dt
        self._prev_io = io

        # Processes
        procs = read_processes()
        top = []
        ncpu = self.info["cpu_count"]
        if self._prev_procs is not None and total_cpu_ticks > 0:
            # total_cpu_ticks is aggregate across all cores; scale so 100% = one full core
            per_core_ticks = total_cpu_ticks / float(ncpu)
            for pid, (name, ticks, rss, cmd) in procs.items():
                prev = self._prev_procs.get(pid)
                used = ticks - prev[1] if prev else 0
                top.append((pid, name, 100.0 * used / per_core_ticks, rss, cmd))
        else:
            top = [(pid, n, 0.0, rss, cmd) for pid, (n, _, rss, cmd) in procs.items()]
        self._prev_procs = procs
        top.sort(key=lambda p: (-p[2], -p[3]))
        mem_total = read_meminfo()["total"] or 1
        top_list = [{
            "pid": pid, "name": name, "cpu": round(cpu, 1), "rss": rss,
            "mem": round(rss / mem_total * 100, 1), "user": pid_user(pid),
            "cmd": (cmd or name)[:160],
        } for pid, name, cpu, rss, cmd in top[:12]]

        # Slow-changing stuff every ~10 ticks
        if self._tick % 10 == 0:
            self._throttled = read_throttled()
            self._voltage = read_voltage()
            self._disks = read_disks()
            self.info["ips"] = get_ip_addresses()
        self._tick += 1

        load, running, nprocs = read_loadavg()
        mem = read_meminfo()
        temp = read_temperature()

        snapshot = {
            "time": now,
            "cpu": {
                "percent": cpu_pct[0] if cpu_pct else 0,
                "per_core": cpu_pct[1:],
                "freq": freqs,
                "freq_max": fmax,
                "freq_min": fmin,
            },
            "temp": temp,
            "voltage": self._voltage,
            "throttled": self._throttled,
            "memory": mem,
            "disks": self._disks,
            "disk_io": {"read": io_read, "write": io_write},
            "network": {"rx_rate": rx_rate, "tx_rate": tx_rate, "interfaces": ifaces},
            "load": load,
            "procs": {"running": running, "total": nprocs, "top": top_list},
            "uptime": read_uptime(),
        }
        point = {
            "t": now, "cpu": snapshot["cpu"]["percent"], "temp": temp,
            "mem": mem["percent"], "rx": rx_rate, "tx": tx_rate,
            "io_r": io_read, "io_w": io_write,
        }
        with self.lock:
            self.latest = snapshot
            if dt:  # skip first (no deltas yet)
                self.history.append(point)
        self._prev_time = now

    def payload(self, with_history):
        with self.lock:
            data = dict(self.latest)
            data["info"] = self.info
            data["interval"] = self.interval
            if with_history:
                data["history"] = list(self.history)
        return data


class DemoSampler(Sampler):
    """Generates plausible fake data so the UI can be previewed off-Pi."""

    def __init__(self, interval=SAMPLE_INTERVAL):
        self.interval = interval
        self.lock = threading.Lock()
        self.history = deque(maxlen=HISTORY_LEN)
        self.latest = {}
        self.info = {
            "hostname": "raspberrypi", "model": "Raspberry Pi 5 Model B Rev 1.0 (demo)",
            "os": "Debian GNU/Linux 12 (bookworm)", "kernel": "6.6.51+rpt-rpi-2712",
            "arch": "aarch64", "cpu_count": 4, "ips": ["192.168.1.42"],
            "python": platform.python_version(),
        }
        self._t0 = time.time()
        self._tick = 0
        # backfill history so charts aren't empty
        for i in range(HISTORY_LEN, 0, -1):
            self._gen(time.time() - i * interval)

    def _gen(self, now):
        k = (now - self._t0) / 20.0
        base = 25 + 18 * math.sin(k) + random.uniform(-6, 6)
        cores = [max(1, min(100, base + random.uniform(-15, 25))) for _ in range(4)]
        cpu = sum(cores) / 4
        temp = 46 + cpu * 0.25 + random.uniform(-0.6, 0.6)
        mem_total = 8 * 1024 ** 3
        mem_used = int(mem_total * (0.31 + 0.04 * math.sin(k / 3)))
        rx = abs(180e3 + 150e3 * math.sin(k * 1.7) + random.uniform(-40e3, 90e3))
        tx = abs(40e3 + 30e3 * math.sin(k * 1.3) + random.uniform(-10e3, 30e3))
        io_r = abs(random.gauss(200e3, 150e3))
        io_w = abs(random.gauss(400e3, 300e3))
        names = ["python3", "Xorg", "chromium", "node", "pihole-FTL", "dockerd", "sshd",
                 "systemd", "lighttpd", "containerd", "bash", "rsyslogd"]
        top = sorted([{
            "pid": 400 + i * 37, "name": n, "cpu": round(abs(random.gauss(cpu / (i + 2), 3)), 1),
            "rss": int(random.uniform(8, 300) * 1024 ** 2), "mem": 0, "user": "pi" if i % 3 else "root",
            "cmd": "/usr/bin/" + n,
        } for i, n in enumerate(names)], key=lambda p: -p["cpu"])
        for p in top:
            p["mem"] = round(p["rss"] / mem_total * 100, 1)
        snap = {
            "time": now,
            "cpu": {"percent": round(cpu, 1), "per_core": [round(c, 1) for c in cores],
                    "freq": [1500 + 900 * (c > 50) for c in cores], "freq_max": 2400.0, "freq_min": 1500.0},
            "temp": round(temp, 1), "voltage": 0.8732,
            "throttled": {"raw": "0x0", "active": [], "past": []},
            "memory": {"total": mem_total, "used": mem_used, "available": mem_total - mem_used,
                       "cached": int(mem_total * 0.22), "percent": round(mem_used / mem_total * 100, 1),
                       "swap_total": 512 * 1024 ** 2, "swap_used": 12 * 1024 ** 2, "swap_percent": 2.3},
            "disks": [
                {"device": "/dev/mmcblk0p2", "mount": "/", "fs": "ext4", "total": 59e9, "used": 14.2e9,
                 "free": 44.8e9, "percent": 24.1},
                {"device": "/dev/mmcblk0p1", "mount": "/boot/firmware", "fs": "vfat", "total": 535e6,
                 "used": 78e6, "free": 457e6, "percent": 14.6},
                {"device": "/dev/sda1", "mount": "/mnt/storage", "fs": "ext4", "total": 1.0e12,
                 "used": 6.1e11, "free": 3.9e11, "percent": 61.0},
            ],
            "disk_io": {"read": io_r, "write": io_w},
            "network": {"rx_rate": rx, "tx_rate": tx, "interfaces": [
                {"name": "eth0", "rx_rate": rx, "tx_rate": tx, "rx_total": 8.2e9, "tx_total": 1.3e9},
                {"name": "wlan0", "rx_rate": 0, "tx_rate": 0, "rx_total": 4.1e6, "tx_total": 9.8e5}]},
            "load": [round(cpu / 30, 2), round(cpu / 34, 2), round(cpu / 40, 2)],
            "procs": {"running": 2, "total": 187, "top": top},
            "uptime": 3 * 86400 + 5 * 3600 + (now - self._t0),
        }
        with self.lock:
            self.latest = snap
            self.history.append({"t": now, "cpu": snap["cpu"]["percent"], "temp": snap["temp"],
                                 "mem": snap["memory"]["percent"], "rx": rx, "tx": tx,
                                 "io_r": io_r, "io_w": io_w})

    def sample(self):
        self._gen(time.time())


# --------------------------------------------------------------------------- #
# HTTP
# --------------------------------------------------------------------------- #
SAMPLER = None


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=STATIC_DIR, **kwargs)

    def log_message(self, fmt, *args):  # quiet
        pass

    def _json(self, obj, status=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        # Allow the dashboard to be opened from another machine (e.g. your PC)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/stats":
            return self._json(SAMPLER.payload(with_history="history=1" in self.path))
        if path == "/api/health":
            return self._json({"ok": True})
        return super().do_GET()


def main():
    global SAMPLER
    ap = argparse.ArgumentParser(description="Raspberry Pi system dashboard")
    ap.add_argument("--host", default="0.0.0.0", help="bind address (default 0.0.0.0)")
    ap.add_argument("--port", type=int, default=8080, help="port (default 8080)")
    ap.add_argument("--interval", type=float, default=SAMPLE_INTERVAL, help="sample interval seconds")
    ap.add_argument("--demo", action="store_true", help="serve fake data (auto-on when /proc is missing)")
    args = ap.parse_args()

    demo = args.demo or not os.path.exists("/proc/stat")
    SAMPLER = DemoSampler(args.interval) if demo else Sampler(args.interval)
    if not demo:
        SAMPLER.sample()   # prime deltas
    SAMPLER.start()

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    ips = SAMPLER.info.get("ips") or ["localhost"]
    print("Pi Dashboard%s running:" % (" (DEMO DATA)" if demo else ""))
    for ip in ips:
        print("  http://%s:%d" % (ip, args.port))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
