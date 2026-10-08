/**
 * Runtime side of image protocol support (QuickJS only).
 * Pure detection logic lives in ./imageProtocol.js.
 */
import { OS, STD, SystemError } from "../core/constants.js";
import { Process, ProcessSync } from "../../qjs-ext-lib/src/process.js";
import {
  chafaArgs,
  detectMultiplexer,
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
 * @param {string} cmd
 * @returns {boolean} whether `cmd` is an executable in PATH
 */
export function commandExists(cmd) {
  const path = STD.getenv("PATH") ?? "";
  return path.split(":").filter(Boolean).some((dir) => {
    const [st, err] = OS.stat(`${dir}/${cmd}`);
    return err === 0 && (st.mode & OS.S_IFMT) === OS.S_IFREG &&
      (st.mode & 0o111) !== 0;
  });
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
    });
  } catch (e) {
    throw new SystemError("Invalid image protocol", e.message);
  }
  if (resolved.protocol !== "kitty" && !commandExists("chafa")) {
    throw new SystemError(
      `chafa is required to draw images with the "${resolved.protocol}" protocol (${resolved.source}).`,
      "Install chafa, or force kitty graphics with --image-protocol kitty / WALLRIZZ_IMAGE_PROTOCOL=kitty.",
    );
  }
  return resolved;
}

let chafaHasPassthrough;
function passthroughNoneNeeded(env) {
  if (!detectMultiplexer(env)) return false;
  if (chafaHasPassthrough === undefined) {
    try {
      const p = new ProcessSync(["chafa", "--help"], { passStderr: false });
      p.run();
      chafaHasPassthrough = p.stdout.includes("--passthrough");
    } catch {
      chafaHasPassthrough = false;
    }
  }
  return chafaHasPassthrough;
}

/**
 * Build chafa argv for the current environment.
 */
export function buildChafaArgs(protocol, columns, rows) {
  const env = STD.getenviron();
  return chafaArgs(protocol, columns, rows, env, {
    passthroughNone: passthroughNoneNeeded(env),
  });
}

/**
 * Render an image with chafa and return the escape/text output (untrimmed).
 * stdin is inherited (the tty) so chafa can read the cell pixel size via
 * TIOCGWINSZ; stdout goes to a temp file so UTF-8 is decoded in one piece.
 * @returns {Promise<string>}
 */
export async function renderWithChafa(protocol, filePath, columns, rows) {
  const p = new Process([...buildChafaArgs(protocol, columns, rows), filePath], {
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
  return cursorTo(x, y) + body;
}
