#!/usr/bin/env python3
"""Thumbnails off the UI thread, end to end (symbols, slow mock magick that
takes ~1s per image).

  1. cold first page of 40 wallpapers: empty frames show at once, and keys
     pressed every 100ms move the selection within ~100ms while the page is
     still being generated
  2. never more magick processes at once than -x
  3. prefetch never starts before the visible page's thumbnails are done
  4. after the next page was prefetched, flipping to it is quick
  5. paging through 5 pages quickly: the final page's image is drawn, no
     earlier page's image is drawn after it
  6. cache key: a new mtime gets a new thumbnail (the stale one is cleaned
     up at startup); a run with nothing
     changed launches no magick at all
  7. q, Ctrl+C, SIGTERM mid-generation: WallRizz exits, no magick left
     running, no temp (half-written) file left
usage: gallery-thumbs.test.py WALLRIZZ_BIN MOCK_MAGICK WORKDIR
"""
import glob, os, pty, re, shutil, struct, subprocess, sys, fcntl, termios, time
sys.dont_write_bytecode = True  # no __pycache__ in the source tree
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from testlib import Checks, Pty, deadline

wr, mock, work = (os.path.abspath(a) for a in sys.argv[1:4])
shutil.rmtree(work, ignore_errors=True)
home, walls, bindir, tpl = f"{work}/home", f"{work}/walls", f"{work}/bin", f"{work}/tpl"
for d in (f"{home}/.config/WallRizz", walls, bindir, tpl):
    os.makedirs(d)
with open(f"{home}/.config/WallRizz/stub@test.js", "w") as f:
    f.write("export function setWallpaper(path) {}\n")
pic = f"{home}/.cache/WallRizz/pic"

# xterm-256 colour cube entries, so chafa's 256-colour output names them
# exactly: a drawn tile tells which wallpaper it is
N = 40
LEVELS = [0, 95, 135, 175, 215, 255]


def cube(code):
    c = code - 16
    return (LEVELS[c // 36], LEVELS[(c // 6) % 6], LEVELS[c % 6]), code


# wallpaper i -> a distinct cube colour (skipping the near-greys)
CUBE = [cube(16 + 5 * i + 1) for i in range(N)]
subprocess.run(["magick", "-size", "64x36", "xc:gray", f"{work}/src.jpg"], check=True)
src_bytes = open(f"{work}/src.jpg", "rb").read()


def make_walls(n):
    for f in os.listdir(walls):
        os.remove(f"{walls}/{f}")
    for i in range(n):
        open(f"{walls}/w{i:02d}.jpg", "wb").write(src_bytes)


for i, ((r, g, b), _) in enumerate(CUBE):  # one PNG per wallpaper
    subprocess.run(["magick", "-size", "32x18", f"xc:rgb({r},{g},{b})", f"{tpl}/w{i:02d}.png"],
                   check=True)
subprocess.run(["magick", "-size", "32x18", "xc:rgb(128,128,128)", f"{tpl}/default.png"], check=True)
os.symlink(mock, f"{bindir}/magick")
log = f"{work}/magick.log"
env = dict(os.environ, HOME=home, PATH=f"{bindir}:{os.environ['PATH']}", TERM="xterm-256color",
           MOCK_MAGICK_LOG=log, MOCK_MAGICK_DELAY="1", MOCK_MAGICK_TEMPLATE_DIR=tpl,
           MOCK_MAGICK_TEMPLATE=f"{tpl}/default.png", MOCK_MAGICK_REAL="/usr/bin/magick")
for k in ("SWAYSOCK", "HYPRLAND_INSTANCE_SIGNATURE", "DISPLAY", "WAYLAND_DISPLAY", "TMUX", "KITTY_WINDOW_ID", "TERM_PROGRAM"):
    env.pop(k, None)

t = Checks("gallery thumbs")
check = t.check


class Term(Pty):
    """answers the cell-size / device-attributes query like a terminal"""
    answered = 0

    def pump(self, sec=0.05):
        super().pump(sec)
        asked = self.out.count(b"\x1b[16t")
        while self.answered < asked:
            self.answered += 1
            try:
                os.write(self.fd, b"\x1b[6;20;10t\x1b[?62;1;6c")
            except OSError:
                return

    def pump_fine(self, sec):
        """like pump, in 2ms steps (for latencies)"""
        end = time.monotonic() + sec
        while time.monotonic() < end and not self.closed:
            self.pump(0.002)


def spawn(cols, rows, plimit="2"):
    open(log, "w").close()
    pid, fd = pty.fork()
    if pid == 0:
        os.execve(wr, [wr, "-d", walls, "-n", "-P", "symbols", "-x", plimit,
                       "-s", "20x6", "--highlight", "border"], env)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, cols * 10, rows * 20))
    return Term(pid, fd)


