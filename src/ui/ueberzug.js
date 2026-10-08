/**
 * Überzug++ driver (QuickJS runtime side), modelled on yazi's ueberzug
 * adapter: one `ueberzugpp layer --silent -o <x11|wayland>` child per
 * WallRizz run, fed newline separated JSON on a pipe:
 *
 *   {"action":"add","identifier":"wallrizz-tile-0","x":..,"y":..,"max_width":..,"max_height":..,"path":"<thumbnail>"}
 *   {"action":"remove","identifier":"wallrizz-tile-0"}
 *
 * Every identifier that was added is tracked so all overlays can be removed
 * before a page change / fullscreen / resize and on exit. Closing the pipe
 * makes ueberzugpp exit (it stops on stdin EOF/HUP), so even if WallRizz is
 * SIGKILLed no overlay is left behind; on a normal exit or SIGINT/SIGTERM/
 * SIGHUP the process is also waited for and killed if it hangs.
 */
import { OS, STD } from "../core/constants.js";
import { ueberzugAdd, ueberzugRemove, ueberzugSocketPath } from "./imageProtocol.js";

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
      try {
        onSignalCleanup?.();
      } catch { /* ignore */ }
      STD.exit(code);
    });
  }
}

export class UeberzugLayer {
  /**
   * @param {string} output - ueberzugpp -o value (x11, wayland, ...)
   * @param {{bin?: string}} [opts]
   */
  constructor(output, { bin = "ueberzugpp" } = {}) {
    this.output = output;
    this.bin = bin;
    this.pid = null;
    this.file = null;
    this.shown = new Set();
    this.dead = true;
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
    return true;
  }

  /** @returns {boolean} whether the ueberzugpp process is still running */
  alive() {
    if (this.dead || !this.pid) return false;
    const [ret] = OS.waitpid(this.pid, OS.WNOHANG);
    if (ret === this.pid) {
      this.dead = true;
      this.pid = null;
    }
    return !this.dead;
  }

  /** Unix socket the layer listens on (for `ueberzugpp cmd -s`). */
  socketPath() {
    return this.pid ? ueberzugSocketPath(STD.getenviron(), this.pid) : null;
  }

  send(line) {
    if (this.dead || !this.file) return false;
    this.file.puts(line + "\n");
    this.file.flush();
    if (this.file.error()) {
      this.dead = true;
      return false;
    }
    return true;
  }

  /** Show `path` at cell (x, y) (0-based), fit into width x height cells. */
  add(identifier, x, y, width, height, path) {
    if (this.send(ueberzugAdd(identifier, x, y, width, height, path))) {
      this.shown.add(identifier);
    }
  }

  remove(identifier) {
    this.shown.delete(identifier);
    this.send(ueberzugRemove(identifier));
  }

  /** Remove every overlay this layer is showing. */
  removeAll() {
    for (const identifier of [...this.shown]) this.remove(identifier);
  }

  /**
   * Remove all overlays, close the pipe (ueberzugpp exits on EOF) and reap
   * the process; SIGTERM, then SIGKILL, if it doesn't go away.
   */
  stop() {
    live.delete(this);
    if (this.file) {
      try {
        this.removeAll();
        this.file.close();
      } catch { /* ignore */ }
      this.file = null;
    }
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
