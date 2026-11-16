r"""Tests for atlas.py. Run from the atlas folder:

    /usr/bin/python3 -I bin/test_atlas.py -v          (macOS)
    python -I bin\test_atlas.py -v                    (Windows)

(`-I -m unittest bin/test_atlas.py` cannot import under -I because the cwd is not on sys.path;
`/usr/bin/python3 -I -m unittest discover -s bin -p test_atlas.py -v` also works.)

Everything runs on fixtures in temporary folders, with the home folder pointed at the fixture ($HOME; on
Windows %USERPROFILE%, %APPDATA%, %LOCALAPPDATA% and %TEMP% as well), so the home scan and every
trash/restore/purge/archive call touch only fixture files.

The same file runs on both platforms:
- Fixture paths are kept in the form atlas prints (forward slashes, J()); what goes into a transcript is
  written the way the platform spells it (nat(): backslashes on Windows), as Claude Code records it.
- Symlinks need Developer Mode or admin on Windows. Without them the fixture uses copies and the
  assertions about links are skipped (SYMLINKS).
- WindowsRuleTests switch atlas.WINDOWS on, so the Windows rules of the pure path functions are checked on
  a Mac too; PosixRuleTests switch it off, so the macOS rules are checked on Windows too. What needs a real
  Windows file system (name spellings on NTFS, read-only files, the Recycle Bin) is in WindowsOnlyTests.
- Two Windows tests reach outside the fixtures and are opt-in:
    set ATLAS_TEST_RECYCLE=1                 sends one small temp file to the real Recycle Bin
    set ATLAS_TEST_OTHER_DRIVE=E:\some\dir   moves a file to a temp folder made there, and back
"""

import calendar
import errno
import hashlib
import importlib.util
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
ATLAS = os.path.join(HERE, "atlas.py")

sys.dont_write_bytecode = True  # importing atlas.py below must not leave a __pycache__ folder in bin/
_spec = importlib.util.spec_from_file_location("atlas_under_test", ATLAS)
atlas = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(atlas)

WIN = os.name == "nt"
MAC = sys.platform == "darwin"
# Opt-in tests that reach outside the fixtures (see the docstring). cmd.exe's `set X=1 && ...` leaves a
# trailing space in the value, hence the strip.
OPT_RECYCLE = os.environ.get("ATLAS_TEST_RECYCLE", "").strip() == "1"
OPT_OTHER_DRIVE = os.environ.get("ATLAS_TEST_OTHER_DRIVE", "").strip().strip('"')


def slugify(p):
    return atlas.slugify(p)


def J(*parts):
    """A path in the form atlas prints: forward slashes on every platform (C:/Users/... on Windows)."""
    return atlas.fwd(os.path.join(*parts))


def nat(p):
    """The same path as the platform spells it: backslashes on Windows, unchanged elsewhere."""
    return p.replace("/", "\\") if WIN else p


def jl(*records):
    return "".join(json.dumps(r, ensure_ascii=False, separators=(",", ":")) + "\n" for r in records)


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="") as fh:  # newline="": no CRLF translation on Windows
        fh.write(text)


def write_bytes(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(data)


def read(path):
    with open(path, encoding="utf-8", newline="") as fh:
        return fh.read()


def read_bytes(path):
    with open(path, "rb") as fh:
        return fh.read()


def _can_symlink():
    d = tempfile.mkdtemp()
    try:
        os.symlink(os.path.join(d, "target"), os.path.join(d, "link"))
        return True
    except (OSError, NotImplementedError, AttributeError):
        return False
    finally:
        shutil.rmtree(d, ignore_errors=True)


SYMLINKS = _can_symlink()


def link(target, path):
    """A symlink where the platform lets us make one, else a copy of the target file."""
    if SYMLINKS:
        os.symlink(nat(target), nat(path))
    else:
        shutil.copyfile(target, path)


def fixture_env(home):
    """What makes `home` the home folder for atlas. On Windows also AppData and TEMP, which would otherwise
    point at the real profile (and the fixture itself lives under the real %TEMP%)."""
    if not WIN:
        return {"HOME": home}
    h = nat(home)
    return {"HOME": h, "USERPROFILE": h, "APPDATA": h + "\\AppData\\Roaming", "LOCALAPPDATA": h + "\\AppData\\Local",
            "TEMP": h + "\\AppData\\Local\\Temp", "TMP": h + "\\AppData\\Local\\Temp"}


def run_atlas(home, *args, **extra_env):
    if WIN:
        env = dict(os.environ)
        env.update(fixture_env(home))
    else:
        env = {"HOME": home, "PATH": "/usr/bin:/bin", "LANG": "C"}
    env.update(extra_env)
    p = subprocess.run([sys.executable, "-I", ATLAS] + list(args), stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
    return p.returncode, p.stdout, p.stderr


def run_json(home, *args, **extra_env):
    code, out, err = run_atlas(home, *args, **extra_env)
    return code, json.loads(out.decode("utf-8")), err


def strings_in(doc):
    """Every string in a JSON value, keys included."""
    if isinstance(doc, str):
        yield doc
    elif isinstance(doc, dict):
        for k, v in doc.items():
            yield k
            for s in strings_in(v):
                yield s
    elif isinstance(doc, list):
        for v in doc:
            for s in strings_in(v):
                yield s


def backslashed(doc):
    return [s for s in strings_in(doc) if "\\" in s]


TS0 = "2026-10-01T00:00:00.000Z"
TS0_MS = calendar.timegm((2026, 10, 1, 0, 0, 0, 0, 0, 0)) * 1000
TS_REC = "2026-10-01T00:00:05.000Z"
TS_REC_MS = TS0_MS + 5000

# A file outside every fixture root (it does not have to exist).
EXT_FILE = "Q:/elsewhere/hosts" if WIN else "/etc/hosts"
EXT_DIR = "Q:/elsewhere" if WIN else "/etc"


def base(rec, cwd, ts=TS_REC, version="2.1.0"):
    out = {"parentUuid": None, "isSidechain": False}
    out.update(rec)
    out.update({"uuid": "u", "timestamp": ts, "userType": "external", "entrypoint": "claude-desktop",
                "cwd": nat(cwd), "sessionId": "s", "version": version, "gitBranch": ""})
    return out


def assistant_tool(cwd, name, inp, version="2.1.0", ts=TS_REC):
    inp = dict(inp)
    for k in ("file_path", "notebook_path", "path"):
        if k in inp:
            inp[k] = nat(inp[k])
    return base({"type": "assistant", "message": {"role": "assistant", "content": [
        {"type": "text", "text": "ok"}, {"type": "tool_use", "id": "t", "name": name, "input": inp}]}}, cwd, ts=ts, version=version)


def user_str(cwd, text, **extra):
    r = base({"type": "user", "message": {"role": "user", "content": text}}, cwd)
    r.update(extra)
    return r


def scratch_base(root):
    """Where the desktop app keeps scratch workspaces under the home folder `root`."""
    if WIN:
        return J(root, "AppData", "Roaming", "Claude", "scratch-workspaces")
    return J(root, "Library", "Application Support", "Claude", "scratch-workspaces")


def build_fixture(root):
    """Build a fake home with a claude dir and project folders under `root`. Returns a dict of paths."""
    root = atlas.fwd(os.path.realpath(root))
    cd = J(root, "claude")
    work_a = J(root, "work", "proj")
    work_b = J(root, "work", "other")
    gone = J(root, "gone")
    scratch_cwd = J(scratch_base(root), "aa", "bb", "scratch-2026-10-01-abc")
    plug = J(root, "plugcache", "vid", "1.0")
    os.makedirs(work_a)
    os.makedirs(work_b)
    write(J(scratch_cwd, "f.txt"), "scratch file\n")
    P = {"root": root, "cd": cd, "a": work_a, "b": work_b, "gone": gone, "scratch": scratch_cwd,
         "scratch_root": scratch_base(root)}

    write(J(cd, "CLAUDE.md"),
          "# Global\n\nZebra记忆token in global\nline three\nSee [[beta-note]] and @~/notes/imported.md and @scope/pkg\n"
          "```\n@author in code\n```\n")
    write(J(root, "notes", "imported.md"), "# Imported\n[more](more.md)\n")
    write(J(root, "notes", "more.md"), "[even](evenmore.md)\n")
    write(J(root, "notes", "evenmore.md"), "end\n")

    # custom memory
    write(J(cd, "shared-memory", "README.md"), "# Shared pool\n\nno frontmatter here\n")
    write(J(cd, "shared-memory", "x.md"),
          "---\nname: shared-x\ndescription: shared rule\nmetadata:\n  type: feedback\n---\n\nzebra记忆TOKEN shared\n")
    write(J(cd, "memory-archive", "proj", "2026-10-01", "y.md"),
          "---\nname: archived-y\ndescription: 'it''s archived'\ntype: project\n---\nZEBRA记忆token archived\n")

    # project A
    slug_a = slugify(work_a)
    pa = J(cd, "projects", slug_a)
    ma = J(pa, "memory")
    filler = "".join("- filler line %03d %s\n" % (i, "x" * 110) for i in range(210))
    write(J(ma, "MEMORY.md"),
          "# Memory Index\n\n- [Alpha](a.md) — first\n- [Beta](b.md \"title\") — second\n"
          "- [Gone](gone.md) — dead\n- [Shared](./x.md) — shared\n- [web](https://example.com/z.md)\n" + filler)
    write(J(ma, "a.md"),
          "---\nname: alpha-note\ndescription: \"say \\\"hi\\\" first\"\nmetadata: \n  node_type: memory\n"
          "  type: feedback\n  originSessionId: abc\n---\n\nBody alpha line with zebra记忆token\n")
    write(J(ma, "b.md"),
          "---\nname: beta-note\ndescription: >\n  folded line one\n  folded line two\ntype: project\n---\nbody\n")
    write(J(ma, "orphan.md"), "\n# Orphan heading\n\nmore text\n")
    link(J(cd, "shared-memory", "x.md"), J(ma, "x.md"))
    write(J(work_a, "CLAUDE.md"), "# Proj A\nSee [plan](docs/plan.md)\n")
    write(J(work_a, "docs", "plan.md"), "# Plan\n[deeper](deeper.md)\n")
    write(J(work_a, "docs", "deeper.md"), "[never](never.md)\n")
    write(J(work_a, "sub", "CLAUDE.md"), "# Sub\n")
    P["slug_a"] = slug_a
    P["mem_a"] = ma

    slug_b = slugify(work_b)
    mem_b_same = J(cd, "projects", slug_b, "memory", "same.md")
    if WIN:  # %TEMP% of the fixture environment, see fixture_env()
        scratchpad = J(root, "AppData", "Local", "Temp", "claude", slug_a, "s1", "scratchpad")
    else:
        scratchpad = "/private/tmp/claude-501/%s/s1/scratchpad" % slug_a

    s1 = J(pa, "s1.jsonl")
    p_a = J(ma, "a.md")
    with open(s1, "w", encoding="utf-8", newline="") as fh:
        fh.write(jl(
            {"type": "queue-operation", "operation": "enqueue", "timestamp": TS0, "sessionId": "s1", "content": "hello"},
            user_str(work_a, "hello first prompt"),
            base({"type": "attachment", "attachment": {"type": "instructions", "files": [
                {"path": nat(J(cd, "CLAUDE.md")), "type": "User", "content": "SECRET-INSTRUCTIONS-CONTENT"},
                {"path": nat(J(ma, "MEMORY.md")), "type": "AutoMem", "content": "SECRET-INSTRUCTIONS-CONTENT"}]}}, work_a),
            base({"type": "attachment", "attachment": {"type": "nested_memory", "path": nat(J(work_a, "sub", "CLAUDE.md")),
                                                        "displayPath": "sub/CLAUDE.md", "content": "SECRET-NESTED-CONTENT"}}, work_a),
            base({"type": "attachment", "attachment": {"type": "skill_listing", "content": "LISTING-DESCRIPTION",
                                                        "skillCount": 1, "isInitial": True, "names": ["old-skill"]}}, work_a),
            base({"type": "attachment", "attachment": {"type": "skill_listing", "content": "LISTING-DESCRIPTION",
                                                        "skillCount": 1, "isInitial": False, "names": ["x-before"]}}, work_a),
            base({"type": "attachment", "attachment": {"type": "skill_listing", "content": "LISTING-DESCRIPTION",
                                                        "skillCount": 4, "isInitial": True,
                                                        "names": ["mine", "anthropic-skills:docx", "vid:clip", "builtin-thing"]}}, work_a),
            {"type": "custom-title", "customTitle": "First title", "sessionId": "s1"},
            {"type": "ai-title", "aiTitle": "AI title", "sessionId": "s1"},
            assistant_tool(work_a, "Skill", {"skill": "mine"}),
            assistant_tool(work_a, "Skill", {"skill": "mine", "args": "again"}),
            assistant_tool(work_a, "Skill", {"skill": "vid:clip"}),
            base({"type": "attachment", "attachment": {"type": "skill_listing", "content": "LISTING-DESCRIPTION",
                                                        "skillCount": 1, "isInitial": False, "names": ["late-skill", "mine"]}}, work_a),
            user_str(work_a, "<command-name>/anthropic-skills:docx</command-name>\n<command-message>docx</command-message>"),
            user_str(work_a, "<command-name>/model</command-name>\n<command-args>x</command-args>"),
            user_str(work_a, "please explain <command-name>/mine</command-name> to me"),
            assistant_tool(work_a, "Read", {"file_path": p_a}),
            assistant_tool(work_a, "Read", {"file_path": p_a}),
            assistant_tool(work_a, "Edit", {"file_path": J(ma, "b.md"), "old_string": "a", "new_string": "b"}),
            assistant_tool(work_a, "Write", {"file_path": J(cd, "CLAUDE.md"), "content": "c"}),
            assistant_tool(work_a, "MultiEdit", {"file_path": J(work_a, "CLAUDE.local.md"), "edits": []}),
            assistant_tool(work_a, "Read", {"file_path": EXT_FILE}),
            assistant_tool(work_a, "Read", {"file_path": J(cd, "shared-memory", "x.md")}),
            assistant_tool(work_a, "Write", {"file_path": J(cd, "projects", slug_a, "notes.md"), "content": "no"}),
            assistant_tool(work_a, "Read", {"file_path": mem_b_same}),
            assistant_tool(work_a, "Bash", {"command": "cd %s && echo hi > %s/out/result.txt" % (work_a, root)},
                           ts="2026-10-01T00:00:09.000Z"),
            assistant_tool(work_a, "Bash", {"command": "curl -s -o ~/dl/file.bin https://example.com 2>/dev/null"}),
            assistant_tool(work_a, "Bash", {"command": "cat > %s/n.txt <<'EOF'\n> quoted line\nEOF" % scratchpad}),
            assistant_tool(work_a, "Glob", {"pattern": "*.md", "path": J(work_a, "docs")}),
            assistant_tool(work_a, "NotebookEdit", {"notebook_path": J(work_a, "nb", "a.ipynb"), "new_source": "x"}),
            assistant_tool(work_a, "Write", {"file_path": J(root, "work", "Old Name", "notes.txt"), "content": "x"}),
            {"type": "custom-title", "customTitle": "Final custom title", "sessionId": "s1"},
        ))
        fh.write('{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Skill" BROKEN\n')
        fh.write(jl(
            base({"type": "system", "subtype": "x", "content": "done"}, work_a, version="2.1.5"),
            {"type": "last-prompt", "leafUuid": "l", "sessionId": "s1", "lastPrompt": "bye"},
        ))
    sub = J(pa, "s1", "subagents")
    write(J(sub, "agent-a1.jsonl"), jl(
        user_str(work_a, "subagent task"), assistant_tool(work_a, "Skill", {"skill": "mine"}),
        assistant_tool(work_a, "Write", {"file_path": J(work_a, "gen", "out.txt"), "content": "x"})))
    write(J(sub, "agent-a1.meta.json"), '{"agentType":"x"}')
    write(J(sub, "workflows", "wf_1", "agent-a2.jsonl"), jl(assistant_tool(work_a, "Skill", {"skill": "projskill"})))
    write(J(sub, "workflows", "wf_1", "journal.jsonl"), jl(assistant_tool(work_a, "Skill", {"skill": "mine"})))
    P["scratchpad"] = scratchpad

    s2 = J(pa, "s2.jsonl")
    write(s2, jl(
        {"type": "mode", "mode": "normal", "sessionId": "s2"},
        user_str(work_a, "prompt of s2"),
        base({"type": "attachment", "attachment": {"type": "skill_listing", "content": "LISTING-DESCRIPTION",
                                                    "skillCount": 1, "isInitial": True, "names": ["mine"]}}, work_a),
        {"type": "ai-title", "aiTitle": "Second via AI", "sessionId": "s2"},
    ))
    long_prompt = "List prompt " + "word " * 40
    s3 = J(pa, "s3.jsonl")
    write(s3, jl(
        {"type": "queue-operation", "operation": "enqueue", "timestamp": TS0, "sessionId": "s3"},
        user_str(work_a, "meta prompt", isMeta=True),
        base({"type": "user", "message": {"role": "user", "content": [{"type": "text", "text": "<system-reminder>x</system-reminder>"}]}}, work_a),
        base({"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t", "content": "res"}]}}, work_a),
        base({"type": "user", "message": {"role": "user", "content": [{"type": "text", "text": long_prompt}]}}, work_a),
    ))
    write(J(pa, "s3", "tool-results", "r.txt"), "tool result\n")
    s4 = J(pa, "s4.jsonl")
    write(s4, jl({"type": "queue-operation", "operation": "enqueue", "timestamp": TS0, "sessionId": "s4"}))
    P.update({"s1": s1, "s2": s2, "s3": s3, "s4": s4, "long_prompt": long_prompt, "pa": pa})

    # project B: same title as A's a.md, shares x.md via symlink, wikilinks into A; CLAUDE.md is a symlink
    pb = J(cd, "projects", slug_b)
    mb = J(pb, "memory")
    write(J(mb, "MEMORY.md"), "- [Same](same.md)\n- [Shared](x.md)\n")
    write(mem_b_same, "---\nname: alpha-note\ndescription: independent copy\n---\nbody [[orphan]]\n")
    link(J(cd, "shared-memory", "x.md"), J(mb, "x.md"))
    b1 = J(pb, "b1.jsonl")
    write(b1, jl(user_str(work_b, "b prompt")))
    write(J(work_b, "AGENTS.md"), "# Agents\n@./extra.md\n")
    write(J(work_b, "extra.md"), "extra\n")
    link(J(work_b, "AGENTS.md"), J(work_b, "CLAUDE.md"))
    P["slug_b"] = slug_b
    P["mem_b_same"] = mem_b_same

    # project C: cwd gone, memory without MEMORY.md
    slug_c = slugify(gone)
    pc = J(cd, "projects", slug_c)
    write(J(pc, "memory", "c.md"), "---\nname: c-note\ndescription: c\n---\n")
    write(J(pc, "c1.jsonl"), jl(user_str(gone, "c prompt")))
    P["slug_c"] = slug_c

    # empty memory dirs: one scratch (has a transcript), one tmp (slug only, no transcripts)
    slug_s = slugify(scratch_cwd)
    os.makedirs(J(cd, "projects", slug_s, "memory"))
    write(J(cd, "projects", slug_s, "sc.jsonl"), jl(user_str(scratch_cwd, "scratch prompt")))
    os.makedirs(J(cd, "projects", "-private-tmp-fixture-xyz", "memory"))
    P["slug_s"] = slug_s
    # a project with no memory dir at all
    os.makedirs(J(cd, "projects", "-nomem-project"))
    write(J(cd, "projects", "-nomem-project", "n1.jsonl"), "not json at all\n")

    # rename: transcripts recorded the old name, the folder on disk now has the new one (the real `hub` case);
    # the old slug folder holds a copy of the same session id
    old = J(root, "work", "Old Name")
    new = J(root, "work", "hub")
    os.makedirs(new)
    slug_h, slug_mv = slugify(new), slugify(old)
    write(J(cd, "projects", slug_h, "shared-sid.jsonl"), jl(user_str(old, "hub prompt")))
    write(J(cd, "projects", slug_mv, "shared-sid.jsonl"),
          jl({"type": "custom-title", "customTitle": "copy", "sessionId": "shared-sid"}, user_str(old, "mv prompt")))
    P.update({"slug_h": slug_h, "slug_mv": slug_mv, "old": old, "new": new})
    # relocated record
    oldp = J(root, "oldplace")
    newp = J(root, "newplace")
    os.makedirs(newp)
    slug_r = slugify(oldp)
    write(J(cd, "projects", slug_r, "r1.jsonl"), jl(
        user_str(oldp, "r prompt"), {"type": "relocated", "relocatedCwd": nat(newp), "sessionId": "r1"}))
    write(J(cd, "projects", slug_r, "memory", "MEMORY.md"), "- [R](r.md)\n")
    write(J(cd, "projects", slug_r, "memory", "r.md"), "---\nname: r-note\ndescription: r\n---\n")
    P.update({"slug_r": slug_r, "oldp": oldp, "newp": newp})
    # slug match through a launch path: sessions started in work/a.b, which is gone; work/a-b has the same slug
    ab_old = J(root, "work", "a.b")
    ab_new = J(root, "work", "a-b")
    os.makedirs(ab_new)
    slug_l = slugify(J(root, "work", "zz"))
    write(J(cd, "projects", slug_l, "l1.jsonl"), jl(user_str(ab_old, "l prompt")))
    P.update({"slug_l": slug_l, "ab_old": ab_old, "ab_new": ab_new})

    # a sub-project living inside A, writing into A
    inner = J(work_a, "inner")
    os.makedirs(inner)
    slug_i = slugify(inner)
    write(J(cd, "projects", slug_i, "i1.jsonl"), jl(
        user_str(inner, "inner prompt"), assistant_tool(inner, "Write", {"file_path": J(work_a, "docs", "x.md"), "content": "x"})))
    P.update({"slug_i": slug_i, "inner": inner})

    # skills
    write(J(cd, "skills", "mine", "SKILL.md"), "---\nname: mine\ndescription: \"my skill\"\n---\nbody\n")
    write(J(cd, "skills", ".trash", "123", "zzz", "SKILL.md"), "---\nname: zzz\n---\n")
    write(J(cd, "skills", "synced", "bucket1", "docx", "SKILL.md"),
          "---\nname: docx\ndescription: |\n  Word files.\n  Second line.\nlicense: x\n---\n")
    write(J(cd, "skills", "synced", "bucket1", ".staging", "SKILL.md"), "x")
    write(J(cd, "skills", "synced", ".bucket-bucket1"), "")
    write(J(plug, "skills", "clip", "SKILL.md"), "---\nname: clip\ndescription: clips video\n---\n")
    write(J(plug, "skills", "notes.mjs"), "x")
    write(J(cd, "plugins", "installed_plugins.json"), json.dumps({"version": 2, "plugins": {
        "vid@market": [{"scope": "local", "projectPath": nat(work_a), "installPath": nat(plug), "version": "1.0"}]}}))
    write(J(work_a, ".claude", "skills", "projskill", "SKILL.md"), "---\nname: projskill\ndescription: proj\n---\n")
    write(J(cd, "settings.json"), "{}\n")

    # deterministic mtimes: s1 newest overall, B project older than A
    t = 1790000000
    times = {s1: t + 500, s2: t + 400, s3: t + 300, s4: t + 200, b1: t + 100,
             J(pc, "c1.jsonl"): t + 50,
             J(cd, "projects", slug_h, "shared-sid.jsonl"): t + 45,
             J(cd, "projects", slug_mv, "shared-sid.jsonl"): t + 44,
             J(cd, "projects", slug_r, "r1.jsonl"): t + 40,
             J(cd, "projects", slug_l, "l1.jsonl"): t + 35,
             J(cd, "projects", slug_i, "i1.jsonl"): t + 30,
             J(cd, "projects", slug_s, "sc.jsonl"): t + 20,
             J(cd, "projects", "-nomem-project", "n1.jsonl"): t + 10}
    for p, mt in times.items():
        os.utime(p, (mt, mt))
    P["t"] = t
    return P


