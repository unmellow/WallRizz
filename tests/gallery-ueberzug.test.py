#!/usr/bin/env python3
"""Grid view + Überzug++ crash handling, end to end, in a pty.

Runs the real WallRizz binary with -P ueberzug against tests/mock-ueberzugpp:
  1. instance 1 is SIGKILLed by this test in the middle of page 1
  2. instances 2 and 3 abort (SIGABRT) after a few commands (MOCK_UZ_DIE_AFTER)
and checks that WallRizz
  - paces the adds (WALLRIZZ_UEBERZUG_SPACING_MS, doubled on each restart),
  - restarts ueberzugpp exactly twice and redraws the current page each time,
  - then falls back to chafa symbols with a one-line notice (chafa gets
    --probe off),
  - leaves no ueberzugpp process behind and exits cleanly on q.
usage: gallery-ueberzug.test.py WALLRIZZ_BIN MOCK WORKDIR
"""
import os, pty, shutil, signal, struct, subprocess, sys, fcntl, termios
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
for i in range(12):
    subprocess.run(["magick", "-size", "160x90", f"plasma:fractal", f"{walls}/w{i:02d}.jpg"], check=True)
os.symlink(mock, f"{bindir}/ueberzugpp")
# chafa wrapper: claims --probe support and logs every render's argv
shutil.copy(os.path.join(os.path.dirname(os.path.abspath(__file__)), "chafa-probe-wrapper"), f"{bindir}/chafa")
chafa_log = f"{work}/chafa.argv"
log, times, pids = f"{work}/uz.log", f"{work}/uz.times", f"{work}/uz.pids"
SPACING = 40
NOTICE = b"using text symbols"
env = dict(os.environ, HOME=home, PATH=f"{bindir}:{os.environ['PATH']}", TERM="xterm-256color",
           WALLRIZZ_UEBERZUG_OUTPUT="wayland", WALLRIZZ_UEBERZUG_SPACING_MS=str(SPACING),
           MOCK_UZ_LOG=log, MOCK_UZ_TIMES=times, MOCK_UZ_PIDS=pids,
           MOCK_UZ_DIE_AFTER="4", MOCK_UZ_DIE_SKIP="1", CHAFA_ARGV_LOG=chafa_log)
for k in ("DISPLAY", "WAYLAND_DISPLAY", "TMUX", "KITTY_WINDOW_ID", "TERM_PROGRAM", "MOCK_CHAFA_OLD"):
    env.pop(k, None)

t = Checks("gallery ueberzug")
check = t.check

pid, fd = pty.fork()
if pid == 0:
    os.execve(wr, [wr, "-d", walls, "-n", "-P", "ueberzug", "-s", "20x5"], env)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 1200, 800))
term = Pty(pid, fd)


def lines(path):
    try:
        return open(path).read().split("\n")
    except FileNotFoundError:
        return []


def uz_alive():
    alive = []
    for p in map(int, filter(None, lines(pids))):
        try:
            os.kill(p, 0)
            alive.append((p, open(f"/proc/{p}/stat").read().split()[2]))
        except (ProcessLookupError, FileNotFoundError):
            pass
    return alive


def renders():
    return [l for l in lines(chafa_log) if l]


def symbols_after_notice():
    return term.out.rfind(b"\x1b[38;") > term.out.find(NOTICE) > 0


def give_up():
    if not term.exited():
        os.kill(pid, signal.SIGTERM)
        term.wait_exit("WallRizz to exit after SIGTERM", 10)
    t.done()


# 1. first layer: wait for 3 adds of page 1, then kill it mid-page
adds1 = lambda: [l for l in lines(times) if " add " in l]
if not check("first page adds start (thumbnails + first adds)",
             term.wait_for("3 adds from the first ueberzugpp", lambda: len(adds1()) >= 3, 60)):
    give_up()
first_pid = int(lines(pids)[0])
os.kill(first_pid, signal.SIGKILL)
# 2./3. restarts abort after 4 commands; then symbols fallback
if not check("fallback notice shown", term.wait_for("the symbols fallback notice", lambda: NOTICE in term.out),
             repr(term.out[-300:])):
    give_up()
# the fallback is complete once the symbols are on screen and every
# ueberzugpp instance is gone (reaped)
term.wait_for("symbols drawn and all ueberzugpp instances gone",
              lambda: symbols_after_notice() and renders() and not uz_alive())

argv = [l for l in lines(log) if l.startswith("ARGV")]
check("ueberzugpp started 3 times (1 + 2 restarts)", len(argv) == 3, str(argv))
check("restarted layers aborted", lines(log).count("ABORT") == 2)
# per instance: add spacing doubles (40, 80, 160 ms) and page 1 is redrawn
inst, cur = [], None
for l in lines(log):
    if l.startswith("ARGV"):
        cur = []
        inst.append(cur)
    elif l.startswith('CMD {"action":"add"') and cur is not None:
        cur.append(l)
check("every instance got page-1 adds", len(inst) == 3 and all(
    i and all('"identifier":"wallrizz-p0-' in a for a in i) for i in inst), str([len(i) for i in inst]))
ts_all = [float(l.split()[0]) * 1000 for l in lines(times) if " add " in l]
# split the add timestamps into the 3 instances by count. The times are
# taken where the mock *reads* each line, so one late read can make the
# next gap look short on a busy machine; a burst, though, packs all adds
# into a few ms. Check the span: n adds sent >= want apart cover at least
# (n-1) x want, minus at most one spacing for a late first read.
counts = [len(i) for i in inst]
k = 0
for n, want in zip(counts, (SPACING, SPACING * 2, SPACING * 4)):
    ts = ts_all[k:k + n]
    k += n
    gaps = [b - a for a, b in zip(ts, ts[1:])]
    span = ts[-1] - ts[0] if len(ts) > 1 else 0
    check(f"adds paced {want} ms apart ({n} adds span >= {n - 2} x {want} ms)",
          n < 2 or span >= (n - 2) * want, f"gaps {[round(g) for g in gaps]}")
check("no ueberzugpp left (no zombies)", not uz_alive(), str(uz_alive()))
r = renders()
check("fallback symbols rendered with chafa --probe off",
      r and all("-f symbols" in l and "--probe off" in l for l in r), str(r[:2]))
check("symbols drawn after fallback", symbols_after_notice())
# 4. still responsive: next page, then quit
term.write(b"L")
term.write(b"q")
check("WallRizz exits on q", term.wait_exit("WallRizz to exit after q"), f"status={term.status}")
t.done()
