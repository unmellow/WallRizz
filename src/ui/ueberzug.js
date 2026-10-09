/**
 * Überzug++ driver (QuickJS runtime side), modelled on yazi's ueberzug
 * adapter: one `ueberzugpp layer --silent -o <x11|wayland>` child per
 * WallRizz run, fed newline separated JSON on a pipe:
 *
 *   {"action":"add","identifier":"wallrizz-tile-0","x":..,"y":..,"max_width":..,"max_height":..,"path":"<thumbnail>"}
 *   {"action":"remove","identifier":"wallrizz-tile-0"}
 *
 * Commands go through a paced queue: one command per write, and two "add"s
 * are always at least `spacingMs` apart (ueberzugpp's Wayland canvas aborts
 * on bursts of adds, see ueberzugSpacing() in imageProtocol.js). Queued adds
 * that were not sent yet can be cancelled (page change), so a stale page
 * never shows up late.
 *
 * Every identifier that was sent is tracked so all overlays can be removed
 * before a page change / fullscreen / resize and on exit. Closing the pipe
 * makes ueberzugpp exit (it stops on stdin EOF/HUP), so even if WallRizz is
 * SIGKILLed no overlay is left behind; on a normal exit or SIGINT/SIGTERM/
 * SIGHUP the process is also waited for and killed if it hangs.
 *
 * Death detection: the child is reaped (waitpid WNOHANG) before every write
 * and by a watchdog timer, a failed write (EPIPE) counts too, and so does a
 * pid that no longer exists. On death the layer reports once through
 * `onDeath(reason)`; the caller decides whether to restart or fall back.
 *
 * Window-up confirmation (`confirm`, Wayland page mode): whenUp(id) resolves
 * once the window of a sent add is on screen (see overlayWatch.js), so a
 * replaced overlay is only removed after its successor appeared. Windows
 * are matched to adds in order, which only works if every add gets its
 * window: a remove that reaches ueberzugpp before the window is mapped
 * means it never maps (no event), and every later add would be credited
 * the previous one's window. So, with confirmation, an overlay whose window
 * isn't up yet is not removed at once: it is "doomed", removed as soon as
 * its window is up (or timed out), and no add is sent meanwhile (at most
 * two overlays alive). Every add has its own timeout, so a doomed overlay
 * holds the next add back for at most HARD_TIMEOUT_MS, and one window that
 * never appears never delays the ones after it.
 */
import { OS, STD } from "../core/constants.js";
import { abortThumbnails } from "../wallpaper/thumbnails.js";
import {
  ueberzugAdd,
  ueberzugRemove,
  ueberzugSocketPath,
  ueberzugSpacing,
} from "./imageProtocol.js";
import { FALLBACK_MS, WindowWatch } from "./overlayWatch.js";

const live = new Set();
// Wayland: ueberzugpp 2.9.x commits a new window's surface on "add" but only
// flushes its Wayland connection when an event comes in, on a 100 ms poll
// timeout, or on "remove" (WaylandCanvas::remove_image). With the replaced
// overlay kept up until the new one is mapped, nothing else flushes, and
// the new window shows up to 100 ms late (sway: 110 ms instead of 35 ms for
// a page). So every add is followed by the remove of an identifier that
// never exists: a no-op that flushes.
export const FLUSH_ID = "wallrizz-flush";
let signalsInstalled = false;
let onSignalCleanup = null;

/** Stop every running layer (exit path, signals). */
export function stopAllUeberzug() {
  for (const layer of [...live]) layer.stop();
}

/**
 * Make sure overlays are cleaned up when WallRizz is killed by a signal.
 * `cleanup` restores the screen (cursor, alternate screen) before exiting.
 */
export function installUeberzugSignalHandlers(cleanup) {
  onSignalCleanup = cleanup ?? onSignalCleanup;
  if (signalsInstalled) return;
  signalsInstalled = true;
  // writing to a dead ueberzugpp must not kill WallRizz
  OS.signal(OS.SIGPIPE, undefined);
  for (const [sig, code] of [[OS.SIGINT, 130], [OS.SIGTERM, 143], [OS.SIGHUP, 129]]) {
    OS.signal(sig, () => {
      stopAllUeberzug();
      abortThumbnails();
      try {
        onSignalCleanup?.();
      } catch { /* ignore */ }
      STD.exit(code);
    });
  }
}

/** waitpid status -> short text */
function describeStatus(status) {
  const sig = status & 0x7f;
  if (sig) return `killed by signal ${sig}${sig === 6 ? " (SIGABRT)" : ""}`;
  return `exited with code ${(status >> 8) & 0xff}`;
}

