"""
FastAPI app providing WebSocket + REST endpoints for the GUI client.
"""

from __future__ import annotations

import asyncio
import copy
import logging
from pathlib import Path
import subprocess
from typing import Any, Dict, Optional

import pyperclip
import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field
from ruamel.yaml import YAML
from starlette.websockets import WebSocketState

from ..i18n import t, normalize_locale
from ..pipeline.orchestrator import MANUAL_CANDIDATE_ID, PipelineExecutor, PipelineResult
from ..pipeline.types import EventCallback, PipelineEvent
from ..utils.config_loader import DEFAULT_SETTINGS_PATH, Settings, load_settings

LOGGER = logging.getLogger(__name__)
_YAML = YAML()
_YAML.indent(mapping=2, sequence=4, offset=2)


class SettingsUpdate(BaseModel):
    updates: Dict[str, Any] = Field(default_factory=dict)


def _current_locale(settings_manager: "SettingsManager") -> str:
    return normalize_locale(settings_manager.settings.get("ui", "locale", default="en-US"))

def _flatten_update_keys(updates: Dict[str, Any], prefix: str = "") -> list[str]:
    keys: list[str] = []
    for key, value in updates.items():
        path = f"{prefix}.{key}" if prefix else str(key)
        if isinstance(value, dict):
            keys.extend(_flatten_update_keys(value, path))
        else:
            keys.append(path)
    return keys


def _settings_summary(settings: Settings) -> Dict[str, Any]:
    model_cfg = settings.model
    return {
        "model": {
            "name": model_cfg.get("name"),
            "base_url": model_cfg.get("base_url"),
            "enable_image": model_cfg.get("enable_image"),
            "text_only": model_cfg.get("text_only"),
            "timeout": model_cfg.get("timeout"),
        },
        "context": {
            "use_native_probe": settings.get("context", "use_native_probe", default=True),
            "screenshot_enabled": settings.get("context", "screenshot", "enabled", default=True),
        },
        "prompt": {"base_dir": settings.prompt.get("base_dir")},
        "history": {"path": settings.history.get("path")},
        "ui": {"locale": settings.get("ui", "locale", default="en-US")},
    }


def create_app(settings_path: Optional[Path | str] = None) -> FastAPI:
    """Create FastAPI application with shared state."""

    app = FastAPI(title="Magic Paste Daemon", version="0.1.0")
    settings_manager = SettingsManager(settings_path)
    coordinator = PipelineCoordinator(settings_manager)

    app.state.settings_manager = settings_manager
    app.state.pipeline_coordinator = coordinator

    @app.get("/healthz")
    async def healthz() -> Dict[str, str]:
        return {"status": "ok"}

    @app.get("/settings")
    async def get_settings() -> Dict[str, Any]:
        return {"settings": settings_manager.copy_raw()}

    @app.post("/settings")
    async def update_settings(payload: SettingsUpdate) -> Dict[str, Any]:
        if not payload.updates:
            return {"settings": settings_manager.copy_raw()}
        settings = await settings_manager.apply_updates(payload.updates)
        return {"settings": settings.raw}

    @app.websocket("/ws")
    async def websocket_endpoint(websocket: WebSocket) -> None:  # pragma: no cover - exercised via GUI
        await websocket.accept()
        LOGGER.info("WebSocket connected")
        connection = WebSocketConnection(websocket)
        await connection.send_json({"type": "ready", "payload": {"settings": settings_manager.copy_raw()}})

        try:
            while True:
                message = await websocket.receive_json()
                LOGGER.info("WebSocket message: %s", message.get("type"))
                await _handle_ws_message(
                    message=message,
                    connection=connection,
                    coordinator=coordinator,
                    settings_manager=settings_manager,
                )
        except WebSocketDisconnect:
            LOGGER.info("WebSocket disconnected")
            await coordinator.cancel_all()
        finally:
            await connection.close()

    return app


def run_server(
    *,
    host: str = "127.0.0.1",
    port: int = 8123,
    settings_path: Optional[Path | str] = None,
) -> None:
    """Blocking helper that starts the FastAPI daemon."""

    LOGGER.info("Magic Paste daemon starting on %s:%s", host, port)
    app = create_app(settings_path)
    config = uvicorn.Config(app=app, host=host, port=port, log_level="info")
    server = uvicorn.Server(config)
    server.run()


async def _handle_ws_message(
    *,
    message: Dict[str, Any],
    connection: "WebSocketConnection",
    coordinator: "PipelineCoordinator",
    settings_manager: "SettingsManager",
) -> None:
    msg_type = message.get("type")
    payload = message.get("payload") or {}

    if msg_type == "trigger_run":
        await _handle_trigger_run(payload, connection, coordinator, settings_manager)
    elif msg_type == "confirm_candidate":
        await _handle_confirm(payload, connection, coordinator)
    elif msg_type == "cancel_run":
        await _handle_cancel(payload, connection, coordinator)
    elif msg_type == "update_settings":
        await _handle_settings_update(payload, connection, settings_manager)
    elif msg_type == "get_settings":
        await connection.send_json({"type": "settings", "payload": {"settings": settings_manager.copy_raw()}})
    else:
        LOGGER.warning("Unknown ws message type: %s", msg_type)
        locale = _current_locale(settings_manager)
        await connection.send_error(t("errors.ws_unknown_type", locale, msg_type=msg_type))


