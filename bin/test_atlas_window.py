r"""Tests for atlas_window.py. Run from the atlas folder:

    /usr/bin/python3 -I bin/test_atlas_window.py -v          (macOS)
    python -I bin\test_atlas_window.py -v                    (Windows)

Each test starts the real server on a loopback port the system picks, with ATLAS_WINDOW_NO_OPEN=1, so no
browser is ever opened, and talks to it over plain sockets (http.client), so every header is the test's
own. The page folder is a fixture in a temporary folder.
"""

import http.client
import importlib.util
import json
import os
import queue
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
HELPER = os.path.join(HERE, "atlas_window.py")

sys.dont_write_bytecode = True  # importing the helper below must not leave a __pycache__ folder in bin/
_spec = importlib.util.spec_from_file_location("atlas_window_under_test", HELPER)
helper = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(helper)

TOKEN = "mod-token-0123456789abcdef-ABCDEF"
PAGE = b"<!doctype html><title>page</title>"
SCRIPT = b"// the page's script\n"
JSON = {"Content-Type": "application/json"}


class Running(object):
    """The helper as a child process, its standard output read line by line."""

    def __init__(self, web, args=(), token=TOKEN, env=None):
        full_env = dict(os.environ, ATLAS_WINDOW_NO_OPEN="1")
        full_env.update(env or {})
        self.proc = subprocess.Popen(
            [sys.executable, "-I", HELPER, "--web", web] + list(args),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=full_env,
        )
        self.lines = queue.Queue()
        threading.Thread(target=self._read, daemon=True).start()
        if token is not None:
            self.proc.stdin.write((token + "\n").encode("ascii"))
        # the mod's spawn closes standard input once the token is written: so does the test
        self.proc.stdin.close()
        self.port = 0

    def _read(self):
        for raw in self.proc.stdout:
            self.lines.put(json.loads(raw.decode("ascii")))
        self.lines.put(None)

    def line(self, timeout=10.0):
        """The next line that is not a tick; None when the helper ended."""
        deadline = time.monotonic() + timeout
        while True:
            doc = self.lines.get(timeout=max(0.05, deadline - time.monotonic()))
            if doc is None or "tick" not in doc:
                return doc

    def until(self, key, timeout=10.0):
        """The next line holding `key`, skipping the others."""
        deadline = time.monotonic() + timeout
        while True:
            doc = self.line(max(0.05, deadline - time.monotonic()))
            if doc is None or key in doc:
                return doc

    def ready(self):
        doc = self.line()
        if doc and doc.get("ready"):
            self.port = doc["port"]
        return doc

    def stop(self):
        if self.proc.poll() is None:
            self.proc.kill()
        self.proc.wait(10)
        for stream in (self.proc.stdout, self.proc.stderr):
            stream.close()


class ServerCase(unittest.TestCase):
    extra_args = ("--no-open",)

    def setUp(self):
        self.web = tempfile.mkdtemp(prefix="atlas-window-web-")
        self.addCleanup(shutil.rmtree, self.web, True)
        with open(os.path.join(self.web, "window.html"), "wb") as f:
            f.write(PAGE)
        with open(os.path.join(self.web, "window.js"), "wb") as f:
            f.write(SCRIPT)
        with open(os.path.join(self.web, "window.css"), "wb") as f:
            f.write(b"body{}\n")
        with open(os.path.join(self.web, "notes.txt"), "wb") as f:
            f.write(b"not a kind of file the page has\n")
        with open(os.path.join(self.web, ".hidden.js"), "wb") as f:
            f.write(b"// a dot file\n")
        os.mkdir(os.path.join(self.web, "sub"))
        with open(os.path.join(self.web, "sub", "inner.js"), "wb") as f:
            f.write(b"// in a folder\n")
        self.outside = tempfile.mkdtemp(prefix="atlas-window-outside-")
        self.addCleanup(shutil.rmtree, self.outside, True)
        with open(os.path.join(self.outside, "secret.js"), "wb") as f:
            f.write(b"// outside the page folder\n")
        self.run_ = Running(self.web, self.extra_args)
        self.addCleanup(self.run_.stop)
        ready = self.run_.ready()
        self.assertEqual(ready, {"ready": True, "port": self.run_.port})
        self.assertGreater(self.run_.port, 0)
        self.host = "127.0.0.1:%d" % self.run_.port

    # ---- plumbing ----

    def request(self, method, path, body=None, headers=None, host=None, timeout=10.0):
        """One request on a connection of its own: (status, headers, body)."""
        conn = http.client.HTTPConnection("127.0.0.1", self.run_.port, timeout=timeout)
        try:
            conn.putrequest(method, path, skip_host=True, skip_accept_encoding=True)
            if host is not False:
                conn.putheader("Host", self.host if host is None else host)
            data = None
            if body is not None:
                data = body if isinstance(body, bytes) else json.dumps(body).encode("utf-8")
                conn.putheader("Content-Length", str(len(data)))
            for name, value in (headers or {}).items():
                conn.putheader(name, value)
            try:
                conn.endheaders(data)
            except (BrokenPipeError, ConnectionResetError):
                pass  # refused before the whole body was sent: the answer is still there to read
            res = conn.getresponse()
            return res.status, dict((k.lower(), v) for k, v in res.getheaders()), res.read()
        finally:
            conn.close()

    def mod(self, method, path, body=None, headers=None):
        h = {"X-Atlas-Token": TOKEN}
        if body is not None:
            h.update(JSON)
        h.update(headers or {})
        return self.request(method, path, body, h)

    def ticket(self):
        """Asks for a window: the ticket of the address the helper would have opened."""
        status, _, body = self.mod("POST", "/open", {})
        self.assertEqual(status, 200)
        answer = json.loads(body)
        self.assertEqual((answer["opened"], answer["how"]), (False, "suppressed"))
        # the address comes back to the mod, on a ticket of its own, so a person can open it by hand
        self.assertRegex(answer["url"], r"^http://127\.0\.0\.1:%d/\?t=[A-Za-z0-9_-]{20,}$" % self.run_.port)
        said = self.run_.until("window")
        self.assertEqual(said["window"], "suppressed")
        prefix = "http://127.0.0.1:%d/?t=" % self.run_.port
        self.assertTrue(said["url"].startswith(prefix), said["url"])
        return said["url"][len(prefix):]

    def enter(self):
        """A page's token, as the page gets it."""
        status, _, body = self.request("POST", "/enter", {"ticket": self.ticket()}, JSON)
        self.assertEqual(status, 200)
        return json.loads(body)["token"]

    def page(self, method, path, token, body=None, headers=None, timeout=10.0):
        h = {"X-Atlas-Token": token}
        if body is not None:
            h.update(JSON)
        h.update(headers or {})
        return self.request(method, path, body, h, timeout=timeout)


