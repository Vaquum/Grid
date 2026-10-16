"""Start Grid's real daemon twice and preserve a primary bridge and port."""
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def output(*args: str) -> str:
    return subprocess.check_output(args, text=True)


def snapshot(name: str) -> dict[str, object]:
    link = json.loads(output("ip", "-j", "link", "show", "dev", name))[0]
    return {key: link.get(key) for key in ("ifindex", "address", "master")}


def isolated() -> None:
    output("ip", "link", "add", "docker0", "type", "bridge")
    output("ip", "address", "add", "172.17.0.1/16", "dev", "docker0")
    output("ip", "link", "set", "docker0", "up")
    output("ip", "link", "add", "primary-port", "type", "veth",
           "peer", "name", "primary-peer")
    output("ip", "link", "set", "primary-port", "master", "docker0")
    before = (snapshot("docker0"), snapshot("primary-port"))
    output(sys.executable, str(ROOT / "deploy/grid_network.py"))
    with tempfile.TemporaryDirectory(prefix="grid-network-") as folder:
        tmp = Path(folder)
        config = json.loads((ROOT / "deploy/grid-docker.json").read_text())
        config.update({"data-root": str(tmp / "docker"),
                       "exec-root": str(tmp / "exec"),
                       "pidfile": str(tmp / "docker.pid"),
                       "hosts": ["unix://" + str(tmp / "docker.sock")],
                       "containerd": str(tmp / "containerd.sock")})
        (tmp / "docker.json").write_text(json.dumps(config))
        runtime_config = (ROOT / "deploy/grid-containerd.toml").read_text()
        runtime_config = runtime_config.replace(
            "/srv/grid/containerd", str(tmp / "containerd"))
        runtime_config = runtime_config.replace(
            "/run/grid-containerd/containerd.sock", str(tmp / "containerd.sock"))
        runtime_config = runtime_config.replace(
            "/run/grid-containerd", str(tmp / "runtime-state"))
        (tmp / "containerd.toml").write_text(runtime_config)
        processes: list[subprocess.Popen[bytes]] = []
        try:
            with (tmp / "runtime.log").open("wb") as log:
                runtime = subprocess.Popen([
                    "containerd", "--config", str(tmp / "containerd.toml")],
                    stdout=log, stderr=subprocess.STDOUT)
                processes.append(runtime)
                for _ in range(2):
                    daemon = subprocess.Popen([
                        "dockerd", "--config-file", str(tmp / "docker.json")],
                        stdout=log, stderr=subprocess.STDOUT)
                    processes.append(daemon)
                    client = ["docker", "--host", config["hosts"][0]]
                    deadline = time.monotonic() + 30
                    while time.monotonic() < deadline:
                        assert daemon.poll() is None, "Grid daemon exited"
                        try:
                            ready = subprocess.run(
                                [*client, "info"], stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL, timeout=2)
                        except subprocess.TimeoutExpired:
                            continue
                        if ready.returncode == 0:
                            break
                        time.sleep(0.1)
                    else:
                        raise AssertionError("Grid daemon did not become ready")
                    assert before == (snapshot("docker0"),
                                      snapshot("primary-port"))
                    network = json.loads(output(
                        *client, "network", "inspect", "bridge"))[0]
                    assert network["Options"][
                        "com.docker.network.bridge.name"] == "grid0"
                    daemon.terminate()
                    daemon.wait(timeout=30)
                    assert before == (snapshot("docker0"),
                                      snapshot("primary-port"))
        except BaseException:
            print((tmp / "runtime.log").read_text(errors="replace")[-10000:])
            raise
        finally:
            for process in reversed(processes):
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait()
    print("Grid daemon restarts preserve docker0 and its existing veth port")


if __name__ == "__main__":
    if os.geteuid() != 0:
        raise SystemExit("run as root on the disposable Linux CI runner")
    if "--isolated" in sys.argv:
        isolated()
    else:
        subprocess.run(["unshare", "--net", "--mount", "--propagation",
                        "private", sys.executable, __file__, "--isolated"],
                       check=True)
