// awww-handler 2: calls awww img, no OS.exec probe
/*
 For:            awww (swww renamed), https://codeberg.org/LGFae/awww
 Author:         https://github.com/unmellow
 Prerequisite:   awww-daemon is running.

 Always invokes `awww`. No PATH probe: OS.exec does not return a pair, and
 a probe here threw "value is not iterable" inside the handler worker.
*/

export async function setWallpaper(wallpaperPath, resizeMode) {
  const options = generateRandomSwwwOptions();
  if (resizeMode === "crop" || resizeMode === "fit" || resizeMode === "no" || resizeMode === "stretch") {
    options.resize = resizeMode;
    options.noResize = false;
  }
  await execAsync(createAwwwCommand(wallpaperPath, options));
}

function createAwwwCommand(imagePath, options) {
  const command = ["awww", "img", imagePath];

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
    "fade",
    "left",
    "right",
    "top",
    "bottom",
    "wipe",
    "wave",
    "grow",
    "center",
    "outer",
  ];

  return {
    resize: "crop",
    transitionType: getRandomElement(transitionTypes),
    transitionStep: 255,
    transitionDuration: 1,
    transitionFps: 60,
    transitionAngle: Math.floor(Math.random() * 360),
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
    ]),
  };
}
