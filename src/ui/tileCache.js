/**
 * Encoded image tiles for the non-kitty protocols (iterm, sixel, symbols).
 *
 * - Always encodes from the small cached thumbnail, never the wallpaper.
 * - Caches the encoded output in memory (LRU) and on disk under
 *   ~/.cache/WallRizz/tiles/, keyed by thumbnail id + thumbnail mtime/size +
 *   protocol + cell box (+ cell pixel size for sixel) + encoder options +
 *   chafa version, so revisiting a page or relaunching never re-encodes.
 * - Encodes in parallel with a bounded, two-priority queue (visible tiles
 *   before prefetch) whose pending work can be dropped on page change.
 *
 * iTerm2 inline images are not produced by chafa: chafa's iterm encoder
 * sends an *uncompressed* TIFF (~1.6 MB per tile at 2x HiDPI), which is what
 * made WezTerm slow. Instead the thumbnail is re-encoded once as a JPEG and
 * sent with width/height in cells and preserveAspectRatio=1.
 */
import { OS, STD, HOME_DIR, execAsync } from "../core/constants.js";
import { ensureDir } from "../core/utils/io.js";
import { buildChafaArgs, chafaFeatures, renderWithChafaArgs } from "./terminalImage.js";

export const TILE_CACHE_DIR = HOME_DIR + "/.cache/WallRizz/tiles/v1/";
const MEMORY_LIMIT = 256;
const JPEG_QUALITY = 85;

/** 32-bit FNV-1a as 8 hex chars */
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
/** base64 of a Uint8Array */
export function base64Bytes(bytes) {
  const out = [];
  let chunk = "";
  const n = bytes.length;
  let i = 0;
  for (; i + 2 < n; i += 3) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    chunk += B64[v >> 18] + B64[(v >> 12) & 63] + B64[(v >> 6) & 63] + B64[v & 63];
    if (chunk.length >= 8192) {
      out.push(chunk);
      chunk = "";
    }
  }
  if (i < n) {
    const a = bytes[i], b = i + 1 < n ? bytes[i + 1] : 0;
    const v = (a << 16) | (b << 8);
    chunk += B64[v >> 18] + B64[(v >> 12) & 63] +
      (i + 1 < n ? B64[(v >> 6) & 63] : "=") + "=";
  }
  out.push(chunk);
  return out.join("");
}

function readBytes(path) {
  const f = STD.open(path, "rb");
  if (!f) return null;
  f.seek(0, STD.SEEK_END);
  const size = f.tell();
  f.seek(0, STD.SEEK_SET);
  const bytes = new Uint8Array(size);
  f.read(bytes.buffer, 0, size);
  f.close();
  return bytes;
}

function writeAtomic(path, content) {
  const tmp = `${path}.${Date.now()}${Math.floor(Math.random() * 1e6)}.tmp`;
  const f = STD.open(tmp, "w");
  if (!f) return;
  f.puts(content);
  f.close();
  OS.rename(tmp, path);
}

/**
 * iTerm2 inline image escape for a base64 payload. columns x rows must
 * already be the image's own aspect-fitted cell box (see fitImageInBox):
 * WezTerm only honours the width when preserveAspectRatio=1, iTerm2 fits
 * into both. doNotMoveCursor=1 is a WezTerm extension (ignored elsewhere).
 */
export function itermEscape(b64, byteSize, columns, rows) {
  return `\x1b]1337;File=inline=1;size=${byteSize};width=${columns};height=${rows};preserveAspectRatio=1;doNotMoveCursor=1:${b64}\x07`;
}

/**
 * Encode an image file as JPEG (optionally downscaled) and return the
 * iTerm2 payload {b64, size}. Used for tiles (thumbnail) and fullscreen.
 */
export async function encodeJpegPayload(srcPath, tmpPath, maxEdge) {
  const args = ["magick", srcPath, "-strip"];
  if (maxEdge) args.push("-resize", `${maxEdge}x${maxEdge}>`);
  args.push("-quality", String(JPEG_QUALITY), `jpeg:${tmpPath}`);
  await execAsync(args);
  const bytes = readBytes(tmpPath);
  OS.remove(tmpPath);
  if (!bytes) throw new Error(`failed to read ${tmpPath}`);
  return { b64: base64Bytes(bytes), size: bytes.length };
}

/** Bounded queue with a high (visible) and a low (prefetch) lane. */
export class Limiter {
  constructor(limit) {
    this.limit = Math.max(1, limit | 0);
    this.active = 0;
    this.high = [];
    this.low = [];
  }

  schedule(fn, { low = false, onCancel } = {}) {
    return new Promise((resolve, reject) => {
      (low ? this.low : this.high).push({ fn, resolve, reject, onCancel });
      this.pump();
    });
  }

