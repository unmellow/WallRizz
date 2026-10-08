/**
 * Terminal image protocol detection, yazi style.
 *
 * Picks one of:
 *   - "kitty"   : kitty graphics protocol (native WallRizz path, unchanged)
 *   - "iterm"   : iTerm2 inline images (OSC 1337), drawn with `chafa -f iterm`
 *   - "sixel"   : DEC sixel, drawn with `chafa -f sixels`
 *   - "symbols" : unicode block/colour symbols, drawn with `chafa -f symbols`
 *   - "ueberzug": Überzug++ (`ueberzugpp layer`) draws real images in a child
 *                 X11/Wayland window over the terminal (any terminal, no
 *                 terminal graphics support needed)
 *
 * Resolution order:
 *   1. explicit override: --image-protocol / WALLRIZZ_IMAGE_PROTOCOL (anything but "auto")
 *   2. terminal multiplexer (tmux/screen/zellij) -> DA1 probe: sixel if advertised, else symbols
 *   3. env based brand detection (TERM, then TERM_PROGRAM, then terminal specific vars)
 *   4. unknown terminal / plain xterm -> DA1 probe: sixel if advertised, else symbols
 *   5. whenever 2-4 end at "symbols" outside a multiplexer, and ueberzugpp is
 *      installed with a usable X11/Wayland canvas -> ueberzug
 *
 * The detection functions are pure (they take an env object and an optional
 * DA1 probe callback) so they can be unit tested without a terminal.
 */

export const PROTOCOLS = ["kitty", "iterm", "sixel", "symbols", "ueberzug"];
export const PROTOCOL_CHOICES = ["auto", ...PROTOCOLS];

const ALIASES = {
  auto: "auto",
  "": "auto",
  kitty: "kitty",
  kgp: "kitty",
  iterm: "iterm",
  iterm2: "iterm",
  iip: "iterm",
  sixel: "sixel",
  sixels: "sixel",
  symbols: "symbols",
  symbol: "symbols",
  chafa: "symbols",
  text: "symbols",
  ascii: "symbols",
  ueberzug: "ueberzug",
  ueberzugpp: "ueberzug",
  "ueberzug++": "ueberzug",
};

/**
 * Normalize a user supplied protocol name.
 * @param {string|undefined|null} value
 * @returns {string|null} one of PROTOCOL_CHOICES, or null if invalid
 */
export function normalizeProtocol(value) {
  if (value === undefined || value === null) return "auto";
  const key = String(value).trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(ALIASES, key)
    ? ALIASES[key]
    : null;
}

const has = (env, name) =>
  env[name] !== undefined && env[name] !== null && env[name] !== "";

/**
 * Detect the terminal "brand" from environment variables only.
 * Mirrors yazi's Brand::from_env ordering: TERM, TERM_PROGRAM, then
 * terminal specific variables (which can leak into child terminals, so they
 * are checked last).
 *
 * @param {Record<string,string>} env
 * @returns {{brand: string, via: string}|null}
 */
