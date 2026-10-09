#!/usr/bin/env python3
"""--clear-cache / --clear-thumbnails and the startup cache cleanup, end to
end with the real binary:

  1. --help lists both flags (no short flags), each default stated once
  2. --clear-thumbnails: removes pic/, tiles/, composites/, fullscreen
     files, keeps colours and themes, prints what was freed, exit 0, never
     opens the picker (no alternate screen)
  3. --clear-cache: removes everything, prints the space freed, exit 0
  4. both follow XDG_CACHE_HOME (and leave $HOME/.cache alone); without
     HOME and XDG_CACHE_HOME they refuse with exit 1
  5. startup cleanup (in the background after the first page): legacy and
     orphaned entries go, the current thumbnails stay, colours.json loses
     the entries of a removed source
usage: cache-flags.test.py WALLRIZZ_BIN WORKDIR
"""
import json, os, pty, shutil, struct, subprocess, sys, fcntl, termios
sys.dont_write_bytecode = True  # no __pycache__ in the source tree
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from testlib import Checks, Pty, deadline

wr, work = (os.path.abspath(a) for a in sys.argv[1:3])
shutil.rmtree(work, ignore_errors=True)
home, xdg = f"{work}/home", f"{work}/xdg"
os.makedirs(f"{home}/.config/WallRizz")
with open(f"{home}/.config/WallRizz/stub@test.js", "w") as f:
    f.write("export function setWallpaper(path) {}\n")
t = Checks("cache flags")
check = t.check
base_env = {k: v for k, v in os.environ.items() if k not in ("XDG_CACHE_HOME", "WALLRIZZ_CACHE_MAX_MB")}


def run(args, env):
    p = subprocess.run([wr] + args, env=env, capture_output=True, timeout=deadline(30))
    return p.returncode, p.stdout.decode(errors="replace"), p.stderr.decode(errors="replace")


def fill(root):
    files = {
        "pic/a-00000001-1-1-600x338.png": 3000, "tiles/v2/a-00000001-1-1-600x338~ab.b64": 1000,
        "composites/page-ab.png": 2000, "composites/page-ab.txt": 100, "fullscreen.jpg": 500,
        "themes/a.png-dark.conf": 50, "colours.json": 20,
    }
    for rel, size in files.items():
        os.makedirs(os.path.dirname(f"{root}/{rel}"), exist_ok=True)
        with open(f"{root}/{rel}", "wb") as f:
            f.write(b"x" * size)


# 1. --help
code, out, _ = run(["--help"], dict(base_env, HOME=home))
# (boolean flags are listed as --(no-)NAME by the argument parser)
import re
check("--help lists --clear-cache, no short flag", re.search(r"^  --\(no-\)clear-cache ", out, re.M), out[-800:])
check("--help lists --clear-thumbnails, no short flag", re.search(r"^  --\(no-\)clear-thumbnails ", out, re.M))
check("--help lists --cache-max", "--cache-max" in out)
# every option states its default at most once (--cache-max used to say
# "(default: 1024)" twice: in its description and from the arg library)
blocks, cur = [], None
for line in out.split("\n"):
    if re.match(r"^  -", line):
        cur = [line]
        blocks.append(cur)
    elif cur is not None:
        cur.append(line)
twice = [b[0].split(":")[0].strip() for b in blocks if "\n".join(b).count("(default:") > 1]
check("--help: no option states its default twice", not twice and blocks, str(twice))
cm = next((b for b in blocks if "--cache-max" in b[0]), [])
check("--help: --cache-max shows (default: 1024) exactly once", "\n".join(cm).count("(default: 1024)") == 1, "\n".join(cm))

# 2. --clear-thumbnails (HOME cache)
hc = f"{home}/.cache/WallRizz"
fill(hc)
code, out, err = run(["--clear-thumbnails"], dict(base_env, HOME=home))
check("--clear-thumbnails exits 0", code == 0, f"{code} {err}")
check("--clear-thumbnails prints the freed space", "Freed 6.4 KB (5 files)." in out, out)
check("--clear-thumbnails names the cache dir", f"{hc}/" in out, out)
check("--clear-thumbnails never opens the picker", "\x1b[?1049h" not in out)
check("images removed", not any(os.path.exists(f"{hc}/{d}") for d in
                                ("pic/a-00000001-1-1-600x338.png", "composites/page-ab.png", "fullscreen.jpg")))
check("colours and themes kept", os.path.exists(f"{hc}/colours.json") and os.path.exists(f"{hc}/themes/a.png-dark.conf"))
check("says colours/themes were kept", "Colours and theme files were kept." in out)

