// Run with: qjs --std --module tests/ueberzug.test.js <path to tests/mock-ueberzugpp> <log file>
// Drives the real UeberzugLayer against a mock ueberzugpp that records stdin.
import * as std from "std";
import * as os from "os";
import { UeberzugLayer } from "../src/ui/ueberzug.js";

const [, mock, log] = scriptArgs;
const times = log + ".times";
let passed = 0, failed = 0;
const eq = (name, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) passed++;
  else { failed++; print(`FAIL ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
};
const readLog = () => (std.loadFile(log) ?? "").split("\n").filter(Boolean);
const readTimes = () =>
  (std.loadFile(times) ?? "").split("\n").filter(Boolean).map((l) => {
    const [t, action, id] = l.split(" ");
    return { t: Number(t) * 1000, action, id };
  });
const gone = (pid) => os.kill(pid, 0) !== 0; // reaped -> ESRCH
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
os.sleep(50);
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
for (let i = 0; i < 8; i++) layer.add(`p0-g1-${i}`, i, 0, 5, 5, `/t/${i}.png`);
await layer.idle();
await os.sleepAsync(50);
let ts = readTimes().filter((x) => x.action === "add");
eq("spacing: all adds sent", ts.length, 8);
const gaps = ts.slice(1).map((x, i) => x.t - ts[i].t);
// (measured where the mock reads them, so allow for its read jitter)
const spanOk = ts.at(-1).t - ts[0].t >= 7 * 40 - 2;
const gapsOk = gaps.every((g) => g >= 30);
eq("spacing: 8 adds span >= 7 x 40 ms", spanOk, true);
eq("spacing: no two adds closer than 40 ms (minus mock read jitter)", gapsOk, true);
if (!spanOk || !gapsOk) print("gaps " + gaps.map((g) => g.toFixed(1)).join(" "));
eq("spacing: default wayland spacing is 150 ms", new UeberzugLayer("wayland").spacingMs, 150);

// 3. page change: queued adds of the old page are cancelled, never sent
reset();
layer.spacingMs = 60;
layer.lastAddAt = -Infinity;
layer.removeAll();
await layer.idle();
await os.sleepAsync(80); // let the mock log the last removes
os.remove(times);
for (let i = 0; i < 6; i++) layer.add(`p1-g2-${i}`, i, 0, 5, 5, `/t/${i}.png`);
await os.sleepAsync(10);
layer.removeAll(); // page change after the first add went out
for (let i = 0; i < 3; i++) layer.add(`p2-g3-${i}`, i, 0, 5, 5, `/t/${i}.png`);
await layer.idle();
await os.sleepAsync(30);
ts = readTimes();
eq(
  "cancel: only the first old add was sent, then its remove, then the new page",
  ts.map((x) => `${x.action} ${x.id}`),
  ["add p1-g2-0", "remove p1-g2-0", "add p2-g3-0", "add p2-g3-1", "add p2-g3-2"],
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
await os.sleepAsync(400);
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
await os.sleepAsync(300);
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
await os.sleepAsync(100);
eq("epipe: reported", deaths, ["write failed (EPIPE)"]);
eq("epipe: lingering process killed and reaped", gone(dpid), true);
std.unsetenv("MOCK_UZ_CLOSE_STDIN");

// 7. stop() never reports a death
reset();
deaths = [];
layer = new UeberzugLayer("x11", { bin: mock, onDeath: (r) => deaths.push(r) });
await layer.start(100);
layer.stop();
await os.sleepAsync(100);
eq("stop: no death report", deaths, []);

// 8. ueberzugpp exits right away -> start() reports failure
reset();
std.setenv("MOCK_UZ_FAIL", "1");
layer = new UeberzugLayer("wayland", { bin: mock });
eq("failed start", await layer.start(150), false);
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
eq("hung stop bounded", Date.now() - t0 < 1500, true);
std.unsetenv("MOCK_UZ_HANG");

print(`ueberzug tests: ${passed} passed, ${failed} failed`);
if (failed) std.exit(1);
