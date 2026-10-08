/**
 * Wallpaper directory scanning (optionally recursive).
 *
 * Wallpapers found in sub directories are returned with their path relative
 * to the wallpaper directory as `name` (e.g. "favorites/landscape/a.jpg"), so
 * every existing `wallpapersDirectory + name` path keeps working. Cache keys
 * (`uniqueId`) are derived from device + inode, so equal file names in
 * different folders never collide.
 */

const IMAGE_RE = /\.(jpeg|png|webp|jpg|gif)$/i;

export const isSupportedImage = (name) => IMAGE_RE.test(name);

/**
 * @param {string} rootDir - wallpaper directory, with trailing "/"
 * @param {object} opts
 * @param {boolean} [opts.recursive=false]
 * @param {number} [opts.depth] - max depth; 1 = rootDir only, undefined = unlimited
 * @param {object} opts.fs - { readdir, stat, lstat, S_IFMT, S_IFDIR, S_IFLNK } (QuickJS os module)
 * @returns {{name: string, dev: number, ino: number}[]}
 */
export function scanWallpapers(rootDir, { recursive = false, depth, fs }) {
  const maxDepth = recursive ? (depth ?? Infinity) : 1;
  const results = [];
  const visitedDirs = new Set(); // dev:ino of real directories (symlink loop guard)
  const isDir = (st) => (st.mode & fs.S_IFMT) === fs.S_IFDIR;
  const isLink = (relPath) => {
    if (!fs.lstat) return false;
    const [lst, err] = fs.lstat(rootDir + relPath);
    return err === 0 && (lst.mode & fs.S_IFMT) === fs.S_IFLNK;
  };

  // Breadth first; directories reached through a symlink are deferred until
  // every real directory has been scanned, so a file is reported under its
  // real path and a linked directory is only scanned if nothing else covers it.
  const queue = [["", 1]];
  const deferred = [];

  const scanDir = (relDir, level) => {
    const absDir = rootDir + relDir;
    const [dirStat, statErr] = fs.stat(absDir);
    if (statErr === 0) {
      const key = `${dirStat.dev}:${dirStat.ino}`;
      if (visitedDirs.has(key)) return; // already scanned (symlink loop / duplicate link)
      visitedDirs.add(key);
    }

    const [names, err] = fs.readdir(absDir);
    if (err !== 0) {
      if (level === 1) {
        throw new Error("Failed to read wallpapers directory:\n" + rootDir);
      }
      return; // unreadable sub directory: skip
    }

    for (const name of names) {
      if (name === "." || name === "..") continue;
      const rel = relDir + name;
      const image = isSupportedImage(name);
      const mayDescend = level < maxDepth && !name.startsWith(".");

      // Without recursion only image-named entries are stat'ed (old behaviour).
      if (!image && !mayDescend) continue;

      const [st, e] = fs.stat(rootDir + rel); // follows symlinks
      if (e !== 0) {
        if (image && level === 1) {
          throw new Error("Failed to read wallpaper stat for:\n" + rootDir + rel);
        }
        continue; // broken symlink etc. in a sub directory
      }

      if (isDir(st)) {
        if (!mayDescend) continue;
        (isLink(rel) ? deferred : queue).push([rel + "/", level + 1]);
        continue;
      }
      if (image) results.push({ name: rel, dev: st.dev, ino: st.ino });
    }
  };

  while (queue.length || deferred.length) {
    const [relDir, level] = queue.length ? queue.shift() : deferred.shift();
    scanDir(relDir, level);
  }
  return results;
}
