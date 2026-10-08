#!/usr/bin/env python3
"""Grid view resize + warm start, end to end, in a pty (Überzug++ mock, so
every overlay's cell box is visible in the mock's log).

  1. cold run at 120x40 builds the thumbnail cache, quit
  2. warm start: the window is 80x24 when WallRizz starts and grows to
     120x40 a moment later (what a compositor does to a new terminal); the
     final page must use the 120x40 grid, not the 80x24 one
  3. resize to 100x30 and 140x45: old overlays removed, new grid, every
     overlay inside the window
usage: gallery-resize.test.py WALLRIZZ_BIN MOCK WORKDIR
"""
import json, os, pty, select, shutil, signal, struct, subprocess, sys, time, fcntl, termios

wr, mock, work = (os.path.abspath(a) for a in sys.argv[1:4])
shutil.rmtree(work, ignore_errors=True)
home, walls, bindir = f"{work}/home", f"{work}/walls", f"{work}/bin"
for d in (f"{home}/.config/WallRizz", walls, bindir):
    os.makedirs(d)
with open(f"{home}/.config/WallRizz/stub@test.js", "w") as f:
    f.write("export function setWallpaper(path) {}\n")
for i in range(36):
    subprocess.run(["magick", "-size", "96x54", "plasma:fractal", f"{walls}/w{i:02d}.jpg"], check=True)
os.symlink(mock, f"{bindir}/ueberzugpp")
log = f"{work}/uz.log"
env = dict(os.environ, HOME=home, PATH=f"{bindir}:{os.environ['PATH']}", TERM="xterm-256color",
           WALLRIZZ_UEBERZUG_OUTPUT="x11", WALLRIZZ_UEBERZUG_SPACING_MS="2", MOCK_UZ_LOG=log)
for k in ("DISPLAY", "WAYLAND_DISPLAY", "TMUX", "KITTY_WINDOW_ID", "TERM_PROGRAM", "MOCK_UZ_DIE_AFTER"):
    env.pop(k, None)
# -s 20x5 with the default padding (2 rows x 1 column) -> 21x7 cells per
# tile: 120x40 -> 5x5, 80x24 -> 3x3, 100x30 -> 4x4, 140x45 -> 6x6
GRID = {(120, 40): (5, 5), (80, 24): (3, 3), (100, 30): (4, 4), (140, 45): (6, 6)}

passed = failed = 0
def check(name, ok, info=""):
    global passed, failed
    if ok: passed += 1
    else:
        failed += 1
        print(f"FAIL {name} {info}")

def resize(fd, cols, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, cols * 10, rows * 20))

class Run:
    def __init__(self, cols, rows):
        open(log, "w").close()
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.execve(wr, [wr, "-d", walls, "-n", "-P", "ueberzug", "-s", "20x5"], env)
        resize(self.fd, cols, rows)
    def pump(self, sec):
        end = time.time() + sec
        while time.time() < end:
            r, _, _ = select.select([self.fd], [], [], 0.05)
            if r:
                try:
                    if not os.read(self.fd, 65536): return
                except OSError:
                    return
    def quit(self):
        os.write(self.fd, b"q")
        self.pump(1.0)
        try:
            w, _ = os.waitpid(self.pid, os.WNOHANG)
        except ChildProcessError:
            w = self.pid
        if not w:
            os.kill(self.pid, signal.SIGTERM)
            os.waitpid(self.pid, 0)
        return w == self.pid

def commands():
    out = []
    for l in open(log).read().split("\n"):
        if l.startswith("CMD "):
            out.append(json.loads(l[4:]))
    return out

def shown():
    """overlays on screen according to the command stream"""
    cur = {}
    for c in commands():
        if c["action"] == "add": cur[c["identifier"]] = c
        else: cur.pop(c["identifier"], None)
    return list(cur.values())

def settle(run, sec=0.8, limit=30):
    """pump until the command log stops changing"""
    end, last = time.time() + limit, -1
    while time.time() < end:
        run.pump(sec)
        n = len(commands())
        if n and n == last: return
        last = n

def check_grid(name, cols, rows):
    s = shown()
    gc, gr = GRID[(cols, rows)]
    want = min(36, gc * gr)
    check(f"{name}: {want} overlays for a {gc}x{gr} grid", len(s) == want, f"got {len(s)}")
    xs = sorted({c["x"] for c in s})
    check(f"{name}: {gc} columns", len(xs) == min(gc, len(s)), str(xs))
    inside = all(c["x"] + c["max_width"] <= cols - 1 and c["y"] + c["max_height"] <= rows for c in s)
    check(f"{name}: every overlay inside {cols}x{rows}", inside,
          str([(c["x"], c["y"], c["max_width"], c["max_height"]) for c in s][:4]))
    gens = {c["identifier"].rsplit("-", 1)[0] for c in s}
    check(f"{name}: only one draw generation on screen", len(gens) == 1, str(gens))

# 1. cold run (thumbnails)
r = Run(120, 40)
settle(r, 1.0, 90)
check_grid("cold 120x40", 120, 40)
check("cold run quits", r.quit())

# 2. warm start: 80x24 at launch, 120x40 shortly after
r = Run(80, 24)
r.pump(0.25)
resize(r.fd, 120, 40)
settle(r)
check_grid("warm start 80x24 -> 120x40", 120, 40)

# 3. resizes during the session
for cols, rows in ((100, 30), (140, 45)):
    before = {c["identifier"] for c in shown()}
    resize(r.fd, cols, rows)
    settle(r)
    check_grid(f"resize to {cols}x{rows}", cols, rows)
    check(f"resize to {cols}x{rows}: old overlays removed",
          not (before & {c["identifier"] for c in shown()}))
check("quits after resizes", r.quit())
print(f"gallery resize tests: {passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
