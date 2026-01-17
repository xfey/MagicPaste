"""
Data types used across the pipeline steps.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Dict, Optional


@dataclass
class IntentCandidate:
    title: str
    description: str
    confidence: str = "medium"


@dataclass
class IntentResult(IntentCandidate):
    output: str = ""
    error: Optional[str] = None
    candidate_id: Optional[str] = None


@dataclass
class PipelineEvent:
    request_id: str
    type: str
    payload: Dict[str, Any]


EventCallback = Callable[[PipelineEvent], Awaitable[None]]
