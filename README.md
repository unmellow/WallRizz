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

Speed: tiles are always encoded from the small cached thumbnails (`~/.cache/WallRizz/pic/`, or under `$XDG_CACHE_HOME`), never from the full-size wallpapers. The encoded output is cached in memory and on disk in `~/.cache/WallRizz/tiles/`, keyed by thumbnail, protocol, cell box, cell pixel size (sixel) and encoder options, so going back to a page or relaunching doesn't re-encode. Tiles are encoded in parallel (limited by `-x/--plimit`), drawn as soon as each one is ready, and the next page is encoded in the background. The grid stays responsive while a page is still loading. Fullscreen still uses the full-size wallpaper. Old cache entries are cleaned up automatically (see [Cache](#cache)).

`ueberzug` doesn't draw in the terminal at all. WallRizz starts one long-lived `ueberzugpp layer --silent -o x11|wayland` and sends it JSON commands on a pipe, the same way yazi does (`{"action":"add","identifier":...,"x":..,"y":..,"max_width":..,"max_height":..,"path":...,"scaler":"fit_contain"}` and `{"action":"remove",...}`). Überzug++ shows each image in its own window placed over the terminal cells, so Alacritty or any other terminal on X11 or a supported Wayland compositor shows real images. How the grid is drawn depends on the output:

- **Wayland: one overlay per page.** The visible page's thumbnails are drawn into one page-sized transparent PNG (on the worker pool), each at exactly the pixel position and size the per-tile path would use, and the page is a single `add`. The gaps are transparent, so the selection frame (terminal text) shows through, and moving the selection never touches the overlay. Finished composites are cached in `~/.cache/WallRizz/composites/`, keyed by the thumbnails on the page and the layout (grid, cell pixel size, tile size), and the next and previous page are composited in the background, so a page you've seen comes back as one cached `add`. An overlay is never removed before the one replacing it is on screen. Re-adding an identifier makes Überzug++ close the old window before the new one is mapped, which blinks, so every new composite is a new identifier added on top, and the overlay it replaces is removed only once the new window is up. On sway WallRizz knows when that is: it runs `swaymsg -r -t subscribe -m '["window"]'` (sway's IPC, `$SWAYSOCK`) and reads the window events as they come, never blocking the UI. On Hyprland it polls `hyprctl clients -j` while a window is due. Elsewhere it assumes the window is up 300 ms after the add. A window that is never reported counts as up after 1 s. The old overlay goes 50 ms after the new window is mapped, and at most two overlays are alive at any time. (`WALLRIZZ_UEBERZUG_CONFIRM=none` turns the confirmation off and uses the 300 ms delay.) A cold page fills in progressively: as thumbnails finish, a fuller composite (a new file) is sent once the previous one's window is up and 150 ms after it appeared (`WALLRIZZ_UEBERZUG_SPACING_MS`); composites that finish in the meantime are coalesced and only the newest is sent. These partial composites live in `/dev/shm/wallrizz-$UID/` (else `$XDG_RUNTIME_DIR/wallrizz/`, else the cache dir). They're deleted once replaced, on page change and on exit, and they don't count towards the cache; only the complete page is cached. The directory itself is removed on exit when no other WallRizz uses it. Page keys are debounced: the page you stop on is drawn 70 ms after the last page key (`WALLRIZZ_UEBERZUG_DEBOUNCE_MS`), so fast paging never draws, or composites, the pages in between. When the page you land on is cached, the old page's overlay stays up until the new page's window is up, so flipping between pages you've seen never shows the bare terminal. If the new page isn't cached yet, or another page key comes first, the old overlay is removed at once. Überzug++ is started with `--no-cache`, so it doesn't keep its own resized copies of every composite in `~/.cache/ueberzugpp`. It's started while the first thumbnails are being made, and is given a 1×1 transparent image right away, so its one-time setup overlaps the thumbnails instead of delaying the first page (`WALLRIZZ_UEBERZUG_WARMUP=0` turns that off).
- **X11: one overlay per tile.** X11 windows have no alpha channel (a transparent PNG shows black), so a page composite would hide the selection frame. Each tile is sent with its fitted cell box, adds are paced (`WALLRIZZ_UEBERZUG_SPACING_MS`, 5 ms on X11), and queued adds of a page you already left are dropped. `WALLRIZZ_UEBERZUG_OVERLAY=page|tile` overrides the choice.

Overlay identifiers are unique per draw (`wallrizz-p<page>-g<generation>-...`), so a late remove can never hit a newer image. All overlays are removed when fullscreen is toggled, on zoom/pan, on terminal resize (they're put back once it settles) and on exit, including Ctrl+C, SIGTERM and SIGHUP. If `ueberzugpp` dies, WallRizz restarts it and redraws the page, twice per session; after a third death it switches to `symbols` with a one-line notice. `ueberzugpp` is stopped on exit. It also exits by itself when WallRizz dies, because its stdin pipe closes. In the list view the preview command sends `ueberzugpp cmd -s <socket> -a add ...` to the same process, over fzf's preview window.

The list view runs `WallRizz --render-tile` as fzf's preview command, which uses the same cache. It relies on fzf passing sixel/iTerm2 output from the preview command through to the terminal (fzf >= 0.44; WallRizz already needs >= 0.63 for its footer).

Override the detection with a flag or an environment variable (the flag wins):

```sh
WallRizz --image-protocol sixel        # or -P sixel; one of auto, kitty, iterm, sixel, symbols, ueberzug
WALLRIZZ_IMAGE_PROTOCOL=iterm WallRizz
WallRizz --which-image-protocol        # print what was detected and why, then exit
```

# Cache

WallRizz keeps its cache in `$XDG_CACHE_HOME/WallRizz/` if `XDG_CACHE_HOME` is set (an absolute path), otherwise `~/.cache/WallRizz/`. Everything uses the same directory: thumbnails (`pic/`), encoded tiles (`tiles/`), Überzug++ page composites (`composites/`), colours (`colours.json`) and theme files (`themes/`).

**Automatic cleanup.** After the first page is drawn, a background worker tidies the cache (it never delays the grid):

- thumbnails, encoded tiles, composites and theme/colour entries of a wallpaper that changed (same path, new modification time or size) are deleted;
- entries of wallpapers in folders you didn't scan this time are kept, unless their source file no longer exists (`sources.json` remembers where each thumbnail came from);
- old-format thumbnail names and the old `tiles/v1/` cache are deleted;
- the image caches (`pic/`, `tiles/`, `composites/`) are capped at 1024 MB by default: the least recently used files go first, never one used by the current run. A thumbnail of a 4K wallpaper is ~0.3 MB, so that's roughly 2,000 wallpapers with their composites and tiles for a couple of grid layouts. Change it with `--cache-max MB` or `WALLRIZZ_CACHE_MAX_MB` (`0` = no cap);
- temp files of a running WallRizz are never touched; nothing outside the cache directory is ever deleted, and the cleanup refuses to run if the cache path is empty, relative, `/`, your home directory or resolves to one of them through a symlink.

**Clearing it by hand:**

```sh
WallRizz --clear-thumbnails   # delete pic/, tiles/, composites/ (colours and theme files stay)
WallRizz --clear-cache        # delete the whole cache directory
```

Both print what was removed and how much space was freed, then exit with status 0 without opening the picker, e.g.

```
Removed the image caches (thumbnails, tiles, composites) in /home/me/.cache/WallRizz/:
  composites/      24 files    41.2 MB
  pic/            212 files    61.7 MB
  tiles/          180 files     9.3 MB
Freed 112.2 MB (416 files).
Colours and theme files were kept.
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
