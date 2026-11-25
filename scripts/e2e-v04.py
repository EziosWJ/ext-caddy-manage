#!/usr/bin/env python3
"""V0.4 ZIP acceptance on standalone Extension Host and stock Caddy."""

import argparse
import contextlib
import http.server
import json
import os
from pathlib import Path
import runpy
import socket
import tempfile
import threading
import time
import urllib.error
import urllib.request

HARNESS = runpy.run_path(str(Path(__file__).with_name("e2e-v02.py")))
PLUGIN = HARNESS["PLUGIN"]
free_ports, process, wait_health = (HARNESS[name] for name in ("free_ports", "process", "wait_health"))


def rss(pid):
    for line in Path(f"/proc/{pid}/status").read_text().splitlines():
        if line.startswith("VmRSS:"):
            return int(line.split()[1])


class Upstream(http.server.BaseHTTPRequestHandler):
    def do_HEAD(self):
        if self.server.delay:
            time.sleep(self.server.delay)
        self.send_response(self.server.status)
        self.end_headers()

    def do_GET(self):
        self.do_HEAD()
        self.wfile.write(b"x" * self.server.size)

    def log_message(self, *_):
        pass


def backend(stack, status=200, delay=0, size=0):
    server = stack.enter_context(http.server.ThreadingHTTPServer(("127.0.0.1", 0), Upstream))
    server.status, server.delay, server.size = status, delay, size
    threading.Thread(target=server.serve_forever, daemon=True).start()
    stack.callback(server.shutdown)
    return server.server_port


