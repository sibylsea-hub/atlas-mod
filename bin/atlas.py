#!/usr/bin/python3
"""atlas indexer: scans a Claude Code config dir and prints one JSON document.

Usage (see docs/contract.md, the only interface shared with the pane):
  atlas.py index  [--claude-dir DIR] [--cache FILE] [--current-cwd PATH]
  atlas.py search QUERY [--claude-dir DIR] [--limit N]
  atlas.py trash PATH... [--days N] [--kind KIND] [--label TEXT] [--protect-session ID]
  atlas.py restore ID... | purge [--dry-run] [--now ID... | --all] | trash-list | set-expiry ID --days N
  atlas.py archive-memory PATH --project-label LABEL
  atlas.py move SRC DEST_DIR | os-trash PATH | reveal PATH | open PATH [--edit]

Python 3.9, stdlib only, macOS and Windows. index / search / trash-list are read-only except the cache
file; only the trash and archive commands move files, and only inside the allowed roots listed in the
contract. move / os-trash / reveal / open act on exactly the path they are given and are never called
by index.

Paths: every path this script keeps or prints uses forward slashes (on Windows `C:/Users/...`, drive
letter upper-cased); see "Paths" in the contract. All path arithmetic goes through the helpers in the
"paths" section below (pjoin, pnorm, under, ...), never through os.path directly, so that the Windows
rules can be tested on a Mac by patching WINDOWS.
"""

import argparse
import calendar
import errno
import json
import ntpath
import os
import posixpath
import re
import shutil
import stat
import sys
import tempfile
import time

WINDOWS = os.name == "nt"

VERSION = 2
# Bump when the per-file summary format or parsing rules change; old cache entries are then ignored.
PARSER_VERSION = 5

MAX_WARNINGS = 50
MAX_SESSIONS = 400
MAX_MEMORY_PATHS = 50
INDEX_LINE_LIMIT = 200
INDEX_BYTE_LIMIT = 25000
MEMORY_DESC_LIMIT = 200
SKILL_DESC_LIMIT = 300
TITLE_PROMPT_LIMIT = 80
SEARCH_TEXT_LIMIT = 200
TAIL_BYTES = 1 << 20
IO_CACHE_CAP = 100
IO_SESSION_CAP = 30
IO_PROJECT_CAP = 50
PATH_HISTORY_CAP = 50
PATHS_PER_SESSION_CAP = 100
NESTED_CAP = 50
DOC_NODE_CAP = 4000
DOC_READ_LIMIT = 1 << 20
SLUG_MAX = 200
LAUNCH_PARENT_CAP = 200
SCAN_DEPTH = 3
SCAN_SKIP = ("Library", ".Trash", ".git", "node_modules", ".cache")
SCAN_SKIP_WINDOWS = ("AppData", ".git", "node_modules", ".cache")
TRASH_DIR = "atlas-trash"
DAY_MS = 86400000
DEFAULT_TRASH_DAYS = 30
# `--days never`: no expiry; the item stays until it is emptied by hand
NEVER = "never"

SEVERITY_RANK = {"error": 0, "warn": 1, "info": 2}
WRITE_TOOLS = ("Write", "Edit", "MultiEdit")

# Substrings that make a transcript line worth json-decoding (contract: "Parsing rules for speed").
_INTERESTING = (
    b"skill_listing",
    b'"instructions"',
    b"nested_memory",
    b'"Skill"',
    b"command-name",
    b"custom-title",
    b"ai-title",
    b'"relocated"',
    b'"file_path"',
    b'"notebook_path"',
    b'"Bash"',
    b'"Glob"',
    b'"Grep"',
)
_SUB_INTERESTING = (b'"Skill"', b'"file_path"', b'"notebook_path"', b'"Bash"', b'"Glob"', b'"Grep"')
_USER_MARKERS = (b'"type":"user"', b'"type": "user"')
_HEAD_LINE_CAP = 200

# Top-level key run present in every record that has a cwd (verified on all real records).
_CWD_SIG = re.compile(rb'"userType":"[^"]*","entrypoint":"([^"]*)","cwd":"((?:[^"\\]|\\.)*)"')

_ISO_RE = re.compile(
    r"^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?$"
)
_COMMAND_RE = re.compile(r"<command-name>\s*(.*?)\s*</command-name>", re.S)
_FM_KEY_RE = re.compile(r"^([A-Za-z0-9_][A-Za-z0-9_.\-]*):(?:[ \t]+(.*?))?[ \t]*$")
_BLOCK_RE = re.compile(r"^[|>][+-]?[0-9]?[+-]?$")
_LINK_RE = re.compile(
    r"\]\(\s*(?:<([^<>\n]+?\.md)(?:#[^<>\n]*)?>|([^()\s<>]+?\.md)(?:#[^()\s<>]*)?)(?:\s+\"[^\"]*\")?\s*\)"
)
_WIKI_RE = re.compile(r"\[\[([^\[\]\n|#]+)(?:[#|][^\[\]\n]*)?\]\]")
_IMPORT_RE = re.compile(r"(?:^|(?<=\s))@([^\s<>()\[\]{}\"'`,;]+)", re.M)
_SCRATCHPAD_RE = re.compile(r"^(?:/private)?/tmp/claude-\d+/([^/]+)(?:/|$)")
_SCRATCHPAD_DIR_RE = re.compile(r"^claude(?:-\d+)?$", re.I)
_TRASH_ID_RE = re.compile(r"^[0-9]{13}-[0-9a-f]{8}$")
_MSYS_DRIVE_RE = re.compile(r"^/([A-Za-z])(?:/|$)")
# Names Windows refuses as a file or folder name (checked for the labels this script turns into folders).
_WIN_BAD_NAME_RE = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_WIN_RESERVED_RE = re.compile(r"^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$", re.I)
_ATTR_HIDDEN = 0x2
_ATTR_SYSTEM = 0x4

_BASH_TOK = r"""("(?:[^"\\]|\\.)*"|'[^']*'|(?:[^\s;&|()<>"'\\]|\\.)+)"""
_BASH_CD = re.compile(r"(?:^|[;&|(]|\s)cd\s+" + _BASH_TOK)
_BASH_REDIR = re.compile(r"(?<![-=<>0-9&])(?:[0-9]|&)?>>?\|?\s*" + _BASH_TOK)
_BASH_OUT = re.compile(r"(?:^|\s)(?:-o|--output)(?:\s+|=)" + _BASH_TOK)


class AtlasError(Exception):
    pass


class Refused(Exception):
    pass


class Warnings(object):
    def __init__(self):
        self.items = []
        self.dropped = 0

    def add(self, msg):
        if len(self.items) < MAX_WARNINGS:
            self.items.append(msg)
        else:
            self.dropped += 1

    def out(self):
        items = list(self.items)
        if self.dropped:
            items = items[: MAX_WARNINGS - 1]
            items.append("还有 %d 条警告未列出" % (self.dropped + 1))
        return items


# ---------------------------------------------------------------- small helpers


def now_ms():
    return int(time.time() * 1000)


