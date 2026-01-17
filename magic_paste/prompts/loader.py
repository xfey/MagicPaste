"""
Utility helpers for loading prompt files and rendering templates.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Any, Dict

from jinja2 import Environment, FileSystemLoader, StrictUndefined

BASE_DIR = Path(__file__).resolve().parent


class PromptLoader:
    """Loads prompt fragments from disk and renders them via Jinja2."""

    def __init__(self, base_dir: str | Path | None = None) -> None:
        prompt_dir = Path(base_dir) if base_dir else BASE_DIR
        self.base_dir = prompt_dir
        self.env = Environment(
            loader=FileSystemLoader(str(prompt_dir)),
            autoescape=False,
            undefined=StrictUndefined,
            trim_blocks=True,
            lstrip_blocks=True,
        )

    @lru_cache(maxsize=64)
    def raw(self, relative_path: str) -> str:
        path = self.base_dir / relative_path
        if not path.exists():
            raise FileNotFoundError(f"prompt file not found: {path}")
        return path.read_text(encoding="utf-8")

    def render(self, relative_path: str, context: Dict[str, Any]) -> str:
        template = self.env.get_template(relative_path)
        return template.render(**context)
