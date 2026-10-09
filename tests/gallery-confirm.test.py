#!/usr/bin/env python3
"""Überzug++ page mode: an overlay is only removed once the window that
replaces it is up. End to end in a pty against tests/mock-ueberzugpp, which
emulates sway (MOCK_SWAY_EVENTS: every add's window is "mapped" after a
delay, one at a time, and a window event goes out), and tests/mock-swaymsg
(the IPC subscription WallRizz reads). Slow mock magick for cold pages.

  A. sway, slow first map (600 ms, like an OpenCV build of ueberzugpp):
     1. the window subscription runs; a warm-up add goes first
     2. first page: each update is sent only after the previous update's
        window was mapped and >= WALLRIZZ_UEBERZUG_SPACING_MS later
        (coalesced: never two adds waiting on one window)
     3. every replaced overlay (update or page flip) is removed after the
        replacing window was mapped, never before; never > 2 overlays
     4. seen-page flips: one add, the old page removed >= the grace after
        the new window was mapped
     5. q: exits, the subscription child is gone, the live dir released
  B. sway, windows never reported: the old page goes after the ~1 s timeout
  C. no compositor confirmation: the old page goes 300 ms after the add
  D. ueberzugpp exits right after starting (it is started in the background,
     while the first page is made): chafa symbols, no restart
usage: gallery-confirm.test.py WALLRIZZ_BIN TESTS_DIR MOCK_MAGICK WORKDIR
"""
import glob, json, os, pty, shutil, signal, struct, subprocess, sys, time, fcntl, termios
sys.dont_write_bytecode = True  # no __pycache__ in the source tree
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from testlib import Checks, Pty, SCALE

wr, tests_dir, mock_magick, work = (os.path.abspath(a) for a in sys.argv[1:5])
shutil.rmtree(work, ignore_errors=True)
home, walls, bindir, tpl = f"{work}/home", f"{work}/walls", f"{work}/bin", f"{work}/tpl"
xdg_cache, run_dir = f"{work}/xdg-cache", f"{work}/run"
for d in (f"{home}/.config/WallRizz", walls, bindir, tpl, xdg_cache, run_dir):
    os.makedirs(d)
os.chmod(run_dir, 0o700)
with open(f"{home}/.config/WallRizz/stub@test.js", "w") as f:
    f.write("export function setWallpaper(path) {}\n")
N = 16  # -g 4x2: 2 pages of 8
for i in range(N):
    rgb = ((i * 53) % 200 + 40, (i * 97) % 200 + 40, (i * 151) % 200 + 40)
    subprocess.run(["magick", "-size", "64x36", "xc:gray", f"{walls}/w{i:02d}.jpg"], check=True)
    subprocess.run(["magick", "-size", "32x18", f"xc:rgb{rgb}", f"{tpl}/w{i:02d}.png"], check=True)
subprocess.run(["magick", "-size", "32x18", "xc:gray", f"{tpl}/default.png"], check=True)
os.symlink(f"{tests_dir}/mock-ueberzugpp", f"{bindir}/ueberzugpp")
os.symlink(f"{tests_dir}/mock-swaymsg", f"{bindir}/swaymsg")
os.symlink(mock_magick, f"{bindir}/magick")
shutil.copy(f"{tests_dir}/chafa-probe-wrapper", f"{bindir}/chafa")
UPDATE_MS, GRACE_MS, FIRST_MAP_MS, MAP_MS = 150, 50, 600, 120
TOL = 0.015  # mock timestamps are taken in another process
base_env = dict(os.environ, HOME=home, XDG_CACHE_HOME=xdg_cache, XDG_RUNTIME_DIR=run_dir,
                PATH=f"{bindir}:{os.environ['PATH']}", TERM="xterm-256color",
                WALLRIZZ_UEBERZUG_OUTPUT="wayland", WALLRIZZ_UEBERZUG_SPACING_MS=str(UPDATE_MS),
                CHAFA_ARGV_LOG=f"{work}/chafa.argv",
                MOCK_MAGICK_DELAY="0.25", MOCK_MAGICK_TEMPLATE_DIR=tpl,
                MOCK_MAGICK_TEMPLATE=f"{tpl}/default.png", MOCK_MAGICK_REAL=shutil.which("magick") or "/usr/bin/magick")
