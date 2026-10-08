/**
 * Thumbnails, generated off the UI thread.
 *
 * Ideas taken from yazi's preloader (yazi-scheduler, yazi-plugin image /
 * magick), adapted to QuickJS and written from scratch:
 *   - a small pool of os.Worker threads (yazi: preload_workers), each
 *     running one magick invocation per batch, with ImageMagick's
 *     decode-at-smaller-size for JPEGs and -limit thread 1 (yazi's magick
 *     preloader also runs magick with -limit thread 1);
 *   - two lanes: the visible page is generated before anything else; the
 *     neighbouring pages are only queued once it is done (yazi: high/low
 *     task priority, preload window page-1..page+1);
 *   - a ticket per page draw: queued work of an older ticket is dropped and
 *     a result of an older ticket is never reported, so it is never drawn
 *     (yazi drops a stale preview by aborting it when the cursor moves);
 *   - the cache name is path + mtime + size (+ thumbnail size), so an
 *     edited wallpaper gets a new thumbnail (yazi: FileSig, the url plus a
 *     stat signature hashed into the cache file name).
 *
 * Every magick process (thumbnails here, iTerm2 tile JPEGs, fullscreen and
 * colour extraction) takes a slot of `magickSlots`, whose cap is -x, so no
 * more than -x run at once.
 *
 * The same workers also make the Überzug++ page composites (composite():
 * one magick per composite, high lane at the front so the visible page
 * never waits behind thumbnails; prefetched neighbours on the low lane; a
 * partial composite can build on the previous one, `base`), and
 * startCacheCleanup() runs the startup cache cleanup (cacheCleanup.js) on a
 * worker of its own, after the first page.
 *
 * Writes go to a temp name and are renamed into place, so a killed process
 * never leaves a half-written thumbnail.
 */
import { OS, STD } from "../core/constants.js";
import { COMPOSITE_DIR, PIC_DIR } from "../core/cachePaths.js";
import { ensureDir } from "../core/utils/io.js";

export const PIC_CACHE_DIR = PIC_DIR;
// images per magick invocation (measured on 4K JPEGs: batches of 3 beat
// one process per image by ~10-15%; bigger batches make a stale batch, which
// a page flip has to wait for, take longer)
export const THUMB_BATCH = 3;
// jpeg:size hint: decode JPEGs at about twice the thumbnail size (the
// libjpeg DCT scaling; measured ~2x faster than a full-size decode)
const JPEG_SIZE_FACTOR = 2;

/** Default pool size: min(4, CPUs), at least 1. -x overrides it. */
export function defaultPoolSize() {
  let cpus = 0;
  try {
    const [names] = OS.readdir("/sys/devices/system/cpu");
    cpus = (names ?? []).filter((n) => /^cpu\d+$/.test(n)).length;
  } catch { /* ignore */ }
  if (!cpus) cpus = 4;
  return Math.max(1, Math.min(4, cpus));
}

/** "600x338" -> { w, h } */
export function parseSize(size) {
  const m = /^(\d+)x(\d+)$/.exec(String(size ?? ""));
  return m ? { w: Number(m[1]), h: Number(m[2]) } : { w: 600, h: 338 };
}

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * Thumbnail file name: readable base name, a hash of the full path, and the
 * file's mtime and size, plus the thumbnail size. Changed content (new
 * mtime or size) never reuses an old thumbnail; a touch only regenerates.
 * @param {string} src - full path of the wallpaper
 * @param {{mtime:number,size:number}} st - its stat
 */
export function thumbName(src, st, size) {
  const base = src.split("/").at(-1).replace(/\.[^.]*$/, "")
    .replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 60);
  return `${base}-${fnv1a(src)}-${Math.floor(st.mtime)}-${st.size}-${size}.png`;
}

/** @returns {string|null} cache path for `src`, null if it can't be stat-ed */
export function thumbPath(src, size) {
  const [st, err] = OS.stat(src);
  if (err !== 0) return null;
  return PIC_CACHE_DIR + thumbName(src, st, size);
}

/**
 * Counting semaphore for magick processes. acquire() waiters are served
 * before the thumbnail pool's queue (they are visible tile encodes,
 * fullscreen or a selection).
 */
