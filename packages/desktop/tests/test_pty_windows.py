"""ConPTY backend smoke test for Windows.

Skipped on Mac/Linux. The CI windows-latest job runs this to catch
ConPTY I/O bugs that the import-only verification can't reach: spawn
failures, encoding regressions, terminate hangs.

The test is deliberately minimal — spawn `cmd /c echo applyloop-pty-ok`,
read until EOF, assert the marker is present. Anything that breaks
ConPTY at the spawn or I/O layer will fail loudly here instead of
slipping into a user session and silently breaking Claude's tool calls.
"""
from __future__ import annotations

import os
import sys
import time
import unittest


@unittest.skipIf(sys.platform != "win32", "Windows-only ConPTY test")
class WindowsPTYTest(unittest.TestCase):
    def test_spawn_echo_and_read(self) -> None:
        # Import via the `server` package so pty_backend's relative import
        # `from .pty_windows import ...` resolves. Don't add server/ to
        # sys.path directly — that breaks the relative import.
        sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
        from server.pty_backend import PlatformPTY  # type: ignore[import-not-found]

        pty = PlatformPTY()
        pid = pty.spawn(
            ["cmd", "/c", "echo applyloop-pty-ok"],
            cwd=os.getcwd(),
            env=os.environ.copy(),
        )
        self.assertGreater(pid, 0, "spawn should return a positive PID")

        # Read until EOF or timeout. The child should print the marker
        # and exit within a fraction of a second; cap at 5s for slow CI.
        deadline = time.monotonic() + 5.0
        out = b""
        while time.monotonic() < deadline:
            chunk = pty.read(4096)
            if not chunk:
                # is_alive() is the authoritative end-of-stream signal —
                # ConPTY can briefly return b"" mid-stream while the child
                # is still alive (small read buffer race).
                if not pty.is_alive():
                    break
                time.sleep(0.05)
                continue
            out += chunk
            if b"applyloop-pty-ok" in out:
                break

        self.assertIn(
            b"applyloop-pty-ok",
            out,
            f"echo marker not found in {len(out)} bytes of output: {out[:200]!r}",
        )

        pty.terminate()
        # Don't assert exact death here — ConPTY's terminate is async and
        # the child may already be dead from the echo+exit. The fact that
        # we got the marker is the win.


if __name__ == "__main__":
    unittest.main()
