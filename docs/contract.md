# atlas: indexer ↔ pane contract

`atlas` is a Claude Code mod (a plugin with a hooks module) that opens a pane in the
desktop Code tab showing a person's memory folders, sessions and skills. It has two halves:

- `bin/atlas.py`: a stdlib-only Python script (3.9 or newer; run with `<python> -I`) that scans
  `~/.claude` and prints one JSON document on stdout. It runs on macOS and on Windows; what differs
  between the two is listed under "Paths and platforms". `index`, `search` and `trash-list` are
  **read-only** on everything except the cache file. Only `trash`, `restore`, `purge` (without
  `--dry-run`), `set-expiry` and `archive-memory` modify anything, as described under
  "Trash and archive" below. `move`, `os-trash`, `reveal` and `open` ("File-manager commands") act on
  exactly the one path they are given; `index` never calls them.
- `hooks/register.tsx`: the hooks module. It runs the script with `$.process.run`, keeps the
  result, and draws the pane.

This file is the only thing the two halves share. Change it first if the shape must change.

## Invocation

```
<python> -I <root>/bin/atlas.py index  [--claude-dir DIR] [--cache FILE] [--current-cwd PATH]
<python> -I <root>/bin/atlas.py search QUERY [--claude-dir DIR] [--limit N]
<python> -I <root>/bin/atlas.py trash PATH... [--days N] [--kind KIND] [--label TEXT] [--protect-session ID] [--claude-dir DIR] [--cache FILE]
<python> -I <root>/bin/atlas.py restore ID... [--claude-dir DIR]
<python> -I <root>/bin/atlas.py purge [--dry-run] [--now ID... | --all] [--claude-dir DIR]
<python> -I <root>/bin/atlas.py trash-list [--claude-dir DIR]
<python> -I <root>/bin/atlas.py set-expiry ID --days N [--claude-dir DIR]
<python> -I <root>/bin/atlas.py archive-memory PATH --project-label LABEL [--claude-dir DIR]
<python> -I <root>/bin/atlas.py move SRC DEST_DIR
<python> -I <root>/bin/atlas.py os-trash PATH
<python> -I <root>/bin/atlas.py reveal PATH
<python> -I <root>/bin/atlas.py open PATH [--edit]
```

- `<python>` is `/usr/bin/python3` on macOS (3.9) and `python` on Windows (3.12). `-I` on both: the
  script must not depend on the environment's `PYTHON*` variables or on the user's site packages.
- `--claude-dir` defaults to `~/.claude`. Tests point it at a fixture folder. The home folder is
  `$HOME` on macOS and `%USERPROFILE%` on Windows (tests set it to a fixture folder too).
- `--cache` defaults to `<claude-dir>/cache/atlas/sessions-v1.json`. Per transcript file it keeps
  `{size, mtimeMs, summary}` so an unchanged file is never parsed again.
- `--current-cwd` is the working directory of the session that opened the pane; the indexer
  marks that project `isCurrent`.
- Exit code 0 with JSON on stdout. On a fatal error, exit 1 and print
  `{"error": "<message>"}` on stdout. Warnings (a file it could not read) go into `warnings`,
  never stderr noise.
- stdout is one JSON document and a newline, **UTF-8 on every platform and in every locale** (see
  "Text encoding"). It must stay under 3 MiB: cap lists as stated below.
- All times are epoch milliseconds (`...Ms`). All paths are absolute and in the one form described
  under "Paths and platforms": forward slashes only.

## Paths and platforms

### The one path form

**Every path the script prints uses forward slashes, on every platform**, and so does every path it
stores (cache, trash `meta.json`). The pane compares and splits paths on `/` only; a backslash in a
printed path is a bug.

- macOS: paths are what they always were (`/Users/alex/.claude/projects/...`). A backslash is an
  ordinary file-name character there and is left alone.
