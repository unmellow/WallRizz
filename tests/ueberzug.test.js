// Run with: qjs --std --module tests/ueberzug.test.js <path to tests/mock-ueberzugpp> <log file>
// Drives the real UeberzugLayer against a mock ueberzugpp that records stdin.
import * as std from "std";
import * as os from "os";
import { FLUSH_ID, UeberzugLayer } from "../src/ui/ueberzug.js";

const [, mock, log] = scriptArgs;
const times = log + ".times";
let passed = 0, failed = 0;
const eq = (name, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) passed++;
  else { failed++; print(`FAIL ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
};
const readLog = () => (std.loadFile(log) ?? "").split("\n").filter(Boolean);
const readAllTimes = () =>
  (std.loadFile(times) ?? "").split("\n").filter(Boolean).map((l) => {
    const [t, action, id] = l.split(" ");
    return { t: Number(t) * 1000, action, id };
  });
// (without the no-op removes that follow every Wayland add, see FLUSH_ID)
const readTimes = () => readAllTimes().filter((x) => x.id !== FLUSH_ID);
const gone = (pid) => os.kill(pid, 0) !== 0; // reaped -> ESRCH
// Condition-based waits (no fixed sleeps), generous deadline, scaled by
// WALLRIZZ_TEST_TIMEOUT_SCALE for slow or busy machines.
const SCALE = Number(std.getenv("WALLRIZZ_TEST_TIMEOUT_SCALE")) || 1;
const waitUntil = async (what, cond, ms = 30000) => {
  const limit = ms * SCALE;
  const end = Date.now() + limit;
  while (!cond()) {
    if (Date.now() >= end) {
      print(`TIMEOUT after ${limit / 1000}s waiting for ${what}`);
      return false;
    }
    await os.sleepAsync(5);
  }
  return true;
};
// what the layer writes, timed on WallRizz's side (the mock's own read
// times jitter on a busy machine)
const recordWrites = (layer) => {
  const sent = [];
  const write = layer.write.bind(layer);
  layer.write = (line) => {
    sent.push({ t: Date.now(), line });
    return write(line);
  };
  return sent;
};
const reset = () => {
  os.remove(log);
  os.remove(times);
};
std.setenv("MOCK_UZ_LOG", log);
std.setenv("MOCK_UZ_TIMES", times);

// 1. normal session (commands in order, tracking, stop)
reset();
let layer = new UeberzugLayer("x11", { bin: mock, spacingMs: 20 });
eq("starts", await layer.start(100), true);
const pid = layer.pid;
eq("socket path", layer.socketPath(), `${std.getenv("UEBERZUGPP_TMPDIR") || std.getenv("TMPDIR") || "/tmp"}/ueberzugpp-${pid}.socket`);
layer.add("wallrizz-tile-0", 2, 1, 36, 11, "/c/pic/a b.png");
layer.add("wallrizz-tile-1", 40, 1, 36, 11, '/c/pic/q"uote.png');
layer.remove("wallrizz-tile-0");
layer.add("wallrizz-tile-2", 78, 1, 36, 11, "/c/pic/ü.png");
eq("adds are queued, not burst", layer.pending() > 0, true);
await layer.idle();
eq("tracks shown", [...layer.shown].sort(), ["wallrizz-tile-1", "wallrizz-tile-2"]);
layer.removeAll();
await layer.idle();
eq("removeAll clears", layer.shown.size, 0);
layer.add("wallrizz-full-g1", 0, 0, 120, 39, "/w/full.jpg", "fit_contain");
await layer.idle();
layer.stop();
await waitUntil("the stopped mock to log EOF and be reaped",
  () => gone(pid) && readLog().includes("EOF"));
eq("stopped process reaped", gone(pid), true);
eq("log", readLog(), [
  "ARGV layer --silent -o x11",
  'CMD {"action":"add","identifier":"wallrizz-tile-0","x":2,"y":1,"max_width":36,"max_height":11,"path":"/c/pic/a b.png"}',
  'CMD {"action":"add","identifier":"wallrizz-tile-1","x":40,"y":1,"max_width":36,"max_height":11,"path":"/c/pic/q\\"uote.png"}',
  'CMD {"action":"remove","identifier":"wallrizz-tile-0"}',
  'CMD {"action":"add","identifier":"wallrizz-tile-2","x":78,"y":1,"max_width":36,"max_height":11,"path":"/c/pic/ü.png"}',
  'CMD {"action":"remove","identifier":"wallrizz-tile-1"}',
  'CMD {"action":"remove","identifier":"wallrizz-tile-2"}',
  'CMD {"action":"add","identifier":"wallrizz-full-g1","x":0,"y":0,"max_width":120,"max_height":39,"path":"/w/full.jpg","scaler":"fit_contain"}',
  'CMD {"action":"remove","identifier":"wallrizz-full-g1"}',
  "EOF",
]);
eq("calls after stop are no-ops", (layer.add("x", 0, 0, 1, 1, "p"), layer.shown.size), 0);

// 2. spacing: one command per write, adds >= spacingMs apart
reset();
layer = new UeberzugLayer("wayland", { bin: mock, spacingMs: 40 });
await layer.start(100);
let sent = recordWrites(layer);
for (let i = 0; i < 8; i++) layer.add(`p0-g1-${i}`, i, 0, 5, 5, `/t/${i}.png`);
await layer.idle();
await waitUntil("the mock to read 8 adds",
  () => readTimes().filter((x) => x.action === "add").length >= 8);
let ts = readTimes().filter((x) => x.action === "add");
eq("spacing: all adds sent", ts.length, 8);
const sentAdds = sent.filter((x) => x.line.includes('"action":"add"'));
eq("spacing: one write per add", sentAdds.length, 8);
const gaps = sentAdds.slice(1).map((x, i) => x.t - sentAdds[i].t);
const spanOk = sentAdds.at(-1).t - sentAdds[0].t >= 7 * 40;
const gapsOk = gaps.every((g) => g >= 40);
eq("spacing: 8 adds span >= 7 x 40 ms", spanOk, true);
eq("spacing: no two adds written closer than 40 ms", gapsOk, true);
if (!spanOk || !gapsOk) print("gaps " + gaps.map((g) => g.toFixed(1)).join(" "));
eq("spacing: default wayland spacing is 150 ms", new UeberzugLayer("wayland").spacingMs, 150);

// 3. page change: queued adds of the old page are cancelled, never sent
reset();
// (a long spacing: the page change below must land between the first and
// the second add even when this process is descheduled for a while)
layer.spacingMs = 500;
layer.lastAddAt = -Infinity;
layer.removeAll();
await layer.idle();
await waitUntil("the mock to log the removes of page 1",
  () => readTimes().filter((x) => x.action === "remove").length >= 8);
os.remove(times);
for (let i = 0; i < 6; i++) layer.add(`p1-g2-${i}`, i, 0, 5, 5, `/t/${i}.png`);
await waitUntil("the first add of the old page to go out", () => layer.pending() === 5);
layer.removeAll(); // page change after the first add went out
for (let i = 0; i < 3; i++) layer.add(`p2-g3-${i}`, i, 0, 5, 5, `/t/${i}.png`);
await layer.idle();
await waitUntil("the mock to log 5 commands", () => readTimes().length >= 5);
ts = readTimes();
eq(
  "cancel: only the first old add was sent, then its remove, then the new page",
  ts.map((x) => `${x.action} ${x.id}`),
  ["add p1-g2-0", "remove p1-g2-0", "add p2-g3-0", "add p2-g3-1", "add p2-g3-2"],
);
eq(
  "wayland: each add is followed by the no-op remove that makes ueberzugpp flush",
  readAllTimes().slice(0, 3).map((x) => `${x.action} ${x.id}`),
  ["add p1-g2-0", `remove ${FLUSH_ID}`, "remove p1-g2-0"],
);
eq("cancel: shown = new page", [...layer.shown].sort(), ["p2-g3-0", "p2-g3-1", "p2-g3-2"]);
layer.stop();

// 4. ueberzugpp aborts mid-page -> detected, reaped, reported once
reset();
std.setenv("MOCK_UZ_DIE_AFTER", "3");
let deaths = [];
layer = new UeberzugLayer("wayland", {
  bin: mock,
  spacingMs: 15,
  onDeath: (reason) => deaths.push(reason),
});
await layer.start(100);
let dpid = layer.pid;
for (let i = 0; i < 10; i++) layer.add(`p0-g1-${i}`, i, 0, 5, 5, `/t/${i}.png`);
await waitUntil("the abort to be reported and reaped", () => deaths.length > 0 && gone(dpid));
eq("abort: reported once", deaths.length, 1);
eq("abort: reason names SIGABRT", /signal 6/.test(deaths[0] ?? ""), true);
eq("abort: no zombie left", gone(dpid), true);
eq("abort: queue dropped", layer.pending(), 0);
eq("abort: later calls are no-ops", (layer.add("x", 0, 0, 1, 1, "p"), layer.pending()), 0);
std.unsetenv("MOCK_UZ_DIE_AFTER");

// 5. ueberzugpp killed while idle -> the watchdog notices
reset();
deaths = [];
layer = new UeberzugLayer("x11", {
  bin: mock,
  watchMs: 50,
  onDeath: (reason) => deaths.push(reason),
});
await layer.start(100);
dpid = layer.pid;
layer.add("a", 0, 0, 1, 1, "/a.png");
await layer.idle();
os.kill(dpid, 9); // SIGKILL (not exported by the qjs os module)
await waitUntil("the watchdog to report the kill", () => deaths.length > 0 && gone(dpid));
eq("killed: watchdog reported", deaths, ["killed by signal 9"]);
eq("killed: reaped", gone(dpid), true);

// 6. stdin closed by ueberzugpp -> EPIPE on write -> reported, process killed
reset();
deaths = [];
std.setenv("MOCK_UZ_CLOSE_STDIN", "1");
layer = new UeberzugLayer("x11", {
  bin: mock,
  watchMs: 0,
  onDeath: (reason) => deaths.push(reason),
});
await layer.start(100);
dpid = layer.pid;
layer.add("a", 0, 0, 1, 1, "/a.png");
layer.add("b", 0, 0, 1, 1, "/b.png");
await waitUntil("EPIPE to be reported", () => deaths.length > 0 && gone(dpid));
eq("epipe: reported", deaths, ["write failed (EPIPE)"]);
eq("epipe: lingering process killed and reaped", gone(dpid), true);
std.unsetenv("MOCK_UZ_CLOSE_STDIN");

// 7. stop() never reports a death
reset();
deaths = [];
layer = new UeberzugLayer("x11", { bin: mock, onDeath: (r) => deaths.push(r) });
await layer.start(100);
layer.stop();
// (asserts that nothing happens: a short fixed pause can't fail spuriously)
await os.sleepAsync(100);
eq("stop: no death report", deaths, []);

// 8. ueberzugpp exits right away -> start() reports failure
reset();
std.setenv("MOCK_UZ_FAIL", "1");
layer = new UeberzugLayer("wayland", { bin: mock });
// (the grace period must outlast the mock's exit on a busy machine)
eq("failed start", await layer.start(2000 * SCALE), false);
eq("failed start reaped", layer.pid, null);
std.unsetenv("MOCK_UZ_FAIL");

// 9. missing binary
layer = new UeberzugLayer("x11", { bin: "/nonexistent/ueberzugpp" });
eq("missing binary", await layer.start(100), false);

// 10. a hung ueberzugpp (ignores EOF and SIGTERM) is SIGKILLed on stop
std.setenv("MOCK_UZ_HANG", "1");
layer = new UeberzugLayer("x11", { bin: mock });
eq("hang starts", await layer.start(100), true);
const hung = layer.pid;
const t0 = Date.now();
layer.stop();
eq("hung killed", gone(hung), true);
eq("hung stop bounded", Date.now() - t0 < 1500 * SCALE, true);
std.unsetenv("MOCK_UZ_HANG");

print(`ueberzug tests: ${passed} passed, ${failed} failed`);
if (failed) std.exit(1);
