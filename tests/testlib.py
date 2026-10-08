"""Helpers for the pty end-to-end tests: condition-based waits.

Every wait polls until its condition holds (or the process exits) and has a
generous deadline, so the tests pass on slow or busy machines.
WALLRIZZ_TEST_TIMEOUT_SCALE (default 1) multiplies every deadline.
"""
import os, select, time

SCALE = float(os.environ.get("WALLRIZZ_TEST_TIMEOUT_SCALE") or 1) or 1.0
DEFAULT_TIMEOUT = 30


def deadline(sec=DEFAULT_TIMEOUT):
    """seconds allowed for a wait, scaled"""
    return sec * SCALE


class Checks:
    def __init__(self, suite):
        self.suite, self.passed, self.failed = suite, 0, 0

    def check(self, name, ok, info=""):
        if ok:
            self.passed += 1
        else:
            self.failed += 1
            print(f"FAIL {name} {info}".rstrip())
        return ok

    def done(self):
        print(f"{self.suite} tests: {self.passed} passed, {self.failed} failed")
        raise SystemExit(1 if self.failed else 0)


class Pty:
    """the master side of a pty.fork(): keeps reading so the child never
    blocks on a full pty, and collects everything it printed"""

    def __init__(self, pid, fd):
        self.pid, self.fd, self.out, self.closed = pid, fd, b"", False
        self.status = None  # waitpid status once the child exited

    def pump(self, sec=0.05):
        end = time.monotonic() + sec
        while not self.closed:
            left = end - time.monotonic()
            if left <= 0:
                return
            r, _, _ = select.select([self.fd], [], [], min(left, 0.05))
            if r:
                try:
                    data = os.read(self.fd, 65536)
                except OSError:
                    data = b""
                if not data:
                    self.closed = True
                    return
                self.out += data
        time.sleep(max(0.0, min(sec, 0.05)))

    def exited(self):
        if self.status is not None:
            return True
        try:
            wpid, status = os.waitpid(self.pid, os.WNOHANG)
        except ChildProcessError:
            wpid, status = self.pid, 0
        if wpid == self.pid:
            self.status = status
            return True
        return False

    def wait_for(self, what, cond, sec=DEFAULT_TIMEOUT, stop_on_exit=True):
        """poll cond() (reading the pty meanwhile) until it is true, the
        child exits (if stop_on_exit) or the scaled deadline passes"""
        limit = deadline(sec)
        end = time.monotonic() + limit
        while True:
            if cond():
                return True
            if stop_on_exit and self.exited():
                self.pump(0.2)  # last output
                if cond():
                    return True
                print(f"WAIT {what}: WallRizz exited first (status {self.status})")
                return False
            if time.monotonic() >= end:
                print(f"TIMEOUT after {limit:.0f}s waiting for {what}")
                return False
            self.pump(0.05)

    def wait_exit(self, what, sec=DEFAULT_TIMEOUT):
        """wait for the child to exit; SIGTERM + reap it on timeout"""
        if self.wait_for(what, self.exited, sec, stop_on_exit=False):
            return True
        try:
            os.kill(self.pid, 15)
            os.waitpid(self.pid, 0)
        except (ProcessLookupError, ChildProcessError):
            pass
        return False

    def write(self, data):
        os.write(self.fd, data)
