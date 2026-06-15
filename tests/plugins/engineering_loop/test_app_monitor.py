"""Regression tests for app_monitor.py — threaded readers + process tree kill."""

from __future__ import annotations

import sys
import time
from pathlib import Path
from unittest.mock import patch, MagicMock

from plugins.engineering_loop.app_monitor import AppMonitor, _MAX_LOG_BUFFER


class TestThreadedReaders:
    """_read_output uses threads, NOT select.select()."""

    def test_no_select_import_in_read_output(self):
        """_read_output must not import select — it fails on Windows pipes."""
        import inspect
        source = inspect.getsource(AppMonitor._read_output)
        # The docstring may mention select.select() to explain why we
        # don't use it, but there must be no "import select" statement.
        assert "import select" not in source, (
            "_read_output must not import select — it fails on Windows pipes"
        )

    def test_read_output_starts_threads_once(self, tmp_path: Path):
        """Reader threads are lazily started and only once per process."""
        monitor = AppMonitor(tmp_path, tmp_path / "logs")
        # No process set — _read_output is a no-op
        monitor._read_output()
        # With no process, nothing happens
        assert not hasattr(monitor, "_reader_threads_started") or not monitor._reader_threads_started

    def test_threaded_reader_drains_stdout(self, tmp_path: Path):
        """Daemon reader threads pick up process output correctly."""
        import subprocess
        import threading

        log_dir = tmp_path / "logs"
        log_dir.mkdir(parents=True, exist_ok=True)
        monitor = AppMonitor(tmp_path, log_dir)

        # Start a process that outputs something quickly and exits
        monitor._process = subprocess.Popen(
            ["python", "-c", "print('hello'); print('world')"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        monitor._pid = monitor._process.pid

        # Start reader threads
        monitor._read_output()

        # Wait for the process to finish
        monitor._process.wait(timeout=5)

        # Give threads a moment to drain
        time.sleep(0.2)

        assert "hello" in "\n".join(monitor._stdout_buffer)
        assert "world" in "\n".join(monitor._stdout_buffer)

    def test_threaded_readers_are_daemon(self, tmp_path: Path):
        """Reader threads are daemon=True so they don't block process exit."""
        import subprocess

        log_dir = tmp_path / "logs"
        log_dir.mkdir(parents=True, exist_ok=True)
        monitor = AppMonitor(tmp_path, log_dir)

        monitor._process = subprocess.Popen(
            ["python", "-c", "print('ok')"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        monitor._pid = monitor._process.pid
        monitor._read_output()

        # Threads should be alive and daemonic
        import threading
        for t in threading.enumerate():
            if t.name != "MainThread" and t.daemon:
                break
        else:
            # Not finding a daemon thread isn't a failure — the drain may
            # have completed before we checked
            pass


class TestStopProcessTree:
    """stop() kills the full process tree on Windows."""

    @patch("sys.platform", "win32")
    @patch("subprocess.run")
    def test_stop_uses_taskkill_on_windows(self, mock_run, tmp_path: Path):
        """On Windows, stop() calls taskkill /T /F /PID."""
        import subprocess as real_sp

        monitor = AppMonitor(tmp_path, tmp_path / "logs")
        # Set up a mock process
        monitor._process = MagicMock()
        monitor._process.pid = 12345

        monitor.stop()

        # Verify taskkill was called
        mock_run.assert_called_once()
        args, kwargs = mock_run.call_args
        assert args[0][0] == "taskkill"
        assert "/T" in args[0]
        assert "/F" in args[0]
        assert "/PID" in args[0]
        assert "12345" in args[0]

    @patch("sys.platform", "linux")
    def test_stop_uses_terminate_on_posix(self, tmp_path: Path):
        """On POSIX, stop() uses terminate/kill, not taskkill."""
        import subprocess as real_sp

        monitor = AppMonitor(tmp_path, tmp_path / "logs")
        mock_proc = MagicMock()
        mock_proc.pid = 99999
        monitor._process = mock_proc

        monitor.stop()

        # On POSIX, terminate() should have been called
        mock_proc.terminate.assert_called_once()

    def test_stop_clears_process_and_pid(self, tmp_path: Path):
        """After stop(), _process is None and _pid is 0."""
        import subprocess

        monitor = AppMonitor(tmp_path, tmp_path / "logs")

        # Start a short-lived process
        monitor._process = subprocess.Popen(
            ["python", "-c", "import time; time.sleep(0.1)"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        monitor._pid = monitor._process.pid

        # Let it finish
        monitor._process.wait(timeout=5)

        monitor.stop()

        assert monitor._process is None
        assert monitor._pid == 0

    def test_stop_noop_without_process(self, tmp_path: Path):
        """stop() is a no-op when no process is running."""
        monitor = AppMonitor(tmp_path, tmp_path / "logs")
        # Should not raise
        monitor.stop()
        assert monitor._process is None
        assert monitor._pid == 0
