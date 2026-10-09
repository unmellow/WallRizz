/**
 * Überzug++ window-up confirmation (Wayland page mode).
 *
 * ueberzugpp shows every image as its own toplevel window (app_id / class
 * `ueberzugpp_<random>`), and needs 0.1 s (sway, libvips build) to 0.7 s
 * (first image, OpenCV build) from the add to a mapped window. An overlay
 * that is replaced (page flip, progressive fill) must stay up until its
 * successor is really on screen, otherwise the terminal shows through for a
 * few frames. A WindowWatch tells when the window of an add appeared:
 *
 *   sway:     `swaymsg -r -t subscribe -m '["window"]'` child, read without
 *             blocking (OS.setReadHandler); a "new"/"floating" event of an
 *             `ueberzugpp_*` window of our ueberzugpp (its pid, or a child
 *             of it) confirms the oldest unconfirmed add
 *   Hyprland: `hyprctl clients -j`, polled every HYPR_POLL_MS (async) while
 *             an add waits: a new mapped, not hidden `ueberzugpp_*` client
 *   other:    no confirmation; an add counts as up FALLBACK_MS after it was
 *             sent
 *
 * ueberzugpp handles commands one by one, so windows appear in the order of
 * the adds; its windows carry a random app_id, so pid and order are all an
 * event can be matched by: an event confirms the oldest add still waiting.
 * Every add has its own hard timeout (HARD_TIMEOUT_MS): then it counts as
 * up anyway and leaves the queue, so an add whose window never appears (or
 * whose event was missed) never holds up a later one. The layer never
 * removes an overlay before its window is up or timed out (ueberzug.js),
 * because ueberzugpp drops a window removed before it is mapped. A window
 * removed after its timeout (or forgotten) may still appear late, or never:
 * it stays as a "removed" marker for REMOVED_MARK_MS. A new window that
 * comes while an older marker exists is held for up to GHOST_CLOSE_MS: if
 * sway reports it closed meanwhile it was the removed one's, otherwise it
 * confirms the oldest waiting add (and the marker goes).
 */
import { OS, STD } from "../core/constants.js";

export const HARD_TIMEOUT_MS = 1000;
export const FALLBACK_MS = 300;
// a window removed before it was seen may still appear this long
export const REMOVED_MARK_MS = 1000;
// a window that may be a removed one's: wait this long for its "close"
export const GHOST_CLOSE_MS = 100;
const HYPR_POLL_MS = 25;
const APP_PREFIX = "ueberzugpp_";

/** Is `exe` in $PATH (or an executable path)? */
function inPath(exe, env) {
  if (exe.includes("/")) return OS.stat(exe)[1] === 0;
  for (const dir of (env.PATH ?? "").split(":")) {
    if (dir && OS.stat(`${dir}/${exe}`)[1] === 0) return true;
  }
  return false;
}

/** parent pid from /proc/<pid>/stat (null if unknown) */
function parentOf(pid) {
  const stat = STD.loadFile(`/proc/${pid}/stat`);
  if (!stat) return null;
  // "pid (comm) state ppid ...": comm may contain spaces and parentheses
  const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const ppid = Number(rest[1]);
  return Number.isFinite(ppid) ? ppid : null;
}

/**
 * Is a window of process `pid` one of the layer's (`owner` itself, or a
 * descendant within a few levels: wrappers)? Without /proc: assume yes.
 */
export function ownedBy(pid, owner, parent = parentOf) {
  if (!owner) return false;
  if (!pid || pid === owner) return true; // no pid in the event: can't tell
  let p = pid;
  for (let depth = 0; depth < 4; depth++) {
    const pp = parent(p);
    if (pp === null) return depth === 0; // no /proc: can't tell
    if (pp === owner) return true;
    if (pp <= 1) return false;
    p = pp;
  }
  return false;
}

/**
 * Splits a stream of concatenated JSON objects (pretty printed or not).
 * push(text) returns the complete top-level objects seen so far.
 */