def batches():
    """[(start, end or None, pid, [basenames])] of thumbnail batches, and
    the peak number of magick processes (any kind) running at once"""
    out, open_ = [], {}
    events = []
    try:
        text = open(log).read()
    except FileNotFoundError:
        text = ""
    for l in text.splitlines():
        p = l.split()
        if len(p) < 3:
            continue
        ts, pid = float(p[1]), p[2]
        if p[0] == "START":
            events.append((ts, 1))
            if p[3:] != ["PASS"]:
                open_[pid] = len(out)
                out.append([ts, None, pid, [os.path.basename(s) for s in p[3:]]])
        elif p[0] == "END":
            events.append((ts, -1))
            if pid in open_:
                out[open_.pop(pid)][1] = ts
    level = peak = 0
    for _, d in sorted(events, key=lambda e: (e[0], e[1])):
        level += d
        peak = max(peak, level)
    return out, peak


def finished(names):
    done = {n for b in batches()[0] if b[1] is not None for n in b[3]}
    return all(n in done for n in names)


def highlight_cols(buf):
    """columns where a selection frame was drawn, in order"""
    return [int(c) for c in re.findall(r"\x1b\[\d+;(\d+)H╭".encode(), buf)]


def shows(buf, i):
    return re.search(rb"[34]8;5;%d[;m]" % CUBE[i][1], buf) is not None


def temps():
    return glob.glob(f"{pic}/*.tmp")


def mock_pids():
    """pids of the slow mock, found through /proc (this test's log names them)"""
    mine = {b[2] for b in batches()[0]}
    alive = []
    for pid in os.listdir("/proc"):
        if not pid.isdigit():
            continue
        try:
            cmd = open(f"/proc/{pid}/cmdline", "rb").read().replace(b"\0", b" ")
        except OSError:
            continue
        if pid in mine and b"magick" in cmd:  # (the mock runs as bin/magick)
            alive.append(pid)
    return alive


def no_leftovers(name):
    check(f"{name}: no temp files left", temps() == [], str(temps()))
    check(f"{name}: no magick left running", mock_pids() == [], str(mock_pids()))
    bad = [p for p in glob.glob(f"{pic}/*.png") if os.path.getsize(p) not in SIZES]
    check(f"{name}: no half-written thumbnail", bad == [], str(bad))


SIZES = {os.path.getsize(p) for p in glob.glob(f"{tpl}/*.png")}


def quit(term, name):
    term.write(b"q")
    check(f"{name}: quits", term.wait_exit(f"WallRizz to quit ({name})", sec=10))


# ---------- 1-4: cold first page of 40 ----------
make_walls(N)
order = [n for n in os.listdir(walls)]  # WallRizz lists in directory order
# 100x32, -s 20x6 + padding 2x1 -> 21x8 per tile: 4 columns x 4 rows
PAGE = 16
page1, page2 = order[:PAGE], order[PAGE:PAGE * 2]
term = spawn(100, 32)
t0 = time.monotonic()
ok = term.wait_for("the placeholder frames", lambda: term.out.count("┌".encode()) >= PAGE - 1, sec=10)
frames_at = time.monotonic() - t0
check("cold page: an empty frame per tile", ok, f"{term.out.count('┌'.encode())} frames")
check("cold page: frames within 0.3s", ok and frames_at < deadline(0.3), f"{frames_at:.3f}s")

lats = []
busy_while_keys = True
for _ in range(5):
    before = len(highlight_cols(term.out))
    term.write(b"l")
    t1 = time.monotonic()
    while len(highlight_cols(term.out)) <= before and time.monotonic() - t1 < deadline(2):
        term.pump_fine(0.002)
    lats.append(time.monotonic() - t1)
    busy_while_keys &= not finished(page1)
    term.pump_fine(0.1)
cols = highlight_cols(term.out)
check("cold page: keys move the selection", len(set(cols)) >= 4, str(cols))
check("cold page: keys were handled while the page was still generating", busy_while_keys)
check("cold page: each key handled within 100ms", max(lats) < deadline(0.1),
      " ".join(f"{v * 1000:.0f}ms" for v in lats))

term.wait_for("the visible page's thumbnails", lambda: finished(page1), sec=60)
check("cold page: every image of the page is drawn",
      term.wait_for("page 1's images", lambda: all(shows(term.out, int(n[1:3])) for n in page1), sec=10))
bs, peak = batches()
check("magick processes at once never above -x 2", 1 <= peak <= 2, f"peak {peak}")
page1_end = max(b[1] for b in bs if b[1] and set(b[3]) & set(page1))
early = [n for b in bs for n in b[3] if n not in page1 and b[0] < page1_end - 0.01]
check("prefetch never starts before the visible page is done", early == [], str(early))
check("visible page first: its batches carry only its wallpapers",
      all(set(b[3]) <= set(page1) for b in bs if b[0] < page1_end - 0.01))
term.wait_for("the next page to be prefetched", lambda: finished(page2), sec=60)
term.pump(0.5)  # their tile encodes
before = len(term.out)
term.write(b"L")
t1 = time.monotonic()
# page 2 is drawn: every one of its 16 images on screen
def page2_drawn():
    region = term.out[before:]
    return all(shows(region, int(n[1:3])) for n in page2)
while not page2_drawn() and time.monotonic() - t1 < deadline(5):
    term.pump_fine(0.002)
flip = time.monotonic() - t1
check("prefetched page 2 is drawn within 0.2s", page2_drawn() and flip < deadline(0.2),
      f"{flip:.3f}s")
