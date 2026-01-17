"""
Capture contextual information about the active window.
"""

from __future__ import annotations

import base64
import json
import logging
import plistlib
import subprocess
import tempfile
from functools import lru_cache
from pathlib import Path
from typing import Optional

from ..i18n import t, normalize_locale
from .schema import ContextSnapshot, WindowContext, ScreenshotContext
from ..utils.config_loader import Settings

LOGGER = logging.getLogger(__name__)
ROOT_DIR = Path(__file__).resolve().parents[2]

APPLE_SCRIPT = """
tell application "System Events"
    set frontProcesses to application processes whose frontmost is true
    if (count of frontProcesses) = 0 then return ""
    tell (first item of frontProcesses)
        set processName to name
        set windowTitle to ""
        set bundleId to ""
        try
            set windowTitle to name of window 1
        end try
        try
            set bundleId to bundle identifier
        end try
        return windowTitle & "||" & processName & "||" & bundleId
    end tell
end tell
"""


class ContextDetector:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.locale = normalize_locale(settings.get("ui", "locale", default="en-US"))
        context_cfg = settings.context
        self.use_native = bool(context_cfg.get("use_native_probe", True))
        screenshot_cfg = context_cfg.get("screenshot", {}) if isinstance(context_cfg, dict) else {}
        self.screenshot_enabled = bool(screenshot_cfg.get("enabled", True))
        probe_path = context_cfg.get("probe_path")
        if probe_path:
            candidate = Path(probe_path)
            if not candidate.is_absolute():
                candidate = ROOT_DIR / candidate
            self.probe_path = candidate
        else:
            self.probe_path = None

    def capture(self) -> ContextSnapshot:
        snapshot = None
        LOGGER.info("ContextDetector capture: use_native=%s screenshot_enabled=%s", self.use_native, self.screenshot_enabled)
        if self.use_native:
            snapshot = self._via_native_probe()
        if snapshot:
            if not self.screenshot_enabled:
                snapshot.screenshot = None
            return snapshot
        LOGGER.debug("Falling back to AppleScript context capture")
        return self._fallback_snapshot()

    def _via_native_probe(self) -> Optional[ContextSnapshot]:
        if not self.probe_path or not self.probe_path.exists():
            LOGGER.warning("Native ContextProbe missing at %s", self.probe_path)
            return None

        try:
            result = subprocess.run(
                [str(self.probe_path)],
                capture_output=True,
                text=True,
                check=True,
            )
        except (FileNotFoundError, subprocess.CalledProcessError) as exc:
            LOGGER.warning("ContextProbe execution failed: %s", exc)
            return None

        try:
            payload = json.loads(result.stdout)
        except json.JSONDecodeError as exc:
            LOGGER.warning("ContextProbe returned invalid JSON: %s", exc)
            return None

        return ContextSnapshot.from_probe(payload)

    def _fallback_snapshot(self) -> ContextSnapshot:
        try:
            result = subprocess.run(
                ["/usr/bin/osascript", "-e", APPLE_SCRIPT],
                capture_output=True,
                text=True,
                check=True,
            )
            raw = result.stdout.strip()
        except (subprocess.CalledProcessError, FileNotFoundError) as exc:
            LOGGER.warning("AppleScript fallback failed: %s", exc)
            raw = ""

        title = ""
        app_name = ""
        bundle_id = None
        if raw and "||" in raw:
            parts = raw.split("||", 2)
            title = parts[0].strip()
            app_name = parts[1].strip() if len(parts) > 1 else ""
            bundle_id = parts[2].strip() if len(parts) > 2 else None

        resolved_app_name = _resolve_app_name(bundle_id, app_name)
        window = WindowContext(
            title=title or None,
            app_name=resolved_app_name or app_name or None,
            bundle_id=bundle_id or None,
        )
        warnings = []
        if not raw:
            warnings.append(t("warnings.window_unavailable", self.locale))

        screenshot = _capture_screenshot() if self.screenshot_enabled else None
        if self.screenshot_enabled and screenshot is None:
            warnings.append(t("warnings.screenshot_failed", self.locale))

        return ContextSnapshot(window=window, screenshot=screenshot, warnings=warnings)


@lru_cache(maxsize=64)
def _resolve_app_name(bundle_id: Optional[str], fallback_name: str) -> Optional[str]:
    if not bundle_id:
        return None
    spotlight_query = f'kMDItemCFBundleIdentifier == "{bundle_id}"'
    try:
        result = subprocess.run(
            ["/usr/bin/mdfind", spotlight_query],
            capture_output=True,
            text=True,
            check=True,
        )
    except subprocess.CalledProcessError:
        return None
    path = result.stdout.strip().splitlines()[0] if result.stdout else ""
    if not path:
        return None
    info_plist = Path(path) / "Contents" / "Info.plist"
    if not info_plist.exists():
        return None
    try:
        with info_plist.open("rb") as handle:
            info = plistlib.load(handle)
    except Exception:
        return None
    return info.get("CFBundleDisplayName") or info.get("CFBundleName") or fallback_name or None


def _capture_screenshot() -> Optional[ScreenshotContext]:
    tmp_path: Optional[Path] = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as tmp:
            tmp_path = Path(tmp.name)
        subprocess.run(
            ["/usr/sbin/screencapture", "-x", "-t", "jpg", str(tmp_path)],
            check=True,
        )
        try:
            subprocess.run(
                [
                    "/usr/bin/sips",
                    "-Z",
                    "1024",
                    "-s",
                    "formatOptions",
                    "35",
                    str(tmp_path),
                ],
                capture_output=True,
                text=True,
                check=True,
            )
        except subprocess.CalledProcessError:
            pass
        data = tmp_path.read_bytes()
        width = height = None
        try:
            meta = subprocess.run(
                ["/usr/bin/sips", "-g", "pixelWidth", "-g", "pixelHeight", str(tmp_path)],
                capture_output=True,
                text=True,
                check=True,
            )
            for line in meta.stdout.splitlines():
                if "pixelWidth" in line:
                    width = int(line.split(":")[-1].strip())
                elif "pixelHeight" in line:
                    height = int(line.split(":")[-1].strip())
        except subprocess.CalledProcessError:
            pass

        encoded = base64.b64encode(data).decode("ascii")
        return ScreenshotContext(
            data_url=f"data:image/jpeg;base64,{encoded}",
            format="jpeg",
            width=width,
            height=height,
            bytes=len(data),
        )
    except Exception as exc:  # noqa: BLE001
        LOGGER.warning("Fallback screenshot capture failed: %s", exc)
        return None
    finally:
        if tmp_path and tmp_path.exists():
            tmp_path.unlink(missing_ok=True)