class TokenTests(ServerCase):
    def test_the_page_needs_a_good_ticket(self):
        self.assertEqual(self.request("GET", "/")[0], 403)
        self.assertEqual(self.request("GET", "/?t=")[0], 403)
        self.assertEqual(self.request("GET", "/?t=nonsense")[0], 403)
        # the mod's own token is no ticket
        self.assertEqual(self.request("GET", "/?t=" + TOKEN)[0], 403)
        ticket = self.ticket()
        status, headers, body = self.request("GET", "/?t=" + ticket)
        self.assertEqual((status, body), (200, PAGE))
        self.assertEqual(headers["content-type"], "text/html; charset=utf-8")

    def test_a_ticket_buys_one_page_token(self):
        ticket = self.ticket()
        status, _, body = self.request("POST", "/enter", {"ticket": ticket}, JSON)
        self.assertEqual(status, 200)
        token = json.loads(body)["token"]
        self.assertNotEqual(token, TOKEN)
        self.assertNotEqual(token, ticket)
        # spent: no second token, and the address no longer serves the page
        self.assertEqual(self.request("POST", "/enter", {"ticket": ticket}, JSON)[0], 403)
        self.assertEqual(self.request("GET", "/?t=" + ticket)[0], 403)
        for bad in ({"ticket": ""}, {"ticket": 5}, {"ticket": TOKEN}, {}):
            self.assertEqual(self.request("POST", "/enter", bad, JSON)[0], 403, bad)

    def test_a_ticket_runs_out(self):
        ticket = self.ticket()
        state_seconds = helper.TICKET_SECONDS
        self.assertGreater(state_seconds, 30)
        # the same rule on a state of the test's own, with the clock moved on
        state = helper.State(helper.Out(None), TOKEN)
        mine = state.new_ticket()
        self.assertTrue(state.ticket_good(mine))
        state.tickets[mine] = time.monotonic() - 1
        self.assertFalse(state.ticket_good(mine))
        self.assertIsNone(state.enter(mine))
        # and the live one is still good
        self.assertEqual(self.request("GET", "/?t=" + ticket)[0], 200)

    def test_each_endpoint_takes_only_its_own_token(self):
        page = self.enter()
        # no token, a wrong one, and the other kind of token
        for token in (None, "wrong", page):
            headers = {} if token is None else {"X-Atlas-Token": token}
            self.assertEqual(self.request("POST", "/push", {"tree": 1}, dict(JSON, **headers))[0], 403, token)
            self.assertEqual(self.request("POST", "/open", {}, dict(JSON, **headers))[0], 403, token)
            self.assertEqual(self.request("GET", "/status", None, headers)[0], 403, token)
        for token in (None, "wrong", TOKEN):
            headers = {} if token is None else {"X-Atlas-Token": token}
            self.assertEqual(self.request("GET", "/state?v=0", None, headers)[0], 403, token)
            self.assertEqual(self.request("POST", "/act", {"kind": "press", "key": "k"}, dict(JSON, **headers))[0], 403, token)
        # a token in the address is not a token
        self.assertEqual(self.request("GET", "/status?t=" + TOKEN)[0], 403)
        self.assertEqual(self.request("GET", "/state?v=0&t=" + page)[0], 403)
        # the right ones pass
        self.assertEqual(self.mod("GET", "/status")[0], 200)
        self.assertEqual(self.page("POST", "/act", page, {"kind": "press", "key": "k"})[0], 204)

    def test_a_refusal_says_nothing(self):
        for status, headers, body in (
            self.request("GET", "/"),
            self.request("GET", "/status"),
            self.request("GET", "/no-such-file.js"),
            self.request("POST", "/push", {"tree": 1}, JSON),
        ):
            self.assertIn(status, (403, 404))
            self.assertEqual(body, b"")
            self.assertEqual(headers["content-length"], "0")
            self.assertEqual(headers["server"], "atlas")

    def test_without_a_token_on_standard_input_it_does_not_start(self):
        for token in (None, "short", "has spaces in it, so it is no token"):
            run = Running(self.web, ("--no-open",), token=token)
            try:
                said = run.line()
                self.assertEqual(said["ready"], False)
                self.assertIn("token", said["error"])
                self.assertEqual(run.proc.wait(10), 2)
            finally:
                run.stop()

    def test_a_page_folder_without_the_page_does_not_start(self):
        empty = tempfile.mkdtemp(prefix="atlas-window-empty-")
        self.addCleanup(shutil.rmtree, empty, True)
        run = Running(empty, ("--no-open",))
        try:
            said = run.line()
            self.assertEqual(said["ready"], False)
            self.assertIn("window.html", said["error"])
            self.assertEqual(run.proc.wait(10), 2)
        finally:
            run.stop()