for k in ("DISPLAY", "WAYLAND_DISPLAY", "TMUX", "KITTY_WINDOW_ID", "TERM_PROGRAM", "MOCK_CHAFA_OLD",
          "WALLRIZZ_UEBERZUG_OVERLAY", "WALLRIZZ_UEBERZUG_DEBOUNCE_MS", "WALLRIZZ_CACHE_MAX_MB",
          "SWAYSOCK", "HYPRLAND_INSTANCE_SIGNATURE", "WALLRIZZ_UEBERZUG_CONFIRM", "WALLRIZZ_UEBERZUG_WARMUP",
          "MOCK_UZ_NO_MAP", "MOCK_UZ_MAP_MS", "MOCK_UZ_FIRST_MAP_MS", "MOCK_SWAY_EVENTS"):
    base_env.pop(k, None)
cache = f"{xdg_cache}/WallRizz"
t = Checks("gallery confirm")
check = t.check


def lines(path):
    try:
        return open(path).read().split("\n")
    except FileNotFoundError:
        return []


class Session:
    def __init__(self, tag, **extra):
        self.log, self.times = f"{work}/uz-{tag}.log", f"{work}/uz-{tag}.times"
        env = dict(base_env, MOCK_UZ_LOG=self.log, MOCK_UZ_TIMES=self.times, **extra)
        self.pid, fd = pty.fork()
        if self.pid == 0:
            os.execve(wr, [wr, "-d", walls, "-n", "-P", "ueberzug", "-e", "-g", "4x2", "-x", "2"], env)
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 1200, 800))
        self.term = Pty(self.pid, fd)

    def events(self):
        """[(time, action, id)] as the mock received them, plus MAPPED"""
        ev = []
        for l in lines(self.times):
            p = l.split()
            if len(p) == 3:
                ev.append((float(p[0]), p[1], p[2]))
        for l in lines(self.log):
            if l.startswith("MAPPED "):
                _, ident, ts = l.split()
                ev.append((float(ts), "mapped", ident))
        return sorted(ev)

    def adds(self, prefix=""):
        return [e for e in self.events() if e[1] == "add" and e[2].startswith(prefix)]

    def first(self, action, ident):
        return next((e[0] for e in self.events() if e[1] == action and e[2] == ident), None)

    def full_adds(self, page):
        return [ident for ident, path in self.paths() if ident.startswith(f"wallrizz-p{page}-") and "/composites/page-" in path]

    def paths(self):
        out = []
        for l in lines(self.log):
            if l.startswith("CMD "):
                try:
                    c = json.loads(l[4:])
                except ValueError:
                    continue
                if c.get("action") == "add":
                    out.append((c["identifier"], c.get("path", "")))
        return out

    def quit(self):
        self.term.write(b"q")
        return self.term.wait_exit("WallRizz to exit after q")

    def give_up(self):
        if not self.term.exited():
            os.kill(self.pid, signal.SIGTERM)
            self.term.wait_exit("WallRizz to exit after SIGTERM", 10)
        t.done()


def max_alive(ev):
    alive, peak = set(), 0
    for _, a, ident in ev:
        if a == "add":
            alive.add(ident)
        elif a == "remove":
            alive.discard(ident)
        peak = max(peak, len(alive))
    return peak


