"""
CLI rendering helpers.
"""

from __future__ import annotations

from typing import Iterable

from rich.console import Console
from rich.panel import Panel
from rich.table import Table

from .types import IntentResult
from ..context.schema import ContextSnapshot

console = Console()


def render_context_snapshot(snapshot: ContextSnapshot) -> None:
    if not snapshot.window and not snapshot.screenshot:
        return
    table = Table(show_header=False, title="上下文")
    table.add_column("字段", style="cyan", no_wrap=True)
    table.add_column("内容", style="white")

    if snapshot.window:
        table.add_row("应用", snapshot.window.app_name or "未知")
        table.add_row("标题", snapshot.window.title or "未知")
    if snapshot.screenshot and snapshot.screenshot.width:
        table.add_row(
            "截图",
            f"{snapshot.screenshot.width}x{snapshot.screenshot.height} ({snapshot.screenshot.format or 'unknown'})",
        )
    if snapshot.warnings:
        table.add_row("警告", "; ".join(snapshot.warnings))
    console.print(table)


def render_results(results: Iterable[IntentResult]) -> None:
    for idx, result in enumerate(results, start=1):
        confidence = (result.confidence or "unknown").upper()
        header = f"{idx}. {result.title} [{confidence}]"
        description = result.description or ""
        body = result.output if result.output else result.error or "无内容"
        subtitle = description or None
        console.print(Panel(body, title=header, subtitle=subtitle, expand=False))
