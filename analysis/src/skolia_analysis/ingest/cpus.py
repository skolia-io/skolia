"""How many CPUs the container gives the ingest process, and PyTorch's threads to match.

PyTorch starts a thread per CPU it sees, which can be more than the container may use.
"""

import math
import os
import sys
from pathlib import Path

import structlog

log = structlog.get_logger(module=__name__)

THREADS_ENV = "SKOLIA_TORCH_THREADS"
CGROUP_CPU_MAX = Path("/sys/fs/cgroup/cpu.max")


def affinity() -> int | None:
    """CPUs the process may be scheduled on."""
    if sys.platform == "linux":
        return len(os.sched_getaffinity(0))
    return None


def cgroup_quota(cpu_max: str | None) -> float | None:
    """CPUs' worth of time per period that cgroup v2's cpu.max allows ("200000 100000" is
    2), or None without a limit ("max 100000")."""
    if cpu_max is None:
        return None
    quota, period = cpu_max.split()
    return None if quota == "max" else int(quota) / int(period)


def available(affinity: int | None, quota: float | None) -> int:
    seen = affinity or os.cpu_count() or 1
    return max(1, min(seen, math.ceil(quota))) if quota is not None else seen


def set_torch_threads() -> None:
    """Give PyTorch one thread per available CPU, or SKOLIA_TORCH_THREADS, and log what the
    container has."""
    import torch

    cpu_max = CGROUP_CPU_MAX.read_text().strip() if CGROUP_CPU_MAX.exists() else None
    cpus = affinity()
    override = os.environ.get(THREADS_ENV)
    threads = int(override) if override else available(cpus, cgroup_quota(cpu_max))
    started_with = torch.get_num_threads()
    torch.set_num_threads(threads)
    log.info(
        "cpus",
        cpu_count=os.cpu_count(),
        affinity=cpus,
        cgroup_cpu_max=cpu_max,
        torch_threads_default=started_with,
        torch_threads=torch.get_num_threads(),
        torch_threads_override=override,
    )
