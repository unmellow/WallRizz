// Run with: qjs --std --module tests/scan.test.js <tree-root>
// Expects the tree created by tests/make-scan-tree.sh
import * as os from "os";
import * as std from "std";
import { scanWallpapers } from "../src/wallpaper/scan.js";

const root = scriptArgs[1].replace(/\/?$/, "/");
let passed = 0, failed = 0;
const eq = (name, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) passed++;
  else {
    failed++;
    print(`FAIL ${name}:\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`);
  }
};
const scan = (opts) => scanWallpapers(root, { ...opts, fs: os }).map((w) => w.name).sort();
const ids = (opts) => scanWallpapers(root, { ...opts, fs: os }).map((w) => `${w.dev}${w.ino}`);

const top = ["a.jpg", "b.png", "same.jpg", "toplink.png"];
const d2 = ["external/o1.png", "favorites/f1.webp", "favorites/same.jpg", "space dir/s#1.png"];
const d3 = ["favorites/nsfw/n1.png", "favorites/nsfw/same.jpg", "favorites/x.jpg/inside.png"];
const d4 = ["favorites/nsfw/landscape/l1.jpg", "favorites/nsfw/landscape/same.jpg"];
const linked = ["linked-favs/f1.webp", "linked-favs/same.jpg"]; // symlink to favorites (dup dir)
const sorted = (a) => [...a].sort();

eq("non-recursive = top level only", scan({}), sorted(top));
eq("depth 1", scan({ recursive: true, depth: 1 }), sorted(top));
eq("depth 2", scan({ recursive: true, depth: 2 }), sorted([...top, ...d2]));
eq("depth 3", scan({ recursive: true, depth: 3 }), sorted([...top, ...d2, ...d3]));
const all = scan({ recursive: true });
eq("unlimited contains deepest", d4.every((p) => all.includes(p)), true);
eq("no hidden dirs", all.some((p) => p.split("/").some((c) => c.startsWith("."))), false);
eq("unlimited = depth 99", all, scan({ recursive: true, depth: 99 }));
// favorites is reached either directly or via linked-favs, never both
eq(
  "symlinked dup dir scanned once",
  all.filter((p) => p.endsWith("f1.webp")).length,
  1,
);
eq("loop terminates & finite", all.length < 50, true);
// toplink.png -> b.png is the same file, so it legitimately shares b.png's id
const uniq = scanWallpapers(root, { recursive: true, fs: os })
  .filter((w) => w.name !== "toplink.png").map((w) => `${w.dev}${w.ino}`);
eq("unique cache ids (same name, different folders)", new Set(uniq).size, uniq.length);
eq("linked-favs never used (real path wins)", all.some((p) => p.startsWith("linked-favs/")), false);
eq("symlinked dir outside tree is scanned", all.includes("external/o1.png"), true);
eq("x.jpg dir is descended, not treated as image", all.includes("favorites/x.jpg"), false);
eq("same.jpg found in 4 folders", all.filter((p) => p.endsWith("same.jpg")).length, 4);
// recursive flag but depth given without flag handled by caller; here depth w/o recursive = non-recursive
eq("depth ignored unless recursive (caller sets recursive)", scan({ depth: 3 }), sorted(top));

let threw = false;
try { scanWallpapers("/nonexistent-dir/", { fs: os }); } catch (_) { threw = true; }
eq("missing root throws", threw, true);

print(`scan tests: ${passed} passed, ${failed} failed`);
print("unlimited result:\n  " + all.join("\n  "));
std.exit(failed ? 1 : 0);
