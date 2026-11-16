#!/usr/bin/python3
"""atlas window helper: a loopback HTTP server between the Atlas mod and its page in a browser window.

Usage (started by hooks/register.tsx; the mod's token arrives as the first line of standard input):
  atlas_window.py [--web DIR] [--no-open] [--port N]

It holds no logic of Atlas's own. The mod draws the pane and pushes the drawing here as JSON; the page
(web/window.html) long-polls for it, and what the person does in the page is written to standard output,
one JSON line each, for the mod to act on.

Standard output, one JSON object per line:
  {"ready": true, "port": N}             the server is listening
  {"ready": false, "error": TEXT}        it could not start (the process then exits 2)
  {"page": "open"} / {"page": "gone"}    a page started polling / none has polled for a while
  {"act": {"kind": ..., ...}}            what a page did (press, select, input, submit, board, resize, hello)
  {"window": "opened" | "suppressed" | "failed", "how": ..., ["url": ...]}
                                         what an open came to; the url only when opening is suppressed
  {"tick": N}                            every 30 s, so a reader that went away is noticed (0: asked at once,
                                         because the parent's id changed)

HTTP, on 127.0.0.1 only. Two kinds of token, each sent as the header X-Atlas-Token:
  the mod's token (standard input)   POST /push, POST /open, GET /status
  a page's token (from /enter)       GET /state, POST /act
  GET /?t=TICKET                     the page; a ticket is good for one page and two minutes
  GET /window.js, /window.css, ...   static files of the page folder
  POST /enter {"ticket": T}          trades the ticket for a page token, once: {"token": P}
  GET /state?v=N&tv=M                long-poll: the newest state once it is newer than N, else 204
  POST /act {"kind": ...}            what the page did
  POST /push {"tree"?, "title"?, "toasts"?, "focus"?}
  POST /open                         opens a window on a new ticket
  GET /status                        {"pages": N, "v": N}

The address a window is opened on carries a ticket, not a token, because a browser's command line can
be read by every process on the machine and its history keeps the address: the ticket stops working
when the page has used it.

This server can do everything Atlas can, so: loopback only; every request's Host must be this server's;
a POST must be application/json and, where it names an Origin, from this server's own; no CORS headers;
nothing is cached; the page may load nothing from elsewhere; bodies are bounded; a refusal says nothing.

It ends when the process that started it goes away: when nobody reads its standard output any more.
That is found out by writing (the tick), at once when its parent's id changes and every two seconds
after. Standard input says nothing about it: the mod's spawn closes it as soon as the token is written.
ATLAS_WINDOW_NO_OPEN=1 keeps it from opening any window: tests and checks set it.

Python 3.9, stdlib only, macOS and Windows.
"""

import argparse
import hmac
import json
import os
import queue
import re
import secrets
import select
import socket
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

WINDOWS = os.name == "nt"
MAC = sys.platform == "darwin"

POLL_SECONDS = 25.0
# A page polls again at once, so one that has not for this long is closed (or asleep).
GONE_SECONDS = 3.0
# A page whose poll was just answered is between two polls, not gone.
BETWEEN_SECONDS = 0.6
TICKET_SECONDS = 120.0
TICK_SECONDS = 30.0
TOAST_SECONDS = 8.0
FOCUS_SECONDS = 5.0
TOASTS_KEPT = 20

MAX_PUSH = 16 << 20
MAX_ACT = 2 << 20
MAX_SMALL = 4 << 10
# how much of a refused request's unread body is read off and dropped before the connection is closed
DRAIN_MAX = 32 << 20

WINDOW_SIZE = "560,900"
TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{16,256}$")
ACT_KINDS = ("press", "select", "input", "submit", "board", "resize", "hello")
TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
}
CSP = (
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src data:; connect-src 'self'; "
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
)


def compact(doc):
    return json.dumps(doc, ensure_ascii=False, separators=(",", ":"))


