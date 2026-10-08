/**
 * Where the live (partial) page composites of Überzug++ page mode are
 * written: memory-backed, private, and outside the cache (they only live
 * while a page fills in, and are never counted against --cache-max).
 *
 *   1. /dev/shm/wallrizz-$UID/
 *   2. $XDG_RUNTIME_DIR/wallrizz/
 *   3. <cache>/composites/ (the cache dir)
 *
 * A candidate is used only if it is a real directory (not a symlink) owned
 * by us with no group/other access (created 0700 if missing; /dev/shm is
 * shared, so a directory someone else made is refused) and a probe file can
 * be written into it.
 */
import * as OS from "os";
import * as STD from "std";
import { pidAlive } from "../wallpaper/cacheCleanup.js";

const PARTIAL_RE = /^partial-(\d+)-\d+\.png$/;

/** our uid (owner of /proc/self), or null where there is no /proc */
export function currentUid() {
  const [st, err] = OS.stat("/proc/self");
  return err === 0 && st ? st.uid : null;
}

/**
 * @param {string} dir - with trailing slash
 * @param {number|null} uid - expected owner (null: owner of the parent)
 * @returns {boolean}
 */
export function usableDir(dir, uid) {
  if (!dir || !dir.startsWith("/") || dir === "/") return false;
  const path = dir.replace(/\/+$/, "");
  let [st, err] = OS.lstat(path);
  if (err !== 0) {
    if (OS.mkdir(path, 0o700) !== 0) return false;
    [st, err] = OS.lstat(path);
    if (err !== 0) return false;
  }
  if ((st.mode & OS.S_IFMT) !== OS.S_IFDIR) return false; // incl. symlinks
  if (uid !== null && st.uid !== uid) return false;
  if ((st.mode & 0o077) !== 0) return false;
  const probe = `${path}/.probe-${OS.getpid?.() ?? 0}`;
  const f = STD.open(probe, "w");
  if (!f) return false;
  f.puts("ok");
  const failed = f.error();
  f.close();
  OS.remove(probe);
  return !failed;
}

/**
 * @param {Record<string, string|undefined>} env
 * @param {string} fallback - cache composites dir (trailing slash)
 * @param {{ shm?: string, uid?: number|null }} [opts] - for tests
 * @returns {string} directory with trailing slash
 */
export function liveRenderDir(env, fallback, { shm = "/dev/shm", uid = currentUid() } = {}) {
  if (uid !== null && usableDir(`${shm}/wallrizz-${uid}/`, uid)) return `${shm}/wallrizz-${uid}/`;
  const run = env.XDG_RUNTIME_DIR;
  if (run && run.startsWith("/")) {
    const [rst, rerr] = OS.stat(run);
    const owner = uid ?? (rerr === 0 ? rst.uid : null);
    if (rerr === 0 && (rst.mode & OS.S_IFMT) === OS.S_IFDIR &&
        usableDir(`${run.replace(/\/+$/, "")}/wallrizz/`, owner)) {
      return `${run.replace(/\/+$/, "")}/wallrizz/`;
    }
  }
  return fallback;
}

/**
 * Remove partial composites left by WallRizz runs that are gone (crash,
 * SIGKILL): partial-<pid>-<n>.png whose pid is not alive. Only that file
 * pattern, only directly inside `dir`.
 * @param {string} dir
 * @param {number} ownPid
 * @returns {number} files removed
 */
export function sweepDeadPartials(dir, ownPid) {
  const [names, err] = OS.readdir(dir);
  if (err !== 0) return 0;
  let removed = 0;
  for (const name of names) {
    const m = PARTIAL_RE.exec(name);
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid === ownPid || pidAlive(pid)) continue;
    const [st, serr] = OS.lstat(dir + name);
    if (serr === 0 && (st.mode & OS.S_IFMT) === OS.S_IFREG && OS.remove(dir + name) === 0) removed++;
  }
  return removed;
}
