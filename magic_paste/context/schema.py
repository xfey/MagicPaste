"""
Data models describing captured context.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


@dataclass
class WindowContext:
    title: Optional[str] = None
    app_name: Optional[str] = None
    bundle_id: Optional[str] = None


@dataclass
class ScreenshotContext:
    data_url: Optional[str] = None
    format: Optional[str] = None
    width: Optional[int] = None
    height: Optional[int] = None
    bytes: Optional[int] = None


@dataclass
class ContextSnapshot:
    window: Optional[WindowContext] = None
    screenshot: Optional[ScreenshotContext] = None
    warnings: List[str] = field(default_factory=list)

    @property
    def screenshot_url(self) -> Optional[str]:
        return self.screenshot.data_url if self.screenshot else None

    @classmethod
    def from_probe(cls, payload: Dict[str, Any]) -> "ContextSnapshot":
        window_payload = payload.get("window") or {}
        screenshot_payload = payload.get("screenshot") or {}
        warnings = payload.get("warnings") or []

        window = WindowContext(
            title=window_payload.get("title"),
            app_name=window_payload.get("appName") or window_payload.get("app_name"),
            bundle_id=window_payload.get("bundleId") or window_payload.get("bundle_id"),
        )

        data_url = None
        if screenshot_payload:
            data = screenshot_payload.get("data")
            fmt = screenshot_payload.get("format") or "jpeg"
            if data:
                data_url = f"data:image/{fmt};base64,{data}"

        screenshot = ScreenshotContext(
            data_url=data_url,
            format=screenshot_payload.get("format"),
            width=screenshot_payload.get("width"),
            height=screenshot_payload.get("height"),
            bytes=screenshot_payload.get("bytes"),
        )

        return cls(window=window, screenshot=screenshot, warnings=warnings)
