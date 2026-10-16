import json
import unittest
from unittest.mock import patch

from deploy import grid_network as network


class GridNetworkTest(unittest.TestCase):
    @patch.object(network, "links", return_value=[])
    @patch.object(network, "run")
    def test_grid_only_creates_its_own_bridge(self, run, _links):
        run.side_effect = lambda *args: "[]" if "route" in args else ""
        network.ensure_grid_bridge()
        commands = [call.args for call in run.call_args_list]
        self.assertIn(("ip", "link", "add", "grid0", "type", "bridge"),
                      commands)
        self.assertFalse(any("docker0" in args for args in commands))

    @patch.object(network, "links", return_value=[])
    @patch.object(network, "run")
    def test_grid_refuses_overlapping_route(self, run, _links):
        run.return_value = '[{"dst":"169.254.254.0/24","dev":"other"}]'
        with self.assertRaisesRegex(RuntimeError, "overlaps"):
            network.ensure_grid_bridge()
        self.assertEqual(run.call_count, 1)

    @patch.object(network, "links")
    @patch.object(network, "run")
    def test_repair_reattaches_recorded_endpoint_without_restart(self, run,
                                                              links):
        peer = {"ifindex": 41, "ifname": "veth-primary",
                "linkinfo": {"info_kind": "veth"}}
        links.side_effect = [[peer], [peer]]
        primary = {"Options": {"com.docker.network.bridge.name": "docker0"},
                   "IPAM": {"Config": [{"Subnet": "172.17.0.0/16",
                                        "Gateway": "172.17.0.1"}]},
                   "Containers": {"primary": {
                       "MacAddress": "02:42:ac:11:00:02"}}}

        def execute(*args):
            if args[0] == "docker" and "network" in args:
                return json.dumps([primary])
            if args[0] == "docker" and "inspect" in args:
                return '[{"State":{"Running":true,"Pid":100}}]'
            if args[:1] == ("nsenter",) and "show" in args:
                return json.dumps([{"ifname": "eth0", "link_index": 41,
                                    "address": "02:42:ac:11:00:02"}])
            return ""

        run.side_effect = execute
        network.restore_primary_bridge()
        commands = [call.args for call in run.call_args_list]
        self.assertIn(("ip", "link", "set", "dev", "veth-primary",
                       "master", "docker0"), commands)
        self.assertFalse(any("restart" in args for args in commands))


if __name__ == "__main__":
    unittest.main()
