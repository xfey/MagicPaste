Convert the source content according to the selected intent.

### Intent
- Target action: {{ intent_title }}
- Intent description: {{ intent_description }}

{% if clipboard_is_image %}
Clipboard content is an image. Use the provided clipboard image to infer and generate the output.
{% else %}
Clipboard text:
```
{{ clipboard_text }}
```
{% endif %}

Return only the converted result.
