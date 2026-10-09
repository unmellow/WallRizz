/*
 For:            swaybg, https://github.com/swaywm/swaybg
 Author:         https://github.com/unmellow
 Prerequisite:   sway; any running swaybg is replaced

 resizeMode from WallRizz's selection menu:
   crop  ->  -m fill     (cover the output, crop the overflow)
   fit   ->  -m fit      (whole image, bars if the aspect differs)
   no    ->  -m center   (native pixels, no scale)
*/

const MODES = { crop: "fill", fit: "fit", no: "center" };

export function setWallpaper(wallpaperPath, resizeMode) {
  const mode = MODES[resizeMode] || "fill";
  OS.exec(["pkill", "-x", "swaybg"]);
  execAsync(
    ["swaybg", "-i", wallpaperPath, "-m", mode],
    { newSession: true },
  );
}
