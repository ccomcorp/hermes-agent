#!/usr/bin/env python3
"""AIOS overlay-injecting + live-reloading static server for Hermes Canvas.

Upstream Canvas serves a static project with `python -m http.server`, which returns
files as-is — so a plain static page has (a) NO Hermes selection overlay ("Select
Element" does nothing) and (b) NO hot-reload (agent edits don't appear until a manual
Refresh). This drop-in server fixes both. For every served .html it injects:

  1. the Canvas selection overlay JS (served at OVERLAY_ROUTE), and
  2. a tiny live-reload poller that reloads the page when project files change,

so click-to-select AND auto-refresh-on-edit work on static projects, like Vite's HMR.

Usage: python hermes_static_server.py <port>  (run with cwd = project dir)
Prints the upstream-compatible ready line so plugin_api.py's readiness regex matches.
"""
import hashlib
import http.server
import os
import socketserver
import sys
from pathlib import Path

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000

# The overlay ships with the plugin's vite-react template, next to this file.
OVERLAY_PATH = Path(__file__).resolve().parent / "templates" / "vite-react" / "src" / "hermes-canvas-overlay.js"
OVERLAY_ROUTE = "/__hermes_canvas_overlay.js"
RELOAD_ROUTE = "/__hermes_reload_token"

# Dirs never worth hashing for the reload token (churn/noise, not user content).
_SKIP_DIRS = {".git", ".worktrees", "node_modules", "__pycache__", "dist", ".vite"}

# Injected into every served HTML: the selection overlay + a 1s live-reload poller.
# The poller reloads the page whenever the reload token (a hash of project file mtimes)
# changes — i.e. right after the agent's worktree sync lands the edit in the project.
INJECT_TAG = (
    f'<script src="{OVERLAY_ROUTE}"></script>'
    "<script>(function(){var last=null;function poll(){"
    f'fetch("{RELOAD_ROUTE}",{{cache:"no-store"}}).then(function(r){{return r.text();}}).then(function(t){{'
    "if(last===null){last=t;}else if(t!==last){location.reload();}"
    "}).catch(function(){}).finally(function(){setTimeout(poll,1000);});}"
    "setTimeout(poll,1000);})();</script>"
)

try:
    OVERLAY_JS = OVERLAY_PATH.read_text(encoding="utf-8")
except Exception:
    OVERLAY_JS = "/* hermes-canvas overlay not found */"


def _reload_token(root: Path) -> str:
    """A cheap hash of the project's file paths + mtimes (skipping churny dirs).
    Changes whenever the agent's synced edit lands, which the injected poller detects."""
    h = hashlib.md5()
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in _SKIP_DIRS]
        for fn in filenames:
            fp = os.path.join(dirpath, fn)
            try:
                h.update(fp.encode("utf-8", "replace"))
                h.update(str(os.stat(fp).st_mtime_ns).encode("ascii"))
            except OSError:
                pass
    return h.hexdigest()


class _InjectingHandler(http.server.SimpleHTTPRequestHandler):
    def _send_body(self, body: bytes, content_type: str) -> None:
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802 (stdlib naming)
        route = self.path.split("?", 1)[0]

        if route == OVERLAY_ROUTE:
            self._send_body(OVERLAY_JS.encode("utf-8"), "application/javascript; charset=utf-8")
            return

        if route == RELOAD_ROUTE:
            self._send_body(_reload_token(Path.cwd()).encode("ascii"), "text/plain; charset=utf-8")
            return

        fs_path = Path(self.translate_path(self.path))
        if fs_path.is_dir():
            fs_path = fs_path / "index.html"

        if fs_path.suffix.lower() in (".html", ".htm") and fs_path.exists():
            try:
                html = fs_path.read_text(encoding="utf-8")
            except Exception:
                super().do_GET()
                return
            if "</body>" in html:
                html = html.replace("</body>", INJECT_TAG + "</body>", 1)
            else:
                html = html + INJECT_TAG
            self._send_body(html.encode("utf-8"), "text/html; charset=utf-8")
            return

        super().do_GET()

    def log_message(self, *args, **kwargs) -> None:  # keep the dev log readable
        try:
            super().log_message(*args, **kwargs)
        except Exception:
            pass


def main() -> None:
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("127.0.0.1", PORT), _InjectingHandler) as httpd:
        # Match plugin_api.py HTTP_SERVER_READY_RE: "Serving HTTP on <ip> port <port>".
        print(f"Serving HTTP on 127.0.0.1 port {PORT} (hermes overlay-injecting + live-reload)", flush=True)
        httpd.serve_forever()


if __name__ == "__main__":
    main()