class HostAndOriginTests(ServerCase):
    def test_host_must_be_this_server(self):
        port = self.run_.port
        ticket = self.ticket()
        for host in ("127.0.0.1:%d" % port, "localhost:%d" % port, "LOCALHOST:%d" % port):
            self.assertEqual(self.request("GET", "/window.js", host=host)[0], 200, host)
            self.assertEqual(self.request("GET", "/?t=" + ticket, host=host)[0], 200, host)
        for host in (
            "127.0.0.1",
            "localhost",
            "127.0.0.1:%d" % (port + 1),
            "example.com",
            "example.com:%d" % port,
            "127.0.0.1.example.com:%d" % port,
            "[::1]:%d" % port,
            "",
            False,
        ):
            self.assertEqual(self.request("GET", "/window.js", host=host)[0], 403, host)
            self.assertEqual(self.request("GET", "/?t=" + ticket, host=host)[0], 403, host)
            self.assertEqual(self.request("GET", "/status", None, {"X-Atlas-Token": TOKEN}, host=host)[0], 403, host)
            self.assertEqual(self.request("POST", "/push", {"tree": 1}, dict(JSON, **{"X-Atlas-Token": TOKEN}), host=host)[0], 403, host)

    def test_two_host_headers_are_refused(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.run_.port, timeout=10)
        try:
            conn.putrequest("GET", "/window.js", skip_host=True)
            conn.putheader("Host", self.host)
            conn.putheader("Host", "example.com")
            conn.endheaders()
            self.assertEqual(conn.getresponse().status, 403)
        finally:
            conn.close()

    def test_a_post_from_another_origin_is_refused(self):
        page = self.enter()
        own = "http://127.0.0.1:%d" % self.run_.port
        act = {"kind": "press", "key": "k"}
        self.assertEqual(self.page("POST", "/act", page, act, {"Origin": own})[0], 204)
        self.assertEqual(self.page("POST", "/act", page, act, {"Origin": "http://localhost:%d" % self.run_.port})[0], 204)
        for origin in ("https://example.com", "http://127.0.0.1:%d" % (self.run_.port + 1), "http://127.0.0.1", "null", own + ".example.com", "https://127.0.0.1:%d" % self.run_.port):
            self.assertEqual(self.page("POST", "/act", page, act, {"Origin": origin})[0], 403, origin)
            self.assertEqual(self.mod("POST", "/push", {"tree": 1}, {"Origin": origin})[0], 403, origin)
            self.assertEqual(self.request("POST", "/enter", {"ticket": "x"}, dict(JSON, Origin=origin))[0], 403, origin)
            # a GET that names another origin is refused too
            self.assertEqual(self.page("GET", "/state?v=-1", page, None, {"Origin": origin})[0], 403, origin)
        # nothing of the refused ones reached standard output
        self.assertEqual(self.run_.until("act"), {"act": act})
        self.assertEqual(self.run_.until("act"), {"act": act})
        self.assertEqual(self.mod("GET", "/status")[0], 200)
        with self.assertRaises(queue.Empty):
            self.run_.until("act", 0.5)

    def test_a_request_a_browser_marks_as_another_sites_is_refused(self):
        page = self.enter()
        ticket = self.ticket()
        for site in ("cross-site", "same-site"):
            marked = {"Sec-Fetch-Site": site}
            self.assertEqual(self.request("GET", "/?t=" + ticket, None, marked)[0], 403, site)
            self.assertEqual(self.request("GET", "/window.js", None, marked)[0], 403, site)
            self.assertEqual(self.page("GET", "/state?v=-1", page, None, marked)[0], 403, site)
            self.assertEqual(self.page("POST", "/act", page, {"kind": "press", "key": "k"}, marked)[0], 403, site)
        for site in ("same-origin", "none"):
            self.assertEqual(self.request("GET", "/?t=" + ticket, None, {"Sec-Fetch-Site": site})[0], 200, site)

    def test_a_post_must_be_json(self):
        page = self.enter()
        raw = json.dumps({"kind": "press", "key": "k"}).encode("utf-8")
        for kind in (None, "text/plain", "application/x-www-form-urlencoded", "multipart/form-data", "application/jsonx"):
            headers = {"X-Atlas-Token": page}
            if kind:
                headers["Content-Type"] = kind
            self.assertEqual(self.request("POST", "/act", raw, headers)[0], 415, kind)
        self.assertEqual(self.request("POST", "/act", raw, {"X-Atlas-Token": page, "Content-Type": "application/json; charset=utf-8"})[0], 204)
        # JSON that is no object, and what is not JSON
        for body in (b"[1]", b'"text"', b"{", b"\xff\xfe"):
            self.assertEqual(self.request("POST", "/act", body, dict(JSON, **{"X-Atlas-Token": page}))[0], 400, body)

    def test_no_cors_headers_and_nothing_cached(self):
        page = self.enter()
        ticket = self.ticket()
        own = "http://127.0.0.1:%d" % self.run_.port
        self.mod("POST", "/push", {"tree": {"type": "Box"}})
        answers = [
            self.request("GET", "/?t=" + ticket),
            self.request("GET", "/window.js"),
            self.request("GET", "/window.css"),
            self.request("GET", "/nothing.js"),
            self.page("GET", "/state?v=0", page, None, {"Origin": own}),
            self.page("POST", "/act", page, {"kind": "press", "key": "k"}, {"Origin": own}),
            self.mod("GET", "/status"),
            self.request("OPTIONS", "/act", None, {"Origin": "https://example.com", "Access-Control-Request-Method": "POST"}),
        ]
        for status, headers, _ in answers:
            self.assertFalse([name for name in headers if name.startswith("access-control-")], headers)
            self.assertEqual(headers["cache-control"], "no-store")
            self.assertEqual(headers["x-content-type-options"], "nosniff")
            self.assertEqual(headers["x-frame-options"], "DENY")
            csp = headers["content-security-policy"]
            self.assertIn("default-src 'none'", csp)
            self.assertIn("script-src 'self'", csp)
            self.assertIn("img-src data:", csp)
            self.assertIn("frame-ancestors 'none'", csp)
            self.assertNotIn("unsafe", csp)
            self.assertNotIn("*", csp)
        self.assertEqual(answers[-1][0], 405)

    def test_other_methods_are_refused(self):
        for method in ("PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"):
            self.assertEqual(self.mod(method, "/push")[0], 405, method)
        self.assertEqual(self.mod("GET", "/push")[0], 405)
        self.assertEqual(self.mod("POST", "/status", {})[0], 405)
        self.assertEqual(self.mod("POST", "/nothing", {})[0], 404)


