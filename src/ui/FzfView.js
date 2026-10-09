import { ansi } from "../../helpers/ansiStyle.js";
import { ProcessSync } from "../../qjs-ext-lib/src/process.js";
import Fzf from "../../helpers/fzf.js";
import { Theme } from "../theme/ThemeManager.js";
import { STD, SystemError, EXIT, OS } from "../core/constants.js";
import {
  commandExists,
  getImageProtocol,
  getTerminalBrand,
  insideKitty,
  insideWezterm,
  queryCellSize,
  requireChafa,
} from "./terminalImage.js";
import { base64Utf8 } from "./imageProtocol.js";
import { UeberzugLayer } from "./ueberzug.js";
import { handleKeysPressSync, keySequences } from "../../helpers/terminal.js";
import { readResizeMode, writeResizeMode } from "../wallpaper/resizeMode.js";

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

    // (inside kitty) the original preview: draw at 0;0 straight on the tty.
    // The base64 path is line 2 of the item minus its trailing space, which
    // used to end up in the payload.
    const kittyPreviewCmd =
      "--preview='printf \"\\x1b[0;0H\\x1b_Ga=T,t=f,f=100,q=2,c=${FZF_PREVIEW_COLUMNS};$(echo -e {} | head -n 2 | tail -n 1 | tr -d \" \")\\x1b\\\\\" >> /dev/tty'";

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
    // fzf only keeps kitty images in the preview when they are drawn with
    // unicode placeholders (U=1). WezTerm has no placeholder support and fzf's
    // repaint wipes its cell-grid images (both chafa -f kitty and a direct
    // a=T,t=f stay blank there), so its list preview uses iTerm2 images,
    // WezTerm's own default protocol. Other kitty terminals keep the
    // original preview.
    const kittyVia = protocol === "kitty" && !insideKitty() &&
        insideWezterm() && commandExists("chafa")
      ? "iterm"
      : null;
    const previewCmd = kittyVia
      ? this.chafaPreviewCmd(kittyVia)
      : protocol === "kitty"
      ? kittyPreviewCmd
      : ueberzug
      ? this.ueberzugPreviewCmd(ueberzug)
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
      this.stopUeberzug(ueberzug);
      throw new SystemError(
        "Failed to run fzf.",
        "Make sure fzf is installed and available in the system.",
        error,
      );
    }
    // fzf is gone (selection, Esc or Ctrl+C): drop the preview overlay
    this.stopUeberzug(ueberzug);

    if (!previewer.success) {
      STD.exit();
      throw new SystemError("Error", previewer.stderr || "No item selected.");
    }

    const wallpaper = previewer.stdout.split("\n")[0].trim();
    const selection = this.wallpapers.find((wp) => wp.name === wallpaper);
    const mode = await askResizeMode();
    if (!mode) {
      throw EXIT;
    }
    selection.resizeMode = mode;
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
   * Adds are serialized with flock and kept `spacingMs` apart (timestamp
   * file), like the grid view's queue: fast scrolling must not burst adds
   * into ueberzugpp's Wayland canvas. If the layer has died (crashed:
   * `ueberzugpp cmd` still exits 0 then), the preview falls back to chafa
   * symbols.
   */
  ueberzugPreviewCmd(layer) {
    const socket = layer.socketPath();
    const pid = layer.pid;
    const spacing = Math.max(0, Math.round(layer.spacingMs));
    const decode =
      'f=$(echo -e {} | head -n 2 | tail -n 1 | tr -d " " | base64 -d 2>/dev/null | tr -d "\\000")';
    const alive = `st=$(cut -d" " -f3 /proc/${pid}/stat 2>/dev/null); [ -n "$st" ] && [ "$st" != Z ]`;
    const add = `ueberzugpp cmd -s "${socket}" -i wallrizz-preview -a add -x "$FZF_PREVIEW_LEFT" -y "$FZF_PREVIEW_TOP" --max-width "$FZF_PREVIEW_COLUMNS" --max-height "$FZF_PREVIEW_LINES" -f "$f" >/dev/null 2>&1`;
    const paced = spacing > 0
      ? `if command -v flock >/dev/null; then exec 9>"${socket}.lock"; flock 9; ` +
        `now=$(date +%s%3N); last=$(cat "${socket}.last" 2>/dev/null); ` +
        `w=$(( \${last:-0} + ${spacing} - now )); ` +
        `if [ "$w" -gt 0 ] && [ "$w" -le ${spacing} ]; then sleep "$(awk "BEGIN{print $w/1000}")"; fi; fi; ` +
        `${add}; date +%s%3N > "${socket}.last"`
      : add;
    let fallback = ":";
    if (commandExists("chafa")) {
      const [self] = OS.readlink("/proc/self/exe");
      const bin = self || "WallRizz";
      fallback = `WALLRIZZ_TERMINAL=${getTerminalBrand()} "${bin}" -P symbols --render-tile "$f" </dev/tty 2>/dev/null`;
    }
    return `--preview='${decode}; if ${alive}; then ${paced}; else ${fallback}; fi'`;
  }

  stopUeberzug(layer) {
    if (!layer) return;
    const socket = layer.socketPath();
    layer.stop();
    if (socket) {
      OS.remove(`${socket}.lock`);
      OS.remove(`${socket}.last`);
    }
  }

  toBase64(str) {
    return base64Utf8(str);
  }
}

function askResizeMode() {
  const saved = readResizeMode();
  print(
    `Display as  c crop   f fit   n no resize   s stretch   Enter ${saved}   Esc cancel`,
  );
  return new Promise((resolve) => {
    handleKeysPressSync({
      c: (_, quit) => { writeResizeMode("crop"); quit(); resolve("crop"); },
      f: (_, quit) => { writeResizeMode("fit"); quit(); resolve("fit"); },
      n: (_, quit) => { writeResizeMode("no"); quit(); resolve("no"); },
      s: (_, quit) => { writeResizeMode("stretch"); quit(); resolve("stretch"); },
      [keySequences.Enter]: (_, quit) => { quit(); resolve(saved); },
      [keySequences.Escape]: (_, quit) => { quit(); resolve(null); },
      q: (_, quit) => { quit(); resolve(null); },
    });
  });
}
