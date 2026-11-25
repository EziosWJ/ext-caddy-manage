#!/usr/bin/env python3
"""Exercise V0.3 ZIP upgrade and quick publishing with stock Caddy and standalone Host."""

import argparse
import base64
import contextlib
import hashlib
import http.client
import http.server
import json
import os
from pathlib import Path
import runpy
import shutil
import socket
import tempfile
import threading
import time
import urllib.error
import urllib.request

HARNESS = runpy.run_path(str(Path(__file__).with_name("e2e-v02.py")))
PLUGIN = HARNESS["PLUGIN"]
free_ports, process, wait_health = (HARNESS[name] for name in ("free_ports", "process", "wait_health"))


class Upstream(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        self.server.requests.append(self.path)
        if self.path == "/ws" and self.headers.get("Upgrade", "").lower() == "websocket":
            accept = hashlib.sha1((self.headers["Sec-WebSocket-Key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode())
            self.send_response(101)
            self.send_header("Connection", "Upgrade")
            self.send_header("Upgrade", "websocket")
            self.send_header("Sec-WebSocket-Accept", base64.b64encode(accept.digest()).decode())
            self.end_headers()
            self.wfile.write(b"\x81\x05hello")
            self.wfile.flush()
            self.close_connection = True
            return
        if self.path == "/events":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
            first = b"data: first\n\n"
            self.wfile.write(f"{len(first):x}\r\n".encode() + first + b"\r\n")
            self.wfile.flush()
            self.server.stream_release.wait(5)
            self.wfile.write(b"0\r\n\r\n")
            return
        time.sleep(self.server.delay)
        status = self.server.status if self.path == "/" else 200
        data = f"{self.server.label} {self.path}".encode()
        self.send_response(status)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        with contextlib.suppress(BrokenPipeError, ConnectionResetError):
            self.wfile.write(data)

    def log_message(self, *_):
        pass


class IPv6Server(http.server.ThreadingHTTPServer):
    address_family = socket.AF_INET6


def upstream(stack, host="127.0.0.1", status=200, delay=0, label="upstream"):
    server_class = IPv6Server if host == "::1" else http.server.ThreadingHTTPServer
    server = stack.enter_context(server_class((host, 0), Upstream))
    server.status, server.delay, server.label = status, delay, label
    server.requests, server.stream_release = [], threading.Event()
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
    thread.start()
    stack.callback(thread.join)
    stack.callback(server.shutdown)
    return server, server.server_port


def request_to(port, hostname, path="/", headers=None):
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        connection.request("GET", path, headers={"Host": hostname, **(headers or {})})
        with connection.getresponse() as response:
            return response.status, response.read()
    finally:
        connection.close()


def rss_kib(pid):
    for line in Path(f"/proc/{pid}/status").read_text().splitlines():
        if line.startswith("VmRSS:"):
            return int(line.split()[1])
    raise RuntimeError("Host RSS is unavailable")


def assert_streams(port, hostname, backend):
    with socket.create_connection(("127.0.0.1", port), timeout=3) as websocket:
        key = base64.b64encode(os.urandom(16)).decode()
        websocket.sendall((
            f"GET /ws HTTP/1.1\r\nHost: {hostname}\r\nUpgrade: websocket\r\n"
            f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
        ).encode())
        with websocket.makefile("rb") as response:
            assert b" 101 " in response.readline()
            headers = {}
            for line in iter(response.readline, b"\r\n"):
                assert line
                name, value = line.split(b":", 1)
                headers[name.lower()] = value.strip()
            expected = hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()
            assert headers[b"sec-websocket-accept"] == base64.b64encode(expected)
            assert response.read(7) == b"\x81\x05hello"
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=3)
    try:
        connection.request("GET", "/events", headers={"Host": hostname, "Accept": "text/event-stream"})
        with connection.getresponse() as response:
            assert response.status == 200 and response.getheader("Content-Type") == "text/event-stream"
            assert response.readline() == b"data: first\n" and response.readline() == b"\n"
            backend.stream_release.set()
            assert response.read() == b""
    finally:
        backend.stream_release.set()
        connection.close()


def run(args, work, stack):
    host_port, admin, http_port, https, legacy_port, web_port, spa_port, split_port, downloads_port, later_port = free_ports(10)
    address = f"http://127.0.0.1:{host_port}"
    extension = f"/api/v1/extensions/{PLUGIN}"
    prefix = f"/extensions/{PLUGIN}"
    client = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def request(method, path, value=None, status=200):
        headers = {}
        if isinstance(value, Path):
            value, headers = value.read_bytes(), {"Content-Type": "application/zip"}
        elif value is not None:
            value, headers = json.dumps(value).encode(), {"Content-Type": "application/json"}
        req = urllib.request.Request(address + path, data=value, method=method, headers=headers)
        try:
            response = client.open(req, timeout=35)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            data = response.read()
            assert response.status == status, (path, response.status, data.decode())
            return json.loads(data) if data else None

    def api(method, path, value=None, status=200):
        response = request(method, prefix + "/api" + path, value, status)
        return response["data"] if status == 200 else response["error"]

    backend, backend_port = upstream(stack, status=401, label="web")
    ipv6, ipv6_port = upstream(stack, "::1", status=404, label="api")
    slow, slow_port = upstream(stack, delay=3)
    _, browser_port = upstream(stack, label="browser")
    conf, disabled, sites, tools = (work / path for path in ("conf.d", "conf.d.disabled", "sites", "tools"))
    for directory in (conf, disabled, sites, tools):
        directory.mkdir()
    main = work / "Caddyfile"
    main.write_text(
        "# >>> ext-caddy-manage:global\n{\n"
        f"\tadmin 127.0.0.1:{admin}\n\thttp_port {http_port}\n\thttps_port {https}\n"
        "\tskip_install_trust\n}\n# <<< ext-caddy-manage:global\nimport conf.d/*.caddy\n"
    )
    # Delegate to real ss. Hide process ownership for one socket, count scans,
    # and simulate a host without the discovery tool without touching host PATH.
    scan_log, no_ss = work / "scans", work / "no-ss"
    ss = tools / "ss"
    real_ss = shutil.which("ss")
    assert real_ss, "iproute2 ss is required for real discovery acceptance"
    ss.write_text(
        "#!/usr/bin/env python3\n"
        "import pathlib, re, subprocess, sys\n"
        f"with open({str(scan_log)!r}, 'a') as log: log.write('scan\\n')\n"
        f"if pathlib.Path({str(no_ss)!r}).exists(): sys.exit(127)\n"
        f"result = subprocess.run([{real_ss!r}, *sys.argv[1:]], stdout=subprocess.PIPE, text=True)\n"
        "for line in result.stdout.splitlines():\n"
        f"    if line.split()[3].endswith(':{ipv6_port}'): line = re.sub(r'users:[^\\s]+', '', line)\n"
        "    print(line)\n"
        "sys.exit(result.returncode)\n"
    )
    ss.chmod(0o755)
    env = {
        **os.environ, "XDG_DATA_HOME": str(work / "caddy-data"),
        "XDG_CONFIG_HOME": str(work / "caddy-config"),
        "PATH": str(tools) + os.pathsep + os.environ["PATH"],
    }

    def start_caddy():
        child = process(stack, [args.caddy, "run", "--config", main, "--adapter", "caddyfile"], work / "caddy.log", env=env)
        wait_health(lambda: client.open(f"http://127.0.0.1:{admin}/config/", timeout=2).close())
        return child

    caddy = start_caddy()
    host = process(stack, [args.host, "serve", "--listen", f"127.0.0.1:{host_port}", "--data-dir", work / "host"], work / "host.log", env=env)
    wait_health(lambda: request("GET", "/api/v1/extensions"))
    config = dict(caddyBinary=args.caddy, mainConfig=str(main), snippetDir=str(conf), sitesRoot=str(sites),
                  logLines=231, certProbeHours=17, backupKeep=23)

    def install(package, version):
        assert request("POST", "/api/v1/extensions", package, 201)["version"] == version
        request("PUT", extension + "/config", config)
        request("POST", extension + "/enable")

    def model(name, port, kind="proxy", scope="local", **values):
        return dict(name=name, domains=[name + ".test"], type=kind,
                    access=dict(protocol="http", scope=scope, port=port), **values)

    def publish(value, selected=None, status=200, confirm=False):
        return api("POST", "/site", dict(model=value, publish=dict(candidateId=selected, confirmAll=confirm)), status)

    def check(site):
        return api("GET", f"/site/entry-check?slug={site['slug']}&get=1")

    def listeners():
        result = api("GET", "/local-listeners")
        assert result["available"], result
        return {entry["port"]: entry for entry in result["candidates"]}

    install(args.previous_zip, "0.2.0")
    legacy_model = model("legacy", legacy_port, "static", static={"root": str(sites), "spa": True})
    legacy = api("POST", "/site", {"model": legacy_model})
    legacy = api("POST", "/site/update", {"slug": legacy["slug"], "baseline": legacy["raw"],
                                         "model": dict(legacy["model"], note="upgrade baseline")})
    backup = legacy["backups"][0]["name"]
    request("DELETE", extension, status=204)
    install(args.current_zip, "0.3.0")
    stored = api("GET", "/site?slug=" + legacy["slug"])
    assert stored["raw"] == legacy["raw"] and stored["formMatchesFile"]
    assert api("GET", "/backup?name=" + backup)["content"]
    assert api("GET", "/health")["sitesRoot"] == str(sites)
    assert not scan_log.exists(), "discovery ran without an operator action"

    print("验证按需 IPv4 / IPv6 发现、进程未知、管理入口、HTTP 401/404 和有界探测", flush=True)
    before_rss, before_scan = rss_kib(host.pid), time.monotonic()
    found = listeners()
    scan_ms = (time.monotonic() - before_scan) * 1000
    assert len(scan_log.read_text().splitlines()) == 1 and backend.requests == ipv6.requests == slow.requests == []
    assert admin not in found and host_port not in found and legacy_port not in found
    assert found[backend_port]["process"] and "process" not in found[ipv6_port]
    for port, expected, code in ((backend_port, "restricted", 401), (ipv6_port, "responded", 404), (slow_port, "timeout", None)):
        before = time.monotonic()
        result = api("POST", "/local-listeners/probe", {"candidateId": found[port]["id"]})
        assert result["status"] == expected and result.get("httpStatus") == code, result
        assert time.monotonic() - before < 4
    print(f"发现 API {scan_ms:.0f} ms，Host RSS {before_rss} → {rss_kib(host.pid)} KiB", flush=True)
    api("POST", "/local-listeners/probe", {"candidateId": f"127.0.0.1:{admin}"}, 409)

    with socket.socket() as replaced:
        replaced.bind(("127.0.0.1", 0))
        replaced.listen()
        port = replaced.getsockname()[1]
        stale = listeners()[port]
    with socket.socket() as replacement:
        replacement.bind(("127.0.0.1", port))
        replacement.listen()
        value = model("stale", web_port, proxy={"upstreams": [stale["upstream"]]})
        assert publish(value, stale["id"], 409)["details"]["field"] == "candidateId"
    value = model("web", web_port, proxy={"upstreams": [found[backend_port]["upstream"]]})
    assert publish(dict(value, access=dict(value["access"], port=backend_port)), found[backend_port]["id"], 400)["details"]["field"] == "proxy.upstreams"
    for port in (admin, host_port):
        invalid = dict(value, proxy={"upstreams": [f"127.0.0.1:{port}"]})
        assert publish(invalid, status=400)["details"]["field"] == "proxy.upstreams"
    open_access = dict(value, access=dict(value["access"], scope="all"))
    assert publish(open_access, found[backend_port]["id"], 400)["details"]["field"] == "confirmAll"
    assert not (conf / "web.caddy").exists()

    print("验证普通 Web、WebSocket、SSE、SPA、SPA + API 和文件下载", flush=True)
    web = publish(open_access, found[backend_port]["id"], confirm=True)
    assert web["apply"]["reloaded"] and check(web)["httpStatus"] == 401
    assert_streams(web_port, "web.test", backend)
    static = sites / "front"
    static.mkdir()
    (static / "index.html").write_text("SPA")
    (sites / "file.bin").write_bytes(b"\x00\x01download\xff")
    no_ss.touch()
    assert api("GET", "/local-listeners")["available"] is False
    manual = publish(model("manual", later_port, proxy={"upstreams": [f"[::1]:{ipv6_port}"]}))
    assert manual["apply"]["reloaded"] and check(manual)["httpStatus"] == 404
    no_ss.unlink()
    spa = publish(model("spa", spa_port, "static", static={"root": str(static), "spa": True}))
    assert check(spa)["httpStatus"] == 200 and request_to(spa_port, "spa.test", "/route") == (200, b"SPA")
    split = publish(model("split", split_port, routing={
        "rules": [{"match": "prefix", "path": "/api", "action": "strip",
                   "proxy": {"upstreams": [found[ipv6_port]["upstream"]]}}],
        "fallback": {"type": "static", "static": {"root": str(static), "spa": True}},
    }), found[ipv6_port]["id"])
    assert split["apply"]["reloaded"]
    assert request_to(split_port, "split.test", "/api/users?keep=1") == (200, b"api /users?keep=1")
    assert request_to(split_port, "split.test", "/api2") == (200, b"SPA")
    downloads = publish(model("download", downloads_port, "static", static={"root": str(sites), "browse": True}))
    assert check(downloads)["httpStatus"] == 200
    assert b"file.bin" in request_to(downloads_port, "download.test")[1]
    assert request_to(downloads_port, "download.test", "/file.bin") == (200, b"\x00\x01download\xff")

    print("验证加载失败回滚、上游不可用、Caddy 停止与加载重试", flush=True)
    with socket.socket() as blocker:
        blocker.bind(("127.0.0.1", 0))
        blocker.listen()
        failed = publish(model("blocked", blocker.getsockname()[1], "static", static={"root": str(sites)}), status=503)
    assert failed["code"] == "reload_failed" and failed["details"]["rollback"]["ok"]
    assert failed["details"]["publication"] == {"saved": "no", "loaded": "no"}
    assert not (conf / "blocked.caddy").exists() and check(downloads)["httpStatus"] == 200
    bad_port, offline_port = free_ports(2)
    bad = publish(model("upstream-down", offline_port, proxy={"upstreams": [f"127.0.0.1:{bad_port}"]}))
    assert bad["apply"]["reloaded"] and check(bad)["httpStatus"] == 502
    caddy.terminate()
    caddy.wait(10)
    pending = publish(model("stopped", free_ports(1)[0], "static", static={"root": str(sites), "browse": True}))
    assert pending["apply"]["savedOnly"] and not pending["apply"]["reloaded"]
    assert "httpStatus" not in check(pending)
    start_caddy()
    assert api("POST", "/service/reload", {})["reload"]["ok"] and check(pending)["httpStatus"] == 200

    print(f"PASS V0.3 standalone ZIP acceptance. Browser URL {address}{prefix}/web/#/sites/new", flush=True)
    if args.serve:
        print(f"Browser upstream 127.0.0.1:{browser_port}; fixture root {sites}", flush=True)
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
    with tempfile.TemporaryDirectory(prefix="ecm-v03-accept-") as directory, contextlib.ExitStack() as stack:
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
