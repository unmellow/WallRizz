// Run with: qjs --module tests/imageProtocol.test.js   (or: node tests/imageProtocol.test.js)
import {
  chafaArgs,
  chafaSymbolOptions,
  parseChafaFeatures,
  da1HasSixel,
  detectBrand,
  normalizeProtocol,
  resolveImageProtocol,
} from "../src/ui/imageProtocol.js";

let failed = 0;
let passed = 0;
const log = typeof print === "function" ? print : console.log;
const eq = (name, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    passed++;
  } else {
    failed++;
    log(`FAIL ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
  }
};

const DA1_SIXEL = "[?62;4;9;22c"; // ESC stripped, as queryDA1 returns it
const DA1_NOSIXEL = "[?62;22c";
const resolve = (env, { override, da1 = null } = {}) => {
  let probed = false;
  const r = resolveImageProtocol({
    env,
    override,
    queryDA1: () => {
      probed = true;
      return da1;
    },
  });
  return { ...r, probed };
};

const cases = [
  // [name, env, opts, expected protocol, expect DA1 probe]
  ["kitty TERM", { TERM: "xterm-kitty" }, {}, "kitty", false],
  ["kitty window id", { TERM: "xterm-256color", KITTY_WINDOW_ID: "1" }, {}, "kitty", false],
  ["ghostty TERM", { TERM: "xterm-ghostty" }, {}, "kitty", false],
  ["ghostty TERM_PROGRAM", { TERM: "xterm-256color", TERM_PROGRAM: "ghostty" }, {}, "kitty", false],
  ["ghostty resources", { TERM: "xterm-256color", GHOSTTY_RESOURCES_DIR: "/usr/share/ghostty" }, {}, "kitty", false],
  ["wezterm TERM_PROGRAM", { TERM: "xterm-256color", TERM_PROGRAM: "WezTerm", WEZTERM_EXECUTABLE: "/usr/bin/wezterm-gui" }, {}, "iterm", false],
  ["wezterm exe only", { TERM: "xterm-256color", WEZTERM_EXECUTABLE: "/usr/bin/wezterm-gui" }, {}, "iterm", false],
  ["wezterm TERM=wezterm", { TERM: "wezterm" }, {}, "iterm", false],
  ["iTerm2", { TERM: "xterm-256color", TERM_PROGRAM: "iTerm.app" }, {}, "iterm", false],
  ["iTerm2 session", { TERM: "xterm-256color", ITERM_SESSION_ID: "w0t0p0" }, {}, "iterm", false],
  ["konsole", { TERM: "xterm-256color", KONSOLE_VERSION: "240802" }, {}, "kitty", false],
  ["foot", { TERM: "foot" }, {}, "sixel", false],
  ["foot-extra", { TERM: "foot-extra" }, {}, "sixel", false],
  ["mlterm", { TERM: "mlterm" }, {}, "sixel", false],
  ["windows terminal", { TERM: "xterm-256color", WT_SESSION: "abc" }, {}, "sixel", false],
  ["vscode", { TERM: "xterm-256color", TERM_PROGRAM: "vscode" }, {}, "iterm", false],
  ["alacritty TERM", { TERM: "alacritty", COLORTERM: "truecolor" }, {}, "symbols", false],
  ["alacritty xterm-256color + window id", { TERM: "xterm-256color", ALACRITTY_WINDOW_ID: "1" }, {}, "symbols", false],
  ["xterm with sixel", { TERM: "xterm-256color", XTERM_VERSION: "XTerm(390)" }, { da1: DA1_SIXEL }, "sixel", true],
  ["xterm without sixel", { TERM: "xterm-256color", XTERM_VERSION: "XTerm(390)" }, { da1: DA1_NOSIXEL }, "symbols", true],
  ["unknown, DA1 sixel", { TERM: "xterm-256color" }, { da1: DA1_SIXEL }, "sixel", true],
  ["unknown, no DA1 answer", { TERM: "xterm-256color" }, { da1: null }, "symbols", true],
  ["empty env", {}, {}, "symbols", true],
  ["tmux inside kitty (leaked KITTY_WINDOW_ID)", { TERM: "tmux-256color", TMUX: "/tmp/tmux-1000/default,1,0", TERM_PROGRAM: "tmux", KITTY_WINDOW_ID: "1" }, { da1: DA1_NOSIXEL }, "symbols", true],
  ["tmux with sixel", { TERM: "screen-256color", TMUX: "/tmp/x" }, { da1: DA1_SIXEL }, "sixel", true],
  ["zellij", { TERM: "xterm-256color", ZELLIJ: "0" }, { da1: null }, "symbols", true],
  // TERM wins over leaked vars (foot launched from kitty)
  ["foot launched from kitty", { TERM: "foot", KITTY_WINDOW_ID: "3" }, {}, "sixel", false],
  // overrides
  ["env override sixel", { TERM: "xterm-kitty", WALLRIZZ_IMAGE_PROTOCOL: "sixel" }, {}, "sixel", false],
  ["env override alias iterm2", { TERM: "foot", WALLRIZZ_IMAGE_PROTOCOL: "iterm2" }, {}, "iterm", false],
  ["env override auto", { TERM: "foot", WALLRIZZ_IMAGE_PROTOCOL: "auto" }, {}, "sixel", false],
  ["cli override beats env", { TERM: "foot", WALLRIZZ_IMAGE_PROTOCOL: "sixel" }, { override: "symbols" }, "symbols", false],
  ["cli auto -> detect", { TERM: "alacritty" }, { override: "auto" }, "symbols", false],
  ["cli kitty in alacritty", { TERM: "alacritty" }, { override: "kitty" }, "kitty", false],
];

for (const [name, env, opts, want, wantProbe] of cases) {
  const r = resolve(env, opts);
  eq(`${name} protocol`, r.protocol, want);
  eq(`${name} probed`, r.probed, wantProbe);
}

// invalid override throws
let threw = false;
try {
  resolve({ TERM: "foot", WALLRIZZ_IMAGE_PROTOCOL: "bogus" });
} catch (_) {
  threw = true;
}
eq("invalid override throws", threw, true);

// helpers
eq("normalize sixels", normalizeProtocol("SIXELS"), "sixel");
eq("normalize undefined", normalizeProtocol(undefined), "auto");
eq("normalize junk", normalizeProtocol("png"), null);
eq("da1 sixel", da1HasSixel("\x1b[?62;4;22c"), true);
eq("da1 vt220 '?64;1;2;6;9;15;18;21;22c'", da1HasSixel("\x1b[?64;1;2;6;9;15;18;21;22c"), false);
eq("da1 garbage", da1HasSixel("hello"), false);
eq("da1 attr 44 is not 4", da1HasSixel("[?62;44c"), false);
eq("brand foot", detectBrand({ TERM: "foot" })?.brand, "foot");
eq("brand none", detectBrand({ TERM: "xterm-256color" }), null);

eq(
  "chafa args sixel",
  chafaArgs("sixel", 30, 10, {}),
  ["chafa", "-f", "sixels", "-s", "30x10", "--animate", "off", "--polite", "on"],
);
eq(
  "chafa args symbols truecolor",
  chafaArgs("symbols", 30.7, 10, { COLORTERM: "truecolor" }).slice(-2),
  ["-c", "full"],
);
eq(
  "chafa args symbols 256",
  chafaArgs("symbols", 30, 10, {}).slice(-2),
  ["-c", "256"],
);
eq(
  "chafa args passthrough",
  chafaArgs("iterm", 30, 10, {}, { passthroughNone: true }).slice(-2),
  ["--passthrough", "none"],
);

// chafa feature detection / symbol options
const HELP_114 = "  -w, --work=NUM  How hard\n      --passthrough=MODE\nAccepted classes for --symbols and --fill:\n  all ascii braille\n  ambiguous border dot hhalf legacy sextant technical wide\n";
const HELP_116 = HELP_114.replace("sextant", "sextant octant");
const HELP_OLD = "  -w, --work=NUM\nAccepted classes for --symbols and --fill:\n  all ascii block half quad\n";
const f114 = parseChafaFeatures("Chafa version 1.14.5\n", HELP_114);
eq("features 1.14", f114, { version: "1.14.5", sextant: true, octant: false, work: true, passthrough: true });
eq("features 1.16 octant", parseChafaFeatures("Chafa version 1.16.2", HELP_116).octant, true);
eq("features old", parseChafaFeatures("Chafa version 1.6.0", HELP_OLD), { version: "1.6.0", sextant: false, octant: false, work: true, passthrough: false });
eq("symbols alacritty+sextant", chafaSymbolOptions(f114, "alacritty"), ["--symbols", "sextant+quad+half+block+space", "--work", "9"]);
eq("symbols unknown terminal", chafaSymbolOptions(f114, "unknown"), ["--symbols", "quad+half+block+space", "--work", "9"]);
eq("symbols old chafa without sextant", chafaSymbolOptions(parseChafaFeatures("Chafa version 1.6.0", HELP_OLD), "alacritty"), ["--symbols", "quad+half+block+space", "--work", "9"]);
eq("symbols no --work -> chafa defaults", chafaSymbolOptions({ version: "1.0", sextant: false, octant: false, work: false }, "alacritty"), []);
eq("symbols no chafa info -> defaults", chafaSymbolOptions(null, "alacritty"), []);
eq("symbols env override", chafaSymbolOptions(f114, "unknown", { WALLRIZZ_CHAFA_SYMBOLS: "all" }), ["--symbols", "all", "--work", "9"]);
eq(
  "chafa args symbols with options",
  chafaArgs("symbols", 10, 5, { COLORTERM: "truecolor" }, { symbolOptions: ["--work", "9"] }).slice(-4),
  ["-c", "full", "--work", "9"],
);

log(`imageProtocol tests: ${passed} passed, ${failed} failed`);
if (failed) {
  if (typeof std !== "undefined") std.exit(1);
  else if (typeof process !== "undefined") process.exit(1);
  else throw new Error("tests failed");
}
