import { OS, STD, execAsync, EXIT, HOME_DIR } from "../core/constants.js";
import {
  clearTerminal,
  cursorHide,
  cursorMove,
  cursorShow,
  cursorTo,
  enterAlternativeScreen,
  eraseDown,
  exitAlternativeScreen,
} from "../../helpers/cursor.js";
import {
  handleKeysPress,
  handleKeysPressAsync,
  keySequences,
} from "../../helpers/terminal.js";
import {
  getImageProtocol,
  imagePixelSize,
  positionOutput,
  queryCellSize,
  renderWithChafa,
  requireChafa,
} from "./terminalImage.js";
import { installUeberzugSignalHandlers, UeberzugLayer } from "./ueberzug.js";
import { fitImageInBox, parseCellPx } from "./imageProtocol.js";
import { encodeJpegPayload, itermEscape, TileCache } from "./tileCache.js";
import { getProcessLimit } from "../core/utils/async.js";

// SIGWINCH (28 on Linux, macOS and the BSDs); QuickJS doesn't export it
const SIGWINCH = 28;
// cell size assumed when the terminal doesn't answer CSI 16 t
const FALLBACK_CELL_PX = { width: 10, height: 20 };
// let ueberzugpp drop the old overlays before the new page's are mapped
const UEBERZUG_SETTLE_MS = 30;

export class GalleryView {
  constructor(config, wallpapers, wallpapersDir, handleSelection, getWallpaperPath, onFocus) {
    this.config = config;
    this.wallpapers = wallpapers;
    this.wallpapersDir = wallpapersDir;
    this.handleSelection = handleSelection;
    this.getWallpaperPath = getWallpaperPath;
    this.onFocusCallback = onFocus;
    // "kitty" keeps the original native kitty graphics path untouched;
    // everything else (iterm, sixel, symbols) is drawn with chafa.
    this.protocol = config.resolvedImageProtocol ?? "kitty";
    this.isKitty = this.protocol === "kitty";
  }

  async render() {
    const pngPaths = this.wallpapers.map((img) => ({
      filePath: this.wallpapersDir + img.uniqueId,
      meta: img,
    }));

    const [terminalWidth, terminalHeight] = OS.ttyGetWinSize();

    if (this.protocol === "ueberzug") {
      const output = getImageProtocol(this.config).ueberzugOutput ?? "x11";
      const layer = new UeberzugLayer(output);
      if (await layer.start()) {
        this.ueberzug = layer;
        installUeberzugSignalHandlers(() => {
          STD.out.puts(exitAlternativeScreen + clearTerminal + cursorShow);
          STD.out.flush();
        });
      } else {
        // ueberzugpp didn't start (no usable canvas, missing libs...)
        requireChafa("symbols", "ueberzugpp failed to start");
        this.protocol = "symbols";
      }
    }

    if (!this.isKitty) {
      // cell pixel size: needed to fit images into tiles (and for sixel
      // encoding); ask once, before raw mode
      const cellPxText = queryCellSize();
      this.cellPx = parseCellPx(cellPxText) ?? FALLBACK_CELL_PX;
      this.cellPxText = cellPxText;
    }

    if (!this.isKitty && !this.ueberzug) {
      this.tiles = new TileCache({
        protocol: this.protocol,
        cellPx: this.protocol === "sixel" ? this.cellPxText : null,
        limit: this.config.processLimit ?? Math.max(1, await getProcessLimit()),
      });
    }

    const gridSize = this.config.enablePagination
      ? `${this.config.gridSize[1]}x${this.config.gridSize[0]}`
      : this.autoGridSize(terminalWidth, terminalHeight);

    await this.gallery(pngPaths, {
      gridSize,
      highlightType: this.config.highlight,
      terminalSize: `${terminalWidth}x${terminalHeight}`,
      cellPadding: {
        vertical: this.config.padding?.[0],
        horizontal: this.config.padding?.[1],
      },
      origin: "0x1",
      onFocus: (_, index) => {
        if (!this.config.onFocus && !USER_ARGUMENTS.focusSet) return;
        const wallpaper = this.wallpapers[index];
        return this.onFocusCallback?.(wallpaper);
      },
      onSelect: async (_, index) => {
        const wallpaper = this.wallpapers[index];
        await this.handleSelection(wallpaper);
      },
      getHiRes: (png) => this.getWallpaperPath(png.meta),
    }).catch(print);
  }

