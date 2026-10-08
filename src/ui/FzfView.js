import { ansi } from "../../helpers/ansiStyle.js";
import { ProcessSync } from "../../qjs-ext-lib/src/process.js";
import Fzf from "../../helpers/fzf.js";
import { Theme } from "../theme/ThemeManager.js";
import { STD, SystemError, EXIT, OS } from "../core/constants.js";
import { buildChafaArgs } from "./terminalImage.js";

export class FzfView {
  constructor(config, wallpapers, wallpapersDir, handleSelection, getWallpaperPath) {
    this.config = config;
    this.wallpapers = wallpapers;
    this.wallpapersDir = wallpapersDir;
    this.handleSelection = handleSelection;
    this.getWallpaperPath = getWallpaperPath;
  }

  async render() {
    const [width] = OS.ttyGetWinSize();
    const cachedColoursFile = STD.loadFile(
      Theme.wallpaperColoursCacheFilePath,
    );
    if (!cachedColoursFile) return;

    const cachedColours = JSON.parse(cachedColoursFile);
    const wallColors = Object.fromEntries(
      Object.entries(
        cachedColours,
      )
        .map(([wallId, pallete]) => {
          const wallpaperName = this.wallpapers.find((wallpaper) =>
            wallpaper.uniqueId === wallId
          )?.name;
          return wallpaperName
            ? [[wallpaperName.concat("#", wallId)], pallete]
            : null;
        })
        .filter(Boolean),
    );

    const kittyPreviewCmd =
      "--preview='printf \"\\x1b[0;0H\\x1b_Ga=T,t=f,f=100,q=2,c=${FZF_PREVIEW_COLUMNS};`echo -e {} | head -n 2 | tail -n 1`\\x1b\\\\\" >> /dev/tty'";

    const protocol = this.config.resolvedImageProtocol ?? "kitty";
    const previewCmd = protocol === "kitty"
      ? kittyPreviewCmd
      : this.chafaPreviewCmd(protocol);

    const fzf = new Fzf();
    fzf.color("16,current-bg:-1")
      .read0()
      .delimiter("' '")
      .withNth("1")
      .previewWindow(
        `wrap,border-none,left,${(this.config.imageSize[0] + 2) * 2}`,
      )
      .noInfo()
      .separator("' '")
      .bind("'focus:transform-footer(echo -e {} | tail -n +3)'")
      .layout("reverse")
      .withShell("'/usr/bin/bash -c'")
      .custom(previewCmd)
      .custom("--footer-border=none");

    const maxLineLength = Math.floor(
      width - (this.config.imageSize[0] + 2) * 2,
    );

    const fzfInput = Object.entries(wallColors)
      .map(([wallpaperName, palette]) => {
        const [wpName, id] = wallpaperName.split("#");
        const name = wpName.includes(" ") ? `"${wpName}"` : wpName;

        const wordLength = Math.floor(maxLineLength / palette.length) || 1;

        const paletteVisualization = (() => {
          const line = palette
            .map((color) =>
              `${ansi.bgHex(color)}${ansi.hex(color)}${"-".repeat(wordLength)}`
            )
            .join("");

          return Array(wordLength * 2)
            .fill(`\b${line}`)
            .join("\n")
            .slice(0, -1);
        })();

        return `${name ?? this.getWallpaperPath({ uniqueId: id, name })} \n${
          this.toBase64(this.wallpapersDir + id)
        } \n${JSON.stringify(paletteVisualization)}\n`;
      })
      .join("\0");

    const previewer = new ProcessSync(
      fzf.toString(),
      {
        input: fzfInput,
        useShell: true,
      },
    );

    try {
      previewer.run();
    } catch (error) {
      throw new SystemError(
        "Failed to run fzf.",
        "Make sure fzf is installed and available in the system.",
        error,
      );
    }

    if (!previewer.success) {
      STD.exit();
      throw new SystemError("Error", previewer.stderr || "No item selected.");
    }

    const wallpaper = previewer.stdout.split("\n")[0].trim();
    const selection = this.wallpapers.find((wp) => wp.name === wallpaper);
    await this.handleSelection(selection);
    throw EXIT;
  }

  /**
   * fzf (>= 0.44) passes sixel / iTerm2 image sequences printed by the preview
   * command through to the terminal and clips them to the preview window;
   * symbols output is plain coloured text. The image path is stored base64
   * encoded on line 2 of each item (for the kitty t=f path), so decode it.
   * Sixel/iTerm2 images get one row less than the preview height so an image
   * touching the bottom line can't scroll the screen (junegunn/fzf#2544).
   * stdin is /dev/tty so chafa can read the cell pixel size.
   */
  chafaPreviewCmd(protocol) {
    const rows = protocol === "symbols"
      ? "${FZF_PREVIEW_LINES}"
      : "$((FZF_PREVIEW_LINES - 1))";
    // placeholder sizes are replaced by shell expansions at preview time
    const chafa = buildChafaArgs(protocol, 1, 1)
      .join(" ")
      .replace("-s 1x1", () => `-s \${FZF_PREVIEW_COLUMNS}x${rows}`);
    return `--preview='f=$(echo -e {} | head -n 2 | tail -n 1 | tr -d " " | base64 -d); ${chafa} "$f" </dev/tty 2>/dev/null'`;
  }

  toBase64(str) {
    const chars =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let result = "";
    let i = 0;

    while (i < str.length) {
      const a = str.charCodeAt(i++);
      const b = i < str.length ? str.charCodeAt(i++) : 0;
      const c = i < str.length ? str.charCodeAt(i++) : 0;

      const idx1 = a >> 2;
      const idx2 = ((a & 3) << 4) | (b >> 4);
      const idx3 = ((b & 15) << 2) | (c >> 6);
      const idx4 = c & 63;

      result += chars[idx1] +
        chars[idx2] +
        (i - 2 < str.length ? chars[idx3] : "=") +
        (i - 1 < str.length ? chars[idx4] : "=");
    }

    return result;
  }
}
