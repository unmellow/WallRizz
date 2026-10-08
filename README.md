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

Hidden folders (names starting with `.`) are skipped. Symlinked folders are followed, but every real directory is scanned only once, so symlink loops terminate and a folder reachable through both a link and its real path isn't listed twice. Wallpapers in sub folders are shown with their relative path (e.g. `favorites/landscape/sunset.jpg`); thumbnails and colour caches are keyed by device and inode, so files with the same name in different folders don't collide.

# Image previews in any terminal

WallRizz picks an image protocol for the grid and list views automatically, the way [yazi](https://github.com/sxyazi/yazi) does:

| Terminal | Detected via | Protocol |
| --- | --- | --- |
| kitty, Ghostty | `TERM=xterm-kitty`/`xterm-ghostty`, `TERM_PROGRAM=ghostty`, `KITTY_WINDOW_ID`, `GHOSTTY_RESOURCES_DIR` | `kitty` (native kitty graphics, unchanged) |
| Konsole | `KONSOLE_VERSION` | `kitty` (untested, override if it misbehaves) |
| WezTerm, iTerm2, VS Code, Warp, Rio, Tabby, Hyper, mintty | `TERM_PROGRAM`, `WEZTERM_EXECUTABLE`, `ITERM_SESSION_ID`, ... | `iterm` (iTerm2 inline images) |
| foot, mlterm, Contour, BlackBox, Windows Terminal | `TERM=foot`, `TERM=mlterm`, `WT_SESSION`, ... | `sixel` |
| xterm, unknown terminals, tmux/screen/zellij | DA1 query (`ESC [ c`) | `sixel` if the terminal reports sixel support, otherwise `symbols` |
| Alacritty, urxvt, st, Linux console | `TERM`, `ALACRITTY_WINDOW_ID` | `symbols` (coloured Unicode blocks) |

`TERM` is checked first, then `TERM_PROGRAM`, then terminal-specific variables, so a variable leaked from a parent terminal (for example `KITTY_WINDOW_ID` inside foot started from kitty) doesn't win. Inside tmux/screen/zellij, graphics passthrough isn't attempted: you get sixel when the multiplexer advertises it (tmux 3.4+ built with sixel), otherwise symbols.

Every protocol except `kitty` is drawn with [chafa](https://hpjansson.org/chafa/) (`chafa -f iterm|sixels|symbols -s WxH`), so chafa needs to be installed. The list view relies on fzf passing sixel/iTerm2 output from the preview command through to the terminal (fzf >= 0.44; WallRizz already needs >= 0.63 for its footer).

Override the detection with a flag or an environment variable (the flag wins):

```sh
WallRizz --image-protocol sixel        # or -P sixel; one of auto, kitty, iterm, sixel, symbols
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
