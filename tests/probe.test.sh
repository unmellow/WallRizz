#!/usr/bin/env bash
# chafa >= 1.16 must always get "--probe off" (list preview / --render-tile,
# all chafa protocols), older chafa never gets the unknown option.
# usage: probe.test.sh WALLRIZZ_BIN WORKDIR
set -u
wr=$(realpath "$1"); work=$2
rm -rf "$work"; mkdir -p "$work/home" "$work/bin"
cp "$(dirname "$0")/chafa-probe-wrapper" "$work/bin/chafa"
magick -size 320x180 plasma:fractal -depth 8 "$work/thumb.png"
passed=0; failed=0
check() { if eval "$2"; then passed=$((passed + 1)); else failed=$((failed + 1)); echo "FAIL $1"; fi; }
run() { # protocol, PATH prefix
  HOME="$work/home" PATH="$2:$PATH" CHAFA_ARGV_LOG="$work/argv.log" FZF_PREVIEW_COLUMNS=40 FZF_PREVIEW_LINES=12 \
    WALLRIZZ_CELL_PX=10x20 "$wr" -P "$1" --render-tile "$work/thumb.png" > "$work/out-$1" 2>/dev/null </dev/null
}
for p in symbols sixel; do
  rm -f "$work/argv.log"; rm -rf "$work/home/.cache"
  run "$p" "$work/bin"
  check "$p: chafa ran" '[[ -s $work/argv.log ]]'
  check "$p: every chafa render has --probe off" '! grep -qv -- "--probe off" "$work/argv.log"'
  check "$p: output produced" '[[ -s $work/out-$p ]]'
done
# chafa without --probe (the wrapper is not in PATH): option not passed
if command -v chafa >/dev/null && ! chafa --help | grep -q -- --probe; then
  rm -rf "$work/home/.cache"
  mkdir -p "$work/bin2"
  printf '#!/bin/sh\necho "$*" >> "%s"\nexec %s "$@"\n' "$work/argv2.log" "$(command -v chafa)" > "$work/bin2/chafa"
  chmod +x "$work/bin2/chafa"
  HOME="$work/home" PATH="$work/bin2:$PATH" FZF_PREVIEW_COLUMNS=40 FZF_PREVIEW_LINES=12 \
    "$wr" -P symbols --render-tile "$work/thumb.png" > /dev/null 2>&1 </dev/null
  check "old chafa: no --probe" '[[ -s $work/argv2.log ]] && ! grep -q -- "--probe" "$work/argv2.log"'
fi
echo "probe tests: $passed passed, $failed failed"
((failed == 0))
