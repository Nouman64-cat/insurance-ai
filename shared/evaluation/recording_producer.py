"""A stand-in for the Kafka producer in the evaluation stack: it records what would have been published and sends nothing.

The services call only start(), stop() and send_and_wait(topic, value=, key=). In the evaluation stack the broker is not
reachable on purpose (see evals/environment/README.md), so the services get this object instead. It refuses to be
created outside an evaluation process: silently swallowing events in a real deployment would lose business data.
"""
from __future__ import annotations

from typing import Any, List, Optional, Tuple

from shared.evaluation.safety import assert_evaluation_process

MAX_KEPT = 10_000


class RecordingProducer:
    def __init__(self) -> None:
        assert_evaluation_process()
        self.sent: List[Tuple[str, Optional[str], Any]] = []
        self.dropped = 0
        self.started = False

    async def start(self) -> None:
        self.started = True

    async def stop(self) -> None:
        self.started = False

    async def send_and_wait(self, topic: str, value: Any = None, key: Any = None, **_: Any) -> None:
        if len(self.sent) < MAX_KEPT:
            self.sent.append((topic, key, value))
        else:
            self.dropped += 1

    send = send_and_wait
