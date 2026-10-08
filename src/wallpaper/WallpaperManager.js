import extensionHandler from "../extensions/ExtensionHandler.js";
import { Theme } from "../theme/ThemeManager.js";
import { UserInterface } from "../ui/UserInterface.js";
import { notify, log } from "../core/utils/ui.js";
import { ensureDir } from "../core/utils/io.js";
import { CacheManager } from "./CacheManager.js";
import { scanWallpapers } from "./scan.js";
import { defaultPoolSize, magickSlots, startCacheCleanup, thumbName } from "./thumbnails.js";
import { formatBytes } from "./cacheCleanup.js";
import { CACHE_DIR } from "../core/cachePaths.js";
import { OS, STD, HOME_DIR, EXIT, SystemError } from "../core/constants.js";

export default class WallpaperManager {
  constructor(config) {
    this.config = config;
    // files used from now on are this run's: the size cap never takes them
    // (a few seconds of slack for coarse timestamps)
    this.runStart = Date.now() - 5000;
    this.sources = [];
    this.wallpapers = this.loadWallpapers();
    this.cacheManager = new CacheManager(this.config, this.wallpapers);
    this.themeManager = new Theme(
      this.cacheManager.getCacheDir(),
      this.wallpapers,
      this.config,
    );
  }

  async init() {
    // -x caps the ImageMagick processes running at once, in every mode
    magickSlots.setCap(this.config.processLimit ?? defaultPoolSize());
    this.loadWallpaperDaemonHandlerScript();
    // Grid mode shows the grid immediately: thumbnails are made by the
    // gallery's worker pool (frames first, images as they finish) and
    // colours/themes are generated for a wallpaper when it is selected,
    // with the rest filled in afterwards at low priority. List mode and
    // the headless setters still need every thumbnail and theme up front.
    if (this.showsGrid()) {
      this.themeManager.loadThemeExtensionScripts();
      try {
        // after the first page is on screen: the cache cleanup, then the
        // colours/themes nobody asked for yet
        await this.handleSettingWallpaper((idle) => {
          this.startCacheCleanup();
          return this.themeManager.fillRemaining(this.wallpapers, idle);
        });
      } finally {
        this.cleanup?.stop();
      }
      return;
    }
    this.startCacheCleanup();
    await this.cacheManager.handleWallpaperCacheCreation();
    await this.themeManager.init();
    await this.handleSettingRandomWallpaper();
    await this.handleSettingWallpaper();
  }

  /**
   * Startup cache cleanup (cacheCleanup.js) in a worker thread: stale,
   * orphaned and legacy cache files, then the size cap (--cache-max). It
   * never blocks drawing; quitting doesn't wait for it.
   */
  startCacheCleanup() {
    if (this.cleanup) return;
    const env = STD.getenviron();
    const mb = Number(this.config.cacheMax ?? 1024);
    this.cleanup = startCacheCleanup({
      root: CACHE_DIR,
      current: this.sources,
      capBytes: mb > 0 ? mb * 1024 * 1024 : 0,
      runStart: this.runStart,
      pid: OS.getpid?.() ?? 0,
      env: { HOME: env.HOME, XDG_CACHE_HOME: env.XDG_CACHE_HOME },
    });
    this.cleanup.done.then((report) => {
      if (!report) return;
      if (!report.ok) {
        log(`Cache cleanup skipped: ${report.why}`, this.config);
        return;
      }
      if (report.colourKeys?.length) this.themeManager.pruneColours(report.colourKeys);
      if (report.removed.length) {
        log(
          `Cache cleanup: removed ${report.removed.length} file(s), ${formatBytes(report.freed)}; ` +
            `image caches now ${formatBytes(report.imageBytes)}`,
          this.config,
        );
      }
    }).catch(() => {});
  }

  /** The interactive grid (not the fzf list, not a headless setter). */
  showsGrid() {
    return this.config.previewMode !== "list" &&
      !this.config.setInterval && !this.config.setRandomWallpaper;
  }