starts_after_flip = [b for b in batches()[0] if b[0] > time.time() - flip - 0.05 and set(b[3]) & set(page2)]
check("prefetched page 2 needs no magick", starts_after_flip == [], str(starts_after_flip))
print(f"  measured: frames {frames_at * 1000:.0f}ms, keys " +
      " ".join(f"{v * 1000:.0f}ms" for v in lats) + f", page flip {flip * 1000:.0f}ms, "
      f"peak magick {peak}")
quit(term, "cold run")
no_leftovers("cold run")

# ---------- 5: paging through 5 pages quickly ----------
shutil.rmtree(f"{home}/.cache", ignore_errors=True)
make_walls(5)
order = [n for n in os.listdir(walls)]
idx = {n: int(n[1:3]) for n in order}
term = spawn(30, 12)  # one 21x8 tile per page
term.wait_for("the first frame", lambda: b"\x1b[3J" in term.out, sec=10)
for _ in range(4):
    term.write(b"L")
    term.pump(0.05)
last = idx[order[4]]
shown = term.wait_for("the last page's image", lambda: shows(term.out, last), sec=60)
check("fast paging: the final page's image is drawn", shown)
at = re.search(rb"[34]8;5;%d[;m]" % CUBE[last][1], term.out)
cut = term.out.rfind(b"\x1b[3J", 0, at.start() if at else len(term.out))
term.pump(2.5)  # stale batches finish meanwhile: none may be drawn
leaked = [n for n in order[:4] if shows(term.out[cut:], idx[n])]
check("fast paging: no earlier page's image drawn on the final page", leaked == [], str(leaked))
quit(term, "fast paging")
no_leftovers("fast paging")

# ---------- 6: cache key, cache hit ----------
shutil.rmtree(f"{home}/.cache", ignore_errors=True)
make_walls(8)
term = spawn(100, 32, plimit="4")
term.wait_for("all 8 thumbnails", lambda: len(glob.glob(f"{pic}/*.png")) >= 8, sec=60)
quit(term, "cache: first run")
first = {p for p in os.listdir(pic) if p.endswith(".png")}
w00 = [n for n in first if n.startswith("w00-")]
check("cache key: the thumbnail is named after the wallpaper", len(w00) == 1, str(sorted(first)[:2]))
future = time.time() + 30
os.utime(f"{walls}/w00.jpg", (future, future))  # touch: new mtime
with open(f"{walls}/w01.jpg", "ab") as f:      # edit: new size
    f.write(b"\0" * 16)
term = spawn(100, 32, plimit="4")
new = lambda: {p for p in os.listdir(pic) if p.endswith(".png")} - first
term.wait_for("two new thumbnails", lambda: len(new()) == 2, sec=30)
check("cache key: new mtime and new size give new thumbnails",
      sorted(n[:3] for n in new()) == ["w00", "w01"], str(sorted(new())))
redone = sorted(n for b in batches()[0] for n in b[3])
check("cache key: only the changed wallpapers are regenerated", redone == ["w00.jpg", "w01.jpg"],
      str(redone))
# the startup cache cleanup (in the background) removes the two stale
# thumbnails of the changed wallpapers and keeps the six others
stale = {n for n in first if n[:3] in ("w00", "w01")}
term.wait_for("stale thumbnails cleaned up", lambda: not (stale & set(os.listdir(pic))), sec=30)
check("cache key: stale thumbnails cleaned up, the others kept",
      not (stale & set(os.listdir(pic))) and (first - stale) <= set(os.listdir(pic)),
      str(sorted(set(os.listdir(pic)))))
quit(term, "cache: changed")
term = spawn(100, 32, plimit="4")
term.wait_for("the cached page", lambda: term.out.count(b"\x1b[0m") >= 8, sec=10)
term.pump(1.5)  # time enough for a cache miss to launch magick
check("cache hit: no thumbnail magick launched", batches()[0] == [], str(batches()[0][:2]))
quit(term, "cache: warm")
no_leftovers("cache runs")


# ---------- 7: interruption ----------
def interrupt(name, how):
    shutil.rmtree(f"{home}/.cache", ignore_errors=True)
    make_walls(N)
    term = spawn(100, 32)
    started = term.wait_for("a thumbnail batch to start",
                            lambda: batches()[0] != [] and mock_pids() != [], sec=10)
    # mid-write: the mock writes half a file, then sleeps
    term.wait_for("a partial temp file", lambda: temps() != [], sec=5)
    check(f"{name}: generation was in progress", started and temps() != [] and mock_pids() != [],
          f"temps {temps()} mocks {mock_pids()}")
    how(term)
    gone = term.wait_exit(f"WallRizz to exit after {name}", sec=10)
    check(f"{name}: WallRizz exits", gone, f"status {term.status}")
    term.pump(0.3)
    no_leftovers(name)


interrupt("q", lambda term: term.write(b"q"))
interrupt("Ctrl+C", lambda term: term.write(b"\x03"))
interrupt("SIGTERM", lambda term: os.kill(term.pid, 15))
t.done()