# 3. --clear-cache
code, out, err = run(["--clear-cache"], dict(base_env, HOME=home))
check("--clear-cache exits 0", code == 0, f"{code} {err}")
check("--clear-cache removed the cache dir", not os.path.exists(hc))
check("--clear-cache prints what it freed", "Removed the cache in" in out and "Freed" in out, out)
check("--clear-cache never opens the picker", "\x1b[?1049h" not in out)
code, out, _ = run(["--clear-cache"], dict(base_env, HOME=home))
check("--clear-cache on an empty cache: exit 0, nothing to remove", code == 0 and "Nothing to remove" in out, out)

# 4. XDG_CACHE_HOME
xc = f"{xdg}/WallRizz"
fill(xc)
fill(hc)
code, out, _ = run(["--clear-cache"], dict(base_env, HOME=home, XDG_CACHE_HOME=xdg))
check("XDG: --clear-cache clears $XDG_CACHE_HOME/WallRizz", code == 0 and not os.path.exists(xc) and f"{xc}/" in out, out)
check("XDG: $HOME/.cache/WallRizz untouched", os.path.exists(f"{hc}/pic/a-00000001-1-1-600x338.png"))
shutil.rmtree(hc)
env = {k: v for k, v in base_env.items() if k not in ("HOME",)}
code, out, err = run(["--clear-cache"], env)
check("no HOME / XDG_CACHE_HOME: refuses with exit 1", code == 1 and "WallRizz:" in err, f"{code} {out} {err}")
code, out, err = run(["--clear-thumbnails"], dict(env, XDG_CACHE_HOME="relative/path"))
check("relative XDG_CACHE_HOME and no HOME: refuses", code == 1, f"{code} {out} {err}")

# 5. startup cleanup, in a pty with symbols
walls = f"{work}/walls"
os.makedirs(walls)
for i in range(4):
    subprocess.run(["magick", "-size", "64x36", "plasma:fractal", f"{walls}/w{i}.jpg"], check=True)
xc = f"{xdg}/WallRizz"
os.makedirs(f"{xc}/pic")
os.makedirs(f"{xc}/tiles/v1/x")
os.makedirs(f"{xc}/composites")
legacy, v1 = f"{xc}/pic/123456.png", f"{xc}/tiles/v1/x/a.out"
orphan_comp, gone_thumb = f"{xc}/composites/page-ff.png", f"{xc}/pic/g-0000000c-1000-1-600x338.png"
for p in (legacy, v1, orphan_comp, gone_thumb):
    open(p, "w").write("x")
gone_key = "g-0000000c-1000-1-600x338.png"
json.dump({gone_key: [1, 2]}, open(f"{xc}/colours.json", "w"))
json.dump({"g-0000000c-1000-1-600x338": f"{work}/removed/g.jpg"}, open(f"{xc}/sources.json", "w"))
env = dict(base_env, HOME=home, XDG_CACHE_HOME=xdg, TERM="xterm-256color")
for k in ("SWAYSOCK", "HYPRLAND_INSTANCE_SIGNATURE", "DISPLAY", "WAYLAND_DISPLAY", "TMUX", "KITTY_WINDOW_ID", "TERM_PROGRAM"):
    env.pop(k, None)
pid, fd = pty.fork()
if pid == 0:
    os.execve(wr, [wr, "-d", walls, "-n", "-P", "symbols"], env)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 1200, 800))
term = Pty(pid, fd)
pics = lambda: [n for n in os.listdir(f"{xc}/pic") if n.startswith("w") and n.endswith(".png")]
check("thumbnails made", term.wait_for("4 thumbnails", lambda: len(pics()) == 4, 60))
check("startup cleanup removed legacy, v1, orphaned composite and gone thumbnail",
      term.wait_for("cleanup", lambda: not any(os.path.exists(p) for p in (legacy, v1, orphan_comp, gone_thumb)), 60),
      str([p for p in (legacy, v1, orphan_comp, gone_thumb) if os.path.exists(p)]))
check("current thumbnails kept", len(pics()) == 4)
term.wait_for("colours.json pruned", lambda: gone_key not in open(f"{xc}/colours.json").read())
check("colours.json lost the removed source's entry", gone_key not in open(f"{xc}/colours.json").read())
src = json.load(open(f"{xc}/sources.json"))
check("sources.json lists the scanned wallpapers", sum(1 for v in src.values() if v.startswith(walls)) == 4, str(src))
check("nothing in $HOME/.cache", not os.path.exists(f"{home}/.cache/WallRizz"))
term.write(b"q")
check("WallRizz exits on q", term.wait_exit("WallRizz to exit after q"), f"status={term.status}")
t.done()
