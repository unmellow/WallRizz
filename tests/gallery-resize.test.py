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
import json, os, pty, shutil, struct, subprocess, sys, fcntl, termios
sys.dont_write_bytecode = True  # no __pycache__ in the source tree
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from testlib import Checks, Pty

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

t = Checks("gallery resize")
check = t.check


def resize(fd, cols, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, cols * 10, rows * 20))


def run(cols, rows):
    open(log, "w").close()
    pid, fd = pty.fork()
    if pid == 0:
        os.execve(wr, [wr, "-d", walls, "-n", "-P", "ueberzug", "-s", "20x5"], env)
    resize(fd, cols, rows)
    return Pty(pid, fd)


def quit(term):
    term.write(b"q")
    return term.wait_exit("WallRizz to exit after q")


def commands():
    out = []
    try:
        text = open(log).read()
    except FileNotFoundError:
        return out
    for l in text.split("\n"):
        if l.startswith("CMD "):
            try:
                out.append(json.loads(l[4:]))
            except ValueError:
                pass  # line still being written
    return out


def shown():
    """overlays on screen according to the command stream"""
    cur = {}
    for c in commands():
        if c["action"] == "add": cur[c["identifier"]] = c
        else: cur.pop(c["identifier"], None)
    return list(cur.values())


def grid_checks(name, cols, rows):
    """(name, ok, info) for the grid expected at cols x rows"""
    s = shown()
    gc, gr = GRID[(cols, rows)]
    want = min(36, gc * gr)
    xs = sorted({c["x"] for c in s})
    gens = {c["identifier"].rsplit("-", 1)[0] for c in s}
    return [
        (f"{name}: {want} overlays for a {gc}x{gr} grid", len(s) == want, f"got {len(s)}"),
        (f"{name}: {gc} columns", len(xs) == min(gc, len(s)), str(xs)),
        (f"{name}: every overlay inside {cols}x{rows}",
         all(c["x"] + c["max_width"] <= cols - 1 and c["y"] + c["max_height"] <= rows for c in s),
         str([(c["x"], c["y"], c["max_width"], c["max_height"]) for c in s][:4])),
        (f"{name}: only one draw generation on screen", len(gens) == 1, str(gens)),
    ]


def expect_grid(term, name, cols, rows, sec=30):
    """wait until the overlays form the expected grid, then record checks"""
    term.wait_for(f"the {cols}x{rows} grid ({name})",
                  lambda: all(ok for _, ok, _ in grid_checks(name, cols, rows)), sec)
    for c in grid_checks(name, cols, rows):
        check(*c)


# 1. cold run (thumbnails)
r = run(120, 40)
expect_grid(r, "cold 120x40", 120, 40, 90)
check("cold run quits", quit(r))

# 2. warm start: 80x24 at launch, 120x40 once the first page is being drawn
# (what a compositor does to a new terminal)
r = run(80, 24)
r.wait_for("the first overlay of the warm start",
           lambda: any(c["action"] == "add" for c in commands()))
resize(r.fd, 120, 40)
expect_grid(r, "warm start 80x24 -> 120x40", 120, 40)

# 3. resizes during the session
for cols, rows in ((100, 30), (140, 45)):
    before = {c["identifier"] for c in shown()}
    resize(r.fd, cols, rows)
    expect_grid(r, f"resize to {cols}x{rows}", cols, rows)
    check(f"resize to {cols}x{rows}: old overlays removed",
          not (before & {c["identifier"] for c in shown()}))
check("quits after resizes", quit(r))
t.done()
