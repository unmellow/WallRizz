/**
 * Überzug++ page composite: the visible page's tile thumbnails drawn into
 * ONE transparent image, so a page is one "add" instead of one per tile.
 *
 * The composite covers the union of the page's tile boxes (tileBox: inside
 * the selection frames, never the last row/column), at the terminal's cell
 * pixel size. Each thumbnail goes exactly where the per-tile path would put
 * it: the same fitImageInBox cell box, then aspect-fitted in pixels and
 * centered in that box. Everything outside the thumbnails is transparent,
 * so the selection frames and placeholders (terminal text) show through on
 * compositors that honour alpha (Wayland; X11 windows have no alpha, see
 * GalleryView).
 *
 * The cache key covers the page contents (each tile's thumbnail id, which
 * carries the wallpaper's path hash, mtime and size) and the layout
 * (pixel positions and sizes, which follow from cols/rows, tile size and
 * cell px), so a revisited page reuses its composite.
 */
import { fitImageInBox } from "./imageProtocol.js";

function fnv1a(str, seed = 0x811c9dc5) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** union of the tile boxes (cells): {x, y, columns, rows} */
export function compositeRegion(boxes) {
  const x0 = Math.min(...boxes.map((b) => b.x));
  const y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.columns));
  const y1 = Math.max(...boxes.map((b) => b.y + b.rows));
  return { x: x0, y: y0, columns: x1 - x0, rows: y1 - y0 };
}

/**
 * @param {object} o
 * @param {Array<{x:number,y:number,columns:number,rows:number}>} o.boxes -
 *   tile boxes of every tile on the page (ready or not: partial and full
 *   composites of a page share one region)
 * @param {Array<{i:number, src:string, id:string, width:number,
 *   height:number}>} o.tiles - tiles whose thumbnail is ready (index into
 *   boxes, thumbnail path, thumbnail id, its pixel size)
 * @param {{width:number,height:number}} o.cell - cell size in pixels
 * @returns {{region, width, height, items: Array<{src, id, w, h, x, y}>,
 *   key: string}}
 */
export function pageComposite({ boxes, tiles, cell }) {
  const region = compositeRegion(boxes);
  const cw = cell.width;
  const ch = cell.height;
  const items = [];
  for (const t of tiles) {
    const box = boxes[t.i];
    if (!box || !(t.width > 0 && t.height > 0)) continue;
    const fit = fitImageInBox(t.width, t.height, box.columns, box.rows, cw, ch);
    const boxW = fit.columns * cw;
    const boxH = fit.rows * ch;
    const s = Math.min(boxW / t.width, boxH / t.height);
    const w = Math.max(1, Math.round(t.width * s));
    const h = Math.max(1, Math.round(t.height * s));
    items.push({
      i: t.i,
      src: t.src,
      id: t.id,
      w,
      h,
      x: (box.x + fit.dx - region.x) * cw + Math.floor((boxW - w) / 2),
      y: (box.y + fit.dy - region.y) * ch + Math.floor((boxH - h) / 2),
    });
  }
  const width = region.columns * cw;
  const height = region.rows * ch;
  const sig = JSON.stringify([width, height, cw, ch, items.map((t) => [t.id, t.w, t.h, t.x, t.y])]);
  return { region, width, height, items, key: fnv1a(sig) + fnv1a(sig, 0x01000193) };
}

/**
 * How Überzug++ shows a grid page:
 *   "page" - one transparent composite per page (Wayland: the compositor
 *            blends the overlay's alpha, so the selection frames between
 *            tiles stay visible; one add per page instead of one per tile)
 *   "tile" - one overlay per tile (X11: ueberzugpp's X11 windows have no
 *            alpha channel, a transparent composite turns black and hides
 *            the frames; X11 needs no add pacing, so this stays fast)
 * WALLRIZZ_UEBERZUG_OVERLAY=page|tile overrides it.
 */
export function ueberzugOverlayMode(output, env = {}) {
  const forced = env.WALLRIZZ_UEBERZUG_OVERLAY;
  if (forced === "page" || forced === "tile") return forced;
  return output === "wayland" ? "page" : "tile";
}
