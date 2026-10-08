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
	cd src && $(abspath $(QJSC)) -flto -D extensions/ExtensionHandlerWorker.js -o WallRizz main.js

quickjs/qjs:
	$(MAKE) -C quickjs -j$(JOBS) qjs

test: quickjs/qjs
	quickjs/qjs --std --module tests/imageProtocol.test.js
	tests/make-scan-tree.sh /tmp/wallrizz-scan-tree
	quickjs/qjs --std --module tests/scan.test.js /tmp/wallrizz-scan-tree

install: src/WallRizz
	install -Dm755 src/WallRizz "$(DESTDIR)$(BINDIR)/WallRizz"

clean:
	rm -f src/WallRizz

distclean: clean
	$(MAKE) -C quickjs clean

.PHONY: all test install clean distclean