async def _handle_trigger_run(
    payload: Dict[str, Any],
    connection: "WebSocketConnection",
    coordinator: "PipelineCoordinator",
    settings_manager: "SettingsManager",
) -> None:
    request_id = payload.get("request_id")
    LOGGER.info("trigger_run received request_id=%s", request_id)
    LOGGER.info("settings summary: %s", _settings_summary(settings_manager.settings))

    async def _event_callback(event: PipelineEvent) -> None:
        await coordinator.handle_event(event)
        await connection.send_event(event)

    settings_manager.reload_if_needed()
    run_id = await coordinator.start_run(event_callback=_event_callback, request_id=request_id)
    await connection.send_json({"type": "run_accepted", "request_id": run_id})


async def _handle_confirm(
    payload: Dict[str, Any],
    connection: "WebSocketConnection",
    coordinator: "PipelineCoordinator",
) -> None:
    request_id = payload.get("request_id")
    candidate_id = payload.get("candidate_id")
    if not request_id or not candidate_id:
        locale = _current_locale(coordinator.settings_manager)
        await connection.send_error(t("errors.ws_confirm_missing", locale))
        return

    output = coordinator.get_candidate_output(request_id, candidate_id)
    result = coordinator.get_result(request_id)
    original_clipboard_has_image = bool(
        result and result.clipboard and getattr(result.clipboard, "original_has_image", result.clipboard.has_image)
    )
    skip_copy = candidate_id == MANUAL_CANDIDATE_ID and original_clipboard_has_image
    if output is None:
        locale = _current_locale(coordinator.settings_manager)
        await connection.send_error(t("errors.ws_output_not_ready", locale), request_id=request_id)
        return

    try:
        if not skip_copy:
            pyperclip.copy(output)
    except pyperclip.PyperclipException as exc:  # type: ignore[attr-defined]
        locale = _current_locale(coordinator.settings_manager)
        await connection.send_error(t("errors.ws_copy_failed", locale, reason=str(exc)), request_id=request_id)
        return
    auto_paste = _simulate_paste()

    await connection.send_json(
        {
            "type": "paste_ready",
            "request_id": request_id,
            "payload": {
                "candidate_id": candidate_id,
                "length": len(output),
                "auto_paste": auto_paste,
            },
        }
    )


async def _handle_cancel(
    payload: Dict[str, Any],
    connection: "WebSocketConnection",
    coordinator: "PipelineCoordinator",
) -> None:
    request_id = payload.get("request_id")
    if not request_id:
        locale = _current_locale(coordinator.settings_manager)
        await connection.send_error(t("errors.ws_cancel_missing", locale))
        return
    cancelled = await coordinator.cancel_run(request_id)
    await connection.send_json({"type": "run_cancelled", "request_id": request_id, "payload": {"cancelled": cancelled}})


async def _handle_settings_update(
    payload: Dict[str, Any],
    connection: "WebSocketConnection",
    settings_manager: "SettingsManager",
) -> None:
    updates = payload.get("updates")
    if not isinstance(updates, dict):
        locale = _current_locale(settings_manager)
        await connection.send_error(t("errors.settings_bad_format", locale))
        return
    update_keys = _flatten_update_keys(updates)
    has_api_key = any(key == "model.api_key" for key in update_keys)
    LOGGER.info("settings update keys: %s", update_keys)
    if has_api_key:
        LOGGER.info("settings update includes model.api_key (redacted)")
    settings = await settings_manager.apply_updates(updates)
    await connection.send_json({"type": "settings_updated", "payload": {"settings": settings.raw}})


class SettingsManager:
    """Load and persist settings.yaml with async locking."""

    def __init__(self, settings_path: Optional[Path | str] = None) -> None:
        path = Path(settings_path) if settings_path else DEFAULT_SETTINGS_PATH
        self.path = path
        LOGGER.info("Settings path: %s (exists=%s)", self.path, self.path.exists())
        self._lock = asyncio.Lock()
        self._settings = load_settings(self.path)
        self._raw_cache: Dict[str, Any] = self._read_raw()

    @property
    def settings(self) -> Settings:
        return self._settings

    def reload_if_needed(self) -> None:
        """Allow callers to re-read the config file to reflect manual edits."""
        LOGGER.info("Reloading settings from %s", self.path)
        self._settings = load_settings(self.path)
        self._raw_cache = self._read_raw()

    async def apply_updates(self, updates: Dict[str, Any]) -> Settings:
        async with self._lock:
            raw = self._read_raw()
            _deep_merge(raw, updates)
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with self.path.open("w", encoding="utf-8") as handle:
                _YAML.dump(raw, handle)
            self._raw_cache = raw
            self._settings = load_settings(self.path)
            return self._settings

    def copy_raw(self) -> Dict[str, Any]:
        return copy.deepcopy(self._raw_cache)

    def _read_raw(self) -> Dict[str, Any]:
        if not self.path.exists():
            return {}
        data = _YAML.load(self.path.read_text(encoding="utf-8")) or {}
        return data


