import { STD, EXIT, SystemError } from "./core/constants.js";
import { parseArguments } from "./args.js";
import {
  ThemeExtensionScriptsDownloadManager,
  WallpaperDaemonHandlerScriptDownloadManager,
} from "./extensions/ExtensionDownloadManager.js";
import WallpaperManager from "./wallpaper/WallpaperManager.js";
import { UserInterface } from "./ui/UserInterface.js";
import { testExtensions } from "./extensions/ExtensionHandler.js";
import { checkForUpdate } from "./core/utils/app.js";
import { getImageProtocol } from "./ui/terminalImage.js";
import { stopAllUeberzug } from "./ui/ueberzug.js";
import { TileCache } from "./ui/tileCache.js";

class WallRizz {
  constructor() {
    this.config = parseArguments();
    // Maintain backward compatibility ONLY where necessary for now
    globalThis.USER_ARGUMENTS = this.config;
  }

  async run() {
    try {
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
    const tiles = new TileCache({
      protocol,
      cellPx: STD.getenv("WALLRIZZ_CELL_PX"),
      limit: 1,
    });
    const out = await tiles.get(this.config.renderTile, columns, rows);
    if (out) {
      STD.out.puts(out.replace(/\n+$/, ""));
      STD.out.flush();
    }
    throw EXIT;
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
