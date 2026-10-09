#!/usr/bin/env python3
"""Überzug++ page mode (one transparent composite overlay per page), end to
end in a pty, against tests/mock-ueberzugpp and the slow mock magick
(~MOCK_MAGICK_DELAY s per thumbnail, composites by the real magick):

  1. ueberzugpp runs as `layer --no-cache`; the cache follows XDG_CACHE_HOME
  2. a cold page fills in progressively: partial composites are new files in
     the memory-backed live dir (never the cache), each update is a new
     identifier added on top, the previous one removed after it, at most
     one update per WALLRIZZ_UEBERZUG_SPACING_MS; the final composite is
     cached (png + .txt) and the partial files are deleted
  3. the composite has every tile at its position (colour per wallpaper)
  4. selection moves send no ueberzugpp command
  5. fast paging (4 page keys at once): only the page stopped on is drawn,
     the old page's overlay is removed, no skipped page is ever added
  6. back to a page already seen: one add of the cached composite, and the
     old page's overlay is removed only after that add
  7. ueberzugpp killed: restart, restart, then chafa symbols
  8. q: exits, no ueberzugpp left, no live partial file of this run left
usage: gallery-pages.test.py WALLRIZZ_BIN MOCK_UEBERZUGPP MOCK_MAGICK WORKDIR
"""
import glob, json, os, pty, shutil, signal, struct, subprocess, sys, time, fcntl, termios
sys.dont_write_bytecode = True  # no __pycache__ in the source tree
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from testlib import Checks, Pty

wr, mock_uz, mock_magick, work = (os.path.abspath(a) for a in sys.argv[1:5])
shutil.rmtree(work, ignore_errors=True)
home, walls, bindir, tpl = f"{work}/home", f"{work}/walls", f"{work}/bin", f"{work}/tpl"
xdg_cache, run_dir = f"{work}/xdg-cache", f"{work}/run"
for d in (f"{home}/.config/WallRizz", walls, bindir, tpl, xdg_cache, run_dir):
    os.makedirs(d)
os.chmod(run_dir, 0o700)
with open(f"{home}/.config/WallRizz/stub@test.js", "w") as f:
    f.write("export function setWallpaper(path) {}\n")
N, PER_PAGE = 40, 8  # -g 4x2: 5 pages
COLOURS = {}
for i in range(N):
    rgb = ((i * 53) % 200 + 40, (i * 97) % 200 + 40, (i * 151) % 200 + 40)
    COLOURS[i] = rgb
    subprocess.run(["magick", "-size", "64x36", "xc:gray", f"{walls}/w{i:02d}.jpg"], check=True)
    subprocess.run(["magick", "-size", "32x18", f"xc:rgb{rgb}", f"{tpl}/w{i:02d}.png"], check=True)
subprocess.run(["magick", "-size", "32x18", "xc:gray", f"{tpl}/default.png"], check=True)
os.symlink(mock_uz, f"{bindir}/ueberzugpp")
os.symlink(mock_magick, f"{bindir}/magick")
shutil.copy(os.path.join(os.path.dirname(os.path.abspath(__file__)), "chafa-probe-wrapper"), f"{bindir}/chafa")
log, pids = f"{work}/uz.log", f"{work}/uz.pids"
UPDATE_MS = 150
NOTICE = b"using text symbols"
env = dict(os.environ, HOME=home, XDG_CACHE_HOME=xdg_cache, XDG_RUNTIME_DIR=run_dir,
           PATH=f"{bindir}:{os.environ['PATH']}", TERM="xterm-256color",
           WALLRIZZ_UEBERZUG_OUTPUT="wayland", WALLRIZZ_UEBERZUG_SPACING_MS=str(UPDATE_MS),
           MOCK_UZ_LOG=log, MOCK_UZ_PIDS=pids, CHAFA_ARGV_LOG=f"{work}/chafa.argv",
           MOCK_MAGICK_DELAY="0.25", MOCK_MAGICK_TEMPLATE_DIR=tpl,
           MOCK_MAGICK_TEMPLATE=f"{tpl}/default.png", MOCK_MAGICK_REAL=shutil.which("magick") or "/usr/bin/magick")
for k in ("SWAYSOCK", "HYPRLAND_INSTANCE_SIGNATURE", "DISPLAY", "WAYLAND_DISPLAY", "TMUX", "KITTY_WINDOW_ID", "TERM_PROGRAM", "MOCK_CHAFA_OLD",
          "WALLRIZZ_UEBERZUG_OVERLAY", "WALLRIZZ_UEBERZUG_DEBOUNCE_MS", "WALLRIZZ_CACHE_MAX_MB"):
    env.pop(k, None)
cache = f"{xdg_cache}/WallRizz"

t = Checks("gallery pages")
check = t.check

