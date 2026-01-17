"""
Client wrapper using the official OpenAI SDK (Async) for chat completions.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from dataclasses import dataclass
from typing import Any, AsyncIterator, Awaitable, Callable, Dict, List, Optional, Sequence

from openai import AsyncOpenAI

from ..pipeline.types import IntentCandidate, IntentResult

LOGGER = logging.getLogger(__name__)


@dataclass
class Stage1Payload:
    system_prompt: str
    user_prompt: str
    clipboard_image_url: Optional[str]
    context_screenshot_url: Optional[str]
    max_candidates: int = 4


@dataclass
class Stage2Payload:
    system_prompt: str
    user_prompt: str
    clipboard_image_url: Optional[str]
    candidate: IntentCandidate


class ModelClient:
    def __init__(
        self,
        *,
        model: str,
        api_key: str,
        base_url: str,
        timeout: float = 60.0,
    ) -> None:
        self.model = model
        self.api_key = api_key
        self.base_url = base_url
        self._client = AsyncOpenAI(api_key=api_key, base_url=base_url, timeout=timeout)
        self.last_stage1_raw: Optional[str] = None

    async def __aenter__(self) -> "ModelClient":
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        await self.close()

    async def close(self) -> None:
        # AsyncOpenAI uses underlying httpx client; explicit close for hygiene.
        await self._client.close()

    async def generate_intents(self, payload: Stage1Payload) -> List[IntentCandidate]:
        messages: List[Dict[str, Any]] = [
            {"role": "system", "content": payload.system_prompt},
            {
                "role": "user",
                "content": _build_stage1_user_content(
                    payload.user_prompt,
                    clipboard_image_url=payload.clipboard_image_url,
                    context_screenshot_url=payload.context_screenshot_url,
                ),
            },
        ]
        response_text = await self._chat(messages)
        self.last_stage1_raw = response_text
        LOGGER.debug("Stage1 raw response: %s", response_text)
        intents = self._parse_intents(response_text)
        return intents[: payload.max_candidates]

    async def generate_outputs(
        self,
        payload: Stage2Payload,
        *,
        concurrency_semaphore: Optional[asyncio.Semaphore] = None,
        chunk_callback: Optional[Callable[[str], Awaitable[None]]] = None,
    ) -> IntentResult:
        async def _run() -> IntentResult:
            messages = [
                {"role": "system", "content": payload.system_prompt},
                {
                    "role": "user",
                    "content": _build_stage2_user_content(
                        payload.user_prompt,
                        clipboard_image_url=payload.clipboard_image_url,
                    ),
                },
            ]
            try:
                response_text = await self._maybe_stream_chat(messages, chunk_callback)
                return IntentResult(
                    title=payload.candidate.title,
                    description=payload.candidate.description,
                    confidence=payload.candidate.confidence,
                    output=response_text.strip(),
                )
            except Exception as exc:
                LOGGER.error("Stage2 generation failed for %s: %s", payload.candidate.title, exc)
                return IntentResult(
                    title=payload.candidate.title,
                    description=payload.candidate.description,
                    confidence=payload.candidate.confidence,
                    output="",
                    error=str(exc),
                )

        if concurrency_semaphore is None:
            return await _run()
        async with concurrency_semaphore:
            return await _run()

    async def _chat(self, messages: Sequence[Dict[str, Any]], **extra: Any) -> str:
        summary = _summarize_messages(messages)
        LOGGER.info(
            "chat request: model=%s base_url=%s roles=%s text_chars=%s images=%s",
            self.model,
            self.base_url,
            summary.get("roles"),
            summary.get("text_chars"),
            summary.get("image_count"),
        )
        try:
            response = await self._client.chat.completions.create(
                model=self.model,
                messages=list(messages),
                **extra,
            )
        except Exception as exc:  # noqa: BLE001
            LOGGER.error("chat request failed: %s", exc)
            raise
        choices = response.choices
        if not choices:
            raise RuntimeError("Model returned no choices")
        message = choices[0].message
        content = message.content
        if isinstance(content, list):
            text = "".join(part.get("text", "") for part in content if getattr(part, "type", None) == "text")
        else:
            text = content or ""
        return text.strip()

    def _parse_intents(self, raw_text: str) -> List[IntentCandidate]:
        cleaned = self._extract_json(raw_text)
        if not cleaned:
            return []
        try:
            data = json.loads(cleaned)
        except json.JSONDecodeError:
            LOGGER.warning("Failed to parse stage1 output; returning empty list")
            return []
        intents: List[IntentCandidate] = []
        if isinstance(data, dict):
            data = [data]
        for item in data:
            if not isinstance(item, dict):
                continue
            title = str(item.get("title", "")).strip()
            description = str(item.get("description", "")).strip()
            confidence = str(item.get("confidence", "")).strip().lower()
            if confidence not in {"low", "medium", "high"}:
                confidence = "medium"
            if title:
                intents.append(IntentCandidate(title=title, description=description, confidence=confidence))
        return intents

    async def _maybe_stream_chat(
        self,
        messages: Sequence[Dict[str, Any]],
        chunk_callback: Optional[Callable[[str], Awaitable[None]]] = None,
    ) -> str:
        if not chunk_callback:
            return await self._chat(messages)

        try:
            chunks: List[str] = []
            async for delta in self._chat_stream(messages):
                if not delta:
                    continue
                chunks.append(delta)
                await chunk_callback(delta)
            if chunks:
                return "".join(chunks)
        except Exception as exc:  # noqa: BLE001
            LOGGER.debug("Streaming fallback to single response: %s", exc)

        response_text = await self._chat(messages)
        if response_text and chunk_callback:
            await chunk_callback(response_text)
        return response_text

    async def _chat_stream(self, messages: Sequence[Dict[str, Any]]) -> AsyncIterator[str]:
        summary = _summarize_messages(messages)
        LOGGER.info(
            "chat stream request: model=%s base_url=%s roles=%s text_chars=%s images=%s",
            self.model,
            self.base_url,
            summary.get("roles"),
            summary.get("text_chars"),
            summary.get("image_count"),
        )
        try:
            stream = await self._client.chat.completions.create(
                model=self.model,
                messages=list(messages),
                stream=True,
            )
        except Exception as exc:  # noqa: BLE001
            LOGGER.error("chat stream request failed: %s", exc)
            raise
        async for chunk in stream:
            text = self._extract_stream_text(chunk)
            if text:
                yield text

    def _extract_stream_text(self, chunk: Any) -> str:
        if not chunk or not getattr(chunk, "choices", None):
            return ""
        choice = chunk.choices[0]
        delta = getattr(choice, "delta", None)
        if delta and getattr(delta, "content", None):
            return self._normalize_content(delta.content)
        message = getattr(choice, "message", None)
        if message and getattr(message, "content", None):
            return self._normalize_content(message.content)
        return ""

    def _normalize_content(self, content: Any) -> str:
        if isinstance(content, list):
            parts: List[str] = []
            for part in content:
                if isinstance(part, dict):
                    parts.append(part.get("text", ""))
                else:
                    text = getattr(part, "text", None)
                    if text:
                        parts.append(text)
            return "".join(parts)
        if isinstance(content, str):
            return content
        if hasattr(content, "text"):
            return getattr(content, "text") or ""
        return ""

    @staticmethod
    def _extract_json(text: str) -> Optional[str]:
        if not text:
            return None
        stripped = text.strip()
        fence_match = re.match(r"```(?:json)?\s*(.*)```", stripped, re.DOTALL)
        if fence_match:
            return fence_match.group(1).strip()
        return stripped


def _build_stage1_user_content(
    user_prompt: str,
    *,
    clipboard_image_url: Optional[str],
    context_screenshot_url: Optional[str],
) -> List[Dict[str, Any]]:
    content: List[Dict[str, Any]] = [{"type": "text", "text": user_prompt}]
    if clipboard_image_url:
        content.append({"type": "text", "text": "[Clipboard Image]"})
        content.append({"type": "image_url", "image_url": {"url": clipboard_image_url}})
    if context_screenshot_url:
        content.append({"type": "text", "text": "[Environment Screenshot]"})
        content.append({"type": "image_url", "image_url": {"url": context_screenshot_url}})
    return content


def _build_stage2_user_content(
    user_prompt: str,
    *,
    clipboard_image_url: Optional[str],
) -> List[Dict[str, Any]]:
    content: List[Dict[str, Any]] = [{"type": "text", "text": user_prompt}]
    if clipboard_image_url:
        content.append({"type": "text", "text": "[Clipboard Image]"})
        content.append({"type": "image_url", "image_url": {"url": clipboard_image_url}})
    return content


def _summarize_messages(messages: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    roles: List[str] = []
    text_chars = 0
    image_count = 0
    for message in messages:
        if isinstance(message, dict):
            role = message.get("role")
            if role:
                roles.append(str(role))
            content = message.get("content")
        else:
            content = None
        if isinstance(content, str):
            text_chars += len(content)
        elif isinstance(content, list):
            for part in content:
                if not isinstance(part, dict):
                    continue
                if part.get("type") == "text":
                    text_chars += len(part.get("text") or "")
                elif part.get("type") == "image_url":
                    image_count += 1
    return {"roles": roles, "text_chars": text_chars, "image_count": image_count}