export class UeberzugLayer {
  /**
   * @param {string} output - ueberzugpp -o value (x11, wayland, ...)
   * @param {object} [opts]
   * @param {string} [opts.bin] - ueberzugpp executable
   * @param {number} [opts.spacingMs] - min. pause between two adds
   * @param {number} [opts.gapMs] - min. pause between any two commands
   * @param {number} [opts.watchMs] - watchdog period (0 = off)
   * @param {(reason: string) => void} [opts.onDeath] - called once if the
   *   process dies (not after stop())
   * @param {boolean} [opts.noCache] - pass --no-cache: images are shown at
   *   their own size, so ueberzugpp must not keep resized copies in
   *   ~/.cache/ueberzugpp (page composites would pile up there, outside our
   *   cache cap) and not decode that copy again on every add
   * @param {boolean} [opts.confirm] - watch for the windows of adds
   *   (WindowWatch: sway IPC, hyprctl, or a FALLBACK_MS estimate)
   * @param {boolean} [opts.flushAdds] - follow every add with a no-op
   *   remove (FLUSH_ID); default: Wayland output
   */
  constructor(output, {
    bin = "ueberzugpp",
    spacingMs,
    gapMs = 2,
    watchMs = 200,
    onDeath = null,
    noCache = false,
    confirm = false,
    flushAdds = output === "wayland",
  } = {}) {
    this.output = output;
    this.bin = bin;
    this.spacingMs = spacingMs ?? ueberzugSpacing(output, STD.getenviron());
    this.gapMs = gapMs;
    this.watchMs = watchMs;
    this.noCache = noCache;
    this.onDeath = onDeath;
    this.pid = null;
    this.file = null;
    this.shown = new Set();
    this.queue = [];
    this.timer = null;
    this.watchTimer = null;
    this.lastAddAt = -Infinity;
    this.lastSentAt = -Infinity;
    this.dead = true;
    this.stopped = false;
    this.deathReason = null;
    this.sent = 0;
    this.confirm = confirm;
    this.flushAdds = flushAdds;
    this.windows = null; // WindowWatch
    this.upInfo = new Map(); // identifier -> { at, how }
    this.upWaiters = new Map(); // identifier -> [resolve]
    this.settled = false;
    this.doomed = new Set(); // removal deferred until the window is up
  }

  /** removes of unconfirmed windows are deferred (see the header) */
  defersRemoves() {
    return Boolean(this.windows) && this.windows.kind !== "none";
  }

  /** how windows are confirmed: "sway", "hyprland" or "none" */
  confirmKind() {
    return this.windows?.kind ?? "none";
  }

  /**
   * Spawn the layer and give it a moment to fail (no display, unsupported
   * compositor, missing libs...).
   * @param {number} [graceMs]
   * @returns {Promise<boolean>} true if it is running
   */
  async start(graceMs = 250) {
    if (!this.spawn()) return false;
    return await this.settle(graceMs);
  }

  /**
   * Spawn ueberzugpp without waiting (commands can be queued at once).
   * @returns {boolean} false if it could not be spawned at all
   */
  spawn() {
    installUeberzugSignalHandlers();
    // the watcher first: subscribed before ueberzugpp maps anything
    if (this.confirm) this.windows = new WindowWatch(() => this.pid);
    const fds = OS.pipe();
    if (!fds) return false;
    const [readFd, writeFd] = fds;
    const devNull = OS.open("/dev/null", OS.O_RDWR);
    try {
      // stdout/stderr -> /dev/null: ueberzugpp must never write into the
      // terminal (fd >= 3, incl. our pipe's write end, is closed in the child)
      this.pid = OS.exec([
        this.bin, "layer", "--silent", ...(this.noCache ? ["--no-cache"] : []),
        "-o", this.output,
      ], {
        block: false,
        usePath: true,
        stdin: readFd,
        stdout: devNull,
        stderr: devNull,
      });
    } catch {
      this.pid = null;
    }
    OS.close(readFd);
    if (devNull >= 0) OS.close(devNull);
    if (!this.pid || this.pid < 0) {
      this.pid = null;
      OS.close(writeFd);
      this.windows?.stop();
      this.windows = null;
      return false;
    }
    this.file = STD.fdopen(writeFd, "w");
    this.dead = false;
    live.add(this);
    return true;
  }

  /**
   * Give a spawned layer a moment to fail (no display, unsupported
   * compositor, missing libs...), then start the watchdog.
   * @returns {Promise<boolean>} true if it is running
   */
  async settle(graceMs = 250) {
    await OS.sleepAsync(graceMs);
    if (!this.alive()) {
      if (!this.stopped) this.stop();
      return false;
    }
    this.settled = true;
    this.watch();
    return true;
  }