def run(args, work, stack):
    host_port, admin, old_port, proxy_port, tls_port, dns_port, slow_site, pending_port, disabled_admin, split_port = free_ports(10)
    host_url = f"http://127.0.0.1:{host_port}"
    extension = f"/api/v1/extensions/{PLUGIN}"
    prefix = f"/extensions/{PLUGIN}"
    client = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def request(method, path, value=None, status=200):
        headers = {}
        if isinstance(value, Path):
            value, headers = value.read_bytes(), {"Content-Type": "application/zip"}
        elif value is not None:
            value, headers = json.dumps(value).encode(), {"Content-Type": "application/json"}
        req = urllib.request.Request(host_url + path, data=value, method=method, headers=headers)
        try:
            response = client.open(req, timeout=28)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            data = response.read()
            assert response.status == status, (path, response.status, data.decode())
            return json.loads(data) if data else None

    def api(method, path, value=None, status=200):
        result = request(method, prefix + "/api" + path, value, status)
        return result["data"] if status == 200 else result["error"]

    def get(path):
        return api("GET", path)

    def post(path, value=None, status=200):
        return api("POST", path, value or {}, status)

    conf, sites, programs = (work / name for name in ("conf.d", "sites", "programs"))
    for directory in (conf, sites, programs):
        directory.mkdir()
    (sites / "index.html").write_text("V0.4")
    main = work / "Caddyfile"
    base = (
        "# >>> ext-caddy-manage:global\n{\n"
        f"\tadmin 127.0.0.1:{admin}\n\thttp_port {old_port}\n"
        "\tskip_install_trust\n\tmetrics\n"
        "}\n# <<< ext-caddy-manage:global\nimport conf.d/*.caddy\n"
    )
    main.write_text(base)

    # Detached Caddy writes real JSON to stderr. Replay its lines in a
    # controlled short-iso journal, with deterministic retention/errors.
    fixture, mode, reads = work / "journal", work / "journal-mode", work / "journal-reads"
    fixture.write_text("")
    command = programs / "journalctl"
    command.write_text(
        "#!/usr/bin/env python3\n"
        "from pathlib import Path\nimport sys\n"
        f"root = Path({str(work)!r})\n"
        "with (root / 'journal-reads').open('a') as out: out.write('1\\n')\n"
        "mode = (root / 'journal-mode').read_text() if (root / 'journal-mode').exists() else ''\n"
        "if mode == 'permission': print('Insufficient permissions', file=sys.stderr); sys.exit(1)\n"
        "limit = next(int(arg.split('=')[1]) for arg in sys.argv if arg.startswith('--lines='))\n"
        "print('\\n'.join((root / 'journal').read_text().splitlines()[::-1][:limit]))\n"
    )
    command.chmod(0o755)
    env = dict(os.environ, PATH=str(programs) + os.pathsep + os.environ["PATH"],
               XDG_DATA_HOME=str(work / "caddy-data"), XDG_CONFIG_HOME=str(work / "caddy-config"))

    def start_caddy():
        child = process(stack, [args.caddy, "run", "--config", main, "--adapter", "caddyfile"], work / "caddy.log", env=env)
        wait_health(lambda: client.open(f"http://127.0.0.1:{admin}/config/", timeout=2).close())
        return child

    def hit(port):
        try:
            return client.open(f"http://127.0.0.1:{port}/", timeout=4).read()
        except urllib.error.HTTPError as error:
            with error:
                return error.code

    caddy = start_caddy()
    host = process(stack, [args.host, "serve", "--listen", f"127.0.0.1:{host_port}", "--data-dir", work / "host"], work / "host.log", env=env)
    wait_health(lambda: request("GET", "/api/v1/extensions"))
    config = dict(caddyBinary=args.caddy, mainConfig=str(main), snippetDir=str(conf), sitesRoot=str(sites),
                  logLines=231, certProbeHours=17, backupKeep=23)

    def install(package, version):
        assert request("POST", "/api/v1/extensions", package, 201)["version"] == version
        request("PUT", extension + "/config", config)
        request("POST", extension + "/enable")

    def publish(name, port, host_name="127.0.0.1", protocol="http", upstream=None):
        model = dict(name=name, domains=[host_name], access=dict(protocol=protocol, scope="local", port=port))
        if upstream:
            model.update(type="proxy", proxy={"upstreams": [f"127.0.0.1:{upstream}"]})
        else:
            model.update(type="static", static=dict(root=str(sites)))
        return post("/site", {"model": model})

    def check(site, failure=None):
        result = post("/site/check", {"slug": site["slug"]})
        assert result.get("firstFailure") == failure, result
        assert [step["id"] for step in result["steps"]] == ["dns", "listen", "tls", "upstream", "http", "config"]
        return result

    install(args.previous_zip, "0.3.0")
    old = post("/site", {"model": dict(name="Legacy", domains=["localhost"], https=False,
                                      type="static", static=dict(root=str(sites)))})
    old = post("/site/update", {"slug": old["slug"], "baseline": old["raw"], "model": dict(old["model"], note="baseline")})
    backup = old["backups"][0]["name"]
    request("DELETE", extension, status=204)
    install(args.current_zip, "0.4.0")
    assert get("/site?slug=" + old["slug"])["raw"] == old["raw"]
    assert get("/backup?name=" + backup)["content"]
    assert get("/health")["logLines"] == 231
    assert get("/metrics") == {"status": "uncollected"}
    wait_health(lambda: check(old)["target"] == f"127.0.0.1:{old_port}")
    proxy = publish("Proxy", proxy_port, upstream=backend(stack, status=503))
    tls = publish("Internal TLS", tls_port, "::1", "internal")
    dns = publish("Unresolved", dns_port, "ecm-unknown.invalid")
    slow = publish("Slow upstream", slow_site, "127.0.0.2", upstream=backend(stack, delay=3))
    assert hit(proxy_port) == 503

    before_rss = (rss(host.pid), rss(caddy.pid))
    started = time.monotonic()
    snap = post("/metrics")
    manual_ms = (time.monotonic() - started) * 1000
    manual_rss = (rss(host.pid), rss(caddy.pid))
    assert snap["status"] == "ok" and snap["runtime"]["rssBytes"] > 0, snap
    assert any(row.get("http5xx", 0) > 0 and row.get("requests", 0) > 0
               and row["meanMs"] >= 0 and row.get("errors", 0) == 0 for row in snap["handlers"]), snap
    assert snap["upstreams"] and all(entry["status"] in ("unhealthy", "unverified") for entry in snap["upstreams"])
    assert "requests" not in snap and get("/metrics")["checkedAt"] == post("/metrics")["checkedAt"]
    print(f"手动采集 {manual_ms:.1f} ms，Host / Caddy RSS {before_rss} → {manual_rss} KiB", flush=True)

    print("验证配置、TLS、DNS、上游超时和 HTTP 失败定位", flush=True)
    assert check(proxy, "http")["steps"][1]["status"] == "ok"
    assert check(tls, "tls")["steps"][2]["action"] == "tls"
    check(dns, "dns")
    started = time.monotonic()
    result = check(slow, "upstream")
    assert "响应超时" in result["steps"][3]["message"]
    assert time.monotonic() - started < 15
    route_targets = [backend(stack) for _ in range(4)]
    split = post("/site", {"model": dict(
        name="Split", domains=["127.0.0.4"], type="proxy",
        access=dict(protocol="http", scope="local", port=split_port),
        routing=dict(rules=[dict(match="prefix", path="/api", action="strip",
                                 proxy={"upstreams": [f"127.0.0.1:{port}" for port in route_targets]})],
                     fallback=dict(type="static", static=dict(root=str(sites), spa=True))),
    )})
    routed = check(split)
    assert routed["steps"][3]["status"] == "unknown" and "3 / 4" in routed["steps"][3]["message"]
    assert "HTTP 200" in routed["steps"][4]["message"]
    assert post("/site/check", {"slug": proxy["slug"], "index": 2}, 400)["code"] == "bad_request"

    main.write_text(base + "\ninvalid.caddy.test { no_such_directive }\n")
    try:
        assert check(proxy, "config")["steps"][-1]["action"] == "global"
    finally:
        main.write_text(base)

    print("验证 Journal 窗口、归属、分类筛选与读取上限", flush=True)
    def access(number, host_name, status, seconds, uri, logger="http.log.access"):
        entry = dict(logger=logger, status=status, duration=seconds,
                     request={"host": host_name, "method": "GET", "uri": uri})
        return f"2025-11-25T12:00:{number:02d}+0000 host caddy[1]: " + json.dumps(entry)

    real_entries = [json.loads(line) for line in (work / "caddy.log").read_text().splitlines() if line.startswith("{")]
    assert any(row.get("status") == 503 and row.get("logger") == "http.log.access" for row in real_entries), real_entries[-10:]
    real = next(row for row in real_entries if row.get("status") == 503 and row.get("logger") == "http.log.access")
    assert real["request"]["host"] == f"127.0.0.1:{proxy_port}"
    matching = f"127.0.0.1:{proxy_port}"
    lines = [
        access(1, "localhost", 200, .010, "/other"),
        access(2, matching, 404, .025, "/missing"),
        access(3, matching, 503, .125, "/failed"),
        access(4, f"127.0.0.1:{old_port}", 500, 1, "/foreign"),
        access(5, matching, 500, 1, "/named", "http.log.access.another"),
        access(6, matching, 200, .150, "/ok"),
        access(7, f"localhost:{old_port}", 200, .010, "/legacy"),
        access(8, f"localhost:{proxy_port}", 200, .010, "/foreign-legacy"),
    ]
    fixture.write_text("\n".join(lines) + "\n")
    logs_url = f"/logs/site?slug={proxy['slug']}&lines=100"
    data = get(logs_url)
    summary = data["summary"]
    assert summary["coverage"] == "window" and summary["journalLines"] == 8, data
    assert summary["start"].endswith("01+0000") and summary["finish"].endswith("08+0000")
    assert (summary["requests"], summary["clientErrors"], summary["serverErrors"], summary["durationSamples"]) == (3, 1, 1, 3)
    assert abs(summary["meanMs"] - 100) < 0.001, summary
    for category, uri in ((4, "/missing"), (5, "/failed")):
        filtered = get(logs_url + f"&statusClass={category}")
        assert filtered["summary"] == summary and [row["uri"] for row in filtered["entries"]] == [uri]
    assert not get(logs_url + "&status=503&q=missing")["entries"]
    legacy_logs = get(f"/logs/site?slug={old['slug']}&lines=100")
    assert [row["uri"] for row in legacy_logs["entries"]] == ["/other", "/legacy"]
    assert len(reads.read_text().splitlines()) == 1
    fixture.write_text("\n".join([lines[1]] * 100) + "\n")
    assert get(logs_url.replace("100", "101"))["summary"]["journalLines"] == 100
    limited = get(logs_url.replace("100", "102") + "&status=404")
    assert len(limited["entries"]) == 100
    assert get(logs_url)["summary"]["coverage"] == "line_limit"
    fixture.write_text("\n".join([access(1, matching, 200, .001, "/" + "x" * 1800)] * 200) + "\n")
    truncated = get(logs_url.replace("100", "200"))["summary"]
    assert truncated["coverage"] == "truncated" and 0 < truncated["requests"] < 200, truncated
    fixture.write_text("")
    assert get(logs_url.replace("100", "201"))["summary"]["coverage"] == "empty"
    mode.write_text("permission")
    assert get(logs_url.replace("100", "202"))["summary"]["coverage"] == "restricted"
    mode.unlink()
    raw = conf / "custom-log.caddy"
    raw.write_text("http://custom.test {\n log {\n output discard\n }\n}\n")
    assert get("/logs/site?slug=custom-log")["summary"]["coverage"] == "unsupported"

    print("验证 Admin 关闭、指标体积上限、停止、端口冲突和重载回滚", flush=True)
    large_port = backend(stack, size=70000)
    for port, expected in (("off", "unavailable"), (f"127.0.0.1:{large_port}", "truncated"),
                           (f"127.0.0.1:{disabled_admin}", "unreachable")):
        main.write_text(base.replace(f"127.0.0.1:{admin}", port))
        assert post("/metrics")["status"] == expected
    main.write_text(base)
    caddy.terminate()
    caddy.wait(10)
    pending = publish("Pending", pending_port, "127.0.0.3")
    # Use a missing listener for the first assertion, then bind the same port.
    assert pending["apply"]["savedOnly"]
    check(pending, "listen")
    with socket.socket() as blocker:
        blocker.bind(("127.0.0.1", pending_port))
        blocker.listen()
        check(pending, "listen")
        assert any("其他进程" in step["message"] for step in check(pending, "listen")["steps"])
    caddy = start_caddy()
    with socket.socket() as blocker:
        blocker.bind(("127.0.0.1", 0))
        blocker.listen()
        model = dict(name="Conflict", domains=["conflict.invalid"], type="static",
                     static=dict(root=str(sites)), access=dict(protocol="http", scope="local", port=blocker.getsockname()[1]))
        failure = post("/site", {"model": model}, 503)
        assert failure["details"]["rollback"]["ok"]
    assert hit(proxy_port) == 503
    # Restart the isolated instance to give the browser a populated histogram
    # even when failed Caddy provisioning removed the metric series.
    caddy.terminate()
    caddy.wait(10)
    caddy = start_caddy()
    assert hit(proxy_port) == 503
    after_rollback = post("/metrics")
    assert after_rollback["status"] == "ok" and after_rollback["handlers"], after_rollback

    fixture.write_text("\n".join(lines) + "\n")
    print(f"PASS V0.4 functional ZIP acceptance. Browser URL {host_url}{prefix}/web/", flush=True)
    print(f"Browser sites: proxy={proxy['slug']}, TLS={tls['slug']}", flush=True)
    if args.resources:
        print("验证 90 秒过期与 60 秒周期采集", flush=True)
        for _ in range(48):
            if get("/metrics")["status"] == "expired":
                break
            time.sleep(2)
        else:
            raise AssertionError("snapshot remained fresh")
        request("PUT", extension + "/config", {"metricsPeriodic": True})
        before = get("/metrics")
        assert before["periodSeconds"] == 60 and before["status"] == "expired", before
        memory_start = (rss(host.pid), rss(caddy.pid))
        started = time.monotonic()
        times = []
        while time.monotonic() - started < 72:
            tick = time.monotonic()
            get("/overview")
            current = get("/metrics")
            times.append((time.monotonic() - tick) * 1000)
            if current["status"] == "ok" and current["checkedAt"] != before["checkedAt"]:
                break
            time.sleep(1)
        else:
            raise AssertionError("periodic collection did not refresh the expired snapshot")
        assert 55 <= time.monotonic() - started < 72
        assert get("/metrics")["periodSeconds"] == 60
        memory_end = (rss(host.pid), rss(caddy.pid))
        print(f"周期采集 {time.monotonic() - started:.1f} s，概览和快照 API 合计中位 {sorted(times)[len(times) // 2]:.1f} ms、峰值 {max(times):.1f} ms，"
              f"Host / Caddy RSS {memory_start} → {memory_end} KiB", flush=True)
        request("PUT", extension + "/config", {"metricsPeriodic": False})
        assert "periodSeconds" not in get("/metrics")
    if args.serve:
        while True:
            time.sleep(1)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--caddy", required=True)
    parser.add_argument("--host", default="ext")
    parser.add_argument("--previous-zip", type=Path, required=True)
    parser.add_argument("--current-zip", type=Path, required=True)
    parser.add_argument("--resources", action="store_true", help="measure real expiry and 60-second collection")
    parser.add_argument("--serve", action="store_true", help="leave the fixture available for browser checks")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="ecm-v04-accept-") as directory, contextlib.ExitStack() as stack:
        work = Path(directory)
        try:
            run(args, work, stack)
        except KeyboardInterrupt:
            pass
        except Exception:
            for name in ("caddy.log", "host.log"):
                if (work / name).exists():
                    print(f"--- {name} ---\n{(work / name).read_text()[-4000:]}", flush=True)
            raise


if __name__ == "__main__":
    main()
