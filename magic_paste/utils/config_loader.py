"""
Utilities for loading YAML configuration with environment overrides.
"""

from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path
import re
import sys
from typing import Any, Dict, MutableMapping

from ruamel.yaml import YAML

_YAML = YAML(typ="safe")
_ENV_PATTERN = re.compile(r"\$\{([^}:]+)(?::([^}]+))?\}")

BASE_DIR = Path(__file__).resolve().parents[1]
PACKAGE_SETTINGS_PATH = BASE_DIR / "config" / "settings.yaml"


def _user_settings_path() -> Path:
    env_override = os.environ.get("MAGIC_PASTE_SETTINGS_PATH")
    if env_override:
        return Path(env_override).expanduser()
    home = Path.home()
    if sys.platform == "darwin":
        base = home / "Library" / "Application Support" / "MagicPaste"
    elif sys.platform.startswith("win"):
        appdata = os.environ.get("APPDATA")
        base = Path(appdata) if appdata else (home / "AppData" / "Roaming")
        base = base / "MagicPaste"
    else:
        xdg = os.environ.get("XDG_CONFIG_HOME")
        base = Path(xdg) if xdg else (home / ".config")
        base = base / "magic_paste"
    return base / "settings.yaml"


DEFAULT_SETTINGS_PATH = _user_settings_path()


def _substitute_env(value: str) -> str:
    def replacer(match: re.Match[str]) -> str:
        key = match.group(1)
        default = match.group(2)
        return os.environ.get(key, default or "")

    return _ENV_PATTERN.sub(replacer, value)


def _resolve(obj: Any) -> Any:
    if isinstance(obj, str):
        return _substitute_env(obj)
    if isinstance(obj, list):
        return [_resolve(item) for item in obj]
    if isinstance(obj, MutableMapping):
        return {key: _resolve(value) for key, value in obj.items()}
    return obj


@dataclass
class Settings:
    """Container for strongly typed access helpers."""

    raw: Dict[str, Any]

    @property
    def model(self) -> Dict[str, Any]:
        return self.raw.get("model", {})

    @property
    def prompt(self) -> Dict[str, Any]:
        return self.raw.get("prompt", {})

    @property
    def stage1(self) -> Dict[str, Any]:
        return self.raw.get("stage1", {})

    @property
    def context(self) -> Dict[str, Any]:
        return self.raw.get("context", {})

    @property
    def history(self) -> Dict[str, Any]:
        return self.raw.get("history", {})

    @property
    def ui(self) -> Dict[str, Any]:
        return self.raw.get("ui", {})

    def get(self, *keys: str, default: Any = None) -> Any:
        cursor: Any = self.raw
        for key in keys:
            if not isinstance(cursor, MutableMapping):
                return default
            cursor = cursor.get(key)
            if cursor is None:
                return default
        return cursor


def load_settings(path: str | Path | None = None) -> Settings:
    """Load YAML settings and resolve environment placeholders."""

    settings_path = Path(path) if path else DEFAULT_SETTINGS_PATH
    if not settings_path.exists():
        if PACKAGE_SETTINGS_PATH.exists():
            settings_path.parent.mkdir(parents=True, exist_ok=True)
            settings_path.write_text(PACKAGE_SETTINGS_PATH.read_text(encoding="utf-8"), encoding="utf-8")
        if not settings_path.exists():
            raise FileNotFoundError(f"Settings file not found: {settings_path}")

    data = _YAML.load(settings_path.read_text(encoding="utf-8")) or {}
    resolved = _resolve(data)
    return Settings(raw=resolved)