  autoGridSize(terminalWidth, terminalHeight) {
    const [imgW, imgH] = this.config.imageSize;
    const [padY, padX] = this.config.padding;

    const containerWidth = imgW + padX;
    const containerHeight = imgH + padY;

    const cols = Math.max(1, Math.floor(terminalWidth / containerWidth));
    const rows = Math.max(1, Math.floor(terminalHeight / containerHeight));

    return `${cols}x${rows}`;
  }

  async getImageDimensions(filePath) {
    const output = await execAsync([
      "magick", "identify", "-format", "%w %h", filePath,
    ]);
    const [width, height] = output.split(" ").map(Number);
    return { width, height };
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

  async renderImage(pngSource, size, position, sourceRect) {
    if (!this.isKitty) {
      return this.renderImageChafa(pngSource, size, position, sourceRect);
    }
    const tempFile = pngSource.filePath.endsWith(".png")
      ? pngSource.filePath
      : `/tmp/${pngSource.filePath.split("/").at(-1)}.png`;

    const [_, err] = OS.stat(tempFile);

    if (err) {
      print("Loading...");
      await execAsync([
        "magick",
        pngSource.filePath,
        "-type",
        "truecolor",
        tempFile,
      ]);
    }

    const encodedPath = this.toBase64(tempFile);

    if (position) {
      STD.out.puts(cursorTo(position.row, position.column));
    }

    let params = "a=T,t=f,f=100,q=2";
    if (size?.columns) params += `,c=${size.columns}`;
    if (size?.rows) params += `,r=${size.rows}`;
    // BUG: kitty ignores s/v/w/h source-rect params, so zoom/pan transmit has no effect.
    // Must pre-crop the image via magick before transmission instead.
    if (sourceRect) {
      if (sourceRect.x !== undefined) params += `,s=${Math.round(sourceRect.x)}`;
      if (sourceRect.y !== undefined) params += `,v=${Math.round(sourceRect.y)}`;
      if (sourceRect.w !== undefined) params += `,w=${Math.round(sourceRect.w)}`;
      if (sourceRect.h !== undefined) params += `,h=${Math.round(sourceRect.h)}`;
    }

    const escapeSequence = `\x1b_G${params};${encodedPath}\x1b\\`;
    STD.out.puts(escapeSequence);
    STD.out.flush();
  }

  /**
   * Non-kitty path: draw with chafa (iterm / sixel / symbols) at a cell.
   * Zoom/pan is done by pre-cropping with ImageMagick.
   */
  async renderImageChafa(pngSource, size, position, sourceRect) {
    let filePath = pngSource.filePath;
    if (
      sourceRect && sourceRect.w && sourceRect.h &&
      (sourceRect.x > 0 || sourceRect.y > 0 ||
        (this._fullW && sourceRect.w < this._fullW) ||
        (this._fullH && sourceRect.h < this._fullH))
    ) {
      const cropFile = `${HOME_DIR}/.cache/WallRizz/fullscreen-crop.png`;
      await execAsync([
        "magick",
        filePath,
        "-crop",
        `${Math.round(sourceRect.w)}x${Math.round(sourceRect.h)}+${
          Math.round(sourceRect.x ?? 0)
        }+${Math.round(sourceRect.y ?? 0)}`,
        "+repage",
        cropFile,
      ]);
      filePath = cropFile;
    }

    // fit the (cropped) image into the screen, centered, keeping its aspect
    // ratio, never touching the last column
    let x = position?.row ?? 0;
    let y = position?.column ?? 1;
    // current size (it may have changed while the crop was being made)
    const [termW, termH] = OS.ttyGetWinSize();
    const dims = sourceRect?.w && sourceRect?.h
      ? { width: sourceRect.w, height: sourceRect.h }
      : imagePixelSize(filePath);
    const cell = this.cellPx ?? FALLBACK_CELL_PX;
    const fit = fitImageInBox(
      dims?.width,
      dims?.height,
      Math.min(size?.columns ?? 20, termW - 1 - x),
      Math.min(size?.rows ?? 10, termH - y),
      cell.width,
      cell.height,
    );
    const columns = fit.columns;
    const rows = fit.rows;
    x += fit.dx;
    y += fit.dy;
    if (this.ueberzug) {
      this.ueberzug.removeAll();
      this.fullGen = (this.fullGen ?? 0) + 1;
      // ueberzug cells are 0-based, cursorTo rows are 1-based
      this.ueberzug.add(
        `wallrizz-full-g${this.fullGen}`,
        x,
        y - 1,
        columns,
        rows,
        filePath,
        "fit_contain",
      );
      return;
    }
    let output;
    if (this.protocol === "iterm") {
      // compressed JPEG instead of chafa's uncompressed TIFF
      const { b64, size: bytes } = await encodeJpegPayload(
        filePath,
        `${HOME_DIR}/.cache/WallRizz/fullscreen.jpg`,
        2560,
      );
      output = itermEscape(b64, bytes, columns, rows);
    } else {
      output = await renderWithChafa(this.protocol, filePath, columns, rows);
    }
    STD.out.puts(positionOutput(this.protocol, output, x, y));
    STD.out.flush();
  }

  async gallery(
    pngs,
    {
      gridSize = "4x3",
      onFocus = () => {},
      onSelect = () => {},
      highlightType = "fill",
      origin = "0x0",
      terminalSize,
      cellPadding = { vertical: 1, horizontal: 1 },
      getHiRes = () => {},
    },
  ) {
    let currentHighlight = highlightType;
    if (!Array.isArray(pngs)) throw TypeError("'pngs' must be an array of png");

    const [originX, originY] = origin ? origin.split("x").map(Number) : [0, 0];
    const [terminalWidth, terminalHeight] = terminalSize
      ? terminalSize.split("x").map(Number)
      : OS.ttyGetWinSize();

    const [targetCols, targetRows] = gridSize.split("x").map(Number);
    let cellWidth = 0;
    let cellHeight = 0;
    let layoutW = 0;
    let layoutH = 0;
    const coordinates = [];
    // Grid geometry for a terminal size. kitty computes it once (unchanged);
    // the other protocols recompute it from the current size on every page
    // draw, so nothing is placed with stale coordinates after a resize.
    const layout = (width, height) => {
      layoutW = width;
      layoutH = height;
      cellWidth = Math.floor(width / targetCols);
      cellHeight = Math.floor(height / targetRows);

      const usedWidth = cellWidth * targetCols;
      const usedHeight = cellHeight * targetRows;
      const offsetX = originX + Math.floor((width - usedWidth) / 2);
      const offsetY = originY + Math.floor((height - usedHeight) / 2);

      coordinates.length = 0;
      for (let row = 0; row < targetRows; row++) {
        for (let col = 0; col < targetCols; col++) {
          const x = offsetX + col * cellWidth;
          const y = offsetY + row * cellHeight;
          coordinates.push([x, y, cellWidth, cellHeight]);
        }
      }
    };
    layout(terminalWidth, terminalHeight);
    const relayout = () => {
      const [width, height] = OS.ttyGetWinSize();
      if (width !== layoutW || height !== layoutH) layout(width, height);
    };

    let currentCell = 0;
    let currentPage = 0;
    const maxCellsInGrid = targetCols * targetRows;
    const totalPages = Math.ceil(pngs.length / maxCellsInGrid);

    const label = () => currentHighlight === "fill" ? "█" : " ";

    // Last highlighted cell (non-kitty path only).
    let highlightedCell = null;

    const frameOf = (cellIndex, chars) => {
      const [x, y, w, h] = coordinates[cellIndex];
      const drawW = Math.floor(w);
      const drawH = Math.floor(h);
      if (drawW <= 1 || drawH <= 1) return "";
      const [hz, vt, tl, tr, bl, br] = chars;
      let out = cursorTo(x, y) + tl + hz.repeat(drawW - 2) + tr;
      for (let i = 1; i < drawH - 1; i++) {
        out += cursorTo(x, y + i) + vt + cursorTo(x + drawW - 1, y + i) + vt;
      }
      out += cursorTo(x, y + drawH - 1) + bl + hz.repeat(drawW - 2) + br;
      return out;
    };

    // With iterm/sixel/symbols the images live in the text layer, so the
    // kitty-style "erase everything and repaint the highlight" would wipe
    // them. Instead only the frame of the old/new cell is touched.
    const renderHighlightCells = (cellIndex) => {
      if (cellIndex < 0 || cellIndex >= coordinates.length) return;
      let out = "";
      if (highlightedCell !== null && highlightedCell !== cellIndex) {
        out += frameOf(highlightedCell, [" ", " ", " ", " ", " ", " "]);
      }
      out += frameOf(cellIndex, frameChars());
      highlightedCell = cellIndex;
      STD.out.puts(out);
      STD.out.flush();
    };
    const frameChars = () =>
      currentHighlight === "fill"
        ? ["█", "█", "█", "█", "█", "█"]
        : ["─", "│", "╭", "╮", "╰", "╯"];
    // repaint the current selection frame (after images were drawn)
    const redrawHighlightFrame = () => {
      if (highlightedCell === null) return;
      STD.out.puts(frameOf(highlightedCell, frameChars()));
      STD.out.flush();
    };

    const renderHighlight = (cellIndex) => {
      if (!this.isKitty) return renderHighlightCells(cellIndex);
      if (cellIndex < 0 || cellIndex >= coordinates.length) return;

      const [x, y, w, h] = coordinates[cellIndex];
      const drawW = Math.floor(w);
      const drawH = Math.floor(h);

      if (drawW <= 0 || drawH <= 0) return;

      STD.out.puts(cursorTo(0, 0), eraseDown);

      if (currentHighlight !== "fill") {
        const borderedLines = this.border(
          Math.max(0, drawH),
          Math.max(0, drawW),
        ).split("\n");

        for (let i = 0; i < borderedLines.length; i++) {
          STD.out.puts(cursorTo(x, y + i) + borderedLines[i]);
        }
      } else {
        const row = label().repeat(drawW);
        for (let i = 0; i < drawH; i++) {
          STD.out.puts(cursorTo(x, y + i) + row);
        }
      }
      STD.out.flush();
    };

    // Inner area of a tile: inside the selection frame (at least one cell of
    // padding), never in the terminal's last column or last row, where a
    // pixel image could wrap or scroll the screen.
    const tileBox = (i) => {
      const [x, y, w, h] = coordinates[i];
      const padX = Math.max(1, cellPadding.vertical || 0);
      const padY = Math.max(1, cellPadding.horizontal || 0);
      const bx = x + padX;
      const by = y + padY;
      const columns = Math.min(w - padX * 2, layoutW - 1 - bx);
      const rows = Math.min(h - padY * 2, layoutH - by);
      return { x: bx, y: by, columns: Math.max(1, columns), rows: Math.max(1, rows) };
    };
    // The image's own box: aspect-fitted inside the tile, centered.
    const fitTile = (i, imagePath) => {
      const box = tileBox(i);
      const size = imagePixelSize(imagePath);
      const cell = this.cellPx ?? FALLBACK_CELL_PX;
      const fit = fitImageInBox(
        size?.width,
        size?.height,
        box.columns,
        box.rows,
        cell.width,
        cell.height,
      );
      return { x: box.x + fit.dx, y: box.y + fit.dy, columns: fit.columns, rows: fit.rows };
    };

    // Non-kitty pages: frame first, then tiles drawn progressively as they
    // come out of the (cached, bounded, parallel) encoder. Returns without
    // waiting so keys stay responsive; stale tiles of a previous page are
    // never drawn (generation check) and their pending encodes are dropped.
    let pageGeneration = 0;
    const ueberzug = this.ueberzug;
    // Überzug++: the overlays are separate windows, so every overlay of the
    // old page is removed before the new page's tiles are added.
    // Identifiers are unique per draw (page + generation), so a remove that
    // is still in flight can never hit an overlay of a newer draw.
    const renderPageOverlays = (skipFocus = false) => {
      ueberzug.removeAll();
      relayout();
      STD.out.puts(clearTerminal);
      highlightedCell = null;
      const generation = ++pageGeneration;
      renderHighlight(currentCell);
      const page = currentPage;
      const startIdx = page * maxCellsInGrid;
      const overlays = [];
      for (let i = 0; i < maxCellsInGrid && startIdx + i < pngs.length; i++) {
        const thumb = pngs[startIdx + i].filePath;
        overlays.push({ i, thumb, box: fitTile(i, thumb) });
      }
      OS.setTimeout(() => {
        if (generation !== pageGeneration || this.fullscreen) return;
        for (const { i, thumb, box } of overlays) {
          // ueberzug cells are 0-based, cursorTo rows are 1-based
          ueberzug.add(
            `wallrizz-p${page}-g${generation}-${i}`,
            box.x,
            box.y - 1,
            box.columns,
            box.rows,
            thumb,
            "fit_contain",
          );
        }
        redrawHighlightFrame();
      }, UEBERZUG_SETTLE_MS);
      const globalIndex = (currentPage * maxCellsInGrid) + currentCell;
      if (!skipFocus && pngs[globalIndex]) {
        onFocus(pngs[globalIndex], globalIndex);
      }
    };

    const renderPageTiles = (skipFocus = false) => {
      if (ueberzug) return renderPageOverlays(skipFocus);
      relayout();
      STD.out.puts(clearTerminal);
      highlightedCell = null;
      const generation = ++pageGeneration;
      this.tiles.cancelPending();
      renderHighlight(currentCell);

      const draw = (box, out) => {
        if (out === null || generation !== pageGeneration || this.fullscreen) return;
        STD.out.puts(positionOutput(this.protocol, out, box.x, box.y));
        STD.out.flush();
        // images never overlap the frame, but repaint it anyway
        redrawHighlightFrame();
      };

      const startIdx = currentPage * maxCellsInGrid;
      const pending = [];
      for (let i = 0; i < maxCellsInGrid && startIdx + i < pngs.length; i++) {
        const thumb = pngs[startIdx + i].filePath;
        const box = fitTile(i, thumb);
        const cached = this.tiles.peek(thumb, box.columns, box.rows);
        if (cached !== null) {
          draw(box, cached);
          continue;
        }
        pending.push(
          this.tiles.get(thumb, box.columns, box.rows)
            .then((out) => draw(box, out))
            .catch(() => {}),
        );
      }

      // prefetch the next page in the background (encode only, no drawing)
      Promise.all(pending).then(() => {
        if (generation !== pageGeneration) return;
        const nextStart = (currentPage + 1) * maxCellsInGrid;
        for (let i = 0; i < maxCellsInGrid && nextStart + i < pngs.length; i++) {
          const thumb = pngs[nextStart + i].filePath;
          const box = fitTile(i, thumb);
          this.tiles.get(thumb, box.columns, box.rows, { low: true })
            .catch(() => {});
        }
      });

      const globalIndex = (currentPage * maxCellsInGrid) + currentCell;
      if (!skipFocus && pngs[globalIndex]) {
        onFocus(pngs[globalIndex], globalIndex);
      }
    };

    const renderPage = async (skipFocus = false) => {
      if (!this.isKitty) return renderPageTiles(skipFocus);
      STD.out.puts(clearTerminal);
      highlightedCell = null;

      const startIdx = currentPage * maxCellsInGrid;
      const promises = [];

      for (let i = 0; i < maxCellsInGrid; i++) {
        const pngIndex = startIdx + i;
        const coord = coordinates[i];

        if (pngIndex < pngs.length) {
          promises.push(
            this.renderImage(pngs[pngIndex], {
              rows: cellHeight - cellPadding.horizontal * 2,
              columns: cellWidth - cellPadding.vertical * 2,
            }, {
              row: coord[0] + cellPadding.vertical,
              column: coord[1] + cellPadding.horizontal,
            }),
          );
        }
      }

      await Promise.all(promises);

      renderHighlight(currentCell);

      const globalIndex = (currentPage * maxCellsInGrid) + currentCell;
      if (!skipFocus && pngs[globalIndex]) {
        onFocus(pngs[globalIndex], globalIndex);
      }
    };

    OS.ttySetRaw();
    STD.out.puts(cursorHide);
    try {
      await renderPage();
      let isFullScreen = false;
      let zoomLevel = 1.0;
      let panX = 0;
      let panY = 0;
      let imgWidth = 0;
      let imgHeight = 0;

    const moveSelectionDown = () => {
      if (isFullScreen) return;
      if (currentCell + targetCols < maxCellsInGrid) {
        const nextGlobal = (currentPage * maxCellsInGrid) +
          (currentCell + targetCols);
        if (nextGlobal < pngs.length) {
          currentCell += targetCols;
          renderHighlight(currentCell);
          return onFocus(pngs[nextGlobal], nextGlobal);
        }
      }
    };

    const moveSelectionUp = () => {
      if (isFullScreen) return;
      if (currentCell - targetCols >= 0) {
        currentCell -= targetCols;
        renderHighlight(currentCell);
        const nextGlobal = (currentPage * maxCellsInGrid) + currentCell;
        return onFocus(pngs[nextGlobal], nextGlobal);
      }
    };

    const renderFullscreen = async () => {
      const globalIndex = (currentPage * maxCellsInGrid) + currentCell;
      // BUG: if getHiRes returns null, falling back to pngSource obj instead of filePath string
      const filePath = getHiRes(pngs[globalIndex]) ?? pngs[globalIndex].filePath;

      const srcW = imgWidth / zoomLevel;
      const srcH = imgHeight / zoomLevel;

      panX = Math.max(0, Math.min(panX, imgWidth - srcW));
      panY = Math.max(0, Math.min(panY, imgHeight - srcH));

      let [screenW, screenH] = [terminalWidth, terminalHeight];
      if (!this.isKitty) {
        // clear the previous frame; keep the last row free so a sixel/iTerm2
        // image can never scroll the screen
        STD.out.puts("\x1b[2J");
        this._fullW = imgWidth;
        this._fullH = imgHeight;
        [screenW, screenH] = OS.ttyGetWinSize();
      }

      // BUG: s/v/w/h source-rect params are ignored by kitty, so pan offsets do nothing.
      // Must pre-crop with magick before transmission.
      return this.renderImage({ filePath }, {
        columns: screenW,
        rows: this.isKitty ? screenH : screenH - 1,
      }, { row: originX, column: originY }, {
        x: Math.round(panX),
        y: Math.round(panY),
        w: Math.round(srcW),
        h: Math.round(srcH),
      });
    };

    const toggleFullscreen = async () => {
      const globalIndex = (currentPage * maxCellsInGrid) + currentCell;
      if (pngs[globalIndex]) {
        // no overlay may outlive the view it belongs to (and pending adds
        // of the grid page are dropped)
        this.ueberzug?.removeAll();
        if (!this.isKitty) pageGeneration++;
        this.fullscreen = !isFullScreen;
        if (isFullScreen = !isFullScreen) {
          print(enterAlternativeScreen);
          zoomLevel = 1.0;
          panX = 0;
          panY = 0;
          // BUG: falling back to pngSource object instead of .filePath string
          const filePath = getHiRes(pngs[globalIndex]) ?? pngs[globalIndex].filePath;
          const dims = await this.getImageDimensions(filePath);
          imgWidth = dims.width;
          imgHeight = dims.height;
          return renderFullscreen();
        }
        print(exitAlternativeScreen);
        // Pixel images in the text layer are not guaranteed to survive the
        // alternate screen round trip on every terminal: redraw the page.
        if (!this.isKitty) await renderPage(true);
      }
    };

    const zoomIn = async () => {
      if (!isFullScreen) return;
      const newZoom = Math.min(5.0, zoomLevel * 1.25);
      panX += (imgWidth / zoomLevel - imgWidth / newZoom) / 2;
      panY += (imgHeight / zoomLevel - imgHeight / newZoom) / 2;
      zoomLevel = newZoom;
      await renderFullscreen();
    };

    const zoomOut = async () => {
      if (!isFullScreen) return;
      const newZoom = Math.max(1.0, zoomLevel / 1.25);
      panX += (imgWidth / zoomLevel - imgWidth / newZoom) / 2;
      panY += (imgHeight / zoomLevel - imgHeight / newZoom) / 2;
      zoomLevel = newZoom;
      await renderFullscreen();
    };

    const panUp = async () => {
      if (!isFullScreen || zoomLevel <= 1.0) return;
      const srcH = imgHeight / zoomLevel;
      panY = Math.max(0, panY - Math.max(1, Math.floor(srcH / 10)));
      await renderFullscreen();
    };

    const panDown = async () => {
      if (!isFullScreen || zoomLevel <= 1.0) return;
      const srcH = imgHeight / zoomLevel;
      panY = Math.min(imgHeight - srcH, panY + Math.max(1, Math.floor(srcH / 10)));
      await renderFullscreen();
    };

    const panLeft = async () => {
      if (!isFullScreen || zoomLevel <= 1.0) return;
      const srcW = imgWidth / zoomLevel;
      panX = Math.max(0, panX - Math.max(1, Math.floor(srcW / 10)));
      await renderFullscreen();
    };

    const panRight = async () => {
      if (!isFullScreen || zoomLevel <= 1.0) return;
      const srcW = imgWidth / zoomLevel;
      panX = Math.min(imgWidth - srcW, panX + Math.max(1, Math.floor(srcW / 10)));
      await renderFullscreen();
    };

    const moveSelection = async (direction) => {
      if (isFullScreen) return;
      const globalIdx = (currentPage * maxCellsInGrid) + currentCell;

      if (direction === "NEXT") {
        const isLastCellInGrid = currentCell === maxCellsInGrid - 1;
        const isLastImage = globalIdx === pngs.length - 1;

        if (!isLastCellInGrid && !isLastImage) {
          currentCell++;
          renderHighlight(currentCell);
          onFocus(pngs[globalIdx + 1], globalIdx + 1);
        } else if (isLastCellInGrid && currentPage < totalPages - 1) {
          currentPage++;
          currentCell = 0;
          await renderPage();
        }
        return;
      }

      if (direction === "PREV") {
        const isFirstCellInGrid = currentCell === 0;

        if (!isFirstCellInGrid) {
          currentCell--;
          renderHighlight(currentCell);
          onFocus(pngs[globalIdx - 1], globalIdx - 1);
        } else if (isFirstCellInGrid && currentPage > 0) {
          currentPage--;
          currentCell = maxCellsInGrid - 1;
          await renderPage();
        }
        return;
      }
    };

    const nextPage = () => {
      if (isFullScreen || currentPage == totalPages - 1) return;
      currentPage++;
      currentCell = 0;
      return renderPage();
    };

    const prevPage = () => {
      if (isFullScreen || currentPage === 0) return;
      currentPage--;
      currentCell = maxCellsInGrid - 1;
      return renderPage();
    };

    const handleExit = (_, exit) => {
      this.ueberzug?.removeAll();
      if (isFullScreen) print(exitAlternativeScreen);
      exit();
    };

    // Resize (non-kitty): when the size really changed, drop all Überzug++
    // overlays at once (they don't move with the text) and redraw from a
    // fresh layout once resizing settles. Spurious SIGWINCHs that leave the
    // size unchanged are ignored, so they can't trigger redraw loops.
    let resizeTimer = null;
    let drawnSize = OS.ttyGetWinSize().join("x");
    if (!this.isKitty) {
      OS.signal(SIGWINCH, () => {
        const size = OS.ttyGetWinSize().join("x");
        if (size === drawnSize && !resizeTimer) return;
        this.ueberzug?.removeAll();
        if (resizeTimer) OS.clearTimeout(resizeTimer);
        resizeTimer = OS.setTimeout(() => {
          resizeTimer = null;
          drawnSize = OS.ttyGetWinSize().join("x");
          if (isFullScreen) renderFullscreen().catch(() => {});
          else renderPage(true);
        }, 150);
      });
    }

    // kitty keeps the original blocking key reader; the other protocols need
    // the event loop to keep running between keys (progressive tiles,
    // background prefetch).
    await (this.isKitty ? handleKeysPress : handleKeysPressAsync)({
      [keySequences.ArrowDown]: () => {
        if (isFullScreen && zoomLevel > 1) return panDown();
        moveSelectionDown();
      },
      "j": () => {
        if (isFullScreen && zoomLevel > 1) return panDown();
        moveSelectionDown();
      },

      [keySequences.ArrowUp]: () => {
        if (isFullScreen && zoomLevel > 1) return panUp();
        moveSelectionUp();
      },
      "k": () => {
        if (isFullScreen && zoomLevel > 1) return panUp();
        moveSelectionUp();
      },

      [keySequences.ArrowRight]: () => {
        if (isFullScreen && zoomLevel > 1) return panRight();
        return moveSelection("NEXT");
      },
      "l": () => {
        if (isFullScreen && zoomLevel > 1) return panRight();
        return moveSelection("NEXT");
      },
      [keySequences.ArrowLeft]: () => {
        if (isFullScreen && zoomLevel > 1) return panLeft();
        return moveSelection("PREV");
      },
      "h": () => {
        if (isFullScreen && zoomLevel > 1) return panLeft();
        return moveSelection("PREV");
      },

      "f": toggleFullscreen,
      "+": zoomIn,
      "-": zoomOut,

      "H": prevPage,
      "L": nextPage,

      [keySequences.Enter]: () => {
        const globalIndex = (currentPage * maxCellsInGrid) + currentCell;
        if (pngs[globalIndex]) {
          return onSelect(pngs[globalIndex], globalIndex);
        }
      },

      [keySequences.Space]: () => {
        USER_ARGUMENTS.focusSet = !USER_ARGUMENTS.focusSet;
        USER_ARGUMENTS.hold = USER_ARGUMENTS.focusSet;
      },
      [keySequences.Tab]: () => {
        currentHighlight = currentHighlight === "border" ? "fill" : "border";
        USER_ARGUMENTS.highlight = currentHighlight;
        renderHighlight(currentCell);
      },

      "q": handleExit,
    });

    } finally {
      if (!this.isKitty) OS.signal(SIGWINCH, null);
      if (this.ueberzug) {
        this.ueberzug.stop();
        this.ueberzug = null;
      }
      STD.out.puts(clearTerminal);
      print(cursorShow);
    }
  }

  border(height, width) {
    const x = "─";
    const y = "│";
    const tl = "╭";
    const tr = "╮";
    const bl = "╰";
    const br = "╯";

    const top = tl + x.repeat(width - 2) + tr;
    const middle = y + " ".repeat(width - 2) + y;
    const bottom = bl + x.repeat(width - 2) + br;

    const rows = [top];
    for (let i = 0; i < height - 2; i++) {
      rows.push(middle);
    }
    rows.push(bottom);

    return rows.join("\n");
  }
}
