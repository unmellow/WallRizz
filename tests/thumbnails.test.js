/**
 * Thumbnail pool unit tests (run from src/, so the worker module resolves):
 *   cd src && ../quickjs/qjs --std --module ../tests/thumbnails.test.js MOCK WORKDIR
 * MOCK is tests/mock-magick-slow (put on PATH as "magick" by this test).
 */
import * as os from "os";
import * as std from "std";

const [mock, work] = scriptArgs.slice(1);
std.setenv("HOME", `${work}/home`);
os.exec(["rm", "-rf", work]);
os.exec(["mkdir", "-p", `${work}/bin`, `${work}/walls`, `${work}/home`]);
os.symlink(mock, `${work}/bin/magick`);
std.setenv("PATH", `${work}/bin:${std.getenv("PATH")}`);
const log = `${work}/magick.log`;
std.setenv("MOCK_MAGICK_LOG", log);
std.setenv("MOCK_MAGICK_DELAY", "0.2");
os.exec(["magick", "-size", "16x9", "xc:red", `${work}/tpl.png`]);
std.setenv("MOCK_MAGICK_TEMPLATE", `${work}/tpl.png`);
for (let i = 0; i < 6; i++) {
  os.exec(["cp", `${work}/tpl.png`, `${work}/walls/w${i}.png`]);
}

// the module reads HOME at import time
const T = await import("../src/wallpaper/thumbnails.js");

let passed = 0, failed = 0;
const check = (name, ok, info = "") => {
  if (ok) passed++;
  else {
    failed++;
    print(`FAIL ${name} ${info}`);
  }
};
const starts = () =>
  (std.loadFile(log) ?? "").split("\n").filter((l) => l.startsWith("START") && !l.includes("PASS"));
const wait = (ms) => new Promise((r) => os.setTimeout(r, ms));

// --- cache key ---
const st = { mtime: 1000, size: 50 };
const a = T.thumbName("/w/a.jpg", st, "600x338");
check("thumbName is stable", a === T.thumbName("/w/a.jpg", { ...st }, "600x338"));
check("thumbName changes with mtime", a !== T.thumbName("/w/a.jpg", { ...st, mtime: 1001 }, "600x338"));
check("thumbName changes with size", a !== T.thumbName("/w/a.jpg", { ...st, size: 51 }, "600x338"));
check("thumbName changes with the path", a !== T.thumbName("/x/a.jpg", st, "600x338"));
check("thumbName changes with the thumbnail size", a !== T.thumbName("/w/a.jpg", st, "300x169"));
check("thumbName is a PNG named after the file", /^a-[0-9a-f]{8}-1000-50-600x338\.png$/.test(a), a);
check("thumbName sanitises odd names",
  /^my_wall__1_-/.test(T.thumbName("/w/my wall (1).jpg", st, "600x338")));
check("thumbPath of a missing file is null", T.thumbPath(`${work}/nope.jpg`, "600x338") === null);
check("defaultPoolSize is 1..4", T.defaultPoolSize() >= 1 && T.defaultPoolSize() <= 4);
check("parseSize", JSON.stringify(T.parseSize("300x169")) === '{"w":300,"h":169}');

// --- magick slots ---
const S = T.magickSlots;
S.setCap(2);
S.peak = 0;
const order = [];
const job = (n) => S.run(async () => {
  order.push(`s${n}`);
  await wait(30);
  order.push(`e${n}`);
});
await Promise.all([job(1), job(2), job(3)]);
check("slots: never more than the cap", S.peak === 2, `peak ${S.peak}`);
check("slots: the third waits for a free slot", order.indexOf("s3") > Math.min(order.indexOf("e1"), order.indexOf("e2")),
  order.join(" "));
check("slots: all released", S.used === 0, `used ${S.used}`);

// --- pool ---
const pool = new T.ThumbPool({ size: "600x338", poolSize: 2 });
const src = (i) => `${work}/walls/w${i}.png`;
let g = pool.bump();
const made = await Promise.all([0, 1, 2].map((i) => pool.request(src(i), g)));
check("pool: thumbnails made", made.every((p) => p && os.stat(p)[1] === 0), JSON.stringify(made));
check("pool: one batch for a page of 3", starts().length === 1, starts().join(" | "));
check("pool: no temp files", (os.readdir(T.PIC_CACHE_DIR)[0] ?? []).every((n) => !n.endsWith(".tmp")));

// cache hit: no magick
const before = starts().length;
const hit = await pool.request(src(0), g);
check("pool: a cache hit launches no magick", hit === made[0] && starts().length === before);

// dedupe: the same wallpaper twice -> one image in one batch
g = pool.bump();
const [d1, d2] = await Promise.all([pool.request(src(3), g), pool.request(src(3), g)]);
check("pool: duplicate requests share one result", d1 && d1 === d2);
check("pool: duplicate requests make one image", starts().at(-1)?.split(" ").length === 4,
  starts().at(-1));

// stale ticket: started under g, page changed (bump) -> null, file made anyway
g = pool.bump();
const stale = pool.request(src(4), g);
await wait(50); // its batch is running
const g2 = pool.bump();
const queuedLow = pool.request(src(5), g2, { low: true });
check("pool: a stale result is not reported", (await stale) === null);
check("pool: ... but the thumbnail is kept for the next visit", os.stat(T.thumbPath(src(4), "600x338"))[1] === 0);
check("pool: the newer ticket's work still runs", (await queuedLow) !== null);

// dropped before it started
g = pool.bump();
os.exec(["cp", `${work}/tpl.png`, `${work}/walls/w9.png`]);
const dropped = pool.request(src(9), g);
pool.bump(); // before the deferred pump ran
check("pool: queued work of an old ticket is dropped", (await dropped) === null);
await pool.shutdown();
check("pool: shutdown leaves no running magick", pool.busy.size === 0 && pool.pids.size === 0);
check("pool: requests after shutdown resolve null", (await pool.request(src(0), 99)) === null);

print(`thumbnails tests: ${passed} passed, ${failed} failed`);
std.exit(failed ? 1 : 0);
