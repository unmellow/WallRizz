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
  handleKeysPressAsync,
  keySequences,
} from "../../helpers/terminal.js";
import {
  commandExists,
  getImageProtocol,
  imagePixelSize,
  insideKitty,
  positionOutput,
  queryCellSize,
  renderWithChafa,
  requireChafa,
  writeOut,
} from "./terminalImage.js";
import { installUeberzugSignalHandlers, UeberzugLayer } from "./ueberzug.js";
import {
  base64Utf8,
  fitImageInBox,
  kittyFileEscape,
  parseCellPx,
  regrid,
} from "./imageProtocol.js";
import { encodeJpegPayload, itermEscape, TileCache } from "./tileCache.js";
import { defaultPoolSize, magickSlots, ThumbPool } from "../wallpaper/thumbnails.js";

// SIGWINCH (28 on Linux, macOS and the BSDs); QuickJS doesn't export it
const SIGWINCH = 28;
// cell size assumed when the terminal doesn't answer CSI 16 t
const FALLBACK_CELL_PX = { width: 10, height: 20 };
// let ueberzugpp drop the old overlays before the new page's are mapped
const UEBERZUG_SETTLE_MS = 30;
// a crashed ueberzugpp is restarted this often per session, then WallRizz
// falls back to chafa symbols
const UEBERZUG_MAX_RESTARTS = 2;
// resize: redraw once the size has been stable this long; the size is also
// polled, in case a SIGWINCH is missed (e.g. during startup)
const RESIZE_SETTLE_MS = 150;
const RESIZE_POLL_MS = 400;
// kitty graphics: delete every image (layer based terminals keep images
// across a text clear)
const KITTY_DELETE_ALL = "\x1b_Ga=d,d=A,q=2\x1b\\";

export class GalleryView {
  constructor(config, wallpapers, wallpapersDir, handleSelection, getWallpaperPath, onFocus, onReady) {
    this.config = config;
    this.wallpapers = wallpapers;
    this.wallpapersDir = wallpapersDir;
    this.handleSelection = handleSelection;
    this.getWallpaperPath = getWallpaperPath;
    this.onFocusCallback = onFocus;
    this.onReady = onReady;
    // "kitty" inside kitty itself keeps the original native kitty graphics
    // path; everything else (iterm, sixel, symbols, ueberzug, and kitty
    // graphics in other terminals such as WezTerm, which put the images
    // into the cell grid where the native path's full-screen erase deletes
    // them) uses the cell-safe tile path.
    this.protocol = config.resolvedImageProtocol ?? "kitty";
    this.isKitty = this.protocol === "kitty" && insideKitty();
    this.statusLine = null;
    this.ueberzugRestarts = 0;
    this.thumbs = null;
  }

