/*
 For:            awww (swww renamed), https://codeberg.org/LGFae/awww
 Author:         https://github.com/unmellow
 Prerequisite:   awww-daemon running (awww img). swww is only a fallback.

 The file used to be named swww@….js and invoked `swww` even when the
 installed daemon was awww. The command is awww. If `awww` is not on PATH
 the same arguments are passed to `swww`.
*/

function wallpaperBin() {
  // OS.exec returns an exit status, 0 on success. It is not a [stdout, err] pair.
  if (!OS.exec(["sh", "-c", "command -v awww >/dev/null 2>&1"])) return "awww";
  return "swww";
}

export async function setWallpaper(wallpaperPath, resizeMode) {
  const options = generateRandomSwwwOptions();
  // WallRizz asks on selection: crop (cover), fit (contain), no (no scale).
  if (resizeMode === "crop" || resizeMode === "fit" || resizeMode === "no") {
    options.resize = resizeMode;
    options.noResize = false;
  }
  const command = createSwwwCommand(wallpaperPath, options);
  await execAsync(command);
}

function createSwwwCommand(imagePath, options) {
  const command = [wallpaperBin(), "img", imagePath];

  // Adding options to the command
  if (options.noResize) {
    command.push("--no-resize");
  }
  if (options.resize) {
    command.push("--resize", options.resize);
  }
  if (options.fillColor) {
    command.push("--fill-color", options.fillColor);
  }
  if (options.filter) {
    command.push("-f", options.filter);
  }
  if (options.transitionType) {
    command.push("--transition-type", options.transitionType);
  }
  if (options.transitionStep !== undefined) {
    command.push("--transition-step", options.transitionStep);
  }
  if (options.transitionDuration !== undefined) {
    command.push("--transition-duration", options.transitionDuration);
  }
  if (options.transitionFps !== undefined) {
    command.push("--transition-fps", options.transitionFps);
  }
  if (options.transitionAngle !== undefined) {
    command.push("--transition-angle", options.transitionAngle);
  }
  if (options.transitionPos) {
    command.push("--transition-pos", options.transitionPos);
  }

  return command;
}

function generateRandomSwwwOptions() {
  function getRandomElement(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  const transitionTypes = [
    // "none",
    // "simple",
    "fade",
    "left",
    "right",
    "top",
    "bottom",
    "wipe",
    "wave",
    "grow",
    "center",
    // "any",
    "outer",
    // "random",
  ]; // Transition types

  const options = {
    resize: "crop", // Resize method ["no", "crop", "fit"]
    transitionType: getRandomElement(transitionTypes), // Type of transition
    transitionStep: 255, // Speed of transition (0-255)
    transitionDuration: 1, // Duration of transition (1-10 seconds)
    transitionFps: 60, // Frame rate for transition (1-60)
    transitionAngle: Math.floor(Math.random() * 360), // Angle for "wipe" and "wave" transitions (0-360 degrees)
    transitionPos: getRandomElement([
      "center",
      "top",
      "left",
      "right",
      "bottom",
      "top-left",
      "top-right",
      "bottom-left",
      "bottom-right",
      `${Math.random() * 100},${Math.random() * 100}`,
    ]), // Center position for transitions
  };

  return options;
}
