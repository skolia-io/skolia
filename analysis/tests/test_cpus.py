from skolia_analysis.ingest.cpus import available, cgroup_quota


def test_cgroup_quota_is_cpus_per_period() -> None:
    assert cgroup_quota("200000 100000") == 2
    assert cgroup_quota("50000 100000") == 0.5


def test_no_cgroup_limit_is_no_quota() -> None:
    assert cgroup_quota("max 100000") is None
    assert cgroup_quota(None) is None


def test_the_quota_caps_the_cpus_seen() -> None:
    assert available(18, 1.0) == 1
    assert available(18, 1.5) == 2
    assert available(2, 4.0) == 2


def test_a_fraction_of_a_cpu_is_one_thread() -> None:
    assert available(18, 0.5) == 1


def test_without_a_quota_every_cpu_seen() -> None:
    assert available(6, None) == 6
