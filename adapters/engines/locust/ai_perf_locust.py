"""ai-perf shim for Locust: makes one standalone Locust process an ai-perf worker (CONTRACTS §3).

Loaded next to the product's locustfile: `locust -f <locustfile>,ai_perf_locust.py --headless`.
It owns the load shape (the run's profile, this worker's share), records every request into
perf-hist/v1 windows on the run's time axis, writes status.json each tick, samples failed requests
with their correlation id, and stops on control.stop, a lost heartbeat, or the hard end.
The bucket and window arithmetic must match controller/hist.mjs and controller/profile.mjs exactly;
tests/locust.test.mjs checks that.
"""

from __future__ import annotations

import json
import math
import os
import re
import time

import gevent
import psutil
from locust import LoadTestShape, events

RUN_DIR = os.environ["AI_PERF_RUN_DIR"]
INDEX = int(os.environ["AI_PERF_WORKER"])
with open(os.path.join(RUN_DIR, "run.json"), encoding="utf-8") as f:
    SPEC = json.load(f)
T = SPEC["timing"]
P = SPEC["profile"]
OUT = os.path.join(RUN_DIR, "raw", f"w{INDEX}")
os.makedirs(OUT, exist_ok=True)

MIN_MS = 0.1
LOG_GROWTH = math.log(1.01)
PHASES = ["warmup", "ramp", "steady", "rampdown"]
SAMPLES_PER_CLASS = 20


def bucket_of(ms: float) -> int:
    if not ms > MIN_MS:
        return 0
    return math.ceil(math.log(ms / MIN_MS) / LOG_GROWTH - 1e-9)


def bounds() -> dict:
    b, at = {}, 0.0
    for ph in PHASES:
        b[ph] = (at, at + P.get(f"{ph}_s", 0))
        at = b[ph][1]
    b["end"] = at
    return b


B = bounds()
WS = T["window_s"]
ORIGIN = B["steady"][0] - WS * math.ceil(B["steady"][0] / WS - 1e-9)


def window_index(t: float) -> int:
    return math.floor((t - ORIGIN) / WS + 1e-9)


def step_at(t: float):
    """The step a stepped profile is on at t (profile.mjs stepAt), or None."""
    steps = P.get("steps")
    if not steps or not (B["steady"][0] <= t < B["steady"][1]):
        return None
    return min(len(steps) - 1, math.floor((t - B["steady"][0]) / P["step_s"] + 1e-9))


def users_at(t: float) -> float:
    # `??` in profile.mjs: an explicit 0 stays 0.
    low = P["warmup_users"] if P.get("warmup_users") is not None else max(1, math.ceil(P["users"] * 0.1))
    steps = P.get("steps")
    first = steps[0] if steps else P["users"]
    top = steps[-1] if steps else P["users"]
    for ph in PHASES:
        start, end = B[ph]
        if t < end:
            frac = (t - start) / (end - start) if end > start else 0
            if ph == "warmup":
                return low
            if ph == "ramp":
                return low + (first - low) * frac
            if ph == "rampdown":
                return top * (1 - frac)
            spike = P.get("spike") or {}
            if spike.get("users") and B["steady"][0] + spike["at_s"] <= t < B["steady"][0] + spike["at_s"] + spike["for_s"]:
                return spike["users"]
            return steps[step_at(t)] if steps else P["users"]
    return 0


def write_json(path: str, value) -> None:
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(value, f)
    for _ in range(50):
        try:
            os.replace(tmp, path)
            return
        except PermissionError:
            time.sleep(0.005)
    raise PermissionError(path)


def read_json(path: str):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


status = {"worker": INDEX, "pid": os.getpid(), "state": "starting", "reason": None, "ts": 0, "t": None,
          "users": 0, "requests": 0, "failures": 0, "cpu_pct": 0, "error_classes": {}}
windows: dict[int, dict] = {}
dirty: set[int] = set()
samples: dict[str, int] = {}
control: dict = {}
proc = psutil.Process()
proc.cpu_percent(None)
hard_end = time.time() + T["barrier_timeout_s"] + B["end"] + 30
env_ref = {}


# The controller's clock is the run's clock (CONTRACTS §3). Each control read bounds this worker's
# offset from below (heartbeat_at was written before the read); the max converges on the truth.
offset = {"ms": None}


def host_ms() -> float:
    return time.time() * 1000 + (offset["ms"] or 0)


def now_t():
    go = control.get("go_at")
    return None if not go else (host_ms() - go) / 1000


def error_class(exc, response=None) -> str:
    # The status code comes from the response, never from digits in the message: "127.0.0.1" or
    # "[Errno 111]" are not HTTP statuses. No response (code 0) means the request never got one.
    for r in (response, getattr(exc, "response", None)):
        code = getattr(r, "status_code", None)
        if isinstance(code, int) and 100 <= code <= 599:
            return f"HTTP {code}"
    return type(exc).__name__