export function detectBrand(env) {
  const term = env.TERM ?? "";
  const termProgram = env.TERM_PROGRAM ?? "";

  // 1. TERM
  if (term === "xterm-kitty") return { brand: "kitty", via: "TERM=xterm-kitty" };
  if (term === "xterm-ghostty") return { brand: "ghostty", via: "TERM=xterm-ghostty" };
  if (term === "foot" || term === "foot-extra" || term.startsWith("foot-")) {
    return { brand: "foot", via: `TERM=${term}` };
  }
  if (term === "wezterm") return { brand: "wezterm", via: "TERM=wezterm" };
  if (term === "rio") return { brand: "rio", via: "TERM=rio" };
  if (term === "alacritty" || term.startsWith("alacritty-")) {
    return { brand: "alacritty", via: `TERM=${term}` };
  }
  if (term.startsWith("mlterm")) return { brand: "mlterm", via: `TERM=${term}` };
  if (term === "contour" || term.startsWith("contour-")) {
    return { brand: "contour", via: `TERM=${term}` };
  }
  if (term.startsWith("rxvt-unicode")) return { brand: "urxvt", via: `TERM=${term}` };
  if (term === "st" || term.startsWith("st-")) return { brand: "st", via: `TERM=${term}` };
  if (term === "linux") return { brand: "linux-console", via: "TERM=linux" };

  // 2. TERM_PROGRAM
  const programs = {
    "iTerm.app": "iterm2",
    WezTerm: "wezterm",
    ghostty: "ghostty",
    WarpTerminal: "warp",
    rio: "rio",
    BlackBox: "blackbox",
    vscode: "vscode",
    Tabby: "tabby",
    Hyper: "hyper",
    mintty: "mintty",
    Apple_Terminal: "apple-terminal",
    Bobcat: "bobcat",
  };
  if (programs[termProgram]) {
    return { brand: programs[termProgram], via: `TERM_PROGRAM=${termProgram}` };
  }

  // 3. terminal specific variables
  const vars = [
    ["KITTY_WINDOW_ID", "kitty"],
    ["GHOSTTY_RESOURCES_DIR", "ghostty"],
    ["WEZTERM_EXECUTABLE", "wezterm"],
    ["WEZTERM_PANE", "wezterm"],
    ["ITERM_SESSION_ID", "iterm2"],
    ["KONSOLE_VERSION", "konsole"],
    ["WT_SESSION", "windows-terminal"],
    ["WARP_HONOR_PS1", "warp"],
    ["VSCODE_INJECTION", "vscode"],
    ["TABBY_CONFIG_DIRECTORY", "tabby"],
    ["MLTERM", "mlterm"],
    ["ALACRITTY_WINDOW_ID", "alacritty"],
    ["ALACRITTY_SOCKET", "alacritty"],
    ["ALACRITTY_LOG", "alacritty"],
  ];
  for (const [name, brand] of vars) {
    if (has(env, name)) return { brand, via: name };
  }
  if (env.LC_TERMINAL === "iTerm2") return { brand: "iterm2", via: "LC_TERMINAL=iTerm2" };

  // xterm proper (XTERM_VERSION is only set by xterm itself)
  if (has(env, "XTERM_VERSION")) return { brand: "xterm", via: "XTERM_VERSION" };

  return null;
}

/**
 * Brand -> protocol. `null` means "ask the terminal (DA1)".
 * Based on yazi's driver table, adjusted to what WallRizz can draw.
 */
export const BRAND_PROTOCOL = {
  kitty: "kitty",
  ghostty: "kitty",
  konsole: "kitty", // yazi uses direct-placement kitty (KgpOld) for Konsole; unverified here
  wezterm: "iterm", // WezTerm's kitty support is partial/opt-in; iTerm2 images are solid
  iterm2: "iterm",
  warp: "iterm",
  rio: "iterm",
  vscode: "iterm",
  tabby: "iterm",
  hyper: "iterm",
  mintty: "iterm",
  bobcat: "iterm",
  foot: "sixel",
  mlterm: "sixel",
  contour: "sixel",
  blackbox: "sixel",
  "windows-terminal": "sixel",
  alacritty: "symbols",
  urxvt: "symbols",
  st: "symbols",
  "apple-terminal": "symbols",
  "linux-console": "symbols",
  xterm: null, // xterm only has sixel when built/configured for it -> probe
};

/**
 * @param {Record<string,string>} env
 * @returns {string|null} multiplexer name or null
 */
export function detectMultiplexer(env) {
  const term = env.TERM ?? "";
  if (has(env, "TMUX") || term.startsWith("tmux") || env.TERM_PROGRAM === "tmux") {
    return "tmux";
  }
  if (has(env, "ZELLIJ")) return "zellij";
  if (has(env, "STY") || term.startsWith("screen")) return "screen";
  return null;
}

/**
 * Parse a DA1 (Primary Device Attributes) response, e.g. "\x1b[?62;4;22c".
 * @param {string} response
 * @returns {boolean} true if attribute 4 (sixel graphics) is advertised
 */
export function da1HasSixel(response) {
  if (!response) return false;
  const match = /\?([0-9;]*)c/.exec(response);
  if (!match) return false;
  return match[1].split(";").includes("4");
}

/** Wayland compositors Überzug++ has a canvas for (same list as yazi). */
const UEBERZUG_WAYLAND_VARS = [
  "SWAYSOCK",
  "HYPRLAND_INSTANCE_SIGNATURE",
  "WAYFIRE_SOCKET",
  "NIRI_SOCKET",
];

/**
 * Pick the Überzug++ output (`ueberzugpp layer -o ...`), following yazi:
 * an X11 session or a plain X display -> "x11"; Wayland -> "wayland" on
 * compositors ueberzugpp supports (sway, Hyprland, Wayfire, niri). Other
 * Wayland compositors (GNOME, KDE, ...) -> null (ueberzugpp can't place a
 * window over a native Wayland terminal there).
 * WALLRIZZ_UEBERZUG_OUTPUT overrides (x11, wayland, ...).
 *
 * @param {Record<string,string>} env
 * @returns {string|null}
 */
