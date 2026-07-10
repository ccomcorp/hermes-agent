"""Backend routes for the Hermes Canvas dashboard plugin.

Manages local Vite projects, dev servers, and agent editing jobs.
Defensive design: works even if Hermes internals change.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

router = APIRouter()

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
PLUGIN_VERSION = "0.1.8"
VITE_READY_RE = re.compile(r"Local:\s+(http://(?:127\.0\.0\.1|localhost):(\d+))")
DEV_READY_RE = re.compile(r"ready in \d+ ms")
DEFAULT_DEV_PORT = 5173
MAX_PORT_ATTEMPTS = 32
HTTP_SERVER_READY_RE = re.compile(r"Serving HTTP on\s+([\d.]+)\s+port\s+(\d+)")

# Hard wall-clock cap for an agent edit job. Without it, a job that gets stuck (e.g. a
# post-edit headless-browser validation) hangs forever on "running" and never flips to
# done. The edit, if made, was already worktree-synced before the cap fires.
AGENT_JOB_TIMEOUT_S = 300

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

def _home() -> Path:
    return Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes")


def _plugin_dir() -> Path:
    return _home() / "plugins" / "hermes-canvas"


def _state_path() -> Path:
    return _plugin_dir() / "canvas-state.json"


def _jobs_dir() -> Path:
    return _plugin_dir() / "jobs"


def _templates_dir() -> Path:
    # AIOS patch: templates ship WITH the plugin code (dashboard/templates), NOT in the
    # runtime HERMES_HOME (which only holds canvas-state.json). Resolving relative to this
    # file makes "Create new project" find the vite-react scaffold whether the plugin runs
    # from the repo or an installed copy. (Upstream looked in _home()/plugins/... -> "Template not found".)
    return Path(__file__).resolve().parent / "templates"


def _projects_dir() -> Path:
    return _canvas_root()


# ---------------------------------------------------------------------------
# State management
# ---------------------------------------------------------------------------

class _State:
    """In-memory state with JSON persistence."""

    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.dev_proc: subprocess.Popen | None = None
        self.dev_port: int | None = None
        self.dev_preview_url: str | None = None
        self.dev_log_path: Path | None = None
        self.dev_stdout_thread: threading.Thread | None = None
        self.project_path: str | None = None
        # Paths the user explicitly opened (project/open) that live OUTSIDE the canvas
        # root; once opened they are allowlisted so their dev/agent ops pass validation.
        self.opened_paths: set[str] = set()
        self.agent_jobs: dict[str, dict[str, Any]] = {}
        self._load()

    def _load(self) -> None:
        path = _state_path()
        if not path.exists():
            return
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            self.project_path = data.get("project_path")
            self.opened_paths = set(data.get("opened_paths", []))
            # Restore agent job metadata (not subprocess handles)
            for job_id, job in data.get("agent_jobs", {}).items():
                if isinstance(job, dict):
                    self.agent_jobs[job_id] = job
        except Exception:
            pass

    def _save(self) -> None:
        path = _state_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        with self.lock:
            serializable_jobs = {}
            for job_id, job in self.agent_jobs.items():
                # Don't serialize Popen objects
                serializable_jobs[job_id] = {
                    k: v for k, v in job.items() if k != "proc"
                }
            payload = {
                "project_path": self.project_path,
                "opened_paths": sorted(self.opened_paths),
                "agent_jobs": serializable_jobs,
            }
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        tmp.replace(path)

    def set_project(self, path: str) -> None:
        with self.lock:
            self.project_path = path
        self._save()

    def add_opened_path(self, path: str) -> None:
        with self.lock:
            self.opened_paths.add(path)
        self._save()

    def register_dev(self, proc: subprocess.Popen, port: int, preview_url: str, log_path: Path) -> None:
        with self.lock:
            self.dev_proc = proc
            self.dev_port = port
            self.dev_preview_url = preview_url
            self.dev_log_path = log_path

    def clear_dev(self) -> None:
        with self.lock:
            self.dev_proc = None
            self.dev_port = None
            self.dev_preview_url = None
            self.dev_log_path = None

    def register_agent(self, job_id: str, proc: subprocess.Popen, log_path: Path, prompt: str) -> None:
        with self.lock:
            self.agent_jobs[job_id] = {
                "proc": proc,
                "log_path": str(log_path),
                "prompt": prompt,
                "started_at": _now_iso(),
                "running": True,
                "exit_code": None,
                "summary": None,
            }
        self._save()

    def update_agent(self, job_id: str, running: bool, exit_code: int | None, summary: str | None) -> None:
        with self.lock:
            if job_id in self.agent_jobs:
                self.agent_jobs[job_id]["running"] = running
                self.agent_jobs[job_id]["exit_code"] = exit_code
                self.agent_jobs[job_id]["summary"] = summary
                if not running:
                    self.agent_jobs[job_id]["finished_at"] = _now_iso()
        self._save()

    def clear_agent_activity(self) -> dict[str, Any]:
        """Clear completed/stale agent activity while preserving live process handles."""
        cleared_log_paths: list[str] = []
        with self.lock:
            kept: dict[str, dict[str, Any]] = {}
            for job_id, job in self.agent_jobs.items():
                proc = job.get("proc")
                is_live = proc is not None and proc.poll() is None
                if is_live:
                    kept[job_id] = job
                elif job.get("log_path"):
                    cleared_log_paths.append(str(job.get("log_path")))
            cleared_count = len(self.agent_jobs) - len(kept)
            self.agent_jobs = kept
        jobs_root = _jobs_dir().resolve()
        for raw_path in cleared_log_paths:
            try:
                log_path = Path(raw_path).resolve()
                if log_path == jobs_root or log_path.is_relative_to(jobs_root):
                    log_path.unlink(missing_ok=True)
            except Exception:
                pass
        self._save()
        return {"cleared_count": cleared_count, "remaining_running": len(kept)}

    def get_agent(self, job_id: str) -> dict[str, Any] | None:
        with self.lock:
            job = self.agent_jobs.get(job_id)
            if job is None:
                return None
            result = dict(job)
            proc = result.pop("proc", None)
            if proc is not None:
                result["running"] = proc.poll() is None
                if not result["running"] and result.get("exit_code") is None:
                    result["exit_code"] = proc.returncode
            return result

    def to_dict(self) -> dict[str, Any]:
        with self.lock:
            jobs = {}
            for job_id, job in self.agent_jobs.items():
                jobs[job_id] = {
                    k: v for k, v in job.items() if k != "proc"
                }
                proc = job.get("proc")
                if proc is not None:
                    jobs[job_id]["running"] = proc.poll() is None
                    if not jobs[job_id]["running"] and jobs[job_id].get("exit_code") is None:
                        jobs[job_id]["exit_code"] = proc.returncode
            return {
                "project_path": self.project_path,
                "dev_server_running": self.dev_proc is not None and self.dev_proc.poll() is None,
                "dev_port": self.dev_port,
                "dev_preview_url": self.dev_preview_url,
                "agent_jobs": jobs,
            }


_state = _State()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _canvas_root() -> Path:
    """The single root all canvas projects live under (validation + default parent)."""
    root_env = os.environ.get("HERMES_CANVAS_PROJECTS_ROOT")
    return Path(root_env).expanduser().resolve() if root_env else (_home().resolve() / "canvas-projects")


def _validate_path(path: str) -> Path:
    """Admit paths under the AIOS canvas projects root, OR any project the user has
    explicitly opened via project/open (allowlisted in _state.opened_paths). Arbitrary
    UNopened paths stay rejected for create/dev/agent operations."""
    root = _canvas_root()
    root.mkdir(parents=True, exist_ok=True)
    p = Path(path).expanduser().resolve()
    if p == root or p.is_relative_to(root):
        return p
    if str(p) in _state.opened_paths:
        return p
    raise HTTPException(status_code=400, detail="Path not allowed (open it via 'Open existing project' first)")


def _which(cmd: str) -> str | None:
    """Find command in PATH (delegates to stdlib so Windows PATHEXT resolution
    is honored, e.g. npm -> npm.CMD, which is required for subprocess.Popen)."""
    return shutil.which(cmd)


def _resolve_hermes_bin() -> str | None:
    """Resolve the hermes CLI, pinned to the interpreter's own venv so the
    dashboard's agent-edit uses the SAME Hermes install that serves it
    (not a different one on PATH). Order: explicit override, a launcher next
    to sys.executable, then PATH."""
    override = os.environ.get("HERMES_CANVAS_HERMES_BIN")
    if override and Path(override).exists():
        return override
    scripts_dir = Path(sys.executable).parent
    for name in ("hermes-real.exe", "hermes.exe", "hermes.cmd", "hermes"):
        cand = scripts_dir / name
        if cand.exists():
            return str(cand)
    return _which("hermes")


_SOURCE_EXTS = {".html", ".htm", ".js", ".jsx", ".ts", ".tsx", ".css", ".vue", ".svelte"}
_RESOLVE_SKIP_DIRS = {".git", ".worktrees", "node_modules", "__pycache__", "dist", ".vite"}


def _list_source_files(project_path: Path) -> list[Path]:
    """Fresh re-scan (not a cached re-stat) so agent-created files are always visible."""
    out: list[Path] = []
    for dirpath, dirnames, filenames in os.walk(project_path):
        dirnames[:] = [d for d in dirnames if d not in _RESOLVE_SKIP_DIRS]
        for fn in filenames:
            if Path(fn).suffix.lower() in _SOURCE_EXTS:
                out.append(Path(dirpath) / fn)
    return out


def _resolve_target_file(project_path: Path, selected_element: dict | None) -> dict | None:
    """Resolve the file to edit. Returns {rel_path, abs_path, source} or None.
    Wrong-file guarded: the resolved file must actually contain the element text."""
    if not selected_element:
        return None
    text = (selected_element.get("text") or "").strip()
    root = project_path.resolve()

    def _contains(abs_path: Path) -> bool:
        if not text:
            return True  # no text to verify against; attr is the only signal
        try:
            return text in abs_path.read_text(encoding="utf-8", errors="replace")
        except Exception:
            return False

    # 1) hermesAttributes.file (containment + wrong-file guard)
    attr = (selected_element.get("hermesAttributes") or {}).get("file")
    if attr:
        cand = (root / attr).resolve()
        if (cand == root or cand.is_relative_to(root)) and cand.is_file() and _contains(cand):
            return {"rel_path": str(cand.relative_to(root)), "abs_path": str(cand), "source": "hermes_file"}

    # 2) unique text match across source files
    if text:
        hits = [p for p in _list_source_files(root)
                if _safe_read_contains(p, text)]
        if len(hits) == 1:
            cand = hits[0].resolve()
            return {"rel_path": str(cand.relative_to(root)), "abs_path": str(cand), "source": "unique_text"}
    return None


def _safe_read_contains(path: Path, needle: str) -> bool:
    try:
        return needle in path.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return False


def _build_edit_prompt(user_prompt: str, resolved: dict | None,
                       selected_element: dict | None, file_list: list[str]) -> str:
    if resolved:
        try:
            contents = Path(resolved["abs_path"]).read_text(encoding="utf-8", errors="replace")
        except Exception:
            contents = ""
        head = (
            "You are editing a web project. Edit THIS file directly - do not search other files.\n"
            f"PATH: {resolved['rel_path']}\n---\n{contents}\n---\n"
            "Apply the change concisely. Preserve/add data-hermes-component, data-hermes-file, "
            "and data-hermes-role attributes on major elements. Do a quick read-back, then finish."
        )
    else:
        listing = "\n".join(file_list[:200])
        head = (
            "You are editing a web project in the current directory. It may be static HTML/CSS/JS "
            "or a Vite + React + Tailwind app - check the files first. Make the change concisely in "
            "the relevant file(s). Preserve/add data-hermes-* attributes on major elements. Do NOT "
            "run headless browsers, screenshots, or verification scripts.\n"
            f"Project files:\n{listing}"
        )
    prompt = f"{head}\n\nUser request: {user_prompt}"
    if selected_element:
        prompt += f"\n\nSelected element context: {json.dumps(selected_element)}"
    return prompt


def _has_npm() -> bool:
    return _which("npm") is not None


def _has_node() -> bool:
    return _which("node") is not None


def _find_free_port(start: int = DEFAULT_DEV_PORT, attempts: int = MAX_PORT_ATTEMPTS) -> int:
    import socket
    for offset in range(attempts):
        port = start + offset
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            if s.connect_ex(("127.0.0.1", port)) != 0:
                return port
    # Fallback: let OS assign a port by binding to 0
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]
    raise HTTPException(status_code=503, detail="No free port found for dev server")


def _read_log_tail(log_path: Path | None, max_lines: int = 200) -> list[str]:
    if not log_path or not log_path.exists():
        return []
    try:
        text = log_path.read_text(encoding="utf-8", errors="replace")
        lines = text.splitlines()
        return lines[-max_lines:] if len(lines) > max_lines else lines
    except Exception:
        return []


def _detect_auth_error(lines: list[str]) -> bool:
    """True only for a genuine auth failure. Requires an auth-signature phrase so
    incidental substrings like '1401ms' or a filename 'error-401.tsx' never match."""
    for ln in lines:
        low = ln.lower()
        if "authentication failed" in low:
            return True
        if "no valid authentication credentials" in low:
            return True
        if "http 401" in low or "401:" in low:
            return True
    return False


def _copy_template(template_name: str, dest: Path) -> None:
    allowed_templates = {"vite-react"}
    if template_name not in allowed_templates:
        raise HTTPException(status_code=400, detail=f"Template not allowed: {template_name}")
    src = (_templates_dir() / template_name).resolve()
    templates_root = _templates_dir().resolve()
    if not (src == templates_root or src.is_relative_to(templates_root)):
        raise HTTPException(status_code=400, detail="Template path not allowed")
    if not src.exists() or not src.is_dir():
        raise HTTPException(status_code=400, detail=f"Template not found: {template_name}")
    if dest.exists():
        raise HTTPException(status_code=400, detail=f"Destination already exists: {dest}")
    shutil.copytree(src, dest)


def _git_init_and_commit(project_path: Path) -> None:
    """Initialize git repo and make initial commit so --worktree works."""
    git = _which("git")
    if not git:
        return
    try:
        subprocess.run([git, "init"], cwd=project_path, check=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        subprocess.run([git, "add", "."], cwd=project_path, check=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        subprocess.run([git, "commit", "-m", "init", "--no-gpg-sign"], cwd=project_path, check=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    except subprocess.CalledProcessError:
        pass


def _run_npm_install(project_path: Path) -> None:
    npm = _which("npm")
    if not npm:
        raise HTTPException(status_code=500, detail="npm not found in PATH")
    try:
        subprocess.run(
            [npm, "install"],
            cwd=project_path,
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
    except subprocess.CalledProcessError as exc:
        raise HTTPException(status_code=500, detail=f"npm install failed: {exc.stdout}")


def _terminate_proc(proc: subprocess.Popen, timeout: int = 5) -> None:
    """Terminate a subprocess and its whole tree (Windows-safe)."""
    if proc.poll() is not None:
        return
    if sys.platform == "win32":
        try:
            subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
        try:
            proc.wait(timeout=timeout)
        except Exception:
            pass
        return
    try:
        os.killpg(proc.pid, 15)
    except Exception:
        try:
            proc.terminate()
        except Exception:
            pass
    try:
        proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, 9)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
        proc.wait()


def _prune_worktree(worktree_path: Path) -> None:
    try:
        shutil.rmtree(worktree_path, ignore_errors=True)
    except Exception:
        pass


def _commit_if_changed(project_path: Path) -> None:
    git = _which("git")
    if not git:
        return
    subprocess.run([git, "add", "."], cwd=project_path, check=False, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    diff = subprocess.run([git, "diff", "--cached", "--quiet"], cwd=project_path, check=False, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    if diff.returncode != 0:
        subprocess.run([git, "commit", "-m", "canvas update", "--no-gpg-sign"], cwd=project_path, check=False, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)


def _sync_worktree_changes(project_path: Path, worktree_path: Path | None = None) -> None:
    """Copy modified files from THIS job's git worktree back to the main project.
    worktree_path is REQUIRED; the old max(mtime) fallback is removed because it could
    copy a stale/leftover worktree over a fresh edit and commit the regression."""
    if worktree_path is None or not worktree_path.exists():
        return
    try:
        for subdir in ["src", "public"]:
            src = worktree_path / subdir
            dst = project_path / subdir
            if src.exists() and dst.exists():
                for f in src.rglob("*"):
                    if f.is_file():
                        rel = f.relative_to(src)
                        target = dst / rel
                        target.parent.mkdir(parents=True, exist_ok=True)
                        shutil.copy2(f, target)
        # Also sync root-level HTML/CSS/JS files for static projects
        for pattern in ["*.html", "*.css", "*.js", "*.jsx", "*.ts", "*.tsx"]:
            for f in worktree_path.glob(pattern):
                if f.is_file():
                    target = project_path / f.name
                    shutil.copy2(f, target)
        # Commit synced changes so next worktree starts from updated HEAD
        git = _which("git")
        if git:
            _commit_if_changed(project_path)
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Dev server stdout reader
# ---------------------------------------------------------------------------

def _dev_stdout_reader(proc: subprocess.Popen, log_path: Path, state_ref: _State) -> None:
    """Reads dev server stdout, writes to log file, detects ready URL."""
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with open(log_path, "w", encoding="utf-8") as log_file:
        for line in proc.stdout or []:
            log_file.write(line)
            log_file.flush()
            m = VITE_READY_RE.search(line)
            if m:
                preview_url = m.group(1)
                port = int(m.group(2))
                with state_ref.lock:
                    state_ref.dev_port = port
                    state_ref.dev_preview_url = preview_url
                state_ref._save()
                continue
            hm = HTTP_SERVER_READY_RE.search(line)
            if hm:
                port = int(hm.group(2))
                preview_url = f"http://127.0.0.1:{port}"
                with state_ref.lock:
                    state_ref.dev_port = port
                    state_ref.dev_preview_url = preview_url
                state_ref._save()


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

class CreateProjectRequest(BaseModel):
    parent_dir: str | None = Field(default=None, alias="parentDir")
    name: str
    template: str = "vite-react"


class OpenProjectRequest(BaseModel):
    project_path: str = Field(..., alias="projectPath")


class StartDevRequest(BaseModel):
    project_path: str = Field(..., alias="projectPath")
    port: int | None = None


class AgentPromptRequest(BaseModel):
    project_path: str = Field(..., alias="projectPath")
    prompt: str
    selected_element: dict | None = Field(default=None, alias="selectedElement")


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.get("/status")
async def status() -> dict[str, Any]:
    """Return current plugin state."""
    s = _state.to_dict()
    return {
        "ok": True,
        "version": PLUGIN_VERSION,
        "project_path": s.get("project_path"),
        "dev_server_running": s.get("dev_server_running", False),
        "dev_port": s.get("dev_port"),
        "dev_preview_url": s.get("dev_preview_url"),
        "agent_jobs": s.get("agent_jobs", {}),
        "has_node": _has_node(),
        "has_npm": _has_npm(),
        "default_project_parent": str(_projects_dir()),
    }


@router.post("/project/create")
async def project_create(req: CreateProjectRequest) -> dict[str, Any]:
    """Create a new project from a template."""
    raw_parent = (req.parent_dir or "").strip()
    using_default_parent = not raw_parent
    parent = _validate_path(raw_parent) if raw_parent else _projects_dir().resolve()
    name = re.sub(r"[^\w\-_.]", "", req.name)
    if not name:
        raise HTTPException(status_code=400, detail="Invalid project name")
    if using_default_parent:
        parent.mkdir(parents=True, exist_ok=True)
    elif not parent.exists() or not parent.is_dir():
        raise HTTPException(status_code=400, detail=f"Parent directory does not exist: {parent}")
    dest = parent / name
    _copy_template(req.template, dest)
    _run_npm_install(dest)
    _git_init_and_commit(dest)
    _state.set_project(str(dest))
    return {
        "ok": True,
        "project_path": str(dest),
        "parent_dir": str(parent),
        "used_default_parent": using_default_parent,
    }


@router.post("/project/open")
async def project_open(req: OpenProjectRequest) -> dict[str, Any]:
    """Open an existing project from ANY directory (not just under the canvas root)."""
    # Relaxed resolution so "Open existing project" works for a project ANYWHERE. We
    # resolve without the root restriction, verify it's a real project dir, then
    # allowlist it (_state.opened_paths) so its later dev/start + agent ops pass
    # _validate_path. (Upstream required the path be under the canvas root -> "Path not
    # allowed" -> the Open button silently no-op'd for projects elsewhere.)
    path = Path(req.project_path).expanduser().resolve()
    if not path.is_dir():
        raise HTTPException(status_code=400, detail="Project directory not found: " + str(path))
    package_json = path / "package.json"
    index_html = path / "index.html"
    if not package_json.exists() and not index_html.exists():
        raise HTTPException(status_code=400, detail="No package.json or index.html found in project path")
    _state.add_opened_path(str(path))
    if not (path / ".git").exists():
        _git_init_and_commit(path)
    _state.set_project(str(path))
    return {"ok": True, "project_path": str(path), "package_json_found": package_json.exists(), "index_html_found": index_html.exists()}


@router.post("/dev/start")
async def dev_start(req: StartDevRequest) -> dict[str, Any]:
    """Start the dev server."""
    project_path = _validate_path(req.project_path)
    package_json = project_path / "package.json"
    index_html = project_path / "index.html"

    # Stop existing dev server if running
    if _state.dev_proc is not None and _state.dev_proc.poll() is None:
        _terminate_proc(_state.dev_proc)
        _state.clear_dev()

    port = req.port or _find_free_port()
    log_path = _plugin_dir() / "dev-server.log"

    if package_json.exists():
        npm = _which("npm")
        if not npm:
            raise HTTPException(status_code=500, detail="npm not found")

        env = os.environ.copy()
        env["PORT"] = str(port)
        env["HOST"] = "127.0.0.1"

        proc = subprocess.Popen(
            [npm, "run", "dev", "--", "--port", str(port), "--host", "127.0.0.1"],
            cwd=project_path,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            env=env,
            start_new_session=True,
        )
    elif index_html.exists():
        python = sys.executable
        # AIOS: serve static projects through the overlay-injecting server so
        # click-to-select works on plain static pages too (upstream `http.server`
        # served files as-is -> no selection overlay -> "Select Element" did nothing).
        static_server = str(Path(__file__).resolve().parent / "hermes_static_server.py")
        proc = subprocess.Popen(
            [python, static_server, str(port)],
            cwd=project_path,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            start_new_session=True,
        )
    else:
        raise HTTPException(status_code=400, detail="No package.json or index.html found")

    _state.register_dev(proc, port, f"http://127.0.0.1:{port}", log_path)

    # Start stdout reader thread
    thread = threading.Thread(
        target=_dev_stdout_reader,
        args=(proc, log_path, _state),
        daemon=True,
    )
    thread.start()
    _state.dev_stdout_thread = thread

    # Wait a moment for the reader to potentially capture the URL
    time.sleep(1.5)

    if proc.poll() is not None:
        logs = _read_log_tail(log_path, max_lines=40)
        _state.clear_dev()
        raise HTTPException(
            status_code=500,
            detail="Dev server exited immediately" + ((": " + "\n".join(logs[-10:])) if logs else ""),
        )

    # Use actual detected port/preview_url if available (Vite may report a different port)
    actual_port = _state.dev_port or port
    actual_url = _state.dev_preview_url or f"http://127.0.0.1:{port}"

    return {
        "ok": True,
        "preview_url": actual_url,
        "port": actual_port,
        "pid": proc.pid,
    }


@router.post("/dev/stop")
async def dev_stop() -> dict[str, Any]:
    """Stop the dev server."""
    proc = _state.dev_proc
    if proc is None:
        return {"ok": True, "stopped": False, "detail": "No dev server was running"}

    if proc.poll() is None:
        _terminate_proc(proc)

    _state.clear_dev()
    return {"ok": True, "stopped": True}


@router.get("/dev/logs")
async def dev_logs() -> dict[str, Any]:
    """Return recent dev server logs."""
    lines = _read_log_tail(_state.dev_log_path)
    return {"ok": True, "lines": lines}


@router.post("/agent/clear")
async def agent_clear() -> dict[str, Any]:
    """Clear completed/stale agent activity from the UI."""
    result = _state.clear_agent_activity()
    return {
        "ok": True,
        "cleared_count": result["cleared_count"],
        "remaining_running": result["remaining_running"],
        "agent_jobs": _state.to_dict().get("agent_jobs", {}),
    }


@router.post("/agent/prompt")
async def agent_prompt(req: AgentPromptRequest) -> dict[str, Any]:
    """Send a prompt to Hermes to edit the project."""
    project_path = _validate_path(req.project_path)
    if not (project_path / "package.json").exists() and not (project_path / "index.html").exists():
        raise HTTPException(status_code=400, detail="No package.json or index.html found")

    hermes_bin = _resolve_hermes_bin()
    if not hermes_bin:
        raise HTTPException(status_code=500, detail="hermes CLI not found in PATH")

    # Serialize edit jobs: terminate any still-running job before starting a new one.
    # Two concurrent jobs each create their own .worktrees/* dir, and the live-sync
    # picks the LATEST worktree by mtime — so a second prompt could race/overwrite the
    # first and silently fail to land. One job at a time keeps the sync deterministic.
    for _jid, _job in list(_state.agent_jobs.items()):
        _p = _job.get("proc")
        if _job.get("running") and _p is not None and _p.poll() is None:
            _terminate_proc(_p)
            _state.update_agent(_jid, running=False, exit_code=-1, summary="Superseded by a new prompt")

    job_id = f"agent-{_now_iso().replace(':', '-')}"
    log_path = _jobs_dir() / f"{job_id}.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)

    # project_path is already validated above. Resolve the target file + build the prompt.
    resolved = _resolve_target_file(project_path, req.selected_element)
    file_list = [str(p.relative_to(project_path)) for p in _list_source_files(project_path)] if not resolved else []
    full_prompt = _build_edit_prompt(req.prompt, resolved, req.selected_element, file_list)

    cmd = [
        hermes_bin,
        "chat",
        "-q", full_prompt,
        "-t", "file",
        "--quiet",
        "--source", "tool",
        "--yolo",
        "--ignore-rules",
        # AIOS: do NOT pass --ignore-user-config. It also strips the model/provider
        # config from HERMES_HOME/config.yaml, so the agent runs with no LLM endpoint
        # ("HTTP 404: No endpoints found for .") and every edit no-ops. --ignore-rules
        # already skips rule/hook enforcement; the model config must be kept.
        "--worktree",
        "--max-turns", "3",
    ]

    log_file = open(log_path, "w", encoding="utf-8")
    proc = subprocess.Popen(
        cmd,
        cwd=project_path,
        stdout=log_file,
        stderr=subprocess.STDOUT,
        text=True,
    )

    _state.register_agent(job_id, proc, log_path, req.prompt)

    with _state.lock:
        if job_id in _state.agent_jobs:
            _state.agent_jobs[job_id]["resolution_source"] = resolved["source"] if resolved else "none"
            _state.agent_jobs[job_id]["target_file"] = resolved["rel_path"] if resolved else None

    # Track worktree path for live syncing
    _worktree_paths: dict[str, Path] = {}

    def _live_sync_reader() -> None:
        """Polls .worktrees directory and syncs changes repeatedly while job runs."""
        worktrees_dir = project_path / ".worktrees"
        current_worktree: Path | None = None
        sync_count = 0
        while proc.poll() is None:
            time.sleep(2)
            # 401 early-abort: stop burning turns on a dead token.
            try:
                if _detect_auth_error(_read_log_tail(log_path, max_lines=40)):
                    with _state.lock:
                        if job_id in _state.agent_jobs:
                            _state.agent_jobs[job_id]["auth_error"] = True
                    _terminate_proc(proc)
                    break
            except Exception:
                pass
            if not worktrees_dir.exists():
                continue
            worktrees = [d for d in worktrees_dir.iterdir() if d.is_dir()]
            if not worktrees:
                continue
            latest = max(worktrees, key=lambda p: p.stat().st_mtime)
            if latest != current_worktree:
                current_worktree = latest
                _worktree_paths[job_id] = latest
            # Sync every 2 seconds from the current worktree
            if current_worktree:
                _sync_worktree_changes(project_path, current_worktree)
                sync_count += 1
        # Final sync after process exits
        if current_worktree and current_worktree.exists():
            _sync_worktree_changes(project_path, current_worktree)

    sync_thread = threading.Thread(target=_live_sync_reader, daemon=True)
    sync_thread.start()

    # Monitor process completion
    def _monitor() -> None:
        try:
            exit_code = proc.wait(timeout=AGENT_JOB_TIMEOUT_S)
        except subprocess.TimeoutExpired:
            _terminate_proc(proc)
            try:
                exit_code = proc.wait(timeout=10)
            except Exception:
                exit_code = -1
        finally:
            try:
                log_file.close()
            except Exception:
                pass
        summary = "Agent finished" if exit_code == 0 else f"Agent stopped (exit {exit_code})"
        try:
            log_text = log_path.read_text(encoding="utf-8", errors="replace")
            lines = [ln for ln in log_text.splitlines() if ln.strip()]
            if lines:
                summary = lines[-1][:200]
        except Exception:
            pass
        _state.update_agent(job_id, running=False, exit_code=exit_code, summary=summary)
        # Let the live-sync thread finish its final worktree->project sync before we
        # prune the worktree, otherwise a last-moment edit could be dropped (the final
        # sync no-ops on a missing worktree).
        try:
            sync_thread.join(timeout=10)
        except Exception:
            pass
        wt = _worktree_paths.get(job_id)
        if wt is not None:
            _prune_worktree(wt)

    monitor_thread = threading.Thread(target=_monitor, daemon=True)
    monitor_thread.start()

    return {"ok": True, "job_id": job_id, "status": "started"}


@router.get("/agent/status/{job_id}")
async def agent_status(job_id: str) -> dict[str, Any]:
    """Get the status of an agent job."""
    job = _state.get_agent(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")

    log_path = Path(job.get("log_path", "")) if job.get("log_path") else None
    logs = _read_log_tail(log_path)

    return {
        "ok": True,
        "job_id": job_id,
        "running": job.get("running", False),
        "exit_code": job.get("exit_code"),
        "summary": job.get("summary"),
        "started_at": job.get("started_at"),
        "finished_at": job.get("finished_at"),
        "logs": logs,
        "auth_error": job.get("auth_error", False),
    }
