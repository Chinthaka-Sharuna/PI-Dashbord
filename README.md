# Pi Dashboard

A lightweight web dashboard for monitoring a Raspberry Pi. It's a single Python file that uses
only the standard library, so there's nothing to `pip install`, and the page loads no external
libraries, so it also works when the Pi has no internet connection.

## What it shows

- **CPU**: total usage, each core's usage and clock speed, load average, and the last 5 minutes as a chart
- **Temperature**: SoC temperature, with a warning above 70 °C and a "hot" state above 80 °C
- **Memory**: used, available, cached and swap
- **Storage**: usage for every mounted disk, plus disk read/write speed
- **Network**: upload and download speed, and totals for each interface
- **Health**: throttling and under-voltage flags, plus core voltage (read with `vcgencmd`)
- **System**: model, OS, kernel, IP addresses and uptime
- **Top processes**: sorted by CPU, with memory, user and command

Light and dark themes are both included (use the button in the top-right corner), and the layout works on phones.

## Quick start (on the Pi)

```bash
# copy this folder to the Pi, e.g.
scp -r "PI Dashbord" pi@raspberrypi.local:~/pi-dashboard

# on the Pi
cd ~/pi-dashboard
python3 server.py
```

Then open `http://<pi-ip>:8080` from any device on your network.

Options:

```
python3 server.py --port 9000        # different port
python3 server.py --interval 1       # sample every second (default 2)
python3 server.py --host 127.0.0.1   # only reachable from the Pi itself
python3 server.py --demo             # fake data, handy for previewing
```

## Run the frontend on your PC

Keep `server.py` running on the Pi, which supplies the data. On your PC you only need the
`static/` folder:

- **Easiest:** double-click `static/index.html`, type the Pi's address (e.g. `192.168.1.42`)
  and click Connect. Your browser remembers the address for next time.
- **Or open the address directly:** add it to the end of the page's address, for example
  `index.html?pi=192.168.1.42:8080`.
- **Or serve it locally:** `python3 -m http.server 8000 -d static`, then open http://localhost:8000.

To switch to a different Pi later, click the green **Live** button in the top bar.

## Run on boot

```bash
sudo ./install.sh            # installs to /opt/pi-dashboard as a systemd service on port 8080
sudo PORT=9000 ./install.sh  # or pick a port
```

Useful commands:

```bash
sudo systemctl status pi-dashboard
journalctl -u pi-dashboard -f
sudo systemctl restart pi-dashboard
```

## Work on the UI without a Pi (demo mode)

Open `static/index.html` in a browser and click **Use demo data**. You can also open
`static/index.html?demo` directly. No server is needed: fake data comes from
[static/mock.js](static/mock.js) and has the same format as the real `/api/stats`.

A **DEMO** panel in the bottom-right corner lets you switch between test scenarios to see each UI state:

| Scenario | What it tests |
|---|---|
| `normal` | Typical light load |
| `busy` | High CPU (warning and red colors) |
| `hot` | 83 °C and active throttling (red gauges, "Active" warning in Health) |
| `undervolt` | Past under-voltage warnings (bad power supply) |
| `full` | 95% memory, 97% disk, swap nearly full |
| `idle` | Near-zero values |
| `eight` | 8 cores, no temperature sensor and no `vcgencmd` (missing-data states) |
| `offline` | The data feed stops responding (Offline status) |

You can also open a scenario directly: `index.html?demo=hot`.

## Preview on your computer with the Python server

On macOS or Windows there is no `/proc`, so the server switches to demo data on its own:

```bash
python3 server.py   # → http://localhost:8080
```

## JSON API

`GET /api/stats` returns the latest snapshot. Add `?history=1` to also get the last ~5 minutes of
samples. This makes it easy to use with Home Assistant, scripts and similar tools.

## Notes

- The page uses the Barlow font from Google Fonts. With no internet connection it uses a
  similar system font, and everything still works.
- Requires Python 3.7+ (Raspberry Pi OS Buster or newer).
- Throttling and voltage readings need `vcgencmd`, which is preinstalled on Raspberry Pi OS. The
  user running the server must be in the `video` group, and `install.sh` sets this up.
- There's no login. Bind with `--host 127.0.0.1`, or keep the port off the public internet, if
  you don't want everyone on the network to see it.
