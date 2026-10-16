#!/usr/bin/env python3
"""Keep Grid's bridge separate; repair the host bridge during deployment."""
import argparse
import ipaddress
import json
import subprocess

GRID_BRIDGE = "grid0"
GRID_ADDRESS = "169.254.254.1/30"
PRIMARY = ["docker", "--host", "unix:///var/run/docker.sock"]


def run(*args):
    return subprocess.check_output(args, text=True)


def links():
    return json.loads(run("ip", "-j", "-d", "link", "show"))


def ensure_grid_bridge():
    existing = next((x for x in links() if x["ifname"] == GRID_BRIDGE), None)
    if existing is None:
        target = ipaddress.ip_interface(GRID_ADDRESS).network
        for route in json.loads(run("ip", "-j", "-4", "route", "show")):
            if route.get("dst", "default") == "default":
                continue
            if target.overlaps(ipaddress.ip_network(route["dst"], strict=False)):
                raise RuntimeError("Grid bridge subnet overlaps an existing route")
        run("ip", "link", "add", GRID_BRIDGE, "type", "bridge")
        run("ip", "address", "add", GRID_ADDRESS, "dev", GRID_BRIDGE)
    else:
        if existing.get("linkinfo", {}).get("info_kind") != "bridge":
            raise RuntimeError("grid0 exists and is not a bridge")
        addresses = json.loads(run("ip", "-j", "-4", "address", "show",
                                   "dev", GRID_BRIDGE))[0]["addr_info"]
        expected = ipaddress.ip_interface(GRID_ADDRESS)
        if not any(a["local"] == str(expected.ip)
                   and a["prefixlen"] == expected.network.prefixlen
                   for a in addresses):
            raise RuntimeError("grid0 has an unexpected address")
    run("ip", "link", "set", "dev", GRID_BRIDGE, "up")


def restore_primary_bridge():
    network = json.loads(run(*PRIMARY, "network", "inspect", "bridge"))[0]
    options = network["Options"]
    bridge = options["com.docker.network.bridge.name"]
    if bridge != "docker0":
        raise RuntimeError("Primary engine does not use docker0; refusing repair")
    existing = next((x for x in links() if x["ifname"] == bridge), None)
    if existing is None:
        ipv4 = next(c for c in network["IPAM"]["Config"]
                    if ipaddress.ip_network(c["Subnet"]).version == 4)
        prefix = ipaddress.ip_network(ipv4["Subnet"]).prefixlen
        run("ip", "link", "add", bridge, "type", "bridge")
        run("ip", "address", "add", f'{ipv4["Gateway"]}/{prefix}',
            "dev", bridge)
        run("ip", "link", "set", "dev", bridge, "mtu",
            options.get("com.docker.network.driver.mtu", "1500"))
    elif existing.get("linkinfo", {}).get("info_kind") != "bridge":
        raise RuntimeError("docker0 exists and is not a bridge")
    run("ip", "link", "set", "dev", bridge, "up")
    # Deleting a bridge detaches existing veth ports. Reattach only endpoints
    # recorded on the primary engine's default network; never restart services.
    host_links = {x["ifindex"]: x for x in links()}
    for cid, endpoint in network.get("Containers", {}).items():
        container = json.loads(run(*PRIMARY, "inspect", cid))[0]
        if not container["State"]["Running"]:
            continue
        pid = str(container["State"]["Pid"])
        interfaces = json.loads(run("nsenter", "--target", pid, "--net",
                                    "ip", "-j", "link", "show"))
        interface = next(x for x in interfaces if x.get("address", "").lower()
                         == endpoint["MacAddress"].lower())
        peer = host_links[interface["link_index"]]
        if peer.get("linkinfo", {}).get("info_kind") != "veth":
            raise RuntimeError("Primary endpoint peer is not a veth")
        if peer.get("master") not in (None, bridge):
            raise RuntimeError("Primary endpoint is attached to another bridge")
        run("ip", "link", "set", "dev", peer["ifname"], "master", bridge)
        run("ip", "link", "set", "dev", peer["ifname"], "up")
        # A recreated bridge can have a new MAC; discard stale gateway ARP.
        for config in network["IPAM"]["Config"]:
            gateway = config.get("Gateway")
            if gateway and ipaddress.ip_address(gateway).version == 4:
                run("nsenter", "--target", pid, "--net", "ip", "neigh",
                    "flush", "to", gateway, "dev", interface["ifname"])


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--restore-primary", action="store_true")
    args = parser.parse_args()
    if args.restore_primary:
        restore_primary_bridge()
    ensure_grid_bridge()