def flip(s, key, page):
    """page key; returns (new add id, removed old id) once the old one is gone"""
    before = s.adds()
    # the overlay on screen: the newest one mapped and not removed (an update
    # still on its way is dropped by the flip, not kept)
    removed = {e[2] for e in s.events() if e[1] == "remove"}
    up = [e[2] for e in before if e[2] not in removed and s.first("mapped", e[2]) is not None]
    old = up[-1] if up else before[-1][2]
    s.term.write(key)
    s.term.wait_for(f"page {page} added", lambda: len(s.adds()) > len(before))
    new = s.adds()[len(before)][2]
    s.term.wait_for("old page removed", lambda: s.first("remove", old) is not None, 10)
    s.term.pump(0.3)
    return new, old


# ---- A. sway with a slow first map ----
events = f"{work}/sway-events"
sway_argv = f"{work}/swaymsg.argv"
a = Session("a", SWAYSOCK=f"{work}/sway.sock", MOCK_SWAY_EVENTS=events, MOCK_SWAY_ARGV=sway_argv,
            MOCK_UZ_FIRST_MAP_MS=str(FIRST_MAP_MS), MOCK_UZ_MAP_MS=str(MAP_MS))
if not check("A: first page complete", a.term.wait_for("page 0's full composite", lambda: a.full_adds(0), 90)):
    a.give_up()
a.term.wait_for("page 0's final window mapped", lambda: a.first("mapped", a.full_adds(0)[-1]) is not None, 10)
a.term.pump(0.4)  # (WallRizz reads the window event, removes the partial)
check("A: window subscription started (swaymsg subscribe window)",
      any("subscribe" in l and "window" in l for l in lines(sway_argv)), str(lines(sway_argv)))
ev = a.events()
check("A: the warm-up add goes first", ev and ev[0][1] == "add" and ev[0][2] == "wallrizz-warmup", str(ev[:3]))
p0 = [e for e in a.adds("wallrizz-p0-")]
check("A: first page filled in progressively", len(p0) >= 2, str(p0))
cadence = []
for prev, cur in zip(p0, p0[1:]):
    m = a.first("mapped", prev[2])
    cadence.append((prev[2], cur[2], None if m is None else round((cur[0] - m) * 1000)))
check("A: each update sent only after the previous update's window was mapped + spacing",
      all(c[2] is not None and c[2] >= UPDATE_MS - TOL * 1000 for c in cadence), str(cadence))
# coalescing: between two consecutive mapped windows of page 0, at most one add
p0_mapped = sorted(a.first("mapped", e[2]) for e in p0 if a.first("mapped", e[2]))
burst = [sum(1 for e in p0 if lo < e[0] <= hi) for lo, hi in zip(p0_mapped, p0_mapped[1:])]
check("A: coalesced (one add per appeared window)", all(n <= 1 for n in burst), str(burst))

# seen flips (page 1 first, cold, then 4 flips between the two seen pages)
a.term.write(b"L")
if not check("A: page 1 complete", a.term.wait_for("page 1's full composite", lambda: a.full_adds(1), 90)):
    a.give_up()
a.term.wait_for("page 1 settled", lambda: a.first("mapped", a.full_adds(1)[-1]) is not None, 10)
a.term.pump(0.5)
flips = []
for k, (key, page) in enumerate([(b"H", 0), (b"L", 1), (b"H", 0), (b"L", 1)]):
    n_adds = len(a.adds())
    new, old = flip(a, key, page)
    m, r = a.first("mapped", new), a.first("remove", old)
    flips.append((len(a.adds()) - n_adds, None if m is None or r is None else round((r - m) * 1000)))
check("A: seen flips: one add each", all(f[0] == 1 for f in flips), str(flips))
check("A: seen flips: old page removed only after the new window was mapped (+grace)",
      all(f[1] is not None and f[1] >= GRACE_MS - TOL * 1000 for f in flips), str(flips))