export class JsonStream {
  constructor() {
    this.buf = "";
    this.depth = 0;
    this.inString = false;
    this.escape = false;
    this.start = -1;
    this.pos = 0;
  }

  push(text) {
    this.buf += text;
    const out = [];
    for (; this.pos < this.buf.length; this.pos++) {
      const ch = this.buf[this.pos];
      if (this.inString) {
        if (this.escape) this.escape = false;
        else if (ch === "\\") this.escape = true;
        else if (ch === '"') this.inString = false;
        continue;
      }
      if (ch === '"') {
        if (this.depth > 0) this.inString = true;
      } else if (ch === "{" || ch === "[") {
        if (this.depth++ === 0) this.start = this.pos;
      } else if ((ch === "}" || ch === "]") && this.depth > 0) {
        if (--this.depth === 0) {
          try {
            out.push(JSON.parse(this.buf.slice(this.start, this.pos + 1)));
          } catch { /* skip a broken object */ }
          this.start = -1;
        }
      }
    }
    // keep only an unfinished object
    if (this.depth === 0) {
      this.buf = "";
      this.pos = 0;
    } else if (this.start > 0) {
      this.buf = this.buf.slice(this.start);
      this.pos -= this.start;
      this.start = 0;
    }
    return out;
  }
}

/** bytes -> string (JSON from swaymsg / hyprctl; non-ASCII only in titles) */
function decode(bytes, n) {
  let s = "";
  for (let i = 0; i < n; i += 8192) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(n, i + 8192)));
  }
  return s;
}

/**
 * Run argv with stdout on a pipe, read it without blocking.
 * @returns {{pid: number, stop: () => void} | null}
 */
function spawnReader(argv, onData, onEnd) {
  const fds = OS.pipe();
  if (!fds) return null;
  const [readFd, writeFd] = fds;
  const devNull = OS.open("/dev/null", OS.O_RDWR);
  let pid = null;
  try {
    pid = OS.exec(argv, { block: false, usePath: true, stdin: devNull, stdout: writeFd, stderr: devNull });
  } catch {
    pid = null;
  }
  OS.close(writeFd);
  if (devNull >= 0) OS.close(devNull);
  if (!pid || pid < 0) {
    OS.close(readFd);
    return null;
  }
  const buf = new Uint8Array(65536);
  let open = true;
  const finish = (kill) => {
    if (!open) return;
    open = false;
    OS.setReadHandler(readFd, null);
    OS.close(readFd);
    if (kill) OS.kill(pid, OS.SIGTERM);
    for (let i = 0; i < 50; i++) {
      const [ret] = OS.waitpid(pid, OS.WNOHANG);
      if (ret === pid || ret < 0) return;
      OS.sleep(2);
    }
    OS.kill(pid, OS.SIGKILL);
    OS.waitpid(pid, 0);
  };
  OS.setReadHandler(readFd, () => {
    const n = OS.read(readFd, buf.buffer, 0, buf.length);
    if (n > 0) {
      onData(decode(buf, n));
      return;
    }
    finish(false);
    onEnd?.();
  });
  return { pid, stop: () => finish(true) };
}

/**
 * Which confirmation is available here.
 * @returns {"sway" | "hyprland" | "none"}
 */
export function windowWatchKind(env = STD.getenviron()) {
  const forced = env.WALLRIZZ_UEBERZUG_CONFIRM;
  if (forced === "none" || forced === "0") return "none";
  if (env.SWAYSOCK && inPath("swaymsg", env)) return "sway";
  if (env.HYPRLAND_INSTANCE_SIGNATURE && inPath("hyprctl", env)) return "hyprland";
  return "none";
}

