import { HOME_DIR, OS, STD } from "../core/constants.js";

// swww --resize values. swaybg maps these to fill / fit / center.
export const RESIZE_MODES = ["crop", "fit", "no"];

const FILE = `${HOME_DIR}/.config/WallRizz/resize-mode`;

export function readResizeMode() {
  const text = STD.loadFile(FILE);
  const mode = text ? String(text).trim() : "";
  return RESIZE_MODES.includes(mode) ? mode : "crop";
}

export function writeResizeMode(mode) {
  if (!RESIZE_MODES.includes(mode)) return;
  const dir = `${HOME_DIR}/.config/WallRizz`;
  OS.mkdir(dir);
  const f = STD.open(FILE, "w");
  f.puts(mode + "\n");
  f.close();
}

export function resizeStatusLine(saved) {
  const mark = (mode, label) =>
    mode === saved ? `[${label} *]` : `[${label}]`;
  return "Display  c " + mark("crop", "crop") +
    "   f " + mark("fit", "fit") +
    "   n " + mark("no", "no resize") +
    "   Enter confirms   Esc cancels";
}