def snapshot(root, exclude=None):
    out = {}
    for dirpath, dirnames, filenames in os.walk(root):
        for fn in filenames + [d for d in dirnames if os.path.islink(J(dirpath, d))]:
            p = J(dirpath, fn)
            if exclude and (p == exclude or p.startswith(atlas.pdirname(exclude) + "/")):
                continue
            st = os.lstat(p)
            h = None
            if os.path.isfile(p) and not os.path.islink(p):
                with open(p, "rb") as fh:
                    h = hashlib.sha1(fh.read()).hexdigest()
            out[p] = (st.st_size, st.st_mtime_ns, h, os.path.islink(p))
    return out


def strip_timing(doc):
    doc = dict(doc)
    doc.pop("generatedAtMs", None)
    doc.pop("elapsedMs", None)
    return doc


class FrontmatterTests(unittest.TestCase):
    def test_nested_metadata_and_quotes(self):
        has, fm, body = atlas.parse_frontmatter(
            "---\nname: n\ndescription: \"a \\\"q\\\" b\"\nmetadata: \n  type: feedback\n  modified: 2026-01-01T00:00:00Z\n---\nbody\n")
        self.assertTrue(has)
        self.assertEqual(fm["description"], 'a "q" b')
        self.assertEqual(fm["metadata"], {"type": "feedback", "modified": "2026-01-01T00:00:00Z"})
        self.assertEqual(atlas.first_body_line(body), "body")

    def test_block_scalars_and_single_quotes(self):
        _, fm, _ = atlas.parse_frontmatter("---\na: >\n  one\n  two\n\n  three\nb: |\n  x\n  y\nc: 'it''s'\nd: plain\n  continued\n---\n")
        self.assertEqual(fm["a"], "one two\nthree")
        self.assertEqual(fm["b"], "x\ny")
        self.assertEqual(fm["c"], "it's")
        self.assertEqual(fm["d"], "plain continued")

    def test_unclosed_or_absent(self):
        self.assertFalse(atlas.parse_frontmatter("---\nname: x\nno end\n")[0])
        self.assertFalse(atlas.parse_frontmatter("# title\n")[0])

    def test_links(self):
        links = atlas.parse_links("[a](a.md) [b](<b c.md>) [w](https://x/y.md) [abs](/x.md) [a2](./a.md) [s](sub/s.md#h)")
        self.assertEqual(links, ["a.md", "b c.md", "sub/s.md"])

    def test_iso(self):
        self.assertEqual(atlas.iso_ms(TS0), TS0_MS)
        self.assertEqual(atlas.iso_ms("2026-10-01T09:00:00+09:00"), TS0_MS)
        self.assertIsNone(atlas.iso_ms("nope"))

    def test_slugify(self):
        # pairs as Claude Code names them under ~/.claude/projects
        self.assertEqual(slugify("/Users/alex/Misc./web game"), "-Users-alex-Misc--web-game")
        self.assertEqual(slugify("/Users/alex/Team Notes/Design Q&A"),
                         "-Users-alex-Team-Notes-Design-Q-A")
        self.assertEqual(slugify("/Users/alex/construction - Sample harness"), "-Users-alex-construction---Sample-harness")
        # non-ASCII: one dash per UTF-16 unit, as in JS
        self.assertEqual(slugify("/a/尽调"), "-a---")
        self.assertEqual(slugify("/a/\U0001F600"), "-a---")
        self.assertEqual(slugify("/a/é"), "-a--")
        long = "/" + "x" * 250
        self.assertEqual(atlas.slug_key(slugify(long)), atlas.slug_key(slugify(long) + "-hash123"))


