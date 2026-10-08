// Cache cleanup, --clear-cache / --clear-thumbnails internals, cache path
// (XDG_CACHE_HOME), the Überzug++ page composite and its live render dir.
// Run with: qjs --std --module tests/cache.test.js WORKDIR
import * as os from "os";
import * as std from "std";
import {
  checkRoot,
  cleanupCache,
  clearCache,
  formatBytes,
  makeJudge,
  pidAlive,
} from "../src/wallpaper/cacheCleanup.js";
import { cacheRoot } from "../src/core/cachePaths.js";
import { currentUid, liveRenderDir, sweepDeadPartials, usableDir } from "../src/ui/liveDir.js";
import { compositeRegion, pageComposite, ueberzugOverlayMode } from "../src/ui/pageComposite.js";
import { fitImageInBox } from "../src/ui/imageProtocol.js";
import { cellSizeFromReplies } from "../src/ui/terminalImage.js";

let failed = 0;
let passed = 0;
const eq = (name, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) passed++;
  else {
    failed++;
    print(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
};
const ok = (name, cond, info = "") => eq(name + (cond ? "" : ` ${info}`), !!cond, true);

const work = scriptArgs[1];
if (!work || !work.startsWith("/tmp/")) throw new Error("usage: cache.test.js /tmp/WORKDIR");
os.exec(["rm", "-rf", work]);
const mkdirs = (p) => os.exec(["mkdir", "-p", p]);
const write = (p, text = "x") => {
  const f = std.open(p, "w");
  f.puts(text);
  f.close();
};
const exists = (p) => os.lstat(p)[1] === 0;
const PID = os.getpid();
// a pid that is not running (pid_max is at most 2^22)
let DEAD = 4194300;
while (pidAlive(DEAD)) DEAD--;
const HOUR = 3600 * 1000;

// ---- cache root: XDG_CACHE_HOME, else HOME ----
eq("cacheRoot XDG", cacheRoot({ XDG_CACHE_HOME: "/x/c", HOME: "/h" }), "/x/c/WallRizz/");
eq("cacheRoot XDG trailing slash", cacheRoot({ XDG_CACHE_HOME: "/x/c/", HOME: "/h" }), "/x/c/WallRizz/");
eq("cacheRoot HOME", cacheRoot({ HOME: "/h" }), "/h/.cache/WallRizz/");
eq("cacheRoot relative XDG ignored", cacheRoot({ XDG_CACHE_HOME: "rel", HOME: "/h" }), "/h/.cache/WallRizz/");
eq("cacheRoot nothing", cacheRoot({}), null);

// ---- path guards ----
const home = `${work}/home`;
mkdirs(`${home}/.cache/WallRizz`);
const genv = { HOME: home };
for (const [name, root] of [
  ["empty", ""],
  ["slash", "/"],
  ["relative", "cache/WallRizz/"],
  ["/tmp", "/tmp/"],
  ["HOME", `${home}/`],
  ["not .../WallRizz/", `${home}/.cache/`],
  ["dot-dot", `${home}/.cache/../.cache/WallRizz/`],
  ["one component", "/WallRizz/"],
  ["nohome fallback", "/tmp/WallRizz-nohome/"],
]) ok(`checkRoot refuses ${name}`, !checkRoot(root, genv).ok, root);
ok("checkRoot accepts ~/.cache/WallRizz/", checkRoot(`${home}/.cache/WallRizz/`, genv).ok);
ok("checkRoot accepts a missing root (nothing to do)", checkRoot(`${work}/none/WallRizz/`, genv).ok);
mkdirs(`${work}/evil1`);
os.symlink("/", `${work}/evil1/WallRizz`);
ok("checkRoot refuses WallRizz -> /", !checkRoot(`${work}/evil1/WallRizz/`, genv).ok);
mkdirs(`${work}/evil2`);
os.symlink(home, `${work}/evil2/WallRizz`);
ok("checkRoot refuses WallRizz -> $HOME", !checkRoot(`${work}/evil2/WallRizz/`, genv).ok);
eq("cleanupCache refuses a bad root", cleanupCache({ root: "/", current: [], capBytes: 0, runStart: 0, pid: PID, env: genv }).ok, false);
eq("clearCache refuses a bad root", clearCache({ root: `${home}/`, pid: PID, env: genv }).ok, false);
ok("refusals removed nothing", exists(`${home}/.cache/WallRizz`));

// ---- judge ----
const srcDir = `${work}/walls`;
const otherDir = `${work}/other`;
mkdirs(srcDir);
mkdirs(otherDir);
write(`${srcDir}/a.jpg`);
write(`${srcDir}/b.jpg`);
write(`${otherDir}/u.jpg`);
const K = "a-0000000a-1000-1-600x338"; // current
const S = "a-0000000a-999-1-600x338"; // stale: same path, old mtime
const B = "b-0000000b-1000-1-600x338"; // current
const G = "g-0000000c-1000-1-600x338"; // source gone (in sources.json)
const U = "u-0000000d-1000-1-600x338"; // unscanned dir, source still there
const X = "x-0000000e-1000-1-600x338"; // never seen
const current = [{ id: K, path: `${srcDir}/a.jpg` }, { id: B, path: `${srcDir}/b.jpg` }];
const sources = { [G]: `${srcDir}/g.jpg`, [U]: `${otherDir}/u.jpg` };
const judge = makeJudge(current, sources);
eq("judge keep", judge(K), "keep");
eq("judge stale", judge(S), "stale");
eq("judge gone", judge(G), "gone");
eq("judge unscanned", judge(U), "unscanned");
eq("judge unknown", judge(X), "unknown");
eq("judge legacy dev+inode", judge("12345678"), "legacy");
eq("judge foreign", judge("notes"), "foreign");

// ---- cleanup ----
const root = `${work}/cache/WallRizz/`;
const r = root.slice(0, -1);
for (const d of ["pic", "tiles/v1/x", "tiles/v2", "composites", "themes"]) mkdirs(`${r}/${d}`);
write(`${r}/sources.json`, JSON.stringify(sources));
for (const id of [K, S, B, G, U, X]) write(`${r}/pic/${id}.png`, "png");
write(`${r}/pic/12345678.png`, "legacy");
write(`${r}/tiles/v1/x/old.out`, "v1");
write(`${r}/tiles/v2/${K}~1a2b.b64`, "t");
write(`${r}/tiles/v2/${S}~20x5-1a2b.out`, "t");
write(`${r}/tiles/v2/${G}~1a2b.b64`, "t");
write(`${r}/composites/page-aaaa.png`, "c");
write(`${r}/composites/page-aaaa.txt`, `${K}\n${B}\n`);
write(`${r}/composites/page-bbbb.png`, "c");
write(`${r}/composites/page-bbbb.txt`, `${K}\n${S}\n`);
write(`${r}/composites/page-cccc.png`, "c"); // no list
write(`${r}/composites/partial-${DEAD}-1.png`, "p");
write(`${r}/composites/partial-${PID}-1.png`, "p");
write(`${r}/themes/${K}.png-dark.conf`, "t");
write(`${r}/themes/${S}.png-light.conf`, "t");
write(`${r}/themes/${U}.png-dark.conf`, "t");
write(`${r}/colours.json`, JSON.stringify({ [`${K}.png`]: [1], [`${G}.png`]: [2], [`${U}.png`]: [3] }));
write(`${r}/pic/${K}.png.${PID}-1.tmp`, "mine");
write(`${r}/pic/${K}.png.${DEAD}-1.tmp`, "dead");
write(`${r}/pic/recent.png.tmp`, "anon");
write(`${r}/pic/old.png.tmp`, "anon");
os.utimes(`${r}/pic/old.png.tmp`, Date.now() - 2 * HOUR, Date.now() - 2 * HOUR);
// outside the cache: a symlink in pic/ named like a stale thumbnail, and a
// symlinked composites dir must never lead to the targets
write(`${work}/outside.png`, "keep me");
os.symlink(`${work}/outside.png`, `${r}/pic/${S.replace("999", "998")}.png`);
mkdirs(`${work}/outdir`);
write(`${work}/outdir/page-dddd.png`, "keep me");
mkdirs(`${work}/cache2/WallRizz`);
os.symlink(`${work}/outdir`, `${work}/cache2/WallRizz/composites`);

const rep = cleanupCache({ root, current, capBytes: 0, runStart: Date.now(), pid: PID, env: genv });
ok("cleanup ok", rep.ok, rep.why);
const gone = (p) => !exists(`${r}/${p}`);
ok("current thumbnail kept", !gone(`pic/${K}.png`));
ok("stale thumbnail removed", gone(`pic/${S}.png`));
ok("gone-source thumbnail removed", gone(`pic/${G}.png`));
ok("unscanned-dir thumbnail kept (source exists)", !gone(`pic/${U}.png`));
ok("unknown thumbnail kept", !gone(`pic/${X}.png`));
ok("legacy pic name removed", gone("pic/12345678.png"));
ok("tiles/v1 removed", gone("tiles/v1"));
ok("current tile kept", !gone(`tiles/v2/${K}~1a2b.b64`));
ok("stale tile removed", gone(`tiles/v2/${S}~20x5-1a2b.out`));
ok("gone tile removed", gone(`tiles/v2/${G}~1a2b.b64`));
ok("composite of current thumbnails kept", !gone("composites/page-aaaa.png") && !gone("composites/page-aaaa.txt"));
ok("composite with a stale thumbnail removed (+ list)", gone("composites/page-bbbb.png") && gone("composites/page-bbbb.txt"));
ok("composite without list removed", gone("composites/page-cccc.png"));
ok("dead run's partial removed", gone(`composites/partial-${DEAD}-1.png`));
ok("own partial kept", !gone(`composites/partial-${PID}-1.png`));
ok("current theme kept", !gone(`themes/${K}.png-dark.conf`));
ok("stale theme removed", gone(`themes/${S}.png-light.conf`));
ok("unscanned theme kept", !gone(`themes/${U}.png-dark.conf`));
eq("colour keys to drop", rep.colourKeys, [`${G}.png`]);
ok("own temp file kept", !gone(`pic/${K}.png.${PID}-1.tmp`));
ok("dead writer's temp file removed", gone(`pic/${K}.png.${DEAD}-1.tmp`));
ok("recent anonymous temp kept", !gone("pic/recent.png.tmp"));
ok("old anonymous temp removed", gone("pic/old.png.tmp"));
ok("symlink target outside the cache untouched", exists(`${work}/outside.png`));
const src = JSON.parse(std.loadFile(`${r}/sources.json`));
ok("sources.json: current + unscanned kept, gone dropped", src[K] && src[B] && src[U] && !src[G]);
ok("freed bytes reported", rep.freed > 0 && rep.removed.length > 10, JSON.stringify(rep.removed.length));
const rep2 = cleanupCache({ root: `${work}/cache2/WallRizz/`, current, capBytes: 0, runStart: Date.now(), pid: PID, env: genv });
ok("symlinked composites dir not followed", rep2.ok && exists(`${work}/outdir/page-dddd.png`));

// ---- size cap: oldest first, never what this run used ----
const capRoot = `${work}/cap/WallRizz/`;
mkdirs(`${capRoot}pic`);
const ids = [];
const now = Date.now();
for (let i = 0; i < 6; i++) {
  const id = `c${i}-0000001${i}-1000-1-600x338`;
  ids.push(id);
  write(`${capRoot}pic/${id}.png`, "y".repeat(1000));
  const t = now - (10 - i) * HOUR; // c0 oldest
  os.utimes(`${capRoot}pic/${id}.png`, t, t);
}
os.utimes(`${capRoot}pic/${ids[0]}.png`, now, now); // used by this run
const capRep = cleanupCache({
  root: capRoot,
  current: ids.map((id) => ({ id, path: `${srcDir}/a.jpg` })),
  capBytes: 3500,
  runStart: now - 1000,
  pid: PID,
  env: genv,
});
const left = ids.filter((id) => exists(`${capRoot}pic/${id}.png`));
eq("cap: oldest removed first, this run's file kept", left, [ids[0], ids[4], ids[5]]);
ok("cap: total under the cap", capRep.imageBytes <= 3500, String(capRep.imageBytes));

// ---- clearCache ----
const clr = `${work}/clr/WallRizz/`;
for (const d of ["pic", "tiles/v2", "composites", "themes"]) mkdirs(clr + d);
write(`${clr}pic/a.png`, "1234");
write(`${clr}tiles/v2/a~1.b64`, "12");
write(`${clr}composites/page-a.png`, "123");
write(`${clr}fullscreen.jpg`, "1");
write(`${clr}themes/a.png-dark.conf`, "t");
write(`${clr}colours.json`, "{}");
write(`${clr}pic/b.png.${PID}-1.tmp`, "own");
const t1 = clearCache({ root: clr, thumbnailsOnly: true, pid: PID, env: genv });
ok("clear thumbnails ok", t1.ok, t1.why);
ok("clear thumbnails: images gone", !exists(`${clr}pic/a.png`) && !exists(`${clr}tiles/v2/a~1.b64`) &&
  !exists(`${clr}composites/page-a.png`) && !exists(`${clr}fullscreen.jpg`));
ok("clear thumbnails: colours and themes kept", exists(`${clr}themes/a.png-dark.conf`) && exists(`${clr}colours.json`));
eq("clear thumbnails: freed bytes", t1.freed, 4 + 2 + 3 + 1 + 3);
const t2 = clearCache({ root: clr, pid: PID, env: genv });
ok("clear all ok", t2.ok && t2.files >= 2, JSON.stringify(t2));
ok("clear all: root removed", !exists(clr));
const t3 = clearCache({ root: clr, pid: PID, env: genv });
ok("clear all on a missing root: ok, nothing", t3.ok && t3.files === 0);
eq("formatBytes", [formatBytes(0), formatBytes(1536), formatBytes(5 * 1024 * 1024)], ["0 B", "1.5 KB", "5.0 MB"]);

// ---- live render dir ----
const uid = currentUid();
ok("uid known", uid !== null);
const shm = `${work}/shm`;
mkdirs(shm);
const run = `${work}/run`;
mkdirs(run);
os.exec(["chmod", "700", run]);
eq("live dir: shm first", liveRenderDir({ XDG_RUNTIME_DIR: run }, "/fb/", { shm, uid }), `${shm}/wallrizz-${uid}/`);
eq("live dir created 0700", os.lstat(`${shm}/wallrizz-${uid}`)[0].mode & 0o777, 0o700);
const shm2 = `${work}/shm2`;
mkdirs(`${shm2}/wallrizz-${uid}`);
os.exec(["chmod", "755", `${shm2}/wallrizz-${uid}`]);
eq("live dir: group/other-accessible dir refused -> XDG_RUNTIME_DIR",
  liveRenderDir({ XDG_RUNTIME_DIR: run }, "/fb/", { shm: shm2, uid }), `${run}/wallrizz/`);
const shm3 = `${work}/shm3`;
mkdirs(`${shm3}`);
mkdirs(`${work}/elsewhere`);
os.symlink(`${work}/elsewhere`, `${shm3}/wallrizz-${uid}`);
eq("live dir: planted symlink refused -> cache fallback",
  liveRenderDir({}, "/fb/", { shm: shm3, uid }), "/fb/");
ok("usableDir refuses a dir owned by someone else", !usableDir(`${work}/own2/`, uid + 1));
eq("live dir: no /dev/shm, no runtime dir -> cache", liveRenderDir({}, "/fb/", { shm: `${work}/none`, uid }), "/fb/");
const live = `${shm}/wallrizz-${uid}/`;
write(`${live}partial-${DEAD}-3.png`);
write(`${live}partial-${PID}-1.png`);
write(`${live}partial-1-1.png`); // pid 1: alive (EPERM)
write(`${live}notes.txt`);
eq("sweep removes only dead runs' partials", sweepDeadPartials(live, PID), 1);
ok("sweep kept own, live and unrelated files",
  exists(`${live}partial-${PID}-1.png`) && exists(`${live}partial-1-1.png`) && exists(`${live}notes.txt`));

// ---- overlay mode ----
eq("overlay: wayland -> page", ueberzugOverlayMode("wayland", {}), "page");
eq("overlay: x11 -> tile", ueberzugOverlayMode("x11", {}), "tile");
eq("overlay: env page", ueberzugOverlayMode("x11", { WALLRIZZ_UEBERZUG_OVERLAY: "page" }), "page");
eq("overlay: env tile", ueberzugOverlayMode("wayland", { WALLRIZZ_UEBERZUG_OVERLAY: "tile" }), "tile");
eq("overlay: junk env ignored", ueberzugOverlayMode("wayland", { WALLRIZZ_UEBERZUG_OVERLAY: "x" }), "page");

// ---- cell size replies ----
eq("cell: 16t", cellSizeFromReplies("[6;15;7t[4;600;980t[?62c", [140, 40]), "7x15");
eq("cell: 14t only (Alacritty)", cellSizeFromReplies("[4;600;980t[?62c", [140, 40]), "7x15");
eq("cell: nothing", cellSizeFromReplies("[?62c", [140, 40]), null);
eq("cell: 14t without grid size", cellSizeFromReplies("[4;600;980t", undefined), null);

// ---- page composite positions ----
const cell = { width: 7, height: 15 };
const boxes = [
  { x: 2, y: 3, columns: 20, rows: 6 },
  { x: 24, y: 3, columns: 20, rows: 6 },
  { x: 2, y: 11, columns: 20, rows: 6 },
  { x: 24, y: 11, columns: 20, rows: 6 },
];
const region = compositeRegion(boxes);
eq("region = union of boxes", [region.x, region.y, region.columns, region.rows], [2, 3, 42, 14]);
const tiles = [
  { i: 0, src: "/a.png", id: "a", width: 600, height: 338 },
  { i: 1, src: "/b.png", id: "b", width: 338, height: 600 }, // portrait
  { i: 3, src: "/d.png", id: "d", width: 600, height: 600 },
];
const c = pageComposite({ boxes, tiles, cell });
eq("composite size = region in pixels", [c.width, c.height], [42 * 7, 14 * 15]);
eq("missing tile (2) left out", c.items.map((it) => it.i), [0, 1, 3]);
for (const it of c.items) {
  const t = tiles.find((x) => x.i === it.i);
  const b = boxes[it.i];
  const fit = fitImageInBox(t.width, t.height, b.columns, b.rows, cell.width, cell.height);
  const bw = fit.columns * cell.width;
  const bh = fit.rows * cell.height;
  const s = Math.min(bw / t.width, bh / t.height);
  const w = Math.max(1, Math.round(t.width * s));
  const h = Math.max(1, Math.round(t.height * s));
  eq(`tile ${it.i} size`, [it.w, it.h], [w, h]);
  eq(`tile ${it.i} position`, [it.x, it.y], [
    (b.x + fit.dx - region.x) * cell.width + Math.floor((bw - w) / 2),
    (b.y + fit.dy - region.y) * cell.height + Math.floor((bh - h) / 2),
  ]);
  ok(`tile ${it.i} inside its box`, it.x >= (b.x - region.x) * cell.width &&
    it.x + it.w <= (b.x - region.x + b.columns) * cell.width &&
    it.y >= (b.y - region.y) * cell.height && it.y + it.h <= (b.y - region.y + b.rows) * cell.height);
}
eq("first tile exact", [c.items[0].x, c.items[0].y, c.items[0].w, c.items[0].h], [0, 5, 140, 79]); // 140x90 px box: 600x338 -> 140x79, (90-79)/2 = 5
eq("key stable", pageComposite({ boxes, tiles, cell }).key, c.key);
ok("key changes with a thumbnail", pageComposite({ boxes, tiles: [{ ...tiles[0], id: "a2" }, ...tiles.slice(1)], cell }).key !== c.key);
ok("key changes with the cell size", pageComposite({ boxes, tiles, cell: { width: 8, height: 16 } }).key !== c.key);
ok("key changes with the layout", pageComposite({ boxes: boxes.map((b) => ({ ...b, rows: 5 })), tiles, cell }).key !== c.key);

print(`cache tests: ${passed} passed, ${failed} failed`);
if (failed) std.exit(1);
