"""
High-level orchestration for both CLI and GUI backends.
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import httpx

from ..i18n import t, normalize_locale
from ..clipboard.reader import ClipboardReader, ClipboardData
from ..context.detector import ContextDetector
from ..context.schema import ContextSnapshot
from ..history.logger import append_event
from ..pipeline.types import EventCallback, IntentCandidate, IntentResult, PipelineEvent
from ..prompts.loader import PromptLoader
from ..services.model_client import ModelClient, Stage1Payload, Stage2Payload
from ..utils.config_loader import Settings

LOGGER = logging.getLogger(__name__)
ROOT_DIR = Path(__file__).resolve().parents[1]
MANUAL_CANDIDATE_ID = "manual"


@dataclass
class PipelineResult:
    request_id: str
    clipboard: ClipboardData
    context: ContextSnapshot
    results: List[IntentResult]
    metrics: Optional["PipelineTimings"] = None


@dataclass
class CandidateEntry:
    candidate_id: str
    candidate: IntentCandidate


@dataclass
class Stage1DebugResult:
    clipboard: ClipboardData
    context: ContextSnapshot
    intents: List[IntentCandidate]
    elapsed: float
    metrics: "PipelineTimings"
    raw_response: Optional[str] = None
    clipboard_meta: Dict[str, object] = field(default_factory=dict)
    screenshot_meta: Dict[str, object] = field(default_factory=dict)


@dataclass
class PipelineTimings:
    clipboard: float = 0.0
    context: float = 0.0
    stage1: float = 0.0
    stage2_total: float = 0.0
    stage2_candidates: Dict[str, float] = field(default_factory=dict)


async def run_pipeline(settings: Settings) -> PipelineResult:
    executor = PipelineExecutor(settings=settings)
    return await executor.run()


async def run_stage1_debug(settings: Settings) -> Stage1DebugResult:
    timings = PipelineTimings()
    clipboard_meta: Dict[str, object] = {}
    reader = ClipboardReader()
    start = time.perf_counter()
    clipboard = reader.read(text_only=bool(settings.get("model", "text_only", default=False)))
    timings.clipboard = time.perf_counter() - start
    if not clipboard:
        raise RuntimeError(t("errors.clipboard_empty", settings.get("ui", "locale", default="en-US")))
    clipboard_meta = {
        "has_text": clipboard.has_text,
        "text_chars": len(clipboard.text or "") if clipboard.text else 0,
        "has_image": clipboard.has_image,
        "image_bytes": len(clipboard.image_data) if clipboard.image_data else 0,
    }

    context_detector = ContextDetector(settings)
    start = time.perf_counter()
    context_snapshot = context_detector.capture()
    timings.context = time.perf_counter() - start
    screenshot_meta = {
        "present": bool(context_snapshot.screenshot and context_snapshot.screenshot.data_url),
        "bytes": context_snapshot.screenshot.bytes if context_snapshot.screenshot else 0,
        "dimensions": (
            (context_snapshot.screenshot.width, context_snapshot.screenshot.height)
            if context_snapshot.screenshot and context_snapshot.screenshot.width and context_snapshot.screenshot.height
            else None
        ),
        "format": context_snapshot.screenshot.format if context_snapshot.screenshot else None,
    }

    executor = PipelineExecutor(settings=settings)
    prompt_loader = executor._prompt_loader()
    stage1_payload = executor._build_stage1_payload(prompt_loader, clipboard, context_snapshot)

    async with _build_model_client(settings) as client:
        start = time.perf_counter()
        intents = await client.generate_intents(stage1_payload)
        elapsed = time.perf_counter() - start
        timings.stage1 = elapsed
        raw_response = getattr(client, "last_stage1_raw", None)

    return Stage1DebugResult(
        clipboard=clipboard,
        context=context_snapshot,
        intents=intents,
        elapsed=elapsed,
        metrics=timings,
        raw_response=raw_response,
        clipboard_meta=clipboard_meta,
        screenshot_meta=screenshot_meta,
    )


class PipelineExecutor:
    """Runs the pipeline and optionally emits intermediate events."""

    def __init__(
        self,
        *,
        settings: Settings,
        event_callback: Optional[EventCallback] = None,
        request_id: Optional[str] = None,
    ) -> None:
        self.settings = settings
        self._event_callback = event_callback
        self.request_id = request_id or uuid.uuid4().hex
        self._manual_result: Optional[IntentResult] = None
        self._manual_payload: Optional[Dict[str, object]] = None
        self._timings = PipelineTimings()
        self.locale = normalize_locale(self.settings.get("ui", "locale", default="en-US"))
        self.text_only = bool(self.settings.get("model", "text_only", default=False))
        self.screenshot_enabled = bool(self.settings.get("context", "screenshot", "enabled", default=True))

    async def run(self) -> PipelineResult:
        try:
            return await self._run()
        except Exception as exc:  # noqa: BLE001
            await self._emit_error(str(exc))
            raise

    async def _run(self) -> PipelineResult:
        reader = ClipboardReader()
        start = time.perf_counter()
        clipboard = reader.read(text_only=self.text_only)
        self._timings.clipboard = time.perf_counter() - start
        if not clipboard:
            raise RuntimeError(t("errors.clipboard_empty", self.locale))

        LOGGER.info(
            "run started request_id=%s text_only=%s screenshot_enabled=%s has_text=%s has_image=%s",
            self.request_id,
            self.text_only,
            self.screenshot_enabled,
            clipboard.has_text,
            clipboard.has_image,
        )
        self._manual_result = self._build_manual_result(clipboard)
        self._manual_payload = self._candidate_payload(self._manual_result, candidate_id=MANUAL_CANDIDATE_ID, is_manual=True)

        await self._emit(
            "run_started",
            {
                "clipboard_type": "image" if clipboard.has_image else "text",
                "has_text": clipboard.has_text,
            },
        )

        context_detector = ContextDetector(self.settings)
        start = time.perf_counter()
        context_snapshot = context_detector.capture()
        self._timings.context = time.perf_counter() - start

        # Text-only模式且没有可用文本：跳过阶段1/2，直接回传原样输出
        if self.text_only and not clipboard.has_text:
            manual_payload = self._manual_payload or self._candidate_payload(
                self._manual_result, candidate_id=MANUAL_CANDIDATE_ID, is_manual=True
            )
            if manual_payload:
                await self._emit("candidates", {"items": [manual_payload]})
            _write_history(self.settings, clipboard, context_snapshot, [self._manual_result] if self._manual_result else [])
            await self._emit("run_completed", {"result_count": 1})
            return PipelineResult(
                request_id=self.request_id,
                clipboard=clipboard,
                context=context_snapshot,
                results=[self._manual_result] if self._manual_result else [],
                metrics=self._timings,
            )

        prompt_loader = self._prompt_loader()
        stage1_payload = self._build_stage1_payload(prompt_loader, clipboard, context_snapshot)

        async with _build_model_client(self.settings) as client:
            stage1_start = time.perf_counter()
            intents = await client.generate_intents(stage1_payload)
            self._timings.stage1 = time.perf_counter() - stage1_start
            candidate_entries = [
                CandidateEntry(candidate_id=uuid.uuid4().hex, candidate=candidate) for candidate in intents
            ]

            manual_payload = self._manual_payload or self._candidate_payload(
                self._manual_result, candidate_id=MANUAL_CANDIDATE_ID, is_manual=True
            )
            candidate_items = [self._candidate_payload(entry.candidate, entry.candidate_id) for entry in candidate_entries]
            if manual_payload:
                candidate_items.append(manual_payload)

            await self._emit("candidates", {"items": candidate_items})

            stage2_results = await self._run_stage2_generation(
                client=client,
                prompt_loader=prompt_loader,
                clipboard=clipboard,
                candidates=candidate_entries,
            )

        results = list(stage2_results)
        if self._manual_result:
            results.append(self._manual_result)

        _write_history(self.settings, clipboard, context_snapshot, results)
        await self._emit("run_completed", {"result_count": len(results)})
        return PipelineResult(
            request_id=self.request_id,
            clipboard=clipboard,
            context=context_snapshot,
            results=results,
            metrics=self._timings,
        )

    def _prompt_loader(self) -> PromptLoader:
        prompt_base = self.settings.prompt.get("base_dir") or "prompts"
        prompt_root = ROOT_DIR / prompt_base
        if not prompt_root.exists():
            LOGGER.warning("Prompt base dir missing: %s", prompt_root)
        return PromptLoader(base_dir=ROOT_DIR / prompt_base)

    def _build_stage1_payload(
        self,
        loader: PromptLoader,
        clipboard: ClipboardData,
        context_snapshot: ContextSnapshot,
    ) -> Stage1Payload:
        return Stage1Payload(
            system_prompt=loader.render("system/stage1.md", {"lang": self.locale}),
            user_prompt=loader.render(
                "templates/stage1_user.md",
                {
                    "clipboard_text": clipboard.text or "",
                    "clipboard_is_image": clipboard.has_image,
                    "app_name": context_snapshot.window.app_name if context_snapshot.window else "",
                    "window_title": context_snapshot.window.title if context_snapshot.window else "",
                    "screenshot_url": context_snapshot.screenshot_url if self.screenshot_enabled else None,
                    "lang": self.locale,
                },
            ),
            clipboard_image_url=None if self.text_only else clipboard.image_data_url,
            context_screenshot_url=context_snapshot.screenshot_url if self.screenshot_enabled else None,
            max_candidates=int(self.settings.stage1.get("max_candidates", 4)),
        )

    async def _run_stage2_generation(
        self,
        *,
        client: ModelClient,
        prompt_loader: PromptLoader,
        clipboard: ClipboardData,
        candidates: List[CandidateEntry],
    ) -> List[IntentResult]:
        if not candidates:
            return []

        LOGGER.info("stage2 generation start: candidates=%s", len(candidates))
        stage2_system = prompt_loader.render("system/stage2.md", {})
        concurrency = max(1, int(self.settings.stage1.get("max_candidates", 4)))
        semaphore = asyncio.Semaphore(concurrency)
        stage2_wall_start = time.perf_counter()

        tasks = [
            asyncio.create_task(
                self._generate_single_candidate(
                    client=client,
                    prompt_loader=prompt_loader,
                    clipboard=clipboard,
                    stage2_system=stage2_system,
                    entry=entry,
                    semaphore=semaphore,
                )
            )
            for entry in candidates
        ]

        results: Dict[str, IntentResult] = {}
        stage2_durations: Dict[str, float] = {}
        for candidate_id, result, duration in await asyncio.gather(*tasks):
            results[candidate_id] = result
            stage2_durations[candidate_id] = duration

        self._timings.stage2_candidates = stage2_durations
        self._timings.stage2_total = time.perf_counter() - stage2_wall_start
        return [results[entry.candidate_id] for entry in candidates if entry.candidate_id in results]

    async def _generate_single_candidate(
        self,
        *,
        client: ModelClient,
        prompt_loader: PromptLoader,
        clipboard: ClipboardData,
        stage2_system: str,
        entry: CandidateEntry,
        semaphore: asyncio.Semaphore,
    ) -> Tuple[str, IntentResult, float]:
        payload = Stage2Payload(
            system_prompt=stage2_system,
            user_prompt=prompt_loader.render(
                "templates/stage2_user.md",
                {
                    "clipboard_text": clipboard.text or "",
                    "clipboard_is_image": clipboard.has_image,
                    "intent_title": entry.candidate.title,
                    "intent_description": entry.candidate.description,
                    "lang": self.locale,
                },
            ),
            clipboard_image_url=None if self.text_only else clipboard.image_data_url,
            candidate=entry.candidate,
        )

        async def _on_chunk(delta: str) -> None:
            if not delta:
                return
            await self._emit(
                "preview_chunk",
                {
                    "candidate_id": entry.candidate_id,
                    "delta_text": delta,
                },
            )

        start = time.perf_counter()
        result = await client.generate_outputs(
            payload,
            concurrency_semaphore=semaphore,
            chunk_callback=_on_chunk,
        )
        duration = time.perf_counter() - start
        result.candidate_id = entry.candidate_id
        await self._emit(
            "preview_chunk",
            {
                "candidate_id": entry.candidate_id,
                "is_final": True,
                **({"error": result.error} if result.error else {}),
            },
        )
        return entry.candidate_id, result, duration

    def _build_manual_result(self, clipboard: ClipboardData) -> IntentResult:
        if clipboard.text:
            output = clipboard.text
        elif getattr(clipboard, "original_has_image", clipboard.has_image):
            output = t("manual.image_output", self.locale)
        else:
            output = ""
        return IntentResult(
            title=t("manual.title", self.locale),
            description=t("manual.desc", self.locale),
            confidence="manual",
            output=output,
            candidate_id=MANUAL_CANDIDATE_ID,
        )

    def _candidate_payload(
        self,
        candidate: IntentCandidate,
        candidate_id: str,
        is_manual: bool = False,
    ) -> Dict[str, object]:
        return {
            "id": candidate_id,
            "title": candidate.title,
            "description": candidate.description,
            "confidence": candidate.confidence,
            "is_manual": is_manual,
            **({"initial_output": getattr(candidate, "output", "")} if is_manual else {}),
        }

    async def _emit(self, event_type: str, payload: Dict[str, object]) -> None:
        if not self._event_callback:
            return
        event = PipelineEvent(request_id=self.request_id, type=event_type, payload=payload)
        try:
            await self._event_callback(event)
        except Exception as exc:  # noqa: BLE001
            LOGGER.warning("Event callback failed: %s", exc)

    async def _emit_error(self, message: str) -> None:
        payload: Dict[str, object] = {"message": message}
        if self._manual_payload:
            payload["fallback"] = self._manual_payload
        await self._emit("error", payload)


def _build_model_client(settings: Settings) -> ModelClient:
    model_cfg = settings.model
    model_name = model_cfg.get("name")
    locale = normalize_locale(settings.get("ui", "locale", default="en-US"))
    if not model_name:
        raise RuntimeError(t("errors.model_name_missing", locale))
    api_key = model_cfg.get("api_key")
    if not api_key:
        raise RuntimeError(t("errors.api_key_missing", locale))

    base_url = _resolve_endpoint(model_cfg, locale)
    timeout = float(model_cfg.get("timeout", 60))
    LOGGER.info("model client: name=%s base_url=%s timeout=%s", model_name, base_url, timeout)
    return ModelClient(model=model_name, api_key=api_key, base_url=base_url, timeout=timeout)


def _resolve_endpoint(model_cfg: Dict[str, Any], locale: str) -> str:
    """Resolve final chat completions endpoint from config (base_url only)."""

    base_url = model_cfg.get("base_url")
    if base_url:
        return _normalize_url(base_url, locale)

    raise RuntimeError(t("errors.endpoint_missing", locale))


def _normalize_url(raw_url: str, locale: str) -> str:
    """Trim, ensure scheme, validate, and echo a clearer error on bad URLs."""
    url = str(raw_url).strip()
    if not url:
        raise RuntimeError(t("errors.endpoint_missing", locale))
    if not url.startswith(("http://", "https://")):
        url = f"https://{url.lstrip('/')}"
    try:
        parsed = httpx.URL(url)
    except Exception:
        raise RuntimeError(t("errors.endpoint_invalid", locale, url=raw_url))
    return str(parsed)


def _write_history(
    settings: Settings,
    clipboard: ClipboardData,
    context: ContextSnapshot,
    results: List[IntentResult],
) -> None:
    history_path = settings.history.get("path") or "history/history.jsonl"
    clipboard_preview = clipboard.text[:500] if clipboard.text else "[image]"
    original_has_image = getattr(clipboard, "original_has_image", clipboard.has_image)
    payload = {
        "clipboard_type": "image" if original_has_image else "text",
        "clipboard_preview": clipboard_preview,
        "clipboard_has_image": original_has_image,
        "clipboard_has_text": clipboard.has_text,
        "window": {
            "title": context.window.title if context.window else None,
            "app": context.window.app_name if context.window else None,
        },
        "screenshot": {
            "present": bool(context.screenshot and context.screenshot.data_url),
            "bytes": context.screenshot.bytes if context.screenshot else None,
            "width": context.screenshot.width if context.screenshot else None,
            "height": context.screenshot.height if context.screenshot else None,
            "format": context.screenshot.format if context.screenshot else None,
        },
        "results": [
            {
                "title": item.title,
                "description": item.description,
                "confidence": item.confidence,
                "candidate_id": item.candidate_id,
                "output_preview": item.output[:400],
                "error": item.error,
            }
            for item in results
        ],
        "warnings": context.warnings,
    }
    append_event(history_path, payload)