def mtime_ms(st):
    return int(st.st_mtime_ns // 1000000)


def iso_ms(s):
    if not isinstance(s, str):
        return None
    m = _ISO_RE.match(s.strip())
    if not m:
        return None
    y, mo, d, h, mi, se = (int(x) for x in m.groups()[:6])
    frac = (m.group(7) or "") + "000"
    ms = int(frac[:3])
    try:
        secs = calendar.timegm((y, mo, d, h, mi, se, 0, 0, 0))
    except (ValueError, OverflowError):
        return None
    tz = m.group(8)
    if tz and tz != "Z":
        sign = 1 if tz[0] == "+" else -1
        digits = tz[1:].replace(":", "")
        secs -= sign * (int(digits[:2]) * 3600 + int(digits[2:4]) * 60)
    return secs * 1000 + ms


# ---------------------------------------------------------------- paths
#
# One path form everywhere (contract: "Paths"). On POSIX every helper below is the os.path function it replaces
# and fwd()/pkey() are the identity. On Windows they keep paths in the forward-slash form and compare them
# case-insensitively. The flavour is read from WINDOWS at call time.


def _pm():
    return ntpath if WINDOWS else posixpath


def fwd(p):
    """The form paths are kept and printed in. POSIX: unchanged (a backslash is an ordinary character there).
    Windows: backslashes become forward slashes, the drive letter is upper-cased, and the long-path prefix
    (two backslashes, a question mark, a backslash) is dropped."""
    if not WINDOWS or not isinstance(p, str) or not p:
        return p
    p = p.replace("\\", "/")
    if p.startswith("//?/"):
        if p[4:8].upper() == "UNC/":
            p = "//" + p[8:]
        elif len(p) >= 6 and p[5] == ":":
            p = p[4:]
    if len(p) >= 2 and p[1] == ":" and "a" <= p[0] <= "z" and (len(p) == 2 or p[2] == "/"):
        p = p[0].upper() + p[1:]
    return p


def native(p):
    """Backslashes, for the few Windows programs that insist on them (explorer, the shell API, link targets)."""
    return p.replace("/", "\\") if WINDOWS else p


def pjoin(*parts):
    return fwd(_pm().join(*parts))


def pnorm(p):
    return fwd(_pm().normpath(p))


def pdirname(p):
    return fwd(_pm().dirname(p))


def pbasename(p):
    return _pm().basename(p)


def real(p):
    return fwd(os.path.realpath(p))


def absp(p):
    return fwd(os.path.abspath(p))


def expand(p):
    return fwd(os.path.expanduser(p))


def home_dir():
    """$HOME on POSIX, %USERPROFILE% on Windows (os.path.expanduser's rule on each)."""
    return fwd(os.path.expanduser("~"))


def is_abs(p):
    """POSIX: starts with "/". Windows: a drive path (C:/x, in either slash) or a UNC path; "/x" and "C:x" are not
    absolute there (they depend on the current drive or directory)."""
    if not isinstance(p, str) or not p:
        return False
    if not WINDOWS:
        return p.startswith("/")
    p = p.replace("\\", "/")
    if len(p) >= 3 and p[1] == ":" and p[2] == "/" and p[0].isascii() and p[0].isalpha():
        return True
    return p.startswith("//") and len(p) > 2 and p[2] != "/"


def pkey(p):
    """What two paths (or file names) are compared on. POSIX: the string itself. Windows: forward slashes and
    lower case, one character for one so that prefixes keep their length."""
    if not WINDOWS or not p:
        return p
    p = p.replace("\\", "/")
    if p.isascii():
        return p.lower()
    return "".join(c.lower() if len(c.lower()) == 1 else c for c in p)


def same_path(a, b):
    return pkey(a) == pkey(b)


def _under_k(pk, rk):
    """under() for strings that already went through pkey()."""
    rk = rk.rstrip("/") or "/"
    if rk == "/":
        return pk.startswith("/")
    return pk == rk or pk.startswith(rk + "/")


def under(path, root):
    if not path or not root:
        return False
    return _under_k(pkey(path), pkey(root))


def strictly_under(path, root):
    return pkey(path) != pkey(root).rstrip("/") and under(path, root)


def is_fs_root(p):
    """"/" (or ""), and on Windows a bare drive (C:/) or a UNC share: a folder that holds everything else."""
    p = fwd(p or "").rstrip("/")
    if not p:
        return True
    if WINDOWS:
        if len(p) == 2 and p[1] == ":":
            return True
        if p.startswith("//") and p.count("/") <= 3:
            return True
    return False


def windows_temp(home, env=None):
    """Windows: the user's temp folder, %TEMP% (else %TMP%, else <home>/AppData/Local/Temp)."""
    env = os.environ if env is None else env
    t = fwd(env.get("TEMP") or env.get("TMP") or "").rstrip("/")
    return t or pjoin(home, "AppData", "Local", "Temp")


def temp_roots(home, env=None):
    """Folders whose contents are throwaway: /tmp and /private/tmp, plus on Windows the user's temp folder
    (both spellings: %TEMP% and <home>/AppData/Local/Temp) and <SystemRoot>/Temp."""
    roots = ["/tmp", "/private/tmp"]
    if WINDOWS:
        env = os.environ if env is None else env
        sysroot = fwd(env.get("SystemRoot") or env.get("SYSTEMROOT") or "").rstrip("/")
        for t in (windows_temp(home, env), pjoin(home, "AppData", "Local", "Temp"), sysroot and sysroot + "/Temp"):
            if t and pkey(t) not in [pkey(r) for r in roots]:
                roots.append(t)
    return roots


def from_msys(p, home):
    """Windows: a Git Bash spelling as a drive path, /c/Users/x -> C:/Users/x and /tmp/x -> <temp>/x. Anything
    else, and every path on POSIX, comes back unchanged."""
    if not WINDOWS or not p.startswith("/") or p.startswith("//"):
        return p
    m = _MSYS_DRIVE_RE.match(p)
    if m:
        return m.group(1).upper() + ":/" + p[3:]
    if p == "/tmp" or p.startswith("/tmp/"):
        return windows_temp(home) + p[4:]
    return p


def scratchpad_slug(path, tmp_roots):
    """The project slug of a session scratchpad path, else None. POSIX: /tmp/claude-<uid>/<slug>/... (also under
    /private). Windows: <temp>/claude/<slug>/... or <temp>/claude-<n>/<slug>/... under any temp root."""
    m = _SCRATCHPAD_RE.match(path)
    if m:
        return m.group(1)
    if WINDOWS:
        for t in tmp_roots:
            if t.startswith("/") or not under(path, t):
                continue
            rest = path[len(t.rstrip("/")) + 1:].split("/")
            if len(rest) >= 2 and rest[1] and _SCRATCHPAD_DIR_RE.match(rest[0]):
                return rest[1]
    return None


def slugify(path):
    """Claude Code's project-folder slug: every UTF-16 unit outside [A-Za-z0-9] becomes '-'. A Windows path gives
    the same slug in either spelling (E:/foo with a backslash or a forward slash is E--foo)."""
    out = []
    for ch in path:
        o = ord(ch)
        if o < 128 and (ch.isalnum()):
            out.append(ch)
        elif o > 0xFFFF:
            out.append("--")
        else:
            out.append("-")
    return "".join(out)


def name_key(name):
    """What two file or folder names are compared on: lower case on Windows, the name itself elsewhere."""
    return pkey(name) if WINDOWS else name


def slug_key(slug):
    """What two slugs are compared on: their first 200 chars, and on Windows without regard to case (the drive
    letter of a cwd is e: in one session and E: in the next, and both are the same project folder there)."""
    key = slug if len(slug) <= SLUG_MAX else slug[:SLUG_MAX]
    return key.lower() if WINDOWS else key


def collapse(text):
    return " ".join(text.split())


def clip(text, limit):
    if text is None:
        return None
    text = collapse(text)
    if len(text) <= limit:
        return text
    return text[: limit - 1] + "…"


def count_lines(text):
    if not text:
        return 0
    return text.count("\n") + (0 if text.endswith("\n") else 1)


def read_text(path, limit=None):
    """A file as text for scanning: always UTF-8, whatever the locale; bytes that are not UTF-8 become U+FFFD."""
    with open(path, "rb") as fh:
        data = fh.read() if limit is None else fh.read(limit)
    return data.decode("utf-8", errors="replace")


def read_text_exact(path):
    """A file as text for editing in place: bytes that are not UTF-8 survive a round trip through
    _write_text_keep_mode unchanged (surrogateescape), so a file in another encoding is never mangled."""
    with open(path, "rb") as fh:
        return fh.read().decode("utf-8", errors="surrogateescape")


def json_bytes(doc, **kw):
    """JSON as UTF-8 bytes. A string with a lone surrogate (a file name Windows allows, half an emoji cut off in
    a transcript, a line kept by read_text_exact) has no UTF-8 form; the whole document is then written with
    ASCII escapes instead, which parses to the same value."""
    try:
        return json.dumps(doc, ensure_ascii=False, **kw).encode("utf-8")
    except UnicodeEncodeError:
        return json.dumps(doc, ensure_ascii=True, **kw).encode("ascii")


def safe_listdir(path, warnings=None):
    try:
        return sorted(os.listdir(path))
    except FileNotFoundError:
        return []
    except OSError as exc:
        if warnings is not None:
            warnings.add("无法读取目录 %s：%s" % (path, exc.strerror or exc))
        return []


def _is_junction(st):
    """Windows: a directory junction (a mount-point reparse point). os.path.islink says no to these."""
    return getattr(st, "st_reparse_tag", 0) == getattr(stat, "IO_REPARSE_TAG_MOUNT_POINT", 0xA0000003)


def is_link(path):
    """A symlink, or on Windows a junction: something to move, count or list as itself and never walk into."""
    if os.path.islink(path):
        return True
    if WINDOWS:
        try:
            return _is_junction(os.lstat(path))
        except OSError:
            return False
    return False


def _alloc(st):
    """Bytes a file takes on disk: st_blocks × 512 where the platform reports blocks. Windows does not; there it
    is the file's logical size, and a directory or link counts 0."""
    blocks = getattr(st, "st_blocks", None)
    if blocks is not None:
        return blocks * 512
    return st.st_size if stat.S_ISREG(st.st_mode) else 0


def du(path):
    """Allocated bytes of a file or tree; symlinks (and junctions) are counted as links, never followed."""
    try:
        st = os.lstat(path)
    except OSError:
        return 0
    total = _alloc(st)
    if stat.S_ISDIR(st.st_mode) and not _is_junction(st):
        stack = [path]
        while stack:
            d = stack.pop()
            try:
                it = os.scandir(d)
            except OSError:
                continue
            with it:
                for e in it:
                    try:
                        est = e.stat(follow_symlinks=False)
                    except OSError:
                        continue
                    total += _alloc(est)
                    if stat.S_ISDIR(est.st_mode) and not _is_junction(est):
                        stack.append(e.path)
    return total


def kind_for(cwd, slug, tmp=None):
    """project | scratch | tmp, from the cwd when there is one, else from the folder slug. `tmp`: temp_roots()."""
    tmp = tmp or ("/tmp", "/private/tmp")
    if cwd:
        if pkey("/Claude/scratch-workspaces/") in pkey(cwd):
            return "scratch"
        if any(under(cwd, t) for t in tmp):
            return "tmp"
        return "project"
    sk = name_key(slug)
    if name_key("-Claude-scratch-workspaces-") in sk:
        return "scratch"
    for t in tmp:
        ts = name_key(slugify(t))
        if sk == ts or sk.startswith(ts + "-"):
            return "tmp"
    return "project"


def scratch_roots(home, env=None):
    """Folders holding the desktop app's scratch workspaces (<root>/*/*/scratch-*).
    macOS: <home>/Library/Application Support/Claude/scratch-workspaces.
    Windows: %APPDATA%/Claude/scratch-workspaces, and because the app may run in an MSIX container, every
    <LocalAppData>/Packages/<package>/LocalCache/Roaming/Claude/scratch-workspaces that exists."""
    if not WINDOWS:
        return [pjoin(home, "Library", "Application Support", "Claude", "scratch-workspaces")]
    env = os.environ if env is None else env
    roots = []

    def add(p):
        if p and pkey(p) not in [pkey(r) for r in roots]:
            roots.append(p)

    tail = ("Claude", "scratch-workspaces")
    appdata = fwd(env.get("APPDATA") or "").rstrip("/")
    if appdata:
        add(pjoin(appdata, *tail))
    add(pjoin(home, "AppData", "Roaming", *tail))
    local = fwd(env.get("LOCALAPPDATA") or "").rstrip("/")
    for packages in ([pjoin(local, "Packages")] if local else []) + [pjoin(home, "AppData", "Local", "Packages")]:
        for name in safe_listdir(packages):
            r = pjoin(packages, name, "LocalCache", "Roaming", *tail)
            if os.path.isdir(r):
                add(r)
    return roots


def scratch_aliases(path, roots):
    """The spellings one scratch workspace can have in a transcript: the same sub-path under each root (on
    Windows a session inside the MSIX container sees .../AppData/Roaming/Claude/..., a process outside it sees
    .../Packages/<package>/LocalCache/Roaming/Claude/...). `path` first; on macOS there is only `path`."""
    out = [path]
    for r in roots:
        r = r.rstrip("/")
        if under(path, r) and not same_path(path, r):
            rel = path[len(r):]
            for other in roots:
                alias = other.rstrip("/") + rel
                if pkey(alias) not in [pkey(o) for o in out]:
                    out.append(alias)
            break
    return out


def _write_bytes_atomic(path, data, mode=None):
    d = pdirname(path) or "."
    fd, tmp = tempfile.mkstemp(prefix=".atlas-", suffix=".tmp", dir=d)
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        if mode is not None:
            os.chmod(tmp, mode)
        os.replace(tmp, path)
        tmp = None
    finally:
        if tmp and os.path.exists(tmp):
            try:
                _unlink(tmp)
            except OSError:
                pass


def _write_json_atomic(path, doc):
    _write_bytes_atomic(path, json_bytes(doc, indent=1), 0o644)


def _write_text_keep_mode(path, text):
    """Write text read with read_text_exact back (UTF-8; bytes that were not UTF-8 go back as they were)."""
    target = real(path) if os.path.islink(path) else path
    mode = None
    if os.path.exists(target):
        mode = stat.S_IMODE(os.stat(target).st_mode)
    _write_bytes_atomic(target, text.encode("utf-8", errors="surrogateescape"), mode if mode is not None else 0o644)


# ---------------------------------------------------------------- frontmatter


def _unquote(v):
    v = v.strip()
    if len(v) >= 2 and v[0] == '"' and v[-1] == '"':
        inner = v[1:-1]
        try:
            out = json.loads('"' + inner + '"', strict=False)
            if isinstance(out, str):
                return out
        except ValueError:
            pass
        return inner.replace('\\"', '"').replace("\\\\", "\\")
    if len(v) >= 2 and v[0] == "'" and v[-1] == "'":
        return v[1:-1].replace("''", "'")
    return v


def _fold_block(lines, literal):
    body = list(lines)
    indents = [len(ln) - len(ln.lstrip(" \t")) for ln in body if ln.strip()]
    cut = min(indents) if indents else 0
    body = [ln[cut:] if ln.strip() else "" for ln in body]
    if literal:
        return "\n".join(body).strip("\n")
    # Folded: lines of a paragraph join with a space; each blank line becomes one newline.
    out = ""
    para = []
    for ln in body:
        if ln.strip():
            para.append(ln.strip())
        elif para:
            out += " ".join(para) + "\n"
            para = []
        elif out:
            out += "\n"
    if para:
        out += " ".join(para)
    return out.strip("\n")


def parse_frontmatter(text):
    """Return (has_frontmatter, data, body_lines). data: str values, one nested dict level."""
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    if not lines or lines[0].lstrip("﻿").rstrip() != "---":
        return False, {}, lines
    end = None
    for i in range(1, len(lines)):
        s = lines[i].rstrip()
        if s == "---" or s == "...":
            end = i
            break
    if end is None:
        return False, {}, lines
    fm = lines[1:end]
    data = {}
    i = 0
    while i < len(fm):
        line = fm[i]
        if not line.strip() or line.lstrip().startswith("#") or line[0] in " \t":
            i += 1
            continue
        m = _FM_KEY_RE.match(line)
        if not m:
            i += 1
            continue
        key = m.group(1)
        val = (m.group(2) or "").strip()
        j = i + 1
        block = []
        while j < len(fm) and (not fm[j].strip() or fm[j][0] in " \t"):
            block.append(fm[j])
            j += 1
        while block and not block[-1].strip():
            block.pop()
        if val and _BLOCK_RE.match(val):
            data[key] = _fold_block(block, literal=val[0] == "|")
        elif val == "":
            nested = {}
            for b in block:
                mm = _FM_KEY_RE.match(b.strip())
                if mm and b.strip():
                    nested[mm.group(1)] = _unquote(mm.group(2) or "")
            if nested:
                data[key] = nested
            else:
                data[key] = " ".join(b.strip() for b in block if b.strip())
        else:
            if block:
                val = val + " " + " ".join(b.strip() for b in block if b.strip())
            data[key] = _unquote(val)
        i = j
    return True, data, lines[end + 1:]


def _fm_str(data, key):
    v = data.get(key)
    if isinstance(v, str) and v.strip():
        return v.strip()
    return None


def first_body_line(body_lines):
    for ln in body_lines:
        s = ln.strip()
        if not s:
            continue
        s = s.lstrip("#").strip()
        if s:
            return s
    return None


def first_heading(body_lines):
    for ln in body_lines:
        s = ln.strip()
        if s.startswith("# "):
            return s[2:].strip() or None
    return None


# ---------------------------------------------------------------- memory


def read_memory_file(path, name, linked, warnings):
    try:
        st = os.stat(path)
        text = read_text(path)
    except OSError as exc:
        warnings.add("无法读取记忆文件 %s：%s" % (path, exc.strerror or exc))
        return None
    has_fm, fm, body = parse_frontmatter(text)
    stem = os.path.splitext(pbasename(name))[0]
    title = _fm_str(fm, "name") or stem
    desc = _fm_str(fm, "description") or first_body_line(body)
    mtype = None
    meta = fm.get("metadata")
    if isinstance(meta, dict) and isinstance(meta.get("type"), str) and meta["type"].strip():
        mtype = meta["type"].strip()
    elif _fm_str(fm, "type"):
        mtype = _fm_str(fm, "type")
    symlink_to = None
    if os.path.islink(path):
        symlink_to = real(path)
    return {
        "name": name,
        "path": path,
        "size": st.st_size,
        "mtimeMs": mtime_ms(st),
        "hasFrontmatter": has_fm,
        "title": title,
        "description": clip(desc, MEMORY_DESC_LIMIT),
        "type": mtype,
        "linked": linked,
        "symlinkTo": symlink_to,
    }


def parse_links(text):
    out = []
    seen = set()
    for m in _LINK_RE.finditer(text):
        target = m.group(1) or m.group(2)
        if "%" in target:
            try:
                from urllib.parse import unquote

                target = unquote(target)
            except Exception:
                pass
        target = fwd(target)
        if target.startswith("/") or target.startswith("~") or re.match(r"^[A-Za-z][A-Za-z0-9+.\-]*:", target):
            continue
        norm = pnorm(target)
        if norm not in seen:
            seen.add(norm)
            out.append(norm)
    return out


def scan_project_memory(mdir, warnings):
    """Return (memory_files, index) for a project's memory dir."""
    index_key = name_key("MEMORY.md")
    names = [n for n in safe_listdir(mdir, warnings) if n.endswith(".md") and not n.startswith(".") and name_key(n) != index_key]
    index_path = pjoin(mdir, "MEMORY.md")
    links = []
    index = {
        "exists": False,
        "path": index_path,
        "lines": 0,
        "bytes": 0,
        "overLineLimit": False,
        "overByteLimit": False,
        "links": [],
        "deadLinks": [],
        "orphans": [],
    }
    if os.path.isfile(index_path):
        try:
            st = os.stat(index_path)
            text = read_text(index_path)
            links = parse_links(text)
            index["exists"] = True
            index["lines"] = count_lines(text)
            index["bytes"] = st.st_size
            index["overLineLimit"] = index["lines"] > INDEX_LINE_LIMIT
            index["overByteLimit"] = index["bytes"] > INDEX_BYTE_LIMIT
            index["links"] = links
            index["deadLinks"] = [l for l in links if not os.path.exists(pjoin(mdir, l))]
        except OSError as exc:
            warnings.add("无法读取 %s：%s" % (index_path, exc.strerror or exc))
    linkset = set(name_key(l) for l in links)
    files = []
    for n in names:
        p = pjoin(mdir, n)
        if not os.path.isfile(p):
            if os.path.islink(p):
                warnings.add("记忆文件是失效的符号链接：%s" % p)
            continue
        mf = read_memory_file(p, n, name_key(n) in linkset, warnings)
        if mf:
            files.append(mf)
    files.sort(key=lambda f: (-f["mtimeMs"], f["name"]))
    index["orphans"] = [f["name"] for f in files if not f["linked"]]
    return files, index


def scan_custom_memory(claude_dir, warnings):
    out = []
    for folder in ("shared-memory", "memory-archive"):
        root = pjoin(claude_dir, folder)
        if not os.path.isdir(root):
            continue
        files = []
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = sorted(d for d in dirnames if not d.startswith("."))
            for fn in sorted(filenames):
                if not fn.endswith(".md") or fn.startswith("."):
                    continue
                p = pjoin(dirpath, fn)
                rel = fwd(os.path.relpath(p, root))
                mf = read_memory_file(p, rel, True, warnings)
                if mf:
                    files.append(mf)
        files.sort(key=lambda f: f["name"])
        out.append({"name": folder, "path": root, "files": files, "index": None})
    return out


# ---------------------------------------------------------------- transcripts


def _memory_path_filter(claude_dirs):
    prefixes = [pkey(cd).rstrip("/") for cd in claude_dirs]
    claude_md = (name_key("CLAUDE.md"), name_key("CLAUDE.local.md"))

    def is_memory_path(p):
        if name_key(pbasename(p)) in claude_md:
            return True
        pk = pkey(p)
        for cd in prefixes:
            if pk.startswith(cd + "/shared-memory/") or pk.startswith(cd + "/memory-archive/"):
                return True
            if pk.startswith(cd + "/projects/"):
                rest = pk[len(cd) + len("/projects/"):].split("/")
                if len(rest) >= 3 and rest[1] == "memory":
                    return True
        return False

    return is_memory_path


def _add_unique(lst, item, limit=None):
    if item in lst:
        return
    if limit is not None and len(lst) >= limit:
        return
    lst.append(item)


def _bump(d, key):
    d[key] = d.get(key, 0) + 1


def _user_text(content):
    """Text of a user message: the string content, or the first text block of a list content
    (None when the list carries a tool_result, i.e. it is not a prompt)."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        for b in content:
            if isinstance(b, dict) and b.get("type") == "tool_result":
                return None
        for b in content:
            if isinstance(b, dict) and b.get("type") == "text" and isinstance(b.get("text"), str):
                return b["text"]
    return None


def _tail_version(path, size):
    if size <= 0:
        return None
    chunk = min(size, TAIL_BYTES)
    try:
        with open(path, "rb") as fh:
            fh.seek(size - chunk)
            data = fh.read(chunk)
    except OSError:
        return None
    lines = data.split(b"\n")
    if size > chunk:
        lines = lines[1:]
    for raw in reversed(lines):
        if b'"version"' not in raw:
            continue
        try:
            r = json.loads(raw)
        except ValueError:
            continue
        if isinstance(r, dict) and isinstance(r.get("version"), str):
            return r["version"]
    return None


def _bash_unquote(tok):
    if len(tok) >= 2 and tok[0] == tok[-1] and tok[0] in "\"'":
        return tok[1:-1]
    return re.sub(r"\\(.)", r"\1", tok)


def bash_io_dirs(command, home):
    """Best-effort (kind, dir) pairs from a Bash command (absolute or ~ paths only):
    "r" for a dir it cd's into, "w" for the parent dir of a redirect or -o/--output target.
    On Windows the command runs in Git Bash: C:/x, a quoted C:\\x, /c/x and /tmp/x are all taken as drive paths."""
    out = []
    if not isinstance(command, str) or not command:
        return out

    def norm(tok):
        p = fwd(_bash_unquote(tok))
        if p.startswith("~/") or p == "~":
            p = home + p[1:]
        p = from_msys(p, home)
        if not is_abs(p):
            return None
        p = pnorm(p)
        if p == "/dev" or p.startswith("/dev/"):
            return None
        return p

    for m in _BASH_CD.finditer(command):
        p = norm(m.group(1))
        if p:
            out.append(("r", p))
    for rx in (_BASH_REDIR, _BASH_OUT):
        for m in rx.finditer(command):
            p = norm(m.group(1))
            if p:
                out.append(("w", pdirname(p) or "/"))
    return out


def _io_add(io, kind, d, ts, bash):
    bucket = io[kind]
    e = bucket.get(d)
    if e is None:
        bucket[d] = [1, ts or 0, 1 if bash else 0]
    else:
        e[0] += 1
        if ts and ts > e[1]:
            e[1] = ts
        if bash:
            e[2] = 1


def collect_tool_io(name, inp, ts, cwd, home, io):
    def absolute(p):
        if not isinstance(p, str) or not p:
            return None
        p = fwd(p)
        if p.startswith("~/"):
            p = home + p[1:]
        p = from_msys(p, home)
        if not is_abs(p):
            if not cwd:
                return None
            p = pjoin(cwd, p)
        return pnorm(p)

    if name == "Read":
        p = absolute(inp.get("file_path"))
        if p:
            _io_add(io, "r", pdirname(p) or "/", ts, False)
    elif name in WRITE_TOOLS:
        p = absolute(inp.get("file_path"))
        if p:
            _io_add(io, "w", pdirname(p) or "/", ts, False)
    elif name == "NotebookEdit":
        p = absolute(inp.get("notebook_path"))
        if p:
            _io_add(io, "w", pdirname(p) or "/", ts, False)
    elif name in ("Glob", "Grep"):
        p = absolute(inp.get("path"))
        if p:
            _io_add(io, "r", p, ts, False)
    elif name == "Bash":
        for kind, d in bash_io_dirs(inp.get("command"), home):
            _io_add(io, kind, d, ts, True)


def _cap_io(io):
    out = {}
    for kind in ("r", "w"):
        items = sorted(io[kind].items(), key=lambda kv: (-kv[1][0], -kv[1][1], kv[0]))[:IO_CACHE_CAP]
        out[kind] = dict(items)
    return out


def _seen(d, key, ts):
    e = d.get(key)
    if e is None:
        d[key] = [ts, ts]
        return
    if ts is not None:
        if e[0] is None or ts < e[0]:
            e[0] = ts
        if e[1] is None or ts > e[1]:
            e[1] = ts


def parse_transcript(path, size, is_memory_path, home):
    s = {
        "firstCwd": None,
        "entrypoint": None,
        "startedMs": None,
        "version": None,
        "cwdCounts": {},
        "customTitle": None,
        "aiTitle": None,
        "firstPrompt": None,
        "loads": [],
        "listingInitial": None,
        "listingLater": [],
        "toolSkills": {},
        "commands": {},
        "memoryReads": [],
        "memoryWrites": [],
        "pathSeen": {},
        "relocated": {},
        "nested": [],
        "io": {"r": {}, "w": {}},
    }
    load_paths = set()
    last_version = None
    last_ts = None
    need_head = True
    line_no = 0
    with open(path, "rb") as fh:
        for raw in fh:
            line_no += 1
            if need_head and line_no > _HEAD_LINE_CAP:
                need_head = False

            sig_cwd = None
            if b'"cwd":"' in raw:
                m = _CWD_SIG.search(raw)
                if m:
                    try:
                        sig_cwd = fwd(json.loads(b'"' + m.group(2) + b'"'))
                    except ValueError:
                        sig_cwd = None
                    i = raw.rfind(b'"timestamp":"', 0, m.start())
                    sig_ts = None
                    if i >= 0:
                        j = raw.find(b'"', i + 13)
                        sig_ts = iso_ms(raw[i + 13:j].decode("ascii", "replace"))
                    if isinstance(sig_cwd, str) and sig_cwd:
                        if sig_ts is not None:
                            last_ts = sig_ts
                        _bump(s["cwdCounts"], sig_cwd)
                        if sig_cwd in s["pathSeen"] or len(s["pathSeen"]) < PATHS_PER_SESSION_CAP:
                            _seen(s["pathSeen"], sig_cwd, sig_ts)
                        if s["firstCwd"] is None:
                            s["firstCwd"] = sig_cwd
                            s["entrypoint"] = m.group(1).decode("utf-8", "replace") or None
                    else:
                        sig_cwd = None

            interesting = False
            for marker in _INTERESTING:
                if marker in raw:
                    interesting = True
                    break
            if not interesting and not need_head:
                if s["firstPrompt"] is not None:
                    continue
                if not (_USER_MARKERS[0] in raw or _USER_MARKERS[1] in raw):
                    continue
            try:
                r = json.loads(raw)
            except ValueError:
                continue
            if not isinstance(r, dict):
                continue
            t = r.get("type")
            ts = iso_ms(r.get("timestamp"))
            if ts is not None:
                last_ts = ts
                if s["startedMs"] is None:
                    s["startedMs"] = ts
            cwd = fwd(r.get("cwd"))
            if isinstance(cwd, str) and cwd and sig_cwd is None:
                _bump(s["cwdCounts"], cwd)
                if cwd in s["pathSeen"] or len(s["pathSeen"]) < PATHS_PER_SESSION_CAP:
                    _seen(s["pathSeen"], cwd, ts)
                if s["firstCwd"] is None:
                    s["firstCwd"] = cwd
                    ep = r.get("entrypoint")
                    s["entrypoint"] = ep if isinstance(ep, str) else None
            if isinstance(r.get("version"), str):
                last_version = r["version"]
            if need_head and s["firstCwd"] is not None and s["startedMs"] is not None:
                need_head = False

            if t == "custom-title":
                v = r.get("customTitle")
                if isinstance(v, str) and v.strip():
                    s["customTitle"] = v.strip()
            elif t == "ai-title":
                v = r.get("aiTitle")
                if isinstance(v, str) and v.strip():
                    s["aiTitle"] = v.strip()
            elif t == "relocated":
                v = r.get("relocatedCwd")
                if is_abs(v):
                    _seen(s["relocated"], pnorm(v), last_ts)
            elif t == "attachment":
                a = r.get("attachment")
                if not isinstance(a, dict):
                    continue
                at = a.get("type")
                if at == "instructions":
                    for f in a.get("files") or []:
                        if not isinstance(f, dict) or not isinstance(f.get("path"), str):
                            continue
                        lp = fwd(f["path"])
                        if lp in load_paths:
                            continue
                        load_paths.add(lp)
                        ft = f.get("type")
                        s["loads"].append({"path": lp, "type": ft if isinstance(ft, str) else None})
                elif at == "skill_listing":
                    names = [n for n in (a.get("names") or []) if isinstance(n, str) and n]
                    if a.get("isInitial"):
                        uniq = []
                        for n in names:
                            _add_unique(uniq, n)
                        s["listingInitial"] = uniq
                        s["listingLater"] = []
                    else:
                        for n in names:
                            _add_unique(s["listingLater"], n)
                elif at == "nested_memory":
                    p = a.get("path")
                    if is_abs(p):
                        _add_unique(s["nested"], pnorm(p), NESTED_CAP)
            elif t == "assistant":
                msg = r.get("message")
                content = msg.get("content") if isinstance(msg, dict) else None
                if not isinstance(content, list):
                    continue
                for b in content:
                    if not isinstance(b, dict) or b.get("type") != "tool_use":
                        continue
                    name = b.get("name")
                    inp = b.get("input")
                    if not isinstance(inp, dict):
                        continue
                    if name == "Skill":
                        sk = inp.get("skill")
                        if isinstance(sk, str) and sk.strip().lstrip("/"):
                            _bump(s["toolSkills"], sk.strip().lstrip("/"))
                        continue
                    collect_tool_io(name, inp, ts, s["firstCwd"], home, s["io"])
                    if name == "Read" or name in WRITE_TOOLS:
                        fp = inp.get("file_path")
                        if not isinstance(fp, str) or not fp:
                            continue
                        fp = from_msys(fwd(fp), home)
                        if not is_abs(fp):
                            fp = pjoin(s["firstCwd"] or "", fp)
                        fp = pnorm(fp)
                        if not is_memory_path(fp):
                            continue
                        key = "memoryReads" if name == "Read" else "memoryWrites"
                        _add_unique(s[key], fp, MAX_MEMORY_PATHS)
            elif t == "user":
                msg = r.get("message")
                content = msg.get("content") if isinstance(msg, dict) else None
                text = _user_text(content)
                if not isinstance(text, str):
                    continue
                stripped = text.lstrip()
                if stripped.startswith("<command-"):
                    for cm in _COMMAND_RE.findall(stripped):
                        cname = cm.strip().lstrip("/")
                        if cname:
                            _bump(s["commands"], cname)
                if (
                    s["firstPrompt"] is None
                    and not r.get("isMeta")
                    and not r.get("isCompactSummary")
                    and stripped
                    and not stripped.startswith("<")
                ):
                    s["firstPrompt"] = clip(stripped, TITLE_PROMPT_LIMIT)
    s["version"] = _tail_version(path, size) or last_version
    s["io"] = _cap_io(s["io"])
    return s


def parse_subagent(path, home):
    skills = {}
    io = {"r": {}, "w": {}}
    cwd = None
    with open(path, "rb") as fh:
        for raw in fh:
            if cwd is None and b'"cwd":"' in raw:
                m = _CWD_SIG.search(raw)
                if m:
                    try:
                        cwd = fwd(json.loads(b'"' + m.group(2) + b'"'))
                    except ValueError:
                        cwd = None
            hit = False
            for marker in _SUB_INTERESTING:
                if marker in raw:
                    hit = True
                    break
            if not hit:
                continue
            try:
                r = json.loads(raw)
            except ValueError:
                continue
            if not isinstance(r, dict) or r.get("type") != "assistant":
                continue
            if cwd is None and isinstance(r.get("cwd"), str):
                cwd = fwd(r["cwd"])
            msg = r.get("message")
            content = msg.get("content") if isinstance(msg, dict) else None
            if not isinstance(content, list):
                continue
            ts = iso_ms(r.get("timestamp"))
            for b in content:
                if not isinstance(b, dict) or b.get("type") != "tool_use":
                    continue
                inp = b.get("input")
                if not isinstance(inp, dict):
                    continue
                if b.get("name") == "Skill":
                    sk = inp.get("skill")
                    if isinstance(sk, str) and sk.strip().lstrip("/"):
                        _bump(skills, sk.strip().lstrip("/"))
                else:
                    collect_tool_io(b.get("name"), inp, ts, cwd, home, io)
    return {"toolSkills": skills, "io": _cap_io(io)}


# ---------------------------------------------------------------- cache


def parser_tag():
    """The cache's format stamp. On Windows it also names the path form, so a cache written by a version that
    kept backslashes is never reused."""
    return "%d-nt1" % PARSER_VERSION if WINDOWS else PARSER_VERSION


class Cache(object):
    def __init__(self, path, claude_dir, warnings):
        self.path = path
        self.claude_dir = claude_dir
        self.warnings = warnings
        self.old = {}
        self.new = {}
        self.home_scan = None
        self.home_scan_changed = False
        self.dirty = False
        self._load()

    def _load(self):
        if not self.path or not os.path.exists(self.path):
            return
        try:
            with open(self.path, "rb") as fh:
                doc = json.loads(fh.read())
        except (OSError, ValueError) as exc:
            self.warnings.add("缓存文件损坏，已重建：%s" % exc)
            self.dirty = True
            return
        if (
            not isinstance(doc, dict)
            or doc.get("parser") != parser_tag()
            or doc.get("claudeDir") != self.claude_dir
            or not isinstance(doc.get("files"), dict)
        ):
            self.dirty = True
            return
        self.old = doc["files"]
        hs = doc.get("homeScan")
        if isinstance(hs, dict) and isinstance(hs.get("key"), str) and isinstance(hs.get("dirs"), list):
            self.home_scan = hs

    def get(self, path, st, kind, parse):
        size = st.st_size
        mt = mtime_ms(st)
        ent = self.old.get(path)
        if (
            isinstance(ent, dict)
            and ent.get("size") == size
            and ent.get("mtimeMs") == mt
            and ent.get("kind") == kind
            and isinstance(ent.get("summary"), dict)
        ):
            self.new[path] = ent
            return ent["summary"]
        summary = parse()
        # Round-trip so a fresh summary is byte-identical to a cached one.
        summary = json.loads(json.dumps(summary, ensure_ascii=False))
        self.new[path] = {"size": size, "mtimeMs": mt, "kind": kind, "summary": summary}
        self.dirty = True
        return summary

    def get_home_scan(self, key):
        if self.home_scan and self.home_scan.get("key") == key:
            return self.home_scan["dirs"]
        return None

    def set_home_scan(self, key, dirs):
        self.home_scan = {"key": key, "dirs": dirs}
        self.home_scan_changed = True

    def save(self):
        if not self.path:
            return
        if not self.dirty and not self.home_scan_changed and set(self.new) == set(self.old):
            return
        doc = {"version": VERSION, "parser": parser_tag(), "claudeDir": self.claude_dir, "files": self.new}
        if self.home_scan:
            doc["homeScan"] = self.home_scan
        data = json_bytes(doc, separators=(",", ":"))
        try:
            os.makedirs(pdirname(self.path) or ".", exist_ok=True)
            _write_bytes_atomic(self.path, data)
        except OSError as exc:
            self.warnings.add("无法写入缓存 %s：%s" % (self.path, exc.strerror or exc))


# ---------------------------------------------------------------- skills


def _skill_entry(name, source, path, plugin=None, project_cwd=None, warnings=None):
    desc = None
    if path:
        try:
            _, fm, _ = parse_frontmatter(read_text(path))
            desc = clip(_fm_str(fm, "description"), SKILL_DESC_LIMIT)
        except OSError as exc:
            if warnings is not None:
                warnings.add("无法读取技能文件 %s：%s" % (path, exc.strerror or exc))
    return {
        "name": name,
        "source": source,
        "path": path,
        "description": desc,
        "plugin": plugin,
        "projectCwd": project_cwd,
        "useCount": 0,
        "sessionsUsing": 0,
        "lastUsedMs": None,
        "listedIn": 0,
    }


def _skill_dirs(root, warnings, skip=()):
    out = []
    for n in safe_listdir(root, warnings):
        if n.startswith(".") or n in skip:
            continue
        p = pjoin(root, n, "SKILL.md")
        if os.path.isfile(p):
            out.append((n, p))
    return out


def scan_skill_files(claude_dir, project_cwds, warnings):
    skills = {}

    def add(entry):
        if entry["name"] not in skills:
            skills[entry["name"]] = entry

    skills_root = pjoin(claude_dir, "skills")
    for n, p in _skill_dirs(skills_root, warnings, skip=("synced",)):
        add(_skill_entry(n, "user", p, warnings=warnings))

    claude_real = real(claude_dir)
    for cwd in sorted(set(c for c in project_cwds if c)):
        dot = pjoin(cwd, ".claude")
        if not os.path.isdir(dot) or same_path(real(dot), claude_real):
            continue
        for n, p in _skill_dirs(pjoin(dot, "skills"), warnings):
            add(_skill_entry(n, "project", p, project_cwd=cwd, warnings=warnings))

    ip_path = pjoin(claude_dir, "plugins", "installed_plugins.json")
    if os.path.isfile(ip_path):
        try:
            with open(ip_path, "rb") as fh:
                ip = json.loads(fh.read())
        except (OSError, ValueError) as exc:
            warnings.add("无法解析 installed_plugins.json：%s" % exc)
            ip = {}
        plugins = ip.get("plugins") if isinstance(ip, dict) else None
        if isinstance(plugins, dict):
            for key in sorted(plugins):
                entries = plugins[key]
                if isinstance(entries, dict):
                    entries = [entries]
                if not isinstance(entries, list):
                    continue
                pname = key.split("@", 1)[0]
                for e in entries:
                    if not isinstance(e, dict) or not isinstance(e.get("installPath"), str):
                        continue
                    pp = fwd(e.get("projectPath")) if isinstance(e.get("projectPath"), str) else None
                    for n, p in _skill_dirs(pjoin(e["installPath"], "skills"), warnings):
                        add(_skill_entry(pname + ":" + n, "plugin", p, plugin=pname, project_cwd=pp, warnings=warnings))

    synced_root = pjoin(skills_root, "synced")
    for bucket in safe_listdir(synced_root, warnings):
        bdir = pjoin(synced_root, bucket)
        if bucket.startswith(".") or not os.path.isdir(bdir):
            continue
        for n, p in _skill_dirs(bdir, warnings):
            add(_skill_entry("anthropic-skills:" + n, "synced", p, warnings=warnings))
    return skills


# ---------------------------------------------------------------- rename tracing


def _subdirs(d):
    """Sub-directories of `d` worth scanning: no dot names, nothing in the skip list, links not followed.
    macOS skips Library and .Trash; Windows skips AppData, anything with the hidden or system attribute
    ($Recycle.Bin, the legacy "Application Data" links) and junctions."""
    skip = [name_key(n) for n in (SCAN_SKIP_WINDOWS if WINDOWS else SCAN_SKIP)]
    out = []
    try:
        it = os.scandir(d)
    except OSError:
        return out
    with it:
        for e in it:
            if e.name.startswith(".") or name_key(e.name) in skip:
                continue
            try:
                if not e.is_dir(follow_symlinks=False):
                    continue
                if WINDOWS:
                    st = e.stat(follow_symlinks=False)
                    if getattr(st, "st_file_attributes", 0) & (_ATTR_HIDDEN | _ATTR_SYSTEM) or _is_junction(st):
                        continue
            except OSError:
                continue
            out.append(fwd(e.path))
    return out


def scan_home_dirs(home):
    """Directories under the home folder to depth 3 (see _subdirs for what is left out)."""
    out = []
    stack = [(home, 1)]
    while stack:
        d, depth = stack.pop()
        for sub in _subdirs(d):
            out.append(sub)
            if depth < SCAN_DEPTH:
                stack.append((sub, depth + 1))
    out.sort()
    return out


def launch_parents(paths):
    """The folders projects were started from: the parent of each given launch path, each once, sorted.
    Used on Windows, where projects usually live on another drive (E:/claude-code/projects/<name>) that the
    home scan never sees; the sub-folders of these parents are slug-match candidates as well."""
    out = {}
    for p in paths:
        if not is_abs(p):
            continue
        p = p.rstrip("/")
        if is_fs_root(p):
            continue
        parent = pdirname(p)
        if parent:
            out.setdefault(pkey(parent), parent)
    return sorted(out.values())


def _file_identity(path):
    try:
        st = os.stat(path)
    except OSError:
        return ("path", pkey(path))
    return (st.st_dev, st.st_ino) if st.st_ino else ("path", pkey(path))


def list_scratch_workspaces(home, roots=None):
    """Every <root>/*/*/scratch-* folder under the scratch roots. With several roots (Windows: the plain
    AppData folder and the MSIX container's copy can be one folder under two names) a folder is listed once."""
    roots = scratch_roots(home) if roots is None else roots
    out = []
    seen = set()
    for root in roots:
        for a in safe_listdir(root):
            pa = pjoin(root, a)
            if a.startswith(".") or not os.path.isdir(pa) or is_link(pa):
                continue
            for b in safe_listdir(pa):
                pb = pjoin(pa, b)
                if b.startswith(".") or not os.path.isdir(pb) or is_link(pb):
                    continue
                for c in safe_listdir(pb):
                    pc = pjoin(pb, c)
                    if c.startswith("scratch-") and os.path.isdir(pc) and not is_link(pc):
                        if len(roots) > 1:
                            ident = _file_identity(pc)
                            if ident in seen:
                                continue
                            seen.add(ident)
                        out.append(pc)
    return out


def choose_project_cwd(slug, summaries):
    counts = {}
    firsts = {}
    for s in summaries:
        for c, n in (s.get("cwdCounts") or {}).items():
            counts[c] = counts.get(c, 0) + n
        fc = s.get("firstCwd")
        if fc:
            firsts[fc] = firsts.get(fc, 0) + 1
            counts.setdefault(fc, 0)
    matching = [c for c in counts if slug_key(slugify(c)) == slug_key(slug)]
    if matching:
        matching.sort(key=lambda c: (-(counts[c] + firsts.get(c, 0)), c))
        return matching[0]
    if firsts:
        return sorted(firsts, key=lambda c: (-firsts[c], c))[0]
    return None


def session_title(s, sid):
    return s.get("customTitle") or s.get("aiTitle") or s.get("firstPrompt") or sid


def skills_available(s):
    out = list(s.get("listingInitial") or [])
    for n in s.get("listingLater") or []:
        _add_unique(out, n)
    return out


def _merge_io(target, io):
    for kind in ("r", "w"):
        for d, (c, ts, b) in (io.get(kind) or {}).items():
            e = target[kind].get(d)
            if e is None:
                target[kind][d] = [c, ts, b]
            else:
                e[0] += c
                if ts > e[1]:
                    e[1] = ts
                if b:
                    e[2] = 1


def _io_out(agg, cap, classify):
    out = {}
    for kind, key in (("w", "writes"), ("r", "reads")):
        rows = [
            {"dir": d, "count": c, "lastMs": ts or None, "class": classify(d), "via": "bash" if b else "tool"}
            for d, (c, ts, b) in agg[kind].items()
        ]
        rows.sort(key=lambda r: (-r["count"], -(r["lastMs"] or 0), r["dir"]))
        out[key] = rows[:cap]
    return out


def io_class(d, claude_keys, project_keys, scratch_keys):
    """claude | project | scratch | external for a directory; the three lists hold pkey()ed roots."""
    dk = pkey(d)
    if not dk:
        return "external"
    for groups, name in ((claude_keys, "claude"), (project_keys, "project"), (scratch_keys, "scratch")):
        for r in groups:
            if r and _under_k(dk, r):
                return name
    return "external"


# ---------------------------------------------------------------- index


def build_index(claude_dir, cache_path, current_cwd):
    t0 = time.time()
    warnings = Warnings()
    if not os.path.isdir(claude_dir):
        raise AtlasError("claude 目录不存在：%s" % claude_dir)
    home = home_dir()
    cache = Cache(cache_path, claude_dir, warnings)
    claude_dirs = [claude_dir]
    claude_real = real(claude_dir)
    if not same_path(claude_real, claude_dir):
        claude_dirs.append(claude_real)
    is_memory_path = _memory_path_filter(claude_dirs)

    gpath = pjoin(claude_dir, "CLAUDE.md")
    gmd = {"path": gpath, "exists": False, "lines": 0, "bytes": 0}
    if os.path.isfile(gpath):
        try:
            gmd["bytes"] = os.stat(gpath).st_size
            gmd["lines"] = count_lines(read_text(gpath))
            gmd["exists"] = True
        except OSError as exc:
            warnings.add("无法读取 %s：%s" % (gpath, exc.strerror or exc))

    projects_dir = pjoin(claude_dir, "projects")
    projects = []
    for slug in safe_listdir(projects_dir, warnings):
        pdir = pjoin(projects_dir, slug)
        if slug.startswith(".") or not os.path.isdir(pdir):
            continue
        entry_sizes = {}
        for n in safe_listdir(pdir):
            entry_sizes[n] = du(pjoin(pdir, n))
        proj_sessions = []
        for fn in safe_listdir(pdir, warnings):
            if not fn.endswith(".jsonl"):
                continue
            fpath = pjoin(pdir, fn)
            try:
                st = os.stat(fpath)
            except OSError as exc:
                warnings.add("无法读取会话文件 %s：%s" % (fpath, exc.strerror or exc))
                continue
            if not os.path.isfile(fpath):
                continue
            sid = fn[: -len(".jsonl")]
            try:
                summ = cache.get(fpath, st, "session", lambda: parse_transcript(fpath, st.st_size, is_memory_path, home))
            except OSError as exc:
                warnings.add("无法读取会话文件 %s：%s" % (fpath, exc.strerror or exc))
                continue
            sub_root = pjoin(pdir, sid, "subagents")
            sub_files = []
            if os.path.isdir(sub_root):
                for dirpath, dirnames, filenames in os.walk(sub_root):
                    dirnames.sort()
                    for sfn in sorted(filenames):
                        if sfn.startswith("agent-") and sfn.endswith(".jsonl"):
                            sub_files.append(pjoin(dirpath, sfn))
            sub_skills = {}
            io = {"r": {}, "w": {}}
            _merge_io(io, summ.get("io") or {})
            for sp in sub_files:
                try:
                    sst = os.stat(sp)
                    ss = cache.get(sp, sst, "subagent", lambda: parse_subagent(sp, home))
                except OSError as exc:
                    warnings.add("无法读取子代理文件 %s：%s" % (sp, exc.strerror or exc))
                    continue
                for n, c in (ss.get("toolSkills") or {}).items():
                    sub_skills[n] = sub_skills.get(n, 0) + c
                _merge_io(io, ss.get("io") or {})
            proj_sessions.append(
                {
                    "id": sid,
                    "path": fpath,
                    "st": st,
                    "summary": summ,
                    "subSkills": sub_skills,
                    "subCount": len(sub_files),
                    "io": io,
                    "diskBytes": entry_sizes.get(fn, 0) + entry_sizes.get(sid, 0),
                }
            )

        cwd = choose_project_cwd(slug, [x["summary"] for x in proj_sessions])
        mdir = pjoin(pdir, "memory")
        if os.path.isdir(mdir):
            mfiles, mindex = scan_project_memory(mdir, warnings)
        else:
            mdir, mfiles, mindex = None, [], None
        last_active = max([mtime_ms(x["st"]) for x in proj_sessions] or [0])

        seen = {}
        launch = set()
        reloc = {}
        for x in proj_sessions:
            s = x["summary"]
            for pth, (a, b) in (s.get("pathSeen") or {}).items():
                _seen(seen, pth, a)
                _seen(seen, pth, b)
            for pth, (a, b) in (s.get("relocated") or {}).items():
                _seen(reloc, pth, a)
                _seen(reloc, pth, b)
                launch.add(pth)
            if s.get("firstCwd"):
                launch.add(s["firstCwd"])
        projects.append(
            {
                "slug": slug,
                "cwd": cwd,
                "label": slug,
                "kind": "project",
                "isCurrent": False,
                "sessionCount": len(proj_sessions),
                "lastActiveMs": last_active,
                "memoryDir": mdir,
                "memoryFiles": mfiles,
                "index": mindex,
                "loads": [],
                "pathHistory": [],
                "resolvedCwd": None,
                "resolution": "missing",
                "relatedSlugs": [],
                "io": {"writes": [], "reads": []},
                "diskBytes": sum(entry_sizes.values()),
                "_sessions": proj_sessions,
                "_seen": seen,
                "_reloc": reloc,
                "_launch": launch,
            }
        )
    by_slug = dict((p["slug"], p) for p in projects)
    slug_names = dict((name_key(p["slug"]), p["slug"]) for p in projects)
    slugkey_to_project = dict((slug_key(p["slug"]), p["slug"]) for p in projects)

    # --- rename tracing
    tmp_roots = temp_roots(home)
    s_roots = scratch_roots(home)
    scratch_list = list_scratch_workspaces(home, s_roots)
    scan_key = "%s|%s" % (home, time.strftime("%Y-%m-%d"))
    home_dirs = cache.get_home_scan(scan_key)
    if home_dirs is None:
        home_dirs = scan_home_dirs(home)
        cache.set_home_scan(scan_key, home_dirs)
    by_slugkey = {}

    def candidate(d, spelled=None):
        found = by_slugkey.setdefault(slug_key(slugify(spelled or d)), [])
        if pkey(d) not in [pkey(x) for x in found]:
            found.append(d)

    for d in home_dirs:
        candidate(d)
    for w in scratch_list:
        for alias in scratch_aliases(w, s_roots):
            candidate(w, alias)
    if WINDOWS:
        # Projects there live outside the home folder as a rule: also look beside every place one was started.
        started = [
            lp
            for p in projects
            for lp in [p["cwd"]] + sorted(p["_launch"])
            if lp and kind_for(lp, "", tmp_roots) == "project"
        ]
        for parent in launch_parents(started)[:LAUNCH_PARENT_CAP]:
            for d in _subdirs(parent):
                candidate(d)

    for p in projects:
        cwd = p["cwd"]
        if cwd and os.path.isdir(cwd):
            p["resolution"], p["resolvedCwd"] = "exists", cwd
            continue
        relocs = sorted(p["_reloc"].items(), key=lambda kv: (-(kv[1][1] or 0), kv[0]))
        hit = [pth for pth, _ in relocs if os.path.isdir(pth)]
        if hit:
            p["resolution"], p["resolvedCwd"] = "relocated", hit[0]
            continue
        cands = [d for d in by_slugkey.get(slug_key(p["slug"]), []) if os.path.isdir(d)]
        if not cands:
            for lp in sorted(p["_launch"]):
                cands = [d for d in by_slugkey.get(slug_key(slugify(lp)), []) if os.path.isdir(d)]
                if cands:
                    break
        if cands:
            p["resolution"], p["resolvedCwd"] = "slug-match", sorted(cands)[0]

    related = dict((p["slug"], set()) for p in projects)
    sid_map = {}
    for p in projects:
        for x in p["_sessions"]:
            sid_map.setdefault(x["id"], set()).add(p["slug"])
    strong = dict((p["slug"], set()) for p in projects)
    for slugs in sid_map.values():
        for a in slugs:
            for b in slugs:
                if a != b:
                    strong[a].add(b)
                    related[a].add(b)
    launch_map = {}
    for p in projects:
        for lp in p["_launch"]:
            launch_map.setdefault(pkey(lp), set()).add(p["slug"])
            other = slugkey_to_project.get(slug_key(slugify(lp)))
            if other and other != p["slug"]:
                related[p["slug"]].add(other)
                related[other].add(p["slug"])
    for slugs in launch_map.values():
        for a in slugs:
            for b in slugs:
                if a != b:
                    related[a].add(b)
    for p in projects:
        if p["resolution"] != "missing":
            continue
        for o in sorted(strong[p["slug"]]):
            q = by_slug[o]
            if q["resolution"] in ("exists", "relocated", "slug-match"):
                p["resolution"], p["resolvedCwd"] = "related", q["resolvedCwd"]
                break
    res_map = {}
    for p in projects:
        if p["resolvedCwd"]:
            res_map.setdefault(pkey(p["resolvedCwd"]), set()).add(p["slug"])
    for slugs in res_map.values():
        for a in slugs:
            for b in slugs:
                if a != b:
                    related[a].add(b)

    for p in projects:
        p["relatedSlugs"] = sorted(related[p["slug"]])
        hist = {}
        for pth, (a, b) in p["_seen"].items():
            hist[pth] = {"path": pth, "firstSeenMs": a, "lastSeenMs": b, "source": "cwd", "launch": pth in p["_launch"]}
        for pth, (a, b) in p["_reloc"].items():
            if pth in hist:
                hist[pth]["launch"] = True
                continue
            hist[pth] = {"path": pth, "firstSeenMs": a, "lastSeenMs": b, "source": "relocated", "launch": True}
        if p["resolution"] == "slug-match" and p["resolvedCwd"] not in hist:
            r = p["resolvedCwd"]
            hist[r] = {"path": r, "firstSeenMs": None, "lastSeenMs": None, "source": "slug-match", "launch": True}
        rows = []
        for h in hist.values():
            rows.append(
                {
                    "path": h["path"],
                    "firstSeenMs": h["firstSeenMs"],
                    "lastSeenMs": h["lastSeenMs"],
                    "exists": os.path.isdir(h["path"]),
                    "source": h["source"],
                    "launch": h["launch"],
                }
            )
        rows.sort(key=lambda h: (0 if h["launch"] else 1, -(h["lastSeenMs"] or 0), h["path"]))
        p["pathHistory"] = rows[:PATH_HISTORY_CAP]
        base = p["resolvedCwd"] or p["cwd"]
        p["label"] = (pbasename(base.rstrip("/")) or base) if base else p["slug"]
        p["kind"] = kind_for(base, p["slug"], tmp_roots)

    # current project
    if current_cwd:
        cur = pnorm(current_cwd)
        cur_slug = slug_key(slugify(cur))
        hit = [p for p in projects if slug_key(p["slug"]) == cur_slug]
        if not hit:
            hit = [p for p in projects if pkey(cur) in (pkey(p["resolvedCwd"]), p["cwd"] and pkey(pnorm(p["cwd"])))]
        if hit:
            hit[0]["isCurrent"] = True

    # ownership / classification helpers
    res_rank = {"exists": 0, "relocated": 1, "slug-match": 1, "related": 2, "missing": 3}
    prefixes = []
    for p in projects:
        roots = set([p["resolvedCwd"]] + list(p["_launch"]))
        for c in roots:
            # a project living at the home folder or at a root (/, or a whole drive) does not claim what is below it
            if c and not is_fs_root(c) and not same_path(c.rstrip("/"), home.rstrip("/")):
                prefixes.append((c.rstrip("/"), res_rank.get(p["resolution"], 3), p["slug"]))
    # longest prefix wins; on a tie (related folders of one renamed project) the one that still exists
    prefixes.sort(key=lambda x: (-len(x[0]), x[1], x[2]))
    prefixes = [(pkey(pre), slug) for pre, _rank, slug in prefixes]
    cd_keys = [pkey(c.rstrip("/")) for c in claude_dirs]

    def owner(path):
        """(scope, slug) for a path: scope global|project|shared-memory|memory-archive|external."""
        if not path:
            return "external", None
        pk = pkey(path)
        for cd in cd_keys:
            if cd and _under_k(pk, cd):
                rest = path[len(cd) + 1:].split("/") if pk != cd else []
                if len(rest) >= 2 and name_key(rest[0]) == "projects" and name_key(rest[1]) in slug_names:
                    return "project", slug_names[name_key(rest[1])]
                if rest and name_key(rest[0]) in ("shared-memory", "memory-archive"):
                    return name_key(rest[0]), None
                return "global", None
        sp = scratchpad_slug(path, tmp_roots)
        if sp and name_key(sp) in slug_names:
            return "project", slug_names[name_key(sp)]
        for pre, slug in prefixes:
            if _under_k(pk, pre):
                return "project", slug
        return "external", None

    scratch_keys = [pkey(r) for r in tmp_roots + s_roots]

    def classifier(p):
        roots = [pkey(r) for r in set([p["resolvedCwd"], p["cwd"]] + list(p["_launch"])) if r]
        return lambda d: io_class(d, cd_keys, roots, scratch_keys)

    # skills from files
    skills = scan_skill_files(claude_dir, [p["resolvedCwd"] for p in projects if p["resolvedCwd"]], warnings)

    known = set(skills)
    for p in projects:
        for x in p["_sessions"]:
            s = x["summary"]
            known.update(skills_available(s))
            known.update((s.get("toolSkills") or {}).keys())
            known.update(x["subSkills"].keys())

    sessions = []
    cross = {}

    def add_cross(a, b, kind, n):
        if not a or not b or a == b or a == "external" or b == "external":
            return
        if a in related and b in related[a]:
            return
        k = (a, b, kind)
        cross[k] = cross.get(k, 0) + n

    for p in projects:
        cls = classifier(p)
        pio = {"r": {}, "w": {}}
        newest_loads = None
        for x in sorted(p["_sessions"], key=lambda x: (-mtime_ms(x["st"]), x["id"])):
            s = x["summary"]
            if newest_loads is None and s.get("loads"):
                newest_loads = s["loads"]
            avail = skills_available(s)
            avail_set = set(avail)
            invoked = []
            for n, c in (s.get("toolSkills") or {}).items():
                invoked.append({"name": n, "count": c, "via": "tool", "inSubagent": False})
            for n, c in (s.get("commands") or {}).items():
                if n in avail_set or n in known:
                    invoked.append({"name": n, "count": c, "via": "command", "inSubagent": False})
            for n, c in x["subSkills"].items():
                invoked.append({"name": n, "count": c, "via": "tool", "inSubagent": True})
            _merge_io(pio, x["io"])
            for kind, label in (("r", "session-read"), ("w", "session-write")):
                for d, (c, _ts, _b) in x["io"][kind].items():
                    sc, sl = owner(d)
                    add_cross(p["slug"], sl if sc == "project" else sc, label, c)
            sessions.append(
                {
                    "id": x["id"],
                    "projectSlug": p["slug"],
                    "path": x["path"],
                    "cwd": s.get("firstCwd"),
                    "title": session_title(s, x["id"]),
                    "startedMs": s.get("startedMs"),
                    "lastMs": mtime_ms(x["st"]),
                    "entrypoint": s.get("entrypoint"),
                    "version": s.get("version"),
                    "loads": s.get("loads") or [],
                    "skillsAvailable": avail,
                    "skillsInvoked": invoked,
                    "memoryReads": (s.get("memoryReads") or [])[:MAX_MEMORY_PATHS],
                    "memoryWrites": (s.get("memoryWrites") or [])[:MAX_MEMORY_PATHS],
                    "subagentCount": x["subCount"],
                    "io": _io_out(x["io"], IO_SESSION_CAP, cls),
                    "diskBytes": x["diskBytes"],
                }
            )
        p["loads"] = newest_loads or []
        p["io"] = _io_out(pio, IO_PROJECT_CAP, cls)

    # skill aggregates (over all sessions, before the output cap)
    for sess in sessions:
        used = set()
        for inv in sess["skillsInvoked"]:
            n = inv["name"]
            if n not in skills:
                skills[n] = _skill_entry(n, "builtin", None)
            sk = skills[n]
            sk["useCount"] += inv["count"]
            used.add(n)
        for n in used:
            sk = skills[n]
            sk["sessionsUsing"] += 1
            if sk["lastUsedMs"] is None or sess["lastMs"] > sk["lastUsedMs"]:
                sk["lastUsedMs"] = sess["lastMs"]
        for n in sess["skillsAvailable"]:
            if n not in skills:
                skills[n] = _skill_entry(n, "builtin", None)
            skills[n]["listedIn"] += 1
    skill_list = sorted(skills.values(), key=lambda k: (-k["useCount"], k["name"]))

    sessions.sort(key=lambda x: (-x["lastMs"], x["id"]))

    custom = scan_custom_memory(claude_dir, warnings)
    docs = build_docs(claude_dir, home, projects, custom, skills, owner, warnings)
    node_by_id = dict((n["id"], n) for n in docs["nodes"])

    def scope_key(n):
        return n["projectSlug"] if n["scope"] == "project" else n["scope"]

    for e in docs["edges"]:
        a, b = node_by_id.get(e["from"]), node_by_id.get(e["to"])
        if a and b:
            add_cross(scope_key(a), scope_key(b), e["type"], 1)
    def nested_pair(a, b):
        pa, pb = by_slug.get(a), by_slug.get(b)
        if not pa or not pb or not pa["resolvedCwd"] or not pb["resolvedCwd"]:
            return False
        return strictly_under(pa["resolvedCwd"], pb["resolvedCwd"]) or strictly_under(pb["resolvedCwd"], pa["resolvedCwd"])

    cross_list = [
        {"from": a, "to": b, "kind": k, "count": n, "nested": nested_pair(a, b)} for (a, b, k), n in cross.items()
    ]
    cross_list.sort(key=lambda c: (-c["count"], c["from"], c["to"], c["kind"]))

    scratch_out = []
    sess_by_project = {}
    for s in sessions:
        sess_by_project.setdefault(s["projectSlug"], []).append(s["id"])
    for w in scratch_list:
        try:
            st = os.stat(w)
        except OSError:
            continue
        ps = None
        for alias in scratch_aliases(w, s_roots):
            ps = slugkey_to_project.get(slug_key(slugify(alias)))
            if ps:
                break
        scratch_out.append(
            {"path": w, "sizeBytes": du(w), "mtimeMs": mtime_ms(st), "projectSlug": ps, "sessionIds": sess_by_project.get(ps, []) if ps else []}
        )
    scratch_out.sort(key=lambda w: (-w["mtimeMs"], w["path"]))

    health = build_health(claude_dir, projects)

    for p in projects:
        for k in ("_sessions", "_seen", "_reloc", "_launch"):
            del p[k]
    projects.sort(
        key=lambda p: (
            0 if p["isCurrent"] else (1 if p["memoryFiles"] else 2),
            -p["lastActiveMs"],
            p["slug"],
        )
    )

    cache.save()

    return {
        "version": VERSION,
        "generatedAtMs": now_ms(),
        "elapsedMs": int((time.time() - t0) * 1000),
        "claudeDir": claude_dir,
        "home": home,
        "warnings": warnings.out(),
        "globalClaudeMd": gmd,
        "projects": projects,
        "customMemory": custom,
        "sessions": sessions[:MAX_SESSIONS],
        "skills": skill_list,
        "health": health,
        "docs": docs,
        "crossProject": cross_list,
        "scratchWorkspaces": scratch_out,
        "trash": trash_summary(claude_dir),
    }


# ---------------------------------------------------------------- document tree


def _strip_code(text):
    out = []
    fence = None
    for line in text.split("\n"):
        s = line.lstrip()
        if fence:
            if s.startswith(fence):
                fence = None
            out.append("")
            continue
        if s.startswith("```") or s.startswith("~~~"):
            fence = s[:3]
            out.append("")
            continue
        out.append(re.sub(r"`[^`\n]*`", "", line))
    return "\n".join(out)


def build_docs(claude_dir, home, projects, custom, skills, owner, warnings):
    nodes = {}
    order = []
    edges = []
    edge_set = set()
    state = {"truncated": False}
    queue = []  # (id, level, as_claude_md)
    info = {}  # id -> {"title": ..., "names": [...]}
    ids = {}  # pkey(path) -> node id: on Windows two spellings of one path are one node
    mem_dir_slug = {}
    for p in projects:
        if p["memoryDir"]:
            mem_dir_slug[pkey(p["memoryDir"])] = p["slug"]
    claude_md = (name_key("CLAUDE.md"), name_key("CLAUDE.local.md"))

    def guess_kind(path):
        d, b = pdirname(path), name_key(pbasename(path))
        if pkey(d) in mem_dir_slug:
            return "memory-index" if b == name_key("MEMORY.md") else "memory"
        sc, _ = owner(path)
        if sc in ("shared-memory", "memory-archive") and path.endswith(".md"):
            return "custom-memory"
        if b in claude_md:
            return "claude-md"
        return "doc"

    def add_node(path, kind=None, scope=None, slug=None, title=None):
        if pkey(path) in ids:
            return ids[pkey(path)]
        if len(order) >= DOC_NODE_CAP:
            state["truncated"] = True
            return None
        if scope is None:
            scope, slug = owner(path)
        exists = os.path.lexists(path)
        is_link = os.path.islink(path)
        nodes[path] = {
            "id": path,
            "path": path,
            "kind": kind or guess_kind(path),
            "scope": scope,
            "projectSlug": slug if scope == "project" else None,
            "exists": exists,
            "isSymlink": is_link,
            "realPath": real(path) if exists else path,
            "title": title or pbasename(path),
        }
        ids[pkey(path)] = path
        order.append(path)
        return path

    def add_edge(a, b, typ):
        if not a or not b or a == b:
            return
        k = (a, b, typ)
        if k in edge_set:
            return
        edge_set.add(k)
        edges.append({"from": a, "to": b, "type": typ})

    # fixed nodes
    g = pjoin(claude_dir, "CLAUDE.md")
    if os.path.lexists(g):
        queue.append((add_node(g, "claude-md", "global", None), 0, True))
    for p in sorted(projects, key=lambda q: q["slug"]):
        r = p["resolvedCwd"]
        if r:
            for rel in ("CLAUDE.md", pjoin(".claude", "CLAUDE.md"), "CLAUDE.local.md"):
                cp = pjoin(r, rel)
                if os.path.lexists(cp) and pkey(cp) not in ids:
                    queue.append((add_node(cp, "claude-md", "project", p["slug"]), 0, True))
        if p["memoryDir"]:
            idx = p["index"]
            if idx and idx["exists"]:
                queue.append((add_node(idx["path"], "memory-index", "project", p["slug"], "MEMORY.md"), 0, False))
            for f in p["memoryFiles"]:
                nid = add_node(f["path"], "memory", "project", p["slug"], f["title"])
                if nid:
                    info[nid] = [f["title"], os.path.splitext(f["name"])[0]]
                queue.append((nid, 0, False))
    for c in custom:
        for f in c["files"]:
            nid = add_node(f["path"], "custom-memory", c["name"], None, f["title"])
            if nid:
                info[nid] = [f["title"], os.path.splitext(pbasename(f["name"]))[0]]
            queue.append((nid, 0, False))
    for k in sorted(skills.values(), key=lambda k: k["name"]):
        if k["source"] == "user" and k["path"]:
            queue.append((add_node(k["path"], "skill", "global", None, k["name"]), 0, False))
        elif k["source"] == "project" and k["path"]:
            sc, sl = owner(k["path"])
            queue.append((add_node(k["path"], "skill", sc, sl, k["name"]), 0, False))
    nested = set()
    for p in projects:
        for x in p["_sessions"]:
            for n in x["summary"].get("nested") or []:
                nested.add(n)
    for n in sorted(nested):
        nid = add_node(n, "claude-md")
        if nid:
            queue.append((nid, 0, True))

    # wikilink name index
    names = {}
    for nid, keys in info.items():
        for k in keys:
            if k:
                names.setdefault(k, []).append(nid)

    def resolve_wiki(name, src):
        cands = names.get(name.strip())
        if not cands:
            return None
        sn = nodes[src]

        def rank(nid):
            n = nodes[nid]
            same = n["scope"] == sn["scope"] and n["projectSlug"] == sn["projectSlug"]
            return (0 if same else (1 if n["scope"] == "shared-memory" else 2), nid)

        return sorted(cands, key=rank)[0]

    done = set()
    qi = 0
    while qi < len(queue):
        nid, level, as_cmd = queue[qi]
        qi += 1
        if not nid or nid in done:
            continue
        done.add(nid)
        n = nodes[nid]
        if not n["exists"]:
            continue
        if n["isSymlink"]:
            rp = n["realPath"]
            tid = add_node(rp)
            add_edge(nid, tid, "symlink")
            if tid:
                queue.append((tid, level, as_cmd or n["kind"] == "claude-md"))
            continue
        path = n["path"]
        if not os.path.isfile(path):
            continue
        try:
            raw = read_text(path, DOC_READ_LIMIT)
        except OSError as exc:
            warnings.add("无法读取 %s：%s" % (path, exc.strerror or exc))
            continue
        has_fm, fm, body = parse_frontmatter(raw)
        if n["title"] == pbasename(path):
            n["title"] = _fm_str(fm, "name") or first_heading(body) or n["title"]
        text = _strip_code(raw)
        base = pdirname(path)
        child_level = level + 1
        read_child = child_level <= 1

        if n["kind"] == "memory-index":
            for l in parse_links(text):
                tid = add_node(pnorm(pjoin(base, l)))
                add_edge(nid, tid, "index")
        else:
            for l in parse_links(text):
                tp = pnorm(pjoin(base, l))
                known_before = pkey(tp) in ids
                tid = add_node(tp)
                add_edge(nid, tid, "link")
                if tid and not known_before and read_child and nodes[tid]["kind"] == "doc":
                    queue.append((tid, child_level, False))
        for w in _WIKI_RE.findall(text):
            tid = resolve_wiki(w, nid)
            add_edge(nid, tid, "wikilink")
        if as_cmd or n["kind"] in ("claude-md", "doc"):
            for tok in _IMPORT_RE.findall(text):
                tok = tok.rstrip(".,:;!?")
                if not tok:
                    continue
                if tok.startswith("~"):
                    tp = expand(tok)
                elif is_abs(tok):
                    tp = tok
                else:
                    tp = pjoin(base, tok)
                tp = pnorm(tp)
                if not (os.path.isfile(tp) or tp.endswith(".md")):
                    continue
                known_before = pkey(tp) in ids
                tid = add_node(tp)
                add_edge(nid, tid, "import")
                if tid and not known_before and read_child:
                    queue.append((tid, child_level, True))

    # nested CLAUDE.md → nearest CLAUDE.md above
    for npath in sorted(nested):
        nid = ids.get(pkey(npath))
        if nid is None:
            continue
        d = pdirname(pdirname(npath))
        prev = None
        while d and d != prev:
            found = None
            for rel in ("CLAUDE.md", pjoin(".claude", "CLAUDE.md")):
                cp = pjoin(d, rel)
                if os.path.isfile(cp):
                    found = cp
                    break
            if found:
                add_edge(nid, add_node(found, "claude-md"), "nested")
                break
            prev, d = d, pdirname(d)

    return {"nodes": [nodes[i] for i in order], "edges": edges, "truncated": state["truncated"]}


# ---------------------------------------------------------------- health


def _issue(severity, kind, slug, path, message):
    return {"severity": severity, "kind": kind, "projectSlug": slug, "path": path, "message": message}


def build_health(claude_dir, projects):
    issues = []
    empty_total = 0
    empty_scratch = 0
    titles = {}
    for p in projects:
        slug = p["slug"]
        if p["resolution"] in ("relocated", "slug-match", "related") and p["cwd"] and not same_path(p["cwd"], p["resolvedCwd"]):
            if under(p["cwd"], p["resolvedCwd"]):
                msg = "记录的工作目录 %s 已不存在，项目文件夹 %s 还在" % (p["cwd"], p["resolvedCwd"])
            else:
                msg = "项目从 %s 改名/移到了 %s" % (p["cwd"], p["resolvedCwd"])
            issues.append(_issue("info", "renamed", slug, p["resolvedCwd"], msg))
        mdir = p["memoryDir"]
        if mdir is None:
            continue
        idx = p["index"]
        files = p["memoryFiles"]
        if not files and not idx["exists"]:
            empty_total += 1
            if p["kind"] in ("scratch", "tmp"):
                empty_scratch += 1
            continue
        if idx["exists"]:
            for dl in idx["deadLinks"]:
                issues.append(_issue("warn", "dead-link", slug, pjoin(mdir, dl), "MEMORY.md 链接了不存在的 %s" % dl))
            by_name = dict((f["name"], f) for f in files)
            for o in idx["orphans"]:
                issues.append(
                    _issue("warn", "orphan", slug, by_name[o]["path"], "%s 没有被 MEMORY.md 链接，启动时不会加载" % o)
                )
            parts = []
            if idx["overLineLimit"]:
                parts.append("%d 行，超出 200 行上限 %d 行（200 行之后不会加载）" % (idx["lines"], idx["lines"] - INDEX_LINE_LIMIT))
            if idx["overByteLimit"]:
                parts.append(
                    "%s 字节，超出 25,000 字节上限 %s 字节" % ("{:,}".format(idx["bytes"]), "{:,}".format(idx["bytes"] - INDEX_BYTE_LIMIT))
                )
            if parts:
                issues.append(_issue("error", "index-over-limit", slug, idx["path"], "MEMORY.md 有 " + "；".join(parts)))
        elif files:
            issues.append(
                _issue("warn", "no-index", slug, mdir, "memory 目录有 %d 个记忆文件，但没有 MEMORY.md" % len(files))
            )
        for f in files:
            if not f["hasFrontmatter"]:
                issues.append(
                    _issue("info", "no-frontmatter", slug, f["path"], "%s 没有 frontmatter（开头的 --- YAML 块）" % f["name"])
                )
            titles.setdefault(f["title"], []).append((p, f))
        if files and p["resolution"] == "missing":
            where = p["cwd"] or p["slug"]
            issues.append(
                _issue(
                    "info",
                    "cwd-missing",
                    slug,
                    p["cwd"] or mdir,
                    "项目有 %d 个记忆文件，但工作目录 %s 已不存在，也没找到改名后的位置" % (len(files), where),
                )
            )
    if empty_total:
        issues.append(
            _issue(
                "info",
                "empty-memory-dir",
                None,
                pjoin(claude_dir, "projects"),
                "%d 个 memory 目录是空的（其中 %d 个属于 scratch/tmp 项目）" % (empty_total, empty_scratch),
            )
        )
    for title in sorted(titles):
        group = titles[title]
        slugs = []
        for p, _ in group:
            if p["slug"] not in slugs:
                slugs.append(p["slug"])
        reals = set(pkey(f["symlinkTo"] or real(f["path"])) for _, f in group)
        if len(slugs) < 2 or len(reals) < 2:
            continue
        labels = []
        for p, _ in group:
            if p["label"] not in labels:
                labels.append(p["label"])
        issues.append(
            _issue(
                "info",
                "same-title",
                None,
                group[0][1]["path"],
                "同名记忆「%s」出现在 %d 个项目：%s" % (title, len(slugs), "、".join(labels)),
            )
        )
    issues.sort(
        key=lambda i: (
            SEVERITY_RANK.get(i["severity"], 9),
            i["projectSlug"] is None,
            i["projectSlug"] or "",
            i["kind"],
            i["path"] or "",
        )
    )
    return issues


# ---------------------------------------------------------------- search


def run_search(claude_dir, query, limit):
    if not os.path.isdir(claude_dir):
        raise AtlasError("claude 目录不存在：%s" % claude_dir)
    targets = []
    g = pjoin(claude_dir, "CLAUDE.md")
    if os.path.isfile(g):
        targets.append((g, None, "global"))
    pdir = pjoin(claude_dir, "projects")
    for slug in safe_listdir(pdir):
        mdir = pjoin(pdir, slug, "memory")
        if slug.startswith(".") or not os.path.isdir(mdir):
            continue
        for n in safe_listdir(mdir):
            p = pjoin(mdir, n)
            if n.endswith(".md") and not n.startswith(".") and os.path.isfile(p):
                targets.append((p, slug, "project"))
    for folder in ("shared-memory", "memory-archive"):
        root = pjoin(claude_dir, folder)
        if not os.path.isdir(root):
            continue
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = sorted(d for d in dirnames if not d.startswith("."))
            for fn in sorted(filenames):
                if fn.endswith(".md") and not fn.startswith("."):
                    targets.append((pjoin(dirpath, fn), None, "custom"))
    q = query.lower()
    results = []
    if q:
        for path, slug, scope in targets:
            if len(results) >= limit:
                break
            try:
                text = read_text(path)
            except OSError:
                continue
            if q not in text.lower():
                continue
            for i, line in enumerate(text.split("\n"), 1):
                if q in line.lower():
                    results.append({"path": path, "projectSlug": slug, "scope": scope, "line": i, "text": clip(line, SEARCH_TEXT_LIMIT)})
                    if len(results) >= limit:
                        break
    return {"query": query, "results": results}


# ---------------------------------------------------------------- trash and archive


def _is_exdev(exc):
    return getattr(exc, "errno", None) == errno.EXDEV or getattr(exc, "winerror", None) == 17


def _unlink(path):
    """os.unlink; on Windows a read-only file (a git object, say) first has its read-only bit cleared."""
    try:
        os.unlink(path)
    except PermissionError:
        if not WINDOWS:
            raise
        os.chmod(path, stat.S_IWRITE)
        os.unlink(path)


def _rmtree(path):
    """shutil.rmtree; on Windows read-only files inside are made writable and removed too."""
    if not WINDOWS:
        shutil.rmtree(path)
        return

    def retry(func, p, exc):
        if func not in (os.unlink, os.rmdir):  # could not even list a folder: nothing to retry
            raise exc if isinstance(exc, BaseException) else exc[1]
        os.chmod(p, stat.S_IWRITE)
        func(p)

    if sys.version_info >= (3, 12):
        shutil.rmtree(path, onexc=retry)
    else:
        shutil.rmtree(path, onerror=retry)


def _tree_sig(root):
    """(number of entries, bytes in regular files) of a tree, links not followed: is a copy whole?"""
    count, size = 0, 0
    stack = [root]
    while stack:
        with os.scandir(stack.pop()) as it:
            for e in it:
                st = e.stat(follow_symlinks=False)
                count += 1
                if stat.S_ISDIR(st.st_mode) and not _is_junction(st):
                    stack.append(e.path)
                elif stat.S_ISREG(st.st_mode):
                    size += st.st_size
    return count, size


def _move_across(src, dst):
    """Move to another volume, where a rename cannot: copy, check the copy, delete the source. A failed copy is
    removed and the source is untouched. If the source then cannot be deleted, the copy is removed again and the
    source stays (a folder already partly deleted is first filled back in from the copy)."""
    if os.path.islink(src):
        os.symlink(os.readlink(src), dst, target_is_directory=os.path.isdir(src))
        try:
            _unlink(src)
        except OSError:
            _unlink(dst)
            raise
        return
    if is_link(src):  # a junction: not something to copy
        raise OSError(errno.EXDEV, "目录联接不能跨卷移动")
    if os.path.isdir(src):
        try:
            shutil.copytree(src, dst, symlinks=True)
            if _tree_sig(src) != _tree_sig(dst):
                raise OSError(errno.EIO, "复制出来的内容和原来的对不上")
        except OSError:
            if os.path.lexists(dst):
                try:
                    _rmtree(dst)
                except OSError:
                    pass
            raise
        try:
            _rmtree(src)
        except OSError as exc:
            try:
                shutil.copytree(dst, src, symlinks=True, dirs_exist_ok=True)
                _rmtree(dst)
            except OSError:
                raise OSError(exc.errno or errno.EIO, "原文件夹没能删干净也没能补回，完整的副本留在 %s" % fwd(dst))
            raise
        return
    try:
        shutil.copy2(src, dst)
        if os.path.getsize(dst) != os.path.getsize(src):
            raise OSError(errno.EIO, "复制出来的文件大小不对")
    except OSError:
        if os.path.lexists(dst):
            try:
                _unlink(dst)
            except OSError:
                pass
        raise
    try:
        _unlink(src)
    except OSError:
        try:
            _unlink(dst)
        except OSError:
            pass
        raise


def _rename(src, dst):
    """The only way trash/archive move anything (tests patch it to simulate EXDEV).
    macOS: os.rename alone, so a target on another volume fails with EXDEV and the caller refuses it.
    Windows: the trash sits on the claude dir's drive and projects usually on another one, so a cross-drive
    move is carried out by _move_across (copy, check, delete) instead of being refused."""
    try:
        os.rename(src, dst)
    except OSError as exc:
        if not (WINDOWS and _is_exdev(exc)):
            raise
        _move_across(src, dst)


def trash_root_of(claude_dir):
    return pjoin(real(claude_dir), TRASH_DIR)


def _read_meta(item_dir):
    with open(pjoin(item_dir, "meta.json"), "rb") as fh:
        meta = json.loads(fh.read())
    if not isinstance(meta, dict) or not isinstance(meta.get("parts"), list):
        raise ValueError("meta.json 格式不对")
    return meta


def _list_trash(root):
    out = []
    for name in safe_listdir(root):
        if not _TRASH_ID_RE.match(name):
            continue
        item = pjoin(root, name)
        if is_link(item) or not os.path.isdir(item):
            continue
        try:
            meta = _read_meta(item)
        except (OSError, ValueError):
            continue
        if meta.get("id") != name:
            continue
        out.append(meta)
    out.sort(key=lambda m: (-(m.get("deletedAtMs") or 0), m.get("id")))
    return out


def _payload_exists(root, meta):
    item = pjoin(root, meta["id"])
    for part in meta.get("parts") or []:
        if not os.path.lexists(pjoin(item, part.get("payload") or "")):
            return False
    return True


def trash_summary(claude_dir):
    root = pjoin(claude_dir, TRASH_DIR)
    items = _list_trash(root) if os.path.isdir(root) else []
    return {"path": root, "items": len(items), "bytes": sum(int(m.get("sizeBytes") or 0) for m in items)}


def cmd_trash_list(claude_dir):
    root = pjoin(claude_dir, TRASH_DIR)
    items = _list_trash(root) if os.path.isdir(root) else []
    out = []
    for m in items:
        m = dict(m)
        m["exists"] = _payload_exists(root, m)
        out.append(m)
    return {"path": root, "items": out, "bytes": sum(int(m.get("sizeBytes") or 0) for m in items)}


def _locate(path):
    """Absolute location of `path` without following a symlink at its last component."""
    if not isinstance(path, str) or not path.strip():
        raise Refused("路径为空")
    p = expand(path)
    if not is_abs(p):
        raise Refused("需要绝对路径")
    p = absp(p)
    base = pbasename(p)
    if not base or base in (".", ".."):
        raise Refused("路径无效")
    parent = real(pdirname(p))
    if WINDOWS:
        base = _disk_name(parent, base)
    return pjoin(parent, base)


def _disk_name(parent, base):
    """Windows: the name as the folder lists it. One file answers to many spellings there (other letter case,
    a trailing dot or space, an 8.3 short name, a ":stream" suffix), and every rule in classify_target is about
    names; a spelling the folder does not list is refused as missing."""
    try:
        names = os.listdir(parent)
    except OSError:
        raise Refused("路径不存在")
    if base in names:
        return base
    hits = [n for n in names if name_key(n) == name_key(base)]
    if len(hits) != 1:
        raise Refused("路径不存在")
    return hits[0]


class TrashContext(object):
    def __init__(self, claude_dir, home, protect, cwds_fn):
        self.cd = real(claude_dir)
        self.root = pjoin(self.cd, TRASH_DIR)
        self.home = home
        spelled = scratch_roots(home)
        self.scratch = []
        for r in spelled:
            r = real(r)
            if pkey(r) not in [pkey(x) for x in self.scratch]:
                self.scratch.append(r)
        # Windows: a workspace's project folder may be named after another spelling of the same root
        self.scratch_spellings = self.scratch + [r for r in spelled if pkey(r) not in [pkey(x) for x in self.scratch]]
        self.protect = protect
        self._cwds_fn = cwds_fn
        self._cwds = None

    def cwds(self):
        if self._cwds is None:
            self._cwds = sorted(set(real(c) for c in self._cwds_fn() if c and os.path.isdir(c)))
        return self._cwds

    def holds_protected(self, project_dir):
        return bool(self.protect) and os.path.lexists(pjoin(project_dir, self.protect + ".jsonl"))

    def workspace_protected(self, loc):
        """Does the project folder of scratch workspace `loc` hold the protected session?"""
        if not self.protect:
            return False
        projects = pjoin(self.cd, "projects")
        spellings = scratch_aliases(loc, self.scratch_spellings) if WINDOWS else [loc]
        for alias in spellings:
            slug = slugify(alias)
            if self.holds_protected(pjoin(projects, slug)):
                return True
            if len(slug) > SLUG_MAX:  # Claude Code cuts a long slug and adds a hash: match on the first 200 chars
                for name in safe_listdir(projects):
                    if len(name) > SLUG_MAX and slug_key(name) == slug_key(slug) and self.holds_protected(pjoin(projects, name)):
                        return True
        return False


def classify_target(loc, ctx):
    """Return (pathClass, [paths to move]) or raise Refused. `loc` comes from _locate()."""
    if not os.path.lexists(loc):
        raise Refused("路径不存在")
    cd = ctx.cd
    name = pbasename(loc)
    if same_path(loc, pjoin(cd, "CLAUDE.md")):
        raise Refused("全局 CLAUDE.md 不能删除")
    for forb, why in (("plugins", "plugins/ 由 Claude Code 管理"), (pjoin("skills", "synced"), "skills/synced 由同步管理"), (TRASH_DIR, "已经在回收站里")):
        fp = pjoin(cd, forb)
        if under(loc, fp):
            raise Refused(why)
    projects = pjoin(cd, "projects")
    if under(loc, projects):
        if same_path(loc, projects):
            raise Refused("不能删除 projects 根目录")
        parts = loc[len(projects) + 1:].split("/")
        pdir = pjoin(projects, parts[0])
        if len(parts) == 1:
            if not os.path.isdir(loc):
                raise Refused("不是项目文件夹")
            if ctx.holds_protected(loc):
                raise Refused("包含当前会话，不能删除")
            return "project", [loc]
        if len(parts) == 2 and name.endswith(".jsonl") and os.path.isfile(loc):
            sid = name[: -len(".jsonl")]
            if ctx.protect and name_key(sid) == name_key(ctx.protect):
                raise Refused("这是当前会话，不能删除")
            out = [loc]
            sdir = pjoin(pdir, sid)
            if os.path.lexists(sdir):
                out.append(sdir)
            return "session", out
        if (
            len(parts) == 3
            and name_key(parts[1]) == "memory"
            and name.endswith(".md")
            and name_key(name) != name_key("MEMORY.md")
            and (os.path.isfile(loc) or os.path.islink(loc))
        ):
            return "memory", [loc]
        raise Refused("projects/ 里只能删除整个项目文件夹、会话 .jsonl 或记忆文件")
    for folder in ("shared-memory", "memory-archive"):
        root = pjoin(cd, folder)
        if under(loc, root):
            if same_path(loc, root):
                raise Refused("不能删除 %s 根目录" % folder)
            return folder, [loc]
    skills = pjoin(cd, "skills")
    if under(loc, skills):
        parts = loc[len(skills) + 1:].split("/") if not same_path(loc, skills) else []
        if len(parts) == 1 and not name.startswith(".") and (os.path.isdir(loc) or os.path.islink(loc)):
            return "user-skill", [loc]
        raise Refused("skills/ 里只能删除整个用户技能文件夹")
    for sroot in ctx.scratch:
        if not under(loc, sroot):
            continue
        parts = loc[len(sroot) + 1:].split("/") if not same_path(loc, sroot) else []
        if len(parts) == 3 and name.startswith("scratch-") and os.path.isdir(loc) and not is_link(loc):
            if ctx.workspace_protected(loc):
                raise Refused("当前会话的工作区，不能删除")
            return "scratch-workspace", [loc]
        raise Refused("只能删除单个 scratch-* 工作区文件夹")
    lk = pkey(loc)
    for cwd in ctx.cwds():
        if lk in (pkey(pjoin(cwd, "CLAUDE.md")), pkey(pjoin(cwd, ".claude", "CLAUDE.md")), pkey(pjoin(cwd, "CLAUDE.local.md"))):
            return "project-claude-md", [loc]
        if same_path(pdirname(loc), pjoin(cwd, ".claude", "skills")) and not name.startswith("."):
            if os.path.isdir(loc) or os.path.islink(loc):
                return "project-skill", [loc]
    raise Refused("不在允许删除的范围内")


def _index_line_targets(line):
    return [pnorm(m.group(1) or m.group(2)) for m in _LINK_RE.finditer(line)]


def remove_index_lines(text, name):
    lines = text.split("\n")
    keep, removed = [], []
    for i, line in enumerate(lines, 1):
        if name_key(name) in [name_key(t) for t in _index_line_targets(line)]:
            removed.append({"line": i, "text": line})
        else:
            keep.append(line)
    return "\n".join(keep), removed


def insert_index_lines(text, recs):
    lines = text.split("\n") if text else [""]
    trailing = lines[-1] == ""
    for rec in sorted(recs, key=lambda r: r.get("line") or 0):
        t = rec.get("text")
        if not isinstance(t, str) or t in lines:
            continue
        limit = len(lines) - 1 if trailing else len(lines)
        pos = max(0, min(int(rec.get("line") or 1) - 1, limit))
        lines.insert(pos, t)
    return "\n".join(lines)


def _rollback(moved):
    for src, dst in reversed(moved):
        try:
            _rename(dst, src)
        except OSError:
            pass


def _move_reason(exc):
    if _is_exdev(exc):
        return "目标在另一个卷上，不会复制，已拒绝"
    return "移动失败：%s" % (exc.strerror or exc)


def _memory_index_edit(cls, loc):
    if cls != "memory":
        return None, None, []
    ip = pjoin(pdirname(loc), "MEMORY.md")
    if not os.path.isfile(ip):
        return None, None, []
    new_text, removed = remove_index_lines(read_text_exact(ip), pbasename(loc))
    return ip, new_text, removed


def _trash_one(loc, cls, parts, ctx, days, kind, label):
    os.makedirs(ctx.root, exist_ok=True)
    item = None
    for _ in range(5):
        now = now_ms()
        item_id = "%013d-%s" % (now, os.urandom(4).hex())
        item = pjoin(ctx.root, item_id)
        try:
            os.mkdir(item)
            break
        except FileExistsError:
            item = None
    if item is None:
        raise Refused("无法创建回收站条目")
    size = sum(du(p) for p in parts)
    try:
        ip, new_text, removed = _memory_index_edit(cls, loc)
    except OSError as exc:
        os.rmdir(item)
        raise Refused("无法读取 MEMORY.md：%s" % (exc.strerror or exc))
    meta = {
        "id": item_id,
        "originalPath": parts[0],
        "kind": kind or cls,
        "pathClass": cls,
        "label": label or pbasename(parts[0]),
        "deletedAtMs": now,
        # None: kept until someone empties it by hand; a purge of what has expired leaves it
        "expiresAtMs": None if days is None else now + days * DAY_MS,
        "sizeBytes": size,
        "parts": [],
        "indexPath": ip if removed else None,
        "indexLines": removed,
    }
    moved = []
    meta_path = pjoin(item, "meta.json")
    try:
        for i, src in enumerate(parts):
            pname = "payload" if i == 0 else "payload.%d" % i
            dst = pjoin(item, pname)
            _rename(src, dst)
            moved.append((src, dst))
            meta["parts"].append({"originalPath": src, "payload": pname})
        _write_json_atomic(meta_path, meta)
        if removed:
            _write_text_keep_mode(ip, new_text)
    except OSError as exc:
        _rollback(moved)
        if os.path.exists(meta_path):
            os.unlink(meta_path)
        try:
            os.rmdir(item)
        except OSError:
            pass
        raise Refused(_move_reason(exc))
    return meta


def _parse_days(days):
    """How long an item is kept, in days; None for `never`: kept until it is emptied by hand."""
    if isinstance(days, str) and days.strip().lower() == NEVER:
        return None
    try:
        d = int(days)
    except (TypeError, ValueError):
        raise Refused("--days 必须是整数，或者 never")
    if d < 0 or d > 3650:
        raise Refused("--days 必须在 0 到 3650 之间")
    return d


def cmd_trash(claude_dir, cache_path, paths, days, kind, label, protect):
    home = home_dir()
    ctx = TrashContext(claude_dir, home, protect, lambda: _project_cwds(claude_dir, cache_path))
    trashed, refused = [], []
    try:
        d = _parse_days(DEFAULT_TRASH_DAYS if days is None else days)
    except Refused as exc:
        return {"trashed": [], "refused": [{"path": p, "reason": str(exc)} for p in paths]}
    seen = set()
    for path in paths:
        try:
            loc = _locate(path)
            if pkey(loc) in seen:
                raise Refused("重复的路径")
            cls, parts = classify_target(loc, ctx)
            seen.add(pkey(loc))
            trashed.append(_trash_one(loc, cls, parts, ctx, d, kind, label))
        except Refused as exc:
            refused.append({"path": path, "reason": str(exc)})
    return {"trashed": trashed, "refused": refused}


def _project_cwds(claude_dir, cache_path):
    doc = build_index(claude_dir, cache_path, None)
    out = []
    for p in doc["projects"]:
        out.extend([p["cwd"], p["resolvedCwd"]])
    return out


def _item_dir(root, item_id):
    if not isinstance(item_id, str) or not _TRASH_ID_RE.match(item_id):
        raise Refused("id 格式不对")
    item = pjoin(root, item_id)
    if is_link(item) or not os.path.isdir(item):
        raise Refused("回收站里没有这个 id")
    return item


def cmd_restore(claude_dir, ids):
    root = trash_root_of(claude_dir)
    restored, refused = [], []
    for item_id in ids:
        try:
            item = _item_dir(root, item_id)
            try:
                meta = _read_meta(item)
            except (OSError, ValueError) as exc:
                raise Refused("meta.json 读取失败：%s" % exc)
            parts = meta["parts"]
            for part in parts:
                op, pl = part.get("originalPath"), part.get("payload")
                if not isinstance(op, str) or not is_abs(op) or pnorm(op) != op:
                    raise Refused("meta.json 里的原路径无效")
                if pl not in ("payload",) and not re.match(r"^payload\.\d+$", pl or ""):
                    raise Refused("meta.json 里的 payload 名无效")
                if not os.path.lexists(pjoin(item, pl)):
                    raise Refused("回收站里的文件不见了")
                if os.path.lexists(op):
                    raise Refused("原位置 %s 已有东西，不会覆盖" % op)
            moved = []
            try:
                for part in parts:
                    os.makedirs(pdirname(part["originalPath"]), exist_ok=True)
                    _rename(pjoin(item, part["payload"]), part["originalPath"])
                    moved.append((pjoin(item, part["payload"]), part["originalPath"]))
            except OSError as exc:
                for a, b in reversed(moved):
                    try:
                        _rename(b, a)
                    except OSError:
                        pass
                raise Refused(_move_reason(exc))
            warn = None
            if meta.get("indexLines") and meta.get("indexPath"):
                ip = meta["indexPath"]
                try:
                    cur = read_text_exact(ip) if os.path.isfile(ip) else ""
                    _write_text_keep_mode(ip, insert_index_lines(cur, meta["indexLines"]))
                except OSError as exc:
                    warn = "MEMORY.md 未能恢复索引行：%s" % (exc.strerror or exc)
            try:
                os.unlink(pjoin(item, "meta.json"))
                os.rmdir(item)
            except OSError:
                pass
            if warn:
                meta["warning"] = warn
            restored.append(meta)
        except Refused as exc:
            refused.append({"id": item_id, "reason": str(exc)})
    return {"restored": restored, "refused": refused}


def _remove_item(root, item_id):
    item = _item_dir(root, item_id)
    if not same_path(pdirname(real(item)), real(root)):
        raise Refused("回收站条目位置异常")
    with os.scandir(item) as it:
        entries = list(it)
    for e in entries:
        if e.is_dir(follow_symlinks=False) and not _is_junction(e.stat(follow_symlinks=False)):
            _rmtree(e.path)
        else:
            _unlink(e.path)
    os.rmdir(item)


def cmd_purge(claude_dir, dry_run, now_ids, everything=False):
    root = trash_root_of(claude_dir)
    items = _list_trash(root) if os.path.isdir(root) else []
    by_id = dict((m["id"], m) for m in items)
    refused = []
    now = now_ms()
    if now_ids:
        targets = []
        for i in now_ids:
            if i in by_id:
                if by_id[i] not in targets:
                    targets.append(by_id[i])
            else:
                refused.append({"id": i, "reason": "回收站里没有这个 id"})
    elif everything:
        targets = list(items)
    else:
        # what has expired; an item whose expiry is null is kept until it is emptied by hand
        targets = [m for m in items if "expiresAtMs" not in m or (m["expiresAtMs"] is not None and int(m["expiresAtMs"] or 0) <= now)]
    purged, freed = [], 0
    for m in targets:
        if not dry_run:
            try:
                _remove_item(root, m["id"])
            except (Refused, OSError) as exc:
                refused.append({"id": m["id"], "reason": str(exc)})
                continue
        purged.append(m)
        freed += int(m.get("sizeBytes") or 0)
    return {"purged": purged, "keptCount": len(items) - len(purged), "freedBytes": freed, "dryRun": bool(dry_run), "refused": refused}


def cmd_set_expiry(claude_dir, item_id, days):
    root = trash_root_of(claude_dir)
    try:
        d = _parse_days(days)
        item = _item_dir(root, item_id)
        try:
            meta = _read_meta(item)
        except (OSError, ValueError) as exc:
            raise Refused("meta.json 读取失败：%s" % exc)
        meta["expiresAtMs"] = None if d is None else now_ms() + d * DAY_MS
        _write_json_atomic(pjoin(item, "meta.json"), meta)
        return {"updated": meta, "refused": []}
    except Refused as exc:
        return {"updated": None, "refused": [{"id": item_id, "reason": str(exc)}]}


def _valid_label(label):
    if not isinstance(label, str):
        return None
    label = label.strip()
    if not label or label in (".", "..") or label.startswith(".") or "/" in label or "\x00" in label:
        return None
    if WINDOWS and (_WIN_BAD_NAME_RE.search(label) or label.endswith(".") or _WIN_RESERVED_RE.match(label)):
        return None  # a backslash or colon would leave memory-archive; the rest Windows refuses as a folder name
    return label


def cmd_archive_memory(claude_dir, path, label):
    home = home_dir()
    ctx = TrashContext(claude_dir, home, None, lambda: [])
    try:
        lab = _valid_label(label)
        if lab is None:
            if WINDOWS:
                raise Refused("--project-label 无效（不能为空、不能以 . 开头或结尾，不能含斜杠、反斜杠、冒号和 * ? \" < > |，不能是 CON、NUL 这类保留名）")
            raise Refused("--project-label 无效（不能为空、不能含 /、不能以 . 开头）")
        loc = _locate(path)
        cls, _ = classify_target(loc, ctx)
        if cls != "memory":
            raise Refused("只能归档项目 memory/ 里的记忆文件")
        if os.path.islink(loc):
            raise Refused("这是符号链接，请用回收站删除链接")
        dest_dir = pjoin(ctx.cd, "memory-archive", lab)
        dest = pjoin(dest_dir, pbasename(loc))
        if os.path.lexists(dest):
            raise Refused("归档里已有同名文件 %s，不会覆盖" % dest)
        try:
            ip, new_text, removed = _memory_index_edit(cls, loc)
        except OSError as exc:
            raise Refused("无法读取 MEMORY.md：%s" % (exc.strerror or exc))
        created = not os.path.isdir(dest_dir)
        try:
            os.makedirs(dest_dir, exist_ok=True)
            _rename(loc, dest)
        except OSError as exc:
            if created:
                try:
                    os.rmdir(dest_dir)
                except OSError:
                    pass
            raise Refused(_move_reason(exc))
        if removed:
            try:
                _write_text_keep_mode(ip, new_text)
            except OSError as exc:
                _rollback([(loc, dest)])
                raise Refused("无法更新 MEMORY.md：%s" % (exc.strerror or exc))
        return {"archived": {"from": loc, "to": dest, "indexLines": removed}, "refused": []}
    except Refused as exc:
        return {"archived": None, "refused": [{"path": path, "reason": str(exc)}]}


# ---------------------------------------------------------------- file-manager commands
#
# move / os-trash / reveal / open: what the pane used to shell out to mv and open for. Each acts on exactly the
# path it is given, prints {"ok": true, ...}, and fails with AtlasError ({"error": ...}, exit 1).

# Windows: file types whose default handler runs the file instead of showing it (on top of %PATHEXT%).
_WIN_RUN_EXTS = (
    ".bat", ".cmd", ".com", ".exe", ".scr", ".msi", ".msc", ".cpl", ".hta", ".lnk", ".url", ".reg", ".jar",
    ".js", ".jse", ".mjs", ".cjs", ".vbs", ".vbe", ".wsf", ".wsh", ".ps1", ".psm1", ".py", ".pyw", ".pl", ".rb",
    ".php", ".sh", ".bash", ".zsh", ".command", ".application", ".appref-ms",
)


def _arg_path(path):
    """An absolute path from the command line in the one path form; links are not resolved."""
    if not isinstance(path, str) or not path.strip():
        raise AtlasError("路径为空")
    p = expand(path)
    if not is_abs(p):
        raise AtlasError("需要绝对路径：%s" % path)
    return absp(p)


def _existing(path):
    p = _arg_path(path)
    if not os.path.lexists(p):
        raise AtlasError("路径不存在：%s" % p)
    return p


def _move_any(src, dst):
    """Move a file, link or folder to `dst`, which must not exist: a rename, or across volumes (another drive)
    copy, check, delete."""
    try:
        os.rename(src, dst)
    except OSError as exc:
        if not _is_exdev(exc):
            raise
        _move_across(src, dst)


def cmd_move(src, dest_dir):
    src = _existing(src)
    dest_dir = _arg_path(dest_dir)
    name = pbasename(src)
    if os.path.isdir(src) and not os.path.islink(src):
        raise AtlasError("move 只移动文件，这是文件夹：%s" % src)
    if not os.path.isdir(dest_dir):
        raise AtlasError("目标文件夹不存在：%s" % dest_dir)
    dest = pjoin(dest_dir, name)
    if os.path.lexists(dest):
        raise AtlasError("%s 里已经有 %s，没有移动" % (dest_dir, name))
    try:
        _move_any(src, dest)
    except OSError as exc:
        raise AtlasError("没有移动：%s" % (exc.strerror or exc))
    return {"ok": True, "to": dest}


def _mac_trash(path, home):
    """Into ~/.Trash under a name not taken there: the plain name, else "<stem> atlas-<epoch ms><ext>"."""
    trash = pjoin(home, ".Trash")
    if under(real(pdirname(path)), real(trash)):
        raise AtlasError("已经在废纸篓里：%s" % path)
    if not os.path.isdir(trash):
        os.makedirs(trash, mode=0o700, exist_ok=True)
    name = pbasename(path)
    dot = name.rfind(".")
    stem, ext = (name[:dot], name[dot:]) if dot > 0 else (name, "")
    to = pjoin(trash, name)
    stamp = now_ms()
    while os.path.lexists(to):
        to = pjoin(trash, "%s atlas-%d%s" % (stem, stamp, ext))
        stamp += 1
    _move_any(path, to)
    return to


def _recycle_request(native_path):
    """The SHFILEOPSTRUCTW that sends one path to the Recycle Bin, and the buffer its pFrom points into (keep
    it alive for the call). Flags: FOF_ALLOWUNDO, and no dialogs (FOF_NOCONFIRMATION | FOF_SILENT |
    FOF_NOERRORUI) except the one Windows shows when the item cannot be recycled and would be deleted for
    good (FOF_WANTNUKEWARNING)."""
    import ctypes

    fields = [
        ("hwnd", ctypes.c_void_p),
        ("wFunc", ctypes.c_uint),
        ("pFrom", ctypes.c_void_p),
        ("pTo", ctypes.c_void_p),
        ("fFlags", ctypes.c_ushort),
        ("fAnyOperationsAborted", ctypes.c_int),
        ("hNameMappings", ctypes.c_void_p),
        ("lpszProgressTitle", ctypes.c_void_p),
    ]
    ns = {"_fields_": fields}
    if ctypes.sizeof(ctypes.c_void_p) == 4:
        ns = {"_pack_": 1, "_fields_": fields}  # shellapi.h packs this struct on 32-bit Windows only
    op = type("SHFILEOPSTRUCTW", (ctypes.Structure,), ns)()
    # pFrom is a list of paths, each NUL-terminated, the list ending with one more NUL: the buffer is zero-filled
    buf = ctypes.create_unicode_buffer(len(native_path.encode("utf-16-le")) // 2 + 2)
    buf.value = native_path
    op.wFunc = 3  # FO_DELETE
    op.pFrom = ctypes.addressof(buf)
    op.fFlags = 0x0040 | 0x0010 | 0x0004 | 0x0400 | 0x4000
    return op, buf


def _windows_recycle(path):
    """Into the Recycle Bin, through the shell: SHFileOperationW(FO_DELETE). Answering No to the "delete for
    good?" question aborts the operation, which is reported as an error."""
    import ctypes

    p = native(path)
    if len(p) >= 248 and not p.startswith("\\\\"):
        # the shell API stops at MAX_PATH: hand it the 8.3 short spelling of a long path
        short = ctypes.create_unicode_buffer(1024)
        n = ctypes.windll.kernel32.GetShortPathNameW("\\\\?\\" + p, short, 1024)
        if 0 < n < 1024:
            p = short.value[4:] if short.value.startswith("\\\\?\\") else short.value
    op, buf = _recycle_request(p)
    fn = ctypes.windll.shell32.SHFileOperationW
    fn.argtypes = [ctypes.c_void_p]
    fn.restype = ctypes.c_int
    rc = fn(ctypes.byref(op))
    del buf
    if rc != 0:
        raise AtlasError("回收站没有接受（SHFileOperation 返回 0x%X）" % rc)
    if op.fAnyOperationsAborted:
        raise AtlasError("已取消，没有移到回收站")


def cmd_os_trash(path):
    path = _existing(path)
    try:
        if WINDOWS:
            _windows_recycle(path)
            to = ""  # the Recycle Bin does not say where it put things
        elif sys.platform == "darwin":
            to = _mac_trash(path, home_dir())
        else:
            raise AtlasError("这个系统上没有接系统废纸篓")
    except OSError as exc:
        raise AtlasError("没能移到废纸篓：%s" % (exc.strerror or exc))
    if os.path.lexists(path) or (to and not os.path.lexists(to)):
        raise AtlasError("没能移到废纸篓：%s" % path)
    return {"ok": True, "to": to}


def _run_tool(argv):
    """Run a helper program and wait for it; its stdout is discarded so it can never mix into the JSON."""
    import subprocess

    try:
        proc = subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=20)
    except (OSError, subprocess.SubprocessError) as exc:
        raise AtlasError("没能运行 %s：%s" % (argv[0], exc))
    if proc.returncode != 0:
        lines = proc.stderr.decode("utf-8", "replace").strip().splitlines()
        raise AtlasError(lines[-1] if lines else "%s 退出码 %d" % (argv[0], proc.returncode))


def _spawn(command):
    """Windows: start a program and do not wait for it (Explorer and Notepad stay open, and explorer.exe's exit
    code means nothing). It inherits none of our handles, so the caller's pipe closes when this script exits."""
    import subprocess

    try:
        subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except OSError as exc:
        raise AtlasError("没能启动：%s" % (exc.strerror or exc))


def _windows_program(name):
    return native(pjoin(fwd(os.environ.get("SystemRoot") or "C:/Windows"), name))


def _windows_runs(path):
    """Windows: is the default handler the wrong thing for editing this file, because opening it would run it?
    (%PATHEXT% plus the usual script and installer types)"""
    ext = os.path.splitext(path)[1].lower()
    if not ext:
        return True  # no type at all: nothing sensible to hand it to, straight to Notepad
    return ext in _WIN_RUN_EXTS or ext in [e.strip().lower() for e in (os.environ.get("PATHEXT") or "").split(";")]


def _windows_open(path, edit):
    p = native(path)
    startfile = getattr(os, "startfile")
    if not edit:
        try:
            startfile(p)
        except OSError as exc:
            raise AtlasError("没能打开：%s" % (exc.strerror or exc))
        return
    try:
        startfile(p, "edit")  # the file type's own "edit" verb, when it has one
        return
    except OSError:
        pass
    if not _windows_runs(p):
        try:
            startfile(p)  # the default handler
            return
        except OSError:
            pass
    _spawn('"%s" "%s"' % (_windows_program("notepad.exe"), p))


def _windows_reveal(path):
    # explorer wants backslashes, and the path quoted right after the comma
    _spawn('"%s" /select,"%s"' % (_windows_program("explorer.exe"), native(path)))


def cmd_reveal(path):
    path = _existing(path)
    if WINDOWS:
        _windows_reveal(path)
    else:
        _run_tool(["/usr/bin/open", "-R", path])
    return {"ok": True}


def cmd_open(path, edit):
    path = _existing(path)
    if edit and os.path.isdir(path):
        raise AtlasError("--edit 只能打开文件，这是文件夹：%s" % path)
    if WINDOWS:
        _windows_open(path, edit)
    else:
        _run_tool(["/usr/bin/open", "-t", path] if edit else ["/usr/bin/open", path])
    return {"ok": True}


# ---------------------------------------------------------------- CLI


class _Parser(argparse.ArgumentParser):
    def error(self, message):
        raise AtlasError("参数错误：" + message)


def _emit(doc):
    """One JSON document and a newline on stdout, as UTF-8 bytes written to its byte stream: the locale's code
    page (GBK on a Chinese Windows) never gets a say, and nothing translates the newline."""
    data = json_bytes(doc, separators=(",", ":"))
    out = getattr(sys.stdout, "buffer", None)
    if WINDOWS and out is not None and sys.stdout.isatty():
        out = None  # typed into a console window: as text, which Python hands to the console as Unicode
    if out is not None:
        out.write(data)
        out.write(b"\n")
    else:  # a stand-in stdout that only takes text
        sys.stdout.write(data.decode("utf-8") + "\n")
    sys.stdout.flush()


def _parser():
    parser = _Parser(prog="atlas.py", add_help=False)
    sub = parser.add_subparsers(dest="cmd")

    def mk(name):
        p = sub.add_parser(name, add_help=False)
        p.add_argument("--claude-dir")
        return p

    p = mk("index")
    p.add_argument("--cache")
    p.add_argument("--current-cwd")
    p = mk("search")
    p.add_argument("query")
    p.add_argument("--limit", type=int, default=200)
    p = mk("trash")
    p.add_argument("paths", nargs="+")
    p.add_argument("--days")
    p.add_argument("--kind")
    p.add_argument("--label")
    p.add_argument("--protect-session")
    p.add_argument("--cache")
    p = mk("restore")
    p.add_argument("ids", nargs="+")
    p = mk("purge")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--now", nargs="+")
    p.add_argument("--all", action="store_true")
    mk("trash-list")
    p = mk("set-expiry")
    p.add_argument("id")
    p.add_argument("--days", required=True)
    p = mk("archive-memory")
    p.add_argument("path")
    p.add_argument("--project-label", required=True)
    p = sub.add_parser("move", add_help=False)
    p.add_argument("src")
    p.add_argument("dest_dir")
    for name in ("os-trash", "reveal"):
        p = sub.add_parser(name, add_help=False)
        p.add_argument("path")
    p = sub.add_parser("open", add_help=False)
    p.add_argument("path")
    p.add_argument("--edit", action="store_true")
    return parser


def main(argv=None):
    try:
        args = _parser().parse_args(argv)
        if not args.cmd:
            raise AtlasError(
                "用法：atlas.py index|search|trash|restore|purge|trash-list|set-expiry|archive-memory|move|os-trash|reveal|open ..."
            )
        claude_dir = absp(expand(getattr(args, "claude_dir", None) or "~/.claude"))
        cache = getattr(args, "cache", None)
        if cache:
            cache = absp(expand(cache))
        else:
            cache = pjoin(claude_dir, "cache", "atlas", "sessions-v1.json")
        if args.cmd == "move":
            doc = cmd_move(args.src, args.dest_dir)
        elif args.cmd == "os-trash":
            doc = cmd_os_trash(args.path)
        elif args.cmd == "reveal":
            doc = cmd_reveal(args.path)
        elif args.cmd == "open":
            doc = cmd_open(args.path, args.edit)
        elif args.cmd == "index":
            doc = build_index(claude_dir, cache, args.current_cwd)
        elif args.cmd == "search":
            doc = run_search(claude_dir, args.query, max(0, args.limit))
        else:
            if not os.path.isdir(claude_dir):
                raise AtlasError("claude 目录不存在：%s" % claude_dir)
            if args.cmd == "trash":
                doc = cmd_trash(claude_dir, cache, args.paths, args.days, args.kind, args.label, args.protect_session)
            elif args.cmd == "restore":
                doc = cmd_restore(claude_dir, args.ids)
            elif args.cmd == "purge":
                doc = cmd_purge(claude_dir, args.dry_run, args.now, args.all)
            elif args.cmd == "trash-list":
                doc = cmd_trash_list(claude_dir)
            elif args.cmd == "set-expiry":
                doc = cmd_set_expiry(claude_dir, args.id, args.days)
            else:
                doc = cmd_archive_memory(claude_dir, args.path, args.project_label)
    except AtlasError as exc:
        _emit({"error": str(exc)})
        return 1
    except Exception as exc:  # fatal: still answer in JSON
        _emit({"error": "%s: %s" % (type(exc).__name__, exc)})
        return 1
    _emit(doc)
    return 0


if __name__ == "__main__":
    sys.exit(main())
