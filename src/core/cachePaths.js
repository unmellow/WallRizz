/**
 * Where WallRizz keeps its caches, in one place, so the app, the automatic
 * cleanup and --clear-cache / --clear-thumbnails always agree.
 *
 * $XDG_CACHE_HOME/WallRizz/ when XDG_CACHE_HOME is set to an absolute path
 * (XDG base directory spec), else $HOME/.cache/WallRizz/. Plain "std"
 * import: also used by the worker threads.
 */
import * as std from "std";

/**
 * @param {{XDG_CACHE_HOME?: string, HOME?: string}} env
 * @returns {string|null} ".../WallRizz/" or null if neither is usable
 */
export function cacheRoot(env) {
  const xdg = env?.XDG_CACHE_HOME;
  if (xdg && xdg.startsWith("/")) return xdg.replace(/\/+$/, "") + "/WallRizz/";
  const home = env?.HOME;
  if (home && home.startsWith("/")) return home.replace(/\/+$/, "") + "/.cache/WallRizz/";
  return null;
}

const env = std.getenviron();
// never "" or "/": an unusable environment gets a private fallback that
// the cleanup and the clear flags refuse to touch (see cacheCleanup.js)
export const CACHE_DIR = cacheRoot(env) ?? "/tmp/WallRizz-nohome/";
export const PIC_DIR = CACHE_DIR + "pic/";
export const TILES_DIR = CACHE_DIR + "tiles/v2/";
export const LEGACY_TILES_DIR = CACHE_DIR + "tiles/v1/";
export const COMPOSITE_DIR = CACHE_DIR + "composites/";
export const THEMES_DIR = CACHE_DIR + "themes/";
export const COLOURS_FILE = CACHE_DIR + "colours.json";
// thumbnail name -> source path (lets the cleanup tell "source gone" from
// "source in a folder that wasn't scanned this run")
export const SOURCES_FILE = CACHE_DIR + "sources.json";