export const magickSlots = {
  cap: Infinity,
  used: 0,
  peak: 0,
  waiters: [],
  listeners: new Map(), // pump function -> urgent (urgent ones pump first)
  setCap(n) {
    this.cap = Math.max(1, n | 0);
  },
  tryAcquire() {
    if (this.used >= this.cap || this.waiters.length) return false;
    this.used++;
    this.peak = Math.max(this.peak, this.used);
    return true;
  },
  acquire() {
    if (this.used < this.cap && !this.waiters.length) {
      this.used++;
      this.peak = Math.max(this.peak, this.used);
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  },
  release() {
    const next = this.waiters.shift();
    if (next) {
      next(); // the slot passes straight on
      return;
    }
    this.used = Math.max(0, this.used - 1);
    for (const urgent of [true, false]) {
      for (const [fn, u] of this.listeners) if (u === urgent) fn();
    }
  },
  /** Run `fn` (which starts one magick) holding a slot. */
  async run(fn) {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  },
};

const livePools = new Set();
let workerSerial = 0; // temp names are unique across pools

/**
 * @param {object} o
 * @param {string} o.size - thumbnail size, "WxH"
 * @param {number} o.poolSize - worker threads
 * @param {boolean} [o.urgent] - gets a freed magick slot before other pools
 *   (a selected wallpaper whose thumbnail is needed now)
 */
export class ThumbPool {
  constructor({ size, poolSize, urgent = false }) {
    this.size = size;
    this.poolSize = Math.max(1, poolSize | 0);
    this.generation = 0;
    this.high = [];
    this.low = [];
    this.workers = [];
    this.idle = [];
    this.busy = new Map(); // worker -> batch (entries)
    this.pids = new Map(); // worker -> pid of its running magick
    this.entries = new Map(); // dest -> entry (queued or running)
    this.stats = { batches: 0, images: 0, stale: 0, composites: 0 };
    this.stopped = false;
    this.pumpTimer = null;
    this.onFree = () => this.pump();
    magickSlots.listeners.set(this.onFree, urgent);
    livePools.add(this);
    ensureDir(PIC_CACHE_DIR);
  }

  /** New ticket: queued work of older tickets is dropped (resolves null). */
  bump() {
    this.generation++;
    if (this.pumpTimer) { OS.clearTimeout(this.pumpTimer); this.pumpTimer = null; }
    const dropped = [...this.high, ...this.low];
    this.high = [];
    this.low = [];
    for (const e of dropped) {
      this.entries.delete(e.dest);
      for (const w of e.waiters) w(null);
    }
    return this.generation;
  }

  /**
   * Make sure the thumbnail of `src` exists. Resolves to its path, or null
   * when the request was dropped / is stale (older ticket) or magick failed.
   * @param {boolean} [low] - prefetch: only runs when nothing visible is queued
   */
  request(src, generation, { low = false } = {}) {
    if (this.stopped) return Promise.resolve(null);
    const dest = thumbPath(src, this.size);
    if (!dest) return Promise.resolve(null);
    const [, err] = OS.stat(dest);
    if (err === 0) return Promise.resolve(dest);
    return new Promise((resolve) => {
      const e = this.entries.get(dest);
      if (e) {
        // already queued or running: share it, under the newest ticket
        e.generation = Math.max(e.generation, generation);
        e.waiters.push(resolve);
        if (!low && e.low && !e.running) {
          this.low.splice(this.low.indexOf(e), 1);
          e.low = false;
          this.high.push(e);
        }
        return;
      }
      const entry = { src, dest, generation, low, waiters: [resolve], running: false };
      this.entries.set(dest, entry);
      (low ? this.low : this.high).push(entry);
      // one turn later: the caller queues the whole page first, so a batch
      // is full instead of one image per magick
      if (!this.pumpTimer) {
        this.pumpTimer = OS.setTimeout(() => {
          this.pumpTimer = null;
          this.pump();
        }, 0);
      }
    });
  }

  /**
   * Make sure the Überzug++ page composite `spec.dest` exists (see
   * ui/pageComposite.js). Same queue, lanes, tickets and magick cap as the
   * thumbnails; a composite is one magick on its own. A finished full
   * composite is cached: the list of thumbnail ids it was made from is
   * written next to it (<name>.txt) for the cache cleanup.
   * @param {{dest: string, width: number, height: number, items: Array,
   *   partial?: boolean}} spec
   * @returns {Promise<string|null>} the composite path, null if dropped,
   *   stale or failed
   */
  composite(spec, generation, { low = false } = {}) {
    if (this.stopped || !spec.items.length) return Promise.resolve(null);
    const dest = spec.dest;
    if (OS.stat(dest)[1] === 0) return Promise.resolve(dest);
    return new Promise((resolve) => {
      const e = this.entries.get(dest);
      if (e) {
        e.generation = Math.max(e.generation, generation);
        e.waiters.push(resolve);
        if (!low && e.low && !e.running) {
          this.low.splice(this.low.indexOf(e), 1);
          e.low = false;
          this.high.push(e);
        }
        return;
      }
      ensureDir(COMPOSITE_DIR);
      if (!spec.partial) {
        writeSmallAtomic(dest.replace(/\.png$/, ".txt"), spec.items.map((t) => t.id).join("\n") + "\n");
      }
      const entry = { kind: "composite", spec, dest, generation, low, waiters: [resolve], running: false };
      this.entries.set(dest, entry);
      // the visible page's composite is what the user is waiting for: it
      // goes before the thumbnails still queued (prefetch ones go last)
      if (low) this.low.push(entry);
      else this.high.unshift(entry);
      if (!this.pumpTimer) {
        this.pumpTimer = OS.setTimeout(() => {
          this.pumpTimer = null;
          this.pump();
        }, 0);
      }
    });
  }

  /** Requests still queued or running (any ticket). */
  get pending() {
    return this.entries.size;
  }

  pump() {
    if (this.stopped) return;
    this.startWorkers();
    while (this.idle.length && (this.high.length || this.low.length)) {
      if (!magickSlots.tryAcquire()) return; // freed slots call pump again
      const lane = this.high.length ? this.high : this.low;
      // a composite runs alone; thumbnails go in batches (up to the next
      // composite in the lane)
      let n = 1;
      if (lane[0].kind !== "composite") {
        while (n < THUMB_BATCH && n < lane.length && lane[n].kind !== "composite") n++;
      }
      const batch = lane.splice(0, n);
      const worker = this.idle.pop();
      this.busy.set(worker, batch);
      const { w, h } = parseSize(this.size);
      for (const e of batch) {
        e.running = true;
        e.tmp = `${e.dest}.${worker.tag}.tmp`;
      }
      if (batch[0].kind === "composite") {
        const e = batch[0];
        this.stats.composites++;
        worker.postMessage({
          type: "composite",
          spec: {
            width: e.spec.width,
            height: e.spec.height,
            base: e.spec.base ?? null,
            items: e.spec.draw ?? e.spec.items,
          },
          tmp: e.tmp,
          dest: e.dest,
        });
        continue;
      }
      this.stats.batches++;
      worker.postMessage({
        type: "batch",
        jpegSize: `${w * JPEG_SIZE_FACTOR}x${h * JPEG_SIZE_FACTOR}`,
        items: batch.map((e) => ({
          src: e.src,
          tmp: e.tmp,
          dest: e.dest,
          size: `${w}x${h}>`,
        })),
      });
    }
  }

  startWorkers() {
    while (this.workers.length < this.poolSize && (this.high.length || this.low.length)) {
      let worker;
      try {
        worker = new OS.Worker("wallpaper/thumbWorker.js");
      } catch {
        return; // no workers: the frames stay empty
      }
      worker.tag = `${OS.getpid?.() ?? 0}-${workerSerial++}`;
      this.workers.push(worker);
      this.idle.push(worker);
      worker.onmessage = (e) => this.onWorkerMessage(worker, e.data);
    }
  }

  onWorkerMessage(worker, msg) {
    if (msg?.type === "pid") {
      // the magick this worker just started (killed on shutdown)
      if (this.busy.has(worker)) this.pids.set(worker, msg.pid);
      return;
    }
    if (msg?.type !== "done") return;
    const batch = this.busy.get(worker) ?? [];
    this.busy.delete(worker);
    this.pids.delete(worker);
    const ok = new Map((msg.results ?? []).map((r) => [r.dest, r.ok]));
    for (const e of batch) {
      this.entries.delete(e.dest);
      const made = ok.get(e.dest) === true;
      if (made) this.stats.images++;
      // an older ticket's result is never reported (so never drawn); the
      // thumbnail is on disk for the next visit anyway
      const current = e.generation === this.generation;
      if (made && !current) this.stats.stale++;
      for (const w of e.waiters) w(made && current ? e.dest : null);
    }
    if (this.stopped) return;
    this.idle.push(worker);
    magickSlots.release(); // may pump
    this.pump();
  }

  /** Temp files of batches still running. */
  runningTemps() {
    return [...this.busy.values()].flat().map((e) => e.tmp).filter(Boolean);
  }

  /**
   * Stop: drop queued work, kill running magick, wait (briefly) for the
   * workers to report back, remove temp files, let the threads end.
   */
  async shutdown(timeoutMs = 2000) {
    if (this.stopped) return;
    this.bump();
    this.stopped = true;
    const until = Date.now() + timeoutMs;
    while (this.busy.size && Date.now() < until) {
      this.killRunning();
      await new Promise((r) => OS.setTimeout(r, 15));
    }
    this.finish();
  }

  /** SIGKILL the magick processes this pool's workers started (recorded pids). */
  killRunning() {
    for (const pid of this.pids.values()) OS.kill(pid, 9);
  }

  /** Synchronous part of the shutdown (signal handlers). */
  finish() {
    this.stopped = true;
    this.killRunning();
    for (const tmp of this.runningTemps()) OS.remove(tmp);
    for (const worker of this.workers) {
      try { worker.postMessage({ type: "stop" }); } catch { /* gone */ }
      worker.onmessage = null;
    }
    for (let i = 0; i < this.busy.size; i++) magickSlots.release();
    this.workers = [];
    this.idle = [];
    this.busy.clear();
    this.pids.clear();
    magickSlots.listeners.delete(this.onFree);
    livePools.delete(this);
  }
}

/** small file, written to a temp name (with our pid) and renamed */
function writeSmallAtomic(path, content) {
  const tmp = `${path}.${OS.getpid?.() ?? 0}-${Date.now()}.tmp`;
  const f = STD.open(tmp, "w");
  if (!f) return false;
  f.puts(content);
  f.close();
  if (OS.rename(tmp, path) === 0) return true;
  OS.remove(tmp);
  return false;
}

/**
 * Startup cache cleanup in a worker thread of its own (same worker
 * module as the pool; no magick, so no magick slot). It never blocks the
 * UI; quitting doesn't wait for it.
 * @param {object} options - see cleanupCache() in cacheCleanup.js
 * @returns {{done: Promise<object|null>, stop: () => void}}
 */
export function startCacheCleanup(options) {
  let worker = null;
  let finish = null;
  const done = new Promise((resolve) => (finish = resolve));
  try {
    worker = new OS.Worker("wallpaper/thumbWorker.js");
  } catch {
    finish(null);
    return { done, stop: () => {} };
  }
  worker.onmessage = (e) => {
    if (e.data?.type !== "cleaned") return;
    worker.onmessage = null;
    finish(e.data.report);
  };
  worker.postMessage({ type: "cleanup", options });
  return {
    done,
    // the event loop stops waiting for it (the thread ends with the process)
    stop: () => {
      if (worker.onmessage) {
        worker.onmessage = null;
        finish(null);
      }
    },
  };
}

/**
 * One thumbnail, now (selection of a wallpaper whose thumbnail isn't made
 * yet: its palette is computed from the thumbnail, not the 4K original).
 * @returns {Promise<string|null>} its path
 */
export async function makeThumbnail(src, size) {
  const dest = thumbPath(src, size);
  if (!dest || OS.stat(dest)[1] === 0) return dest;
  const pool = new ThumbPool({ size, poolSize: 1, urgent: true });
  try {
    return await pool.request(src, pool.generation);
  } finally {
    await pool.shutdown();
  }
}

/**
 * Kill this process's own magick / chafa children started from the main
 * thread (tile encodes, fullscreen; the thumbnail workers' magick pids are
 * recorded and killed by the pool), so quitting, Ctrl+C, SIGTERM or SIGHUP
 * never leaves one running. Only direct children of this very process are
 * touched (parent pid = ours, found through /proc; elsewhere a no-op).
 */
export function killMagickChildren() {
  let names = [];
  try { names = OS.readdir("/proc")[0] ?? []; } catch { names = []; }
  const me = OS.getpid?.() ?? Number(OS.readlink("/proc/self")[0]);
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    const stat = STD.loadFile(`/proc/${pid}/stat`);
    if (!stat) continue;
    const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    if (ppid !== me) continue;
    const cmd = (STD.loadFile(`/proc/${pid}/cmdline`) ?? "").split("\0")[0];
    if (/(^|\/)(magick|convert|chafa)$/.test(cmd)) OS.kill(pid, 9);
  }
}

/** Signal path: kill children, remove temps, stop every pool (sync). */
export function abortThumbnails() {
  for (const pool of [...livePools]) pool.finish();
  killMagickChildren();
}