class PipelineCoordinator:
    """Manages background pipeline executions and preview buffers."""

    def __init__(self, settings_manager: SettingsManager) -> None:
        self.settings_manager = settings_manager
        self._tasks: Dict[str, asyncio.Task[PipelineResult]] = {}
        self._results: Dict[str, PipelineResult] = {}
        self._partial_outputs: Dict[str, Dict[str, str]] = {}
        self._manual_outputs: Dict[str, str] = {}

    async def start_run(self, *, event_callback: EventCallback, request_id: Optional[str] = None) -> str:
        executor = PipelineExecutor(settings=self.settings_manager.settings, event_callback=event_callback, request_id=request_id)
        task = asyncio.create_task(executor.run())
        self._tasks[executor.request_id] = task

        def _done_callback(fut: asyncio.Task[PipelineResult]) -> None:
            self._tasks.pop(executor.request_id, None)
            self._partial_outputs.pop(executor.request_id, None)
            self._manual_outputs.pop(executor.request_id, None)
            try:
                result = fut.result()
            except Exception as exc:  # noqa: BLE001
                LOGGER.error("Pipeline run %s failed: %s", executor.request_id, exc)
            else:
                self._results[executor.request_id] = result

        task.add_done_callback(_done_callback)
        return executor.request_id

    async def cancel_run(self, request_id: str) -> bool:
        task = self._tasks.pop(request_id, None)
        if task:
            task.cancel()
        self._partial_outputs.pop(request_id, None)
        self._manual_outputs.pop(request_id, None)
        return task is not None

    async def cancel_all(self) -> None:
        for request_id in list(self._tasks.keys()):
            await self.cancel_run(request_id)

    async def handle_event(self, event: PipelineEvent) -> None:
        if event.type == "preview_chunk":
            payload = event.payload
            candidate_id = payload.get("candidate_id")
            if not candidate_id:
                return
            delta = payload.get("delta_text")
            if delta:
                buffer = self._partial_outputs.setdefault(event.request_id, {}).get(candidate_id, "")
                buffer += delta
                self._partial_outputs[event.request_id][candidate_id] = buffer
            elif payload.get("is_final"):
                self._partial_outputs.setdefault(event.request_id, {}).setdefault(candidate_id, "")
            if payload.get("error"):
                self._partial_outputs.setdefault(event.request_id, {})[candidate_id] = ""
        elif event.type == "candidates":
            items = event.payload.get("items", [])
            for item in items:
                if item.get("is_manual"):
                    output_text = item.get("initial_output") or ""
                    self._manual_outputs[event.request_id] = output_text

    def get_result(self, request_id: str) -> Optional[PipelineResult]:
        return self._results.get(request_id)

    def get_candidate_output(self, request_id: str, candidate_id: str) -> Optional[str]:
        result = self._results.get(request_id)
        if result:
            for item in result.results:
                if item.candidate_id == candidate_id:
                    return item.output
        if candidate_id == MANUAL_CANDIDATE_ID:
            manual = self._manual_outputs.get(request_id)
            if manual:
                return manual
        return self._partial_outputs.get(request_id, {}).get(candidate_id)


class WebSocketConnection:
    """Serialize writes to a WebSocket and provide helper send methods."""

    def __init__(self, websocket: WebSocket) -> None:
        self.websocket = websocket
        self._send_lock = asyncio.Lock()

    async def send_event(self, event: PipelineEvent) -> None:
        await self.send_json({"type": event.type, "request_id": event.request_id, "payload": event.payload})

    async def send_error(self, message: str, request_id: Optional[str] = None) -> None:
        payload: Dict[str, Any] = {"message": message}
        if request_id:
            payload["request_id"] = request_id
        await self.send_json({"type": "error", "payload": payload})

    async def send_json(self, payload: Dict[str, Any]) -> None:
        if self.websocket.application_state == WebSocketState.DISCONNECTED:
            return
        async with self._send_lock:
            await self.websocket.send_json(payload)

    async def close(self) -> None:
        if self.websocket.application_state != WebSocketState.DISCONNECTED:
            await self.websocket.close()


def _deep_merge(original: Dict[str, Any], updates: Dict[str, Any]) -> Dict[str, Any]:
    for key, value in updates.items():
        if isinstance(value, dict) and isinstance(original.get(key), dict):
            _deep_merge(original[key], value)
        else:
            original[key] = value
    return original


def _simulate_paste() -> bool:
    script = 'tell application "System Events" to keystroke "v" using {command down}'
    try:
        subprocess.run(
            ["/usr/bin/osascript", "-e", script],
            check=True,
            capture_output=True,
            text=True,
        )
        return True
    except (FileNotFoundError, subprocess.CalledProcessError) as exc:
        LOGGER.warning("自动粘贴失败：%s", exc)
        return False