- Windows: `C:/Users/alex/.claude/projects/...`, `E:/claude-code/projects/foo`, `//server/share/x`.
  The drive letter is upper-cased (`e:\x` → `E:/x`) and a `\\?\` long-path prefix is dropped. This
  goes for relative paths too (`MemoryFile.name` of a customMemory file, `MemoryIndex.links`).
- **Accepted**: on Windows every path the script takes may use either slash or a mix: command-line
  arguments, `cwd` / `relocatedCwd` / attachment paths / tool `file_path`s inside transcripts,
  `installed_plugins.json`, environment variables. They are converted on the way in. The one thing
  echoed back verbatim is the `path` of a `refused` entry (it is the caller's own argument).
- Absolute means: starts with `/` on macOS; on Windows a drive path (`C:/x`) or a UNC path. `/x`
  and `C:x` are not absolute on Windows.
- Windows compares paths **without regard to letter case** (`under`, the claude dir, project
  roots, slugs, `MEMORY.md` / `CLAUDE.md` names, link targets in MEMORY.md). What is printed keeps the
  spelling it was found in, so a folder recorded as `E:/Foo` in one transcript and `E:/foo` in
  another appears as two `pathHistory` entries; only the drive letter is unified. macOS compares
  exactly, as before.
- Symlinks: unchanged. A Windows directory junction is treated like a symlinked folder wherever the
  script refuses to follow links (`du`, the home scan, scratch workspace listing, purge); it is not
  reported as `isSymlink` / `symlinkTo`.

### Text encoding

- Every file is read as bytes and decoded as UTF-8 by the script itself; the locale's encoding (GBK
  on a Chinese Windows) is never used. Bytes that are not UTF-8 become U+FFFD in what `index` and
  `search` print; they never stop a scan and are not a warning.
- stdout is written as UTF-8 bytes to the byte stream (`sys.stdout.buffer`), not through the
  locale's text layer, and never with CRLF. JSON is normally written with the characters themselves
  (`ensure_ascii=False`). One exception: if any string in the document holds a lone surrogate (a
  title cut in the middle of an emoji, a Windows file name with half a pair), which has no UTF-8
  form, the whole document is written with `\uXXXX` escapes instead. It is still valid UTF-8 and
  `JSON.parse` gives the same value. The cache and `meta.json` follow the same rule.
  (Only when stdout is a Windows console window, i.e. someone runs the script by hand, is the document
  written as text instead, so that the console shows it correctly. The pane always reads a pipe.)
- Files the script edits in place (MEMORY.md, when a memory file is trashed, restored or archived)
  are read and written back byte-for-byte outside the removed or re-inserted lines: text that is not
  UTF-8 is carried through unchanged (`surrogateescape`), never replaced.

### What differs on Windows

| | macOS | Windows |
|---|---|---|
| home folder | `$HOME` | `%USERPROFILE%` |
| scratch workspace roots | `<home>/Library/Application Support/Claude/scratch-workspaces` | `%APPDATA%/Claude/scratch-workspaces` (and `<home>/AppData/Roaming/...` if that is another folder), plus every existing `<LocalAppData>/Packages/<package>/LocalCache/Roaming/Claude/scratch-workspaces`: the desktop app runs in an MSIX container, and the same workspace is `.../AppData/Roaming/Claude/...` to a session inside it and `.../Packages/<package>/LocalCache/Roaming/Claude/...` to a process outside |
| temp roots (`kind: "tmp"`, io class `scratch`) | `/tmp`, `/private/tmp` | those two (for slugs like `-private-tmp-x`), plus `%TEMP%` (else `%TMP%`), `<home>/AppData/Local/Temp`, `<SystemRoot>/Temp` |
| session scratchpad | `/tmp/claude-<uid>/<slug>/...` (also under `/private`) | `<temp root>/claude/<slug>/...` or `<temp root>/claude-<n>/<slug>/...` |
| sizes (`diskBytes`, `sizeBytes`, `bytes`) | allocated: `st_blocks × 512` | Windows reports no blocks: the logical size (`st_size`) of every regular file; a folder or link itself counts 0 |
| home scan skips | dot names, `Library`, `.Trash`, `.git`, `node_modules`, `.cache`, symlinked folders | dot names, `AppData`, `.git`, `node_modules`, `.cache`, anything with the hidden or system attribute, symlinks and junctions |
| slug-match candidates | home scan + scratch workspaces | the same, plus the sub-folders of every folder a project was started from (projects live outside the home folder there, e.g. `E:/claude-code/projects/<name>`) |
| trash across volumes | refused (`EXDEV`), never copied | carried out as copy → check → delete (see "Trash and archive") |
| the OS's own trash | `~/.Trash` | the Recycle Bin |
| cache `parser` stamp | the integer `PARSER_VERSION` | the string `"<PARSER_VERSION>-nt1"`, so a cache from a version that kept backslashes is rebuilt |

A scratch workspace found under one root is matched to its project folder (`projectSlug`, slug-match,
`--protect-session`) through the slug of the same sub-path under **each** root, and a folder reachable
under two roots is listed once.

## `index` output

```jsonc
{
  "version": 2,                        // 2 adds: projects[].pathHistory/resolvedCwd/resolution/relatedSlugs/io/diskBytes,
                                       // sessions[].io/diskBytes, docs, crossProject, scratchWorkspaces, trash
  "generatedAtMs": 0,
  "elapsedMs": 0,
  "claudeDir": "/Users/alex/.claude",
  "home": "/Users/alex",
  "warnings": ["..."],                 // at most 50

  "globalClaudeMd": { "path": "...", "exists": true, "lines": 0, "bytes": 0 },

  "projects": [                         // every folder under <claude-dir>/projects
    {
      "slug": "-Users-alex-my-project",
      "cwd": "/Users/alex/my project",   // a `cwd` seen in its transcripts whose slug form (non-alphanumerics → "-")
                                           // equals the folder slug, most frequent first; else the most common session cwd
                                           // (sessions often cd into subfolders, and a renamed folder keeps its old cwd);
                                           // null if no transcripts
      "label": "my project",              // basename of resolvedCwd, else of cwd, else slug
      "kind": "project",                   // "project" | "scratch" (under .../Claude/scratch-workspaces/) | "tmp" (under a temp root:
                                           // /private/tmp or /tmp; on Windows also %TEMP% etc., see "What differs on Windows"),
                                           // judged from resolvedCwd, else cwd, else the slug (-Claude-scratch-workspaces- / the slug of a temp root)
      "pathHistory": [ PathSeen ],         // see "Rename tracing"; at most 50
      "resolvedCwd": "/Users/alex/my project",   // where the project lives now; null when resolution is "missing"
      "resolution": "exists",              // "exists" | "relocated" | "slug-match" | "related" | "missing"
      "relatedSlugs": [],                  // other project folders that are the same project before/after a rename
      "io": Io,                            // aggregated over its sessions, top 50 reads and top 50 writes (see "Reads and writes")
      "diskBytes": 0,                      // allocated bytes of its whole folder under projects/ (transcripts, session dirs, memory)
      "isCurrent": false,
      "sessionCount": 0,                   // top-level *.jsonl files in the folder
      "lastActiveMs": 0,                   // newest transcript mtime, else 0
      "memoryDir": ".../memory",           // null when the folder has no memory/ dir
      "memoryFiles": [ MemoryFile ],       // every *.md in memory/ except MEMORY.md, newest first
      "index": MemoryIndex | null,         // null when memoryDir is null
      "loads": [ { "path": "...", "type": "User" } ]
        // what the newest session of this project that recorded any `instructions` attachment loaded
        // at start: the union of `files[]` of those attachments ({path, type}); type is
        // "User" | "Project" | "AutoMem" | ...; empty when no session recorded one
        // (sessions before 2026-09 never do)
    }
  ],
  // projects sorted: isCurrent first, then memory file count > 0 by lastActiveMs desc, then the rest by lastActiveMs desc

  "customMemory": [                    // the person's own folders outside the official layout
    {
      "name": "shared-memory",            // also "memory-archive"; only those that exist
      "path": "/Users/alex/.claude/shared-memory",
      "files": [ MemoryFile ],            // recursive, *.md, README.md included; `name` is the path relative to `path`;
                                          // sorted by name
      "index": null
    }
  ],

  "sessions": [ Session ],             // top-level sessions, newest lastMs first, at most 400

  "skills": [ Skill ],                 // sorted by useCount desc, then name

  "health": [ Issue ],                 // sorted error > warn > info, then projectSlug (null last), then kind, then path

  "docs": Docs,                        // document tree and cross-links, see "Document tree"
  "crossProject": [ CrossEdge ],       // see "Document tree"; sorted by count desc, then from, to, kind

  "scratchWorkspaces": [               // <scratch root>/*/*/scratch-* (depth 3); macOS root:
                                       // <home>/Library/Application Support/Claude/scratch-workspaces; Windows roots: see above
    { "path": "...", "sizeBytes": 0, "mtimeMs": 0,
      "projectSlug": "-Users-...-scratch-2026-10-22-e8e9fe",   // project folder whose slug equals the path's slug, else null
      "sessionIds": ["..."] }          // that project's session ids, newest first
  ],                                   // sorted by mtimeMs desc

  "trash": { "path": "<claude-dir>/atlas-trash", "items": 0, "bytes": 0 }   // summary; the folder is never created by index
}
```

Sizes (`diskBytes`, `sizeBytes`, `bytes`) are allocated bytes (`st_blocks × 512`, symlinks not followed).
On Windows, which has no `st_blocks`, they are the sum of the files' logical sizes.

### MemoryFile

```jsonc
{
  "name": "feedback-terse.md",        // file name (relative path for customMemory)
  "path": "/abs/path.md",
  "size": 0,
  "mtimeMs": 0,
  "hasFrontmatter": true,              // starts with a --- YAML block
  "title": "feedback-terse",           // frontmatter `name`, else file stem
  "description": "...",                // frontmatter `description`, else first non-empty body line (leading #'s stripped),
                                       // whitespace collapsed, ≤ 200 chars
  "type": "feedback",                  // frontmatter `metadata.type` or top-level `type`, else null
  "linked": true,                      // MEMORY.md links to it (always true for customMemory)
  "symlinkTo": null                    // real path when the file is a symlink (shared-memory files are linked into
                                       // several projects' memory/ this way), else null
}
```

Frontmatter is parsed by hand (no PyYAML): `key: value` lines, and one nested level under
`metadata:` (indented `type: x`). Values may be quoted (double quotes with backslash escapes, or
single quotes), may continue on indented lines, or be `>` / `|` block scalars (plugin SKILL.md files use these).

### MemoryIndex (MEMORY.md)

```jsonc
{
  "exists": true,
  "path": ".../memory/MEMORY.md",
  "lines": 0,
  "bytes": 0,
  "overLineLimit": false,              // lines > 200 (only the first 200 load)
  "overByteLimit": false,              // bytes > 25000
  "links": ["feedback-terse.md"],      // markdown link targets ](x.md) that are relative .md files, in order
  "deadLinks": ["gone.md"],            // links whose file does not exist in memoryDir
  "orphans": ["unlinked.md"]           // memoryFiles not linked from MEMORY.md
}
```

When memory/ exists but has no MEMORY.md, `index` is still an object with `exists: false`, zero
counts, empty `links`/`deadLinks`, and every memory file in `orphans`.

### Session

```jsonc
{
  "id": "face6b47-...",                // file stem
  "projectSlug": "-Users-alex-my-project",
  "path": "/abs/<id>.jsonl",
  "cwd": "/Users/alex/my project",   // cwd of the first record that has one (the first line is usually a
                                        // queue-operation / custom-title / mode record with no cwd); null if none
  "title": "整理记忆文件",              // last `custom-title`.customTitle, else last `ai-title`.aiTitle,
                                        // else first real user prompt: a non-isMeta user record whose content is a string,
                                        // or a list of blocks with no tool_result whose first text block is used
                                        // (most desktop prompts are lists), not starting with "<";
                                        // whitespace collapsed, ≤ 80 chars; else id
  "startedMs": 0,                      // first record that has a timestamp (ISO in file → ms); null if none
  "lastMs": 0,                         // file mtime
  "entrypoint": "claude-desktop",      // `entrypoint` of the same record that gave `cwd`, may be null
  "version": "2.1.287",                // `version` of the last record that has one (the last line usually has none), may be null
  "loads": [ { "path": "...", "type": "User" } ],  // union of `instructions` attachments' files (path, type), first-seen order
  "skillsAvailable": ["autodoc", "anthropic-skills:docx"],
        // names from the last `skill_listing` attachment with isInitial true, plus `names` of later
        // non-initial ones (union, order kept). Field on the attachment: `names` (array of strings)
  "skillsInvoked": [ { "name": "autodoc", "count": 2, "via": "tool", "inSubagent": false } ],
        // via "tool": assistant tool_use blocks with name "Skill" (input.skill);
        // via "command": user records whose content (string, or first text block) starts with "<command-"
        //   and holds <command-name>/x</command-name> where x (without the slash) is in skillsAvailable,
        //   or matches a known skill name (prompts that merely quote the tag do not count).
        // Also scan <session-dir>/subagents/**/agent-*.jsonl for Skill tool_use → inSubagent true.
        // One entry per (name, via, inSubagent).
  "memoryReads":  ["/abs/.../memory/x.md"],
  "memoryWrites": ["/abs/.../memory/y.md"],
        // tool_use Read (file_path) → reads; Write/Edit/MultiEdit (file_path) → writes;
        // only paths under any <claude-dir>/projects/*/memory/, <claude-dir>/shared-memory/,
        // <claude-dir>/memory-archive/, or named CLAUDE.md / CLAUDE.local.md. Unique, first-seen order, at most 50 each.
  "subagentCount": 0,                  // agent-*.jsonl files under <session-dir>/subagents/ (recursive; the
                                       // workflows/<wf>/journal.jsonl files there are not agents and are skipped)
  "io": Io,                            // top 30 reads and top 30 writes; includes its subagents' tool calls
  "diskBytes": 0                       // allocated bytes of <id>.jsonl plus the <id>/ session dir
}
```

Parsing rules for speed (the folder is 1.3 GB, ~400 sessions, ~700 jsonl files):
- Read line by line; `json.loads` a line only when it contains one of the substrings
  `skill_listing`, `"instructions"`, `nested_memory` (the attachment types used), `"Skill"`, `command-name`,
  `custom-title`, `ai-title`, `"relocated"`, `"file_path"`, `"notebook_path"`, `"Bash"`, `"Glob"`, `"Grep"`,
  or while it is among the leading lines before the first
  record with both a cwd and a timestamp has been seen, or when no first prompt has been found yet and it
  is a `"type":"user"` line. `version` comes from the last record with one, read from the file's last 1 MiB.
  Malformed lines are skipped.
- Cache per transcript file (top-level and subagent files) on `(size, mtimeMs)`. The cache holds only
  per-file summaries (titles, names, paths, counts; never transcript text or skill-listing descriptions),
  compact JSON, entries for vanished files dropped, written atomically (temp file + rename, temp removed on failure).
- A full cold run must finish within 60 s on this machine; a warm run (nothing changed) within 3 s.

### Skill

```jsonc
{
  "name": "anthropic-skills:docx",     // the name as it appears in skill_listing names / Skill tool input
  "source": "synced",                  // "user" | "synced" | "plugin" | "project" | "builtin"
  "path": "/abs/SKILL.md",             // null for builtin
  "description": "...",                // SKILL.md frontmatter description, ≤ 300 chars; for builtin: null
  "plugin": null,                      // plugin name for source "plugin"
  "projectCwd": null,                  // for source "project"
  "useCount": 0,                       // total invocations across all sessions (tool + command, subagents included)
  "sessionsUsing": 0,                  // sessions that invoked it
  "lastUsedMs": null,                  // lastMs of the newest session that invoked it
  "listedIn": 0                        // sessions whose skillsAvailable contains it
}
```

Where skills come from (a name is taken by the first source that has it, in this order: user, project, plugin, synced):
- `user`: `<claude-dir>/skills/<name>/SKILL.md` (skip the `synced` folder and names starting with `.`, e.g. `.trash`); name = `<name>`.
- `synced`: `<claude-dir>/skills/synced/<bucket>/<name>/SKILL.md` (skip names starting with `.`);
  name = `anthropic-skills:<name>`.
- `plugin`: `<claude-dir>/plugins/installed_plugins.json` → `plugins[key][i].installPath`, each
  `skills/<name>/SKILL.md`; plugin name = key before `@`; name = `<plugin>:<name>`.
  Also `projectPath` on the entry → put it in `projectCwd`.
- `project`: for every project cwd that exists on disk, `<cwd>/.claude/skills/<name>/SKILL.md`; name = `<name>`.
  Skipped when `<cwd>/.claude` is the claude dir itself (the `/Users/alex` project).
- `builtin`: any name seen in sessions' skillsAvailable or skillsInvoked with no file found above.

### Issue

```jsonc
{
  "severity": "warn",                  // "error" | "warn" | "info"
  "kind": "dead-link",
  "projectSlug": "-Users-alex-my-project",   // null for custom/global
  "path": "/abs/path",                 // the file or folder the issue is about
  "message": "MEMORY.md 链接了不存在的 gone.md"   // Chinese, one line
}
```

Kinds (message in Chinese):
- `dead-link` (warn): MEMORY.md links a file that does not exist.
- `orphan` (warn): a memory file MEMORY.md does not link (it never loads at start).
- `index-over-limit` (error): MEMORY.md over 200 lines or 25,000 bytes; say which and by how much.
- `no-index` (warn): memory dir has .md files but no MEMORY.md.
- `no-frontmatter` (info): project memory file without frontmatter (customMemory files are not checked).
- `empty-memory-dir` (info): ONE issue summarising all memory dirs with 0 .md files (MEMORY.md included),
  with the count and how many are scratch/tmp; `path` = `<claude-dir>/projects`, `projectSlug` null.
- `same-title` (info): the same memory `title` in 2+ projects (candidate for shared-memory); path = one of them,
  message names the projects. Skipped when all those files resolve to one real file (already shared by symlink).
- With no MEMORY.md, a dir gets `no-index` only (no per-file `orphan` issues).
- `cwd-missing` (info): a project with memory files whose `resolution` is `missing`.
- `renamed` (info): a project whose recorded cwd is gone but was found elsewhere (`resolution` relocated,
  slug-match or related): "项目从 X 改名/移到了 Y"; `path` = resolvedCwd.

## Rename tracing

`PathSeen`:

```jsonc
{ "path": "/Users/alex/construction - Old Name",
  "firstSeenMs": 0, "lastSeenMs": 0,   // record timestamps; for `relocated` (which has no timestamp) the nearest earlier
                                       // record's timestamp; null for slug-match entries
  "exists": false,                     // is a directory now
  "source": "cwd",                     // "cwd" (a record's cwd) | "relocated" (a {"type":"relocated","relocatedCwd"} record)
                                       // | "slug-match" (a directory found on disk, below)
  "launch": true }                     // it was some session's first cwd, or a relocatedCwd, or a slug-match:
                                       // a place the project lived, not just a folder a session cd'ed into
