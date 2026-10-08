/**
 * Runtime side of image protocol support (QuickJS only).
 * Pure detection logic lives in ./imageProtocol.js.
 */
import { OS, STD, SystemError } from "../core/constants.js";
import { Process, ProcessSync } from "../../qjs-ext-lib/src/process.js";
import {
  chafaArgs,
  chafaSymbolOptions,
  detectMultiplexer,
  parseChafaFeatures,
  pngSize,
  resolveImageProtocol,
} from "./imageProtocol.js";
import { cursorTo } from "../../helpers/cursor.js";

/**
 * Ask the terminal for its Primary Device Attributes (DA1).
 * Runs a tiny bash helper on /dev/tty with a short timeout so it never
 * interferes with the QuickJS event loop. Returns null on failure/timeout.
 * @returns {string|null}
 */
export function queryDA1() {
  const script = [
    "exec 3<>/dev/tty || exit 1",
    'old=$(stty -g <&3) || exit 1',
    "stty raw -echo min 0 time 5 <&3",
    "printf '\\033[c' >&3",
    'resp=""',
    'while IFS= read -r -s -n1 -t 0.5 ch <&3; do resp+="$ch"; [[ $ch == c ]] && break; done',
    'stty "$old" <&3',
    'printf "%s" "${resp//$\'\\033\'/}"',
  ].join("\n");
  try {
    const p = new ProcessSync(["bash", "-c", script], {
      passStderr: false,
      passStdout: false,
    });
    p.run();
    if (!p.success) return null;
    return p.stdout || null;
  } catch {
    return null;
  }
}

/**
 * Ask the terminal for its cell size in pixels (XTWINOPS CSI 16 t), with a
 * DA1 query as sentinel so terminals that ignore CSI 16 t don't stall us.
 * @returns {string|null} "WxH" or null
 */
