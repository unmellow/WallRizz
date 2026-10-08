// Run with: qjs --module tests/imageProtocol.test.js   (or: node tests/imageProtocol.test.js)
import {
  chafaArgs,
  chafaSymbolOptions,
  parseChafaFeatures,
  da1HasSixel,
  detectBrand,
  normalizeProtocol,
  resolveImageProtocol,
  fitImageInBox,
  parseCellPx,
  pngSize,
  ueberzugAdd,
  ueberzugOutput,
  ueberzugRemove,
  ueberzugSocketPath,
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

// --- Überzug++ ---
const uz = (env, { override, da1 = null, has = true } = {}) =>
  resolveImageProtocol({ env, override, queryDA1: () => da1, hasUeberzug: () => has });
const X = { DISPLAY: ":0" };
const SWAY = { WAYLAND_DISPLAY: "wayland-1", SWAYSOCK: "/run/sway.sock" };
eq("normalize ueberzug", normalizeProtocol("ueberzug"), "ueberzug");
eq("normalize ueberzugpp", normalizeProtocol("UeberzugPP"), "ueberzug");
eq("uz output x11", ueberzugOutput(X), "x11");
eq("uz output x11 session", ueberzugOutput({ XDG_SESSION_TYPE: "x11", DISPLAY: ":1", WAYLAND_DISPLAY: "w" }), "x11");
eq("uz output sway", ueberzugOutput(SWAY), "wayland");
eq("uz output hyprland", ueberzugOutput({ WAYLAND_DISPLAY: "w", HYPRLAND_INSTANCE_SIGNATURE: "x" }), "wayland");
eq("uz output niri", ueberzugOutput({ WAYLAND_DISPLAY: "w", NIRI_SOCKET: "/s" }), "wayland");
eq("uz output wayfire", ueberzugOutput({ WAYLAND_DISPLAY: "w", WAYFIRE_SOCKET: "/s" }), "wayland");
eq("uz output gnome wayland -> none", ueberzugOutput({ WAYLAND_DISPLAY: "w", DISPLAY: ":0", XDG_SESSION_TYPE: "wayland" }), null);
eq("uz output no display", ueberzugOutput({}), null);
eq("uz output env override", ueberzugOutput({ WALLRIZZ_UEBERZUG_OUTPUT: "X11" }), "x11");
eq("uz auto alacritty x11", uz({ TERM: "alacritty", ...X }).protocol, "ueberzug");
eq("uz auto alacritty x11 output", uz({ TERM: "alacritty", ...X }).ueberzugOutput, "x11");
eq("uz auto alacritty sway", uz({ TERM: "alacritty", ...SWAY }).ueberzugOutput, "wayland");
eq("uz auto unknown no sixel", uz({ TERM: "xterm-256color", ...X }).protocol, "ueberzug");
eq("uz auto unknown with sixel stays sixel", uz({ TERM: "xterm-256color", ...X }, { da1: DA1_SIXEL }).protocol, "sixel");
eq("uz auto not installed", uz({ TERM: "alacritty", ...X }, { has: false }).protocol, "symbols");
eq("uz auto no display", uz({ TERM: "alacritty" }).protocol, "symbols");
eq("uz auto gnome wayland", uz({ TERM: "alacritty", WAYLAND_DISPLAY: "w", DISPLAY: ":0" }).protocol, "symbols");
eq("uz auto in tmux", uz({ TERM: "tmux-256color", TMUX: "/tmp/t", ...X }).protocol, "symbols");
eq("uz auto foot keeps sixel", uz({ TERM: "foot", ...SWAY }).protocol, "sixel");
eq("uz auto wezterm keeps iterm", uz({ TERM_PROGRAM: "WezTerm", ...X }).protocol, "iterm");
eq("uz auto kitty keeps kitty", uz({ TERM: "xterm-kitty", ...X }).protocol, "kitty");
eq("uz forced symbols stays symbols", uz({ TERM: "alacritty", ...X }, { override: "symbols" }).protocol, "symbols");
eq("uz forced", uz({ TERM: "foot", ...SWAY }, { override: "ueberzug" }).protocol, "ueberzug");
eq("uz forced env", uz({ TERM: "foot", WALLRIZZ_IMAGE_PROTOCOL: "ueberzug", ...X }).ueberzugOutput, "x11");
eq("uz forced gnome wayland guesses wayland", uz({ WAYLAND_DISPLAY: "w" }, { override: "ueberzug" }).ueberzugOutput, "wayland");
eq("uz forced nothing guesses x11", uz({}, { override: "ueberzug" }).ueberzugOutput, "x11");
eq("uz forced without probe hook", resolveImageProtocol({ env: X, override: "ueberzug" }).protocol, "ueberzug");
eq(
  "uz add json",
  ueberzugAdd("wallrizz-tile-0", 3, 2, 36, 11, "/h/.cache/WallRizz/pic/a b\"c.png"),
  '{"action":"add","identifier":"wallrizz-tile-0","x":3,"y":2,"max_width":36,"max_height":11,"path":"/h/.cache/WallRizz/pic/a b\\\"c.png"}',
);
eq("uz add clamps", JSON.parse(ueberzugAdd("i", -1, -2, 0, 0, "p")), { action: "add", identifier: "i", x: 0, y: 0, max_width: 1, max_height: 1, path: "p" });
eq("uz remove json", ueberzugRemove("wallrizz-tile-3"), '{"action":"remove","identifier":"wallrizz-tile-3"}');
eq("uz socket default", ueberzugSocketPath({}, 42), "/tmp/ueberzugpp-42.socket");
eq("uz socket TMPDIR", ueberzugSocketPath({ TMPDIR: "/run/user/1000/" }, 42), "/run/user/1000/ueberzugpp-42.socket");
eq("uz socket UEBERZUGPP_TMPDIR wins", ueberzugSocketPath({ TMPDIR: "/a", UEBERZUGPP_TMPDIR: "/b" }, 7), "/b/ueberzugpp-7.socket");

// --- fitting images into tiles ---
// 36x11 cells of 10x20 px = 360x220 px
eq("fit 16:9 width-limited", fitImageInBox(600, 338, 36, 11, 10, 20), { columns: 36, rows: 11, dx: 0, dy: 0 });
eq("fit 4:3 height-limited centered", fitImageInBox(451, 338, 36, 11, 10, 20), { columns: 29, rows: 11, dx: 3, dy: 0 });
eq("fit portrait", fitImageInBox(190, 338, 36, 11, 10, 20), { columns: 12, rows: 11, dx: 12, dy: 0 });
eq("fit square", fitImageInBox(338, 338, 36, 11, 10, 20), { columns: 22, rows: 11, dx: 7, dy: 0 });
eq("fit ultrawide vertical centering", fitImageInBox(2100, 300, 36, 11, 10, 20), { columns: 36, rows: 3, dx: 0, dy: 4 });
eq("fit unknown size -> whole box", fitImageInBox(undefined, undefined, 36, 11, 10, 20), { columns: 36, rows: 11, dx: 0, dy: 0 });
eq("fit tiny box", fitImageInBox(600, 338, 1, 1, 10, 20), { columns: 1, rows: 1, dx: 0, dy: 0 });
// property: never larger than the box, and a WezTerm-style height (from the
// width alone) never overflows the box
let fitOk = true;
for (const [iw, ih] of [[600, 338], [451, 338], [190, 338], [338, 338], [600, 100], [100, 600], [599, 337], [1, 1]]) {
  for (const [c, r] of [[36, 11], [32, 10], [7, 3], [100, 38], [1, 5], [5, 1]]) {
    for (const [cw, ch] of [[10, 20], [8, 17], [9, 22], [14, 31]]) {
      const f = fitImageInBox(iw, ih, c, r, cw, ch);
      // (an image narrower than one cell once fitted is clamped to 1 column)
      if (Math.min((c * cw) / iw, (r * ch) / ih) * iw < cw) continue;
      const wezH = (f.columns * cw * ih) / iw;
      if (
        f.columns > c || f.rows > r || f.dx + f.columns > c || f.dy + f.rows > r ||
        wezH > r * ch + 1e-6 || (f.columns * cw) > c * cw
      ) {
        fitOk = false;
        log(`fit overflow ${iw}x${ih} in ${c}x${r} @${cw}x${ch}: ${JSON.stringify(f)} wezH=${wezH}`);
      }
    }
  }
}
eq("fit never exceeds box (incl. WezTerm width-only)", fitOk, true);
eq("cell px", parseCellPx("10x20"), { width: 10, height: 20 });
eq("cell px bad", parseCellPx("x"), null);
eq("cell px null", parseCellPx(null), null);
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 1, 0xc3, 0, 0, 1, 0x52]);
eq("png size", pngSize(png), { width: 451, height: 338 });
eq("png size not png", pngSize(new Uint8Array(24)), null);
eq(
  "uz add with scaler",
  JSON.parse(ueberzugAdd("wallrizz-p0-g1-0", 2, 1, 29, 11, "/t.png", "fit_contain")).scaler,
  "fit_contain",
);
eq("uz add without scaler", "scaler" in JSON.parse(ueberzugAdd("i", 0, 0, 1, 1, "p")), false);

log(`imageProtocol tests: ${passed} passed, ${failed} failed`);
if (failed) {
  if (typeof std !== "undefined") std.exit(1);
  else if (typeof process !== "undefined") process.exit(1);
  else throw new Error("tests failed");
}
