"""Bounded, thread-safe operational metrics. No filenames or document contents."""

from collections import Counter, deque
import math
import sys
import threading
import time
try:
    import resource
except ImportError:  # Windows: report unavailable instead of inventing a memory number.
    resource = None

BUCKETS = (0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600)


def percentile(values, fraction):
    if not values:
        return None
    values = sorted(values)
    index = (len(values) - 1) * fraction
    low = math.floor(index)
    high = math.ceil(index)
    return values[low] + (values[high] - values[low]) * (index - low)


class Metrics:
    def __init__(self):
        self.started = time.monotonic()
        self.lock = threading.Lock()
        self.http = Counter()
        self.modes = {}

    def observe_http(self, status):
        with self.lock:
            self.http[str(status)] += 1

    def observe(self, performance, verdict, layer2, layer3):
        mode = "content_pixel" if layer2 and layer3 else "content" if layer2 else "pixel" if layer3 else "file_only"
        with self.lock:
            state = self.modes.setdefault(mode, {
                "count": 0, "complete": 0, "total_seconds": 0., "input_bytes": 0,
                "latencies": deque(maxlen=256), "buckets": Counter(), "verdicts": Counter(), "layers": Counter(),
            })
            seconds = performance["total_seconds"]
            state["count"] += 1
            state["complete"] += int(performance["complete"])
            state["total_seconds"] += seconds
            state["input_bytes"] += performance["input_bytes"]
            state["latencies"].append(seconds)
            state["verdicts"][verdict] += 1
            for bound in BUCKETS:
                state["buckets"][bound] += int(seconds <= bound)
            for layer, duration in performance["layer_seconds"].items():
                state["layers"][layer] += duration

    def snapshot(self):
        with self.lock:
            uptime = time.monotonic() - self.started
            modes = {}
            for mode, state in self.modes.items():
                n = state["count"]
                modes[mode] = {
                    "analyses": n, "complete": state["complete"], "incomplete": n - state["complete"],
                    "completion_rate": state["complete"] / n,
                    "mean_seconds": state["total_seconds"] / n,
                    "p50_seconds": percentile(state["latencies"], .5),
                    "p95_seconds": percentile(state["latencies"], .95),
                    "percentile_sample_count": len(state["latencies"]),
                    "input_bytes": state["input_bytes"], "verdict_counts": dict(state["verdicts"]),
                    "mean_layer_seconds": {layer: seconds / n for layer, seconds in state["layers"].items()},
                }
            count = sum(s["count"] for s in self.modes.values())
            factor = 1 if sys.platform == "darwin" else 1024
            return {
                "scope": "API process; resets on restart; percentiles use the latest 256 analyses per mode",
                "uptime_seconds": uptime, "analyses": count,
                "observed_analyses_per_minute": count * 60 / max(uptime, .001),
                "http_status_counts": dict(self.http), "modes": modes,
                "api_peak_rss_bytes": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * factor if resource else None,
                "worker_peak_rss_bytes": resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss * factor if resource else None,
                "memory_scope": "Process-lifetime high-water marks; worker value is not per document or simultaneous total memory",
            }

    def prometheus(self):
        with self.lock:
            lines = ["# TYPE forgery_analysis_duration_seconds histogram", "# TYPE forgery_analyses_total counter", "# TYPE forgery_http_requests_total counter"]
            for mode, state in sorted(self.modes.items()):
                for bound in BUCKETS:
                    lines.append(f'forgery_analysis_duration_seconds_bucket{{mode="{mode}",le="{bound}"}} {state["buckets"][bound]}')
                lines.extend([
                    f'forgery_analysis_duration_seconds_bucket{{mode="{mode}",le="+Inf"}} {state["count"]}',
                    f'forgery_analysis_duration_seconds_count{{mode="{mode}"}} {state["count"]}',
                    f'forgery_analysis_duration_seconds_sum{{mode="{mode}"}} {state["total_seconds"]}',
                    f'forgery_analyses_total{{mode="{mode}",complete="true"}} {state["complete"]}',
                    f'forgery_analyses_total{{mode="{mode}",complete="false"}} {state["count"] - state["complete"]}',
                ])
            for status, count in sorted(self.http.items()):
                lines.append(f'forgery_http_requests_total{{status="{status}"}} {count}')
            return "\n".join(lines) + "\n"
