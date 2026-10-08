import { FzfView } from "./FzfView.js";
import { GalleryView } from "./GalleryView.js";
import { getImageProtocol } from "./terminalImage.js";
import { log } from "../core/utils/ui.js";

/**
 * @typedef {import('../core/types.d.ts').WallpapersList} WallpapersList
 */

class UserInterface {
  /**
   * @param {WallpapersList} wallpaperList
   * @param {string} wallpapersDirectory
   * @param {Function} handleSelection
   * @param {Function} getWallpaperPath
   * @param {Function} handleFocus
   * @param {Object} config
   */
  constructor(
    wallpaperList,
    wallpapersDirectory,
    handleSelection,
    getWallpaperPath,
    handleFocus,
    config,
  ) {
    this.wallpapers = wallpaperList;
    this.wallpapersDir = wallpapersDirectory;
    this.handleSelection = handleSelection;
    this.getWallpaperPath = getWallpaperPath;
    this.handleFocus = handleFocus;
    this.config = config;
  }

  /**
   * Initialize UI
   */
  async init() {
    const image = getImageProtocol(this.config);
    this.config.resolvedImageProtocol = image.protocol;
    log(
      `Image protocol: ${image.protocol} (terminal: ${image.terminal}, ${image.source})`,
      this.config,
    );

    if (this.config.previewMode === "list") {
      const fzfView = new FzfView(
        this.config,
        this.wallpapers,
        this.wallpapersDir,
        this.handleSelection,
        this.getWallpaperPath,
      );
      return await fzfView.render();
    }

    const galleryView = new GalleryView(
      this.config,
      this.wallpapers,
      this.wallpapersDir,
      this.handleSelection,
      this.getWallpaperPath,
      this.handleFocus,
    );
    await galleryView.render();
  }

  static printKeyMaps() {
    print("Keymaps:");
    print("  Arrow keys / hjkl : Navigate");
    print("  Enter             : Select");
    print("  f                 : Fullscreen preview");
    print("  H / L             : Page Up / Down");
    print("  q                 : Exit");
  }
}

export { UserInterface };
