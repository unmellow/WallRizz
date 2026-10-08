#!/usr/bin/env bash
# chafa >= 1.16 must always get "--probe off" (list preview / --render-tile,
# all chafa protocols), older chafa never gets the unknown option.
# Always 7 checks, whatever chafa version is installed.
# usage: probe.test.sh WALLRIZZ_BIN WORKDIR
set -u
wr=$(realpath "$1"); work=$2
rm -rf "$work"; mkdir -p "$work/home" "$work/bin"
cp "$(dirname "$0")/chafa-probe-wrapper" "$work/bin/chafa"
magick -size 320x180 plasma:fractal -depth 8 "$work/thumb.png"
passed=0; failed=0
check() { if eval "$2"; then passed=$((passed + 1)); else failed=$((failed + 1)); echo "FAIL $1"; fi; }
run() { # protocol, PATH prefix
  HOME="$work/home" PATH="$2:$PATH" MOCK_CHAFA_OLD="${MOCK_CHAFA_OLD:-}" CHAFA_ARGV_LOG="$work/argv.log" FZF_PREVIEW_COLUMNS=40 FZF_PREVIEW_LINES=12 \
    WALLRIZZ_CELL_PX=10x20 "$wr" -P "$1" --render-tile "$work/thumb.png" > "$work/out-$1" 2>/dev/null </dev/null
}
for p in symbols sixel; do
  rm -f "$work/argv.log"; rm -rf "$work/home/.cache"
  run "$p" "$work/bin"
  check "$p: chafa ran" '[[ -s $work/argv.log ]]'
  check "$p: every chafa render has --probe off" '! grep -qv -- "--probe off" "$work/argv.log"'
  check "$p: output produced" '[[ -s $work/out-$p ]]'
done
# old chafa (< 1.16, no --probe option): the option must never be passed.
# Faked with the wrapper's MOCK_CHAFA_OLD mode (no --probe in --help,
# version 1.14.0, --probe rejected), so this runs with any installed chafa;
# it used to depend on the real chafa being old and was skipped silently
# with chafa >= 1.16.
rm -f "$work/argv.log"; rm -rf "$work/home/.cache"
MOCK_CHAFA_OLD=1 run symbols "$work/bin"
check "old chafa: rendered, and never got --probe" \
  '[[ -s $work/argv.log && -s $work/out-symbols ]] && ! grep -q -- "--probe" "$work/argv.log"'
echo "probe tests: $passed passed, $failed failed"
((failed == 0))