export function ueberzugOutput(env) {
  if (has(env, "WALLRIZZ_UEBERZUG_OUTPUT")) {
    return String(env.WALLRIZZ_UEBERZUG_OUTPUT).trim().toLowerCase();
  }
  if (env.XDG_SESSION_TYPE === "x11" && has(env, "DISPLAY")) return "x11";
  if (has(env, "WAYLAND_DISPLAY")) {
    return UEBERZUG_WAYLAND_VARS.some((name) => has(env, name)) ? "wayland" : null;
  }
  if (has(env, "DISPLAY")) return "x11";
  return null;
}

/**
 * Resolve the image protocol.
 *
 * @param {object} opts
 * @param {Record<string,string>} opts.env - environment variables
 * @param {string} [opts.override] - value of --image-protocol (may be "auto")
 * @param {() => (string|null)} [opts.queryDA1] - returns raw DA1 response or null
 * @param {() => boolean} [opts.hasUeberzug] - whether `ueberzugpp` is in PATH
 * @returns {{protocol: string, terminal: string, source: string, ueberzugOutput?: string}}
 */
export function resolveImageProtocol({ env, override, queryDA1, hasUeberzug }) {
  const result = resolveBaseProtocol({ env, override, queryDA1 });
  if (result.protocol === "ueberzug") {
    // forced: use the detected canvas, or guess from what's there
    result.ueberzugOutput = ueberzugOutput(env) ??
      (has(env, "WAYLAND_DISPLAY") ? "wayland" : "x11");
    return result;
  }
  if (
    result.protocol === "symbols" && result.terminal !== "override" &&
    !detectMultiplexer(env)
  ) {
    const output = ueberzugOutput(env);
    if (output && hasUeberzug?.()) {
      return {
        protocol: "ueberzug",
        terminal: result.terminal,
        source: `${result.source}; ueberzugpp found (${output} canvas)`,
        ueberzugOutput: output,
      };
    }
  }
  return result;
}

function resolveBaseProtocol({ env, override, queryDA1 }) {
  const wanted = normalizeProtocol(override ?? env.WALLRIZZ_IMAGE_PROTOCOL);
  if (wanted === null) {
    throw new Error(
      `Invalid image protocol "${override ?? env.WALLRIZZ_IMAGE_PROTOCOL}". ` +
        `Expected one of: ${PROTOCOL_CHOICES.join(", ")}`,
    );
  }
  if (wanted !== "auto") {
    return { protocol: wanted, terminal: "override", source: "user override" };
  }

  const probe = (terminal, why) => {
    const response = queryDA1 ? queryDA1() : null;
    if (da1HasSixel(response)) {
      return { protocol: "sixel", terminal, source: `${why}; DA1 advertises sixel` };
    }
    return {
      protocol: "symbols",
      terminal,
      source: `${why}; ${response ? "DA1 has no sixel" : "no DA1 answer"}`,
    };
  };

  const mux = detectMultiplexer(env);
  if (mux) {
    // Graphics passthrough through multiplexers is not handled; tmux (>=3.4,
    // built with sixel) and zellij render sixel themselves and say so in DA1.
    return probe(mux, `inside ${mux}`);
  }

  const detected = detectBrand(env);
  if (detected) {
    const protocol = BRAND_PROTOCOL[detected.brand];
    if (protocol) {
      return { protocol, terminal: detected.brand, source: `env ${detected.via}` };
    }
    return probe(detected.brand, `env ${detected.via}`);
  }

  return probe("unknown", "unknown terminal");
}

/** chafa -f value for a protocol */
export function chafaFormat(protocol) {
  return {
    kitty: "kitty",
    iterm: "iterm",
    sixel: "sixels",
    symbols: "symbols",
  }[protocol] ?? "symbols";
}

/**
 * Parse chafa capabilities from `chafa --version` and `chafa --help` output.
 * @param {string} versionText
 * @param {string} helpText
 * @returns {{version: string, sextant: boolean, octant: boolean, work: boolean, passthrough: boolean}}
 */
