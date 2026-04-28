#!/usr/bin/env python3
"""
Local HTTP embedding server for codebase-mcp.

Defaults:
- EMBED_MODEL=BAAI/bge-large-en-v1.5
- EMBED_DEVICE=cpu
- EMBED_HOST=127.0.0.1
- EMBED_PORT=8080

API:
- GET  /healthz
- POST /v1/embeddings
  body: {"input": "text" | ["text1", "text2"], "model": "...optional..."}
  response: {"data":[{"embedding":[...]}...], ...}
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path
from typing import List, Optional, Union

DEPS = ["fastapi", "uvicorn", "sentence-transformers", "einops"]


def ensure_python3() -> None:
    if sys.version_info.major >= 3:
        return
    py3 = os.environ.get("PYTHON3_BIN", "python3")
    print(
        f"[codebase-mcp-embed-server] current interpreter is Python {sys.version_info.major}; "
        f"restarting with {py3}",
        file=sys.stderr,
    )
    os.execvp(py3, [py3, *sys.argv])


def ensure_venv() -> None:
    if os.environ.get("EMBED_USE_VENV", "1").lower() in {"0", "false", "no"}:
        return
    # If already inside a venv, keep current interpreter.
    if getattr(sys, "base_prefix", sys.prefix) != sys.prefix:
        return

    venv_dir = Path(
        os.environ.get(
            "EMBED_VENV_DIR",
            str(Path.home() / ".cache" / "codebase-mcp-embed-server" / "venv"),
        )
    )
    py = venv_dir / "bin" / "python3"

    if not py.exists():
        print(
            f"[codebase-mcp-embed-server] creating virtualenv at {venv_dir}",
            file=sys.stderr,
        )
        venv_dir.parent.mkdir(parents=True, exist_ok=True)
        r = subprocess.run([sys.executable, "-m", "venv", str(venv_dir)], check=False)
        if r.returncode != 0:
            print(
                "[codebase-mcp-embed-server] failed to create virtualenv. "
                "Install manually with Python 3 venv and rerun.",
                file=sys.stderr,
            )
            sys.exit(r.returncode)

    if str(py) != sys.executable:
        print(
            f"[codebase-mcp-embed-server] restarting inside virtualenv: {py}",
            file=sys.stderr,
        )
        os.execv(str(py), [str(py), *sys.argv])


def install_deps() -> int:
    clean_env = os.environ.copy()
    # Prevent legacy Python 2 site-packages leakage into Python 3 pip runs.
    clean_env.pop("PYTHONPATH", None)
    clean_env.pop("PYTHONHOME", None)
    clean_env["PIP_DISABLE_PIP_VERSION_CHECK"] = "1"
    clean_env["PYTHONNOUSERSITE"] = "1"

    # Ensure pip exists for the interpreter we are about to use.
    ensurepip_cmds = [
        [sys.executable, "-I", "-m", "ensurepip", "--upgrade"],
        ["python3", "-I", "-m", "ensurepip", "--upgrade"],
    ]
    for cmd in ensurepip_cmds:
        try:
            subprocess.run(cmd, check=False, env=clean_env)
        except FileNotFoundError:
            continue

    cmds = [
        [sys.executable, "-I", "-m", "pip", "install", *DEPS],
        ["python3", "-I", "-m", "pip", "install", *DEPS],
        ["pip3", "install", *DEPS],
    ]
    for cmd in cmds:
        try:
            r = subprocess.run(cmd, check=False, env=clean_env)
            if r.returncode == 0:
                return 0
        except FileNotFoundError:
            continue
    return 1


def ensure_deps() -> None:
    try:
        # noqa: F401
        import fastapi  # type: ignore
        import pydantic  # type: ignore
        import sentence_transformers  # type: ignore
        import uvicorn  # type: ignore
        return
    except Exception as e:  # pragma: no cover
        print(
            "[codebase-mcp-embed-server] missing Python deps; installing: "
            + " ".join(DEPS),
            file=sys.stderr,
        )
        print(f"[codebase-mcp-embed-server] import error: {e}", file=sys.stderr)
    if install_deps() != 0:
        print(
            "[codebase-mcp-embed-server] dependency install failed. "
            "Run manually with Python 3: python3 -m pip install fastapi uvicorn sentence-transformers einops",
            file=sys.stderr,
        )
        sys.exit(1)


ensure_python3()
ensure_venv()
ensure_deps()
from fastapi import FastAPI  # type: ignore  # noqa: E402
from pydantic import BaseModel  # type: ignore  # noqa: E402
from sentence_transformers import SentenceTransformer  # type: ignore  # noqa: E402
import uvicorn  # type: ignore  # noqa: E402


EMBED_MODEL = os.getenv("EMBED_MODEL", "BAAI/bge-large-en-v1.5")
EMBED_DEVICE = os.getenv("EMBED_DEVICE", "cpu")
EMBED_HOST = os.getenv("EMBED_HOST", "127.0.0.1")
EMBED_PORT = int(os.getenv("EMBED_PORT", "8080"))
EMBED_TRUST_REMOTE_CODE = os.getenv("EMBED_TRUST_REMOTE_CODE", "1").lower() in {
    "1",
    "true",
    "yes",
}

print(
    f"[codebase-mcp-embed-server] loading model={EMBED_MODEL} device={EMBED_DEVICE} "
    f"host={EMBED_HOST} port={EMBED_PORT} trust_remote_code={EMBED_TRUST_REMOTE_CODE}",
    file=sys.stderr,
)
try:
    MODEL = SentenceTransformer(
        EMBED_MODEL,
        device=EMBED_DEVICE,
        trust_remote_code=EMBED_TRUST_REMOTE_CODE,
    )
except Exception as e:
    print(
        f"[codebase-mcp-embed-server] failed to load model={EMBED_MODEL}: {e}",
        file=sys.stderr,
    )
    print(
        "[codebase-mcp-embed-server] If this is a custom module error (e.g. `custom_st`), "
        "keep EMBED_TRUST_REMOTE_CODE=1 or try a fallback model like "
        "`BAAI/bge-base-en-v1.5` / `BAAI/bge-large-en-v1.5`.",
        file=sys.stderr,
    )
    raise

app = FastAPI(title="codebase-mcp-embed-server", version="1.0")


class EmbReq(BaseModel):
    input: Union[str, List[str]]
    model: Optional[str] = None


@app.get("/healthz")
def healthz() -> dict:
    return {"ok": True, "model": EMBED_MODEL, "device": EMBED_DEVICE}


@app.post("/v1/embeddings")
def embeddings(req: EmbReq) -> dict:
    texts = [req.input] if isinstance(req.input, str) else req.input
    vecs = MODEL.encode(
        texts,
        normalize_embeddings=True,
        convert_to_numpy=True,
        show_progress_bar=False,
    )
    return {
        "object": "list",
        "model": req.model or EMBED_MODEL,
        "data": [
            {"object": "embedding", "index": i, "embedding": v.tolist()}
            for i, v in enumerate(vecs)
        ],
    }


if __name__ == "__main__":
    uvicorn.run(app, host=EMBED_HOST, port=EMBED_PORT, log_level="info")