class PosixRuleTests(unittest.TestCase):
    """The macOS rules of the pure path functions, which must stay as they are, checked on every platform
    (atlas.WINDOWS switched off)."""

    def setUp(self):
        patcher = mock.patch.object(atlas, "WINDOWS", False)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_bash_dirs(self):
        home = "/h"
        cmd = ("cd /abs/one && make > /abs/out/log.txt 2>/dev/null; curl -o ~/dl/f.bin x --output=/abs/o2/z "
               "&& cd relative && echo a -> /not/arrow && x 2>&1 && cat > out.txt\n> /quoted/line\n")
        self.assertEqual(sorted(set(atlas.bash_io_dirs(cmd, home))),
                         [("r", "/abs/one"), ("w", "/abs/o2"), ("w", "/abs/out"), ("w", "/h/dl"), ("w", "/quoted")])
        self.assertEqual(atlas.bash_io_dirs('cd "/with space/dir" && ls', home), [("r", "/with space/dir")])

    def test_paths_pass_through(self):
        odd = "/Users/alex/a\\b c/x.md"  # a backslash is an ordinary character in a POSIX file name
        self.assertEqual(atlas.fwd(odd), odd)
        self.assertEqual(atlas.pkey(odd), odd)
        self.assertEqual(atlas.native(odd), odd)
        self.assertEqual(atlas.pnorm("/a//b/../c/"), "/a/c")
        self.assertEqual(atlas.pjoin("/a", "b", "/c"), "/c")
        self.assertEqual((atlas.pdirname("/a/b\\c"), atlas.pbasename("/a/b\\c")), ("/a", "b\\c"))
        self.assertTrue(atlas.is_abs("/x"))
        for p in ("C:/x", "C:\\x", "x", "", None):
            self.assertFalse(atlas.is_abs(p), p)
        self.assertTrue(atlas.under("/a/b/c", "/a/b"))
        self.assertTrue(atlas.under("/a/b", "/a/b/"))
        self.assertTrue(atlas.under("/a", "/"))
        self.assertFalse(atlas.under("/a/B", "/a/b"))  # case matters
        self.assertFalse(atlas.under("/a/bc", "/a/b"))
        self.assertFalse(atlas.strictly_under("/a/b", "/a/b"))
        self.assertTrue(atlas.is_fs_root("/"))
        self.assertFalse(atlas.is_fs_root("/a"))
        self.assertNotEqual(atlas.slug_key("-Users-Alex"), atlas.slug_key("-users-alex"))
        self.assertEqual(atlas.parser_tag(), atlas.PARSER_VERSION)
        self.assertEqual(atlas.from_msys("/c/x", "/h"), "/c/x")
        self.assertEqual(atlas._valid_label("a\\b:c"), "a\\b:c")

    def test_kinds_and_roots(self):
        home = "/Users/alex"
        self.assertEqual(atlas.temp_roots(home, {"TEMP": "/elsewhere"}), ["/tmp", "/private/tmp"])
        self.assertEqual(atlas.scratch_roots(home, {"APPDATA": "/elsewhere"}),
                         ["/Users/alex/Library/Application Support/Claude/scratch-workspaces"])
        ws = "/Users/alex/Library/Application Support/Claude/scratch-workspaces/a/b/scratch-2026-01-02-0a1b2c"
        self.assertEqual(atlas.scratch_aliases(ws, atlas.scratch_roots(home, {})), [ws])
        self.assertEqual(atlas.kind_for(ws, "x"), "scratch")
        self.assertEqual(atlas.kind_for(None, slugify(ws)), "scratch")
        for cwd in ("/tmp", "/tmp/x", "/private/tmp", "/private/tmp/x/y"):
            self.assertEqual(atlas.kind_for(cwd, "x"), "tmp", cwd)
        for slug in ("-tmp", "-tmp-x", "-private-tmp", "-private-tmp-x"):
            self.assertEqual(atlas.kind_for(None, slug), "tmp", slug)
        for cwd, slug in (("/tmpx", "-tmpx"), ("/Users/alex/tmp/x", "-Users-alex-tmp-x"), ("/private/tmpx", "-private-tmpx")):
            self.assertEqual(atlas.kind_for(cwd, slug), "project", cwd)
            self.assertEqual(atlas.kind_for(None, slug), "project", slug)
        self.assertEqual(atlas.scratchpad_slug("/private/tmp/claude-501/-Users-alex-x/s/scratchpad", ["/tmp", "/private/tmp"]), "-Users-alex-x")
        self.assertEqual(atlas.scratchpad_slug("/tmp/claude-501/-Users-alex-x", ["/tmp", "/private/tmp"]), "-Users-alex-x")
        self.assertIsNone(atlas.scratchpad_slug("/tmp/claude/-Users-alex-x/s", ["/tmp", "/private/tmp"]))

    def test_sizes(self):
        f = types.SimpleNamespace(st_blocks=8, st_size=10, st_mode=stat.S_IFREG | 0o644)
        self.assertEqual(atlas._alloc(f), 4096)  # blocks, where the platform has them
        f = types.SimpleNamespace(st_size=10, st_mode=stat.S_IFREG | 0o644)
        d = types.SimpleNamespace(st_size=4096, st_mode=stat.S_IFDIR | 0o755)
        self.assertEqual((atlas._alloc(f), atlas._alloc(d)), (10, 0))  # no st_blocks (Windows): logical size, folders 0


class IndexTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.P = build_fixture(cls.tmp.name)
        cls.cache = J(cls.P["cd"], "cache", "atlas", "sessions-v1.json")
        # arguments in the platform's own spelling (backslashes on Windows), with a trailing separator
        code, out, err = run_atlas(cls.P["root"], "index", "--claude-dir", nat(cls.P["cd"]), "--current-cwd", nat(cls.P["b"]) + os.sep)
        cls.code, cls.raw, cls.err = code, out, err
        cls.doc = json.loads(out.decode("utf-8"))
        cls.proj = dict((p["slug"], p) for p in cls.doc["projects"])
        cls.sess = dict((s["path"], s) for s in cls.doc["sessions"])
        cls.skills = dict((k["name"], k) for k in cls.doc["skills"])
        cls.nodes = dict((n["id"], n) for n in cls.doc["docs"]["nodes"])
        cls.edges = set((e["from"], e["to"], e["type"]) for e in cls.doc["docs"]["edges"])

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def s(self, sid, slug=None):
        slug = slug or self.P["slug_a"]
        return self.sess[J(self.P["cd"], "projects", slug, sid + ".jsonl")]

    def test_exit_and_shape(self):
        self.assertEqual(self.code, 0, self.err)
        self.assertEqual(self.err, b"")
        d = self.doc
        for k in ("version", "generatedAtMs", "elapsedMs", "claudeDir", "home", "warnings", "globalClaudeMd",
                  "projects", "customMemory", "sessions", "skills", "health", "docs", "crossProject",
                  "scratchWorkspaces", "trash"):
            self.assertIn(k, d)
        self.assertEqual(d["version"], 2)
        self.assertEqual(d["home"], self.P["root"])
        self.assertEqual(d["warnings"], [])
        self.assertEqual(d["claudeDir"], self.P["cd"])
        self.assertEqual(d["globalClaudeMd"], {"path": J(self.P["cd"], "CLAUDE.md"), "exists": True, "lines": 8,
                                               "bytes": os.path.getsize(J(self.P["cd"], "CLAUDE.md"))})
        self.assertLess(len(self.raw), 3 * 1024 * 1024)
        self.assertTrue(os.path.isfile(self.cache))
        self.assertEqual(d["trash"], {"path": J(self.P["cd"], "atlas-trash"), "items": 0, "bytes": 0})
        self.assertFalse(os.path.exists(J(self.P["cd"], "atlas-trash")))

    def test_one_path_form(self):
        # contract "Paths": not one backslash in anything index prints, whatever the transcripts recorded
        self.assertEqual(backslashed(self.doc), [])
        for p in self.doc["projects"]:
            for key in ("cwd", "resolvedCwd", "memoryDir"):
                if p[key] is not None:
                    self.assertTrue(atlas.is_abs(p[key]), p[key])
        for s in self.doc["sessions"]:
            self.assertTrue(atlas.is_abs(s["path"]), s["path"])

    def test_projects_order_and_fields(self):
        slugs = [p["slug"] for p in self.doc["projects"]]
        self.assertEqual(slugs[0], self.P["slug_b"])  # current first
        self.assertTrue(self.proj[self.P["slug_b"]]["isCurrent"])
        self.assertEqual(sum(1 for p in self.doc["projects"] if p["isCurrent"]), 1)
        self.assertEqual(slugs[1:4], [self.P["slug_a"], self.P["slug_c"], self.P["slug_r"]])  # with memory, newest first
        self.assertEqual(len(slugs), 11)
        a = self.proj[self.P["slug_a"]]
        self.assertEqual(a["cwd"], self.P["a"])
        self.assertEqual(a["label"], "proj")
        self.assertEqual(a["kind"], "tmp" if self.P["a"].startswith("/private/tmp/") else "project")
        self.assertEqual(a["sessionCount"], 4)
        self.assertEqual(a["lastActiveMs"], (self.P["t"] + 500) * 1000)
        self.assertEqual(a["memoryDir"], self.P["mem_a"])
        self.assertEqual(a["loads"], [{"path": J(self.P["cd"], "CLAUDE.md"), "type": "User"},
                                      {"path": J(self.P["mem_a"], "MEMORY.md"), "type": "AutoMem"}])
        self.assertEqual(self.proj[self.P["slug_s"]]["kind"], "scratch")
        tmpp = self.proj["-private-tmp-fixture-xyz"]
        self.assertEqual((tmpp["kind"], tmpp["cwd"], tmpp["label"], tmpp["sessionCount"], tmpp["lastActiveMs"]),
                         ("tmp", None, "-private-tmp-fixture-xyz", 0, 0))
        nomem = self.proj["-nomem-project"]
        self.assertIsNone(nomem["memoryDir"])
        self.assertIsNone(nomem["index"])
        self.assertEqual(nomem["memoryFiles"], [])

    def test_memory_files(self):
        a = self.proj[self.P["slug_a"]]
        files = dict((f["name"], f) for f in a["memoryFiles"])
        self.assertEqual(sorted(files), ["a.md", "b.md", "orphan.md", "x.md"])
        fa = files["a.md"]
        self.assertEqual((fa["hasFrontmatter"], fa["title"], fa["description"], fa["type"], fa["linked"]),
                         (True, "alpha-note", 'say "hi" first', "feedback", True))
        self.assertIsNone(fa["symlinkTo"])
        fb = files["b.md"]
        self.assertEqual((fb["type"], fb["description"]), ("project", "folded line one folded line two"))
        fo = files["orphan.md"]
        self.assertEqual((fo["hasFrontmatter"], fo["title"], fo["description"], fo["type"], fo["linked"]),
                         (False, "orphan", "Orphan heading", None, False))
        self.assertEqual(files["x.md"]["symlinkTo"], J(self.P["cd"], "shared-memory", "x.md") if SYMLINKS else None)
        mt = [f["mtimeMs"] for f in a["memoryFiles"]]
        self.assertEqual(mt, sorted(mt, reverse=True))

    def test_memory_index(self):
        idx = self.proj[self.P["slug_a"]]["index"]
        self.assertTrue(idx["exists"])
        self.assertEqual(idx["links"], ["a.md", "b.md", "gone.md", "x.md"])
        self.assertEqual(idx["deadLinks"], ["gone.md"])
        self.assertEqual(idx["orphans"], ["orphan.md"])
        self.assertTrue(idx["overLineLimit"])
        self.assertTrue(idx["overByteLimit"])
        self.assertEqual(idx["lines"], 217)
        c = self.proj[self.P["slug_c"]]["index"]
        self.assertFalse(c["exists"])
        self.assertEqual(c["orphans"], ["c.md"])

    def test_custom_memory(self):
        cm = dict((c["name"], c) for c in self.doc["customMemory"])
        self.assertEqual(sorted(cm), ["memory-archive", "shared-memory"])
        self.assertEqual([f["name"] for f in cm["shared-memory"]["files"]], ["README.md", "x.md"])
        y = cm["memory-archive"]["files"][0]
        self.assertEqual((y["name"], y["title"], y["description"], y["type"], y["linked"]),
                         ("proj/2026-10-01/y.md", "archived-y", "it's archived", "project", True))

    def test_session_s1(self):
        s = self.s("s1")
        self.assertEqual(s["title"], "Final custom title")
        self.assertEqual(s["cwd"], self.P["a"])
        self.assertEqual(s["startedMs"], TS0_MS)
        self.assertEqual(s["lastMs"], (self.P["t"] + 500) * 1000)
        self.assertEqual(s["entrypoint"], "claude-desktop")
        self.assertEqual(s["version"], "2.1.5")
        self.assertEqual([l["type"] for l in s["loads"]], ["User", "AutoMem"])
        self.assertEqual(s["skillsAvailable"], ["mine", "anthropic-skills:docx", "vid:clip", "builtin-thing", "late-skill"])
        inv = dict(((i["name"], i["via"], i["inSubagent"]), i["count"]) for i in s["skillsInvoked"])
        self.assertEqual(inv, {("mine", "tool", False): 2, ("vid:clip", "tool", False): 1,
                               ("anthropic-skills:docx", "command", False): 1,
                               ("mine", "tool", True): 1, ("projskill", "tool", True): 1})
        self.assertEqual(s["memoryReads"], [J(self.P["mem_a"], "a.md"), J(self.P["cd"], "shared-memory", "x.md"),
                                            self.P["mem_b_same"]])
        self.assertEqual(s["memoryWrites"], [J(self.P["mem_a"], "b.md"), J(self.P["cd"], "CLAUDE.md"),
                                             J(self.P["a"], "CLAUDE.local.md")])
        self.assertEqual(s["subagentCount"], 2)

    def test_session_io(self):
        io = self.s("s1")["io"]
        w = dict((r["dir"], r) for r in io["writes"])
        r = dict((x["dir"], x) for x in io["reads"])
        a, root, cd = self.P["a"], self.P["root"], self.P["cd"]
        self.assertEqual((w[a]["count"], w[a]["via"], w[a]["class"]), (1, "tool", "project"))  # MultiEdit; cd is a read
        self.assertEqual((r[a]["via"], r[a]["class"]), ("bash", "project"))  # cd <a>
        self.assertEqual((w[self.P["mem_a"]]["count"], w[self.P["mem_a"]]["via"], w[self.P["mem_a"]]["class"]), (1, "tool", "claude"))
        self.assertEqual((w[cd]["class"], w[J(root, "out")]["via"]), ("claude", "bash"))
        self.assertEqual(w[J(root, "dl")]["via"], "bash")  # ~ expanded with $HOME
        self.assertEqual(w[self.P["scratchpad"]]["class"], "scratch")
        self.assertEqual(w[J(a, "nb")]["class"], "project")  # NotebookEdit
        self.assertEqual(w[J(a, "gen")]["count"], 1)  # from the subagent
        self.assertNotIn("/dev", w)
        self.assertNotIn("/quoted", w)
        self.assertEqual((r[self.P["mem_a"]]["count"], r[self.P["mem_a"]]["class"]), (2, "claude"))
        self.assertEqual(r[EXT_DIR]["class"], "external")
        self.assertEqual(r[J(a, "docs")]["class"], "project")  # Glob path
        counts = [x["count"] for x in io["writes"]]
        self.assertEqual(counts, sorted(counts, reverse=True))
        pio = self.proj[self.P["slug_a"]]["io"]
        self.assertEqual(dict((x["dir"], x["count"]) for x in pio["reads"])[self.P["mem_a"]], 2)

    def test_disk_bytes(self):
        pa = self.P["pa"]
        expect = sum(atlas.du(J(pa, n)) for n in os.listdir(pa))
        self.assertEqual(self.proj[self.P["slug_a"]]["diskBytes"], expect)
        s3 = self.s("s3")
        self.assertEqual(s3["diskBytes"], atlas.du(self.P["s3"]) + atlas.du(J(pa, "s3")))
        self.assertGreater(atlas.du(J(pa, "s3")), 0)

    def test_scratch_workspaces(self):
        ws = self.doc["scratchWorkspaces"]
        self.assertEqual(len(ws), 1)
        self.assertEqual((ws[0]["path"], ws[0]["projectSlug"], ws[0]["sessionIds"]), (self.P["scratch"], self.P["slug_s"], ["sc"]))
        self.assertGreater(ws[0]["sizeBytes"], 0)

    def test_rename_tracing(self):
        h, mv = self.proj[self.P["slug_h"]], self.proj[self.P["slug_mv"]]
        self.assertEqual((h["cwd"], h["resolution"], h["resolvedCwd"], h["label"]), (self.P["old"], "slug-match", self.P["new"], "hub"))
        hist = dict((x["path"], x) for x in h["pathHistory"])
        self.assertEqual((hist[self.P["old"]]["source"], hist[self.P["old"]]["exists"], hist[self.P["old"]]["launch"]), ("cwd", False, True))
        self.assertEqual(hist[self.P["old"]]["firstSeenMs"], TS_REC_MS)
        self.assertEqual((hist[self.P["new"]]["source"], hist[self.P["new"]]["exists"]), ("slug-match", True))
        self.assertEqual((mv["resolution"], mv["resolvedCwd"]), ("related", self.P["new"]))
        self.assertEqual(h["relatedSlugs"], [self.P["slug_mv"]])
        self.assertEqual(mv["relatedSlugs"], [self.P["slug_h"]])
        r = self.proj[self.P["slug_r"]]
        self.assertEqual((r["resolution"], r["resolvedCwd"]), ("relocated", self.P["newp"]))
        rh = dict((x["path"], x) for x in r["pathHistory"])
        self.assertEqual((rh[self.P["newp"]]["source"], rh[self.P["newp"]]["firstSeenMs"]), ("relocated", TS_REC_MS))
        l = self.proj[self.P["slug_l"]]
        self.assertEqual((l["cwd"], l["resolution"], l["resolvedCwd"]), (self.P["ab_old"], "slug-match", self.P["ab_new"]))
        self.assertEqual((self.proj[self.P["slug_c"]]["resolution"], self.proj[self.P["slug_c"]]["resolvedCwd"]), ("missing", None))
        self.assertEqual(self.proj[self.P["slug_a"]]["resolution"], "exists")
        self.assertEqual(self.proj[self.P["slug_a"]]["relatedSlugs"], [])

    def test_skills(self):
        k = self.skills
        self.assertEqual((k["mine"]["source"], k["mine"]["description"]), ("user", "my skill"))
        self.assertEqual((k["mine"]["useCount"], k["mine"]["sessionsUsing"], k["mine"]["listedIn"]), (3, 1, 2))
        self.assertEqual(k["anthropic-skills:docx"]["source"], "synced")
        self.assertEqual(k["anthropic-skills:docx"]["description"], "Word files. Second line.")
        clip = k["vid:clip"]
        self.assertEqual((clip["source"], clip["plugin"], clip["projectCwd"], clip["useCount"]), ("plugin", "vid", self.P["a"], 1))
        ps = k["projskill"]
        self.assertEqual((ps["source"], ps["projectCwd"], ps["useCount"]), ("project", self.P["a"], 1))
        for n in ("builtin-thing", "late-skill"):
            self.assertEqual((k[n]["source"], k[n]["path"], k[n]["useCount"], k[n]["listedIn"]), ("builtin", None, 0, 1))
        for n in ("old-skill", "x-before", "model", "zzz", ".staging"):
            self.assertNotIn(n, k)

    def test_health(self):
        h = self.doc["health"]
        kinds = {}
        for i in h:
            kinds.setdefault(i["kind"], []).append(i)
        self.assertEqual((h[0]["kind"], h[0]["severity"]), ("index-over-limit", "error"))
        self.assertEqual([i["path"] for i in kinds["dead-link"]], [J(self.P["mem_a"], "gone.md")])
        self.assertEqual([i["path"] for i in kinds["orphan"]], [J(self.P["mem_a"], "orphan.md")])
        self.assertEqual([i["projectSlug"] for i in kinds["no-index"]], [self.P["slug_c"]])
        self.assertEqual([i["projectSlug"] for i in kinds["cwd-missing"]], [self.P["slug_c"]])  # not the renamed ones
        self.assertEqual(sorted(i["projectSlug"] for i in kinds["renamed"]),
                         sorted([self.P["slug_h"], self.P["slug_mv"], self.P["slug_r"], self.P["slug_l"]]))
        hub = [i for i in kinds["renamed"] if i["projectSlug"] == self.P["slug_h"]][0]
        self.assertEqual(hub["message"], "项目从 %s 改名/移到了 %s" % (self.P["old"], self.P["new"]))
        self.assertEqual(len(kinds["empty-memory-dir"]), 1)
        self.assertIn("其中 2 个", kinds["empty-memory-dir"][0]["message"])
        # alpha-note in A and B; without symlinks the two x.md copies are a second pair
        self.assertEqual(len(kinds["same-title"]), 1 if SYMLINKS else 2)
        ranks = [atlas.SEVERITY_RANK[i["severity"]] for i in h]
        self.assertEqual(ranks, sorted(ranks))

    def test_docs_nodes(self):
        n, P = self.nodes, self.P
        g = J(P["cd"], "CLAUDE.md")
        self.assertEqual((n[g]["kind"], n[g]["scope"]), ("claude-md", "global"))
        ca = J(P["a"], "CLAUDE.md")
        self.assertEqual((n[ca]["kind"], n[ca]["scope"], n[ca]["projectSlug"], n[ca]["title"]), ("claude-md", "project", P["slug_a"], "Proj A"))
        self.assertEqual(n[J(P["a"], "sub", "CLAUDE.md")]["kind"], "claude-md")
        self.assertEqual(n[J(P["mem_a"], "MEMORY.md")]["kind"], "memory-index")
        self.assertEqual((n[J(P["mem_a"], "a.md")]["kind"], n[J(P["mem_a"], "a.md")]["title"]), ("memory", "alpha-note"))
        xa = J(P["mem_a"], "x.md")
        if SYMLINKS:
            self.assertEqual((n[xa]["isSymlink"], n[xa]["realPath"]), (True, J(P["cd"], "shared-memory", "x.md")))
        self.assertEqual(n[J(P["cd"], "shared-memory", "x.md")]["kind"], "custom-memory")
        self.assertEqual(n[J(P["cd"], "shared-memory", "x.md")]["scope"], "shared-memory")
        self.assertEqual((n[J(P["cd"], "skills", "mine", "SKILL.md")]["kind"], n[J(P["cd"], "skills", "mine", "SKILL.md")]["scope"]),
                         ("skill", "global"))
        psk = J(P["a"], ".claude", "skills", "projskill", "SKILL.md")
        self.assertEqual((n[psk]["kind"], n[psk]["projectSlug"]), ("skill", P["slug_a"]))
        plan = J(P["a"], "docs", "plan.md")
        self.assertEqual((n[plan]["kind"], n[plan]["projectSlug"], n[plan]["title"]), ("doc", P["slug_a"], "Plan"))
        self.assertIn(J(P["a"], "docs", "deeper.md"), n)  # reached from a doc, added but not read
        self.assertNotIn(J(P["a"], "docs", "never.md"), n)
        self.assertEqual(n[J(P["root"], "notes", "imported.md")]["scope"], "external")
        self.assertIn(J(P["root"], "notes", "more.md"), n)
        self.assertNotIn(J(P["root"], "notes", "evenmore.md"), n)
        self.assertFalse(n[J(P["mem_a"], "gone.md")]["exists"])
        cb = J(P["b"], "CLAUDE.md")
        self.assertEqual((n[cb]["kind"], n[cb]["isSymlink"]), ("claude-md", SYMLINKS))
        if SYMLINKS:
            self.assertEqual(n[J(P["b"], "AGENTS.md")]["kind"], "doc")
        self.assertFalse(self.doc["docs"]["truncated"])
        for node in n.values():
            self.assertTrue(os.path.isabs(node["id"]))

    def test_docs_edges(self):
        P, e = self.P, self.edges
        g = J(P["cd"], "CLAUDE.md")
        ca = J(P["a"], "CLAUDE.md")
        imported = J(P["root"], "notes", "imported.md")
        expect = [
            (g, imported, "import"),
            (imported, J(P["root"], "notes", "more.md"), "link"),
            (ca, J(P["a"], "docs", "plan.md"), "link"),
            (J(P["a"], "docs", "plan.md"), J(P["a"], "docs", "deeper.md"), "link"),
            (J(P["a"], "sub", "CLAUDE.md"), ca, "nested"),
            (J(P["mem_a"], "MEMORY.md"), J(P["mem_a"], "a.md"), "index"),
            (J(P["mem_a"], "MEMORY.md"), J(P["mem_a"], "gone.md"), "index"),
            (P["mem_b_same"], J(P["mem_a"], "orphan.md"), "wikilink"),
            (g, J(P["mem_a"], "b.md"), "wikilink"),
        ]
        if SYMLINKS:
            expect += [
                (J(P["mem_a"], "x.md"), J(P["cd"], "shared-memory", "x.md"), "symlink"),
                (J(P["b"], "CLAUDE.md"), J(P["b"], "AGENTS.md"), "symlink"),
                (J(P["b"], "AGENTS.md"), J(P["b"], "extra.md"), "import"),
            ]
        else:  # CLAUDE.md is then a copy of AGENTS.md and imports extra.md itself
            expect.append((J(P["b"], "CLAUDE.md"), J(P["b"], "extra.md"), "import"))
        for edge in expect:
            self.assertIn(edge, e)
        targets = set(t for _, t, _ in e)
        self.assertFalse([t for t in targets if t.endswith("/author") or "scope" in t])
        self.assertFalse([x for x in e if x[0] == J(P["a"], "docs", "deeper.md")])  # not read

    def test_cross_project(self):
        P = self.P
        c = dict(((x["from"], x["to"], x["kind"]), x["count"]) for x in self.doc["crossProject"])
        self.assertEqual(c[(P["slug_a"], P["slug_b"], "session-read")], 1)
        self.assertEqual(c[(P["slug_a"], "shared-memory", "session-read")], 1)
        self.assertEqual(c[(P["slug_a"], "global", "session-write")], 1)
        if SYMLINKS:
            self.assertEqual(c[(P["slug_a"], "shared-memory", "symlink")], 1)
            self.assertEqual(c[(P["slug_b"], "shared-memory", "symlink")], 1)
        self.assertEqual(c[(P["slug_b"], P["slug_a"], "wikilink")], 1)
        self.assertEqual(c[("global", P["slug_a"], "wikilink")], 1)
        nested = dict(((x["from"], x["to"], x["kind"]), x["nested"]) for x in self.doc["crossProject"])
        self.assertEqual(c[(P["slug_i"], P["slug_a"], "session-write")], 1)
        self.assertTrue(nested[(P["slug_i"], P["slug_a"], "session-write")])
        self.assertFalse(nested[(P["slug_a"], P["slug_b"], "session-read")])
        self.assertEqual(c[(P["slug_a"], P["slug_h"], "session-write")], 1)  # old path of the renamed project -> the folder that exists
        self.assertNotIn((P["slug_a"], P["slug_mv"], "session-write"), c)
        for (a, b, _k) in c:
            self.assertNotEqual(a, b)
            self.assertNotIn("external", (a, b))
        self.assertNotIn((P["slug_h"], P["slug_mv"]), [(a, b) for a, b, _ in c])

    def test_warm_run_identical_and_cache_small(self):
        # the other spelling of the same arguments: forward slashes
        code, out, err = run_atlas(self.P["root"], "index", "--claude-dir", self.P["cd"], "--current-cwd", self.P["b"] + "/")
        self.assertEqual(code, 0)
        warm = json.loads(out.decode("utf-8"))
        self.assertEqual(strip_timing(warm), strip_timing(self.doc))
        with open(self.cache, "rb") as fh:
            cache_bytes = fh.read()
        cache = json.loads(cache_bytes)
        self.assertEqual(cache["parser"], atlas.parser_tag())
        self.assertEqual(backslashed(cache), [])
        self.assertTrue(cache["homeScan"]["key"].startswith(self.P["root"] + "|"))
        for secret in (b"SECRET-INSTRUCTIONS-CONTENT", b"LISTING-DESCRIPTION", b"SECRET-NESTED-CONTENT", b"quoted line"):
            self.assertNotIn(secret, cache_bytes)
        self.assertNotIn(b"\n ", cache_bytes)  # compact
        self.assertFalse([n for n in os.listdir(os.path.dirname(self.cache)) if n != "sessions-v1.json"])


class SearchTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.P = build_fixture(cls.tmp.name)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_search_scopes_and_case(self):
        code, doc, _ = run_json(self.P["root"], "search", "zebra记忆", "--claude-dir", self.P["cd"])
        self.assertEqual(code, 0)
        self.assertEqual(doc["query"], "zebra记忆")
        res = doc["results"]
        self.assertEqual(sorted(set(r["scope"] for r in res)), ["custom", "global", "project"])
        g = [r for r in res if r["scope"] == "global"][0]
        self.assertEqual((g["line"], g["projectSlug"], g["text"]), (3, None, "Zebra记忆token in global"))
        a = [r for r in res if r["path"] == J(self.P["mem_a"], "a.md")][0]
        self.assertEqual((a["projectSlug"], a["line"]), (self.P["slug_a"], 10))
        self.assertEqual(len(res), 1 + 1 + 2 + 1 + 1)

    def test_search_limit_and_empty(self):
        _, doc, _ = run_json(self.P["root"], "search", "ZEBRA", "--claude-dir", self.P["cd"], "--limit", "2")
        self.assertEqual(len(doc["results"]), 2)
        _, doc, _ = run_json(self.P["root"], "search", "no-such-thing-anywhere", "--claude-dir", self.P["cd"])
        self.assertEqual(doc["results"], [])


class CacheAndSafetyTests(unittest.TestCase):
    def test_read_only_and_cache_invalidation(self):
        with tempfile.TemporaryDirectory() as tmp:
            P = build_fixture(tmp)
            cache = J(P["root"], "elsewhere", "c.json")
            before = snapshot(P["root"], cache)
            for _ in range(2):
                code, out, err = run_atlas(P["root"], "index", "--claude-dir", P["cd"], "--cache", cache)
                self.assertEqual(code, 0, err)
            for args in (["trash-list"], ["purge", "--dry-run"], ["search", "x"]):
                code, out, err = run_atlas(P["root"], *(args + ["--claude-dir", P["cd"]]))
                self.assertEqual(code, 0, err)
            self.assertEqual(snapshot(P["root"], cache), before)
            self.assertFalse(os.path.exists(J(P["cd"], "atlas-trash")))
            self.assertTrue(os.path.isfile(cache))
            with open(P["s2"], "a", encoding="utf-8") as fh:
                fh.write(jl({"type": "custom-title", "customTitle": "Renamed s2", "sessionId": "s2"}))
            os.remove(P["s4"])
            _, doc, _ = run_json(P["root"], "index", "--claude-dir", P["cd"], "--cache", cache)
            titles = dict((s["id"], s["title"]) for s in doc["sessions"])
            self.assertEqual(titles["s2"], "Renamed s2")
            self.assertNotIn("s4", titles)
            with open(cache, "rb") as fh:
                files = json.loads(fh.read())["files"]
            self.assertNotIn(P["s4"], files)
            self.assertIn(P["s2"], files)

    def test_corrupt_cache_and_fatal_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            P = build_fixture(tmp)
            cache = J(P["root"], "c.json")
            write(cache, "{not json")
            code, doc, _ = run_json(P["root"], "index", "--claude-dir", P["cd"], "--cache", cache)
            self.assertEqual(code, 0)
            self.assertTrue(any("缓存" in w for w in doc["warnings"]))
            code, doc, _ = run_json(P["root"], "index", "--claude-dir", J(P["root"], "missing"))
            self.assertEqual(code, 1)
            self.assertIn("error", doc)
            code, doc, _ = run_json(P["root"], "bogus")
            self.assertEqual(code, 1)
            self.assertIn("error", doc)


class TrashTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.P = build_fixture(self.tmp.name)
        self.cd = self.P["cd"]
        self.troot = J(self.cd, "atlas-trash")

    def tearDown(self):
        self.tmp.cleanup()

    def cli(self, *args):
        code, doc, err = run_json(self.P["root"], *(list(args) + ["--claude-dir", self.cd]))
        self.assertEqual(code, 0, err)
        self.assertEqual(backslashed(doc), [])  # every argument here is spelled with forward slashes
        return doc

    def items(self):
        return [n for n in os.listdir(self.troot)] if os.path.isdir(self.troot) else []

    def test_round_trip_folder_session_memory(self):
        P = self.P
        nomem = J(self.cd, "projects", "-nomem-project")
        s3dir = J(P["pa"], "s3")
        a_md = J(P["mem_a"], "a.md")
        index = J(P["mem_a"], "MEMORY.md")
        index_before = read(index)
        doc = self.cli("trash", nomem, P["s3"], a_md, "--label", "清理", "--days", "7")
        self.assertEqual(doc["refused"], [])
        by_class = dict((m["pathClass"], m) for m in doc["trashed"])
        self.assertEqual(sorted(by_class), ["memory", "project", "session"])
        sess = by_class["session"]
        self.assertEqual([p["originalPath"] for p in sess["parts"]], [P["s3"], s3dir])
        self.assertEqual(sess["expiresAtMs"] - sess["deletedAtMs"], 7 * 86400000)
        self.assertEqual(sess["label"], "清理")
        mem = by_class["memory"]
        self.assertEqual(mem["indexLines"], [{"line": 3, "text": "- [Alpha](a.md) — first"}])
        self.assertEqual(mem["indexPath"], index)
        for p in (nomem, P["s3"], s3dir, a_md):
            self.assertFalse(os.path.lexists(p))
        self.assertNotIn("(a.md)", read(index))
        lst = self.cli("trash-list")
        self.assertEqual(len(lst["items"]), 3)
        self.assertTrue(all(m["exists"] for m in lst["items"]))
        self.assertGreater(lst["bytes"], 0)
        _, idx_doc, _ = run_json(P["root"], "index", "--claude-dir", self.cd)
        self.assertEqual(idx_doc["trash"]["items"], 3)
        res = self.cli("restore", *[m["id"] for m in doc["trashed"]])
        self.assertEqual(res["refused"], [])
        self.assertEqual(len(res["restored"]), 3)
        for p in (nomem, P["s3"], J(s3dir, "tool-results", "r.txt"), a_md):
            self.assertTrue(os.path.lexists(p), p)
        self.assertEqual(read(index), index_before)
        self.assertEqual(self.items(), [])

    def test_refusals(self):
        P, cd = self.P, self.cd
        os.makedirs(J(P["root"], "outside"))
        write(J(P["root"], "outside", "inner.md"), "x")
        if SYMLINKS:
            os.symlink(nat(J(P["root"], "outside")), nat(J(cd, "shared-memory", "linkdir")))
        write(J(P["b"], "random.txt"), "x")
        os.makedirs(J(cd, "skills", ".trash", "keep"), exist_ok=True)
        cache = J(cd, "cache", "atlas", "sessions-v1.json")  # trash may refresh atlas's own cache
        before = snapshot(P["root"], cache)
        bad = [
            J(cd, "CLAUDE.md"),
            J(cd, "plugins", "installed_plugins.json"),
            J(cd, "plugins"),
            J(cd, "skills", "synced", "bucket1", "docx"),
            J(cd, "skills", "synced"),
            J(cd, "skills"),
            J(cd, "skills", ".trash"),
            J(cd, "skills", "mine", "SKILL.md"),
            J(cd, "projects"),
            J(cd, "shared-memory"),
            J(cd, "memory-archive"),
            J(P["pa"], "s1", "subagents", "agent-a1.jsonl"),
            J(P["pa"], "s1"),
            J(P["mem_a"], "MEMORY.md"),
            P["mem_a"],
            J(cd, "settings.json"),
            J(P["b"], "random.txt"),
            J(P["root"], "does-not-exist"),
            cd + "/projects/" + P["slug_a"] + "/../../CLAUDE.md",
            J(P["scratch_root"], "aa"),
            J(P["root"], "plugcache", "vid", "1.0", "skills", "clip"),
            "/",
            "",
            "relative/path.md",
        ]
        if SYMLINKS:
            bad.append(J(cd, "shared-memory", "linkdir", "inner.md"))
        doc = self.cli("trash", *bad)
        self.assertEqual(doc["trashed"], [])
        self.assertEqual([r["path"] for r in doc["refused"]], bad)
        for r in doc["refused"]:
            self.assertTrue(r["reason"])
        prot = self.cli("trash", P["s1"], P["pa"], "--protect-session", "s1")
        self.assertEqual(prot["trashed"], [])
        self.assertEqual([r["path"] for r in prot["refused"]], [P["s1"], P["pa"]])
        prot2 = self.cli("trash", P["scratch"], "--protect-session", "sc")
        self.assertEqual(prot2["trashed"], [])
        self.assertEqual(snapshot(P["root"], cache), before)
        # once something is in the trash, the trash itself is off limits
        ok = self.cli("trash", J(P["mem_a"], "orphan.md"))
        item = J(self.troot, ok["trashed"][0]["id"])
        doc = self.cli("trash", item, J(item, "payload"), J(item, "meta.json"))
        self.assertEqual(len(doc["refused"]), 3)
        bad_days = self.cli("trash", J(P["mem_a"], "b.md"), "--days", "-1")
        self.assertEqual(bad_days["trashed"], [])

    @unittest.skipUnless(SYMLINKS, "needs symlinks (on Windows: Developer Mode or admin)")
    def test_symlink_moved_not_target(self):
        P = self.P
        target = J(P["root"], "outside", "target.md")
        write(target, "precious\n")
        link = J(self.cd, "shared-memory", "ext-link.md")
        os.symlink(nat(target), nat(link))
        doc = self.cli("trash", link)
        self.assertEqual(len(doc["trashed"]), 1)
        payload = J(self.troot, doc["trashed"][0]["id"], "payload")
        self.assertTrue(os.path.islink(payload))
        self.assertEqual(read(target), "precious\n")
        self.assertFalse(os.path.lexists(link))
        purge = self.cli("purge", "--now", doc["trashed"][0]["id"])
        self.assertEqual(len(purge["purged"]), 1)
        self.assertEqual(read(target), "precious\n")  # purging the link never touches its target

    def test_other_allowed_classes(self):
        P, cd = self.P, self.cd
        targets = [
            J(cd, "skills", "mine"),
            J(P["a"], ".claude", "skills", "projskill"),
            J(P["a"], "CLAUDE.md"),
            P["scratch"],
            J(cd, "shared-memory", "README.md"),
            J(cd, "memory-archive", "proj"),
        ]
        before = snapshot(P["root"])
        doc = self.cli("trash", *targets, "--protect-session", "s1")
        self.assertEqual(doc["refused"], [])
        self.assertEqual([m["pathClass"] for m in doc["trashed"]],
                         ["user-skill", "project-skill", "project-claude-md", "scratch-workspace", "shared-memory", "memory-archive"])
        for t in targets:
            self.assertFalse(os.path.lexists(t))
        res = self.cli("restore", *[m["id"] for m in doc["trashed"]])
        self.assertEqual(len(res["restored"]), 6)
        after = snapshot(P["root"])
        cache_dir = J(cd, "cache")
        self.assertEqual(dict((k, v) for k, v in after.items() if not k.startswith(cache_dir)), before)

    def test_restore_never_overwrites(self):
        orphan = J(self.P["mem_a"], "orphan.md")
        doc = self.cli("trash", orphan)
        write(orphan, "new content\n")
        res = self.cli("restore", doc["trashed"][0]["id"])
        self.assertEqual(res["restored"], [])
        self.assertEqual(len(res["refused"]), 1)
        self.assertEqual(read(orphan), "new content\n")
        self.assertEqual(len(self.items()), 1)
        res = self.cli("restore", "../../etc", "1234")
        self.assertEqual(len(res["refused"]), 2)

    def test_purge_expiry_dry_run_and_now(self):
        P = self.P
        t0 = self.cli("trash", J(P["mem_a"], "orphan.md"), "--days", "0")["trashed"][0]
        t30 = self.cli("trash", J(P["mem_a"], "b.md"), "--days", "30")["trashed"][0]
        dry = self.cli("purge", "--dry-run")
        self.assertEqual(([m["id"] for m in dry["purged"]], dry["dryRun"], dry["keptCount"]), ([t0["id"]], True, 1))
        self.assertEqual(len(self.items()), 2)
        self.assertTrue(all(m["exists"] for m in self.cli("trash-list")["items"]))
        real = self.cli("purge")
        self.assertEqual(([m["id"] for m in real["purged"]], real["keptCount"]), ([t0["id"]], 1))
        self.assertGreater(real["freedBytes"], 0)
        self.assertEqual(self.items(), [t30["id"]])
        upd = self.cli("set-expiry", t30["id"], "--days", "0")
        self.assertLessEqual(upd["updated"]["expiresAtMs"], atlas.now_ms())
        later = self.cli("trash", J(P["mem_a"], "a.md"))["trashed"][0]
        now = self.cli("purge", "--now", later["id"], "1790000000000-deadbeef")
        self.assertEqual([m["id"] for m in now["purged"]], [later["id"]])
        self.assertEqual(len(now["refused"]), 1)
        self.assertEqual(self.items(), [t30["id"]])
        self.assertEqual([m["id"] for m in self.cli("purge")["purged"]], [t30["id"]])
        self.assertEqual(self.items(), [])

    def test_never_expires_until_emptied_by_hand(self):
        P = self.P
        kept = self.cli("trash", J(P["mem_a"], "orphan.md"), "--days", "never")["trashed"][0]
        self.assertIsNone(kept["expiresAtMs"])
        due = self.cli("trash", J(P["mem_a"], "b.md"), "--days", "0")["trashed"][0]
        listed = dict((m["id"], m) for m in self.cli("trash-list")["items"])
        self.assertIsNone(listed[kept["id"]]["expiresAtMs"])
        # a purge of what has expired leaves it, however often it runs
        for _ in range(2):
            out = self.cli("purge")
            self.assertNotIn(kept["id"], [m["id"] for m in out["purged"]])
        self.assertEqual(self.items(), [kept["id"]])
        self.assertNotIn(due["id"], self.items())
        # its expiry can be given and taken away again
        upd = self.cli("set-expiry", kept["id"], "--days", "7")
        self.assertGreater(upd["updated"]["expiresAtMs"], atlas.now_ms())
        self.assertIsNone(self.cli("set-expiry", kept["id"], "--days", "Never")["updated"]["expiresAtMs"])
        self.assertEqual(self.cli("purge")["purged"], [])
        # and it still comes back whole
        self.assertEqual(self.cli("restore", kept["id"])["refused"], [])
        self.assertTrue(os.path.exists(J(P["mem_a"], "orphan.md")))
        bad = self.cli("trash", J(P["mem_a"], "a.md"), "--days", "sometimes")
        self.assertEqual((bad["trashed"], len(bad["refused"])), ([], 1))

    def test_purge_all_empties_whatever_the_expiry(self):
        P = self.P
        ids = [self.cli("trash", J(P["mem_a"], name), "--days", days)["trashed"][0]["id"]
               for name, days in (("orphan.md", "never"), ("b.md", "30"), ("a.md", "0"))]
        dry = self.cli("purge", "--all", "--dry-run")
        self.assertEqual((sorted(m["id"] for m in dry["purged"]), dry["keptCount"], dry["dryRun"]), (sorted(ids), 0, True))
        self.assertEqual(sorted(self.items()), sorted(ids))
        real = self.cli("purge", "--all")
        self.assertEqual((sorted(m["id"] for m in real["purged"]), real["keptCount"], real["refused"]), (sorted(ids), 0, []))
        self.assertGreater(real["freedBytes"], 0)
        self.assertEqual(self.items(), [])
        self.assertEqual(self.cli("purge", "--all")["purged"], [])

    def test_archive_memory_never_overwrites(self):
        P = self.P
        b_md = J(P["mem_a"], "b.md")
        original = read(b_md)
        doc = self.cli("archive-memory", b_md, "--project-label", "proj-label")
        dest = J(self.cd, "memory-archive", "proj-label", "b.md")
        self.assertEqual(doc["archived"]["to"], dest)
        self.assertEqual(read(dest), original)
        self.assertFalse(os.path.exists(b_md))
        self.assertNotIn("(b.md", read(J(P["mem_a"], "MEMORY.md")))
        self.assertEqual(doc["archived"]["indexLines"][0]["line"], 4)
        write(b_md, "second b\n")
        again = self.cli("archive-memory", b_md, "--project-label", "proj-label")
        self.assertIsNone(again["archived"])
        self.assertEqual(read(dest), original)
        self.assertEqual(read(b_md), "second b\n")
        cases = [(b_md, "../escape"), (b_md, ".hidden"), (b_md, ""), (J(self.cd, "shared-memory", "x.md"), "ok")]
        if SYMLINKS:
            cases.append((J(P["mem_a"], "x.md"), "ok"))  # a link: to be trashed, not archived
        if WIN:
            cases += [(b_md, "..\\escape"), (b_md, "C:"), (b_md, "a:b"), (b_md, "nul"), (b_md, "dot.")]
        for path, label in cases:
            self.assertIsNone(self.cli("archive-memory", path, "--project-label", label)["archived"], label)
        self.assertEqual(self.cli("trash-list")["items"], [])

    def test_exdev_refused_and_rolled_back(self):
        P = self.P
        a_md = J(P["mem_a"], "a.md")
        index = J(P["mem_a"], "MEMORY.md")
        index_before = read(index)
        real_rename = os.rename

        def always_exdev(src, dst):
            raise OSError(errno.EXDEV, "Cross-device link")

        calls = {"n": 0}

        def second_fails(src, dst):
            calls["n"] += 1
            if calls["n"] == 2:
                raise OSError(errno.EXDEV, "Cross-device link")
            real_rename(src, dst)

        with mock.patch.dict(os.environ, fixture_env(P["root"])):
            with mock.patch.object(atlas, "_rename", side_effect=always_exdev):
                doc = atlas.cmd_trash(self.cd, None, [a_md], None, None, None, None)
                arch = atlas.cmd_archive_memory(self.cd, a_md, "lab")
            self.assertEqual(doc["trashed"], [])
            self.assertIn("卷", doc["refused"][0]["reason"])
            self.assertIsNone(arch["archived"])
            self.assertIn("卷", arch["refused"][0]["reason"])
            self.assertTrue(os.path.isfile(a_md))
            self.assertEqual(read(index), index_before)
            self.assertFalse(os.path.exists(J(self.cd, "memory-archive", "lab")))
            with mock.patch.object(atlas, "_rename", side_effect=second_fails):
                doc = atlas.cmd_trash(self.cd, None, [P["s3"]], None, None, None, None)
            self.assertEqual(doc["trashed"], [])
            self.assertTrue(os.path.isfile(P["s3"]))
            self.assertTrue(os.path.isdir(J(P["pa"], "s3")))
        self.assertEqual(self.items(), [])


