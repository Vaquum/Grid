import pathlib
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from deploy.bootstrap_storage_guard import install_guard


class StorageBootstrapTest(unittest.TestCase):
    @patch("deploy.bootstrap_storage_guard.subprocess.run")
    def test_invalid_boundary_does_not_replace_installed_guard(self, run):
        run.side_effect = subprocess.CalledProcessError(1, ["sh"])
        with tempfile.TemporaryDirectory() as temporary:
            directory = pathlib.Path(temporary)
            target = directory / "grid-storage-check"
            target.write_text("old guard")
            with self.assertRaises(subprocess.CalledProcessError):
                install_guard("failing guard", directory)
            self.assertEqual(target.read_text(), "old guard")
            self.assertEqual(list(directory.iterdir()), [target])

    @patch("deploy.bootstrap_storage_guard.subprocess.run")
    def test_checked_guard_replaces_stale_guard_before_rsync(self, run):
        with tempfile.TemporaryDirectory() as temporary:
            directory = pathlib.Path(temporary)
            target = directory / "grid-storage-check"
            target.write_text("old blockdev guard")
            install_guard("new sysfs guard", directory)
            self.assertEqual(target.read_text(), "new sysfs guard")
            self.assertEqual(target.stat().st_mode & 0o777, 0o755)
            self.assertEqual(run.call_args.kwargs["cwd"], "/srv/grid")
