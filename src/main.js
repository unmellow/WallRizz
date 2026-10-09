import { OS, STD, EXIT, SystemError } from "./core/constants.js";
import { parseArguments } from "./args.js";
import {
  ThemeExtensionScriptsDownloadManager,
  WallpaperDaemonHandlerScriptDownloadManager,
} from "./extensions/ExtensionDownloadManager.js";
import WallpaperManager from "./wallpaper/WallpaperManager.js";
import { UserInterface } from "./ui/UserInterface.js";
import { testExtensions } from "./extensions/ExtensionHandler.js";
import { checkForUpdate } from "./core/utils/app.js";
import { getImageProtocol, imagePixelSize } from "./ui/terminalImage.js";
import { fitImageInBox, parseCellPx } from "./ui/imageProtocol.js";
import { stopAllUeberzug } from "./ui/ueberzug.js";
import { TileCache } from "./ui/tileCache.js";
import { clearCache, formatBytes } from "./wallpaper/cacheCleanup.js";
import { CACHE_DIR } from "./core/cachePaths.js";

class WallRizz {
  constructor() {
    this.config = parseArguments();
    // Maintain backward compatibility ONLY where necessary for now
    globalThis.USER_ARGUMENTS = this.config;
  }

  async run() {
    try {
      this.handleClearCache();
      await this.handleRenderTile();
      this.handleShowKeymaps();
      this.handleWhichImageProtocol();
      await this.handleRunUpdate();
      await this.handleExtensionTest();
      await this.handleThemeExtensionScriptDownload();
      await this.handleWallpaperHandlerScriptDownload();
      await this.handleWallpaperManager();
    } catch (status) {
      this.handleExecutionStatus(status);
    } finally {
      this.config.inspection && print(this.config);
    }
  }

  async handleExtensionTest() {
    if (!this.config.test) return;
    await testExtensions(this.config);
    throw EXIT;
  }

  async handleThemeExtensionScriptDownload() {
    if (!this.config.downloadThemeExtensionScripts) return;
    const downloadManager = new ThemeExtensionScriptsDownloadManager(
      this.config,
    );
    await downloadManager.init();
  }

  async handleWallpaperHandlerScriptDownload() {
    if (!this.config.downloadWallpaperDaemonHandlerScript) return;
    const downloadManager = new WallpaperDaemonHandlerScriptDownloadManager(
      this.config,
    );
    await downloadManager.init();
  }

  async handleWallpaperManager() {
    const wallpaperManager = new WallpaperManager(this.config);
    await wallpaperManager.init();
  }

  handleShowKeymaps() {
    if (!this.config.showKeyMap) return;
    UserInterface.printKeyMaps();
    throw EXIT;
  }

  // Used by the list view's fzf preview: same cache as the grid view.
  async handleRenderTile() {
    if (!this.config.renderTile) return;
    const protocol = this.config.imageProtocol;
    if (!["iterm", "sixel", "symbols"].includes(protocol)) throw EXIT;
    const columns = Number(STD.getenv("FZF_PREVIEW_COLUMNS")) || 40;
    const lines = Number(STD.getenv("FZF_PREVIEW_LINES")) || 20;
    // keep pixel images off the last line so they can't scroll the screen
    const rows = protocol === "symbols" ? lines : Math.max(1, lines - 1);
    const cellPxText = STD.getenv("WALLRIZZ_CELL_PX");
    const cell = parseCellPx(cellPxText) ?? { width: 10, height: 20 };
    const thumb = this.config.renderTile;
    const size = imagePixelSize(thumb);
    // aspect-fitted, centered box inside the preview window
    const fit = fitImageInBox(
      size?.width,
      size?.height,
      Math.max(1, columns - 1),
      rows,
      cell.width,
      cell.height,
    );
    const tiles = new TileCache({
      protocol,
      cellPx: protocol === "sixel" ? cellPxText : null,
      limit: 1,
    });
    const out = await tiles.get(thumb, fit.columns, fit.rows);
    if (out) {
      const body = out.replace(/\n+$/, "");
      // Only symbols (plain text) are centered. fzf draws a pixel image at
      // the start of its line whatever precedes it, and shows an iTerm2
      // image only when it starts on the preview's first line (it assumes
      // the image needs the whole preview height).
      const pad = " ".repeat(fit.dx);
      STD.out.puts(
        protocol === "symbols"
          ? "\n".repeat(fit.dy) + body.split("\n").map((line) => pad + line).join("\n")
          : body,
      );
      STD.out.flush();
    }
    throw EXIT;
  }

  // --clear-cache / --clear-thumbnails: remove, report, exit (no picker)
  handleClearCache() {
    const { clearCache: all, clearThumbnails } = this.config;
    if (!all && !clearThumbnails) return;
    const env = STD.getenviron();
    const report = clearCache({
      root: CACHE_DIR,
      thumbnailsOnly: !all,
      pid: OS.getpid?.() ?? 0,
      env: { HOME: env.HOME, XDG_CACHE_HOME: env.XDG_CACHE_HOME },
    });
    if (!report.ok) {
      STD.err.puts(`WallRizz: ${report.why}\n`);
      STD.exit(1);
    }
    const what = all ? "cache" : "image caches (thumbnails, tiles, composites)";
    if (!report.files) {
      print(`Nothing to remove: the ${what} in ${CACHE_DIR} ${all ? "is" : "are"} already empty.`);
    } else {
      print(`Removed the ${what} in ${CACHE_DIR}:`);
      const width = Math.max(...report.parts.map((p) => p.name.length));
      for (const p of report.parts) {
        const files = `${p.files} file${p.files === 1 ? "" : "s"}`;
        print(`  ${p.name.padEnd(width)}  ${files.padStart(12)}  ${formatBytes(p.bytes).padStart(9)}`);
      }
      print(`Freed ${formatBytes(report.freed)} (${report.files} file${report.files === 1 ? "" : "s"}).`);
    }
    if (report.inUse) {
      print(`Kept ${report.inUse} temp file(s) another running WallRizz is writing.`);
    }
    if (!all) print("Colours and theme files were kept.");
    STD.exit(0);
  }

  handleWhichImageProtocol() {
    if (!this.config.whichImageProtocol) return;
    const { protocol, terminal, source, ueberzugOutput } = getImageProtocol(
      this.config,
    );
    const canvas = ueberzugOutput ? ` output=${ueberzugOutput}` : "";
    print(`protocol=${protocol}${canvas} terminal=${terminal} (${source})`);
    throw EXIT;
  }

  async handleRunUpdate() {
    if (!this.config.update) return;
    await checkForUpdate();
    throw EXIT;
  }

  handleExecutionStatus(status) {
    stopAllUeberzug();
    if (status === EXIT) STD.exit(0);
    if (status instanceof SystemError) {
      status.log(this.config.inspection);
    } else {
      STD.err.puts(
        `${status.constructor.name}: ${status.message}\n${status.stack}`,
      );
    }
    STD.exit(1);
  }
}

const wallRizz = new WallRizz();
await wallRizz.run();
// Done (picked, quit): exit now. QuickJS would otherwise keep running until
// every pending timer and read handler is gone (e.g. a confirmation or
// thumbnail timer), delaying the exit by seconds.
stopAllUeberzug();
STD.out.flush();
STD.exit(0);