  loadWallpapers() {
    let found;
    try {
      found = scanWallpapers(this.config.wallpapersDirectory, {
        recursive: this.config.recursive || this.config.depth !== undefined,
        depth: this.config.depth,
        fs: OS,
      });
    } catch (e) {
      throw new Error(e.message);
    }
    // The id is the thumbnail's file name: path + mtime + size (+ thumbnail
    // size), so an edited wallpaper gets a new thumbnail, palette and theme
    // (the old dev+inode name kept stale ones forever). Stale and legacy
    // cache files are removed by the startup cleanup.
    const wallpapers = found.map(({ name, dev, ino }) => {
      const path = this.config.wallpapersDirectory.concat(name);
      const [st, err] = OS.stat(path);
      if (err === 0) {
        this.sources.push({
          id: thumbName(path, st, this.config.thumbnailSize).replace(/\.png$/, ""),
          path,
        });
      }
      return {
        name,
        uniqueId: err === 0
          ? thumbName(path, st, this.config.thumbnailSize)
          : `${dev}${ino}`.concat(".png"),
      };
    });
    log(
      `Found ${wallpapers.length} wallpaper(s) in ${this.config.wallpapersDirectory}` +
        (this.config.recursive || this.config.depth !== undefined
          ? ` (recursive, depth: ${this.config.depth ?? "unlimited"})`
          : ""),
      this.config,
    );

    if (!wallpapers.length) {
      throw new SystemError(
        "No wallpaper found in ".concat(this.config.wallpapersDirectory),
        "Make sure the supported image file exists in the directory.",
      );
    }

    return wallpapers;
  }

  loadWallpaperDaemonHandlerScript() {
    const extensionDir = HOME_DIR.concat("/.config/WallRizz/");
    ensureDir(extensionDir);
    const scriptNames = OS.readdir(extensionDir)[0]
      .filter((name) => name !== "." && name !== ".." && name.endsWith(".js"));
    if (scriptNames.length > 1) {
      throw new SystemError(
        `Too many scripts found in the ${extensionDir}.`,
        "Only one script is required.",
      );
    }
    if (scriptNames.length) {
      const extensionPath = extensionDir.concat(scriptNames[0]);
      this.wallpaperDaemonHandler = async (...all) =>
        await extensionHandler({
          scriptPath: extensionPath,
          scriptMethods: {
            setWallpaper: null,
          },
          args: all,
          config: this.config,
        });
    } else {
      throw new SystemError(
        "Failed to find any wallpaper daemon handler script in " +
          extensionDir,
        'Run "WallRizz -w" to download it.',
      );
    }
  }

  async handleSettingRandomWallpaper() {
    const setRandomWallpaper = async (index = Math.floor(
      Math.random() * this.wallpapers.length,
    )) => await this.handleSelection(this.wallpapers[index]);

    if (this.config.setInterval) {
      while (true) {
        await setRandomWallpaper();
        OS.setTimeout(
          () => {
            STD.evalScript(this.config.setIntervalCallback);
          },
          this.config.setInterval,
        );
      }
    } else if (this.config.setRandomWallpaper) {
      await setRandomWallpaper();
      throw EXIT;
    }
  }

  async handleSettingWallpaper(onGalleryReady) {
    const ui = new UserInterface(
      this.wallpapers,
      this.cacheManager.getCacheDir(),
      this.handleSelection.bind(this),
      this.getWallpaperPath.bind(this),
      this.handleSelection.bind(this),
      this.config,
      onGalleryReady,
    );
    await ui.init();
  }

  async handleSelection(wallpaper) {
    const { name, uniqueId } = wallpaper;
    // grid mode may not have colours/themes for this wallpaper yet
    if (!this.themeManager.getCachedColours(uniqueId)) {
      await this.themeManager.ensureWallpaper(uniqueId, name);
    }
    const promises = [
      this.themeManager.setThemes(uniqueId, name),
      this.setWallpaper(name),
    ];
    await Promise.all(promises);
    if (!this.config.hold) throw EXIT;
  }

  getWallpaperPath(wallpaper) {
    return this.config.wallpapersDirectory.concat(wallpaper.name);
  }

  isSupportedImageFormat(name) {
    const nameArray = name.split(".");
    const format = nameArray[nameArray.length - 1].toLowerCase();
    return /^(jpeg|png|webp|jpg|gif)$/i.test(format);
  }

  async setWallpaper(wallpaperName) {
    const wallpaperPath =
      `${this.config.wallpapersDirectory}${wallpaperName}`;
    await this.wallpaperDaemonHandler(wallpaperPath);
    await notify("New wallpaper", wallpaperName, "normal", this.config);
  }
}
