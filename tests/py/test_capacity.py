"""CPU capacity must reflect the process's effective allocation."""

import unittest
from unittest.mock import patch

from grid.capacity import effective_cpus


class Capacity(unittest.TestCase):
    def budget(self, files, affinity=48):
        with patch("grid.capacity.os.cpu_count", return_value=48), \
                patch("grid.capacity.os.sched_getaffinity", create=True,
                      return_value=set(range(affinity))), \
                patch("grid.capacity._read",
                      side_effect=lambda path: files.get(str(path), "")):
            return effective_cpus()

    def test_host_48_quota_8(self):
        self.assertEqual(self.budget({"/sys/fs/cgroup/cpu.max":
                                      "800000 100000"}), 8)

    def test_affinity_is_a_second_ceiling(self):
        self.assertEqual(self.budget({"/sys/fs/cgroup/cpu.max":
                                      "800000 100000"}, affinity=3), 3)

    def test_fractional_quotas_round_down_to_whole_worker_slots(self):
        for quota, expected in (("250000", 2), ("50000", 1)):
            self.assertEqual(self.budget({"/sys/fs/cgroup/cpu.max":
                                          quota + " 100000"}), expected)

    def test_missing_unlimited_and_malformed_metadata(self):
        for value in ("", "max 100000", "bad", "800000 0", "-1 100000"):
            self.assertEqual(self.budget({"/sys/fs/cgroup/cpu.max": value}),
                             48)
        with patch("grid.capacity.os.cpu_count", return_value=None), \
                patch("grid.capacity.os.sched_getaffinity", create=True,
                      side_effect=OSError), \
                patch("grid.capacity._read", return_value=""):
            self.assertEqual(effective_cpus(), 1)

    def test_nested_group_and_ancestor_quota(self):
        files = {
            "/proc/self/cgroup": "0::/team/job",
            "/proc/self/mountinfo":
                "1 0 0:1 / /cgroup rw - cgroup2 cgroup rw",
            "/cgroup/team/job/cpu.max": "1200000 100000",
            "/cgroup/team/cpu.max": "600000 100000",
            "/cgroup/cpu.max": "max 100000",
        }
        self.assertEqual(self.budget(files), 6)
        files["/proc/self/mountinfo"] = (
            "1 0 0:1 /team /cgroup rw - cgroup2 cgroup rw")
        files["/cgroup/job/cpu.max"] = "400000 100000"
        self.assertEqual(self.budget(files), 4)

    def test_v1_cpu_mount_and_parent_limit(self):
        files = {
            "/proc/self/cgroup": "3:cpu,cpuacct:/team/job",
            "/proc/self/mountinfo":
                "1 0 0:1 / /cpu rw - cgroup cgroup rw,cpu,cpuacct",
            "/cpu/team/job/cpu.cfs_quota_us": "-1",
            "/cpu/team/job/cpu.cfs_period_us": "100000",
            "/cpu/team/cpu.cfs_quota_us": "800000",
            "/cpu/team/cpu.cfs_period_us": "100000",
        }
        self.assertEqual(self.budget(files), 8)