class StaticTests(ServerCase):
    def test_the_pages_files(self):
        status, headers, body = self.request("GET", "/window.js")
        self.assertEqual((status, body), (200, SCRIPT))
        self.assertEqual(headers["content-type"], "text/javascript; charset=utf-8")
        status, headers, _ = self.request("GET", "/window.css")
        self.assertEqual(status, 200)
        self.assertEqual(headers["content-type"], "text/css; charset=utf-8")
        # the page by its file name, for a reload: it holds no secret
        self.assertEqual(self.request("GET", "/window.html")[0], 200)

    def test_nothing_else_of_the_folder_and_nothing_outside(self):
        if os.name != "nt":
            os.symlink(os.path.join(self.outside, "secret.js"), os.path.join(self.web, "link.js"))
        outside_name = os.path.basename(self.outside)
        for path in (
            "/notes.txt",  # a kind of file the page has none of
            "/.hidden.js",
            "/sub/inner.js",
            "/sub",
            "/sub/",
            "/link.js",  # a link out of the folder
            "/../%s/secret.js" % outside_name,
            "/..%%2f%s%%2fsecret.js" % outside_name,
            "/%%2e%%2e/%s/secret.js" % outside_name,
            "/..\\%s\\secret.js" % outside_name,
            "//etc/passwd",
            "/window.js/",
            "/window.js%00.html",
            "/",
            "/.",
            "/..",
        ):
            status, _, body = self.request("GET", path)
            self.assertIn(status, (403, 404), path)
            self.assertEqual(body, b"", path)

    def test_no_listing(self):
        for path in ("/sub", "/sub/", "/./", "/window.js/.."):
            status, _, body = self.request("GET", path)
            self.assertIn(status, (400, 403, 404), path)
            self.assertEqual(body, b"")


