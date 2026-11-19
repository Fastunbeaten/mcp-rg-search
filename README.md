# mcp-rg-search

一个**只读**的 MCP 服务，用于按**文件内容**检索。它是 [ripgrep](https://github.com/BurntSushi/ripgrep) 的一层薄封装，但把 ripgrep 原有的几个坑逐一封住。

对外只暴露**一个工具** `search_content`，重点解决 agent 真正关心的三件事：**扫描预算显式化**、**遇不可读目录时诚实降级**、**返回契约稳定且不静默丢结果**。

> **运行要求**：Node.js ≥ 20，且能找到 `rg`（ripgrep）—— 在 `PATH` 上，或用 `RG_PATH` 显式指定（`RG_PATH` **优先于** `PATH`）。
> **零第三方依赖** —— MCP 协议直接基于 stdio JSON-RPC 实现。
> **平台范围**：面向 **Windows** 验证；其它平台未验证。

---

## 为什么不能直接用 ripgrep？

人自己跑 `rg` 没问题。对 agent 来说它有几个锋利的边角，本服务就是为了把这些边角包起来：

| 直接用 `rg` 的问题 | 本服务的做法 |
|---|---|
| 遇到一个不可读目录，`rg` 以非零退出 —— 整次检索返回**零结果**，已经找到的也一起丢掉 | **降级**：返回 `ok:true` 和已有的部分结果，并用 `skipped.unreadable` 与 `skippedSamples` 逐个点名不可读路径 |
| 扫描上限不可见 —— 进程就那么停了，你分不清「确实没命中」还是「预算耗尽」 | **显式**：`truncated:true` + `truncatedBy` + 可执行的 `hint` |
| 敏感文件（`~/.ssh`、`.env`、`*.pem` 等）会出现在输出里，被原样塞进模型上下文 | **脱敏**：敏感文件的路径与内容**永不**返回 —— 只留一个 `skipped.sensitive` 计数 |
| 想取**最新**的 N 条命中，得把整个结果集翻一遍 | **`tail`**：一次调用取每个文件的最后 N 条命中 |

它还补上了 `rg` 本身没有的东西：非 UTF-8 编码支持（`gb18030`、`big5`、`utf-16`）、两段式检索（`files` → `matches`），以及一套跨版本稳定的字段词表。

---

## 安装

```bash
npm install -g mcp-rg-search
```

也可以直接从 GitHub 仓库安装（走 npm 的 **git spec**，**需要本机装有 git**）：

```bash
npm install -g github:Fastunbeaten/mcp-rg-search
```

或者直接从一份检出运行：

```bash
node /path/to/mcp-rg-search/index.mjs
```

服务通过 **stdio** 讲 MCP（协议版本 `2024-11-05`）；把客户端的入口指向 `index.mjs` 即可。全局安装后入口也可以直接写 `mcp-rg-search`。

### 客户端配置

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

全局安装（`npm install -g`）之后，入口可以直接写可执行名，不必再指到 `index.mjs`：

```json
{
  "mcpServers": {
    "rg-search": {
      "command": "mcp-rg-search"
    }
  }
}
```

---

## 工具：`search_content`

### 参数

| 参数 | 类型 | 默认值 | 约束 | 说明 |
|---|---|---|---|---|
| `query` | string | — | 必填，非空 | 搜索串。 |
| `mode` | `literal` \| `regex` | `literal` | — | `literal` 把 query 当普通文本（`\|` `.` `*` 都是普通字符）。`regex` 使用 Rust regex 方言（`\|` = 「或」，`.` = 任意字符，`^`/`$` = 锚点）。不是 PCRE2。 |
| `path` | string | 服务进程工作目录 | — | 搜索根 —— 任何可读目录，或单个文件。 |
| `include` | string[] | — | — | 只搜匹配这些 glob 的文件。不含 `/` 的模式匹配任意层级的文件名；含 `/` 的模式按相对搜索根的路径匹配。不传 = 不限扩展名。 |
| `exclude` | string[] | `**/node_modules/**`、`**/.git/**`、`**/.venv/**`、`**/venv/**`、`**/__pycache__/**` | — | 排除 glob。**默认值是 glob 模式** —— 传 `exclude: ["node_modules"]` 排除不掉任何东西。传 `[]` 取消所有排除。**`path` 指向单个文件时，显式 `exclude` 对该文件不生效**（该文件直接被检索）。 |
| `encoding` | `auto` \| `utf-8` \| `gb18030` \| `big5` \| `utf-16le` \| `utf-16be` | `auto` | — | `auto` 按字节匹配（rg 的默认）。**搜非 UTF-8 中文必须显式给 `gb18030`。** |
| `context_lines` | integer | `0` | 0–1000 | 每条命中前后各取几行上下文。`only_matching` 为 true 时忽略。 |
| `output` | `matches` \| `files` \| `count` | `files` | — | `files` = 路径 + 每文件命中数（先用这个）；`matches` = 行号与行内容；`count` = 只回总计。 |
| `max_results` | integer | `500` | 0–1e6 | 最多返回多少条命中行（`matches` 模式下）。 |
| `max_files` | integer | `5000` | 1–1e7 | 最多扫描多少文件。 |
| `max_matches_per_file` | integer | `50` | 1–1e5 | 每文件最多保留多少条命中行。 |
| `max_context` | integer | `200` | 0–1e5 | 每文件最多保留多少条上下文行。 |
| `max_columns` | integer | `500` | 1–1e6 | 超长行截断到这个宽度，避免一行撑爆返回体。 |
| `only_matching` | boolean | `false` | — | 只返回匹配片段，不返回整行。 |
| `multiline` | boolean | `false` | — | 允许模式跨行。 |
| `offset` | integer | `0` | 0–1e6 | 跳过前 N 条结果（分页）。 |
| `tail` | integer | — | 1–1e6 | 每个文件只保留**行号最大的最后 N 条**命中。结果仍按行号升序返回。优先于 `max_matches_per_file`。只在 `output='matches'` 时有效。 |
| `respect_gitignore` | boolean | `false` | — | 遵守 `.gitignore`（默认不遵守 —— 宁可多报，不静默漏）。 |
| `follow_symlinks` | boolean | `false` | — | 跟随符号链接。 |
| `case_sensitive` | boolean | `true` | — | 是否大小写敏感。 |

**超范围的值一律以 `invalid_args` 拒绝** —— 不会被静默夹到边界。（schema 只对 `tail` 声明了 `maximum`，其余上界由服务端以同样方式拒绝。）

### 返回结构

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

**关键字段**

| 字段 | 含义 |
|---|---|
| `ok` | 只有真正失败时才为 `false`（参数不合法、搜索根不存在、找不到 `rg`）。**降级仍然返回 `ok:true`。** |
| `mode` | 回显本次的 **output 取值**（`files` / `matches` / `count`）—— **不是**匹配模式；`literal` / `regex` 这个入参在返回里不回显。 |
| `query` / `root` / `encoding` | 回显本次实际执行的东西（`root` 是正斜杠化的绝对路径）。 |
| `totals.files` / `totals.matches` | 扫描的文件数 / 命中总数。 |
| `files[]` | `output='files'`：每文件一条 —— `path`、`matches`。`output='matches'`：另外带 `lines[]`（`{ line, text }`；`context_lines > 0` 时混入带 `context: true` 的上下文行），存储行数被截断的文件还带 `lineTruncated: true`。 |
| `skipped` | 按原因分类的计数对象：`binary`、`sensitive`、`unreadable`。 |
| `skippedSamples[]` | 整个数组**最多 10 条**样本（各原因**共享同一配额**，先占满的类别其余不再补），带 `reason`。**敏感类条目只带 `{ "reason": "sensitive" }` —— 绝不带路径。** |
| `truncated` | 结果不完整。 |
| `truncatedBy` | **为什么**不完整：`max_results`、`max_columns`、`max_context`、`max_matches_per_file` 或 `scan_limit`。 |
| `hint` | 下一步该怎么做（收窄路径、加大上限、换编码……），没有则为 `null`。 |
| `limits` | 本次实际生效的预算。 |
| `excludesApplied` | 实际生效的排除模式。 |
| `tailApplied` | 只在传了 `tail` 时出现：`min(tail, 各文件保留命中行数的最大值)` —— 单文件时即该文件的命中数。 |

**多个上限同时触发时**，`truncatedBy` 报优先级最高的那个：

```
max_matches_per_file (60) > max_context (55) > max_columns (50) > scan_limit (40) > max_results (30)
```

### 错误码

| 错误码 | 含义 | 怎么办 |
|---|---|---|
| `invalid_args` | 参数缺失或超范围 | 改参数；报错信息里写明了约束 |
| `not_found` | 搜索根不存在 | 检查 `path` |
| `dependency_unavailable` | 找不到可用的 `rg`：显式指定的 `RG_PATH` 不可用，或 `PATH` 上没有 `rg` | 安装 ripgrep，或把 `RG_PATH` 指到可执行文件 |
| `io_error` | 检索无法启动 | 检查路径与权限 |

失败时返回体形如：

```jsonc
{
  "ok": false,
  "error": "not_found",
  "reason": "搜索根不存在：D:/some/path"
}
```

`reason` 是中文说明，可直接展示给用户。`dependency_unavailable` 额外带 `expected`（找到的候选 `rg` 路径数组）与 `installHint`（安装提示）。

---

## 敏感文件

默认情况下，匹配这些模式的文件**永不**返回 —— 路径与内容都不返回：

```
**/.env*        **/*.pem        **/*.key
**/.ssh/**      **/.aws/**      **/*.credentials.yaml
```

它们只计入 `skipped.sensitive`。

要换成自己的规则集，把 `RG_PROTECTED_RULES` 指向一个 JSON 文件：

```json
[
  { "id": "D1", "scope": "file", "pattern": "**/.env*" },
  { "id": "D2", "scope": "directory", "pattern": "**/.ssh/**" }
]
```

`scope` 取 `file` 或 `directory`。文件不存在或没有一条可用规则时，回落内置默认 —— **配错了也绝不会放宽暴露范围**。

外部文件支持三种写法：`["*.pem", …]`、`{ "patterns": [...] }`、`{ "rules": [{ "id", "scope", "pattern", "deny" }] }`；只采用 `deny` 缺省或含 `"read"` 的规则。

---

## 环境变量

| 变量 | 用途 |
|---|---|
| `RG_PATH` | `rg` 可执行文件的绝对路径。**优先级高于 `PATH`** —— 显式指定了就用它，即使 `PATH` 上还有别的 `rg`；**指定了但文件不存在或不可执行时，直接报 `dependency_unavailable`，不会回落到 `PATH`**。 |
| `RG_PROTECTED_RULES` | 覆盖内置敏感文件规则的 JSON 文件路径。 |

---

## 自测

npm 包**不包含** `test/` 目录（保持包体积最小）。想跑自测请从仓库获取：

```bash
git clone https://github.com/Fastunbeaten/mcp-rg-search
cd mcp-rg-search
node test/search.test.mjs
```

需要本地已安装 `rg`（ripgrep）。测试会自行创建临时样本文件，跑完自动清理。

---

## 项目性质

个人项目，按需维护，不承诺响应时限与长期支持。适合直接使用或 fork 自建，不建议作为关键依赖。

---

## 许可

MIT —— 见 [LICENSE](LICENSE)。