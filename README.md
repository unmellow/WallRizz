<div align = center>
<img src="https://github.com/user-attachments/assets/58a5f213-21a0-401b-a4f2-28d823b89b0f" alt="Rizzed penguin" style="width: 30%;">
 
**WallRizz** is terminal based wallpaper and system theme manager that lets you **<i>"𝑹𝒊𝒛𝒛 𝒚𝒐𝒖𝒓 𝑳𝒊𝒏𝒖𝒙"</i>** with ease.

---
**[<kbd> <br> Workflow <br> </kbd>](https://github.com/5hubham5ingh/WallRizz/wiki#workflow-overview)** 
**[<kbd> <br> Wallpapers <br> </kbd>](https://github.com/5hubham5ingh/WallRizz/wiki#online-wallpaper-browsing)** 

**[<kbd> <br> Install <br> </kbd>](https://github.com/5hubham5ingh/WallRizz/wiki/1.-Installation)** 
**[<kbd> <br> Setup <br> </kbd>](https://github.com/5hubham5ingh/WallRizz/wiki/2.-Setup)** 
**[<kbd> <br> Usage <br> </kbd>](https://github.com/5hubham5ingh/WallRizz/wiki/3.-Usage-Guide)** 
**[<kbd> <br> Extensions <br> </kbd>](https://github.com/5hubham5ingh/WallRizz/wiki/4.-Extensions)** 
 
</div>

---

# Features

- **Wallpaper Selection**: Choose your wallpaper from a grid or list menu in the terminal.  
- **Theme Generation and Application**: Automatically generates and applies themes based on the chosen wallpaper to various applications.  
- **Online Wallpaper Browsing**: Browse wallpapers from your favorite wallpaper repositories directly from the terminal, and download them to the specified wallpaper directory.  
- **Extensible with Scripts**: Write or edit theming scripts for different applications. Create an extension template for writing new extensions with a single command.
- **Finest Level of Control Over Colors and Themes**  
Achieve unparalleled precision with the built-in **ColorJs** library and the option to set a custom color generation backend, enabling highly customizable and seamless theme creation.
- **Lightweight**: Built with QuickJS for fast startup and a small standalone executable, ensuring minimal system resource usage while also facilitating extension support.  

Check [wiki](https://github.com/5hubham5ingh/WallRizz/wiki) for more.

# Wallpapers in sub folders

By default only the wallpaper directory itself is read. `-R`/`--recursive` also searches its sub folders, and `-D`/`--depth NUM` limits how deep (`--depth` implies `--recursive`; `1` is the directory itself, which is the default behaviour; no depth means unlimited, like `find` without `-maxdepth`):

```sh
WallRizz -R -d ~/Pictures/wallpapers          # every sub folder
WallRizz -D 2 -d ~/Pictures/wallpapers        # wallpapers/ and wallpapers/*/ only
WALLPAPER_DIR=~/Pictures/wallpapers WallRizz -R
```

Hidden folders (names starting with `.`) are skipped. Symlinked folders are followed, but every real directory is scanned only once, so symlink loops terminate and a folder reachable through both a link and its real path isn't listed twice. Wallpapers in sub folders are shown with their relative path (e.g. `favorites/landscape/sunset.jpg`); thumbnails and colour caches are keyed by the full path plus the file's modification time and size, so files with the same name in different folders don't collide, and an edited wallpaper gets a new thumbnail and palette.

# Image previews in any terminal

WallRizz picks an image protocol for the grid and list views automatically, the way [yazi](https://github.com/sxyazi/yazi) does:

| Terminal | Detected via | Protocol |
| --- | --- | --- |
| kitty, Ghostty | `TERM=xterm-kitty`/`xterm-ghostty`, `TERM_PROGRAM=ghostty`, `KITTY_WINDOW_ID`, `GHOSTTY_RESOURCES_DIR` | `kitty` (native kitty graphics, unchanged) |
| Konsole | `KONSOLE_VERSION` | `kitty` (untested, override if it misbehaves) |
| WezTerm, iTerm2, VS Code, Warp, Rio, Tabby, Hyper, mintty | `TERM_PROGRAM`, `WEZTERM_EXECUTABLE`, `ITERM_SESSION_ID`, ... | `iterm` (iTerm2 inline images) |
| foot, mlterm, Contour, BlackBox, Windows Terminal | `TERM=foot`, `TERM=mlterm`, `WT_SESSION`, ... | `sixel` |
| xterm, unknown terminals, tmux/screen/zellij | DA1 query (`ESC [ c`) | `sixel` if the terminal reports sixel support, otherwise `ueberzug` or `symbols` (see below) |
| Alacritty, urxvt, st, Linux console | `TERM`, `ALACRITTY_WINDOW_ID` | `ueberzug` if [Überzug++](https://github.com/jstkdng/ueberzugpp) can be used, otherwise `symbols` (coloured Unicode blocks) |

Whenever detection ends at `symbols` outside tmux/screen/zellij, WallRizz uses `ueberzug` instead if `ueberzugpp` is in `PATH` and there's a canvas for it. Like yazi, that means an X11 session or `DISPLAY` (X11 output), or Wayland on sway, Hyprland, Wayfire or niri (Wayland output). Other Wayland compositors such as GNOME and KDE keep `symbols`; force it with `-P ueberzug` and `WALLRIZZ_UEBERZUG_OUTPUT=x11|wayland` if you want to try. If `ueberzugpp` exits right after starting, WallRizz falls back to `symbols`.

`TERM` is checked first, then `TERM_PROGRAM`, then terminal-specific variables, so a variable leaked from a parent terminal (for example `KITTY_WINDOW_ID` inside foot started from kitty) doesn't win. Inside tmux/screen/zellij, graphics passthrough isn't attempted: you get sixel when the multiplexer advertises it (tmux 3.4+ built with sixel), otherwise symbols.

How the non-kitty protocols are drawn:

- `sixel` and `symbols` use [chafa](https://hpjansson.org/chafa/) (`chafa -f sixels|symbols -s WxH`), so chafa needs to be installed.
- `iterm` doesn't use chafa: chafa's iTerm2 encoder sends an uncompressed TIFF, about 1.6 MB per tile on a HiDPI screen. WallRizz converts the thumbnail to a JPEG once (ImageMagick) and sends it with its size in cells and `preserveAspectRatio=1`, which is roughly 40x less data per page.
- `symbols` uses finer symbols and chafa's highest quality setting (`--work 9`). With chafa >= 1.8 in Alacritty, kitty, Ghostty, foot or WezTerm it uses `--symbols sextant+quad+half+block+space` (those terminals draw sextants with a built-in font, so they line up); elsewhere it uses `quad+half+block+space`. Older chafa without `--work` keeps chafa's defaults. Octants (chafa >= 1.16) aren't used by default because Alacritty's built-in font doesn't have them; set `WALLRIZZ_CHAFA_SYMBOLS` (e.g. `octant+sextant+quad+half+block`, or `all`) to pick the symbol classes yourself.

Every image (all protocols except `kitty`) is fitted into its tile inside the selection frame. It keeps its aspect ratio, is centered, and never covers the frame, the last row or the last column. 4:3, square and portrait wallpapers no longer spill into the next row. WezTerm sizes an iTerm2 image from its width alone, so WallRizz computes the cell box from the cell pixel size (asked with `CSI 16 t`, assumed 1:2 if the terminal doesn't answer). It also saves and restores the cursor around each image, so nothing scrolls or shifts.

Thumbnails are made off the UI thread. The grid opens at once with an empty frame per tile; a small pool of worker threads (`-x/--plimit`, default min(4, CPUs)) runs ImageMagick in batches of up to three images, decoding JPEGs at about twice the thumbnail size (`jpeg:size`), and each tile fills in as soon as its thumbnail is ready. The visible page always comes first; the next and then the previous page are made afterwards, at low priority, so flipping to them is instant. Every page draw takes a ticket: work queued for a page you already left is dropped, and a result that arrives late is never drawn. Never more than `-x` ImageMagick processes run at once (thumbnails, iTerm2 tile JPEGs, fullscreen and colour extraction share the cap). Thumbnails are written to a temp name and renamed into place, and quitting (q, Ctrl+C, SIGTERM) kills the running ImageMagick processes and removes their temp files. In the grid, colours and theme files are generated for a wallpaper when you select it (and in the background for the pages you've seen), instead of for every wallpaper before the grid opens. The list view still prepares everything first, with the same worker pool.

Speed: tiles are always encoded from the small cached thumbnails (`~/.cache/WallRizz/pic/`), never from the full-size wallpapers. The encoded output is cached in memory and on disk in `~/.cache/WallRizz/tiles/`, keyed by thumbnail, protocol, cell box, cell pixel size (sixel) and encoder options, so going back to a page or relaunching doesn't re-encode. Tiles are encoded in parallel (limited by `-x/--plimit`), drawn as soon as each one is ready, and the next page is encoded in the background. The grid stays responsive while a page is still loading. Fullscreen still uses the full-size wallpaper. Delete `~/.cache/WallRizz/tiles/` to reclaim the disk space.

`ueberzug` doesn't draw in the terminal at all. WallRizz starts one `ueberzugpp layer --silent -o x11|wayland` and sends it JSON commands on a pipe, the same way yazi does (`{"action":"add","identifier":...,"x":..,"y":..,"max_width":..,"max_height":..,"path":<thumbnail>}` and `{"action":"remove",...}`). Überzug++ shows each thumbnail in its own window placed over the terminal cells, so Alacritty or any other terminal on X11 or a supported Wayland compositor shows real images. Each tile is sent with its fitted cell box and `"scaler":"fit_contain"`. Overlay identifiers are unique per draw (`wallrizz-p<page>-g<generation>-<tile>`), so a late remove can never hit a newer image. All overlays are removed before a page change, when fullscreen is toggled, on zoom/pan, on terminal resize (they're put back once it settles) and on exit, including Ctrl+C, SIGTERM and SIGHUP. `ueberzugpp` is stopped on exit. It also exits by itself when WallRizz dies, because its stdin pipe closes. In the list view the preview command sends `ueberzugpp cmd -s <socket> -a add ...` to the same process, over fzf's preview window.

The list view runs `WallRizz --render-tile` as fzf's preview command, which uses the same cache. It relies on fzf passing sixel/iTerm2 output from the preview command through to the terminal (fzf >= 0.44; WallRizz already needs >= 0.63 for its footer).

Override the detection with a flag or an environment variable (the flag wins):

```sh
WallRizz --image-protocol sixel        # or -P sixel; one of auto, kitty, iterm, sixel, symbols, ueberzug
WALLRIZZ_IMAGE_PROTOCOL=iterm WallRizz
WallRizz --which-image-protocol        # print what was detected and why, then exit
```

# Gallery

## User Interface
**List view**                                                                                               
![1000003004](https://github.com/user-attachments/assets/2c0e1c34-a196-42b7-9273-2b844f4a52d2)

**Grid view**                                                                                  
![ezgif com-animated-gif-maker(1)](https://github.com/user-attachments/assets/25335e24-f625-4de5-8de3-08e222d0294b)

## Applications
https://github.com/user-attachments/assets/1847eb59-bc7b-4b0a-a13d-bbea3651e804

**Kitty**                                                                                                                                                         
![ezgif com-animated-gif-maker(2)](https://github.com/user-attachments/assets/b534600f-8198-4a2e-a88a-f9e1bce06f35)

**VSCode**                                                                                                                        
![ezgif com-optimize](https://github.com/user-attachments/assets/3b94f40c-41cd-4242-a0ae-7c35cff8a567)

**NeoVim**                                                                                                                                
![ezgif com-optimize(1)](https://github.com/user-attachments/assets/400fae79-dae1-4555-8144-c17b00220cfc)

**Firefox**                                                               
![ezgif com-animated-gif-maker(4)](https://github.com/user-attachments/assets/2596446d-0da4-47bd-90f6-82d857a43865)
 
**Jiffy**                                                                                       
![ezgif com-animated-gif-maker](https://github.com/user-attachments/assets/a0303dca-355d-4601-8bb8-aa59ae13a9f8)


# To Do:
PRs are welcome.

**Theme extension**
- Neovim Theme Extension
- Rofi theme extension

**Wallpaper handler extensions**
- KDE
- Gnome

# Thanks
- [ctn-malone](https://github.com/ctn-malone/qjs-ext-lib) for QuickJs extension.
- [Brian Grinstead](https://github.com/bgrins/TinyColor) for tinycolor.js

---


<div align = center>
  
**[<kbd> <br> Contribute <br> </kbd>](https://github.com/5hubham5ingh/WallRizz/blob/main/CONTRIBUTING.md)** 
**[<kbd> <br> Support <br> </kbd>](https://github.com/sponsors/5hubham5ingh?o=esb)** 

</div>
