"""Install the checked guard before using a possibly stale installed guard."""
import os
import pathlib
import subprocess
import sys
import tempfile


def install_guard(source, directory=pathlib.Path("/usr/local/libexec")):
    # Validate the boundary from memory before creating any host files.
    subprocess.run(["sh", "-s", "--", "--cwd"], input=source, text=True,
                   cwd="/srv/grid", check=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".grid-storage-check-",
                                           dir=directory)
    try:
        with os.fdopen(descriptor, "w") as output:
            output.write(source)
        os.chmod(temporary, 0o755)
        os.replace(temporary, directory / "grid-storage-check")
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


if __name__ == "__main__":
    if os.geteuid() != 0:
        raise SystemExit("Storage guard upgrade requires root")
    install_guard(sys.stdin.read())
