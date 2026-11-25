#!/usr/bin/env python3
"""V0.2 acceptance using two ZIPs, a standalone Host, and a stock Caddy."""

import argparse
import contextlib
import copy
import http.server
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request

PLUGIN = "cn.ezios.ecm"


class Upstream(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(404 if self.path.startswith("/missing") else 200)
        self.end_headers()
        self.wfile.write(f"{self.server.name} {self.path}".encode())

    def log_message(self, *_):
        pass


def free_ports(count):
    with contextlib.ExitStack() as stack:
        sockets = [stack.enter_context(socket.socket()) for _ in range(count)]
        for sock in sockets:
            sock.bind(("127.0.0.1", 0))
        return [sock.getsockname()[1] for sock in sockets]


def process(stack, argv, log, **options):
    with log.open("wb") as output:
        child = subprocess.Popen(argv, stdout=output, stderr=subprocess.STDOUT, **options)

    def stop():
        if child.poll() is None:
            child.terminate()
            try:
                child.wait(5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()

    stack.callback(stop)
    return child


def wait_health(check):
    for _ in range(100):
        try:
            if check() is not False:
                return
        except (OSError, AssertionError):
            time.sleep(0.1)
    raise AssertionError("待测服务未启动")


def run(args, work, stack):
    host_port, admin, http_port, https, route_port, v4_port, v6_port = free_ports(7)
    host_url = f"http://127.0.0.1:{host_port}"
    host_api = f"/api/v1/extensions/{PLUGIN}"
    plugin_api = f"/extensions/{PLUGIN}/api"
    client = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def request(method, path, body=None, status=200):
        headers = {}
        if isinstance(body, Path):
            body, headers = body.read_bytes(), {"Content-Type": "application/zip"}
        elif body is not None:
            body, headers = json.dumps(body).encode(), {"Content-Type": "application/json"}
        req = urllib.request.Request(host_url + path, data=body, method=method, headers=headers)
        try:
            response = client.open(req, timeout=30)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            data = response.read().decode()
            assert response.status == status, (method, path, response.status, data)
            return json.loads(data) if data else {}

    def api(method, path, body=None, status=200):
        envelope = request(method, plugin_api + path, body, status)
        if status == 200:
            assert envelope["ok"], envelope
            return envelope["data"]
        return envelope["error"]

    def install(package, configure, version):
        info = request("POST", "/api/v1/extensions", package, 201)
        assert info["version"] == version, info
        request("PUT", host_api + "/config", configure)
        request("POST", host_api + "/enable")

    conf = work / "conf.d"
    sites = work / "sites"
    conf.mkdir()
    (work / "conf.d.disabled").mkdir()
    sites.mkdir()
    main = work / "Caddyfile"
    main.write_text(
        "# >>> ext-caddy-manage:global\n{\n"
        f"\tadmin 127.0.0.1:{admin}\n\thttp_port {http_port}\n\thttps_port {https}\n"
        "\tskip_install_trust\n}\n# <<< ext-caddy-manage:global\nimport conf.d/*.caddy\n"
    )
    trust = work / "client-root.pem"
    env = {
        **os.environ,
        "XDG_DATA_HOME": str(work / "caddy-data"),
        "XDG_CONFIG_HOME": str(work / "caddy-config"),
        "SSL_CERT_FILE": str(trust),
    }
    process(stack, [args.caddy, "run", "--config", main, "--adapter", "caddyfile"], work / "caddy.log", env=env)
    process(stack, [args.host, "serve", "--listen", f"127.0.0.1:{host_port}", "--data-dir", work / "host"], work / "host.log", env=env)
    wait_health(lambda: request("GET", "/api/v1/extensions"))
    wait_health(lambda: client.open(f"http://127.0.0.1:{admin}/config/", timeout=2).close())

    config = dict(caddyBinary=args.caddy, mainConfig=str(main), snippetDir=str(conf),
                  sitesRoot=str(sites), logLines=231, certProbeHours=17, backupKeep=23)
    install(args.previous_zip, config, "0.1.0")
    print("验证 V0.1 ZIP 与升级前快照", flush=True)
    old = api("POST", "/site", {"model": {
        "type": "static", "name": "Legacy", "domains": ["old.test"], "https": False,
    }})
    old_path = "/site?slug=" + old["slug"]
    assert old["apply"]["reloaded"], old
    old = api("POST", "/site/update", {"slug": old["slug"], "baseline": old["raw"],
                                        "model": dict(old["model"], note="previous version")})
    assert old["apply"]["reloaded"] and old["backups"], old
    backup = old["backups"][0]["name"]
    old_root = Path(old["model"]["static"]["root"])
    old_root.mkdir(exist_ok=True)
    (old_root / "index.html").write_text("legacy")

    request("DELETE", host_api, status=204)
    install(args.current_zip, config, "0.2.0")
    upgraded = api("GET", old_path)
    assert upgraded["raw"] == old["raw"] and upgraded["formMatchesFile"] is True and upgraded["drift"] is False
    assert upgraded["model"]["note"] == "previous version"
    assert backup in [entry["name"] for entry in upgraded["backups"]]
    assert api("GET", "/backup?name=" + backup)["content"] == old["raw"]
    assert api("GET", "/health")["logLines"] == 231
    diagnostics = api("GET", "/diagnostics")
    effective = {entry["key"]: entry["value"] for entry in diagnostics["config"]}
    assert all(effective[key] == value for key, value in config.items()), effective
    capabilities = {item["id"]: item for item in diagnostics["dns"]["providers"]}
    for provider in ("cloudflare", "alidns", "tencentcloud"):
        item = capabilities["dns.providers." + provider]
        assert item["disk"] == "missing", item
        assert item["running"] in {"missing", "unknown"}, item

    def fetch(url, resolve=None, ca=None, auth=False):
        stdout = work / "response.txt"
        command = ["curl", "-q", "--noproxy", "*", "--silent", "--max-time", "3",
                   "--output", str(stdout), "--write-out", "%{http_code}"]
        if resolve:
            command.extend(["--resolve", resolve])
        if ca:
            command.extend(["--cacert", str(ca)])
        if auth:
            command.extend(["--user", "tester:secret"])
        value = subprocess.run([*command, "--", url], text=True, capture_output=True)
        if value.returncode:
            return value.returncode, ""
        return int(value.stdout), stdout.read_text()

    assert fetch(f"http://old.test:{http_port}/", f"old.test:{http_port}:127.0.0.1") == (200, "legacy")

    print("验证内网 HTTPS、监听范围、根 CA 与宿主信任", flush=True)
    tls_sites = []
    for name, identity, address, port, scope in (
        ("TLS Domain", "internal.test", "127.0.0.1", https, "local"),
        ("TLS IPv4", "127.0.0.2", "127.0.0.2", v4_port, "address"),
        ("TLS IPv6", "[0:0:0:0:0:0:0:1]", "::1", v6_port, "all"),
    ):
        entry = {"protocol": "internal", "scope": scope, "port": port}
        if scope == "address":
            entry["bindAddress"] = address
        site = api("POST", "/site", {"model": {"type": "static", "name": name,
                                               "domains": [identity], "access": entry}})
        assert site["apply"]["reloaded"] and "tls internal" in site["raw"], site
        assert site["formMatchesFile"] is True and site["certs"] == [], site
        root = Path(site["model"]["static"]["root"])
        root.mkdir(exist_ok=True)
        (root / "index.html").write_text(name)
        tls_sites.append(site)

    def check(site):
        return api("GET", f"/site/entry-check?slug={site['slug']}")

    wait_health(lambda: check(tls_sites[0])["connected"])
    ca = api("GET", f"/site/root-ca?slug={tls_sites[0]['slug']}")
    assert re.fullmatch(r"(?:[0-9A-F]{2}:){31}[0-9A-F]{2}", ca["fingerprint"]), ca
    assert ca["pem"].count("BEGIN CERTIFICATE") == 1 and "PRIVATE KEY" not in ca["pem"]
    for site in tls_sites:
        entry = check(site)
        assert entry["issuance"] == "presented" and entry["connected"] and entry["trust"] == "untrusted", entry
    trust.write_text(ca["pem"])
    domain_resolve = f"internal.test:{https}:127.0.0.1"
    for index, site in enumerate(tls_sites):
        assert fetch(site["urls"][0], domain_resolve if index == 0 else None, trust) == (200, site["name"])
        entry = check(site)
        assert entry["trust"] == "trusted" and entry["httpStatus"] == 200, entry
    for addr, port in (("127.0.0.2", https), ("127.0.0.1", v4_port)):
        with socket.socket() as probe:
            assert probe.connect_ex((addr, port)) != 0, (addr, port)
    with socket.create_connection(("127.0.0.2", v6_port), timeout=2):
        pass

    print("验证按段匹配、重写、查询串和互斥兜底", flush=True)
    upstreams = []
    for name in ("pool-a", "pool-b", "overlap"):
        server = stack.enter_context(http.server.ThreadingHTTPServer(("127.0.0.1", 0), Upstream))
        server.name = name
        threading.Thread(target=server.serve_forever, daemon=True).start()
        stack.callback(server.shutdown)
        upstreams.append(f"127.0.0.1:{server.server_port}")

    static = sites / "spa"
    static.mkdir()
    (static / "index.html").write_text("SPA_FALLBACK")
    model = {
        "name": "Routing", "type": "proxy", "domains": ["routes.test"],
        "access": {"protocol": "http", "scope": "local", "port": route_port},
        "routing": {
            "rules": [
                {"match": "prefix", "path": "/api", "action": "strip", "proxy": {"upstreams": upstreams[:2]}},
                {"match": "prefix", "path": "/api/v2", "proxy": {"upstreams": upstreams[2:]}},
                {"match": "exact", "path": "/api", "action": "rewrite", "rewrite": "/status",
                 "proxy": {"upstreams": upstreams[2:]}},
            ],
            "fallback": {"type": "static", "static": {"root": str(static), "spa": True}},
        },
    }
    route = api("POST", "/site", {"model": model})
    assert route["apply"]["reloaded"], route

    def hit(path, auth=False):
        return fetch(f"http://routes.test:{route_port}{path}", f"routes.test:{route_port}:127.0.0.1", auth=auth)

    assert hit("/api?keep=1") == (200, "overlap /status?keep=1")
    seen = {hit("/api/") for _ in range(6)}
    assert seen == {(200, "pool-a /"), (200, "pool-b /")}, seen
    assert hit("/api/users?a=1&a=2")[1].endswith(" /users?a=1&a=2")
    assert hit("/api/v2/users") == (200, "overlap /api/v2/users")
    assert hit("/apiv2") == (200, "SPA_FALLBACK")
    status, response = hit("/api/missing")
    assert status == 404 and response.endswith(" /missing"), (status, response)
    dup = copy.deepcopy(model)
    dup["routing"]["rules"].append(dup["routing"]["rules"][0])
    assert api("POST", "/site/preview", {"slug": route["slug"], "model": dup}, 400)["code"] == "invalid_model"

    def update(candidate, status=200):
        nonlocal route
        result = api("POST", "/site/update", {"slug": route["slug"], "baseline": route["raw"], "model": candidate}, status)
        if status == 200:
            route = result
            assert route["apply"]["reloaded"], route
        return result

    print("验证访问控制、磁盘冲突和真实重载失败回滚", flush=True)
    hashed = subprocess.run([args.caddy, "hash-password"], input="secret\n", text=True, capture_output=True, check=True).stdout.strip()
    model["security"] = {"basicAuth": [{"user": "tester", "hash": hashed}], "ipMode": "deny", "ipList": ["127.0.0.1"]}
    update(model)
    assert route["raw"].index("respond @denied 403") < route["raw"].index("basic_auth") < route["raw"].index("handle @")
    for path in ("/api", "/apiv2"):
        assert hit(path)[0] == 403 and hit(path, True)[0] == 403
    model["security"].update(ipMode="allow", ipList=["127.0.0.1"])
    update(model)
    for path in ("/api", "/apiv2"):
        assert hit(path)[0] == 401 and hit(path, True)[0] == 200

    model["routing"]["fallback"] = {"type": "proxy", "proxy": {"upstreams": upstreams[2:]}}
    update(model)
    assert hit("/apiv2?keep=yes", True) == (200, "overlap /apiv2?keep=yes")
    model["routing"]["fallback"] = {"type": "404"}
    update(model)
    assert hit("/apiv2", True)[0] == 404
    path = Path(route["path"])
    path.write_text(route["raw"] + "# external\n")
    assert update(model, 409)["code"] == "conflict"
    assert path.read_text().endswith("# external\n")
    path.write_text(route["raw"])

    with socket.socket() as blocked:
        blocked.bind(("127.0.0.1", 0))
        blocked.listen()
        failed = copy.deepcopy(model)
        failed["access"]["port"] = blocked.getsockname()[1]
        assert update(failed, 503)["code"] == "reload_failed"
    assert path.read_text() == route["raw"] and hit("/api", True) == (200, "overlap /status")
    saved = api("GET", f"/site?slug={route['slug']}")
    assert saved["model"]["access"]["port"] == route_port and saved["formMatchesFile"]

    print(f"PASS V0.2 standalone ZIP acceptance. Browser URL {host_url}/extensions/{PLUGIN}/web/", flush=True)
    if args.serve:
        while True:
            time.sleep(1)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--caddy", required=True)
    parser.add_argument("--host", default="ext")
    parser.add_argument("--previous-zip", required=True, type=Path)
    parser.add_argument("--current-zip", required=True, type=Path)
    parser.add_argument("--serve", action="store_true", help="keep the isolated fixture running for browser checks")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="ecm-v02-accept-") as directory, contextlib.ExitStack() as stack:
        work = Path(directory)
        try:
            run(args, work, stack)
        except KeyboardInterrupt:
            pass
        except Exception:
            for log in ("caddy.log", "host.log"):
                if (work / log).is_file():
                    print(f"--- {log} ---\n{(work / log).read_text()[-6000:]}")
            raise


if __name__ == "__main__":
    main()
