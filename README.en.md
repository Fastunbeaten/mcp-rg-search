# mcp-rg-search

A read-only MCP server for searching file **contents**, built as a thin, opinionated wrapper around [ripgrep](https://github.com/BurntSushi/ripgrep).

It exposes **one tool** — `search_content` — and focuses on what an AI agent actually needs: **explicit scan budgets**, **honest degradation** when a directory can't be read, and **a response contract that never silently drops results**.

> **Requirements**: Node.js ≥ 20, and a usable `rg` (ripgrep) — on `PATH`, or pointed to by `RG_PATH` (which **takes precedence over** `PATH`).
> **Zero third-party dependencies** — the MCP protocol is implemented directly over stdio JSON-RPC.
> **Platform scope**: verified on **Windows + DSH**; other platforms are untested.

---

## Why not just use ripgrep?

Running `rg` yourself is fine for a human. For an agent it has four sharp edges, and this server exists to close them:

| Problem with raw `rg` | What this server does |
|---|---|
| An unreadable directory makes `rg` exit non-zero — the whole search returns **zero results**, discarding everything it did find | **Degrades**: returns `ok:true` with the partial results, plus `skipped.unreadable` and `skippedSamples` naming each unreadable path |
| Scan limits are invisible — the process just stops, and you can't tell "no matches" from "ran out of budget" | **Explicit**: `truncated:true` + `truncatedBy` + an actionable `hint` |
| Sensitive files (`~/.ssh`, `.env`, `*.pem`, …) show up in output and get copied into the model's context | **Redacted**: neither the path nor the content of a sensitive file is ever returned — only a `skipped.sensitive` counter |
| Finding the *most recent* N hits means paging through the whole result set | **`tail`**: ask for the last N matches per file, in one call |

It also adds what raw `rg` doesn't do: non-UTF-8 encoding support (`gb18030`, `big5`, `utf-16`), two-phase search (`files` → `matches`), and a stable field vocabulary that doesn't change between releases.

---

## Install

**From npm** (available once the package reaches the registry):

```bash
npm install -g mcp-rg-search
```

**From the GitHub repository** (works today):

```bash
npm install -g github:Fastunbeaten/mcp-rg-search
```

> The second form uses npm's **git spec** (it installs straight from the GitHub repository) and **requires git on your machine**. The name `mcp-rg-search` is reserved on npm.

Or run it from a checkout:

```bash
node /path/to/mcp-rg-search/index.mjs
```

The server speaks MCP over **stdio** (protocol version `2024-11-05`); point your client at the `index.mjs` entry point. After a global install you can use `mcp-rg-search` as the entry point directly.

### Client configuration

**DSH** (`cordis.patch.yml`):

```yaml
- id: mcp-rg-search
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: rg-search
    transport: stdio
    command: node
    args:
      - '/absolute/path/to/mcp-rg-search/index.mjs'
```

**Generic MCP client**:

```json
{
  "mcpServers": {
    "rg-search": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-rg-search/index.mjs"]
    }
  }
}
```

After a global install (`npm install -g`) the entry point can be the executable name instead of the path to `index.mjs`:

```yaml
- id: mcp-rg-search
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: rg-search
    transport: stdio
    command: mcp-rg-search
```

---

## Tool: `search_content`

### Parameters

| Parameter | Type | Default | Constraints | Description |
|---|---|---|---|---|
| `query` | string | — | required, non-empty | The search string. |
| `mode` | `literal` \| `regex` | `literal` | — | `literal` matches the query as plain text (`\|` `.` `*` are ordinary characters). `regex` uses the Rust regex dialect (`\|` = "or", `.` = any character, `^`/`$` = anchors). Not PCRE2. |
| `path` | string | server's cwd | — | Search root — any readable directory, or a single file. |
| `include` | string[] | — | — | Only search files matching these globs. A pattern without `/` matches the basename at any depth; a pattern with `/` is matched against the path relative to the search root. Not passed = all extensions. |
| `exclude` | string[] | `**/node_modules/**`, `**/.git/**`, `**/.venv/**`, `**/venv/**`, `**/__pycache__/**` | — | Exclude globs. **The defaults are glob patterns** — passing `exclude: ["node_modules"]` excludes nothing. Pass `[]` to disable all exclusions. **When `path` points at a single file, an explicit `exclude` does not apply to it** (that file is searched directly). |
| `encoding` | `auto` \| `utf-8` \| `gb18030` \| `big5` \| `utf-16le` \| `utf-16be` | `auto` | — | `auto` matches bytes (rg's default). **Searching non-UTF-8 Chinese requires an explicit `gb18030`.** |
| `context_lines` | integer | `0` | 0–1000 | Lines of context around each hit. Ignored when `only_matching` is true. |
| `output` | `matches` \| `files` \| `count` | `files` | — | `files` = paths + per-file hit counts (use this first); `matches` = line numbers and content; `count` = totals only. |
| `max_results` | integer | `500` | 0–1e6 | Maximum number of hit lines (in `matches` mode). |
| `max_files` | integer | `5000` | 1–1e7 | Maximum number of files scanned. |
| `max_matches_per_file` | integer | `50` | 1–1e5 | Maximum hit lines kept per file. |
| `max_context` | integer | `200` | 0–1e5 | Maximum context lines kept per file. |
| `max_columns` | integer | `500` | 1–1e6 | Long lines are truncated to this width instead of flooding the response. |
| `only_matching` | boolean | `false` | — | Return only the matched fragment, not the whole line. |
| `multiline` | boolean | `false` | — | Allow the pattern to span lines. |
| `offset` | integer | `0` | 0–1e6 | Skip the first N results (pagination). |
| `tail` | integer | — | 1–1e6 | Keep only the **last N hits per file** (by line number). Results are still returned in ascending line order. Takes precedence over `max_matches_per_file`. Only valid with `output='matches'`. |
| `respect_gitignore` | boolean | `false` | — | Honour `.gitignore` (off by default — better to under-report than silently miss). |
| `follow_symlinks` | boolean | `false` | — | Follow symbolic links. |
| `case_sensitive` | boolean | `true` | — | Case sensitivity. |

**Out-of-range values are rejected with `invalid_args`** — nothing is silently clamped. (`maximum` is declared in the schema for `tail`; the other upper bounds are enforced by the server the same way.)

### Response shape

```jsonc
{
  "ok": true,
  "mode": "files",
  "query": "fetchUser",
  "root": "src",
  "encoding": "auto",
  "files": [ { "path": "src/index.js", "matches": 5 } ],
  "totals": { "files": 12, "matches": 87 },
  "truncated": false,
  "truncatedBy": null,
  "limits": { "maxResults": 500, "maxFiles": 5000, "maxMatchesPerFile": 50, "maxColumns": 500, "maxContext": 200 },
  "excludesApplied": ["**/node_modules/**", "**/.git/**", "**/.venv/**", "**/venv/**", "**/__pycache__/**"],
  "onlyMatchingApplied": false,
  "skipped": { "binary": 0, "sensitive": 0, "unreadable": 0 },
  "skippedSamples": [],
  "hint": null,
  "elapsedMs": 42
}
```

**Key fields**

| Field | Meaning |
|---|---|
| `ok` | `false` only for a real failure (bad arguments, missing search root, `rg` not found). **Degradation still returns `ok:true`.** |
| `mode` | Echo of the **output mode** actually used (`files` / `matches` / `count`) — **not** the match mode; the `literal` / `regex` input is not echoed back. |
| `query` / `root` / `encoding` | Echo of what actually ran (`root` is an absolute path with forward slashes). |
| `totals.files` / `totals.matches` | Files scanned / total hits found. |
| `files[]` | `output='files'`: one entry per file — `path`, `matches`. `output='matches'`: also `lines[]` with `{ line, text }` (plus `line`-keyed `context: true` entries when `context_lines > 0`), and `lineTruncated: true` on files whose stored lines were capped. |
| `skipped` | Object of counters by reason: `binary`, `sensitive`, `unreadable`. |
| `skippedSamples[]` | At most **10 samples in total** (one shared quota across all reasons — whichever reason fills it first takes every slot), each with `reason`. **Sensitive entries carry only `{ "reason": "sensitive" }` — never a path.** |
| `truncated` | The result is incomplete. |
| `truncatedBy` | **Why** it is incomplete: `max_results`, `max_columns`, `max_context`, `max_matches_per_file` or `scan_limit`. |
| `hint` | What to do next (narrow the path, raise a limit, switch encoding…), or `null`. |
| `limits` | The budgets actually applied in this call. |
| `excludesApplied` | The exclusion patterns that were actually in effect. |
| `tailApplied` | Present only when `tail` was passed: `min(tail, the largest number of retained hit lines across all files)` — for a single file, its hit count. |

**When several limits are hit at once**, `truncatedBy` reports the highest-priority one:

```
max_matches_per_file (60) > max_context (55) > max_columns (50) > scan_limit (40) > max_results (30)
```

### Error codes

| Code | Meaning | What to do |
|---|---|---|
| `invalid_args` | A parameter is missing or out of range | Fix the argument; the message names the constraint |
| `not_found` | The search root does not exist | Check `path` |
| `dependency_unavailable` | No usable `rg` was found: the explicit `RG_PATH` is unusable, or there is no `rg` on `PATH` | Install ripgrep, or point `RG_PATH` at an executable |
| `io_error` | The search could not be started | Inspect the path and permissions |

On failure the response body looks like:

```jsonc
{
  "ok": false,
  "error": "not_found",
  "reason": "搜索根不存在：D:/some/path"
}
```

`reason` is a human-readable explanation you can show as-is. `dependency_unavailable` additionally carries `expected` (the candidate `rg` paths that were found) and `installHint` (an installation hint).

---

## Sensitive files

By default, files matching these patterns are **never** returned — neither path nor content:

```
**/.env*        **/*.pem        **/*.key
**/.ssh/**      **/.aws/**      **/*.credentials.yaml
```

They are only counted in `skipped.sensitive`.

To use your own rule set, point `RG_PROTECTED_RULES` at a JSON file:

```json
[
  { "id": "D1", "scope": "file", "pattern": "**/.env*" },
  { "id": "D2", "scope": "directory", "pattern": "**/.ssh/**" }
]
```

`scope` is `file` or `directory`. If the file is missing or contains no usable rules, the built-in defaults are used — **a misconfiguration never widens what is exposed**.

The external file accepts three shapes: `["*.pem", …]`, `{ "patterns": [...] }` and `{ "rules": [{ "id", "scope", "pattern", "deny" }] }`; only rules whose `deny` is absent or contains `"read"` are applied.

---

## Environment variables

| Variable | Purpose |
|---|---|
| `RG_PATH` | Absolute path to the `rg` executable. **Takes precedence over `PATH`** — when it is set, that binary is used even if another `rg` is on `PATH`; **if it is set but the file does not exist or is not executable, the call fails with `dependency_unavailable` and does not fall back to `PATH`**. |
| `RG_PROTECTED_RULES` | Path to a JSON file overriding the built-in sensitive-file rules. |

---

## License

MIT — see [LICENSE](LICENSE).