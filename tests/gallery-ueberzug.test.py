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
import os, pty, select, signal, shutil, struct, subprocess, sys, time, fcntl, termios

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
env = dict(os.environ, HOME=home, PATH=f"{bindir}:{os.environ['PATH']}", TERM="xterm-256color",
           WALLRIZZ_UEBERZUG_OUTPUT="wayland", WALLRIZZ_UEBERZUG_SPACING_MS=str(SPACING),
           MOCK_UZ_LOG=log, MOCK_UZ_TIMES=times, MOCK_UZ_PIDS=pids,
           MOCK_UZ_DIE_AFTER="4", MOCK_UZ_DIE_SKIP="1", CHAFA_ARGV_LOG=chafa_log)
for k in ("DISPLAY", "WAYLAND_DISPLAY", "TMUX", "KITTY_WINDOW_ID", "TERM_PROGRAM"):
    env.pop(k, None)

passed = failed = 0
def check(name, ok, info=""):
    global passed, failed
    if ok: passed += 1
    else:
        failed += 1
        print(f"FAIL {name} {info}")

pid, fd = pty.fork()
if pid == 0:
    os.execve(wr, [wr, "-d", walls, "-n", "-P", "ueberzug", "-s", "20x5"], env)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 1200, 800))
out = b""
def pump(sec):
    global out
    end = time.time() + sec
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.05)
        if r:
            try:
                data = os.read(fd, 65536)
            except OSError:
                return
            if not data:
                return
            out += data
def lines(path):
    try:
        return open(path).read().split("\n")
    except FileNotFoundError:
        return []
def wait_for(cond, sec):
    end = time.time() + sec
    while time.time() < end:
        if cond():
            return True
        pump(0.05)
    return False

# 1. first layer: wait for 3 adds of page 1, then kill it mid-page
adds1 = lambda: [l for l in lines(times) if " add " in l]
check("first page adds start (thumbnails + first adds)", wait_for(lambda: len(adds1()) >= 3, 60))
first_pid = int(lines(pids)[0])
os.kill(first_pid, signal.SIGKILL)
# 2./3. restarts abort after 4 commands; then symbols fallback
check("fallback notice shown", wait_for(lambda: b"using text symbols" in out, 20), repr(out[-300:]))
pump(1.5)

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
t = []
for l in lines(times):
    if " add " in l:
        t.append(float(l.split()[0]) * 1000)
# split the add timestamps into the 3 instances by count
counts = [len(i) for i in inst]
k = 0
for n, want in zip(counts, (SPACING, SPACING * 2, SPACING * 4)):
    ts = t[k:k + n]
    k += n
    gaps = [b - a for a, b in zip(ts, ts[1:])]
    check(f"adds >= {want} ms apart", all(g >= want - 10 for g in gaps), f"{[round(g) for g in gaps]}")
alive = []
for p in map(int, filter(None, lines(pids))):
    try:
        os.kill(p, 0)
        st = open(f"/proc/{p}/stat").read().split()[2]
        alive.append((p, st))
    except (ProcessLookupError, FileNotFoundError):
        pass
check("no ueberzugpp left (no zombies)", not alive, str(alive))
renders = [l for l in lines(chafa_log) if l]
check("fallback symbols rendered with chafa --probe off",
      renders and all("-f symbols" in l and "--probe off" in l for l in renders), str(renders[:2]))
check("symbols drawn after fallback", out.rfind(b"\x1b[38;") > out.find(b"using text symbols") > 0)
# 4. still responsive: next page, then quit
os.write(fd, b"L")
pump(1.0)
os.write(fd, b"q")
pump(1.5)
try:
    wpid, status = os.waitpid(pid, os.WNOHANG)
except ChildProcessError:
    wpid, status = pid, 0
if not wpid:
    os.kill(pid, signal.SIGTERM)
    os.waitpid(pid, 0)
check("WallRizz exits on q", wpid == pid, f"status={status}")
print(f"gallery ueberzug tests: {passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
