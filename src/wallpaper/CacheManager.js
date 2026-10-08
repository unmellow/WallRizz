import { SystemError, HOME_DIR, OS } from "../core/constants.js";
import { ensureDir } from "../core/utils/io.js";
import { log } from "../core/utils/ui.js";
import { defaultPoolSize, ThumbPool } from "./thumbnails.js";

/**
 * Up-front thumbnail pass (list mode and the headless setters; the grid
 * makes its thumbnails lazily, see GalleryView). Uses the same worker pool
 * and magick invocation as the grid, so it runs off the main thread too.
 */
export class CacheManager {
  constructor(config, wallpapers) {
    this.config = config;
    this.wallpapers = wallpapers;
    this.picCacheDir = HOME_DIR.concat("/.cache/WallRizz/pic/");
    ensureDir(this.picCacheDir);
  }

  async handleWallpaperCacheCreation() {
    const missing = this.wallpapers.filter((wp) =>
      OS.stat(this.picCacheDir.concat(wp.uniqueId))[1] !== 0
    );
    if (!missing.length) return;

    log("Caching images...", this.config);
    const pool = new ThumbPool({
      size: this.config.thumbnailSize,
      poolSize: this.config.processLimit ?? defaultPoolSize(),
    });
    let made;
    try {
      made = await Promise.all(missing.map((wp) =>
        pool.request(this.config.wallpapersDirectory.concat(wp.name), pool.generation)
      ));
    } finally {
      await pool.shutdown();
    }
    const failed = missing.filter((_, i) => !made[i]);
    if (failed.length) {
      throw new SystemError(
        "Failed to create wallpaper cache",
        "Make sure ImageMagick is installed in your system",
        `no thumbnail for: ${failed.slice(0, 5).map((wp) => wp.name).join(", ")}` +
          (failed.length > 5 ? ` (+${failed.length - 5} more)` : ""),
      );
    }
    log("Done", this.config);
  }

  isSupportedImageFormat(name) {
    const nameArray = name.split(".");
    const format = nameArray[nameArray.length - 1].toLowerCase();
    return /^(jpeg|png|webp|jpg|gif)$/i.test(format);
  }

  getCacheDir() {
    return this.picCacheDir;
  }
}
