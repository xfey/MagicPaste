#!/usr/bin/env python3
from __future__ import annotations

import sys
import zipfile
from pathlib import Path

RUAMEL_INIT = """# Added for zipimport compatibility with namespace packages.
from pkgutil import extend_path
__path__ = extend_path(__path__, __name__)
"""

OPENAI_LIB_INIT = """# Added for zipimport compatibility with namespace packages.
# openai.lib ships without __init__.py; zipimport can't import namespace packages.
"""


def ensure_ruamel_init(zip_path: Path) -> bool:
    with zipfile.ZipFile(zip_path, "a", compression=zipfile.ZIP_DEFLATED) as zf:
        if "ruamel/__init__.py" in zf.namelist():
            return False
        zf.writestr("ruamel/__init__.py", RUAMEL_INIT)
        return True


def ensure_openai_lib_init(zip_path: Path) -> bool:
    with zipfile.ZipFile(zip_path, "a", compression=zipfile.ZIP_DEFLATED) as zf:
        if "openai/lib/__init__.py" in zf.namelist():
            return False
        zf.writestr("openai/lib/__init__.py", OPENAI_LIB_INIT)
        return True


def _iter_new_layout(runtime_root: Path, arch: str):
    lib_root = runtime_root / arch / "lib"
    if not lib_root.exists():
        return
    versions = sorted([p for p in lib_root.iterdir() if p.is_dir() and p.name.startswith("python")])
    for version_dir in versions:
        sp = version_dir / "site-packages"
        zip_path = sp / "site-packages.zip"
        if zip_path.exists():
            yield arch, zip_path


def _iter_legacy_layout(runtime_root: Path, arch: str):
    versions_root = runtime_root / arch / "Frameworks" / "Python.framework" / "Versions"
    if not versions_root.exists():
        return
    versions = sorted([p for p in versions_root.iterdir() if p.is_dir() and p.name != "Current"])
    for version_dir in versions:
        py_version = version_dir.name
        sp = version_dir / "lib" / f"python{py_version}" / "site-packages"
        zip_path = sp / "site-packages.zip"
        if zip_path.exists():
            yield arch, zip_path


def iter_zip_paths(repo_root: Path):
    runtime_root = repo_root / "runtime" / "python"
    for arch in ("arm64", "x64"):
        yield from _iter_new_layout(runtime_root, arch)
        yield from _iter_legacy_layout(runtime_root, arch)


def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: patch_site_packages_zip.py <repo_root>", file=sys.stderr)
        return 2
    repo_root = Path(sys.argv[1]).resolve()
    if not repo_root.exists():
        print(f"Repo root not found: {repo_root}", file=sys.stderr)
        return 2

    touched = 0
    scanned = 0
    for arch, zip_path in iter_zip_paths(repo_root):
        scanned += 1
        try:
            changed = ensure_ruamel_init(zip_path)
            changed_openai = ensure_openai_lib_init(zip_path)
        except Exception as exc:  # noqa: BLE001
            print(f"[patch-runtime] {arch}: failed to patch {zip_path}: {exc}", file=sys.stderr)
            return 1
        if changed:
            touched += 1
            print(f"[patch-runtime] {arch}: added ruamel/__init__.py to {zip_path}")
        else:
            print(f"[patch-runtime] {arch}: ruamel/__init__.py already present in {zip_path}")
        if changed_openai:
            touched += 1
            print(f"[patch-runtime] {arch}: added openai/lib/__init__.py to {zip_path}")
        else:
            print(f"[patch-runtime] {arch}: openai/lib/__init__.py already present in {zip_path}")

    if scanned == 0:
        print("[patch-runtime] no site-packages.zip found; skipping")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
