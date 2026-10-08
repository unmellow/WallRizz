/**
 * Cache cleanup (runs in a worker thread at startup) and the
 * --clear-cache / --clear-thumbnails flags (main thread).
 *
 * Every cache file is attributed to a thumbnail id, the thumbnail's file
 * name without ".png": "<name>-<fnv1a(full path)>-<mtime>-<size>-<WxH>".
 *   pic/<id>.png                          thumbnail
 *   tiles/v2/<protocol>/<id>~<...>        encoded tile (iterm/sixel/symbols)
 *   composites/page-<key>.png + .txt      Überzug++ page composite; the .txt
 *                                         lists the ids it was made from
 *   themes/<script>/<id>.png-<dark|light>.conf, colours.json keys <id>.png
 * An id is judged against the wallpapers scanned this run:
 *   - scanned now, same path and same mtime/size/size  -> kept
 *   - same path scanned now, other mtime/size/WxH       -> stale, removed
 *   - path not scanned this run: removed only if the source file no longer
 *     exists (path from sources.json); otherwise kept
 *   - can't be attributed (no recorded path)            -> kept (cap only)
 * Legacy formats are removed: dev+inode names ("<digits>.png") and
 * tiles/v1/. Then the image caches (pic, tiles, composites) are trimmed to
 * the size cap, oldest first (max of mtime and atime), never touching a
 * file used during this run.
 *
 * Safety: only paths inside the resolved cache root are ever removed, the
 * root must end in "/WallRizz/" and can't resolve to "/" or $HOME,
 * symlinks are unlinked, never followed, and a "*.tmp" file whose writer
 * (pid in its name) is still running is never touched.
 */
import * as os from "os";
import * as std from "std";

const ID_RE = /^(.+)-([0-9a-f]{8})-(\d+)-(\d+)-(\d+x\d+)$/;
const LEGACY_ID_RE = /^\d+$/;
const TMP_PID_RE = /\.(\d+)-[^./]*\.tmp$/;
const PARTIAL_RE = /^partial-(\d+)-\d+\.png$/;
const HOUR = 3600 * 1000;
const IMAGE_DIRS = ["pic/", "tiles/", "composites/"];
const IMAGE_FILES = ["fullscreen-crop.png", "fullscreen-kitty.png", "fullscreen.jpg"];

export const DEFAULT_CACHE_MAX_MB = 1024;

/** 12345678 -> "11.8 MB" */
export function formatBytes(n) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return u === 0 ? `${v} B` : `${v.toFixed(1)} ${units[u]}`;
}

/** "<id>" parts or null */
export function parseThumbId(id) {
  const m = ID_RE.exec(id);
  return m ? { base: m[1], hash: m[2], mtime: m[3], size: m[4], thumb: m[5] } : null;
}

/** pid in a temp file name, or null */
export function tmpOwner(name) {
  const m = TMP_PID_RE.exec(name);
  return m ? Number(m[1]) : null;
}

export function pidAlive(pid) {
  if (!(pid > 0)) return false;
  const r = os.kill(pid, 0);
  return r === 0 || r === -1; // EPERM: exists, not ours
}

/**
 * Check the cache root before anything is removed.
 * @returns {{ok: true, real: string} | {ok: false, why: string}}
 *   real: the resolved directory, no trailing slash ("" if it doesn't exist)
 */
export function checkRoot(root, env = {}) {
  if (typeof root !== "string" || !root.startsWith("/")) {
    return { ok: false, why: "cache directory is not an absolute path" };
  }
  if (root.startsWith("/tmp/WallRizz-nohome/")) {
    return { ok: false, why: "neither HOME nor XDG_CACHE_HOME is set to an absolute path" };
  }
  if (!root.endsWith("/WallRizz/") || root.length <= "/WallRizz/".length) {
    return { ok: false, why: `refusing to touch ${root}: not a WallRizz cache directory` };
  }
  if (/\/\.\.?(\/|$)/.test(root)) {
    return { ok: false, why: `refusing to touch ${root}` };
  }
  const dir = root.slice(0, -1);
  const [, lerr] = os.lstat(dir);
  if (lerr !== 0) return { ok: true, real: "" }; // nothing there yet
  const [real, err] = os.realpath(dir);
  if (err !== 0 || !real || real === "/") {
    return { ok: false, why: `refusing to touch ${root}: it resolves to "${real || "?"}"` };
  }
  const forbidden = new Set(["/", "/home", "/root", "/tmp", "/usr", "/etc", "/var"]);
  for (const v of [env.HOME, env.XDG_CACHE_HOME]) {
    if (v && v.startsWith("/")) {
      const [r] = os.realpath(v);
      if (r) forbidden.add(r);
      forbidden.add(v.replace(/\/+$/, "") || "/");
    }
  }
  if (forbidden.has(real) || real.split("/").filter(Boolean).length < 2) {
    return { ok: false, why: `refusing to touch ${root}: it resolves to ${real}` };
  }
  return { ok: true, real };
}

