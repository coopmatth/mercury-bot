"""Build identity for cache busting.

The service worker caches static assets cache-first, keyed by a version
string. If that string does not change when the assets do, an installed phone
keeps serving stale JavaScript forever — including stale pay calculations,
which is a money bug rather than a cosmetic one.

So the version is derived from the assets themselves instead of a constant
someone has to remember to bump. Any change to a template, stylesheet or
script produces a different id, the bytes of /sw.js change, the browser sees
an updated worker, and the old caches are dropped.
"""
from __future__ import annotations

import hashlib
from pathlib import Path

from .config import BASE_DIR

# Directories whose contents the browser caches.
WATCHED = ("static", "templates")

# Files larger than this are fingerprinted by size rather than content. It
# only applies to the vendored OCR engine (~9.7 MB), which is immutable —
# reading it on every boot would cost far more than it detects.
CONTENT_HASH_LIMIT = 1_000_000

_cached: str | None = None


def _walk(root: Path):
    for path in sorted(root.rglob("*")):
        if path.is_file() and "__pycache__" not in path.parts:
            yield path


def compute_build_id(base: Path | None = None) -> str:
    """Short hash over everything the service worker may cache."""
    base = base or BASE_DIR
    digest = hashlib.sha256()

    for name in WATCHED:
        root = base / name
        if not root.is_dir():
            continue
        for path in _walk(root):
            digest.update(str(path.relative_to(base)).encode())
            try:
                size = path.stat().st_size
                if size > CONTENT_HASH_LIMIT:
                    digest.update(str(size).encode())
                else:
                    digest.update(path.read_bytes())
            except OSError:
                # A file that vanished mid-walk should not break page serving.
                digest.update(b"?")

    return digest.hexdigest()[:12]


def build_id() -> str:
    """Cached for the life of the process — a restart follows every deploy."""
    global _cached
    if _cached is None:
        _cached = compute_build_id()
    return _cached


def reset_cache() -> None:
    """Drop the memoised id. For tests."""
    global _cached
    _cached = None