pid, fd = pty.fork()
if pid == 0:
    os.execve(wr, [wr, "-d", walls, "-n", "-P", "ueberzug", "-e", "-g", "4x2", "-x", "2"], env)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 1200, 800))
term = Pty(pid, fd)


def lines(path):
    try:
        return open(path).read().split("\n")
    except FileNotFoundError:
        return []


def cmds(instance=None):
    """[(instance, action, identifier, path)] from the mock's log"""
    out, inst = [], -1
    for l in lines(log):
        if l.startswith("ARGV"):
            inst += 1
        elif l.startswith("CMD "):
            try:
                c = json.loads(l[4:])
            except ValueError:
                continue
            if instance is None or inst == instance:
                out.append((inst, c.get("action"), c.get("identifier", ""), c.get("path", "")))
    return out


def adds(prefix=""):
    return [c for c in cmds() if c[1] == "add" and c[2].startswith(prefix)]


def page_of(ident):
    return int(ident.split("-")[1][1:])  # wallrizz-p<page>-g<gen>-page-u<n>


def full_composite(c):
    return f"{cache}/composites/page-" in c[3]


def uz_alive():
    alive = []
    for p in map(int, filter(None, lines(pids))):
        try:
            os.kill(p, 0)
            if open(f"/proc/{p}/stat").read().split()[2] != "Z":
                alive.append(p)
        except (ProcessLookupError, FileNotFoundError):
            pass
    return alive


def give_up():
    if not term.exited():
        os.kill(pid, signal.SIGTERM)
        term.wait_exit("WallRizz to exit after SIGTERM", 10)
    t.done()


# 1./2. cold first page, progressive
if not check("first page complete (cached composite added)",
             term.wait_for("the full composite of page 0", lambda: any(full_composite(c) for c in adds("wallrizz-p0-")), 90)):
    give_up()
argv = [l for l in lines(log) if l.startswith("ARGV")]
check("ueberzugpp started as layer --no-cache", argv and "layer" in argv[0] and "--no-cache" in argv[0], str(argv))
p0 = adds("wallrizz-p0-")
partial = [c for c in p0 if not full_composite(c)]
check("cold page filled in progressively (partial updates before the final)", len(partial) >= 1, str(p0))
live_dirs = {os.path.dirname(c[3]) for c in partial}
check("partials are in the live dir, never in the cache",
      all(d and not d.startswith(cache) for d in live_dirs) and all(
          d.startswith("/dev/shm/wallrizz-") or d == f"{run_dir}/wallrizz" for d in live_dirs), str(live_dirs))
check("every update is a new file", len({c[3] for c in p0}) == len(p0), str(p0))
check("every update is a new identifier", len({c[2] for c in p0}) == len(p0), str(p0))
check("final composite is the last p0 add", full_composite(p0[-1]))
# superseded overlays are removed, each after its successor was added
seq = [c for c in cmds() if c[2].startswith("wallrizz-p0-")]
term.wait_for("superseded p0 overlays removed",
              lambda: all(any(x[1] == "remove" and x[2] == c[2] for x in cmds()) for c in p0[:-1]))
seq = [c for c in cmds() if c[2].startswith("wallrizz-p0-")]
order_ok = all(
    any(x[1] == "remove" and x[2] == c[2] for x in seq) and
    min(j for j, x in enumerate(seq) if x[1] == "remove" and x[2] == c[2]) > seq.index(p0[k + 1])
    for k, c in enumerate(p0[:-1]))
check("each superseded overlay is removed after its successor's add", order_ok, str(seq))
check("the complete page is never removed while shown",
      not any(x[1] == "remove" and x[2] == p0[-1][2] for x in cmds()))
final = p0[-1][3]
check("final composite cached with its .txt", os.path.exists(final) and os.path.exists(final[:-4] + ".txt"))
check("nothing written to $HOME/.cache (XDG_CACHE_HOME is used)", not os.path.exists(f"{home}/.cache/WallRizz"))
term.wait_for("partial files deleted once the final composite is shown",
              lambda: not any(os.path.exists(c[3]) for c in partial))
check("partial files deleted", not any(os.path.exists(c[3]) for c in partial), str([c[3] for c in partial]))

# 3. tile positions in the composite: each wallpaper's colour in its tile
def pixel(path, x, y):
    out = subprocess.run(["magick", path, "-format", f"%[pixel:p{{{x},{y}}}]", "info:"],
                         capture_output=True, text=True).stdout
    return out.strip()