```

One entry per path (source priority cwd > relocated > slug-match); launch entries first, then by lastSeenMs desc.
Every record's cwd counts, including the lines the prefilter does not decode: cwd and timestamp are taken from
the fixed top-level key run `"userType":…,"entrypoint":…,"cwd":"…"` and the `"timestamp"` before it.

`resolution` / `resolvedCwd`, first that applies:
1. `exists`: cwd is a directory.
2. `relocated`: the newest relocatedCwd that is a directory.
3. `slug-match`: a directory whose slug equals the folder slug, or equals the slug of any launch path. Candidates:
   a scan of `$HOME` to depth 3 (skipping `Library`, `.Trash`, `.git`, `node_modules`, `.cache` and all hidden
   dirs; symlinked dirs not followed) plus the scratch workspaces. The scan is kept in the cache file under
   key `<home>|<local date>`, so it runs at most once a day. A folder-slug match beats a launch-path match.
   On Windows the home scan skips `AppData` instead of `Library`/`.Trash`, and there is a second source of
   candidates, read fresh on every run: the direct sub-folders of the parent of every project cwd and launch path
   that is not a temp or scratch folder (at most 200 parents). With projects in `E:/claude-code/projects/<name>`
   that is every folder in `E:/claude-code/projects`.
4. `related`: a project folder holding a transcript with the same session id (the rename signal: Claude Code
   moves transcripts to the new slug) that resolved by 1–3; take its resolvedCwd. Weaker relations
   (shared launch path) do not propagate a location, because a session that started in a subfolder would
   otherwise inherit the parent's folder.
5. `missing`: resolvedCwd null.

Slug = Claude Code's: every char outside `[A-Za-z0-9]` → `-` (spaces, `.`, `&`, non-ASCII; a character outside
the BMP gives `--`, as JS counts UTF-16 units). Slugs longer than 200 chars are compared on their first 200.
A Windows cwd gives the same slug in either spelling, because `:`, `\` and `/` all become `-`:
`E:\claude-code\projects\foo` and `E:/claude-code/projects/foo` → `E--claude-code-projects-foo`, `C:\Users\alex` →
`C--Users-alex`. On Windows slugs are compared without regard to case (`e--foo` and `E--foo` are one folder
on NTFS, and the drive letter of a recorded cwd is not always in the same case).

`relatedSlugs` (sorted): another folder B is related to A when they hold a transcript with the same session id,
or share a launch path, or a launch path of one has the other's folder name as its slug, or both resolve to the
same resolvedCwd.

## Reads and writes

`Io`:

```jsonc
{ "writes": [ { "dir": "/abs/dir", "count": 3, "lastMs": 0, "class": "project", "via": "tool" } ],
  "reads":  [ { "dir": "/abs/dir", "count": 9, "lastMs": 0, "class": "claude",  "via": "tool" } ] }
