"""
Clipboard helpers built on top of pyperclip.
"""

from __future__ import annotations

from dataclasses import dataclass
import base64
import subprocess
import tempfile
from pathlib import Path
from typing import Optional

import pyperclip


@dataclass
class ClipboardData:
    text: Optional[str] = None
    image_data: Optional[bytes] = None
    image_mime: str = "image/png"
    original_has_image: bool = False

    @property
    def has_text(self) -> bool:
        return bool(self.text)

    @property
    def has_image(self) -> bool:
        return bool(self.image_data)

    @property
    def image_data_url(self) -> Optional[str]:
        if not self.image_data:
            return None
        encoded = base64.b64encode(self.image_data).decode("ascii")
        return f"data:{self.image_mime};base64,{encoded}"


class ClipboardReader:
    """Reads clipboard content. Supports plain text or PNG image payloads."""

    def read(self, *, text_only: bool = False) -> Optional[ClipboardData]:
        """
        When text_only is True, ignore image payloads and keep only text.
        If clipboard contains only image in text_only mode, return a placeholder
        ClipboardData with empty text to allow downstream fallback handling.
        """
        text = self._read_text()
        image = self._read_image()

        if text_only:
            if text:
                return ClipboardData(text=text, original_has_image=bool(image))
            if image:
                # image present but ignored; keep a marker for later messaging
                return ClipboardData(text="", original_has_image=True)
            return None

        if image:
            return ClipboardData(text=text, image_data=image, image_mime="image/png", original_has_image=True)
        return ClipboardData(text=text, original_has_image=False)

    def _read_text(self) -> Optional[str]:
        text = pyperclip.paste()
        if text is None:
            return None
        text = text.strip("\x00")
        return text or None

    def _read_image(self) -> Optional[bytes]:
        data = self._pbpaste("png")
        if not data or not data.startswith(b"\x89PNG\r\n\x1a\n"):
            data = self._read_image_via_applescript("PNGf")
        if not data:
            tiff_data = self._pbpaste("tiff")
            if not tiff_data:
                tiff_data = self._read_image_via_applescript("TIFF")
            if tiff_data:
                data = self._convert_tiff_to_png(tiff_data)
        if not data:
            return None
        if not data.startswith(b"\x89PNG\r\n\x1a\n"):
            return None
        if len(data) > 10 * 1024 * 1024:
            return None
        return data

    def _pbpaste(self, prefer: str) -> Optional[bytes]:
        try:
            result = subprocess.run(
                ["/usr/bin/pbpaste", "-Prefer", prefer],
                capture_output=True,
                check=True,
            )
        except (FileNotFoundError, subprocess.CalledProcessError):
            return None
        return result.stdout or None

    def _read_image_via_applescript(self, type_code: str) -> Optional[bytes]:
        script_template = f"""
on run argv
    set outPath to item 1 of argv
    try
        set dataBlob to the clipboard as «class {type_code}»
    on error
        return ""
    end try
    set outFile to open for access (POSIX file outPath) with write permission
    set eof outFile to 0
    write dataBlob to outFile
    close access outFile
    return outPath
end run
"""
        with tempfile.TemporaryDirectory() as tmpdir:
            script_path = Path(tmpdir) / "dump.scpt"
            out_path = Path(tmpdir) / "clip.bin"
            script_path.write_text(script_template, encoding="utf-8")
            try:
                result = subprocess.run(
                    ["/usr/bin/osascript", str(script_path), str(out_path)],
                    capture_output=True,
                    text=True,
                    check=True,
                )
            except (FileNotFoundError, subprocess.CalledProcessError):
                return None
            if result.stdout.strip() != str(out_path):
                return None
            if not out_path.exists():
                return None
            return out_path.read_bytes()

    def _convert_tiff_to_png(self, tiff_data: bytes) -> Optional[bytes]:
        with tempfile.TemporaryDirectory() as tmpdir:
            tiff_path = Path(tmpdir) / "clip.tiff"
            png_path = Path(tmpdir) / "clip.png"
            tiff_path.write_bytes(tiff_data)
            try:
                subprocess.run(
                    ["/usr/bin/sips", "-s", "format", "png", str(tiff_path), "--out", str(png_path)],
                    capture_output=True,
                    text=True,
                    check=True,
                )
            except subprocess.CalledProcessError:
                return None
            if not png_path.exists():
                return None
            return png_path.read_bytes()