class StateTests(ServerCase):
    extra_args = ("--no-open", "--poll-seconds", "1.2")

    def test_versions_and_what_a_poll_gets(self):
        page = self.enter()
        # nothing pushed yet: the poll waits its time out
        started = time.monotonic()
        status, _, body = self.page("GET", "/state?v=0", page)
        self.assertEqual((status, body), (204, b""))
        self.assertGreater(time.monotonic() - started, 1.0)
        tree = {"type": "Box", "props": {}, "children": ["你好", {"type": "Text", "props": {}, "children": ["x"]}]}
        status, _, body = self.mod("POST", "/push", {"tree": tree, "title": "Atlas · proj"})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["v"], 1)
        status, headers, body = self.page("GET", "/state?v=0", page)
        self.assertEqual(status, 200)
        self.assertEqual(headers["content-type"], "application/json; charset=utf-8")
        got = json.loads(body.decode("utf-8"))
        self.assertEqual(got, {"v": 1, "tv": 1, "title": "Atlas · proj", "focus": None, "toasts": [], "tree": tree})
        # up to date: nothing until something newer
        self.assertEqual(self.page("GET", "/state?v=1&tv=1", page)[0], 204)
        # a toast and a focus without a tree: a new version, the same tree, which is then left out
        self.assertEqual(json.loads(self.mod("POST", "/push", {"toasts": ["已保存"], "focus": "back"})[2])["v"], 2)
        got = json.loads(self.page("GET", "/state?v=1&tv=1", page)[2].decode("utf-8"))
        self.assertEqual(got, {"v": 2, "tv": 1, "title": "Atlas · proj", "focus": {"key": "back", "n": 1}, "toasts": [{"id": 1, "text": "已保存"}]})
        # a page that has no tree yet is given it
        self.assertEqual(json.loads(self.page("GET", "/state?v=1", page)[2].decode("utf-8"))["tree"], tree)
        # the same tree pushed again is no new tree
        self.assertEqual(json.loads(self.mod("POST", "/push", {"tree": tree})[2])["v"], 3)
        self.assertNotIn("tree", json.loads(self.page("GET", "/state?v=2&tv=1", page)[2].decode("utf-8")))
        other = {"type": "Box", "props": {}, "children": []}
        self.mod("POST", "/push", {"tree": other})
        got = json.loads(self.page("GET", "/state?v=3&tv=1", page)[2].decode("utf-8"))
        self.assertEqual((got["v"], got["tv"], got["tree"]), (4, 2, other))
        self.assertEqual(self.page("GET", "/state?v=x", page)[0], 400)

    def test_a_waiting_poll_is_answered_by_the_next_push(self):
        page = self.enter()
        got = {}

        def poll():
            got["answer"] = self.page("GET", "/state?v=0", page)

        waiter = threading.Thread(target=poll)
        waiter.start()
        time.sleep(0.3)
        self.assertEqual(got, {})
        self.mod("POST", "/push", {"tree": {"type": "Box"}})
        waiter.join(5)
        self.assertEqual(got["answer"][0], 200)
        self.assertEqual(json.loads(got["answer"][2])["v"], 1)

    def test_page_open_and_gone(self):
        page = self.enter()
        self.assertEqual(json.loads(self.mod("GET", "/status")[2]), {"pages": 0, "v": 0})
        got = {}

        def poll():
            got["answer"] = self.page("GET", "/state?v=0", page)

        waiter = threading.Thread(target=poll)
        waiter.start()
        self.assertEqual(self.run_.until("page"), {"page": "open"})
        self.assertEqual(json.loads(self.mod("GET", "/status")[2])["pages"], 1)
        waiter.join(5)
        self.assertEqual(got["answer"][0], 204)
        # its poll just answered, the page is between two polls: still counted, for a moment
        self.assertEqual(json.loads(self.mod("GET", "/status")[2])["pages"], 1)
        time.sleep(helper.BETWEEN_SECONDS + 0.3)
        self.assertEqual(json.loads(self.mod("GET", "/status")[2])["pages"], 0)
        # no poll for a while: gone, said once
        started = time.monotonic()
        self.assertEqual(self.run_.until("page", 10), {"page": "gone"})
        self.assertLess(time.monotonic() - started, helper.GONE_SECONDS + 3)
        self.assertEqual(json.loads(self.mod("GET", "/status")[2])["pages"], 0)
        with self.assertRaises(queue.Empty):
            self.run_.until("page", 1.0)
        # and open again with the next poll
        self.page("GET", "/state?v=0", page)
        self.assertEqual(self.run_.until("page"), {"page": "open"})

    def test_a_page_that_hangs_up_mid_poll_is_noticed(self):
        page = self.enter()
        conn = http.client.HTTPConnection("127.0.0.1", self.run_.port, timeout=10)
        conn.request("GET", "/state?v=0", headers={"X-Atlas-Token": page})
        self.assertEqual(self.run_.until("page"), {"page": "open"})
        self.assertEqual(json.loads(self.mod("GET", "/status")[2])["pages"], 1)
        conn.close()
        time.sleep(0.2)
        # asked right away, before the watch has said gone: the count is of connections still there
        self.assertEqual(json.loads(self.mod("GET", "/status")[2])["pages"], 0)
        self.assertEqual(self.run_.until("page", 10), {"page": "gone"})

    def test_acts_are_lines_on_standard_output(self):
        page = self.enter()
        acts = [
            {"kind": "hello", "width": 528, "height": 860},
            {"kind": "press", "key": "tab:prompt"},
            {"kind": "select", "key": "skin", "value": "porto"},
            {"kind": "input", "key": "hd-command", "value": "echo 你好\n第二行 \"quoted\" \\ back"},
            {"kind": "submit", "key": "search", "value": "关键词"},
            {"kind": "board", "data": {"board": "skills", "type": "drop", "card": "s:demo", "from": "on", "to": "off", "index": 0}},
            {"kind": "resize", "width": 700, "height": 900},
        ]
        for act in acts:
            self.assertEqual(self.page("POST", "/act", page, act)[0], 204, act)
        for act in acts:
            self.assertEqual(self.run_.until("act"), {"act": act})
        # a kind the page has none of, or none at all, is not passed on
        for bad in ({"kind": "eval", "code": "1"}, {"key": "k"}, {"kind": 3}):
            self.assertEqual(self.page("POST", "/act", page, bad)[0], 400, bad)
        with self.assertRaises(queue.Empty):
            self.run_.until("act", 0.5)

    def test_every_line_is_one_ascii_json_line(self):
        page = self.enter()
        self.page("POST", "/act", page, {"kind": "input", "key": "k", "value": "一行\n两行\r\n 三行"})
        # read raw: the reader thread parsed it already, so parse it back the way it was written
        doc = self.run_.until("act")
        self.assertEqual(doc["act"]["value"], "一行\n两行\r\n 三行")
        line = json.dumps(doc, ensure_ascii=True, separators=(",", ":"))
        self.assertNotIn("\n", line)
        self.assertTrue(all(ord(ch) < 128 for ch in line))

    def test_bodies_are_bounded(self):
        page = self.enter()
        ok = {"kind": "input", "key": "k", "value": "x" * (helper.MAX_ACT - 200)}
        self.assertEqual(self.page("POST", "/act", page, ok)[0], 204)
        self.assertEqual(len(self.run_.until("act")["act"]["value"]), helper.MAX_ACT - 200)
        too_long = {"kind": "input", "key": "k", "value": "x" * (helper.MAX_ACT + 1)}
        self.assertEqual(self.page("POST", "/act", page, too_long)[0], 413)
        self.assertEqual(self.request("POST", "/enter", {"ticket": "t" * (helper.MAX_SMALL + 1)}, JSON)[0], 413)
        self.assertEqual(self.mod("POST", "/open", {"pad": "p" * (helper.MAX_SMALL + 1)})[0], 413)
        # a length that is no number, a negative one, none at all, a coding that is not chunks
        for headers in ({"Content-Length": "many"}, {"Content-Length": "-5"}, {}, {"Transfer-Encoding": "gzip"}):
            conn = http.client.HTTPConnection("127.0.0.1", self.run_.port, timeout=10)
            try:
                conn.putrequest("POST", "/act", skip_host=True)
                conn.putheader("Host", self.host)
                conn.putheader("X-Atlas-Token", page)
                conn.putheader("Content-Type", "application/json")
                for name, value in headers.items():
                    conn.putheader(name, value)
                conn.endheaders()
                self.assertIn(conn.getresponse().status, (411, 413), headers)
            finally:
                conn.close()
        # a declared length over the bound is refused before any of the body is read
        conn = http.client.HTTPConnection("127.0.0.1", self.run_.port, timeout=10)
        try:
            conn.putrequest("POST", "/push", skip_host=True)
            conn.putheader("Host", self.host)
            conn.putheader("X-Atlas-Token", TOKEN)
            conn.putheader("Content-Type", "application/json")
            conn.putheader("Content-Length", str(helper.MAX_PUSH + 1))
            conn.endheaders()
            self.assertEqual(conn.getresponse().status, 413)
        finally:
            conn.close()
        with self.assertRaises(queue.Empty):
            self.run_.until("act", 0.5)

    def chunks(self, path, token, pieces, tail=b"0\r\n\r\n"):
        """A POST whose body is sent in chunks, as some clients send one: the status."""
        conn = http.client.HTTPConnection("127.0.0.1", self.run_.port, timeout=10)
        try:
            conn.putrequest("POST", path, skip_host=True)
            conn.putheader("Host", self.host)
            conn.putheader("X-Atlas-Token", token)
            conn.putheader("Content-Type", "application/json")
            conn.putheader("Transfer-Encoding", "chunked")
            conn.endheaders()
            try:
                for piece in pieces:
                    conn.send(b"%x\r\n" % len(piece) + piece + b"\r\n")
                conn.send(tail)
            except (BrokenPipeError, ConnectionResetError):
                pass  # refused before the whole body was sent
            return conn.getresponse().status
        finally:
            conn.close()

    def test_a_body_sent_in_chunks_is_read_whole_and_bounded_the_same(self):
        page = self.enter()
        raw = json.dumps({"kind": "input", "key": "k", "value": "分块的正文 " * 200}).encode("utf-8")
        self.assertEqual(self.chunks("/act", page, [raw[:7], raw[7:300], raw[300:]]), 204)
        self.assertEqual(self.run_.until("act")["act"]["value"], "分块的正文 " * 200)
        # with a trailer after the last chunk, and a chunk extension
        conn = http.client.HTTPConnection("127.0.0.1", self.run_.port, timeout=10)
        try:
            conn.putrequest("POST", "/act", skip_host=True)
            for name, value in (("Host", self.host), ("X-Atlas-Token", page), ("Content-Type", "application/json"), ("Transfer-Encoding", "chunked")):
                conn.putheader(name, value)
            conn.endheaders()
            body = b'{"kind":"press","key":"k"}'
            conn.send(b"%x;ext=1\r\n" % len(body) + body + b"\r\n0\r\nX-Trailer: 1\r\n\r\n")
            self.assertEqual(conn.getresponse().status, 204)
        finally:
            conn.close()
        self.assertEqual(self.run_.until("act"), {"act": {"kind": "press", "key": "k"}})
        # over the bound: refused when the chunks come to more, not after reading them all
        big = b"x" * (256 << 10)
        self.assertEqual(self.chunks("/act", page, [big] * 10), 413)
        # what is not chunks
        self.assertEqual(self.chunks("/act", page, [], tail=b"zz\r\n\r\n"), 400)
        self.assertEqual(self.chunks("/act", page, [], tail=b"-5\r\n\r\n"), 400)
        self.assertEqual(self.chunks("/act", page, [], tail=b"5\r\nabcdeXX0\r\n\r\n"), 400)
        with self.assertRaises(queue.Empty):
            self.run_.until("act", 0.5)
        # the mod's push in chunks
        tree = {"type": "Box", "props": {}, "children": ["分块"]}
        self.assertEqual(self.chunks("/push", TOKEN, [json.dumps({"tree": tree}).encode("utf-8")]), 200)
        self.assertEqual(json.loads(self.page("GET", "/state?v=0", page)[2].decode("utf-8"))["tree"], tree)

    def test_a_large_push_goes_through_whole(self):
        page = self.enter()
        tree = {"type": "Box", "props": {}, "children": [{"type": "Svg", "props": {"source": "<svg>%s</svg>" % ("é" * 400_000), "alt": "图"}, "children": []}]}
        self.assertEqual(self.mod("POST", "/push", {"tree": tree})[0], 200)
        got = json.loads(self.page("GET", "/state?v=0", page)[2].decode("utf-8"))
        self.assertEqual(got["tree"], tree)

    def test_old_toasts_and_focus_are_not_shown_to_a_late_page(self):
        state = helper.State(helper.Out(None), TOKEN)
        state.push({"tree": {"type": "Box"}, "toasts": ["旧的"], "focus": "back"})
        fresh = json.loads(state._answer(-1))
        self.assertEqual(fresh["toasts"], [{"id": 1, "text": "旧的"}])
        self.assertEqual(fresh["focus"], {"key": "back", "n": 1})
        state.toasts = [(i, text, at - helper.TOAST_SECONDS - 1) for i, text, at in state.toasts]
        state.focus = (state.focus[0], state.focus[1], state.focus[2] - helper.FOCUS_SECONDS - 1)
        late = json.loads(state._answer(-1))
        self.assertEqual((late["toasts"], late["focus"]), ([], None))
        # only the newest few are kept at all
        state.push({"toasts": ["t%d" % i for i in range(helper.TOASTS_KEPT + 5)]})
        self.assertEqual(len(state.toasts), helper.TOASTS_KEPT)


