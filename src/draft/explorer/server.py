"""Serve the morphology atlas from ``web/``, plus two endpoints the page uses
when it runs locally: save a design into ``src/draft/robots/`` and run Draft's
generator and feasibility gate on it.

    python scripts/morphology_explorer.py            # http://127.0.0.1:8082
"""

from __future__ import annotations

import argparse
import contextlib
import io
import json
import mimetypes
import re
import tempfile
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import yaml

from draft.paths import repo_root
from draft.robots import ROBOTS_DIR

WEB = Path(__file__).parent / "web"

#: What the published page is wrapped in, so the local page renders the same.
_SKELETON = (
    '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
    '<meta name="atlas-server" content="1">\n'
    '<style>:root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);'
    'padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0;font:14px system-ui,'
    'sans-serif}img{max-width:100%}[hidden]{display:none!important}</style>\n'
    '</head>\n<body>\n{page}\n</body>\n</html>\n'
)

#: Designs the atlas exports are named `atlas_<id>`; nothing else is written.
_NAME = re.compile(r"^atlas_[a-z0-9]{3,16}$")
_FILES = ("parameters.yaml", "tree.yaml", "mesh.yaml")


def _design_files(body: dict) -> tuple[str, dict[str, str]]:
    name = str(body.get("name", ""))
    files = body.get("files") or {}
    if not _NAME.match(name):
        raise ValueError(f"not an atlas design name: {name!r}")
    if set(files) != set(_FILES) or not all(isinstance(v, str) for v in files.values()):
        raise ValueError(f"expected exactly {', '.join(_FILES)}")
    return name, files


def save_design(body: dict) -> dict:
    """Write the design into the robots directory, where every tool finds it."""
    name, files = _design_files(body)
    target = ROBOTS_DIR / name
    target.mkdir(parents=True, exist_ok=True)
    for fname, text in files.items():
        (target / fname).write_text(text, encoding="utf-8")
    try:
        shown = target.relative_to(repo_root())
    except ValueError:
        shown = target
    return {"path": str(shown)}


def check_design(body: dict) -> dict:
    """Compile the design in a scratch directory and report the gate's verdict."""
    from draft.generation.generator import RobotGenerator
    from draft.trends.feasibility import FeasibilityViolation

    name, files = _design_files(body)
    with tempfile.TemporaryDirectory() as tmp:
        src = Path(tmp) / name
        src.mkdir()
        for fname, text in files.items():
            (src / fname).write_text(text, encoding="utf-8")
        out = Path(tmp) / "out"
        log = io.StringIO()
        try:
            with contextlib.redirect_stdout(log), contextlib.redirect_stderr(log):
                RobotGenerator(src).generate(out)
        except FeasibilityViolation as exc:
            lines = [ln.strip().lstrip("- ").strip() for ln in str(exc).splitlines()[1:]]
            return {"verdict": "refused", "violations": [ln for ln in lines if ln]}
        report = next(out.rglob("feasibility_report.yaml"))
        rep = yaml.safe_load(report.read_text())
        return {"verdict": "compiled", "total_mass_kg": float(rep.get("total_mass_kg") or 0.0),
                "warnings": [str(w) for w in rep.get("warnings") or []]}


class _Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # quiet: one line per request is noise here
        pass

    def _send(self, status: int, body: bytes, ctype: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, status: int, data: dict) -> None:
        self._send(status, json.dumps(data).encode(), "application/json")

    def do_GET(self) -> None:
        path = self.path.split("?", 1)[0].lstrip("/") or "index.html"
        f = (WEB / path).resolve()
        if not f.is_relative_to(WEB.resolve()) or not f.is_file():
            self._send(HTTPStatus.NOT_FOUND, b"not found", "text/plain")
            return
        if f.name == "index.html":
            page = _SKELETON.replace("{page}", f.read_text(encoding="utf-8"))
            self._send(HTTPStatus.OK, page.encode(), "text/html; charset=utf-8")
            return
        ctype = "text/javascript" if f.suffix == ".js" else (
            mimetypes.guess_type(f.name)[0] or "application/octet-stream")
        self._send(HTTPStatus.OK, f.read_bytes(), ctype)

    def do_POST(self) -> None:
        actions = {"/api/save": save_design, "/api/check": check_design}
        action = actions.get(self.path)
        if action is None:
            self._json(HTTPStatus.NOT_FOUND, {"error": "no such endpoint"})
            return
        try:
            n = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(n) or b"{}")
            self._json(HTTPStatus.OK, action(body))
        except ValueError as exc:
            self._json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
        except Exception as exc:  # the page shows the message rather than hanging
            self._json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": f"{type(exc).__name__}: {exc}"})


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8082)
    args = ap.parse_args(argv)
    server = ThreadingHTTPServer((args.host, args.port), _Handler)
    print(f"Morphology atlas: http://{args.host}:{server.server_address[1]}/", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0
