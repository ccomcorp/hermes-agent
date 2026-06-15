"""App development monitor.

Manages the lifecycle of a dev server: start, readiness check, health probe,
smoke test, log capture, and cleanup.  All operations are non-blocking with
configurable timeouts.
"""

from __future__ import annotations

import json
import logging
import os
import re
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Dict, List, Optional

from .schemas import AppMonitorResult

logger = logging.getLogger(__name__)

# Patterns that signal a dev server is ready
_READY_PATTERNS = [
    r"(?:listening|running|ready|started|serving|accepting connections)",
    r"(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d+)",
    r"http://localhost:\d+",
    r"Server started",
    r"Development server",
    r"ready in \d",
    r"compiled successfully",
    r"Compiled successfully",
    r"VITE.*ready",
    r"VITE.*running",
]

# Maximum log buffer size before rotating to file
_MAX_LOG_BUFFER = 50_000


class AppMonitor:
    """Monitors a development server lifecycle.

    Usage::

        monitor = AppMonitor(project_root, log_dir)
        result = monitor.start("npm run dev", port=3000)
        if result.ready:
            print("App is running!")
        monitor.stop()
    """

    def __init__(self, project_root: Path, log_dir: Path) -> None:
        self._project_root = project_root
        self._log_dir = log_dir
        self._process: Optional[subprocess.Popen] = None
        self._pid: int = 0
        self._start_command: str = ""
        self._started_at: float = 0.0
        self._stdout_buffer: List[str] = []
        self._stderr_buffer: List[str] = []

    @property
    def is_running(self) -> bool:
        if self._process is None:
            return False
        return self._process.poll() is None

    @property
    def pid(self) -> int:
        return self._pid

    def start(
        self,
        command: str,
        port: int = 0,
        health_endpoint: str = "",
        readiness_timeout: float = 30.0,
        readiness_pattern: Optional[str] = None,
    ) -> AppMonitorResult:
        """Start a dev server and wait for readiness signal.

        Args:
            command: Shell command to start the dev server
            port: Expected port (0 = auto-detect from output)
            health_endpoint: Optional health check URL path (e.g., "/api/health")
            readiness_timeout: Max seconds to wait for ready signal
            readiness_pattern: Custom regex to detect readiness
        """
        self._start_command = command
        self._started_at = time.time()
        self._stdout_buffer = []
        self._stderr_buffer = []

        try:
            self._process = subprocess.Popen(
                command,
                shell=True,
                cwd=str(self._project_root),
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                env={**os.environ, "CI": "true"},
            )
            self._pid = self._process.pid
        except Exception as exc:
            return AppMonitorResult(
                start_command=command,
                running=False,
                error_summary=f"Failed to start: {exc}",
                started_at=self._started_at,
            )

        # Wait for readiness signal
        detected_port = port
        ready = False
        deadline = time.time() + readiness_timeout

        while time.time() < deadline:
            # Read available output
            self._read_output()

            # Check for ready patterns
            combined = "\n".join(self._stdout_buffer[-20:] + self._stderr_buffer[-10:])
            if readiness_pattern:
                if re.search(readiness_pattern, combined, re.IGNORECASE):
                    ready = True
                    break
            else:
                for pattern in _READY_PATTERNS:
                    m = re.search(pattern, combined, re.IGNORECASE)
                    if m:
                        ready = True
                        # Extract port if not specified
                        if not detected_port and m.lastindex and m.group(1):
                            try:
                                detected_port = int(m.group(1))
                            except (ValueError, IndexError):
                                pass
                        break
                if ready:
                    break

            # Check if process died
            if self._process.poll() is not None:
                break

            time.sleep(0.5)

        # If a health endpoint is configured, probe it
        health_status = 0
        if ready and detected_port and health_endpoint:
            health_status = self._probe_health(detected_port, health_endpoint)

        # Save logs
        log_path = self._save_logs()

        return AppMonitorResult(
            start_command=command,
            pid=self._pid,
            running=self.is_running,
            ready=ready,
            port=detected_port,
            health_endpoint=health_endpoint,
            health_status=health_status,
            server_logs_path=str(log_path),
            error_summary=self._extract_errors(),
            started_at=self._started_at,
            checked_at=time.time(),
        )

    def stop(self) -> None:
        """Stop the dev server and clean up, killing the full process tree.

        On Windows, uses ``taskkill /T /F /PID`` to kill child processes
        (e.g. cmd.exe-wrapped dev servers).  On POSIX, falls back to
        terminate/kill.
        """
        if self._process is None:
            return
        try:
            pid = self._process.pid
            if pid and sys.platform == "win32":
                # Kill the full process tree so cmd.exe wrappers don't
                # become orphans.
                subprocess.run(
                    ["taskkill", "/T", "/F", "/PID", str(pid)],
                    capture_output=True,
                    timeout=10,
                )
            else:
                self._process.terminate()
                try:
                    self._process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self._process.kill()
                    self._process.wait(timeout=2)
        except Exception:
            pass
        finally:
            self._process = None
            self._pid = 0

    def check(self) -> AppMonitorResult:
        """Check the current status of a running app."""
        if not self.is_running:
            return AppMonitorResult(
                start_command=self._start_command,
                running=False,
                error_summary="Process is not running",
                started_at=self._started_at,
                checked_at=time.time(),
            )

        self._read_output()
        return AppMonitorResult(
            start_command=self._start_command,
            pid=self._pid,
            running=True,
            ready=True,  # was running, assume still ready
            server_logs_path=str(self._log_dir / "app.log"),
            error_summary=self._extract_errors(),
            started_at=self._started_at,
            checked_at=time.time(),
        )

    def _read_output(self) -> None:
        """Read available stdout/stderr from the process via background threads.

        Uses one daemon reader thread per pipe so we are never blocked on a
        single pipe and never rely on ``select.select()``, which is
        unavailable for Windows pipe handles.
        """
        if self._process is None:
            return

        # Lazy-start reader threads (run once per process lifetime)
        if not hasattr(self, "_reader_threads_started"):
            self._reader_threads_started = False

        if not self._reader_threads_started:
            self._reader_threads_started = True

            def _drain(pipe, buffer: List[str], tag: str) -> None:
                try:
                    for line in pipe:
                        buffer.append(line.rstrip())
                        if sum(len(l) for l in buffer) > _MAX_LOG_BUFFER:
                            buffer[:] = buffer[-2000:]
                except (ValueError, OSError):
                    pass

            if self._process.stdout:
                t_stdout = threading.Thread(
                    target=_drain,
                    args=(self._process.stdout, self._stdout_buffer, "stdout"),
                    daemon=True,
                )
                t_stdout.start()

            if self._process.stderr:
                t_stderr = threading.Thread(
                    target=_drain,
                    args=(self._process.stderr, self._stderr_buffer, "stderr"),
                    daemon=True,
                )
                t_stderr.start()

    def _probe_health(self, port: int, endpoint: str) -> int:
        """Probe a health endpoint. Returns HTTP status code."""
        try:
            import urllib.request
            url = f"http://localhost:{port}{endpoint}"
            req = urllib.request.Request(url, method="GET")
            with urllib.request.urlopen(req, timeout=5) as resp:
                return resp.status
        except Exception:
            return 0

    def _extract_errors(self) -> str:
        """Extract error-looking lines from stderr."""
        error_lines = []
        for line in self._stderr_buffer[-50:]:
            low = line.lower()
            if any(
                kw in low
                for kw in [
                    "error", "exception", "traceback", "failed",
                    "cannot", "unable", "refused", "timeout",
                    "ERR!", "warn",
                ]
            ):
                error_lines.append(line[:200])
        return "\n".join(error_lines[-20:])

    def _save_logs(self) -> Path:
        """Save buffered logs to a file."""
        log_path = self._log_dir / "app.log"
        with open(log_path, "w", encoding="utf-8") as f:
            f.write(f"COMMAND: {self._start_command}\n")
            f.write(f"STARTED: {self._started_at}\n\n")
            f.write("--- STDOUT ---\n")
            f.write("\n".join(self._stdout_buffer))
            f.write("\n\n--- STDERR ---\n")
            f.write("\n".join(self._stderr_buffer))
        return log_path