class WindowsRuleTests(unittest.TestCase):
    """The Windows rules of the pure path functions, on every platform (atlas.WINDOWS switched on).
    On a Mac the file system underneath is still POSIX, so only functions that work on strings, or on a
    folder they are handed, are exercised here; the commands themselves run for real on Windows only."""

    HOME = "C:/Users/alex"
    CD = "C:/Users/alex/.claude"
    PLAIN = "C:/Users/alex/AppData/Roaming/Claude/scratch-workspaces"
    MSIX = "C:/Users/alex/AppData/Local/Packages/Claude_pzs8sxrjxfjjc/LocalCache/Roaming/Claude/scratch-workspaces"

    def setUp(self):
        patcher = mock.patch.object(atlas, "WINDOWS", True)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_one_path_form(self):
        f = atlas.fwd
        self.assertEqual(f("E:\\claude-code\\projects\\foo"), "E:/claude-code/projects/foo")
        self.assertEqual(f("C:\\Users/alex\\.claude/projects"), "C:/Users/alex/.claude/projects")  # mixed slashes
        self.assertEqual(f("e:\\x"), "E:/x")  # drive letter upper-cased
        self.assertEqual(f("c:"), "C:")
        self.assertEqual(f("C:/already/fine"), "C:/already/fine")
        self.assertEqual(f("\\\\?\\C:\\long\\path"), "C:/long/path")
        self.assertEqual(f("\\\\?\\UNC\\srv\\share\\x"), "//srv/share/x")
        self.assertEqual(f("\\\\srv\\share\\x"), "//srv/share/x")
        self.assertEqual(f("sub\\note.md"), "sub/note.md")
        self.assertEqual(f("c:note.md"), "c:note.md")  # drive-relative: not a drive path, left alone
        self.assertIsNone(f(None))
        self.assertEqual(f(""), "")
        self.assertEqual(atlas.native("C:/Users/alex/a b.md"), "C:\\Users\\alex\\a b.md")
        self.assertEqual(atlas.pjoin("C:\\Users\\alex", ".claude", "projects"), "C:/Users/alex/.claude/projects")
        self.assertEqual(atlas.pjoin("E:/proj", "D:\\other\\x.md"), "D:/other/x.md")
        self.assertEqual(atlas.pjoin("E:/proj/sub", "/rooted/x.md"), "E:/rooted/x.md")
        self.assertEqual(atlas.pnorm("e:\\a\\.\\b\\..\\c\\"), "E:/a/c")
        self.assertEqual(atlas.pnorm("C:/a//b/../c"), "C:/a/c")
        self.assertEqual(atlas.pdirname("E:\\claude-code\\projects\\foo"), "E:/claude-code/projects")
        self.assertEqual(atlas.pdirname("E:/foo"), "E:/")
        self.assertEqual(atlas.pdirname("E:/"), "E:/")
        self.assertEqual(atlas.pbasename("E:\\claude-code\\projects\\foo bar"), "foo bar")
        self.assertEqual(atlas.pbasename("E:/"), "")

    def test_is_abs(self):
        for p in ("C:\\x", "C:/x", "c:/", "E:\\", "\\\\srv\\share\\x", "//srv/share"):
            self.assertTrue(atlas.is_abs(p), p)
        for p in ("/x", "\\x", "C:x", "C:", "x", "", "~/x", ".\\x", None, 3):
            self.assertFalse(atlas.is_abs(p), p)

    def test_compare_without_case(self):
        self.assertTrue(atlas.same_path("C:\\Users\\Alex\\.claude", "c:/users/alex/.CLAUDE"))
        self.assertTrue(atlas.under("c:\\users\\ALEX\\.claude\\projects\\x", self.CD))
        self.assertTrue(atlas.under(self.CD, self.CD + "/"))
        self.assertFalse(atlas.under("E:/foobar/x", "E:/foo"))
        self.assertTrue(atlas.under("E:/x/y", "E:/"))
        self.assertTrue(atlas.under("e:/", "E:/"))
        self.assertFalse(atlas.under("D:/x", "E:/"))
        self.assertTrue(atlas.strictly_under("E:/a/B", "e:/A"))
        self.assertFalse(atlas.strictly_under("E:/A", "e:/a"))
        odd = "C:\\Users\\Alex\\笔记\\ÀİB"
        self.assertEqual(atlas.pkey(odd), "c:/users/alex/笔记/àİb")  # one character for one: prefixes keep their length
        self.assertEqual(len(atlas.pkey(odd)), len(odd))
        for p in ("C:/", "C:", "c:\\", "//srv/share", "//srv/share/", ""):
            self.assertTrue(atlas.is_fs_root(p), p)
        for p in ("C:/Users", "//srv/share/x"):
            self.assertFalse(atlas.is_fs_root(p), p)
        self.assertEqual(atlas.name_key("MEMORY.md"), atlas.name_key("memory.MD"))

    def test_slug_round_trip(self):
        cases = (
            ("E:\\claude-code\\projects\\foo", "E--claude-code-projects-foo"),
            ("C:\\Users\\alex", "C--Users-alex"),
            ("E:\\", "E--"),
            ("\\\\srv\\share\\proj", "--srv-share-proj"),
            ("E:\\claude-code\\projects\\我的 项目.v2", "E--claude-code-projects" + "-" * 7 + "v2"),
        )
        for raw, slug in cases:
            canon = atlas.fwd(raw)
            self.assertEqual(slugify(raw), slug)  # as Claude Code names the folder, from the cwd it recorded
            self.assertEqual(slugify(canon), slug)  # and the same from the forward-slash form
            sub = canon.rstrip("/") + "/sub"
            summaries = [{"firstCwd": sub, "cwdCounts": {canon: 2, sub: 9}}]
            self.assertEqual(atlas.choose_project_cwd(slug, summaries), canon)  # slug -> the cwd it stands for
            self.assertEqual(atlas.choose_project_cwd(slug.lower(), summaries), canon)  # NTFS: e--foo is E--foo
            self.assertEqual(atlas.choose_project_cwd("Z--unrelated", summaries), sub)
        # e: in one session and E: in the next are one cwd and one slug
        self.assertEqual(atlas.fwd("e:\\claude-code\\projects\\foo"), atlas.fwd("E:\\claude-code\\projects\\foo"))
        self.assertEqual(atlas.slug_key(slugify("e:\\claude-code\\projects\\foo")), atlas.slug_key("E--claude-code-projects-foo"))
        long = "E:\\" + "x" * 250
        self.assertEqual(atlas.slug_key(slugify(long)), atlas.slug_key(slugify(long) + "-hash123"))

    def test_kinds_and_temp_roots(self):
        env = {"TEMP": "C:\\Users\\alex\\AppData\\Local\\Temp", "SystemRoot": "C:\\Windows"}
        tmp = atlas.temp_roots(self.HOME, env)
        self.assertEqual(tmp, ["/tmp", "/private/tmp", "C:/Users/alex/AppData/Local/Temp", "C:/Windows/Temp"])
        # %TEMP% in its 8.3 short spelling: both spellings count
        short = atlas.temp_roots("C:/Users/alex-long-name", {"TEMP": "C:\\Users\\ALEX-~1\\AppData\\Local\\Temp"})
        self.assertEqual(short[2:], ["C:/Users/ALEX-~1/AppData/Local/Temp", "C:/Users/alex-long-name/AppData/Local/Temp"])
        self.assertEqual(atlas.temp_roots(self.HOME, {})[2:], ["C:/Users/alex/AppData/Local/Temp"])
        ws = "/3f2a/9c1d/scratch-2026-01-02-0a1b2c"
        for root in (self.PLAIN, self.MSIX):
            self.assertEqual(atlas.kind_for(root + ws, "x", tmp), "scratch")
            self.assertEqual(atlas.kind_for((root + ws).lower(), "x", tmp), "scratch")
            self.assertEqual(atlas.kind_for(None, slugify(root + ws), tmp), "scratch")
            self.assertEqual(atlas.kind_for(None, slugify(root + ws).lower(), tmp), "scratch")
        for cwd in ("C:/Users/alex/AppData/Local/Temp/job1", "c:/users/ALEX/appdata/local/temp", "C:/Windows/Temp/x", "/tmp/x"):
            self.assertEqual(atlas.kind_for(cwd, "x", tmp), "tmp", cwd)
        for slug in ("C--Users-alex-AppData-Local-Temp-job1", "c--users-alex-appdata-local-temp", "-private-tmp-x"):
            self.assertEqual(atlas.kind_for(None, slug, tmp), "tmp", slug)
        for cwd in ("E:/claude-code/projects/foo", "C:/Users/alex", "C:/Users/alex/AppData/Local/Temporary/x"):
            self.assertEqual(atlas.kind_for(cwd, "x", tmp), "project", cwd)
            self.assertEqual(atlas.kind_for(None, slugify(cwd), tmp), "project", cwd)

    def test_scratchpad_owner(self):
        tmp = ["/tmp", "/private/tmp", "C:/Users/alex/AppData/Local/Temp"]
        sp = atlas.scratchpad_slug
        self.assertEqual(sp("C:/Users/alex/AppData/Local/Temp/claude/E--claude-code-projects-foo/sid/scratchpad", tmp),
                         "E--claude-code-projects-foo")
        self.assertEqual(sp("c:/users/alex/appdata/local/temp/Claude-0/E--foo/sid", tmp), "E--foo")
        self.assertIsNone(sp("C:/Users/alex/AppData/Local/Temp/claudette/E--foo/sid", tmp))
        self.assertIsNone(sp("C:/Users/alex/AppData/Local/Temp/claude", tmp))
        self.assertIsNone(sp("E:/claude/E--foo/x", tmp))
        self.assertEqual(sp("/private/tmp/claude-501/-Users-alex-x/s/scratchpad", tmp), "-Users-alex-x")

    def test_scratch_roots_and_msix_container(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            home = atlas.fwd(os.path.realpath(tmpdir))
            plain = home + "/AppData/Roaming/Claude/scratch-workspaces"
            msix = home + "/AppData/Local/Packages/Claude_pzs8sxrjxfjjc/LocalCache/Roaming/Claude/scratch-workspaces"
            w1 = plain + "/s1/l1/scratch-2026-11-01-aaaaaa"
            w2 = msix + "/s2/l2/scratch-2026-11-02-bbbbbb"
            for d in (w1, w2, msix + "/s2/l2/not-a-workspace", msix + "/.hidden/l/scratch-x",
                      home + "/AppData/Local/Packages/Some.Other_1/LocalCache/Roaming/NotClaude"):
                os.makedirs(d)
            env = {"APPDATA": (home + "/AppData/Roaming").replace("/", "\\"), "LOCALAPPDATA": (home + "/AppData/Local").replace("/", "\\")}
            roots = atlas.scratch_roots(home, env)
            self.assertEqual(roots, [plain, msix])
            self.assertEqual(atlas.scratch_roots(home, {}), [plain, msix])  # from the home folder alone
            self.assertEqual(sorted(atlas.list_scratch_workspaces(home, roots)), sorted([w1, w2]))
            # inside the container both roots are one folder: a workspace is listed once
            with mock.patch.object(atlas, "_file_identity", return_value=("one", "folder")):
                self.assertEqual(len(atlas.list_scratch_workspaces(home, roots)), 1)
            # a session in the container records the plain spelling; a process outside sees the package's
            self.assertEqual(atlas.scratch_aliases(w2, roots), [w2, plain + "/s2/l2/scratch-2026-11-02-bbbbbb"])
            self.assertEqual(atlas.scratch_aliases(w1.upper(), roots)[1], msix + "/S1/L1/SCRATCH-2026-11-01-AAAAAA")
            self.assertEqual(atlas.scratch_aliases("E:/elsewhere/x", roots), ["E:/elsewhere/x"])
            with mock.patch.dict(os.environ, {"APPDATA": env["APPDATA"], "LOCALAPPDATA": env["LOCALAPPDATA"]}):
                ctx = atlas.TrashContext(home + "/.claude", home, "sid", lambda: [])
            self.assertEqual([atlas.pkey(r) for r in ctx.scratch], [atlas.pkey(plain), atlas.pkey(msix)])
            # the project folder is named after the spelling the session recorded
            write(home + "/.claude/projects/" + slugify(plain + "/s2/l2/scratch-2026-11-02-bbbbbb") + "/sid.jsonl", "")
            self.assertTrue(ctx.workspace_protected(w2))
            self.assertFalse(ctx.workspace_protected(w1))

    def test_io_class(self):
        cd = [atlas.pkey(self.CD)]
        proj = [atlas.pkey("E:/claude-code/projects/foo")]
        scratch = [atlas.pkey(r) for r in ("/tmp", "C:/Users/alex/AppData/Local/Temp", self.PLAIN, self.MSIX)]
        for d, want in (
            ("c:\\USERS\\alex\\.claude\\projects", "claude"),
            ("E:/Claude-Code/projects/foo/src", "project"),
            (self.MSIX + "/a/b/scratch-1/out", "scratch"),
            (self.PLAIN + "/a/b/scratch-1", "scratch"),
            ("C:/Users/alex/AppData/Local/Temp/claude/E--foo/s/scratchpad", "scratch"),
            ("E:/claude-code/projects/foobar", "external"),
            ("D:/x", "external"),
        ):
            self.assertEqual(atlas.io_class(d, cd, proj, scratch), want, d)

    def test_launch_parents(self):
        paths = ["E:/claude-code/projects/foo", "e:\\claude-code\\projects\\bar", "E:/claude-code/projects/foo/", "E:/", "C:/Users/alex",
                 "relative/x", "/rooted", None]
        self.assertEqual(atlas.launch_parents(paths), ["C:/Users", "E:/claude-code/projects"])

    def test_git_bash_paths(self):
        with mock.patch.dict(os.environ, {"TEMP": "C:\\Users\\alex\\AppData\\Local\\Temp"}):
            self.assertEqual(atlas.from_msys("/c/Users/alex/x", self.HOME), "C:/Users/alex/x")
            self.assertEqual(atlas.from_msys("/e", self.HOME), "E:/")
            self.assertEqual(atlas.from_msys("/tmp/build/x", self.HOME), "C:/Users/alex/AppData/Local/Temp/build/x")
            self.assertEqual(atlas.from_msys("/usr/bin/env", self.HOME), "/usr/bin/env")
            self.assertEqual(atlas.from_msys("E:/x", self.HOME), "E:/x")
            cmd = ('cd /e/claude-code/projects/foo && npm test > "C:\\Users\\alex\\out dir\\log.txt" 2>/dev/null; '
                   "curl -o E:/dl/f.bin https://x --output=~/dl2/z && cd relative && cd /usr/local && echo x > /tmp/claude/t.txt")
            self.assertEqual(sorted(set(atlas.bash_io_dirs(cmd, self.HOME))), [
                ("r", "E:/claude-code/projects/foo"),
                ("w", "C:/Users/alex/AppData/Local/Temp/claude"),
                ("w", "C:/Users/alex/dl2"),
                ("w", "C:/Users/alex/out dir"),
                ("w", "E:/dl"),
            ])

    def test_transcript_paths(self):
        cwd = "E:\\claude-code\\projects\\foo"
        mem = "c:\\users\\Alex\\.claude\\projects\\E--claude-code-projects-foo\\memory\\a.md"
        text = jl(
            user_str(cwd, "hello"),
            base({"type": "attachment", "attachment": {"type": "instructions", "files": [
                {"path": "C:\\Users\\alex\\.claude\\CLAUDE.md", "type": "User"},
                {"path": "C:/Users/alex/.claude/CLAUDE.md", "type": "User"}]}}, cwd),  # one file, both spellings
            base({"type": "attachment", "attachment": {"type": "nested_memory", "path": cwd + "\\sub\\CLAUDE.md"}}, cwd),
            {"type": "relocated", "relocatedCwd": "e:\\claude-code\\projects\\foo2\\", "sessionId": "s"},
            assistant_tool(cwd, "Read", {"file_path": mem}),
            assistant_tool(cwd, "Edit", {"file_path": "docs\\plan.md"}),  # relative: joins the cwd
            assistant_tool(cwd, "Write", {"file_path": "/c/Users/alex/notes/x.txt"}),  # Git Bash spelling
            assistant_tool(cwd, "Glob", {"pattern": "*", "path": "E:/claude-code/projects/foo/src"}),
            assistant_tool(cwd, "Bash", {"command": "cd /e/claude-code/projects/foo && echo x > out/y.txt"}),
            user_str("e:\\claude-code\\projects\\foo", "the drive letter in the other case"),
        )
        with tempfile.TemporaryDirectory() as tmpdir:
            path = os.path.join(tmpdir, "s.jsonl")
            write(path, text)
            s = atlas.parse_transcript(path, os.path.getsize(path), atlas._memory_path_filter([self.CD]), self.HOME)
            sub = atlas.parse_subagent(path, self.HOME)
        s = json.loads(json.dumps(s))
        self.assertEqual(backslashed(s), [])
        self.assertEqual(backslashed(sub), [])
        self.assertEqual(s["firstCwd"], "E:/claude-code/projects/foo")
        self.assertEqual(list(s["cwdCounts"]), ["E:/claude-code/projects/foo"])
        self.assertEqual(list(s["pathSeen"]), ["E:/claude-code/projects/foo"])
        self.assertEqual(s["loads"], [{"path": "C:/Users/alex/.claude/CLAUDE.md", "type": "User"}])
        self.assertEqual(s["nested"], ["E:/claude-code/projects/foo/sub/CLAUDE.md"])
        self.assertEqual(list(s["relocated"]), ["E:/claude-code/projects/foo2"])
        mem_dir = "C:/users/Alex/.claude/projects/E--claude-code-projects-foo/memory"
        self.assertEqual(s["memoryReads"], [mem_dir + "/a.md"])  # under the claude dir whatever the letter case
        self.assertEqual(sorted(s["io"]["r"]), sorted([mem_dir, "E:/claude-code/projects/foo/src", "E:/claude-code/projects/foo"]))
        self.assertEqual(sorted(s["io"]["w"]), ["C:/Users/alex/notes", "E:/claude-code/projects/foo/docs"])
        self.assertEqual(sorted(sub["io"]["w"]), ["C:/Users/alex/notes", "E:/claude-code/projects/foo/docs"])

    def test_links_and_names(self):
        links = atlas.parse_links("[a](sub\\a.md) [b](.\\b.md) [c](C:\\abs\\c.md) [d](\\rooted\\d.md) [e](x/../e.md)")
        self.assertEqual(links, ["sub/a.md", "b.md", "e.md"])
        text, removed = atlas.remove_index_lines("- [A](Feedback.md) — x\n- [B](b.md)\n", "feedback.md")
        self.assertEqual((text, removed), ("- [B](b.md)\n", [{"line": 1, "text": "- [A](Feedback.md) — x"}]))
        with tempfile.TemporaryDirectory() as tmpdir:
            mdir = atlas.fwd(os.path.realpath(tmpdir))
            write(mdir + "/MEMORY.md", "- [F](Feedback.md)\n")
            write(mdir + "/feedback.md", "---\nname: f\n---\n")
            files, index = atlas.scan_project_memory(mdir, atlas.Warnings())
            self.assertEqual([(f["name"], f["linked"]) for f in files], [("feedback.md", True)])
            self.assertEqual(index["orphans"], [])
            # one file answers to many spellings: only the listed one is accepted, in the listed spelling
            self.assertEqual(atlas._disk_name(mdir, "memory.MD"), "MEMORY.md")
            self.assertEqual(atlas._disk_name(mdir, "feedback.md"), "feedback.md")
            for spelling in ("feedback.md.", "feedback.md ", "FEEDBA~1.MD", "feedback.md::$DATA", "missing.md"):
                with self.assertRaises(atlas.Refused):
                    atlas._disk_name(mdir, spelling)
        for label in ("a\\b", "..\\up", "C:", "a:b", "nul", "NUL.txt", "com1", "dot.", "a*b", 'q"x', "a/b", ".hidden", ""):
            self.assertIsNone(atlas._valid_label(label), label)
        for label in ("my project", "项目 一", "v1.2", "console"):
            self.assertEqual(atlas._valid_label(label), label)
        # what trash writes into meta.json passes restore's own check of it
        op = atlas.pjoin(self.CD, "projects", "E--foo", "memory", "a.md")
        self.assertTrue(atlas.is_abs(op) and atlas.pnorm(op) == op)
        self.assertNotEqual(atlas.parser_tag(), atlas.PARSER_VERSION)  # a cache from before the path rule is not reused

    def test_open_and_reveal_commands(self):
        env = {"SystemRoot": "C:\\Windows", "PATHEXT": ".COM;.EXE;.BAT;.CMD"}
        md = "E:/claude-code/projects/foo/docs dir/笔记.md"
        md_native = "E:\\claude-code\\projects\\foo\\docs dir\\笔记.md"

        def run(path, edit, fail=()):
            """(startfile calls, spawned command lines) for one open; `fail`: the verbs with no handler."""
            calls, spawned = [], []

            def startfile(p, verb=None):
                calls.append((p, verb))
                if verb in fail:
                    raise OSError(1155, "No application is associated with the specified file for this operation")

            with mock.patch.dict(os.environ, env), mock.patch.object(os, "startfile", startfile, create=True), \
                    mock.patch.object(atlas, "_spawn", spawned.append):
                atlas._windows_open(path, edit)
            return calls, spawned

        notepad = '"C:\\Windows\\notepad.exe" '
        self.assertEqual(run(md, False), ([(md_native, None)], []))  # the default handler
        self.assertEqual(run(md, True), ([(md_native, "edit")], []))  # the type's own edit verb
        self.assertEqual(run(md, True, fail=("edit",)), ([(md_native, "edit"), (md_native, None)], []))  # else the default handler
        self.assertEqual(run(md, True, fail=("edit", None)), ([(md_native, "edit"), (md_native, None)], [notepad + '"%s"' % md_native]))
        for script in ("C:/x/hook.bat", "C:/x/hook.JS", "C:/x/hook.py", "C:/x/hook.sh", "C:/x/tool.EXE", "C:/x/Makefile"):
            calls, spawned = run(script, True, fail=("edit",))  # never "opened": that would run it
            self.assertEqual(calls, [(atlas.native(script), "edit")], script)
            self.assertEqual(spawned, [notepad + '"%s"' % atlas.native(script)], script)
        with self.assertRaises(atlas.AtlasError):
            run(md, False, fail=(None,))
        spawned = []
        with mock.patch.dict(os.environ, env), mock.patch.object(atlas, "_spawn", spawned.append):
            atlas._windows_reveal(md)
        self.assertEqual(spawned, ['"C:\\Windows\\explorer.exe" /select,"%s"' % md_native])

    def test_recycle_bin_request(self):
        import ctypes

        path = "E:\\claude-code\\projects\\foo\\docs dir\\笔记 \U0001F600.md"
        op, buf = atlas._recycle_request(path)
        if ctypes.sizeof(ctypes.c_void_p) == 8:
            self.assertEqual(ctypes.sizeof(op), 56)  # the Win64 layout of SHFILEOPSTRUCTW
        self.assertEqual((op.wFunc, op.fFlags, op.hwnd, op.pTo), (3, 0x4454, None, None))
        self.assertEqual(ctypes.wstring_at(op.pFrom), path)
        # in the buffer's own units (UTF-16 on Windows, where the emoji takes two)
        units = len(path.encode("utf-16-le")) // 2 if ctypes.sizeof(ctypes.c_wchar) == 2 else len(path)
        self.assertEqual((buf[units], buf[units + 1]), ("\x00", "\x00"))  # the list of paths ends with two NULs
        seen = []

        def shell(result, aborted):
            def SHFileOperationW(ref):
                seen.append((ctypes.wstring_at(ref._obj.pFrom), ref._obj.wFunc))
                ref._obj.fAnyOperationsAborted = aborted
                return result
            return types.SimpleNamespace(shell32=types.SimpleNamespace(SHFileOperationW=SHFileOperationW))

        with mock.patch.object(ctypes, "windll", shell(0, 0), create=True):
            atlas._windows_recycle("E:/claude-code/projects/foo/a b.md")
        self.assertEqual(seen, [("E:\\claude-code\\projects\\foo\\a b.md", 3)])  # backslashes for the shell
        with mock.patch.object(ctypes, "windll", shell(0x7C, 0), create=True):
            with self.assertRaises(atlas.AtlasError) as caught:
                atlas._windows_recycle("E:/x.md")
        self.assertIn("0x7C", str(caught.exception))
        with mock.patch.object(ctypes, "windll", shell(0, 1), create=True):  # "delete for good?" answered No
            with self.assertRaises(atlas.AtlasError):
                atlas._windows_recycle("E:/x.md")

    def test_cross_drive_move_is_copied(self):
        # the trash is on the claude dir's drive, a project on another: the rename fails, the move still happens
        with tempfile.TemporaryDirectory() as tmpdir:
            src, dst = os.path.join(tmpdir, "skill"), os.path.join(tmpdir, "trash", "payload")
            write(os.path.join(src, "SKILL.md"), "skill\n")
            write(os.path.join(src, "ref", "笔记.md"), "note\n")
            os.makedirs(os.path.dirname(dst))
            with mock.patch.object(os, "rename", side_effect=OSError(errno.EXDEV, "different disk drive")):
                atlas._rename(src, dst)
                self.assertFalse(os.path.lexists(src))
                self.assertEqual((read(os.path.join(dst, "SKILL.md")), read(os.path.join(dst, "ref", "笔记.md"))), ("skill\n", "note\n"))
                atlas._rename(dst, src)  # and back, as restore does
                self.assertFalse(os.path.lexists(dst))
                self.assertEqual(sorted(os.listdir(src)), ["SKILL.md", "ref"])
                # a copy that fails leaves the source whole and no half copy behind
                with mock.patch.object(shutil, "copytree", side_effect=OSError(errno.ENOSPC, "disk full")):
                    with self.assertRaises(OSError):
                        atlas._rename(src, dst)
                self.assertEqual(sorted(os.listdir(src)), ["SKILL.md", "ref"])
                self.assertFalse(os.path.lexists(dst))
                # a copy that comes out different is thrown away
                with mock.patch.object(atlas, "_tree_sig", side_effect=[(3, 11), (2, 5)]):
                    with self.assertRaises(OSError):
                        atlas._rename(src, dst)
                self.assertEqual(sorted(os.listdir(src)), ["SKILL.md", "ref"])
                self.assertFalse(os.path.lexists(dst))


class FileCommandTests(unittest.TestCase):
    """move / os-trash / reveal / open."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = atlas.fwd(os.path.realpath(self.tmp.name))

    def cmd(self, *args):
        code, out, err = run_atlas(self.root, *args)
        self.assertEqual(err, b"")
        doc = json.loads(out.decode("utf-8"))
        if code != 0:
            self.assertEqual(list(doc), ["error"])
            self.assertTrue(doc["error"])
        return code, doc

    def test_move(self):
        name = "笔记 一 (draft).md"
        src, dest = J(self.root, "from dir", name), J(self.root, "到这里")
        write(src, "内容\n")
        os.makedirs(dest)
        # arguments in the platform's spelling, the folder with a trailing separator
        code, doc = self.cmd("move", nat(src), nat(dest) + os.sep)
        self.assertEqual((code, doc), (0, {"ok": True, "to": J(dest, name)}))
        self.assertFalse(os.path.lexists(src))
        self.assertEqual(read(J(dest, name)), "内容\n")
        # a file of that name is already there: refused, both files untouched
        write(src, "second\n")
        code, doc = self.cmd("move", src, dest)
        self.assertEqual(code, 1)
        self.assertIn(name, doc["error"])
        self.assertEqual((read(src), read(J(dest, name))), ("second\n", "内容\n"))
        for args in ((src, J(self.root, "no such dir")), (J(self.root, "missing.md"), dest), (J(self.root, "from dir"), dest),
                     ("relative.md", dest), (src, "relative-dir"), (src, J(dest, name))):
            code, doc = self.cmd("move", *args)
            self.assertEqual(code, 1, args)
        self.assertEqual((read(src), read(J(dest, name))), ("second\n", "内容\n"))
        self.assertEqual(sorted(os.listdir(dest)), [name])
        self.assertEqual(sorted(os.listdir(J(self.root, "from dir"))), [name])

    @unittest.skipUnless(SYMLINKS, "needs symlinks (on Windows: Developer Mode or admin)")
    def test_move_takes_the_link_not_its_target(self):
        target, lnk, dest = J(self.root, "shared", "x.md"), J(self.root, "a", "x.md"), J(self.root, "b")
        write(target, "shared\n")
        os.makedirs(J(self.root, "a"))
        os.makedirs(dest)
        os.symlink(nat(target), nat(lnk))
        code, doc = self.cmd("move", lnk, dest)
        self.assertEqual((code, doc["to"]), (0, J(dest, "x.md")))
        self.assertTrue(os.path.islink(J(dest, "x.md")))
        self.assertFalse(os.path.lexists(lnk))
        self.assertEqual(read(target), "shared\n")

    def test_move_across_volumes(self):
        # another drive (Windows) or volume (macOS): a rename cannot do it, so the file is copied, checked, removed
        name = "note 一.md"
        src, dest = J(self.root, "a", name), J(self.root, "b")
        write(src, "hello\n")
        os.makedirs(dest)
        exdev = OSError(errno.EXDEV, "Cross-device link")
        with mock.patch.object(os, "rename", side_effect=exdev):
            with mock.patch.object(shutil, "copy2", side_effect=OSError(errno.ENOSPC, "disk full")):
                with self.assertRaises(atlas.AtlasError):
                    atlas.cmd_move(src, dest)
            self.assertEqual((read(src), os.listdir(dest)), ("hello\n", []))
            real_unlink = atlas._unlink

            def source_is_locked(path):
                if atlas.same_path(atlas.fwd(path), src):
                    raise PermissionError(errno.EACCES, "in use")
                real_unlink(path)

            with mock.patch.object(atlas, "_unlink", side_effect=source_is_locked):
                with self.assertRaises(atlas.AtlasError):
                    atlas.cmd_move(src, dest)
            self.assertEqual((read(src), os.listdir(dest)), ("hello\n", []))  # the copy was taken back
            self.assertEqual(atlas.cmd_move(src, dest), {"ok": True, "to": J(dest, name)})
        self.assertFalse(os.path.lexists(src))
        self.assertEqual(read(J(dest, name)), "hello\n")

    @unittest.skipUnless(MAC, "the ~/.Trash rule is macOS's")
    def test_os_trash_macos(self):
        home = self.root  # run_atlas makes this $HOME: the trash is <fixture>/.Trash, not the real one
        trash = J(home, ".Trash")
        a = J(home, "docs", "note 一.md")
        write(a, "one\n")
        self.assertFalse(os.path.exists(trash))
        code, doc = self.cmd("os-trash", a)
        self.assertEqual((code, doc), (0, {"ok": True, "to": J(trash, "note 一.md")}))
        self.assertFalse(os.path.lexists(a))
        self.assertEqual(read(doc["to"]), "one\n")
        self.assertEqual(stat.S_IMODE(os.stat(trash).st_mode), 0o700)
        # the plain name is taken: "<stem> atlas-<epoch ms><ext>"
        write(a, "two\n")
        code, doc = self.cmd("os-trash", a)
        self.assertEqual(code, 0)
        self.assertRegex(doc["to"], "^" + re.escape(J(trash, "note 一 atlas-")) + r"[0-9]{13}\.md$")
        self.assertEqual((read(doc["to"]), read(J(trash, "note 一.md"))), ("two\n", "one\n"))
        for name, pattern in ((".env", r"\.env atlas-[0-9]{13}"), ("Makefile", r"Makefile atlas-[0-9]{13}"),
                              ("a.tar.gz", r"a\.tar atlas-[0-9]{13}\.gz")):
            for expect in (re.escape(name), pattern):
                write(J(home, "docs", name), name)
                code, doc = self.cmd("os-trash", J(home, "docs", name))
                self.assertEqual(code, 0)
                self.assertRegex(doc["to"], "^" + re.escape(trash + "/") + expect + "$")
                self.assertEqual(read(doc["to"]), name)
        write(J(home, "folder", "inner.txt"), "x")
        code, doc = self.cmd("os-trash", J(home, "folder"))
        self.assertEqual((code, doc["to"]), (0, J(trash, "folder")))
        self.assertEqual(read(J(trash, "folder", "inner.txt")), "x")
        self.assertEqual(self.cmd("os-trash", J(trash, "folder"))[0], 1)  # already there
        self.assertEqual(self.cmd("os-trash", J(home, "docs", "missing.md"))[0], 1)
        self.assertEqual(self.cmd("os-trash", "relative.md")[0], 1)
        self.assertEqual(os.listdir(J(home, "docs")), [])

    def test_errors_are_json(self):
        missing = J(self.root, "nothing here.md")
        for args in (("reveal", missing), ("open", missing), ("open", missing, "--edit"), ("os-trash", missing),
                     ("reveal", "relative.md"), ("open", ""), ("move", missing), ("open", self.root, "--edit")):
            code, doc = self.cmd(*args)
            self.assertEqual(code, 1, args)

    @unittest.skipIf(WIN, "the macOS commands; the Windows ones are in WindowsRuleTests")
    def test_reveal_and_open_macos(self):
        f = J(self.root, "docs dir", "笔记.md")
        write(f, "x")
        calls = []
        with mock.patch.object(atlas, "_run_tool", calls.append):
            self.assertEqual(atlas.cmd_reveal(f), {"ok": True})
            self.assertEqual(atlas.cmd_open(J(self.root, "docs dir"), False), {"ok": True})
            self.assertEqual(atlas.cmd_open(f, False), {"ok": True})
            self.assertEqual(atlas.cmd_open(f, True), {"ok": True})
            for bad in (lambda: atlas.cmd_reveal(J(self.root, "missing")), lambda: atlas.cmd_open(J(self.root, "docs dir"), True)):
                with self.assertRaises(atlas.AtlasError):
                    bad()
        self.assertEqual(calls, [["/usr/bin/open", "-R", f], ["/usr/bin/open", J(self.root, "docs dir")],
                                 ["/usr/bin/open", f], ["/usr/bin/open", "-t", f]])
        # a helper that fails is an error with its last line of stderr; its stdout never reaches ours
        with self.assertRaises(atlas.AtlasError) as caught:
            atlas._run_tool([sys.executable, "-c", "import sys; print('noise'); sys.stderr.write('first\\nlast line\\n'); sys.exit(3)"])
        self.assertEqual(str(caught.exception), "last line")
        atlas._run_tool([sys.executable, "-c", "print('noise')"])


class Utf8Tests(unittest.TestCase):
    """Text is UTF-8 whatever the locale, and a file in another encoding neither stops a scan nor gets mangled."""

    GBK_LINE = "这一行是 GBK 编码".encode("gbk")

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = root = atlas.fwd(os.path.realpath(self.tmp.name))
        self.cd = cd = J(root, "claude")
        self.cwd = J(root, "work", "项目")
        os.makedirs(self.cwd)
        self.slug = slugify(self.cwd)
        self.mem = mem = J(cd, "projects", self.slug, "memory")
        write(J(cd, "CLAUDE.md"), "# 全局\n")
        self.index = J(mem, "MEMORY.md")
        write_bytes(self.index, b"# Index\n- [gbk](gbk.md) - " + self.GBK_LINE + b"\n- [ok](ok.md) - " + self.GBK_LINE + b"\n" + self.GBK_LINE + b"\n")
        write_bytes(J(mem, "gbk.md"), "---\nname: 中文名\ndescription: 说明\n---\n正文\n".encode("gbk"))
        write(J(mem, "ok.md"), "---\nname: ok-note\ndescription: 记忆 说明\n---\nbody\n")
        write_bytes(J(cd, "shared-memory", "latin1.md"), b"caf\xe9 au lait\n")
        self.session = J(cd, "projects", self.slug, "s1.jsonl")
        write_bytes(self.session, jl(user_str(self.cwd, "你好，世界")).encode("utf-8")
                    + b'{"type":"user","cwd":"\xd6\xd0\xce\xc4","message":{"role":"user","content":"\xd6\xd0"}}\n'
                    + b"\xff\xfe not json at all\n")
        # the locale says GBK (macOS; on a Chinese Windows it already does): stdout must still be UTF-8
        self.env = {} if WIN else {"LC_ALL": "zh_CN.GBK", "LANG": "zh_CN.GBK"}

    def run_cmd(self, *args):
        code, out, err = run_atlas(self.root, *(list(args) + ["--claude-dir", self.cd]), **self.env)
        self.assertEqual((code, err), (0, b""), out[:300])
        return out, json.loads(out.decode("utf-8"))

    def test_scan_survives_other_encodings(self):
        out, doc = self.run_cmd("index")
        self.assertEqual(doc["warnings"], [])
        self.assertIn("记忆 说明".encode("utf-8"), out)  # UTF-8 itself on stdout, not escapes, not the locale's GBK
        proj = [p for p in doc["projects"] if p["slug"] == self.slug][0]
        self.assertEqual(proj["cwd"], self.cwd)
        files = dict((f["name"], f) for f in proj["memoryFiles"])
        self.assertEqual(sorted(files), ["gbk.md", "ok.md"])
        self.assertEqual(files["ok.md"]["description"], "记忆 说明")
        self.assertIn("\ufffd", files["gbk.md"]["title"] + (files["gbk.md"]["description"] or ""))
        self.assertEqual(proj["index"]["links"], ["gbk.md", "ok.md"])
        self.assertEqual([s["title"] for s in doc["sessions"]], ["你好，世界"])
        out, found = self.run_cmd("search", "au lait")
        self.assertEqual([(r["scope"], r["text"]) for r in found["results"]], [("custom", "caf\ufffd au lait")])
        self.assertEqual(self.run_cmd("search", "记忆")[1]["results"][0]["path"], J(self.mem, "ok.md"))

    def test_lone_surrogate_does_not_stop_the_output(self):
        # half an emoji, as a title cut in the middle of a surrogate pair is written by JSON.stringify
        with open(self.session, "ab") as fh:
            fh.write(b'{"type":"custom-title","customTitle":"cut \\ud83d","sessionId":"s1"}\n')
        out, doc = self.run_cmd("index")
        self.assertEqual([s["title"] for s in doc["sessions"]], ["cut \ud83d"])
        self.assertEqual(out, out.decode("ascii").encode("ascii"))  # the whole document fell back to ASCII escapes
        self.assertIn("记忆 说明", [f["description"] for p in doc["projects"] for f in p["memoryFiles"]])

    def test_index_file_in_another_encoding_is_edited_byte_for_byte(self):
        before = read_bytes(self.index)
        out, doc = self.run_cmd("trash", J(self.mem, "ok.md"))
        self.assertEqual(doc["refused"], [])
        meta = doc["trashed"][0]
        self.assertEqual(meta["indexLines"][0]["line"], 3)
        self.assertEqual(read_bytes(self.index), before.replace(b"- [ok](ok.md) - " + self.GBK_LINE + b"\n", b""))
        out, lst = self.run_cmd("trash-list")
        self.assertEqual(lst["items"][0]["indexLines"], meta["indexLines"])
        out, doc = self.run_cmd("restore", meta["id"])
        self.assertEqual(doc["refused"], [])
        self.assertEqual(read_bytes(self.index), before)  # the GBK bytes came through untouched
        out, doc = self.run_cmd("archive-memory", J(self.mem, "gbk.md"), "--project-label", "项目")
        self.assertEqual(doc["archived"]["to"], J(self.cd, "memory-archive", "项目", "gbk.md"))
        self.assertEqual(read_bytes(self.index), before.replace(b"- [gbk](gbk.md) - " + self.GBK_LINE + b"\n", b""))


@unittest.skipUnless(WIN, "needs a real Windows file system")
class WindowsOnlyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.P = build_fixture(self.tmp.name)

    def test_spellings_of_one_file(self):
        P, cd = self.P, self.P["cd"]
        index_before = read(J(P["mem_a"], "MEMORY.md"))
        refused = [
            nat(J(P["mem_a"], "memory.md")),  # MEMORY.md in another letter case
            nat(J(P["mem_a"], "MEMORY.md.")),  # trailing dot: the same file to Win32
            nat(J(P["mem_a"], "orphan.md::$DATA")),  # its default data stream
            nat(J(cd, "claude.MD")),  # the global CLAUDE.md
            nat(J(cd, "PROJECTS")),
            nat(J(cd, "Shared-Memory")),
        ]
        code, doc, err = run_json(P["root"], "trash", *(refused + ["--claude-dir", nat(cd)]))
        self.assertEqual((code, err), (0, b""))
        self.assertEqual(doc["trashed"], [])
        self.assertEqual([r["path"] for r in doc["refused"]], refused)
        self.assertEqual(read(J(P["mem_a"], "MEMORY.md")), index_before)
        # backslashes, another letter case, a lower-case drive letter: found, and reported in the one path form
        spelled = nat(J(P["mem_a"], "ORPHAN.MD"))
        spelled = spelled[0].lower() + spelled[1:]
        code, doc, err = run_json(P["root"], "trash", spelled, "--claude-dir", nat(cd).upper())
        self.assertEqual((code, doc["refused"]), (0, []))
        meta = doc["trashed"][0]
        self.assertEqual((meta["pathClass"], meta["originalPath"]), ("memory", J(P["mem_a"], "orphan.md")))
        self.assertEqual(backslashed(meta), [])
        code, doc, err = run_json(P["root"], "restore", meta["id"], "--claude-dir", cd)
        self.assertEqual(len(doc["restored"]), 1)
        self.assertEqual(os.listdir(P["mem_a"]).count("orphan.md"), 1)

    def test_index_takes_any_spelling_of_its_arguments(self):
        P = self.P
        code, a, err = run_json(P["root"], "index", "--claude-dir", P["cd"], "--current-cwd", P["b"])
        spelled = nat(P["cd"])
        code, b, err = run_json(P["root"], "index", "--claude-dir", spelled[0].lower() + spelled[1:] + "\\", "--current-cwd", nat(P["b"]).upper())
        self.assertEqual((code, err), (0, b""))
        self.assertEqual(strip_timing(b), strip_timing(a))
        self.assertEqual([p["slug"] for p in b["projects"] if p["isCurrent"]], [P["slug_b"]])

    def test_purge_removes_read_only_files(self):
        # Windows will not delete a read-only file (git objects are); purge clears the bit first
        P = self.P
        locked = J(P["scratch"], "objects", "pack.idx")
        write(locked, "x")
        os.chmod(locked, stat.S_IREAD)
        code, doc, err = run_json(P["root"], "trash", P["scratch"], "--claude-dir", P["cd"])
        self.assertEqual((code, doc["refused"], err), (0, [], b""))
        code, doc, err = run_json(P["root"], "purge", "--now", doc["trashed"][0]["id"], "--claude-dir", P["cd"])
        self.assertEqual((code, len(doc["purged"]), doc["refused"], err), (0, 1, [], b""))
        self.assertEqual(os.listdir(J(P["cd"], "atlas-trash")), [])

    @unittest.skipUnless(OPT_RECYCLE, "set ATLAS_TEST_RECYCLE=1 to send one temp file to the real Recycle Bin")
    def test_recycle_bin(self):
        f = J(self.P["root"], "atlas recycle test 回收站.txt")
        write(f, "safe to delete: written by atlas's test suite\n")
        code, doc, err = run_json(self.P["root"], "os-trash", nat(f))
        self.assertEqual((code, doc, err), (0, {"ok": True, "to": ""}, b""))
        self.assertFalse(os.path.lexists(f))

    @unittest.skipUnless(OPT_OTHER_DRIVE, "set ATLAS_TEST_OTHER_DRIVE to a folder on another drive to move a file there and back")
    def test_move_to_another_drive(self):
        other = tempfile.mkdtemp(dir=OPT_OTHER_DRIVE)
        self.addCleanup(shutil.rmtree, other, True)
        self.assertNotEqual(os.path.splitdrive(os.path.realpath(other))[0].lower(), os.path.splitdrive(self.P["root"])[0].lower())
        name = "跨盘 note.md"
        src = J(self.P["root"], name)
        write(src, "across\n")
        code, doc, err = run_json(self.P["root"], "move", src, other)
        self.assertEqual((code, doc), (0, {"ok": True, "to": J(other, name)}))
        self.assertFalse(os.path.lexists(src))
        code, doc, err = run_json(self.P["root"], "move", J(other, name), self.P["root"])
        self.assertEqual((code, read(src)), (0, "across\n"))


if __name__ == "__main__":
    unittest.main()