  /** @returns {boolean} whether the ueberzugpp process is still running */
  alive() {
    if (this.dead || !this.pid) return false;
    const [ret, status] = OS.waitpid(this.pid, OS.WNOHANG);
    if (ret === this.pid) {
      this.died(describeStatus(status), true);
    } else if (ret < 0 && OS.kill(this.pid, 0) !== 0) {
      // not our child any more and no such process
      this.died("process gone", true);
    }
    return !this.dead;
  }

  /** Unix socket the layer listens on (for `ueberzugpp cmd -s`). */
  socketPath() {
    return this.pid ? ueberzugSocketPath(STD.getenviron(), this.pid) : null;
  }

  /** Watchdog: notice a crash even while nothing is being sent. */
  watch() {
    if (!this.watchMs || this.watchTimer || this.dead) return;
    this.watchTimer = OS.setTimeout(() => {
      this.watchTimer = null;
      if (this.alive()) this.watch();
    }, this.watchMs);
  }

  /**
   * Mark the layer dead, drop everything queued, reap the process and
   * report once (unless we stopped it ourselves).
   */
  died(reason, reaped = false) {
    if (this.dead && this.deathReason) return;
    this.dead = true;
    this.deathReason = reason;
    this.queue.length = 0;
    this.shown.clear();
    this.dropWindows();
    if (this.timer) OS.clearTimeout(this.timer);
    if (this.watchTimer) OS.clearTimeout(this.watchTimer);
    this.timer = this.watchTimer = null;
    live.delete(this);
    if (this.file) {
      try {
        this.file.close();
      } catch { /* ignore */ }
      this.file = null;
    }
    const pid = this.pid;
    this.pid = null;
    if (pid && !reaped) {
      // a write failed but the process may linger: make sure it goes away
      OS.kill(pid, OS.SIGKILL);
      for (let i = 0; i < 20; i++) {
        const [ret] = OS.waitpid(pid, OS.WNOHANG);
        if (ret === pid || ret < 0) break;
        OS.sleep(5);
      }
    }
    if (!this.stopped && this.onDeath) {
      const cb = this.onDeath;
      OS.setTimeout(() => cb(reason), 0);
    }
  }

  /** Write one command line now. */
  write(line) {
    if (this.dead || !this.file) return false;
    if (!this.alive()) return false;
    this.file.puts(line + "\n");
    this.file.flush();
    if (this.file.error()) {
      this.died("write failed (EPIPE)");
      return false;
    }
    this.sent++;
    this.lastSentAt = Date.now();
    return true;
  }

  /** Send queued commands, keeping the spacing. */
  pump() {
    if (this.timer || this.dead) return;
    while (this.queue.length) {
      const head = this.queue[0];
      // an add waits for deferred removals (pumped again when they're sent)
      if (head.action === "add" && this.doomed.size) return;
      const now = Date.now();
      let due = this.lastSentAt + this.gapMs;
      if (head.action === "add") due = Math.max(due, this.lastAddAt + this.spacingMs);
      if (due > now) {
        this.timer = OS.setTimeout(() => {
          this.timer = null;
          this.pump();
        }, due - now);
        return;
      }
      this.queue.shift();
      if (!this.write(head.line)) {
        this.settleWaiters(head.identifier, "dead");
        return;
      }
      if (head.action === "add") {
        this.lastAddAt = this.lastSentAt;
        this.shown.add(head.identifier);
        this.expectWindow(head.identifier);
        if (this.flushAdds && !this.write(ueberzugRemove(FLUSH_ID))) return;
      }
    }
  }

  /**
   * Show `path` at cell (x, y) (0-based), fit into width x height cells
   * (optional ueberzugpp scaler, e.g. "fit_contain"). Queued, see pump().
   */
  add(identifier, x, y, width, height, path, scaler) {
    if (this.dead) return;
    this.queue.push({
      action: "add",
      identifier,
      line: ueberzugAdd(identifier, x, y, width, height, path, scaler),
    });
    this.pump();
  }

  remove(identifier) {
    if (this.dead) return;
    const queued = this.queue.findIndex((c) =>
      c.action === "add" && c.identifier === identifier
    );
    if (queued >= 0) {
      this.queue.splice(queued, 1); // never sent: nothing to remove
      this.settleWaiters(identifier, "cancelled");
    }
    if (!this.shown.delete(identifier)) return;
    const info = this.upInfo.get(identifier);
    if (info?.how === "timeout") this.windows?.removedUnseen(identifier);
    if (!this.upInfo.delete(identifier)) {
      // removed before its window was confirmed
      this.settleWaiters(identifier, "removed");
      if (this.defersRemoves()) {
        this.doomed.add(identifier); // see expectWindow
        return;
      }
      this.windows?.forget(identifier);
    }
    this.queue.push({ action: "remove", identifier, line: ueberzugRemove(identifier) });
    this.pump();
  }