  /** Drop everything not started yet; their promises resolve to null. */
  cancelPending() {
    const pending = [...this.high, ...this.low];
    this.high = [];
    this.low = [];
    for (const t of pending) {
      t.onCancel?.();
      t.resolve(null);
    }
  }

  pump() {
    while (this.active < this.limit && (this.high.length || this.low.length)) {
      const t = this.high.length ? this.high.shift() : this.low.shift();
      this.active++;
      Promise.resolve()
        .then(t.fn)
        .then(t.resolve, t.reject)
        .finally(() => {
          this.active--;
          this.pump();
        });
    }
  }
}

export class TileCache {
  /**
   * @param {object} o
   * @param {string} o.protocol - iterm | sixel | symbols
   * @param {string} [o.cellPx] - "WxH" cell size in pixels (sixel cache key)
   * @param {number} [o.limit] - max parallel encoders
   */
  constructor({ protocol, cellPx, limit }) {
    this.protocol = protocol;
    this.cellPx = cellPx || "?";
    this.limiter = new Limiter(limit || 4);
    this.memory = new Map();
    this.inflight = new Map();
    this.dir = TILE_CACHE_DIR + protocol + "/";
    ensureDir(this.dir);
    // everything that changes the encoded bytes besides the image and box
    this.encoderId = protocol === "iterm"
      ? `jpeg-q${JPEG_QUALITY}`
      : `${buildChafaArgs(protocol, 1, 1).join(" ")}|chafa-${chafaFeatures()?.version}` +
        (protocol === "sixel" ? `|px-${this.cellPx}` : "");
    this.stats = { memory: 0, disk: 0, encoded: 0 };
  }

  thumbInfo(thumbPath) {
    const [st, err] = OS.stat(thumbPath);
    return err === 0 ? `${st.mtime}-${st.size}` : "missing";
  }

  key(thumbPath, columns, rows) {
    const id = thumbPath.split("/").at(-1).replace(/\.[^.]+$/, "");
    const info = this.thumbInfo(thumbPath);
    if (this.protocol === "iterm") {
      // the JPEG payload is independent of the cell box
      const hash = fnv1a(`${thumbPath}|${info}|${this.encoderId}`);
      return { mem: `${id}-${hash}`, disk: `${this.dir}${id}-${hash}.b64` };
    }
    const hash = fnv1a(`${thumbPath}|${info}|${this.encoderId}|${columns}x${rows}`);
    const name = `${id}-${columns}x${rows}-${hash}`;
    return { mem: name, disk: `${this.dir}${name}.out` };
  }

  remember(k, value) {
    this.memory.delete(k);
    this.memory.set(k, value);
    if (this.memory.size > MEMORY_LIMIT) {
      this.memory.delete(this.memory.keys().next().value);
    }
  }

  finish(value, columns, rows) {
    if (this.protocol !== "iterm") return value;
    const nl = value.indexOf("\n");
    const size = Number(value.slice(0, nl));
    return itermEscape(value.slice(nl + 1), size, columns, rows);
  }

  /** Cached output (memory, then disk) or null. Synchronous. */
  peek(thumbPath, columns, rows) {
    const k = this.key(thumbPath, columns, rows);
    let value = this.memory.get(k.mem);
    if (value !== undefined) {
      this.stats.memory++;
      return this.finish(value, columns, rows);
    }
    value = STD.loadFile(k.disk);
    if (value !== null && value !== undefined && value.length) {
      this.stats.disk++;
      this.remember(k.mem, value);
      return this.finish(value, columns, rows);
    }
    return null;
  }

  async encode(thumbPath, columns, rows, k) {
    let value;
    if (this.protocol === "iterm") {
      const { b64, size } = await encodeJpegPayload(thumbPath, `${k.disk}.jpg`);
      value = `${size}\n${b64}`;
    } else {
      value = await renderWithChafaArgs(
        [...buildChafaArgs(this.protocol, columns, rows), thumbPath],
      );
    }
    writeAtomic(k.disk, value);
    this.remember(k.mem, value);
    this.stats.encoded++;
    return value;
  }

  /**
   * Encoded tile, from cache or freshly encoded in the bounded queue.
   * Resolves to null if the request was cancelled before it started.
   */
  async get(thumbPath, columns, rows, { low = false } = {}) {
    const hit = this.peek(thumbPath, columns, rows);
    if (hit !== null) return hit;
    const k = this.key(thumbPath, columns, rows);
    let p = this.inflight.get(k.mem);
    if (!p) {
      p = this.limiter.schedule(
        () => this.encode(thumbPath, columns, rows, k),
        { low, onCancel: () => this.inflight.delete(k.mem) },
      ).finally(() => {
        if (this.inflight.get(k.mem) === p) this.inflight.delete(k.mem);
      });
      this.inflight.set(k.mem, p);
    }
    const value = await p;
    return value === null ? null : this.finish(value, columns, rows);
  }

  cancelPending() {
    this.limiter.cancelPending();
  }
}
