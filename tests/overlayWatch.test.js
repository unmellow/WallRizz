// Run with: qjs --std --module tests/overlayWatch.test.js <tests dir> <work dir>
// Window-up confirmation (src/ui/overlayWatch.js) and UeberzugLayer.whenUp,
// against tests/mock-swaymsg and tests/mock-ueberzugpp (MOCK_SWAY_EVENTS).
import * as std from "std";
import * as os from "os";
import { JsonStream, ownedBy, WindowWatch, windowWatchKind, HARD_TIMEOUT_MS, FALLBACK_MS, GHOST_CLOSE_MS } from "../src/ui/overlayWatch.js";
import { UeberzugLayer } from "../src/ui/ueberzug.js";

const [, testsDir, work] = scriptArgs;
let passed = 0, failed = 0;
const eq = (name, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) passed++;
  else { failed++; print(`FAIL ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
};
const ok = (name, cond, info = "") => eq(name + (cond ? "" : ` ${info}`), !!cond, true);
const SCALE = Number(std.getenv("WALLRIZZ_TEST_TIMEOUT_SCALE")) || 1;
const waitUntil = async (what, cond, ms = 10000) => {
  const end = Date.now() + ms * SCALE;
  while (!cond()) {
    if (Date.now() >= end) { print(`TIMEOUT waiting for ${what}`); return false; }
    await os.sleepAsync(5);
  }
  return true;
};

// 1. streaming JSON: pretty printed, split anywhere, braces in strings
{
  const s = new JsonStream();
  const text = '{ "change": "new", "container": { "app_id": "a}{\\"b", "nodes": [ ] } }\n{"x":[1,{"y":2}]}{"z":"\\\\"}';
  const got = [];
  for (let i = 0; i < text.length; i += 7) got.push(...s.push(text.slice(i, i + 7)));
  eq("json stream objects", got, [
    { change: "new", container: { app_id: 'a}{"b', nodes: [] } }, { x: [1, { y: 2 }] }, { z: "\\" }]);
  eq("json stream drained", s.buf, "");
}

// 2. ownership: the layer's pid or a descendant (wrapper) within 4 levels
{
  const parents = { 50: 40, 40: 30, 30: 1, 60: 1 };
  const parent = (p) => parents[p] ?? null;
  eq("owned: same pid", ownedBy(30, 30, parent), true);
  eq("owned: grandchild", ownedBy(50, 30, parent), true);
  eq("not owned: other tree", ownedBy(60, 30, parent), false);
  eq("not owned: no layer", ownedBy(30, null, parent), false);
  eq("no /proc: assume owned", ownedBy(70, 30, () => null), true);
}

// 3. kind detection
{
  const bin = `${work}/bin`;
  os.mkdir(work);
  os.mkdir(bin);
  os.symlink(`${testsDir}/mock-swaymsg`, `${bin}/swaymsg`);
  eq("kind sway", windowWatchKind({ SWAYSOCK: "/x", PATH: bin }), "sway");
  eq("kind sway without swaymsg: none", windowWatchKind({ SWAYSOCK: "/x", PATH: "/nonexistent" }), "none");
  eq("kind hyprland without hyprctl: none", windowWatchKind({ HYPRLAND_INSTANCE_SIGNATURE: "x", PATH: "/nonexistent" }), "none");
  eq("kind forced none", windowWatchKind({ SWAYSOCK: "/x", PATH: bin, WALLRIZZ_UEBERZUG_CONFIRM: "none" }), "none");
  eq("kind plain", windowWatchKind({ PATH: bin }), "none");
  std.setenv("PATH", `${bin}:${std.getenv("PATH")}`);
}

// 4. no confirmation: up after FALLBACK_MS
{
  const w = new WindowWatch(() => 1, { kind: "none" });
  let up = null;
  const t0 = Date.now();
  w.sent("a", (how) => { up = { how, ms: Date.now() - t0 }; });
  await waitUntil("fallback", () => up);
  ok("fallback after ~300 ms", up && up.how === "fallback" && up.ms >= FALLBACK_MS - 5, JSON.stringify(up));
  w.stop();
}

// 5. sway: events through the swaymsg child
const events = `${work}/events`;
std.setenv("MOCK_SWAY_EVENTS", events);
std.setenv("SWAYSOCK", `${work}/sway.sock`);
const emit = (pid, id, app = `ueberzugpp_t${id}`, change = "new") => {
  const f = std.open(events, "a");
  f.puts(JSON.stringify({ change, container: { id, app_id: app, pid, visible: true } }) + "\n");
  f.close();
};
{
  const owner = 4242;
  const w = new WindowWatch(() => owner, { kind: "sway", parent: () => 1 });
  eq("sway watcher runs", w.kind, "sway");
  const childPid = w.child?.pid;
  await os.sleepAsync(150); // (swaymsg subscribed)
  const ups = {};
  const sent = (id) => {
    const t0 = Date.now();
    w.sent(id, (how) => { ups[id] = { how, ms: Date.now() - t0 }; });
  };
  sent("a");
  emit(9999, 1); // another process' window: ignored
  emit(owner, 2, "foot"); // not ueberzugpp: ignored
  await os.sleepAsync(60);
  eq("foreign windows ignored", ups.a, undefined);
  emit(owner, 3);
  await waitUntil("a mapped", () => ups.a);
  eq("a confirmed by its window", ups.a?.how, "mapped");
  emit(owner, 3, undefined, "floating"); // same window again: no effect
  // hard timeout, then its late window must not confirm the next add
  sent("b");
  await waitUntil("b timeout", () => ups.b, 3000);
  ok("b: hard timeout ~1 s", ups.b?.how === "timeout" && ups.b.ms >= HARD_TIMEOUT_MS - 5 && ups.b.ms < HARD_TIMEOUT_MS + 400 * SCALE, JSON.stringify(ups.b));
  sent("c");
  emit(owner, 4); // b's late window
  await os.sleepAsync(80);
  eq("late window of a timed-out add doesn't confirm the next", ups.c, undefined);
  emit(owner, 5);
  await waitUntil("c mapped", () => ups.c);
  eq("c confirmed by its own window", ups.c?.how, "mapped");
  // removed before its window appeared: its window is eaten, not credited
  sent("d");
  w.forget("d");
  sent("e");
  emit(owner, 6);
  await os.sleepAsync(80);
  eq("forgotten add: no callback", ups.d, undefined);
  eq("window of a removed add doesn't confirm the next", ups.e, undefined);
  emit(owner, 7);
  await waitUntil("e mapped", () => ups.e);
  eq("e confirmed", ups.e?.how, "mapped");
  w.stop();
  ok("swaymsg child killed on stop", childPid && os.kill(childPid, 0) !== 0);
}

// 6. sway: an add sent before the subscription is surely up uses the short
// fallback, not the 1 s timeout (its event may have been missed)
{
  const w = new WindowWatch(() => 1, { kind: "sway", parent: () => 1 });
  let up = null;
  const t0 = Date.now();
  w.sent("early", (how) => { up = { how, ms: Date.now() - t0 }; });
  await waitUntil("early", () => up, 3000);
  ok("early add: fallback, not the 1 s timeout", up?.how === "fallback-early" && up.ms < HARD_TIMEOUT_MS - 200, JSON.stringify(up));
  w.stop();
}

// 7. sway: an add that timed out and was then removed may never get its
// window: the next window is held until a "close" says whose it was
{
  const owner = 4343;
  const w = new WindowWatch(() => owner, { kind: "sway", parent: () => 1 });
  await os.sleepAsync(150);
  const ups = {};
  const sent = (id) => {
    const t0 = Date.now();
    w.sent(id, (how) => { ups[id] = { how, ms: Date.now() - t0 }; });
  };
  const close = (id) => emit(owner, id, `ueberzugpp_t${id}`, "close");
  sent("g");
  await waitUntil("g timeout", () => ups.g, 3000);
  w.removedUnseen("g"); // (removed; its window never appears)
  sent("h");
  await os.sleepAsync(50);
  emit(owner, 20); // h's window: no close follows
  await waitUntil("h", () => ups.h, 2000);
  ok("removed ghost that never mapped: next window confirms the next add", ups.h?.how === "mapped", JSON.stringify(ups.h));
  sent("i");
  await waitUntil("i timeout", () => ups.i, 3000);
  w.removedUnseen("i");
  sent("j");
  emit(owner, 21); // i's late window, closed at once (its remove was sent)
  close(21);
  await os.sleepAsync(GHOST_CLOSE_MS + 60);
  eq("removed ghost's late window (closed) doesn't confirm the next add", ups.j, undefined);
  emit(owner, 22);
  await waitUntil("j", () => ups.j, 2000);
  eq("next add confirmed by its own window", ups.j?.how, "mapped");
  w.stop();
}

// 8. swaymsg dies: waiting adds degrade to the fallback
{
  const w = new WindowWatch(() => 1, { kind: "sway", parent: () => 1 });
  await os.sleepAsync(150);
  let up = null;
  w.sent("x", (how) => { up = how; });
  os.kill(w.child.pid, 9);
  await waitUntil("degraded", () => up, 3000);
  eq("source gone: fallback", up, "fallback");
  eq("source gone: kind none", w.kind, "none");
  w.stop();
}

// 9. UeberzugLayer.whenUp with the mock's emulated sway windows
{
  const log = `${work}/uz.log`;
  std.setenv("MOCK_UZ_LOG", log);
  std.setenv("MOCK_UZ_MAP_MS", "120");
  const layer = new UeberzugLayer("wayland", { bin: `${testsDir}/mock-ueberzugpp`, confirm: true, spacingMs: 0 });
  eq("layer starts", await layer.start(150), true);
  eq("layer confirm kind", layer.confirmKind(), "sway");
  const t0 = Date.now();
  layer.add("p1", 0, 0, 10, 5, "/x.png");
  const up = await layer.whenUp("p1");
  ok("whenUp: mapped after the mock's map delay", up.how === "mapped" && up.at - t0 >= 110, JSON.stringify({ ...up, ms: up.at - t0 }));
  eq("isUp", layer.isUp("p1"), true);
  const cmdsNow = (std.loadFile(log) ?? "").split("\n").filter((l) => l.startsWith("CMD "));
  eq("wayland: every add is followed by the flushing no-op remove", cmdsNow.slice(0, 2).map((l) => JSON.parse(l.slice(4))).map((c) => `${c.action} ${c.identifier}`),
    ["add p1", "remove wallrizz-flush"]);
  eq("whenUp again: same answer", (await layer.whenUp("p1")).how, "mapped");
  layer.add("p2", 0, 0, 10, 5, "/y.png");
  const p2 = layer.whenUp("p2");
  layer.remove("p2");
  eq("removed before up", (await p2).how, "removed");
  eq("unknown id", (await layer.whenUp("nope")).how, "gone");
  layer.add("p3", 0, 0, 10, 5, "/z.png");
  const p3 = await layer.whenUp("p3");
  eq("next add confirmed by its own window", p3.how, "mapped");
  // p2 was removed before its window was up: the remove waits for the
  // window (else it may never map and no event comes), and p3's add waits
  // for that remove (never more than two overlays)
  const order = (std.loadFile(log) ?? "").split("\n").map((l) =>
    l.startsWith("MAPPED p2") ? "mapped p2" : l.includes('"remove","identifier":"p2"') ? "remove p2"
      : l.includes('"add","identifier":"p3"') ? "add p3" : null).filter(Boolean);
  eq("unconfirmed overlay: removed after its window mapped, next add after that", order, ["mapped p2", "remove p2", "add p3"]);
  const p4 = (layer.add("p4", 0, 0, 1, 1, "/w.png"), layer.whenUp("p4"));
  layer.stop();
  eq("stop resolves waiters", (await p4).how, "dead");
}

print(`overlayWatch tests: ${passed} passed, ${failed} failed`);
if (failed) std.exit(1);
