import { ansi } from "../../helpers/ansiStyle.js";
import { ProcessSync } from "../../qjs-ext-lib/src/process.js";
import Fzf from "../../helpers/fzf.js";
import { Theme } from "../theme/ThemeManager.js";
import { STD, SystemError, EXIT, OS } from "../core/constants.js";
import {
  getImageProtocol,
  getTerminalBrand,
  queryCellSize,
  requireChafa,
} from "./terminalImage.js";
import { UeberzugLayer } from "./ueberzug.js";

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

    let protocol = this.config.resolvedImageProtocol ?? "kitty";
    let ueberzug = null;
    if (protocol === "ueberzug") {
      ueberzug = new UeberzugLayer(
        getImageProtocol(this.config).ueberzugOutput ?? "x11",
      );
      if (!(await ueberzug.start())) {
        ueberzug = null;
        requireChafa("symbols", "ueberzugpp failed to start");
        protocol = "symbols";
      }
    }
    const previewCmd = protocol === "kitty"
      ? kittyPreviewCmd
      : ueberzug
      ? this.ueberzugPreviewCmd(ueberzug.socketPath())
      : this.chafaPreviewCmd(protocol);

    const fzf = new Fzf();
    fzf.color("16,current-bg:-1")
      .read0()
      // one field per line, so names with spaces show (and match) in full
      .delimiter("'\\n'")
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
        // split on the last "#" so folder/file names containing "#" survive
        const sep = String(wallpaperName).lastIndexOf("#");
        const wpName = String(wallpaperName).slice(0, sep);
        const id = String(wallpaperName).slice(sep + 1);
        const name = wpName;

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

    // the preview overlay is added through the socket by the preview
    // command; register it so stopping the layer removes it too
    ueberzug?.shown.add("wallrizz-preview");

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
      ueberzug?.stop();
      throw new SystemError(
        "Failed to run fzf.",
        "Make sure fzf is installed and available in the system.",
        error,
      );
    }
    // fzf is gone (selection, Esc or Ctrl+C): drop the preview overlay
    ueberzug?.stop();

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
   * symbols output is plain coloured text. The preview runs this binary with
   * --render-tile, which renders the cached *thumbnail* through the same
   * on-disk tile cache as the grid view (so revisits/relaunches are instant).
   * The thumbnail path is stored base64 encoded on line 2 of each item (for
   * the kitty t=f path), so decode it first. That encoder leaves NUL bytes
   * at the end of some paths; they are stripped, otherwise bash prints a
   * "command substitution: ignored null byte" warning into the preview's
   * first line, and fzf then can't show an iTerm2 image (it only draws one
   * that starts on line 1). stdin is /dev/tty so chafa can read the cell
   * pixel size.
   */
  chafaPreviewCmd(protocol) {
    const [self] = OS.readlink("/proc/self/exe");
    const bin = self || "WallRizz";
    // cell pixel size: fits the image into the preview (and sixel encoding)
    const cellPx = queryCellSize();
    const env = `WALLRIZZ_TERMINAL=${getTerminalBrand()}` +
      (cellPx ? ` WALLRIZZ_CELL_PX=${cellPx}` : "");
    return `--preview='f=$(echo -e {} | head -n 2 | tail -n 1 | tr -d " " | base64 -d 2>/dev/null | tr -d "\\000"); ${env} "${bin}" -P ${protocol} --render-tile "$f" </dev/tty 2>/dev/null'`;
  }

  /**
   * Überzug++ preview: WallRizz keeps one `ueberzugpp layer` running (fed on
   * a pipe, so it dies with WallRizz) and the preview command tells it,
   * through its socket, to show the thumbnail over fzf's preview window
   * (same approach as the lf/fzf ueberzugpp scripts). Re-adding the same
   * identifier replaces the previous image.
   */
  ueberzugPreviewCmd(socket) {
    return `--preview='f=$(echo -e {} | head -n 2 | tail -n 1 | tr -d " " | base64 -d 2>/dev/null | tr -d "\\000"); ueberzugpp cmd -s "${socket}" -i wallrizz-preview -a add -x "$FZF_PREVIEW_LEFT" -y "$FZF_PREVIEW_TOP" --max-width "$FZF_PREVIEW_COLUMNS" --max-height "$FZF_PREVIEW_LINES" -f "$f" >/dev/null 2>&1'`;
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