class Out(object):
    """Standard output, a line at a time, from one thread: a reader that is gone ends the process."""

    def __init__(self, stream):
        self.stream = stream
        self.lines = queue.Queue()
        self.thread = threading.Thread(target=self._run, name="out", daemon=True)

    def start(self):
        self.thread.start()

    def say(self, doc):
        self.lines.put(json.dumps(doc, ensure_ascii=True, separators=(",", ":")))

    def write_now(self, doc):
        """For the lines before the writer thread runs (ready, or why not)."""
        self._write(json.dumps(doc, ensure_ascii=True, separators=(",", ":")))

    def _write(self, line):
        try:
            self.stream.write((line + "\n").encode("ascii"))
            self.stream.flush()
        except (OSError, ValueError):
            os._exit(0)

    def _run(self):
        while True:
            self._write(self.lines.get())


class State(object):
    """What the mod last pushed, who is looking, and the tickets and tokens given out."""

    def __init__(self, out, mod_token):
        self.out = out
        self.mod_token = mod_token
        self.cond = threading.Condition()
        self.version = 0
        self.tree_version = 0
        self.tree_json = "null"
        self.title = ""
        self.focus = None  # (key, n, at)
        self.focus_n = 0
        self.toasts = []  # (id, text, at)
        self.toast_n = 0
        self.tickets = {}  # ticket -> good until
        self.pages = set()  # page tokens
        self.polls = {}  # id -> socket, the polls waiting now
        self.poll_n = 0
        # the monotonic clock may start at nought with the process: "never" is before any time it gives
        self.last_poll = float("-inf")
        self.last_answer = float("-inf")
        self.listening = False

    # ---- tickets and tokens ----

    def new_ticket(self):
        ticket = secrets.token_urlsafe(32)
        now = time.monotonic()
        with self.cond:
            for old in [t for t, until in self.tickets.items() if until < now]:
                del self.tickets[old]
            self.tickets[ticket] = now + TICKET_SECONDS
        return ticket

    def _find(self, table, given):
        """The entry of `table` equal to `given`, every entry compared in constant time."""
        found = None
        raw = given.encode("utf-8", "replace")
        for known in table:
            if hmac.compare_digest(known.encode("ascii"), raw):
                found = known
        return found

    def ticket_good(self, given):
        with self.cond:
            known = self._find(list(self.tickets), given)
            return known is not None and self.tickets[known] >= time.monotonic()

    def enter(self, given):
        """Spends a ticket: the page token it buys, or None."""
        with self.cond:
            known = self._find(list(self.tickets), given)
            if known is None:
                return None
            until = self.tickets.pop(known)
            if until < time.monotonic():
                return None
            token = secrets.token_urlsafe(32)
            self.pages.add(token)
            return token

    def is_mod(self, given):
        return hmac.compare_digest(self.mod_token.encode("ascii"), given.encode("utf-8", "replace"))

    def is_page(self, given):
        with self.cond:
            return self._find(list(self.pages), given) is not None

    # ---- what the mod pushed ----

    def push(self, doc):
        now = time.monotonic()
        with self.cond:
            if "tree" in doc:
                text = compact(doc["tree"])
                if text != self.tree_json:
                    self.tree_json = text
                    self.tree_version += 1
            if isinstance(doc.get("title"), str):
                self.title = doc["title"][:200]
            if isinstance(doc.get("focus"), str):
                self.focus_n += 1
                self.focus = (doc["focus"][:1000], self.focus_n, now)
            toasts = doc.get("toasts")
            if isinstance(toasts, list):
                for text in toasts:
                    if isinstance(text, str) and text:
                        self.toast_n += 1
                        self.toasts.append((self.toast_n, text[:2000], now))
                del self.toasts[:-TOASTS_KEPT]
            self.version += 1
            self.cond.notify_all()
            return self.version

    def _answer(self, have_tree):
        """The state as one JSON text; the tree is left out when the page already has this one."""
        now = time.monotonic()
        focus = None
        if self.focus and now - self.focus[2] < FOCUS_SECONDS:
            focus = {"key": self.focus[0], "n": self.focus[1]}
        toasts = [{"id": i, "text": text} for i, text, at in self.toasts if now - at < TOAST_SECONDS]
        head = compact({"v": self.version, "tv": self.tree_version, "title": self.title, "focus": focus, "toasts": toasts})
        if have_tree == self.tree_version:
            return head
        return head[:-1] + ',"tree":' + self.tree_json + "}"

    def wait(self, since, have_tree, sock, poll_seconds):
        """A page's long-poll: the answer once there is one newer than `since`, None when the time is up,
        False when the page hung up."""
        deadline = time.monotonic() + poll_seconds
        with self.cond:
            self.poll_n += 1
            mine = self.poll_n
            self.polls[mine] = sock
            self.last_poll = time.monotonic()
            if not self.listening:
                self.listening = True
                self.out.say({"page": "open"})
            answered = True
            try:
                while self.version <= since:
                    left = deadline - time.monotonic()
                    if left <= 0:
                        return None
                    self.cond.wait(min(left, 0.5))
                    if hung_up(sock):
                        answered = False
                        return False
                return self._answer(have_tree)
            finally:
                del self.polls[mine]
                self.last_poll = time.monotonic()
                if answered:
                    self.last_answer = self.last_poll

    def live_pages(self):
        """How many pages are looking now: the polls waiting on a connection that is still there, or one
        for a page whose poll was answered a moment ago and whose next has not come in yet."""
        with self.cond:
            live = sum(1 for sock in self.polls.values() if not hung_up(sock))
            if live == 0 and self.listening and time.monotonic() - self.last_answer < BETWEEN_SECONDS:
                return 1
            return live

    def watch(self):
        """Says when the last page has gone: no poll waiting, and none for a while."""
        while True:
            time.sleep(0.5)
            with self.cond:
                quiet = time.monotonic() - self.last_poll
                if self.listening and not self.polls and quiet > GONE_SECONDS:
                    self.listening = False
                    self.out.say({"page": "gone"})


