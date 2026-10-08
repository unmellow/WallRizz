/**
 * Thumbnail worker (compiled into the binary; runs in os.Worker threads,
 * see thumbnails.js).
 *
 * One magick invocation per batch: JPEGs are decoded at about twice the
 * thumbnail size (jpeg:size), each image is written to a temp name, and
 * the temp file is renamed into place only when magick succeeded. A
 * killed magick leaves no thumbnail behind, only its temp file, which is
 * removed here (or by the pool on shutdown).
 */
import * as os from "os";

const parent = os.Worker.parent;
const devNull = os.open("/dev/null", os.O_RDWR);

// The child's pid goes to the pool before waiting for it, so quitting /
// a signal can kill exactly this process (and nothing else).
const run = (args) => {
  const pid = os.exec(args, {
    block: false,
    usePath: true,
    stdin: devNull,
    stdout: devNull,
    stderr: devNull,
  });
  if (pid <= 0) return -1;
  parent.postMessage({ type: "pid", pid });
  let ret, status;
  do [ret, status] = os.waitpid(pid, 0); while (ret !== pid && ret === -4 /* EINTR */);
  if (ret !== pid) return -1;
  const sig = status & 0x7f;
  return sig ? -sig : (status >> 8) & 0xff;
};

export const magickArgs = (items, jpegSize) => {
  // -limit thread 1: several workers run at once; one core each (no
  // slower, and the load stays predictable)
  const args = [
    "magick", "-limit", "thread", "1",
    "-define", "filename:literal=true",
  ];
  if (jpegSize) args.push("-define", `jpeg:size=${jpegSize}`);
  for (const item of items) {
    // first frame only (GIF), EXIF orientation applied, no metadata
    args.push(
      "(", item.src, "-delete", "1--1", "-auto-orient", "-strip",
      "-resize", item.size, "-define", "png:compression-level=1",
      "-write", `PNG:${item.tmp}`, "+delete", ")",
    );
  }
  args.push("null:");
  return args;
};

parent.onmessage = (e) => {
  const msg = e.data;
  if (!msg) return;
  if (msg.type === "stop") {
    parent.onmessage = null; // lets this thread end
    return;
  }
  if (msg.type !== "batch") return;
  const code = run(magickArgs(msg.items, msg.jpegSize));
  const results = msg.items.map((item) => {
    let ok = false;
    const [st, err] = os.stat(item.tmp);
    if (code === 0 && err === 0 && st.size > 0) {
      ok = os.rename(item.tmp, item.dest) === 0;
    }
    if (!ok) os.remove(item.tmp);
    return { dest: item.dest, ok };
  });
  parent.postMessage({ type: "done", results });
};