ev = a.events()
# every removed page overlay: its replacement (next add of this run) mapped first
early = []
page_adds = [e for e in ev if e[1] == "add" and e[2] != "wallrizz-warmup"]
for i, e in enumerate(page_adds[:-1]):
    r = a.first("remove", e[2])
    nxt = page_adds[i + 1][2]
    m = a.first("mapped", nxt)
    # the old page of a cold flip goes at once (nothing replaces it); skip
    # removals that come before the next add was even sent
    if r is None or r < page_adds[i + 1][0]:
        continue
    if m is None or r < m:
        early.append((e[2], nxt, r, m))
check("A: no overlay removed before its replacement was mapped", not early, str(early))
check("A: never more than two overlays alive", max_alive(ev) <= 2, str(max_alive(ev)))
watch_pids = [int(p) for p in subprocess.run(["pgrep", "-f", f"tail .*{events}"], capture_output=True, text=True).stdout.split()]
check("A: one subscription child while running", len(watch_pids) == 1, str(watch_pids))
check("A: q exits", a.quit(), f"status={a.term.status}")
time.sleep(0.2)
check("A: subscription child gone after exit", not any(os.path.exists(f"/proc/{p}") for p in watch_pids), str(watch_pids))
live = {os.path.dirname(p) for _, p in a.paths() if "/partial-" in p or "/warmup-" in p}
leftover = [f for d in live for f in glob.glob(f"{d}/*-{a.pid}*") + glob.glob(f"{d}/.inst-{a.pid}")]
check("A: no live file or marker of this run left", not leftover, str(leftover))
gone_ok = all(not os.path.isdir(d) or glob.glob(f"{d}/.inst-*") for d in live)
check("A: live dir removed unless another WallRizz uses it", gone_ok and live, str(live))

# ---- B. windows never reported: hard timeout ----
b = Session("b", SWAYSOCK=f"{work}/sway.sock", MOCK_SWAY_EVENTS=events, MOCK_UZ_NO_MAP="1")
if not check("B: first page drawn", b.term.wait_for("page 0's full composite", lambda: b.full_adds(0), 60)):
    b.give_up()
b.term.pump(1.3)
gaps = []
for key, page in [(b"L", 1), (b"H", 0)]:
    new, old = flip(b, key, page)
    gaps.append(round((b.first("remove", old) - b.first("add", new)) * 1000))
    b.term.pump(0.3)
check("B: no confirmation: old page removed after the ~1 s hard timeout",
      all(950 <= g <= 1000 + 600 * SCALE for g in gaps), str(gaps))
check("B: q exits", b.quit(), f"status={b.term.status}")

# ---- C. no confirmation available: 300 ms fallback ----
c = Session("c")
if not check("C: first page drawn", c.term.wait_for("page 0's full composite", lambda: c.full_adds(0), 60)):
    c.give_up()
c.term.pump(0.8)
gaps = []
for key, page in [(b"L", 1), (b"H", 0)]:
    new, old = flip(c, key, page)
    gaps.append(round((c.first("remove", old) - c.first("add", new)) * 1000))
check("C: fallback: old page removed 300 ms after the add (not before)",
      all(300 - TOL * 1000 <= g <= 300 + 500 * SCALE for g in gaps), str(gaps))
check("C: q exits", c.quit(), f"status={c.term.status}")

# ---- D. ueberzugpp can't start ----
chafa_log = f"{work}/chafa.argv"
if os.path.exists(chafa_log):
    os.remove(chafa_log)
d = Session("d", SWAYSOCK=f"{work}/sway.sock", MOCK_SWAY_EVENTS=events, MOCK_UZ_FAIL="1")
check("D: failed start: symbols notice", d.term.wait_for("the symbols notice", lambda: b"using text symbols" in d.term.out, 30))
check("D: failed start: tiles drawn with chafa", d.term.wait_for("chafa runs", lambda: bool(lines(chafa_log)[0:1] and lines(chafa_log)[0]), 30))
check("D: failed start: no restart", len([l for l in lines(d.log) if l.startswith("ARGV")]) == 1, str(lines(d.log)[:3]))
check("D: q exits", d.quit(), f"status={d.term.status}")
t.done()