  async render() {
    const pngPaths = this.wallpapers.map((img) => ({
      filePath: this.wallpapersDir + img.uniqueId,
      meta: img,
    }));

    const [terminalWidth, terminalHeight] = OS.ttyGetWinSize();

    // -x / --plimit: thumbnail worker threads, parallel tile encoders, and
    // the cap on magick processes running at once. Default min(4, CPUs).
    this.poolSize = this.config.processLimit ?? defaultPoolSize();
    magickSlots.setCap(this.poolSize);
    this.thumbs = new ThumbPool({
      size: this.config.thumbnailSize,
      poolSize: this.poolSize,
    });

    if (this.protocol === "ueberzug") {
      this.ueberzugOutput = getImageProtocol(this.config).ueberzugOutput ?? "x11";
      if (!(await this.startUeberzug())) {
        // ueberzugpp didn't start (no usable canvas, missing libs...)
        requireChafa("symbols", "ueberzugpp failed to start");
        this.protocol = "symbols";
      }
    }
    // Ctrl+C / SIGTERM / SIGHUP: no overlay, magick child or temp file is
    // left behind, and the screen is restored
    installUeberzugSignalHandlers(() => {
      STD.out.puts(exitAlternativeScreen + clearTerminal + cursorShow);
      STD.out.flush();
    });

    if (!this.isKitty) {
      // cell pixel size: needed to fit images into tiles (and for sixel
      // encoding); ask once, before raw mode
      const cellPxText = queryCellSize();
      this.cellPx = parseCellPx(cellPxText) ?? FALLBACK_CELL_PX;
      this.cellPxText = cellPxText;
    }

    if (!this.isKitty && !this.ueberzug && this.protocol !== "kitty") {
      this.makeTileCache();
    }

    // grid for a terminal size; the cell-safe path re-evaluates it whenever
    // the size changes (resize, or the compositor resizing a new window
    // after WallRizz already drew its first page)
    const gridFor = (width, height) =>
      this.config.enablePagination
        ? `${this.config.gridSize[1]}x${this.config.gridSize[0]}`
        : this.autoGridSize(width, height);

    await this.gallery(pngPaths, {
      gridSize: gridFor(terminalWidth, terminalHeight),
      gridFor,
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

  makeTileCache() {
    this.tiles = new TileCache({
      protocol: this.protocol,
      cellPx: this.protocol === "sixel" ? this.cellPxText : null,
      limit: this.poolSize,
    });
  }

  /**
   * Start (or restart) the Überzug++ layer. Every restart doubles the pause
   * between adds. On death: restart up to UEBERZUG_MAX_RESTARTS times and
   * redraw, then fall back to chafa symbols for the rest of the session.
   * @returns {Promise<boolean>}
   */
  async startUeberzug(spacingMs) {
    const layer = new UeberzugLayer(this.ueberzugOutput, {
      spacingMs,
      onDeath: (reason) => this.onUeberzugDeath(layer, reason),
    });
    if (!(await layer.start())) return false;
    this.ueberzug = layer;
    return true;
  }

  async onUeberzugDeath(layer, reason) {
    if (this.ueberzug !== layer) return; // stopped / replaced already
    this.ueberzug = null;
    this.ueberzugDeaths = [...(this.ueberzugDeaths ?? []), reason];
    if (this.ueberzugRestarts < UEBERZUG_MAX_RESTARTS) {
      this.ueberzugRestarts++;
      if (await this.startUeberzug(Math.max(layer.spacingMs * 2, 50))) {
        this.redraw?.();
        return;
      }
    }
    // give up on Überzug++ for this session
    if (commandExists("chafa")) {
      this.protocol = "symbols";
      this.makeTileCache();
      this.statusLine = `Überzug++ ${reason} (${this.ueberzugDeaths.length}x): ` +
        "using text symbols for this session";
    } else {
      this.protocol = "none";
      this.statusLine = `Überzug++ ${reason}: no images (install chafa for text symbols)`;
    }
    this.redraw?.();
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
    const output = await magickSlots.run(() =>
      execAsync(["magick", "identify", "-format", "%w %h", `${filePath}[0]`])
    );
    const [width, height] = output.split(" ").map(Number);
    return { width, height };
  }

  /**
   * base64 of the image path for kitty's t=f. (The original encoder padded
   * with "A" instead of "=", appending NUL bytes to the decoded path.)
   */
  toBase64(str) {
    return base64Utf8(str);
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
      await magickSlots.run(() =>
        execAsync([
          "magick",
          pngSource.filePath,
          "-type",
          "truecolor",
          tempFile,
        ])
      );
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
      const src = filePath;
      await magickSlots.run(() => execAsync([
        "magick",
        src,
        "-crop",
        `${Math.round(sourceRect.w)}x${Math.round(sourceRect.h)}+${
          Math.round(sourceRect.x ?? 0)
        }+${Math.round(sourceRect.y ?? 0)}`,
        "+repage",
        cropFile,
      ]));
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
    if (this.protocol === "none") return;
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
    if (this.protocol === "kitty") {
      // kitty graphics outside kitty: a PNG file the terminal reads (t=f)
      const png = `${HOME_DIR}/.cache/WallRizz/fullscreen-kitty.png`;
      await magickSlots.run(() => execAsync([
        "magick",
        `${filePath}[0]`,
        "-resize",
        "2560x2560>",
        png,
      ]));
      output = KITTY_DELETE_ALL + kittyFileEscape(png, columns, rows);
    } else if (this.protocol === "iterm") {
      // compressed JPEG instead of chafa's uncompressed TIFF
      const { b64, size: bytes } = await magickSlots.run(() =>
        encodeJpegPayload(
          filePath,
          `${HOME_DIR}/.cache/WallRizz/fullscreen.jpg`,
          2560,
        )
      );
      output = itermEscape(b64, bytes, columns, rows);
    } else {
      output = await renderWithChafa(this.protocol, filePath, columns, rows);
    }
    writeOut(positionOutput(this.protocol, output, x, y));
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
      gridFor = null,
    },
  ) {
    let currentHighlight = highlightType;
    if (!Array.isArray(pngs)) throw TypeError("'pngs' must be an array of png");

    const [originX, originY] = origin ? origin.split("x").map(Number) : [0, 0];
    const [terminalWidth, terminalHeight] = terminalSize
      ? terminalSize.split("x").map(Number)
      : OS.ttyGetWinSize();

    let [targetCols, targetRows] = gridSize.split("x").map(Number);
    let cellWidth = 0;
    let cellHeight = 0;
    let layoutW = 0;
    let layoutH = 0;
    let layoutReserved = 0;
    let currentCell = 0;
    let currentPage = 0;
    let maxCellsInGrid = targetCols * targetRows;
    let totalPages = Math.ceil(pngs.length / maxCellsInGrid);
    // terminal size the current page was laid out for (cell-safe path)
    let drawnSize = null;
    const coordinates = [];
    // Grid geometry for a terminal size. kitty computes it once (unchanged);
    // the other protocols recompute it, and the grid dimensions, from the
    // current size on every page draw, so nothing is placed with stale
    // coordinates after a resize. The selected wallpaper stays selected.
    const layout = (width, height) => {
      layoutW = width;
      layoutH = height;
      // a status line (e.g. "Überzug++ crashed") takes the last row
      layoutReserved = !this.isKitty && this.statusLine ? 1 : 0;
      const gridH = Math.max(1, height - layoutReserved);
      if (!this.isKitty && gridFor) {
        const [cols, rows] = gridFor(width, gridH).split("x").map(Number);
        if (cols > 0 && rows > 0 && (cols !== targetCols || rows !== targetRows)) {
          const g = regrid(
            currentPage * maxCellsInGrid + currentCell,
            cols,
            rows,
            pngs.length,
          );
          targetCols = cols;
          targetRows = rows;
          maxCellsInGrid = g.maxCells;
          totalPages = g.totalPages;
          currentPage = g.page;
          currentCell = g.cell;
        }
      }
      cellWidth = Math.floor(width / targetCols);
      cellHeight = Math.floor(gridH / targetRows);

      const usedWidth = cellWidth * targetCols;
      const usedHeight = cellHeight * targetRows;
      const offsetX = originX + Math.floor((width - usedWidth) / 2);
      const offsetY = originY + Math.floor((gridH - usedHeight) / 2);

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
    // read the real size at draw time (a new terminal window may still be
    // 80x24 when WallRizz starts and get resized right after)
    const relayout = () => {
      const [width, height] = OS.ttyGetWinSize();
      const reserved = this.statusLine ? 1 : 0;
      if (width !== layoutW || height !== layoutH || reserved !== layoutReserved) {
        layout(width, height);
      }
      drawnSize = `${width}x${height}`;
    };
    // the status line, in the row the layout keeps free for it
    const statusRow = () =>
      this.statusLine && layoutReserved
        ? cursorTo(0, layoutH) + "\x1b[0;2m" +
          [...this.statusLine].slice(0, Math.max(0, layoutW - 1)).join("") + "\x1b[0m"
        : "";

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
        out += restFrameOf(highlightedCell);
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
      // placeholder frames of the tiles still waiting for a thumbnail
      let frames = "";
      for (let i = 0; i < tilesOnPage(); i++) {
        if (i !== cellIndex && !loaded.has(i)) frames += placeholderOf(i);
      }
      STD.out.puts(frames);

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

    // Thumbnails are made by the worker pool (see wallpaper/thumbnails.js):
    // every page draw first shows the frame of each tile whose image isn't
    // ready, then fills tiles in as their thumbnail (and tile encode)
    // finishes. Nothing here waits for a thumbnail, so keys stay
    // responsive. Each draw takes a ticket (pageGeneration for drawing,
    // thumbGen for the pool): output of an older draw is never written.
    let pageGeneration = 0;
    // tiles of the current page whose image is drawn (the others show a
    // dim placeholder frame)
    let loaded = new Set();
    const tilesOnPage = () =>
      Math.max(0, Math.min(maxCellsInGrid, pngs.length - currentPage * maxCellsInGrid));
    const PLACEHOLDER = ["─", "│", "┌", "┐", "└", "┘"];
    const BLANK = [" ", " ", " ", " ", " ", " "];
    const placeholderOf = (i) => "\x1b[0;2m" + frameOf(i, PLACEHOLDER) + "\x1b[0m";
    // frame of a tile that isn't selected
    const restFrameOf = (i) =>
      i < tilesOnPage() && !loaded.has(i) && this.protocol !== "none"
        ? placeholderOf(i)
        : frameOf(i, BLANK);
    const sourceOf = (idx) => getHiRes(pngs[idx]) ?? pngs[idx].filePath;
    const thumbReady = (idx) => OS.stat(pngs[idx].filePath)[1] === 0;
    // thumbnail of a tile: at once if cached, else from the pool
    const thumbFor = (idx, thumbGen, low = false) =>
      thumbReady(idx)
        ? Promise.resolve(pngs[idx].filePath)
        : this.thumbs.request(sourceOf(idx), thumbGen, { low });
    // a tile's image is on screen: its placeholder goes
    const markLoaded = (i) => {
      loaded.add(i);
      if (i !== highlightedCell) STD.out.puts(frameOf(i, BLANK));
      redrawHighlightFrame();
    };

    // Prefetch (after the visible page is complete): thumbnails of the next
    // page, then of the previous one, at low priority, and their encoded
    // tiles (not drawn). A page flip then draws from cache.
    const prefetch = (generation, thumbGen) => {
      const pageOf = async (page) => {
        if (page < 0 || page >= totalPages || generation !== pageGeneration) return;
        const start = page * maxCellsInGrid;
        const jobs = [];
        for (let i = 0; i < maxCellsInGrid && start + i < pngs.length; i++) {
          jobs.push(
            thumbFor(start + i, thumbGen, true).then((thumb) => {
              if (!thumb || generation !== pageGeneration || !this.tiles) return;
              const box = fitTile(i, thumb);
              return this.tiles.get(thumb, box.columns, box.rows, { low: true });
            }).catch(() => {}),
          );
        }
        await Promise.all(jobs);
      };
      return pageOf(currentPage + 1).then(() => pageOf(currentPage - 1));
    };

    // Überzug++: the overlays are separate windows, so every overlay of the
    // old page is removed (and adds of it still queued are dropped) before
    // the new page's tiles are added. Identifiers are unique per draw (page
    // + generation), so a remove that is still in flight can never hit an
    // overlay of a newer draw. The layer paces the adds (see ueberzug.js).
    const renderPageOverlays = (skipFocus = false) => {
      const ueberzug = this.ueberzug;
      ueberzug.removeAll();
      relayout();
      STD.out.puts(clearTerminal + statusRow());
      highlightedCell = null;
      const generation = ++pageGeneration;
      const thumbGen = this.thumbs.bump();
      loaded = new Set();
      const page = currentPage;
      const startIdx = page * maxCellsInGrid;
      const current = () =>
        generation === pageGeneration && !this.fullscreen && this.ueberzug === ueberzug;
      const addOverlay = (i, thumb) => {
        const box = fitTile(i, thumb);
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
        markLoaded(i);
      };
      const ready = [];
      const pending = [];
      let frames = "";
      for (let i = 0; i < maxCellsInGrid && startIdx + i < pngs.length; i++) {
        if (thumbReady(startIdx + i)) {
          ready.push({ i, thumb: pngs[startIdx + i].filePath });
          continue;
        }
        if (i !== currentCell) frames += placeholderOf(i);
        pending.push(
          this.thumbs.request(sourceOf(startIdx + i), thumbGen).then((thumb) => {
            if (thumb && current()) addOverlay(i, thumb);
          }).catch(() => {}),
        );
      }
      STD.out.puts(frames);
      renderHighlight(currentCell);
      OS.setTimeout(() => {
        if (!current()) return;
        for (const { i, thumb } of ready) addOverlay(i, thumb);
        redrawHighlightFrame();
      }, UEBERZUG_SETTLE_MS);
      Promise.all(pending).then(() => {
        if (current()) prefetch(generation, thumbGen);
      });
      const globalIndex = (currentPage * maxCellsInGrid) + currentCell;
      if (!skipFocus && pngs[globalIndex]) {
        onFocus(pngs[globalIndex], globalIndex);
      }
    };

    // Cell-grid pages (iterm, sixel, symbols, kitty graphics outside kitty):
    // tiles already encoded are drawn at once; the others show a placeholder
    // frame and are drawn as their thumbnail and tile encode finish.
    const renderPageTiles = (skipFocus = false) => {
      if (this.ueberzug) return renderPageOverlays(skipFocus);
      relayout();
      const kittyCells = this.protocol === "kitty";
      STD.out.puts((kittyCells ? KITTY_DELETE_ALL : "") + clearTerminal + statusRow());
      highlightedCell = null;
      const generation = ++pageGeneration;
      this.tiles?.cancelPending();
      // the thumbnail ticket: work of an older page is dropped / never drawn
      const thumbGen = this.thumbs.bump();
      loaded = new Set();
      const imagesOn = kittyCells || !!this.tiles;
      const current = () => generation === pageGeneration && !this.fullscreen;

      const draw = (i, box, out) => {
        if (out === null || !current()) return;
        writeOut(positionOutput(this.protocol, out, box.x, box.y));
        markLoaded(i);
      };
      // encoded output of a tile from its thumbnail: a string (cached), or
      // a promise of one
      const encodeTile = (i, thumb, cachedOnly) => {
        const box = fitTile(i, thumb);
        if (kittyCells) return { box, out: kittyFileEscape(thumb, box.columns, box.rows) };
        const out = this.tiles.peek(thumb, box.columns, box.rows);
        if (out !== null || cachedOnly) return { box, out };
        return { box, out: this.tiles.get(thumb, box.columns, box.rows) };
      };

      const startIdx = currentPage * maxCellsInGrid;
      const now = [];
      const later = [];
      let frames = "";
      for (let i = 0; imagesOn && i < maxCellsInGrid && startIdx + i < pngs.length; i++) {
        const idx = startIdx + i;
        if (thumbReady(idx)) {
          const tile = encodeTile(i, pngs[idx].filePath, true);
          if (tile.out !== null) {
            now.push({ i, ...tile });
            continue;
          }
        }
        if (i !== currentCell) frames += placeholderOf(i);
        later.push(i);
      }
      STD.out.puts(frames);
      renderHighlight(currentCell);
      for (const { i, box, out } of now) draw(i, box, out);

      const pending = later.map((i) =>
        thumbFor(startIdx + i, thumbGen).then((thumb) => {
          if (!thumb || !current()) return;
          const { box, out } = encodeTile(i, thumb, false);
          return Promise.resolve(out).then((o) => draw(i, box, o));
        }).catch(() => {})
      );
      // prefetch, only once the visible page is complete (never ahead of it)
      Promise.all(pending).then(() => {
        if (current()) return prefetch(generation, thumbGen);
      }).catch(() => {});

      const globalIndex = (currentPage * maxCellsInGrid) + currentCell;
      if (!skipFocus && pngs[globalIndex]) {
        onFocus(pngs[globalIndex], globalIndex);
      }
    };

    // kitty itself: the original native path (images in kitty's own layer,
    // placed with t=f from the PNG thumbnail), filled in the same way.
    const renderPage = async (skipFocus = false) => {
      if (!this.isKitty) return renderPageTiles(skipFocus);
      STD.out.puts(clearTerminal);
      highlightedCell = null;
      const generation = ++pageGeneration;
      const thumbGen = this.thumbs.bump();
      loaded = new Set();
      const current = () => generation === pageGeneration && !this.fullscreen;

      const startIdx = currentPage * maxCellsInGrid;
      const place = (i, thumb) => {
        const coord = coordinates[i];
        return this.renderImage({ filePath: thumb }, {
          rows: cellHeight - cellPadding.horizontal * 2,
          columns: cellWidth - cellPadding.vertical * 2,
        }, {
          row: coord[0] + cellPadding.vertical,
          column: coord[1] + cellPadding.horizontal,
        });
      };
      const ready = [];
      const later = [];
      for (let i = 0; i < maxCellsInGrid && startIdx + i < pngs.length; i++) {
        if (thumbReady(startIdx + i)) {
          ready.push(i);
          loaded.add(i);
        } else later.push(i);
      }
      // the highlight (and the placeholder frames of the missing tiles)
      renderHighlight(currentCell);
      await Promise.all(ready.map((i) => place(i, pngs[startIdx + i].filePath)));

      const pending = later.map((i) =>
        this.thumbs.request(sourceOf(startIdx + i), thumbGen).then(async (thumb) => {
          if (!thumb || !current()) return;
          loaded.add(i);
          await place(i, thumb);
          if (i !== currentCell) STD.out.puts(frameOf(i, BLANK));
          STD.out.flush();
        }).catch(() => {})
      );
      Promise.all(pending).then(() => {
        if (current()) return prefetch(generation, thumbGen);
      }).catch(() => {});

      const globalIndex = (currentPage * maxCellsInGrid) + currentCell;
      if (!skipFocus && pngs[globalIndex]) {
        onFocus(pngs[globalIndex], globalIndex);
      }
    };

    let isFullScreen = false;
    let zoomLevel = 1.0;
    let panX = 0;
    let panY = 0;
    let imgWidth = 0;
    let imgHeight = 0;

    // Resize (non-kitty): when the size really changed, drop all Überzug++
    // overlays at once (they don't move with the text) and redraw from a
    // fresh layout (grid dimensions included) once resizing settles.
    // Installed before the first draw, and backed by a size poll, so a
    // resize that happens while the first page is being drawn (a new
    // terminal window growing from 80x24) is never missed. Spurious
    // SIGWINCHs that leave the size unchanged are ignored, so they can't
    // trigger redraw loops.
    let resizeTimer = null;
    let pollTimer = null;
    let active = true;
    let renderFullscreenRef = null; // defined with the key handlers below
    const redraw = () => {
      if (!active) return;
      if (isFullScreen) renderFullscreenRef?.().catch(() => {});
      else renderPage(true);
    };
    const onResize = () => {
      if (!active) return;
      const size = OS.ttyGetWinSize().join("x");
      if (size === drawnSize && !resizeTimer) return;
      this.ueberzug?.removeAll();
      if (resizeTimer) OS.clearTimeout(resizeTimer);
      resizeTimer = OS.setTimeout(() => {
        resizeTimer = null;
        redraw();
      }, RESIZE_SETTLE_MS);
    };
    const poll = () => {
      pollTimer = OS.setTimeout(() => {
        pollTimer = null;
        if (!active) return;
        if (drawnSize !== null) onResize();
        poll();
      }, RESIZE_POLL_MS);
    };
    if (!this.isKitty) {
      OS.signal(SIGWINCH, onResize);
      poll();
      // Überzug++ restart / fallback redraws through this
      this.redraw = redraw;
    }

    OS.ttySetRaw();
    STD.out.puts(cursorHide);
    try {
      await renderPage();
      // colours/themes for the wallpapers not generated up front, quietly,
      // and only while no thumbnail is being made
      this.stopBackground = this.onReady?.(() =>
        this.thumbs.pending === 0 && this.thumbs.busy.size === 0 && !isFullScreen);

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
        drawnSize = `${screenW}x${screenH}`;
        if (this.statusLine) {
          STD.out.puts(cursorTo(0, screenH) + "\x1b[0;2m" +
            [...this.statusLine].slice(0, Math.max(0, screenW - 1)).join("") + "\x1b[0m");
          screenH -= 1;
        }
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

    renderFullscreenRef = renderFullscreen;

    const toggleFullscreen = async () => {
      const globalIndex = (currentPage * maxCellsInGrid) + currentCell;
      if (pngs[globalIndex]) {
        // no overlay may outlive the view it belongs to (and pending adds
        // of the grid page are dropped)
        this.ueberzug?.removeAll();
        pageGeneration++;
        // queued thumbnails / tile encodes of the grid page are dropped, so
        // fullscreen's own magick gets a slot as soon as one frees up
        this.thumbs.bump();
        this.tiles?.cancelPending();
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

    // Keys are read from the event loop (never a blocking read), so worker
    // results, tile encodes and prefetch keep running between keys, and a
    // key is handled while a cold page is still being generated.
    await handleKeysPressAsync({
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
      // raw mode: Ctrl+C arrives as a key, not as SIGINT
      [keySequences["Ctrl+C"]]: handleExit,
    });

    } finally {
      active = false;
      if (resizeTimer) OS.clearTimeout(resizeTimer);
      if (pollTimer) OS.clearTimeout(pollTimer);
      this.redraw = null;
      if (!this.isKitty) OS.signal(SIGWINCH, null);
      if (this.ueberzug) {
        this.ueberzug.stop();
        this.ueberzug = null;
      }
      // drop queued thumbnail work, kill a magick still mid-batch (its temp
      // file is removed) and let the worker threads end
      this.stopBackground?.();
      await this.thumbs?.shutdown();
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
