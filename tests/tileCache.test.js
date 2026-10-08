// Run with: HOME=<tmp> qjs --std --module tests/tileCache.test.js <image.png>
import * as std from "std";
import * as os from "os";
import { base64Bytes, fnv1a, Limiter, TileCache, TILE_CACHE_DIR } from "../src/ui/tileCache.js";

const img = scriptArgs[1];
let passed = 0, failed = 0;
const eq = (name, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) passed++;
  else { failed++; print(`FAIL ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
};
const bytes = (s) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));

eq("b64 empty", base64Bytes(bytes("")), "");
eq("b64 f", base64Bytes(bytes("f")), "Zg==");
eq("b64 fo", base64Bytes(bytes("fo")), "Zm8=");
eq("b64 foo", base64Bytes(bytes("foo")), "Zm9v");
eq("b64 foobar", base64Bytes(bytes("foobar")), "Zm9vYmFy");
eq("b64 binary", base64Bytes(new Uint8Array([0, 255, 128, 1])), "AP+AAQ==");
eq("fnv1a empty", fnv1a(""), "811c9dc5");
eq("fnv1a a", fnv1a("a"), "e40c292c");

// Limiter: bounded, high lane before low lane, cancel drops pending
const order = [];
let running = 0, maxRunning = 0;
const lim = new Limiter(2);
const job = (name) => () => new Promise((res) => {
  running++; maxRunning = Math.max(maxRunning, running); order.push(name);
  os.setTimeout(() => { running--; res(name); }, 20);
});
const results = await Promise.all([
  lim.schedule(job("h1")), lim.schedule(job("h2")),
  lim.schedule(job("low1"), { low: true }), lim.schedule(job("h3")),
]);
eq("limiter results", results, ["h1", "h2", "low1", "h3"]);
eq("limiter max parallel", maxRunning, 2);
eq("limiter high before low", order.indexOf("h3") < order.indexOf("low1"), true);
const lim2 = new Limiter(1);
const a = lim2.schedule(job("a"));
const b = lim2.schedule(job("b"));
lim2.cancelPending();
eq("cancel pending", await Promise.all([a, b]), ["a", null]);

// TileCache: encode once, then memory hit, then disk hit in a new instance
for (const protocol of ["symbols", "sixel", "iterm"]) {
  const t1 = new TileCache({ protocol, cellPx: "10x20", limit: 2 });
  const out1 = await t1.get(img, 20, 6);
  eq(`${protocol} encoded once`, t1.stats.encoded, 1);
  const out2 = await t1.get(img, 20, 6);
  eq(`${protocol} memory hit`, [t1.stats.encoded, t1.stats.memory, out2 === out1], [1, 1, true]);
  const t2 = new TileCache({ protocol, cellPx: "10x20", limit: 2 });
  const out3 = t2.peek(img, 20, 6);
  eq(`${protocol} disk hit after relaunch`, [t2.stats.disk, t2.stats.encoded, out3 === out1], [1, 0, true]);
  eq(`${protocol} different box -> miss`, protocol === "iterm" ? t2.peek(img, 30, 9) !== null : t2.peek(img, 30, 9) === null, true);
  const prefix = { symbols: "\x1b[0m", sixel: "\x1bP", iterm: "\x1b]1337;File=inline=1;" }[protocol];
  eq(`${protocol} output prefix`, out1.startsWith(prefix), true);
  if (protocol === "iterm") {
    eq("iterm payload is JPEG", out1.split(":")[1].startsWith("/9j/"), true);
    eq("iterm keeps aspect, box in cells", /width=20;height=6;preserveAspectRatio=1/.test(out1), true);
  }
}
const [files] = os.readdir(TILE_CACHE_DIR + "symbols/");
eq("tile written to disk", files.filter((f) => f.endsWith(".out")).length, 1);

print(`tileCache tests: ${passed} passed, ${failed} failed`);
std.exit(failed ? 1 : 0);
