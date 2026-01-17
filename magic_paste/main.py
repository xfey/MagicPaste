"""
Typer CLI entrypoint for Magic Paste demo.
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path

import typer
from rich.console import Console

from .context.detector import ContextDetector
from .pipeline.orchestrator import PipelineTimings, run_pipeline, run_stage1_debug
from .pipeline.renderer import render_context_snapshot, render_results
from .utils.config_loader import load_settings, Settings

console = Console()
app = typer.Typer(add_completion=False)


def _setup_logging(verbose: bool) -> None:
    level = logging.DEBUG if verbose else logging.INFO
    logging.basicConfig(level=level, format="[%(levelname)s] %(message)s")


@app.command(help="执行 Magic Paste pipeline，输出候选结果。")
def run(
    settings_path: Path = typer.Option(None, "--settings", "-s", help="自定义配置文件路径"),
    verbose: bool = typer.Option(False, "--verbose", "-v", help="输出调试日志"),
) -> None:
    _setup_logging(verbose)
    settings = load_settings(settings_path)
    try:
        result = asyncio.run(run_pipeline(settings))
    except Exception as exc:  # noqa: BLE001
        console.print(f"[red]运行失败：{exc}[/red]")
        raise typer.Exit(code=1) from exc

    render_context_snapshot(result.context)
    render_results(result.results)


@app.command(help="仅显示上下文探测结果。")
def context(
    settings_path: Path = typer.Option(None, "--settings", "-s", help="自定义配置文件路径"),
    verbose: bool = typer.Option(False, "--verbose", "-v", help="输出调试日志"),
) -> None:
    _setup_logging(verbose)
    settings = load_settings(settings_path)
    detector = ContextDetector(settings)
    snapshot = detector.capture()
    render_context_snapshot(snapshot)


@app.command(help="启动 FastAPI 守护进程，供 GUI 连接。")
def daemon(
    host: str = typer.Option("127.0.0.1", "--host", help="监听地址"),
    port: int = typer.Option(8123, "--port", help="监听端口"),
    settings_path: Path = typer.Option(None, "--settings", "-s", help="自定义配置文件路径"),
    verbose: bool = typer.Option(False, "--verbose", "-v", help="输出调试日志"),
) -> None:
    _setup_logging(verbose)
    from .server import run_server

    try:
        run_server(host=host, port=port, settings_path=settings_path)
    except KeyboardInterrupt as exc:
        raise typer.Exit(code=0) from exc


@app.command(help="调试阶段一生成，仅输出候选与耗时。")
def debug_stage1(
    settings_path: Path = typer.Option(None, "--settings", "-s", help="自定义配置文件路径"),
    verbose: bool = typer.Option(False, "--verbose", "-v", help="输出调试日志"),
) -> None:
    _setup_logging(verbose)
    settings = load_settings(settings_path)
    try:
        result = asyncio.run(run_stage1_debug(settings))
    except Exception as exc:  # noqa: BLE001
        console.print(f"[red]阶段一执行失败：{exc}[/red]")
        raise typer.Exit(code=1) from exc

    console.print(f"[bold]阶段一耗时[/bold]：{result.elapsed:.2f}s，候选 {len(result.intents)} 项")
    _print_timings(result.metrics)
    _print_media_info(result.clipboard_meta, result.screenshot_meta)
    for idx, item in enumerate(result.intents, start=1):
        console.print(f"{idx}. [cyan]{item.title}[/cyan] — {item.description} (confidence={item.confidence})")
    if result.raw_response:
        console.print("\n[bold]原始响应[/bold]:")
        console.print(result.raw_response)


@app.command(help="执行完整 Pipeline 并打印阶段耗时统计。")
def debug_timings(
    settings_path: Path = typer.Option(None, "--settings", "-s", help="自定义配置文件路径"),
    verbose: bool = typer.Option(False, "--verbose", "-v", help="输出调试日志"),
) -> None:
    _setup_logging(verbose)
    settings = load_settings(settings_path)
    try:
        result = asyncio.run(run_pipeline(settings))
    except Exception as exc:  # noqa: BLE001
        console.print(f"[red]Pipeline 运行失败：{exc}[/red]")
        raise typer.Exit(code=1) from exc

    if not result.metrics:
        console.print("未收集到耗时数据。")
        raise typer.Exit(code=0)

    _print_timings(result.metrics)


def _print_timings(metrics: PipelineTimings | None) -> None:
    if not metrics:
        return
    console.print("[bold]阶段耗时统计[/bold]：")
    console.print(f"- 读取剪贴板：{metrics.clipboard:.2f}s")
    console.print(f"- 捕获上下文：{metrics.context:.2f}s")
    console.print(f"- 阶段一推理：{metrics.stage1:.2f}s")
    if metrics.stage2_candidates:
        console.print(f"- 阶段二总耗时：{metrics.stage2_total:.2f}s")
        for cid, duration in metrics.stage2_candidates.items():
            console.print(f"    · 候选 {cid[:6]}…：{duration:.2f}s")


def _print_media_info(clipboard_meta: dict | None, screenshot_meta: dict | None) -> None:
    if clipboard_meta:
        console.print(
            "\n[bold]剪贴板[/bold]：文本字符 {text_chars}、图像 {has_image}（{image_bytes} bytes）".format(**clipboard_meta)
        )
    if screenshot_meta:
        console.print(
            "[bold]截图[/bold]：存在 {present}、大小 {bytes} bytes、分辨率 {dimensions}、格式 {format}".format(
                **{k: (v if v is not None else "N/A") for k, v in screenshot_meta.items()}
            )
        )


def main() -> None:
    app()


if __name__ == "__main__":
    main()