class OpenTests(ServerCase):
    extra_args = ()

    def test_started_without_no_open_it_opens_once_and_the_switch_suppresses_it(self):
        said = self.run_.until("window")
        self.assertEqual(said["window"], "suppressed")
        self.assertTrue(said["url"].startswith("http://127.0.0.1:%d/?t=" % self.run_.port))
        # each open is on a ticket of its own
        again = self.ticket()
        self.assertNotEqual(said["url"].split("?t=")[1], again)

    def test_the_commands_an_open_would_run(self):
        url = "http://127.0.0.1:5/?t=abc"
        mac = helper.open_commands(url, "mac", has_chrome=True)
        self.assertEqual(mac[0], ("chrome-app", ["/usr/bin/open", "-na", "Google Chrome", "--args", "--app=" + url, "--window-size=560,900"]))
        self.assertEqual(mac[1], ("default", ["/usr/bin/open", url]))
        self.assertEqual(helper.open_commands(url, "mac", has_chrome=False), [("default", ["/usr/bin/open", url])])
        win = helper.open_commands(url, "windows", windows_browser="msedge")
        self.assertEqual(win, [("msedge-app", ["cmd", "/c", "start", "", "msedge", "--app=" + url, "--window-size=560,900"])])
        # no Edge or Chrome: no command; the default browser is opened by the shell itself
        self.assertEqual(helper.open_commands(url, "windows", windows_browser=""), [])
        # the address holds nothing a shell would read as its own
        ticket = helper.State(helper.Out(None), TOKEN).new_ticket()
        self.assertRegex(ticket, r"^[A-Za-z0-9_-]+$")


