# Non-interactive build for packagers (no sudo, nothing installed system-wide).
# Builds the pinned QuickJS submodule in-tree and uses its qjsc, which finds
# quickjs.h / libquickjs.a next to itself.
#
#   git submodule update --init --recursive
#   make
#   make install DESTDIR="$pkgdir" PREFIX=/usr
#
# Use a system qjsc instead with: make QJSC=qjsc

PREFIX  ?= /usr/local
BINDIR  ?= $(PREFIX)/bin
QJSC    ?= quickjs/qjsc
JOBS    ?= $(shell nproc 2>/dev/null || echo 1)

SOURCES := $(shell find src helpers -name '*.js') \
           $(wildcard qjs-ext-lib/src/*.js qjs-ext-lib/src/internal/*.js)

all: src/WallRizz

quickjs/qjsc:
	@test -f quickjs/Makefile || { echo "quickjs submodule missing: run 'git submodule update --init --recursive'"; exit 1; }
	$(MAKE) -C quickjs -j$(JOBS) qjsc libquickjs.a

ifeq ($(QJSC),quickjs/qjsc)
src/WallRizz: quickjs/qjsc
endif
src/WallRizz: $(SOURCES)
	cd src && $(abspath $(QJSC)) -flto -D extensions/ExtensionHandlerWorker.js -D wallpaper/thumbWorker.js -o WallRizz main.js

quickjs/qjs:
	$(MAKE) -C quickjs -j$(JOBS) qjs

test: quickjs/qjs src/WallRizz
	quickjs/qjs --std --module tests/imageProtocol.test.js
	tests/make-scan-tree.sh /tmp/wallrizz-scan-tree
	quickjs/qjs --std --module tests/scan.test.js /tmp/wallrizz-scan-tree
	rm -rf /tmp/wallrizz-tile-home && mkdir -p /tmp/wallrizz-tile-home
	magick -size 320x180 plasma:fractal -depth 8 /tmp/wallrizz-tile-home/thumb.png
	HOME=/tmp/wallrizz-tile-home quickjs/qjs --std --module tests/tileCache.test.js /tmp/wallrizz-tile-home/thumb.png
	quickjs/qjs --std --module tests/ueberzug.test.js tests/mock-ueberzugpp /tmp/wallrizz-ueberzug-test.log
	rm -rf /tmp/wallrizz-overlaywatch-test
	quickjs/qjs --std --module tests/overlayWatch.test.js $(abspath tests) /tmp/wallrizz-overlaywatch-test
	python3 tests/gallery-resize.test.py src/WallRizz tests/mock-ueberzugpp /tmp/wallrizz-resize-test
	cd src && ../quickjs/qjs --std --module ../tests/thumbnails.test.js $(abspath tests/mock-magick-slow) /tmp/wallrizz-thumbnails-test
	quickjs/qjs --std --module tests/cache.test.js /tmp/wallrizz-cache-test
	@if command -v chafa >/dev/null; then \
		tests/probe.test.sh src/WallRizz /tmp/wallrizz-probe-test && \
		python3 tests/gallery-ueberzug.test.py src/WallRizz tests/mock-ueberzugpp /tmp/wallrizz-gallery-test && \
		python3 tests/gallery-thumbs.test.py src/WallRizz tests/mock-magick-slow /tmp/wallrizz-thumbs-test && \
		python3 tests/gallery-pages.test.py src/WallRizz tests/mock-ueberzugpp tests/mock-magick-slow /tmp/wallrizz-pages-test && \
		python3 tests/gallery-confirm.test.py src/WallRizz $(abspath tests) tests/mock-magick-slow /tmp/wallrizz-confirm-test && \
		python3 tests/cache-flags.test.py src/WallRizz /tmp/wallrizz-cacheflags-test; \
	else echo "probe / gallery-ueberzug / gallery-thumbs / gallery-pages / gallery-confirm / cache-flags tests skipped: chafa not installed"; fi

install: src/WallRizz
	install -Dm755 src/WallRizz "$(DESTDIR)$(BINDIR)/WallRizz"

clean:
	rm -f src/WallRizz

distclean: clean
	$(MAKE) -C quickjs clean

.PHONY: all test install clean distclean
