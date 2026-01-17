{% if clipboard_is_image %}
Clipboard content: an image from the user (see "Clipboard Image" below).
{% else %}
Clipboard text:
```
{{ clipboard_text }}
```
{% endif %}

{% if clipboard_is_image or screenshot_url %}
Attached visuals:
{% if clipboard_is_image %}- Clipboard Image: the original clipboard image if present.
{% endif %}{% if screenshot_url %}- Environment Screenshot: full-screen capture to help infer the destination context.
{% endif %}
{% endif %}

{% include "templates/tool_window.md" %}

Please output ONLY a JSON array; each item must include `title`, `description`, and `confidence`. Use the user's preferred language: {{ lang }}.