size = subprocess.run(["magick", "identify", "-format", "%w %h", final], capture_output=True, text=True).stdout.split()
w, h = int(size[0]), int(size[1])
# the .txt lists the page's thumbnail ids in tile order (row-major); the
# grid is 2 columns x 4 rows here (-g 4x2 at this terminal size). Sample
# each tile's centre: it must be that wallpaper's colour
ids = [l for l in open(final[:-4] + ".txt").read().split("\n") if l]
cols, rows = 2, 4
pos_ok = []
for i, tid in enumerate(ids):
    cx, cy = int((i % cols + 0.5) * w / cols), int((i // cols + 0.5) * h / rows)
    want = "srgb(%d,%d,%d)" % COLOURS[int(tid[1:3])]
    got = pixel(final, cx, cy).replace("srgba", "srgb").replace(",1)", ")")
    pos_ok.append(got == want)
check("composite lists the page's 8 thumbnails", len(ids) == PER_PAGE, str(ids))
check("every tile's thumbnail sits at its tile position", all(pos_ok), str(pos_ok))
corner = pixel(final, 0, 0)
check("gaps between tiles are transparent", corner.endswith(",0)") or "none" in corner, corner)

# 4. selection moves: no command at all
n0 = len(cmds())
out0 = len(term.out)
term.write(b"l")
term.write(b"l")
term.write(b"j")
term.wait_for("selection redrawn", lambda: len(term.out) > out0 + 20)
time.sleep(0.6)
term.pump(0.1)
check("selection moves send no ueberzugpp command", len(cmds()) == n0, str(cmds()[n0:]))

# 5. fast paging: 4 page keys at once, stop on page 4
n1 = len(cmds())
term.write(b"LLLL")
if not check("stop page (4) drawn",
             term.wait_for("the full composite of page 4", lambda: any(full_composite(c) for c in adds("wallrizz-p4-")), 90)):
    give_up()
after = cmds()[n1:]
skipped = [c for c in after if c[1] == "add" and page_of(c[2]) in (1, 2, 3)]
check("skipped pages 1-3 never added", not skipped, str(skipped))
check("page 0's overlay removed on fast paging",
      any(c[1] == "remove" and c[2] == p0[-1][2] for c in after))
first_p4 = next(j for j, c in enumerate(after) if c[1] == "add" and page_of(c[2]) == 4)
rm_p0 = next(j for j, c in enumerate(after) if c[1] == "remove" and c[2] == p0[-1][2])
check("burst: the old overlay goes before the stop page is drawn", rm_p0 < first_p4)

# 6. page 3 (cold), then back to page 4: one cached add, old removed after it
term.write(b"H")
term.wait_for("page 3 complete", lambda: any(full_composite(c) for c in adds("wallrizz-p3-")), 90)
p4_final = [c for c in adds("wallrizz-p4-") if full_composite(c)][-1][3]
p3_last = adds("wallrizz-p3-")[-1]
term.wait_for("page 3 settled", lambda: (time.sleep(0.4) or True) and adds()[-1] == p3_last)
n2 = len(cmds())
term.write(b"L")
term.wait_for("page 4 back", lambda: any(c[1] == "add" and page_of(c[2]) == 4 for c in cmds()[n2:]))
term.wait_for("old page removed", lambda: any(c[1] == "remove" and c[2] == p3_last[2] for c in cmds()[n2:]))
time.sleep(0.5)
term.pump(0.1)
back = cmds()[n2:]
back_adds = [c for c in back if c[1] == "add"]
check("seen page: exactly one add", len(back_adds) == 1, str(back))
check("seen page: the cached composite", back_adds and back_adds[0][3] == p4_final, str(back_adds))
ia = next((j for j, c in enumerate(back) if c[1] == "add"), 99)
ir = next((j for j, c in enumerate(back) if c[1] == "remove" and c[2] == p3_last[2]), -1)
check("seen page: the old overlay is removed after the new add", ir > ia, str(back))
check("composite cache file count = pages completed",
      len(glob.glob(f"{cache}/composites/page-*.png")) >= 3)

# 7. kill ueberzugpp three times: restart, restart, symbols
for k in range(3):
    pl = [int(p) for p in lines(pids) if p]
    os.kill(pl[-1], signal.SIGKILL)
    if k < 2:
        ok = term.wait_for(f"restart #{k + 1} redraws the page",
                           lambda: len([l for l in lines(log) if l.startswith("ARGV")]) == k + 2 and cmds(k + 1) and
                           any(c[1] == "add" for c in cmds(k + 1)))
        check(f"restart #{k + 1} redrew the current page", ok)
check("symbols fallback after the third death", term.wait_for("the symbols notice", lambda: NOTICE in term.out))
check("ueberzugpp started exactly 3 times", len([l for l in lines(log) if l.startswith("ARGV")]) == 3)

# 8. quit
term.write(b"q")
check("WallRizz exits on q", term.wait_exit("WallRizz to exit after q"), f"status={term.status}")
check("no ueberzugpp left", not uz_alive(), str(uz_alive()))
leftover = [p for d in live_dirs for p in glob.glob(f"{d}/partial-{pid}-*.png")]
check("no live partial file of this run left", not leftover, str(leftover))
t.done()