def hung_up(sock):
    """True when the other end closed the connection (nothing to read, and the read says end of file)."""
    try:
        readable, _, _ = select.select([sock], [], [], 0)
        if not readable:
            return False
        return sock.recv(1, socket.MSG_PEEK) == b""
    except (OSError, ValueError):
        return True


# ---------- opening a window ----------


def mac_chrome():
    for base in ("/Applications", os.path.expanduser("~/Applications")):
        if os.path.isdir(os.path.join(base, "Google Chrome.app")):
            return True
    return False


def windows_app_browser():
    """The name `start` runs Edge or Chrome by, when Windows knows where one is."""
    try:
        import winreg
    except ImportError:
        return None
    for exe in ("msedge.exe", "chrome.exe"):
        for hive in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
            try:
                winreg.CloseKey(winreg.OpenKey(hive, "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\" + exe))
                return exe[:-4]
            except OSError:
                continue
    return None


def open_commands(url, platform=None, has_chrome=None, windows_browser=None):
    """The commands to try in turn, each (how, argv): a window with no tabs or address bar first, where a
    browser that can draw one is installed, then the default browser. Empty where there is no command
    (the default browser on Windows is opened by the shell itself, see open_window)."""
    platform = platform or ("windows" if WINDOWS else "mac" if MAC else "other")
    out = []
    if platform == "mac":
        if mac_chrome() if has_chrome is None else has_chrome:
            out.append(("chrome-app", ["/usr/bin/open", "-na", "Google Chrome", "--args", "--app=" + url, "--window-size=" + WINDOW_SIZE]))
        out.append(("default", ["/usr/bin/open", url]))
    elif platform == "windows":
        browser = windows_app_browser() if windows_browser is None else windows_browser
        if browser:
            out.append((browser + "-app", ["cmd", "/c", "start", "", browser, "--app=" + url, "--window-size=" + WINDOW_SIZE]))
    else:
        out.append(("default", ["xdg-open", url]))
    return out


def open_window(url):
    """Opens the page: (how, None) when something took it, (None, why) when nothing did."""
    why = "no browser could be started"
    for how, argv in open_commands(url):
        try:
            done = subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=15)
            if done.returncode == 0:
                return how, None
            why = (done.stderr or b"").decode("utf-8", "replace").strip()[-300:] or "%s exited %d" % (argv[0], done.returncode)
        except (OSError, subprocess.SubprocessError) as exc:
            why = str(exc)[-300:]
    if WINDOWS:
        try:
            os.startfile(url)  # the default browser, with no shell to read the address
            return "default", None
        except OSError as exc:
            why = str(exc)[-300:]
    return None, why


# ---------- HTTP ----------


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    timeout = 120
    state = None  # these four are set on the class main() makes of this one
    web = ""
    no_open = False
    poll_seconds = POLL_SECONDS

    def log_message(self, format, *args):  # noqa: A002 (the base class's name)
        pass  # an address may hold a ticket: nothing is logged

    def version_string(self):
        return "atlas"

    def send_error(self, code, message=None, explain=None):
        self.refuse(code)

    # ---- answers ----

    def _head(self, code, kind, length):
        self.send_response(code)
        if kind:
            self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(length))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Security-Policy", CSP)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")

    def answer(self, code, body=b"", kind=None):
        try:
            self._head(code, kind, len(body))
            self.end_headers()
            if body and self.command != "HEAD":
                self.wfile.write(body)
        except OSError:
            self.close_connection = True

    def answer_json(self, doc):
        text = doc if isinstance(doc, str) else compact(doc)
        self.answer(200, text.encode("utf-8"), "application/json; charset=utf-8")

    def refuse(self, code):
        """A refusal with no detail; the connection is not kept, since its body may not have been read."""
        self.close_connection = True
        try:
            self._head(code, None, 0)
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.flush()
        except OSError:
            return
        self.drain()

    def drain(self):
        """Reads off, and drops, the body a refused POST is still sending, within bounds. A connection
        closed with bytes unread is reset on Windows, and the sender then sees a broken connection in
        place of the refusal; nothing read here is kept."""
        if self.command != "POST" or getattr(self, "body_read", False):
            return
        try:
            declared = int(self.headers.get("Content-Length") or "0")
        except ValueError:
            declared = 0
        chunked = bool((self.headers.get("Transfer-Encoding") or "").strip())
        left = DRAIN_MAX if chunked else min(max(declared, 0), DRAIN_MAX)
        if left <= 0:
            return
        try:
            self.connection.shutdown(socket.SHUT_WR)  # the answer is whole: the sender may read it now
            self.connection.settimeout(1.5)
            while left > 0:
                data = self.rfile.read1(min(65536, left))
                if not data:
                    break
                left -= len(data)
        except (OSError, ValueError):
            pass

    # ---- checks ----

    def own_names(self):
        port = self.server.server_address[1]
        return ("127.0.0.1:%d" % port, "localhost:%d" % port)

    def checked(self):
        """The request's path and query when it is addressed to this server by its own name and, where
        it names an Origin, comes from this server's own page; None, the refusal sent, otherwise."""
        hosts = self.headers.get_all("Host") or []
        if len(hosts) != 1 or hosts[0].strip().lower() not in self.own_names():
            self.refuse(403)
            return None
        origin = self.headers.get("Origin")
        if origin is not None and origin.strip().lower() not in tuple("http://" + name for name in self.own_names()):
            self.refuse(403)
            return None
        try:
            parts = urlsplit(self.path)
            query = parse_qs(parts.query, keep_blank_values=True, max_num_fields=8)
        except ValueError:
            self.refuse(400)
            return None
        return parts.path, query

    def from_elsewhere(self):
        """True, the refusal sent, for a request a browser marks as another site's. Asked of what a page
        is given and what a page sends; the mod's own requests come from no browser."""
        if (self.headers.get("Sec-Fetch-Site") or "same-origin").strip().lower() in ("same-origin", "none"):
            return False
        self.refuse(403)
        return True

    def token(self):
        return self.headers.get("X-Atlas-Token") or ""

    def body(self, limit):
        """A POST's JSON object, or None with the refusal sent."""
        kind = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        if kind != "application/json":
            self.refuse(415)
            return None
        coding = (self.headers.get("Transfer-Encoding") or "").strip().lower()
        if coding:
            # a client may send a body in chunks instead of saying its length: read the same, to the same bound
            if coding != "chunked":
                self.refuse(411)
                return None
            raw = self.chunked(limit)
            if raw is None:
                return None
        else:
            try:
                length = int(self.headers.get("Content-Length") or "")
            except ValueError:
                self.refuse(411)
                return None
            if length < 0 or length > limit:
                self.refuse(413)
                return None
            try:
                raw = self.rfile.read(length)
            except OSError:
                self.close_connection = True
                return None
            if len(raw) != length:
                self.refuse(400)
                return None
        # the whole body is in: a refusal from here on has nothing left to read off
        self.body_read = True
        try:
            doc = json.loads(raw.decode("utf-8"))
        except (ValueError, RecursionError):
            self.refuse(400)
            return None
        if not isinstance(doc, dict):
            self.refuse(400)
            return None
        return doc

    def chunked(self, limit):
        """A body sent in chunks, whole, or None with the refusal sent: too long, or not chunks at all."""
        parts = []
        total = 0
        try:
            while True:
                line = self.rfile.readline(80)
                if not line.endswith(b"\n"):
                    self.refuse(400)
                    return None
                try:
                    size = int(line.split(b";")[0].strip() or b"x", 16)
                except ValueError:
                    self.refuse(400)
                    return None
                if size < 0:
                    self.refuse(400)
                    return None
                if size == 0:
                    # the trailer: lines up to an empty one, none of them read
                    for _ in range(32):
                        if self.rfile.readline(1024) in (b"\r\n", b"\n", b""):
                            break
                    return b"".join(parts)
                total += size
                if total > limit:
                    self.refuse(413)
                    return None
                data = self.rfile.read(size)
                if len(data) != size or self.rfile.readline(4) not in (b"\r\n", b"\n"):
                    self.refuse(400)
                    return None
                parts.append(data)
        except OSError:
            self.close_connection = True
            return None

    # ---- GET ----

    def do_GET(self):
        asked = self.checked()
        if asked is None:
            return
        path, query = asked
        if path == "/status":
            if not self.state.is_mod(self.token()):
                return self.refuse(403)
            return self.answer_json({"pages": self.state.live_pages(), "v": self.state.version})
        if path in ("/push", "/open", "/act", "/enter"):
            return self.refuse(405)
        if self.from_elsewhere():
            return
        if path == "/":
            ticket = (query.get("t") or [""])[0]
            if not ticket or not self.state.ticket_good(ticket):
                return self.refuse(403)
            return self.static("window.html")
        if path == "/state":
            if not self.state.is_page(self.token()):
                return self.refuse(403)
            return self.poll(query)
        return self.static(path[1:])

    def static(self, name):
        """A file of the page folder by its plain name: no folders, no dot files, nothing outside."""
        if not re.match(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$", name):
            return self.refuse(404)
        kind = TYPES.get(os.path.splitext(name)[1].lower())
        root = os.path.realpath(self.web)
        full = os.path.realpath(os.path.join(root, name))
        if kind is None or os.path.dirname(full) != root or not os.path.isfile(full):
            return self.refuse(404)
        try:
            with open(full, "rb") as f:
                data = f.read()
        except OSError:
            return self.refuse(404)
        self.answer(200, data, kind)

    def poll(self, query):
        try:
            since = int((query.get("v") or ["-1"])[0])
            have_tree = int((query.get("tv") or ["-1"])[0])
        except ValueError:
            return self.refuse(400)
        got = self.state.wait(since, have_tree, self.connection, self.poll_seconds)
        if got is False:
            self.close_connection = True
            return
        if got is None:
            return self.answer(204)
        self.answer_json(got)

    # ---- POST ----

    def do_POST(self):
        self.body_read = False
        asked = self.checked()
        if asked is None:
            return
        path, _ = asked
        if path in ("/enter", "/act") and self.from_elsewhere():
            return
        if path == "/enter":
            doc = self.body(MAX_SMALL)
            if doc is None:
                return
            ticket = doc.get("ticket")
            token = self.state.enter(ticket) if isinstance(ticket, str) and ticket else None
            if token is None:
                return self.refuse(403)
            return self.answer_json({"token": token})
        if path == "/act":
            if not self.state.is_page(self.token()):
                return self.refuse(403)
            doc = self.body(MAX_ACT)
            if doc is None:
                return
            if doc.get("kind") not in ACT_KINDS:
                return self.refuse(400)
            self.state.out.say({"act": doc})
            return self.answer(204)
        if path in ("/push", "/open"):
            if not self.state.is_mod(self.token()):
                return self.refuse(403)
            doc = self.body(MAX_PUSH if path == "/push" else MAX_SMALL)
            if doc is None:
                return
            if path == "/push":
                version = self.state.push(doc)
                return self.answer_json({"v": version, "pages": self.state.live_pages()})
            return self.answer_json(self.open_one())
        if path in ("/", "/state", "/status"):
            return self.refuse(405)
        self.refuse(404)

    def open_one(self):
        return open_page(self.state, self.server.server_address[1], self.no_open)

    def do_HEAD(self):
        self.refuse(405)

    do_PUT = do_DELETE = do_PATCH = do_OPTIONS = do_HEAD


def open_page(state, port, no_open):
    """Opens a window on a new ticket and says on standard output what came of it."""
    url = "http://127.0.0.1:%d/?t=%s" % (port, state.new_ticket())
    if no_open:
        state.out.say({"window": "suppressed", "url": url})
        return {"opened": False, "how": "suppressed", "url": url}
    how, why = open_window(url)
    if how is None:
        # the address goes back to the mod (never into a page): it can be opened by hand while its ticket lasts
        state.out.say({"window": "failed", "error": why})
        return {"opened": False, "how": "failed", "error": why, "url": url}
    state.out.say({"window": "opened", "how": how})
    return {"opened": True, "how": how}


class Server(ThreadingHTTPServer):
    daemon_threads = True
    # the port is the system's pick, so nothing is gained by sharing it, and on Windows sharing lets
    # another process take the same port
    allow_reuse_address = False
    request_queue_size = 32

    def handle_error(self, request, client_address):
        pass  # a page that hung up mid-answer is not worth a traceback


# ---------- the parent ----------


def parent_watch(parent, out):
    """Notices the process that started this one going away, and from then on asks every two seconds
    whether anyone still reads what this one says: with the reader gone, the line written ends the
    process (see Out). The parent's id alone does not end it: a starter that hands its child on and
    exits is not a session that ended, and the reader is what tells the two apart."""
    handle = None
    if WINDOWS:
        try:
            import ctypes

            kernel = ctypes.windll.kernel32
            handle = kernel.OpenProcess(0x00100000, False, parent)  # SYNCHRONIZE
        except Exception:  # noqa: BLE001 (no ctypes, no handle: the tick still notices, later)
            handle = None
    orphaned = False
    while True:
        time.sleep(2.0 if orphaned else 1.0)
        if orphaned:
            out.say({"tick": 0})
        elif WINDOWS:
            if handle:
                try:
                    orphaned = kernel.WaitForSingleObject(handle, 0) == 0
                except Exception:  # noqa: BLE001
                    handle = None
        else:
            orphaned = os.getppid() != parent
        if orphaned:
            out.say({"tick": 0})


def ticker(out):
    n = 0
    while True:
        time.sleep(TICK_SECONDS)
        n += 1
        out.say({"tick": n})


def read_token(stream):
    try:
        line = stream.readline(1024)
    except (OSError, ValueError):
        return None
    text = line.decode("ascii", "replace").strip()
    return text if TOKEN_RE.match(text) else None


def main(argv=None):
    parser = argparse.ArgumentParser(description="The loopback server behind Atlas's browser window.")
    parser.add_argument("--web", default=os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "web"))
    parser.add_argument("--no-open", action="store_true", help="do not open a window at start")
    parser.add_argument("--port", type=int, default=0, help="0: the system picks")
    parser.add_argument("--poll-seconds", type=float, default=POLL_SECONDS, help=argparse.SUPPRESS)
    args = parser.parse_args(argv)

    out = Out(sys.stdout.buffer)
    parent = os.getppid()
    token = read_token(sys.stdin.buffer)
    if token is None:
        out.write_now({"ready": False, "error": "no token on standard input"})
        return 2
    if not os.path.isfile(os.path.join(args.web, "window.html")):
        out.write_now({"ready": False, "error": "the page folder has no window.html: %s" % args.web})
        return 2
    state = State(out, token)
    suppressed = os.environ.get("ATLAS_WINDOW_NO_OPEN") == "1"
    handler = type("AtlasHandler", (Handler,), {"state": state, "web": args.web, "no_open": suppressed, "poll_seconds": args.poll_seconds})
    try:
        server = Server(("127.0.0.1", args.port), handler)
    except OSError as exc:
        out.write_now({"ready": False, "error": "could not listen on 127.0.0.1: %s" % exc})
        return 2
    port = server.server_address[1]
    out.write_now({"ready": True, "port": port})
    out.start()
    for target, targs in ((parent_watch, (parent, out)), (ticker, (out,)), (state.watch, ())):
        threading.Thread(target=target, args=targs, daemon=True).start()
    if not args.no_open:
        open_page(state, port, suppressed)
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