/** remove `path` if it is strictly inside `real` (no symlink is followed) */
function removeInside(real, path) {
  if (!real || !path.startsWith(real + "/") || /\/\.\.?(\/|$)/.test(path)) return false;
  return os.remove(path) === 0;
}

/** lstat'ed directory walk, symlinks are reported as files, never entered */
function walk(dir, visit, depth = 0) {
  if (depth === 0) {
    // the starting directory itself must be a real directory, not a link
    const [st, e] = os.lstat(dir);
    if (e !== 0 || (st.mode & os.S_IFMT) !== os.S_IFDIR) return;
  }
  const [names, err] = os.readdir(dir);
  if (err !== 0 || depth > 6) return;
  for (const name of names) {
    if (name === "." || name === "..") continue;
    const path = `${dir}/${name}`;
    const [st, e] = os.lstat(path);
    if (e !== 0) continue;
    const isDir = (st.mode & os.S_IFMT) === os.S_IFDIR;
    if (isDir) {
      walk(path, visit, depth + 1);
      visit(path, name, st, true);
    } else {
      visit(path, name, st, false);
    }
  }
}

function readJson(path) {
  try {
    const text = std.loadFile(path);
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function writeJsonAtomic(path, value, pid) {
  const tmp = `${path}.${pid}-${Date.now()}.tmp`;
  const f = std.open(tmp, "w");
  if (!f) return false;
  f.puts(JSON.stringify(value));
  f.close();
  if (os.rename(tmp, path) === 0) return true;
  os.remove(tmp);
  return false;
}

/**
 * Judge thumbnail ids against this run's scan.
 * @param {Array<{id: string, path: string}>} current
 * @param {Object<string,string>} sources - id -> source path (sources.json)
 */
export function makeJudge(current, sources = {}) {
  const ids = new Map(current.map((c) => [c.id, c.path]));
  const byHash = new Map();
  for (const c of current) {
    const p = parseThumbId(c.id);
    if (p) byHash.set(`${p.base}-${p.hash}`, c.path);
  }
  const memo = new Map();
  /** @returns {"keep"|"stale"|"gone"|"legacy"|"unscanned"|"unknown"|"foreign"} */
  return (id) => {
    if (memo.has(id)) return memo.get(id);
    let v;
    if (ids.has(id)) v = "keep";
    else if (LEGACY_ID_RE.test(id)) v = "legacy";
    else {
      const p = parseThumbId(id);
      if (!p) v = "foreign";
      else if (byHash.has(`${p.base}-${p.hash}`)) v = "stale";
      else if (sources[id]) v = os.stat(sources[id])[1] === 0 ? "unscanned" : "gone";
      else v = "unknown";
    }
    memo.set(id, v);
    return v;
  };
}

const DROP = new Set(["stale", "gone", "legacy"]);

/**
 * The startup cleanup. Synchronous (it runs in a worker thread).
 * @param {object} o
 * @param {string} o.root - cache root (".../WallRizz/")
 * @param {Array<{id: string, path: string}>} o.current - scanned wallpapers
 *   (id = thumbnail name without ".png", path = full source path)
 * @param {number} o.capBytes - size cap of the image caches (0 = none)
 * @param {number} o.runStart - ms; files used since then are never trimmed
 * @param {number} o.pid - our pid (our temp files are live)
 * @param {object} [o.env] - HOME / XDG_CACHE_HOME for the root check
 * @returns {{ok: boolean, why?: string, removed: Array<{path: string,
 *   bytes: number, why: string}>, freed: number, imageBytes: number,
 *   colourKeys: string[]}}
 */
export function cleanupCache({ root, current, capBytes, runStart, pid, env = {}, now = Date.now() }) {
  const report = { ok: true, removed: [], freed: 0, imageBytes: 0, colourKeys: [] };
  const safe = checkRoot(root, env);
  if (!safe.ok) return { ...report, ok: false, why: safe.why };
  if (!safe.real) return report;
  const real = safe.real;
  const sources = readJson(`${real}/sources.json`) ?? {};
  const judge = makeJudge(current, sources);
  const seen = new Set(); // ids still referenced by a kept file
  const drop = (path, st, why) => {
    if (removeInside(real, path)) {
      report.removed.push({ path, bytes: st?.size ?? 0, why });
      report.freed += st?.size ?? 0;
      return true;
    }
    return false;
  };
  const tmpRule = (path, name, st) => {
    const owner = tmpOwner(name);
    if (owner === pid || pidAlive(owner)) return; // a live writer
    if (owner === null && now - st.mtime < HOUR) return; // unknown writer, recent
    drop(path, st, "temp file of a finished process");
  };
  const judgeId = (path, st, id) => {
    const v = judge(id);
    if (DROP.has(v)) return drop(path, st, v === "legacy" ? "legacy name" : `${v} source`);
    seen.add(id);
    return false;
  };

  // legacy tile cache: the whole tiles/v1/ tree
  walk(`${real}/tiles/v1`, (path, name, st, isDir) => {
    if (isDir) removeInside(real, path);
    else drop(path, st, "legacy tiles/v1");
  });
  removeInside(real, `${real}/tiles/v1`);

  // thumbnails
  walk(`${real}/pic`, (path, name, st, isDir) => {
    if (isDir) return;
    if (name.endsWith(".tmp")) return tmpRule(path, name, st);
    if (name.endsWith(".png")) judgeId(path, st, name.slice(0, -4));
  });

  // encoded tiles
  walk(`${real}/tiles/v2`, (path, name, st, isDir) => {
    if (isDir) return;
    if (name.endsWith(".tmp")) return tmpRule(path, name, st);
    const cut = name.indexOf("~");
    if (cut > 0) judgeId(path, st, name.slice(0, cut));
  });

  // page composites (Überzug++)
  walk(`${real}/composites`, (path, name, st, isDir) => {
    if (isDir) return;
    if (name.endsWith(".tmp")) return tmpRule(path, name, st);
    const partial = PARTIAL_RE.exec(name);
    if (partial) {
      const owner = Number(partial[1]);
      if (owner !== pid && !pidAlive(owner)) drop(path, st, "partial composite of a finished process");
      return;
    }
    if (!/^page-[0-9a-f]+\.png$/.test(name)) {
      if (/^page-[0-9a-f]+\.txt$/.test(name) && os.stat(path.replace(/\.txt$/, ".png"))[1] !== 0 &&
        now - st.mtime > 10 * 60 * 1000) {
        drop(path, st, "composite list without its image");
      }
      return;
    }
    const list = path.replace(/\.png$/, ".txt");
    const text = std.loadFile(list);
    const ids = text ? text.split("\n").filter(Boolean) : null;
    const bad = !ids || ids.some((id) => DROP.has(judge(id)));
    if (bad) {
      drop(path, st, ids ? "made from a stale or removed thumbnail" : "composite without its list");
      const [lst, le] = os.lstat(list);
      if (le === 0) drop(list, lst, "composite list");
    } else {
      for (const id of ids) seen.add(id);
    }
  });

  // theme configs
  walk(`${real}/themes`, (path, name, st, isDir) => {
    if (isDir) return;
    if (name.endsWith(".tmp")) return tmpRule(path, name, st);
    const m = /^(.+)\.png-(dark|light)\.conf$/.exec(name);
    if (m) judgeId(path, st, m[1]);
  });

  // colour cache keys: applied by the main thread (it owns colours.json)
  const colours = readJson(`${real}/colours.json`);
  if (colours && typeof colours === "object") {
    for (const key of Object.keys(colours)) {
      const id = key.replace(/\.png$/, "");
      if (DROP.has(judge(id))) report.colourKeys.push(key);
      else seen.add(id);
    }
  }

  // size cap on the image caches, oldest first
  const files = [];
  for (const dir of IMAGE_DIRS) {
    walk(`${real}/${dir.slice(0, -1)}`, (path, name, st, isDir) => {
      if (isDir || name.endsWith(".tmp")) return;
      files.push({ path, name, st, t: Math.max(st.mtime, st.atime ?? 0) });
    });
  }
  report.imageBytes = files.reduce((n, f) => n + f.st.size, 0);
  if (capBytes > 0 && report.imageBytes > capBytes) {
    files.sort((a, b) => a.t - b.t);
    let total = report.imageBytes;
    for (const f of files) {
      if (total <= capBytes) break;
      if (f.t >= runStart) continue; // used by this run
      if (f.name.endsWith(".txt")) continue; // goes with its composite
      if (drop(f.path, f.st, "size cap")) {
        total -= f.st.size;
        if (f.name.endsWith(".png") && f.path.includes("/composites/page-")) {
          const list = f.path.replace(/\.png$/, ".txt");
          const [lst, le] = os.lstat(list);
          if (le === 0 && drop(list, lst, "composite list")) total -= lst.size;
        }
      }
    }
    report.imageBytes = total;
  }

  // remember where this run's thumbnails come from
  const next = {};
  for (const [id, path] of Object.entries(sources)) {
    if (seen.has(id) && !DROP.has(judge(id))) next[id] = path;
  }
  for (const c of current) next[c.id] = c.path;
  writeJsonAtomic(`${real}/sources.json`, next, pid);
  return report;
}

/**
 * --clear-cache (everything) / --clear-thumbnails (image caches only:
 * thumbnails, tiles, composites, fullscreen scratch images).
 * @returns {{ok: boolean, why?: string, root: string, parts: Array<{name:
 *   string, files: number, bytes: number}>, files: number, freed: number,
 *   inUse: number}}
 */
export function clearCache({ root, thumbnailsOnly = false, pid, env = {} }) {
  const report = { ok: true, root, parts: [], files: 0, freed: 0, inUse: 0 };
  const safe = checkRoot(root, env);
  if (!safe.ok) return { ...report, ok: false, why: safe.why };
  if (!safe.real) return report;
  const real = safe.real;
  const [names, err] = os.readdir(real);
  if (err !== 0) return { ...report, ok: false, why: `can't read ${root}` };
  const wanted = names.filter((n) => n !== "." && n !== ".." &&
    (!thumbnailsOnly || IMAGE_DIRS.includes(n + "/") || IMAGE_FILES.includes(n)))
    .sort();
  for (const name of wanted) {
    const path = `${real}/${name}`;
    const [st, e] = os.lstat(path);
    if (e !== 0) continue;
    const part = { name: (st.mode & os.S_IFMT) === os.S_IFDIR ? name + "/" : name, files: 0, bytes: 0 };
    const removeFile = (p, n, s) => {
      if (n.endsWith(".tmp")) {
        const owner = tmpOwner(n);
        if (owner !== pid && pidAlive(owner)) {
          report.inUse++;
          return;
        }
      }
      if (removeInside(real, p)) {
        part.files++;
        part.bytes += s.size;
      }
    };
    if ((st.mode & os.S_IFMT) === os.S_IFDIR) {
      walk(path, (p, n, s, isDir) => {
        if (isDir) removeInside(real, p); // fails (kept) if something is left
        else removeFile(p, n, s);
      });
      removeInside(real, path);
    } else {
      removeFile(path, name, st);
    }
    if (part.files) report.parts.push(part);
    report.files += part.files;
    report.freed += part.bytes;
  }
  // the cache directory itself (when clearing everything and it's empty;
  // a symlinked cache directory is left in place)
  if (!thumbnailsOnly) {
    const [lst] = os.lstat(root.slice(0, -1));
    if (lst && (lst.mode & os.S_IFMT) === os.S_IFDIR) os.remove(root.slice(0, -1));
  }
  return report;
}
