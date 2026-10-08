#!/usr/bin/env bash
# Build a throwaway wallpaper tree for tests/scan.test.js
set -euo pipefail
root=${1:?usage: make-scan-tree.sh DIR}
rm -rf "$root" "$root-outside"; mkdir -p "$root" "$root-outside"
magick -size 64x36 gradient:white-blue -depth 8 "$root-outside/o1.png"
cd "$root"
img() { magick -size 64x36 "$2" -depth 8 "$1"; }
mkdir -p favorites/nsfw/landscape .hidden/deep "space dir" favorites/x.jpg
img a.jpg gradient:red-blue
img b.png gradient:green-yellow
img same.jpg plasma:fractal
img favorites/f1.webp gradient:blue-white
img favorites/same.jpg plasma:fractal
img favorites/nsfw/n1.png gradient:black-red
img favorites/nsfw/same.jpg plasma:fractal
img favorites/nsfw/landscape/l1.jpg gradient:orange-purple
img favorites/nsfw/landscape/same.jpg plasma:fractal
img favorites/x.jpg/inside.png gradient:cyan-magenta   # directory with an image-like name
img "space dir/s#1.png" gradient:gray-white
img .hidden/h.png gradient:red-red
img .hidden/deep/h2.png gradient:red-red
echo "not an image" > favorites/notes.txt
ln -s ../.. favorites/nsfw/landscape/loop          # symlink loop back to root
ln -s favorites linked-favs                        # second path to an already scanned dir
ln -s b.png toplink.png                            # symlinked file
ln -s /nonexistent/missing.png favorites/broken.png # broken symlink in a sub dir
ln -s "$root-outside" external                      # symlinked dir outside the tree: scanned