export class WindowWatch {
  /**
   * @param {() => number | null} ownerPid - pid of the ueberzugpp layer
   * @param {object} [opts]
   * @param {"sway" | "hyprland" | "none"} [opts.kind]
   * @param {(pid: number) => number | null} [opts.parent] - for tests
   */
  constructor(ownerPid, { kind = windowWatchKind(), parent = parentOf } = {}) {
    this.ownerPid = ownerPid;
    this.kind = kind;
    this.parent = parent;
    this.queue = []; // waiting { id, sentAt, cb, timer } / removed markers { until }
    this.timedOut = new Map(); // id -> entry of a timed-out add (for removedUnseen)
    this.seen = new Set(); // sway container ids / hyprland addresses
    this.child = null;
    this.held = null; // { cid, mark, timer }: a window that may be a removed one's
    this.pollTimer = null;
    this.polling = null;
    this.stopped = false;
    this.stats = { mapped: 0, timeout: 0, fallback: 0 };
    // (swaymsg prints nothing once subscribed; it is started before
    // ueberzugpp, which needs far longer to map its first window)
    if (kind === "sway") this.startSway();
  }

  startSway() {
    const stream = new JsonStream();
    this.child = spawnReader(
      ["swaymsg", "-r", "-t", "subscribe", "-m", '["window"]'],
      (text) => {
        for (const ev of stream.push(text)) this.onSwayEvent(ev);
      },
      () => this.degrade(),
    );
    if (!this.child) {
      this.kind = "none";
    }
  }

  /** the event source went away: everything still waiting uses the fallback */
  degrade() {
    if (this.stopped || this.kind === "none") return;
    this.child = null;
    this.kind = "none";
    if (this.held) OS.clearTimeout(this.held.timer);
    this.held = null;
    this.queue = this.queue.filter((e) => e.cb);
    for (const e of this.queue) {
      this.arm(e, Math.max(0, e.sentAt + FALLBACK_MS - Date.now()), "fallback");
    }
  }

  onSwayEvent(ev) {
    const con = ev?.container ?? {};
    if (ev?.change === "close") {
      if (this.held && this.held.cid === con.id) {
        // the held window was a removed one's: it confirms nothing
        OS.clearTimeout(this.held.timer);
        const { mark } = this.held;
        this.held = null;
        this.drop(mark);
      }
      return;
    }
    if (ev?.change !== "new" && ev?.change !== "floating") return;
    if (!String(con.app_id ?? "").startsWith(APP_PREFIX)) return;
    if (this.seen.has(con.id)) return;
    if (!ownedBy(con.pid, this.ownerPid(), this.parent)) return;
    this.seen.add(con.id);
    if (this.seen.size > 256) this.seen = new Set([...this.seen].slice(-64));
    this.appeared(con.id);
  }

  drop(e) {
    this.queue = this.queue.filter((x) => x !== e);
  }

  /** forget removed markers that are past their time */
  purge() {
    const now = Date.now();
    this.queue = this.queue.filter((e) => e.cb || e.until > now);
  }

  /** a window of ours appeared: confirm the oldest waiting add */
  appeared(cid = null) {
    if (this.held) {
      // windows come in order: the held one was the removed one's
      OS.clearTimeout(this.held.timer);
      const { mark } = this.held;
      this.held = null;
      this.drop(mark);
    }
    this.purge();
    const first = this.queue.findIndex((e) => e.cb);
    const mark = this.queue.find((e, i) => !e.cb && (first < 0 || i < first));
    if (mark && first >= 0 && cid !== null && this.kind === "sway") {
      // this window is the removed one's (a close follows) or the add's
      this.held = {
        cid,
        mark,
        timer: OS.setTimeout(() => {
          this.held = null;
          this.drop(mark); // it never appeared
          this.appeared(null);
        }, GHOST_CLOSE_MS),
      };
      return;
    }
    if (mark && first < 0) {
      this.drop(mark); // nothing waits: it was the removed one's
      return;
    }
    if (first < 0) return;
    const e = this.queue[first];
    if (mark) this.drop(mark);
    this.drop(e);
    this.resolve(e, "mapped");
  }

  /** keep `e` (no longer waiting) as a removed marker, in add order */
  mark(e) {
    e.cb = null;
    e.until = Date.now() + REMOVED_MARK_MS;
    this.drop(e);
    const at = this.queue.findIndex((x) => x.sentAt > e.sentAt);
    if (at < 0) this.queue.push(e);
    else this.queue.splice(at, 0, e);
  }

