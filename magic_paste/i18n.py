"""
Lightweight i18n helper for backend components.
"""

from __future__ import annotations

from typing import Dict

DEFAULT_LOCALE = "en-US"

_TRANSLATIONS: Dict[str, Dict[str, str]] = {
    "en-US": {
        "manual.title": "Paste as-is",
        "manual.desc": "Keep the original clipboard content without changes.",
        "manual.image_output": "[Clipboard image preserved as-is]",
        "errors.clipboard_empty": "No available text or image content in clipboard.",
        "errors.model_name_missing": "Please configure model.name in config/settings.yaml",
        "errors.api_key_missing": "Model API key is missing. Set model.api_key in config/settings.yaml",
        "errors.endpoint_missing": "Model endpoint is not configured. Set model.base_url in config/settings.yaml",
        "errors.endpoint_invalid": "Model endpoint is invalid: {url}",
        "errors.ws_unknown_type": "Unknown message type: {msg_type}",
        "errors.ws_confirm_missing": "confirm_candidate requires request_id and candidate_id",
        "errors.ws_output_not_ready": "Candidate output is not ready yet",
        "errors.ws_copy_failed": "Copy to clipboard failed: {reason}",
        "errors.ws_cancel_missing": "cancel_run requires request_id",
        "errors.settings_bad_format": "settings updates payload is invalid",
        "warnings.window_unavailable": "Unable to get window info; using empty context.",
        "warnings.screenshot_failed": "Unable to capture desktop screenshot.",
        "notices.text_only_image_ignored": "Image input ignored in text-only mode; only raw paste is available.",
    },
    "zh-CN": {
        "manual.title": "原样输出",
        "manual.desc": "保持原文粘贴，不做处理。",
        "manual.image_output": "[剪贴板为图像，原样粘贴保留图像内容]",
        "errors.clipboard_empty": "剪贴板没有可用的文本或图像内容。",
        "errors.model_name_missing": "请在 config/settings.yaml 中配置 model.name",
        "errors.api_key_missing": "未配置模型 API Key，请在 config/settings.yaml 的 model.api_key 中填写",
        "errors.endpoint_missing": "未配置模型请求地址，请在 config/settings.yaml 设置 model.base_url",
        "errors.endpoint_invalid": "模型请求地址不合法：{url}",
        "errors.ws_unknown_type": "未知消息类型：{msg_type}",
        "errors.ws_confirm_missing": "confirm_candidate 缺少 request_id 或 candidate_id",
        "errors.ws_output_not_ready": "候选输出尚未准备好",
        "errors.ws_copy_failed": "复制到剪贴板失败：{reason}",
        "errors.ws_cancel_missing": "cancel_run 缺少 request_id",
        "errors.settings_bad_format": "settings 更新格式不正确",
        "warnings.window_unavailable": "无法获取窗口信息，使用空上下文。",
        "warnings.screenshot_failed": "无法捕获桌面截图。",
        "notices.text_only_image_ignored": "已开启纯文本模式，图片输入被忽略，仅提供原样粘贴。",
    },
}


def normalize_locale(lang: str | None) -> str:
    if not lang:
        return DEFAULT_LOCALE
    lang = str(lang)
    if lang in _TRANSLATIONS:
        return lang
    # fallback by primary tag
    primary = lang.split("-")[0]
    for key in _TRANSLATIONS:
        if key.startswith(primary):
            return key
    return DEFAULT_LOCALE


def t(key: str, lang: str | None = None, **kwargs: object) -> str:
    locale = normalize_locale(lang)
    template = _TRANSLATIONS.get(locale, {}).get(key) or _TRANSLATIONS[DEFAULT_LOCALE].get(key) or key
    try:
        return template.format(**kwargs)
    except Exception:
        return template


def available_locales() -> Dict[str, str]:
    """Return map of locale code to human-readable name."""
    return {
        "en-US": "English",
        "zh-CN": "简体中文",
    }