export function parseChafaFeatures(versionText = "", helpText = "") {
  const version = /version\s+(\d+\.\d+(?:\.\d+)?)/i.exec(versionText)?.[1] ?? "unknown";
  // symbol class list is a table of words after "Accepted classes"
  const classes = helpText.split(/Accepted classes/i)[1] ?? "";
  return {
    version,
    sextant: /\bsextant\b/.test(classes),
    octant: /\boctant\b/.test(classes),
    work: /--work\b/.test(helpText),
    passthrough: /--passthrough\b/.test(helpText),
  };
}

// Terminals known to draw Unicode 13 sextants (U+1FB00..1FB3B) with a built-in
// font, so they line up with the block elements (Alacritty >= 0.13). Octants
// (U+1CD00, chafa >= 1.16) are not in Alacritty's built-in font, so they are
// only used when explicitly requested.
const SEXTANT_BRANDS = new Set(["alacritty", "kitty", "ghostty", "foot", "wezterm"]);

/**
 * Extra chafa options for the symbols protocol (finer symbols, more work).
 * Falls back to [] (chafa defaults, the pre-1.6 WallRizz behaviour) on chafa
 * builds without the needed features.
 * @param {object} features - parseChafaFeatures() result (or null)
 * @param {string} [brand] - detected terminal brand
 * @param {Record<string,string>} [env]
 * @returns {string[]}
 */
export function chafaSymbolOptions(features, brand, env = {}) {
  if (!features) return [];
  const work = features.work ? ["--work", "9"] : [];
  const custom = env.WALLRIZZ_CHAFA_SYMBOLS;
  if (custom) return ["--symbols", custom, ...work];
  if (!features.work) return [];
  if (features.sextant && SEXTANT_BRANDS.has(brand)) {
    return ["--symbols", "sextant+quad+half+block+space", ...work];
  }
  // quadrants / half / eighth blocks are U+2580..259F: present in nearly every font
  return ["--symbols", "quad+half+block+space", ...work];
}

/**
 * Build the chafa argument vector for drawing an image into a WxH cell box.
 * @param {string} protocol
 * @param {number} columns
 * @param {number} rows
 * @param {Record<string,string>} env
 * @param {object} [opts]
 * @param {boolean} [opts.passthroughNone] - add "--passthrough none" (chafa >= 1.14)
 * @param {string[]} [opts.symbolOptions] - chafaSymbolOptions() result
 * @returns {string[]}
 */
export function chafaArgs(protocol, columns, rows, env, opts = {}) {
  const args = [
    "chafa",
    "-f",
    chafaFormat(protocol),
    "-s",
    `${Math.max(1, Math.floor(columns))}x${Math.max(1, Math.floor(rows))}`,
    "--animate",
    "off",
    "--polite",
    "on",
  ];
  if (protocol === "symbols") {
    const colorterm = (env.COLORTERM ?? "").toLowerCase();
    args.push(
      "-c",
      colorterm === "truecolor" || colorterm === "24bit" ? "full" : "256",
    );
    if (opts.symbolOptions) args.push(...opts.symbolOptions);
  }
  if (opts.passthroughNone) args.push("--passthrough", "none");
  return args;
}

/**
 * Überzug++ JSON commands (one per line on `ueberzugpp layer` stdin), same
 * shape yazi sends. x/y are 0-based terminal cells; the image is scaled to
 * fit max_width x max_height cells keeping its aspect ratio.
 */
export function ueberzugAdd(identifier, x, y, maxWidth, maxHeight, path) {
  return JSON.stringify({
    action: "add",
    identifier,
    x: Math.max(0, Math.round(x)),
    y: Math.max(0, Math.round(y)),
    max_width: Math.max(1, Math.round(maxWidth)),
    max_height: Math.max(1, Math.round(maxHeight)),
    path,
  });
}

export function ueberzugRemove(identifier) {
  return JSON.stringify({ action: "remove", identifier });
}

/**
 * Socket of a running `ueberzugpp layer` (it always listens on one, also in
 * stdin mode): $UEBERZUGPP_TMPDIR, else the C++ temp dir ($TMPDIR, $TMP,
 * $TEMP, $TEMPDIR, /tmp), + /ueberzugpp-<pid>.socket.
 */
export function ueberzugSocketPath(env, pid) {
  const dir = ["UEBERZUGPP_TMPDIR", "TMPDIR", "TMP", "TEMP", "TEMPDIR"]
    .map((name) => env[name])
    .find((value) => value) ?? "/tmp";
  return `${dir.replace(/\/+$/, "") || "/"}/ueberzugpp-${pid}.socket`;
}