export function queryCellSize() {
  const script = [
    "exec 3<>/dev/tty || exit 1",
    'old=$(stty -g <&3) || exit 1',
    "stty raw -echo min 0 time 5 <&3",
    "printf '\\033[16t\\033[c' >&3",
    'resp=""',
    'while IFS= read -r -s -n1 -t 0.5 ch <&3; do resp+="$ch"; [[ $ch == c ]] && break; done',
    'stty "$old" <&3',
    'printf "%s" "${resp//$\'\\033\'/}"',
  ].join("\n");
  try {
    const p = new ProcessSync(["bash", "-c", script], {
      passStderr: false,
      passStdout: false,
    });
    p.run();
    const m = /\[6;(\d+);(\d+)t/.exec(p.stdout || "");
    return m ? `${m[2]}x${m[1]}` : null;
  } catch {
    return null;
  }
}

let features;
/**
 * chafa capabilities (version, sextant/octant symbols, --work), detected once
 * and cached on disk keyed by the chafa binary's path/mtime/size, so the
 * per-preview --render-tile process doesn't spawn chafa twice just to ask.
 */
export function chafaFeatures() {
  if (features !== undefined) return features;
  const bin = findCommand("chafa");
  if (!bin) return (features = null);
  const [st] = OS.stat(bin);
  const stamp = `${bin}|${st?.mtime}|${st?.size}`;
  const cacheFile = `${STD.getenv("HOME")}/.cache/WallRizz/chafa-features.json`;
  try {
    const cached = JSON.parse(STD.loadFile(cacheFile) ?? "null");
    if (cached?.stamp === stamp) return (features = cached.features);
  } catch { /* ignore */ }
  try {
    const v = new ProcessSync(["chafa", "--version"], { passStderr: false });
    v.run();
    const h = new ProcessSync(["chafa", "--help"], { passStderr: false });
    h.run();
    features = v.success ? parseChafaFeatures(v.stdout, h.stdout) : null;
  } catch {
    features = null;
  }
  try {
    const f = STD.open(cacheFile, "w");
    if (f) {
      f.puts(JSON.stringify({ stamp, features }));
      f.close();
    }
  } catch { /* ignore */ }
  return features;
}

let terminalBrand = STD.getenv("WALLRIZZ_TERMINAL") ?? "unknown";
/** Terminal brand used to pick chafa symbol sets (set after detection). */
export function setTerminalBrand(brand) {
  if (brand && brand !== "override") terminalBrand = brand;
}
export function getTerminalBrand() {
  return terminalBrand;
}

/**
 * @param {string} cmd
 * @returns {boolean} whether `cmd` is an executable in PATH
 */
export function commandExists(cmd) {
  return findCommand(cmd) !== null;
}

/** @returns {string|null} full path of `cmd` in PATH */
export function findCommand(cmd) {
  const path = STD.getenv("PATH") ?? "";
  for (const dir of path.split(":").filter(Boolean)) {
    const [st, err] = OS.stat(`${dir}/${cmd}`);
    if (
      err === 0 && (st.mode & OS.S_IFMT) === OS.S_IFREG &&
      (st.mode & 0o111) !== 0
    ) return `${dir}/${cmd}`;
  }
  return null;
}

let resolved = null;

/**
 * Detect (once) and return the image protocol to use.
 * @param {object} config - parsed CLI config (uses config.imageProtocol)
 * @returns {{protocol: string, terminal: string, source: string}}
 */
export function getImageProtocol(config) {
  if (resolved) return resolved;
  const env = STD.getenviron();
  try {
    resolved = resolveImageProtocol({
      env,
      override: config?.imageProtocol,
      queryDA1,
      hasUeberzug: () => commandExists("ueberzugpp"),
    });
  } catch (e) {
    throw new SystemError("Invalid image protocol", e.message);
  }
  setTerminalBrand(resolved.terminal);
  if (resolved.protocol === "sixel" || resolved.protocol === "symbols") {
    requireChafa(resolved.protocol, resolved.source);
  }
  return resolved;
}

/** Throw a helpful error when chafa is needed but missing. */
export function requireChafa(protocol, why) {
  if (commandExists("chafa")) return;
  throw new SystemError(
    `chafa is required to draw images with the "${protocol}" protocol (${why}).`,
    "Install chafa (or ueberzugpp), or force kitty graphics with --image-protocol kitty / WALLRIZZ_IMAGE_PROTOCOL=kitty.",
  );
}

function passthroughNoneNeeded(env) {
  return Boolean(detectMultiplexer(env) && chafaFeatures()?.passthrough);
}

/**
 * Build chafa argv for the current environment.
 */
export function buildChafaArgs(protocol, columns, rows) {
  const env = STD.getenviron();
  return chafaArgs(protocol, columns, rows, env, {
    passthroughNone: passthroughNoneNeeded(env),
    symbolOptions: protocol === "symbols"
      ? chafaSymbolOptions(chafaFeatures(), terminalBrand, env)
      : undefined,
  });
}

/**
 * Render an image with chafa and return the escape/text output (untrimmed).
 * stdin is inherited (the tty) so chafa can read the cell pixel size via
 * TIOCGWINSZ; stdout goes to a temp file so UTF-8 is decoded in one piece.
 * @returns {Promise<string>}
 */
export function renderWithChafa(protocol, filePath, columns, rows) {
  return renderWithChafaArgs([...buildChafaArgs(protocol, columns, rows), filePath]);
}

/** Run a full chafa argv (see renderWithChafa) and return its raw output. */
export async function renderWithChafaArgs(argv) {
  const filePath = argv.at(-1);
  const p = new Process(argv, {
    streamStdout: false,
    trim: false,
  });
  await p.run();
  if (!p.success) {
    throw new SystemError(
      `chafa failed to render ${filePath}`,
      p.stderr || `exit code ${p.state.exitCode}`,
    );
  }
  return p.stdout;
}

/**
 * Turn chafa output into a string that draws the image with its top-left
 * corner at terminal cell (x, y) (x 0-based column, y 1-based row, same
 * convention as helpers/cursor.js cursorTo).
 * Symbols output is multi-line, so every line gets its own cursor move;
 * pixel protocols are a single escape sequence drawn at the cursor.
 */
export function positionOutput(protocol, output, x, y) {
  const body = output.replace(/\n+$/, "");
  if (protocol === "symbols") {
    return body
      .split("\n")
      .map((line, i) => cursorTo(x, y + i) + line)
      .join("") + "\x1b[0m";
  }
  // Terminals move the cursor below/after a sixel or iTerm2 image (WezTerm
  // to the line under it): save and restore it so later drawing isn't
  // shifted and nothing can scroll.
  return "\x1b7" + cursorTo(x, y) + body + "\x1b8";
}

const sizes = new Map();
/**
 * Pixel size of an image: read from the PNG header (thumbnails are PNG),
 * else `magick identify`. Memoized per path+mtime.
 * @returns {{width: number, height: number}|null}
 */
export function imagePixelSize(path) {
  const [st, err] = OS.stat(path);
  if (err !== 0) return null;
  const key = `${path}|${st.mtime}|${st.size}`;
  if (sizes.has(key)) return sizes.get(key);
  let size = null;
  const f = STD.open(path, "rb");
  if (f) {
    const buf = new ArrayBuffer(24);
    const n = f.read(buf, 0, 24);
    f.close();
    size = pngSize(new Uint8Array(buf, 0, Math.max(0, n)));
  }
  if (!size) {
    try {
      const p = new ProcessSync(
        ["magick", "identify", "-format", "%w %h", `${path}[0]`],
        { passStderr: false },
      );
      p.run();
      const [width, height] = (p.stdout || "").trim().split(" ").map(Number);
      if (width > 0 && height > 0) size = { width, height };
    } catch { /* ignore */ }
  }
  sizes.set(key, size);
  return size;
}