# Error text goes into the run's evidence: credentials in it are masked (design §7.3).
SECRETS = [
    (re.compile(r"([?&](?:access_token|token|api_?key|key|password|secret|sig)=)[^&\s'\"]+", re.I), r"\1***"),
    (re.compile(r"\b(Bearer|Token|Basic)\s+[A-Za-z0-9._~+/=-]{8,}", re.I), r"\1 ***"),
    (re.compile(r"(\b[a-z][a-z0-9+.-]*://)[^\s/:@'\"]+:[^\s/@'\"]+@", re.I), r"\1***@"),
]


def mask(text: str) -> str:
    for pattern, repl in SECRETS:
        text = pattern.sub(repl, text)
    return text


@events.request.add_listener
def on_request(request_type, name, response_time, response_length, exception=None, context=None, response=None, **_):
    t = now_t()
    if t is None or t < 0:
        return
    k = window_index(t)
    w = windows.setdefault(k, {"schema": "perf-hist-window/v1", "worker": INDEX, "window": k, "window_s": WS,
                               "origin_s": ORIGIN, "endpoints": {}})
    ep = w["endpoints"].setdefault(name, {"requests": 0, "failures": 0,
                                         "hist": {"schema": "perf-hist/v1", "count": 0, "max_ms": 0, "buckets": {}}})
    h = ep["hist"]
    b = str(bucket_of(response_time))
    h["buckets"][b] = h["buckets"].get(b, 0) + 1
    h["count"] += 1
    h["max_ms"] = max(h["max_ms"], response_time)
    ep["requests"] += 1
    status["requests"] += 1
    if exception is not None:
        cls = error_class(exception, response)
        ep["failures"] += 1
        status["failures"] += 1
        status["error_classes"][cls] = status["error_classes"].get(cls, 0) + 1
        if samples.get(cls, 0) < SAMPLES_PER_CLASS:
            samples[cls] = samples.get(cls, 0) + 1
            rid = response.headers.get("x-request-id") if response is not None else None
            with open(os.path.join(OUT, "errors.ndjson"), "a", encoding="utf-8") as f:
                f.write(json.dumps({"t": round(t, 3), "name": name, "class": cls, "error": mask(str(exception))[:300],
                                    "correlation_id": rid}) + "\n")
    dirty.add(k)


def flush():
    for k in list(dirty):
        try:
            write_json(os.path.join(OUT, f"hist-{k}.json"), windows[k])
            dirty.discard(k)
        except OSError:
            pass


def stop(reason: str):
    flush()
    status.update(state="stopped", reason=reason, ts=int(host_ms()))
    write_json(os.path.join(OUT, "status.json"), status)
    runner = env_ref.get("env").runner if env_ref.get("env") else None
    if runner:
        runner.quit()
    os._exit(0)


STALL_S = max(1.0, 5 * T["tick_ms"] / 1000)
status["stalls"] = []


def loop():
    last = time.time()
    while True:
        # A gap longer than STALL_S between ticks means this process froze and sent nothing: it is
        # reported (CONTRACTS §3); the controller decides whether the run is still evaluable.
        gap = time.time() - last
        last = time.time()
        t_now = now_t()
        if status["state"] == "running" and gap > STALL_S and t_now is not None:
            status["stalls"].append({"from": round(t_now - gap, 3), "to": round(t_now, 3)})
        global control
        read = read_json(os.path.join(RUN_DIR, "control.json"))
        if read:
            control = read
            seen = read.get("heartbeat_at", 0) - time.time() * 1000
            offset["ms"] = seen if offset["ms"] is None else max(offset["ms"], seen)
        if time.time() > hard_end:
            stop("hard_end")
        now_ms = host_ms()
        status["ts"] = int(now_ms)
        if control and now_ms - control.get("heartbeat_at", 0) > T["heartbeat_timeout_s"] * 1000:
            stop("heartbeat_lost")
        if control.get("stop"):
            stop(control.get("stop_reason") or "stop")
        t = now_t()
        if t is not None and t >= 0:
            status["state"] = "running"
            status["t"] = t
        runner = env_ref["env"].runner
        status["users"] = runner.user_count if runner else 0
        status["cpu_pct"] = proc.cpu_percent(None)
        flush()
        try:
            write_json(os.path.join(OUT, "status.json"), status)
        except OSError:
            pass
        gevent.sleep(T["tick_ms"] / 1000)


@events.init.add_listener
def on_init(environment, **_):
    env_ref["env"] = environment


@events.test_start.add_listener
def on_test_start(environment, **_):
    status["state"] = "ready"
    gevent.spawn(loop)


class AiPerfShape(LoadTestShape):
    """Follows the run's profile from go_at; zero users until then (the barrier)."""

    def tick(self):
        t = now_t()
        if t is None or t < 0:
            return (0, 100)
        if t >= B["end"]:
            return (0, 100)
        # Whole users split exactly: the first (total mod workers) workers take one extra, so the
        # sum over workers is the profile's count, never a rounding drift.
        total = round(users_at(t))
        share = total // SPEC["workers"] + (1 if INDEX < total % SPEC["workers"] else 0)
        return (share, max(1, P["users"]))
