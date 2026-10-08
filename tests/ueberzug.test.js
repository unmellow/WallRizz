// Run with: qjs --std --module tests/ueberzug.test.js <path to tests/mock-ueberzugpp> <log file>
// Drives the real UeberzugLayer against a mock ueberzugpp that records stdin.
import * as std from "std";
import * as os from "os";
import { UeberzugLayer } from "../src/ui/ueberzug.js";

const [, mock, log] = scriptArgs;
let passed = 0, failed = 0;
const eq = (name, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) passed++;
  else { failed++; print(`FAIL ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
};
const readLog = () => (std.loadFile(log) ?? "").split("\n").filter(Boolean);
const gone = (pid) => os.kill(pid, 0) !== 0; // reaped -> ESRCH

// 1. normal session
os.remove(log);
std.setenv("MOCK_UZ_LOG", log);
let layer = new UeberzugLayer("x11", { bin: mock });
eq("starts", await layer.start(100), true);
const pid = layer.pid;
eq("socket path", layer.socketPath(), `${std.getenv("UEBERZUGPP_TMPDIR") || std.getenv("TMPDIR") || "/tmp"}/ueberzugpp-${pid}.socket`);
layer.add("wallrizz-tile-0", 2, 1, 36, 11, "/c/pic/a b.png");
layer.add("wallrizz-tile-1", 40, 1, 36, 11, '/c/pic/q"uote.png');
layer.remove("wallrizz-tile-0");
layer.add("wallrizz-tile-2", 78, 1, 36, 11, "/c/pic/ü.png");
eq("tracks shown", [...layer.shown].sort(), ["wallrizz-tile-1", "wallrizz-tile-2"]);
layer.removeAll();
eq("removeAll clears", layer.shown.size, 0);
layer.add("wallrizz-fullscreen", 0, 0, 120, 39, "/w/full.jpg");
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
  'CMD {"action":"add","identifier":"wallrizz-fullscreen","x":0,"y":0,"max_width":120,"max_height":39,"path":"/w/full.jpg"}',
  'CMD {"action":"remove","identifier":"wallrizz-fullscreen"}',
  "EOF",
]);
eq("calls after stop are no-ops", (layer.add("x", 0, 0, 1, 1, "p"), layer.shown.size), 0);

// 2. ueberzugpp exits right away -> start() reports failure
os.remove(log);
std.setenv("MOCK_UZ_FAIL", "1");
layer = new UeberzugLayer("wayland", { bin: mock });
eq("failed start", await layer.start(150), false);
eq("failed start reaped", layer.pid, null);
std.unsetenv("MOCK_UZ_FAIL");

// 3. missing binary
layer = new UeberzugLayer("x11", { bin: "/nonexistent/ueberzugpp" });
eq("missing binary", await layer.start(100), false);

// 4. a hung ueberzugpp (ignores EOF and SIGTERM) is SIGKILLed on stop
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
