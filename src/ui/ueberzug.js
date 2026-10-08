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
 */
import { OS, STD } from "../core/constants.js";
import { abortThumbnails } from "../wallpaper/thumbnails.js";
import {
  ueberzugAdd,
  ueberzugRemove,
  ueberzugSocketPath,
  ueberzugSpacing,
} from "./imageProtocol.js";

const live = new Set();
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
   */
  constructor(output, {
    bin = "ueberzugpp",
    spacingMs,
    gapMs = 2,
    watchMs = 200,
    onDeath = null,
  } = {}) {
    this.output = output;
    this.bin = bin;
    this.spacingMs = spacingMs ?? ueberzugSpacing(output, STD.getenviron());
    this.gapMs = gapMs;
    this.watchMs = watchMs;
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
  }

  /**
   * Spawn the layer and give it a moment to fail (no display, unsupported
   * compositor, missing libs...).
   * @param {number} [graceMs]
   * @returns {Promise<boolean>} true if it is running
   */
  async start(graceMs = 250) {
    installUeberzugSignalHandlers();
    const fds = OS.pipe();
    if (!fds) return false;
    const [readFd, writeFd] = fds;
    const devNull = OS.open("/dev/null", OS.O_RDWR);
    try {
      // stdout/stderr -> /dev/null: ueberzugpp must never write into the
      // terminal (fd >= 3, incl. our pipe's write end, is closed in the child)
      this.pid = OS.exec([this.bin, "layer", "--silent", "-o", this.output], {
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
      return false;
    }
    this.file = STD.fdopen(writeFd, "w");
    this.dead = false;
    live.add(this);
    await OS.sleepAsync(graceMs);
    if (!this.alive()) {
      this.stop();
      return false;
    }
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
      if (!this.write(head.line)) return;
      if (head.action === "add") {
        this.lastAddAt = this.lastSentAt;
        this.shown.add(head.identifier);
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
    if (queued >= 0) this.queue.splice(queued, 1); // never sent: nothing to remove
    if (!this.shown.delete(identifier)) return;
    this.queue.push({ action: "remove", identifier, line: ueberzugRemove(identifier) });
    this.pump();
  }

  /** Drop adds that were queued but not sent yet (stale page). */
  cancelPending() {
    this.queue = this.queue.filter((c) => c.action !== "add");
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
        for (const identifier of this.shown) {
          this.file.puts(ueberzugRemove(identifier) + "\n");
        }
        this.file.flush();
        this.file.close();
      } catch { /* ignore */ }
      this.file = null;
    }
    this.queue.length = 0;
    this.shown.clear();
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
    if (reaped(300)) return;
    OS.kill(pid, OS.SIGTERM);
    if (reaped(300)) return;
    OS.kill(pid, OS.SIGKILL);
    reaped(100);
  }
}
