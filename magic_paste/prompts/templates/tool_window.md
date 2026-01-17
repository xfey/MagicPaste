Window context:
- App: {{ app_name or "Unknown app" }}
- Title: {{ window_title or "Unknown title" }}
{% if screenshot_url %}- Screenshot: {{ screenshot_url }}
{% else %}- Screenshot: Not provided
{% endif %}