  /** Drop adds that were queued but not sent yet (stale page). */
  cancelPending() {
    for (const c of this.queue) {
      if (c.action === "add") this.settleWaiters(c.identifier, "cancelled");
    }
    this.queue = this.queue.filter((c) => c.action !== "add");
  }

  /** an add was written: find out when its window is up */
  expectWindow(identifier) {
    const up = (how) => {
      if (this.doomed.delete(identifier)) {
        // removed meanwhile: now it can go (adds held back follow)
        if (this.dead) return;
        if (how === "timeout") this.windows?.removedUnseen(identifier);
        this.queue.unshift({ action: "remove", identifier, line: ueberzugRemove(identifier) });
        this.pump();
        return;
      }
      if (!this.shown.has(identifier) || this.upInfo.has(identifier)) return;
      const info = { at: Date.now(), how };
      this.upInfo.set(identifier, info);
      this.settleWaiters(identifier, how, info.at);
    };
    if (this.windows) this.windows.sent(identifier, up);
    else OS.setTimeout(() => up("fallback"), FALLBACK_MS);
  }

  settleWaiters(identifier, how, at = Date.now()) {
    const waiters = this.upWaiters.get(identifier);
    if (!waiters) return;
    this.upWaiters.delete(identifier);
    for (const resolve of waiters) resolve({ how, at });
  }

  /** resolve every waiter (death / stop), stop the watcher */
  dropWindows() {
    for (const identifier of [...this.upWaiters.keys()]) this.settleWaiters(identifier, "dead");
    this.upInfo.clear();
    this.doomed.clear();
    this.windows?.stop();
    this.windows = null;
  }

  /**
   * Resolves with { how, at } once the window of add `identifier` is up:
   * how = "mapped" (confirmed), "timeout" (HARD_TIMEOUT_MS without a
   * confirmation), "fallback" (no confirmation possible, assumed up after
   * FALLBACK_MS); or, if it never will be: "cancelled"
   * (dropped before it was sent), "removed", "dead", "gone" (unknown id).
   * @returns {Promise<{how: string, at: number}>}
   */
  whenUp(identifier) {
    const info = this.upInfo.get(identifier);
    if (info) return Promise.resolve(info);
    const queued = this.queue.some((c) => c.action === "add" && c.identifier === identifier);
    if (this.dead || (!queued && !this.shown.has(identifier))) {
      return Promise.resolve({ how: "gone", at: Date.now() });
    }
    return new Promise((resolve) => {
      const list = this.upWaiters.get(identifier) ?? [];
      list.push(resolve);
      this.upWaiters.set(identifier, list);
    });
  }

  /** @returns {boolean} the window of `identifier` is known to be up */
  isUp(identifier) {
    return this.upInfo.has(identifier);
  }

  /** Cancel queued adds and remove every overlay that was shown. */
  removeAll() {
    this.cancelPending();
    for (const identifier of [...this.shown]) this.remove(identifier);
  }

  /** @returns {number} commands waiting in the queue */
  pending() {
    return this.queue.length;
  }

  /** Resolves when the queue is empty (or the layer is dead). */
  async idle() {
    while (this.queue.length && !this.dead) await OS.sleepAsync(5);
  }

  /**
   * Remove all overlays, close the pipe (ueberzugpp exits on EOF) and reap
   * the process; SIGTERM, then SIGKILL, if it doesn't go away.
   */
  stop() {
    this.stopped = true;
    live.delete(this);
    if (this.timer) OS.clearTimeout(this.timer);
    if (this.watchTimer) OS.clearTimeout(this.watchTimer);
    this.timer = this.watchTimer = null;
    this.cancelPending();
    if (this.file) {
      try {
        // exiting: pending removes and the removal of what is shown are
        // written right away (no new window is mapped, nothing to pace)
        for (const c of this.queue) this.file.puts(c.line + "\n");
        for (const identifier of [...this.shown, ...this.doomed]) {
          this.file.puts(ueberzugRemove(identifier) + "\n");
        }
        this.file.flush();
        this.file.close();
      } catch { /* ignore */ }
      this.file = null;
    }
    this.queue.length = 0;
    this.shown.clear();
    this.dropWindows();
    const pid = this.pid;
    this.pid = null;
    this.dead = true;
    if (!pid) return;
    const reaped = (ms) => {
      for (let waited = 0; waited <= ms; waited += 10) {
        const [ret] = OS.waitpid(pid, OS.WNOHANG);
        if (ret === pid || ret < 0) return true;
        OS.sleep(10);
      }
      return false;
    };
    // (bounded: quitting must stay fast even while ueberzugpp is busy
    // starting up or loading an image)
    if (reaped(80)) return;
    OS.kill(pid, OS.SIGTERM);
    if (reaped(80)) return;
    OS.kill(pid, OS.SIGKILL);
    reaped(50);
  }
}