```

- From assistant `tool_use` blocks (main transcript and its subagents): Read → read of `file_path`;
  Write/Edit/MultiEdit → write of `file_path`; NotebookEdit → write of `notebook_path`; Glob/Grep → read of
  `path` (a directory, counted as itself). A file counts toward its parent dir. Relative paths join the session cwd.
- Best-effort Bash (`input.command`), absolute or `~` paths only: the dir of `cd <dir>` counts as a read
  (where the work happened), and the parent dir of the targets of `>`, `>>`, `2>`, `&>`, `-o FILE`,
  `--output FILE` / `--output=FILE` counts as a write; `/dev/*` targets skipped. Such a dir has `via: "bash"` (else `"tool"`).
  On Windows the command runs in Git Bash, so besides `C:/x` and a quoted `"C:\x"` the spellings `/c/x`
  (→ `C:/x`) and `/tmp/x` (→ `%TEMP%/x`) are understood; other `/...` paths (`/usr`, `/dev/null`) are dropped.
  The same two Git Bash spellings are accepted in tool `file_path`s.
- `lastMs`: newest record timestamp that touched the dir.
- `class`, first that applies: `claude` (under the claude dir), `project` (under the project's resolvedCwd, cwd
  or a launch path), `scratch` (under a temp root or one of the app's scratch-workspaces roots, see
  "What differs on Windows"), `external`.
- Sorted by count desc, then lastMs desc, then dir. The cache keeps at most 100 dirs per transcript and kind.

## Document tree

`Docs`:

```jsonc
{ "nodes": [ { "id": "/abs/path.md",          // id = absolute path (not resolved)
               "path": "/abs/path.md",
               "kind": "memory",              // claude-md | memory-index | memory | custom-memory | skill | doc
               "scope": "project",            // "global" | "project" | "shared-memory" | "memory-archive" | "external"
               "projectSlug": "-Users-...",   // for scope project, else null
               "exists": true, "isSymlink": false,
               "realPath": "/abs/path.md",    // os.path.realpath; equals path unless a symlink is involved
               "title": "..." } ],            // frontmatter name, else first "# " heading, else file name
  "edges": [ { "from": "<node id>", "to": "<node id>", "type": "index" } ],
  "truncated": false }                        // true when the 4000-node cap was hit
```

Nodes:
- `claude-md`: `<claude-dir>/CLAUDE.md` (scope global); per project with a resolvedCwd, `<cwd>/CLAUDE.md`,
  `<cwd>/.claude/CLAUDE.md`, `<cwd>/CLAUDE.local.md` when they exist; every path from sessions' `nested_memory`
  attachments (`{"type":"nested_memory","path","displayPath","content"}`), existing or not.
- `memory-index` (MEMORY.md) and `memory` (other .md) in project memory dirs; `custom-memory` for
  shared-memory / memory-archive files; `skill` for user and project SKILL.md files.
- `doc`: any other file reached by an edge (AGENTS.md, docs/企划.md, a dead link target, ...).
- scope/projectSlug of a node: by location: inside `<claude-dir>/projects/<slug>/` → that project; shared-memory,
  memory-archive; elsewhere in the claude dir → global; under a project's resolvedCwd or launch path (longest
  prefix wins, ties go to the project that still exists; a project living at `$HOME` or `/` (on Windows: at the
  root of a drive or share) does not claim everything below it) → that project; else external.
  The project CLAUDE.md files listed above always belong to their project.

Edges (unique per from, to, type). A file's text is read once; fenced code blocks and inline code are ignored:
- `import`: `@path` tokens (at line start or after whitespace) in claude-md and doc nodes, `~` expanded,
  relative to the file's directory; kept when the target is a file or ends in `.md` (so `@scope/pkg` and
  `@mentions` are dropped).
- `link`: `](relative.md)` markdown links (same rule as MemoryIndex.links) in every node except MEMORY.md.
- `index`: MEMORY.md → each linked file.
- `wikilink`: `[[name]]` (also `[[name|alias]]`, `[[name#h]]`) → the memory / custom-memory node whose
  frontmatter `name` or file stem equals name; prefer the same project, then shared-memory, then any (by path).
  Unresolved wikilinks make no edge.
- `nested`: a nested_memory CLAUDE.md → the nearest `CLAUDE.md` or `.claude/CLAUDE.md` in an ancestor directory.
- `symlink`: a symlinked node → its realPath node.
- Expansion: the fixed nodes above are read. A `doc` node reached from them, and a symlink's realPath node, is
  read too (its edges are added); nodes reached from there are added but not read.

`CrossEdge`:

```jsonc
{ "from": "-Users-alex-my-project", "to": "shared-memory", "kind": "symlink", "count": 5,
  "nested": false }                    // true when one project's resolvedCwd is inside the other's (a parent repo and a
                                       // sub-project); on real data these are most of the biggest session edges
```

- from/to are project slugs or `global` / `shared-memory` / `memory-archive`.
- From doc edges whose two nodes have different scope keys (slug for scope project, else the scope; `external`
  skipped): kind = the edge type, count = number of edges.
- From sessions: a session of project A whose Io (uncapped, from the cache) touches a dir owned by B: kind
  `session-read` / `session-write`, count = number of tool calls. Owner of a dir: the node scope rule above,
  plus `<claude-dir>` itself and its CLAUDE.md → global, and `/private/tmp/claude-<uid>/<slug>/…` (session
  scratchpads; on Windows `<temp root>/claude/<slug>/…` or `<temp root>/claude-<n>/<slug>/…`) → that project.
  A ≠ B, and pairs of related projects are skipped.

## Trash and archive

These commands are the only ones that modify files. Every target is validated before anything moves; a target
that fails validation is refused with a reason and nothing else is touched.

Trash root `<claude-dir>/atlas-trash/`. Item `<root>/<id>/` with `payload` (the moved file or folder;
a second part is `payload.1`) and `meta.json`:

```jsonc
{ "id": "1792640000000-1a2b3c4d",      // <deletedAtMs>-<8 hex>; commands only accept ids of this form
  "originalPath": "/abs/path",         // the first part
  "kind": "session",                   // --kind if given, else pathClass
  "pathClass": "session",              // project | session | memory | shared-memory | memory-archive | user-skill
                                       // | project-skill | project-claude-md | scratch-workspace
  "label": "...",                      // --label, else the file name
  "deletedAtMs": 0, "expiresAtMs": 0,  // expires = deleted + --days (default 30) days; null under `--days never`
  "sizeBytes": 0,
  "parts": [ { "originalPath": "/abs/<id>.jsonl", "payload": "payload" },
             { "originalPath": "/abs/<id>",       "payload": "payload.1" } ],
  "indexPath": "/abs/memory/MEMORY.md" | null,
  "indexLines": [ { "line": 7, "text": "- [x](x.md) — ..." } ] }   // lines removed from MEMORY.md (memory files)
```

- Moves use `os.rename` only. On macOS a cross-volume move (EXDEV) is refused, never copied. A symlink is moved
  as the link itself. On any failure the parts already moved are moved back.
- Windows moves differently in one case. The trash root is on the claude dir's drive while projects (their
  CLAUDE.md files and `.claude/skills`) usually live on another, so refusing a cross-drive move would make those
  targets untrashable. When `os.rename` fails because source and target are on different drives, the part is
  copied to the target (links copied as links), the copy is checked (same number of entries and bytes; same
  size for a file), and only then is the source deleted. A failed or mismatching copy is removed and the source
  left untouched; if the source cannot be deleted afterwards (a file in use), the copy is removed again and the
  move is refused; a folder that was already partly deleted is first filled back in from the copy. A junction is
  not moved across drives (refused). `restore` and the roll-back use the same move. Read-only files are deleted
  by `purge` after clearing the read-only bit.
- Windows names: one file answers to many spellings there (another letter case, a trailing dot or space, an 8.3
  short name, a `:stream` suffix). The last component of a target must be a name its folder actually lists
  (letter case aside); it is then taken in the listed spelling, and anything else is refused as missing. So
  `memory.md` is `MEMORY.md` and is refused like it. `originalPath` in `meta.json` is always the listed spelling.
- MEMORY.md is edited byte-for-byte (see "Text encoding"); an `indexLines[].text` taken from a line that is not
  UTF-8 holds lone surrogates and is printed with `\uXXXX` escapes.
- Allowed targets (located by the realpath of their parent dir plus their own name): inside `<claude-dir>/projects/`
  a whole project folder, a session `<id>.jsonl` (its `<id>/` session dir goes with it), or a memory `*.md`
  other than MEMORY.md; anything strictly inside `<claude-dir>/shared-memory/` or `<claude-dir>/memory-archive/`;
  a user skill folder `<claude-dir>/skills/<name>` (not `synced`, not hidden); for a project cwd (cwd or
  resolvedCwd of any project, as `index` computes them) `<cwd>/.claude/skills/<name>`, `<cwd>/CLAUDE.md`,
  `<cwd>/.claude/CLAUDE.md`, `<cwd>/CLAUDE.local.md`; a scratch workspace folder (depth 3 `scratch-*`).
- Always refused: the global `<claude-dir>/CLAUDE.md`, anything under `plugins/` or `skills/synced`, anything in the
  trash root, the root folders themselves, a missing path, and (with `--protect-session ID`) that session's jsonl,
  the project folder holding it, and the scratch workspace whose slug folder holds it (a slug over 200 chars is
  matched on its first 200, as everywhere; on Windows the slug of each spelling of the workspace is tried).
- Trashing a memory file removes the MEMORY.md lines that link it (recorded in `indexLines`); restore puts them back.

Outputs:
- `trash` → `{ "trashed": [meta], "refused": [ { "path", "reason" } ] }`
- `restore ID...` → `{ "restored": [meta], "refused": [ { "id", "reason" } ] }`: moves every part back if nothing is
  at its originalPath now (never overwrites), recreating missing parent dirs, re-inserts indexLines that are not
  already present at their old line numbers, then removes the item folder.
- `purge [--dry-run]` → `{ "purged": [meta], "keptCount": 0, "freedBytes": 0, "dryRun": false, "refused": [...] }`:
  removes items whose expiresAtMs has passed, leaving those whose expiresAtMs is null (kept until emptied by hand);
  `--now ID...` removes exactly those items now (the pane's 立即清空); `--all` removes every item whatever its
  expiry (the pane's 清空回收站); `--dry-run` reports the same without removing anything.
- `trash-list` → `{ "path", "items": [meta + "exists"], "bytes" }`, newest first; read-only.
- `set-expiry ID --days N` → `{ "updated": meta }` with expiresAtMs = now + N days, or null for `--days never`.
  `trash` takes `--days never` the same way.
- `archive-memory PATH --project-label LABEL` → `{ "archived": { "from", "to", "indexLines" } | null, "refused": [...] }`:
  moves a project memory file (not a symlink) to `<claude-dir>/memory-archive/<LABEL>/<name>` (LABEL: no `/`, not
  hidden; never overwrites), removes its MEMORY.md lines. Not trash: no expiry, never purged.
  On Windows LABEL must also be a legal folder name: none of `\ : * ? " < > |` or control characters, no trailing
  dot, not a reserved device name (`CON`, `NUL`, `COM1`, ...). A backslash or a colon would otherwise leave
  `memory-archive`.
- A bad id or argument is a refusal, not a crash; exit code 0 unless the command could not run at all.

## File-manager commands

What the pane used to shell out to `/bin/mv` and `/usr/bin/open` for. Each takes absolute paths (either slash on
Windows, `~` expanded), acts on exactly that path with no allowed-roots check, prints one JSON object and exits 0,
or prints `{"error": "<message>"}` and exits 1 having changed nothing. A missing path is always an error. None of
them reads the claude dir or is called by `index`.

- `move SRC DEST_DIR` → `{ "ok": true, "to": "<DEST_DIR>/<name of SRC>" }`. Moves the file `SRC` (a symlink is moved
  as the link) into the existing folder `DEST_DIR` under the same name. Errors: `SRC` is a folder, `DEST_DIR` is not
  an existing folder, or `DEST_DIR` already holds something of that name (nothing is overwritten; the same check as
  `mv -n`). Works across volumes and drives on both platforms: a rename where possible, else copy → size check →
  delete the source, and if the source cannot be deleted the copy is removed and the move fails.
- `os-trash PATH` → `{ "ok": true, "to": "<where it went>" }`. Puts a file or folder in the operating system's own
  trash (not atlas's `atlas-trash`).
  - macOS: moved into `~/.Trash` (created if missing) under its own name, or when that name is taken there, under
    `<stem> atlas-<epoch ms><ext>` (`<stem>` is the name up to its last dot, a leading dot not counting: `a.tar.gz` →
    `a.tar atlas-<ms>.gz`, `.env` → `.env atlas-<ms>`). `to` is the new path. Something already inside `~/.Trash` is an error.
  - Windows: the Recycle Bin, through `SHFileOperationW` (`FO_DELETE` with `FOF_ALLOWUNDO`) via `ctypes`. `to` is
    `""`: the Recycle Bin does not say where it put things. No dialog is shown, with one exception kept on purpose:
    if Windows cannot recycle the item and would delete it for good (a drive without a Recycle Bin, an item too big
    for it), it asks, and answering No is reported as an error. The shell API stops at 260 characters; a longer
    path is handed over in its 8.3 short form when the volume has one, else the call fails with an error.
  - Any other system: an error.
- `reveal PATH` → `{ "ok": true }`. Shows the file or folder selected in the file manager: `open -R PATH` on macOS,
  `explorer.exe /select,"PATH"` on Windows (not waited for; its exit code carries no information).
- `open PATH [--edit]` → `{ "ok": true }`.
  - Without `--edit`: the system's default handler, for a folder or a file: `open PATH` on macOS, `os.startfile`
    on Windows. For a file this does whatever a double-click does, including running it; the pane uses it for folders.
  - With `--edit` (files only; a folder is an error): a text editor. macOS: `open -t PATH`. Windows, first that
    works: the file type's own "edit" verb; the default handler, unless opening the file would run it (extension
    in `%PATHEXT%` or one of the usual script and installer types such as `.bat .cmd .js .vbs .ps1 .py .sh .exe
    .msi .lnk .reg`) or it has no extension at all; Notepad. So `--edit` never executes a hook script.
- On macOS a helper's failure is reported with the last line of its stderr; the helper's stdout is discarded so it
  cannot mix into the JSON.

## `search` output

```jsonc
{
  "query": "...",
  "results": [                         // at most --limit (default 200)
    { "path": "/abs/file.md", "projectSlug": "-Users-...", "scope": "project", // "project" | "custom" | "global"
      "line": 12, "text": "the matching line, ≤ 200 chars" }
  ]
}
```

Case-insensitive substring over every memory file (projects' memory/, customMemory folders,
`<claude-dir>/CLAUDE.md`). Plain substring, not regex.