@unittest.skipIf(os.name == "nt", "the parent's id is watched another way on Windows")
class ParentTests(unittest.TestCase):
    def test_it_ends_when_its_parent_is_gone(self):
        web = tempfile.mkdtemp(prefix="atlas-window-web-")
        self.addCleanup(shutil.rmtree, web, True)
        with open(os.path.join(web, "window.html"), "wb") as f:
            f.write(PAGE)
        # a parent that starts the helper, holding the pipe it writes to, prints its pid, and is then killed
        code = (
            "import subprocess, sys, time\n"
            "p = subprocess.Popen([sys.executable, '-I', %r, '--web', %r, '--no-open'], stdin=subprocess.PIPE, stdout=subprocess.PIPE)\n"
            "p.stdin.write(b'%s\\n'); p.stdin.close()\n"
            "print(p.pid, flush=True)\n"
            "time.sleep(60)\n"
        ) % (HELPER, web, TOKEN)
        parent = subprocess.Popen([sys.executable, "-I", "-c", code], stdout=subprocess.PIPE, env=dict(os.environ, ATLAS_WINDOW_NO_OPEN="1"))
        try:
            pid = int(parent.stdout.readline())
            time.sleep(0.5)
            os.kill(pid, 0)  # running
        finally:
            parent.kill()
            parent.wait(10)
            parent.stdout.close()
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                return
            time.sleep(0.2)
        os.kill(pid, 9)
        self.fail("the helper outlived its parent")

    def test_a_starter_that_exits_while_the_reader_lives_does_not_end_it(self):
        web = tempfile.mkdtemp(prefix="atlas-window-web-")
        self.addCleanup(shutil.rmtree, web, True)
        with open(os.path.join(web, "window.html"), "wb") as f:
            f.write(PAGE)
        # a starter that hands the helper this test's pipe and exits a moment later: the helper's parent
        # is gone, its reader is not
        code = (
            "import subprocess, sys, time\n"
            "p = subprocess.Popen([sys.executable, '-I', %r, '--web', %r, '--no-open'], stdin=subprocess.PIPE)\n"
            "p.stdin.write(b'%s\\n'); p.stdin.close()\n"
            "print('{\"pid\": %%d}' %% p.pid, flush=True)\n"
            "time.sleep(1.0)\n"
        ) % (HELPER, web, TOKEN)
        starter = subprocess.Popen([sys.executable, "-I", "-c", code], stdout=subprocess.PIPE, env=dict(os.environ, ATLAS_WINDOW_NO_OPEN="1"))
        pid = 0
        try:
            docs = [json.loads(starter.stdout.readline()), json.loads(starter.stdout.readline())]
            pid = [d["pid"] for d in docs if "pid" in d][0]
            port = [d["port"] for d in docs if "port" in d][0]
            self.assertEqual(starter.wait(10), 0)
            time.sleep(3.5)
            os.kill(pid, 0)  # still running
            conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
            conn.request("GET", "/status", headers={"X-Atlas-Token": TOKEN})
            self.assertEqual(conn.getresponse().status, 200)
            conn.close()
            # it has been asking whether anyone reads: every line since is one of those
            self.assertEqual(json.loads(starter.stdout.readline()), {"tick": 0})
        finally:
            starter.stdout.close()
            if starter.poll() is None:
                starter.kill()
        # and with the reader gone as well, it ends
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                return
            time.sleep(0.2)
        os.kill(pid, 9)
        self.fail("the helper outlived its reader")

    def test_it_ends_when_nobody_reads_its_output(self):
        web = tempfile.mkdtemp(prefix="atlas-window-web-")
        self.addCleanup(shutil.rmtree, web, True)
        with open(os.path.join(web, "window.html"), "wb") as f:
            f.write(PAGE)
        proc = subprocess.Popen(
            [sys.executable, "-I", HELPER, "--web", web, "--no-open"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            env=dict(os.environ, ATLAS_WINDOW_NO_OPEN="1"),
        )
        try:
            proc.stdin.write((TOKEN + "\n").encode("ascii"))
            proc.stdin.close()
            port = json.loads(proc.stdout.readline())["port"]
            proc.stdout.close()
            # the next line it writes finds the reader gone: what an open came to is such a line
            conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
            try:
                conn.request("POST", "/open", b"{}", {"X-Atlas-Token": TOKEN, "Content-Type": "application/json"})
                conn.getresponse().read()
            except (OSError, http.client.HTTPException):
                pass
            finally:
                conn.close()
            self.assertEqual(proc.wait(10), 0)
        finally:
            if proc.poll() is None:
                proc.kill()
            proc.wait(10)


if __name__ == "__main__":
    unittest.main()