  /**
   * The remove of `id` was sent after its add timed out (no window seen):
   * that window may still appear (and close), or never.
   */
  removedUnseen(id) {
    const e = this.timedOut.get(id);
    if (!e) return;
    this.timedOut.delete(id);
    if (this.kind !== "none" && !this.stopped) this.mark(e);
  }

  resolve(e, how) {
    if (e.timer) OS.clearTimeout(e.timer);
    e.timer = null;
    const cb = e.cb;
    e.cb = null;
    this.stats[how] = (this.stats[how] ?? 0) + 1;
    cb?.(how);
  }

  arm(e, ms, how) {
    if (e.timer) OS.clearTimeout(e.timer);
    e.timer = OS.setTimeout(() => {
      e.timer = null;
      if (!e.cb) return;
      // its own timeout: it leaves the queue, later adds don't wait on it
      this.drop(e);
      if (how === "timeout") {
        this.timedOut.set(e.id, e);
        if (this.timedOut.size > 32) this.timedOut.delete(this.timedOut.keys().next().value);
      }
      this.resolve(e, how);
    }, ms);
  }

  /**
   * The add of `id` was just written; `cb(how)` is called once when its
   * window is up ("mapped"), timed out ("timeout"), or assumed up
   * ("fallback").
   */
  sent(id, cb) {
    const e = { id, sentAt: Date.now(), cb, timer: null, until: 0 };
    this.timedOut.delete(id);
    this.queue.push(e);
    if (this.kind === "none") {
      this.arm(e, FALLBACK_MS, "fallback");
      return;
    }
    this.arm(e, HARD_TIMEOUT_MS, "timeout");
    if (this.kind === "hyprland") this.poll();
  }

  /**
   * `id` was removed before its window was confirmed: drop the callback;
   * its window may still appear (and must not count for a newer add).
   */
  forget(id) {
    const e = this.queue.find((x) => x.id === id && x.cb);
    if (!e) return;
    if (e.timer) OS.clearTimeout(e.timer);
    e.timer = null;
    if (this.kind === "none") {
      e.cb = null;
      this.drop(e);
    } else {
      this.mark(e);
    }
  }

  /** adds still waiting for their window */
  waiting() {
    return this.queue.filter((e) => e.cb).length;
  }

  // Hyprland: poll the client list while something waits
  poll() {
    if (this.pollTimer || this.polling || this.stopped || this.kind !== "hyprland") return;
    let out = "";
    this.polling = spawnReader(["hyprctl", "clients", "-j"], (t) => { out += t; }, () => {
      this.polling = null;
      let clients = null;
      try {
        clients = JSON.parse(out);
      } catch { /* ignore */ }
      if (!Array.isArray(clients)) {
        this.degrade();
        return;
      }
      for (const c of clients) {
        if (!String(c.class ?? c.initialClass ?? "").startsWith(APP_PREFIX)) continue;
        if (c.mapped === false || c.hidden === true || this.seen.has(c.address)) continue;
        if (!ownedBy(c.pid, this.ownerPid(), this.parent)) continue;
        this.seen.add(c.address);
        this.appeared();
      }
      if (this.waiting() && !this.stopped) {
        this.pollTimer = OS.setTimeout(() => {
          this.pollTimer = null;
          this.poll();
        }, HYPR_POLL_MS);
      }
    });
    if (!this.polling) this.degrade();
  }

  stop() {
    this.stopped = true;
    for (const e of this.queue) if (e.timer) OS.clearTimeout(e.timer);
    this.queue = [];
    this.timedOut.clear();
    if (this.held) OS.clearTimeout(this.held.timer);
    this.held = null;
    if (this.pollTimer) OS.clearTimeout(this.pollTimer);
    this.pollTimer = null;
    this.polling?.stop();
    this.polling = null;
    this.child?.stop();
    this.child = null;
  }
}
