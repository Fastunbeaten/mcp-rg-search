#!/usr/bin/env node
// mcp-rg-search — 只读的「按内容检索」MCP 服务器（stdio / JSON-RPC 2.0）
// 零第三方依赖：只用 Node 内置模块 + spawn 调用 rg 二进制。
// 只读：只做「枚举 + 检索」，不写任何文件。
// 工具：search_content（唯一一个）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 外部敏感规则文件（可选）：环境变量 RG_PROTECTED_RULES 指向 JSON 时覆盖内置默认。 */
const PROTECTED_RULES_FILE = process.env.RG_PROTECTED_RULES
  ? path.resolve(process.env.RG_PROTECTED_RULES)
  : null;

/** 内置默认敏感规则（不依赖任何外部工具目录）。 */
export const DEFAULT_SENSITIVE_RULES = [
  { id: 'D1', scope: 'file', pattern: '**/.env*' },
  { id: 'D2', scope: 'file', pattern: '**/*.pem' },
  { id: 'D3', scope: 'file', pattern: '**/*.key' },
  { id: 'D4', scope: 'directory', pattern: '**/.ssh/**' },
  { id: 'D5', scope: 'directory', pattern: '**/.aws/**' },
  { id: 'D6', scope: 'file', pattern: '**/*.credentials.yaml' },
];

/** 默认排除清单（实测大幅减少遍历与输出条目；额外再加「目录自身」形式经实测无可复现收益，故保持 5 条）。显式传 exclude: [] = 完全不排除。 */
export const DEFAULT_EXCLUDES = [
  '**/node_modules/**',
  '**/.git/**',
  '**/.venv/**',
  '**/venv/**',
  '**/__pycache__/**',
];

const ENCODINGS = new Set(['auto', 'utf-8', 'gb18030', 'big5', 'utf-16le', 'utf-16be']);
const OUTPUT_MODES = new Set(['matches', 'files', 'count']);
const MODES = new Set(['literal', 'regex']);

/** 扫描墙钟预算（毫秒）：超限 → 返回部分结果 + truncatedBy:'scan_limit'。 */
const SCAN_TIME_BUDGET_MS = 30000;
/** 单次搜索最多保留的行数（内存护栏）。 */
const MAX_STORED_LINES = 100000;
/** 分块扫描时每条命令的路径长度上限（Windows 命令行护栏）。 */
const CHUNK_PATH_BUDGET = 7000;

/* ----------------------------- 小工具 ----------------------------- */

function toPosix(p) { return String(p).replace(/\\/g, '/'); }

function isExecutableFile(p) {
  try { return fs.existsSync(p) && fs.statSync(p).isFile(); } catch { return false; }
}

function errorResult(code, reason, extra) {
  return Object.assign({ ok: false, error: code, reason }, extra || {});
}

/* --------------------- 敏感规则（内置默认 + 可选外部覆盖） --------------------- */

let sensitiveCache = { key: '', rules: DEFAULT_SENSITIVE_RULES };

/**
 * 外部规则文件 → 统一格式 [{id, scope, pattern}]；解析不出任何规则时返回 null。
 * 支持三种写法：["*.pem", ...] / { patterns: [...] } / { rules: [{ id, scope, pattern, deny }] }
 * 第三种与 { rules: [{ deny, scope, pattern }] } 结构兼容：只取 deny 含 'read' 的规则（缺省 deny 视为敏感）。
 */
function parseExternalRules(file) {
  let j;
  try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  const fromStrings = (arr) => arr
    .filter(x => typeof x === 'string' && x.trim() !== '')
    .map((p, i) => ({ id: `X${i + 1}`, scope: 'file', pattern: p }));
  if (Array.isArray(j)) return fromStrings(j);
  if (j && Array.isArray(j.patterns)) return fromStrings(j.patterns);
  if (j && Array.isArray(j.rules)) {
    return j.rules
      .filter(r => r && typeof r.pattern === 'string' && (!Array.isArray(r.deny) || r.deny.includes('read')))
      .map((r, i) => ({ id: r.id || `X${i + 1}`, scope: r.scope === 'directory' ? 'directory' : 'file', pattern: String(r.pattern) }));
  }
  return null;
}

/**
 * 生效的敏感规则：
 *  - 未设 RG_PROTECTED_RULES          → 内置默认（不再依赖任何外部目录）
 *  - 设了且可解析出规则               → 完全覆盖内置默认
 *  - 设了但文件不可读 / 解析不出规则   → 回落到内置默认（配置错误绝不放宽敏感规则）
 */
export function loadSensitiveRules() {
  if (!PROTECTED_RULES_FILE) return DEFAULT_SENSITIVE_RULES.slice();
  let st = null;
  try { st = fs.statSync(PROTECTED_RULES_FILE); } catch { return DEFAULT_SENSITIVE_RULES.slice(); }
  const key = `${PROTECTED_RULES_FILE}|${st.mtimeMs}`;
  if (key === sensitiveCache.key) return sensitiveCache.rules;
  const parsed = parseExternalRules(PROTECTED_RULES_FILE);
  const rules = parsed && parsed.length ? parsed : DEFAULT_SENSITIVE_RULES.slice();
  sensitiveCache = { key, rules };
  return rules;
}

/** glob → 正则源码（支持 ** / * / ?）。 */
function globToRegExpSource(pat) {
  let out = '';
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    if (c === '*') {
      if (pat[i + 1] === '*') {
        i++;
        if (pat[i + 1] === '/') { i++; out += '(?:.*/)?'; }
        else out += '.*';
      } else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return out;
}

/**
 * glob → 正则源码（include 白名单的 JS 侧唯一语义，与 rg 的 --glob 对齐）：
 *   - 单星号 → 不跨斜杠的一段（任意层级 basename 内的任意字符）
 *   - 双星号 + 斜杠 → 可空前缀（零层或多层目录，因此双星号模式也能匹配根层文件）
 *   - 双星号（后面不跟斜杠）→ 任意字符（含斜杠）
 *   - 问号 → 单个非斜杠字符
 */
export function globToLooseSource(pat) {
  let out = '';
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    if (c === '*') {
      if (pat[i + 1] === '*') {
        i++;
        if (pat[i + 1] === '/') { i++; out += '(?:.*/)?'; }
        else out += '.*';
      } else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return out;
}

/**
 * include 白名单的 JS 侧匹配（唯一语义；任何扫描分支都走这里）：
 *  - 不含 '/' 的模式 = 按 basename 匹配（任意层级，如 "index.mjs" 命中任何层级的 index.mjs）
 *  - 含 '/' 的模式   = 按「相对搜索根的路径」匹配（单星号不跨斜杠，如 src/xxx.mjs 不匹配 src/a/b.mjs）
 */
export function matchGlobPattern(pat, absPath, rootAbs) {
  const p = String(pat).replace(/\\/g, '/');
  const base = path.basename(absPath).replace(/\\/g, '/');
  const rel = toPosix(path.relative(rootAbs, absPath)) || base;
  let re;
  try { re = new RegExp('^' + globToLooseSource(p) + '$'); } catch { return false; }
  if (p.includes('/')) return re.test(rel);
  return re.test(base);
}

/** 单条规则是否命中某个路径（同时看绝对 posix 路径与相对根的 posix 路径）。 */
export function ruleMatches(rule, absPosix, relPosix) {
  const pat = String(rule.pattern).replace(/\\/g, '/');
  if (rule.scope === 'directory') {
    const p = pat.replace(/\/+$/, '');
    if (p.includes('*')) {
      const seg = p.replace(/^\*\*\//, '').replace(/\/\*\*$/, '');
      if (seg && !seg.includes('*')) {
        const segs = absPosix.split('/');
        const rsegs = relPosix.split('/');
        if (segs.includes(seg) || rsegs.includes(seg)) return true;
      }
      const re = new RegExp('^' + globToRegExpSource(p));
      return re.test(absPosix) || re.test(relPosix);
    }
    return absPosix === p || absPosix.startsWith(p + '/') || relPosix === p || relPosix.startsWith(p + '/');
  }
  const re = new RegExp('^' + globToRegExpSource(pat) + '$');
  return re.test(relPosix) || re.test(absPosix);
}

/** 路径是否命中任意敏感规则。 */
export function isSensitivePath(absPath, rootAbs, rules) {
  const absPosix = toPosix(absPath);
  const relPosix = toPosix(path.relative(rootAbs, absPath)) || path.basename(absPosix);
  for (const r of rules) if (ruleMatches(r, absPosix, relPosix)) return r;
  return null;
}

/** 敏感规则 → rg 的排除 glob（让 rg 根本不读这些文件）。 */
export function sensitiveGlobs(rules) {
  const out = [];
  for (const r of rules) {
    const p = String(r.pattern).replace(/\\/g, '/');
    if (r.scope === 'directory') {
      const seg = p.replace(/^\*\*\//, '').replace(/\/\*\*$/, '');
      if (seg && !seg.includes('*')) out.push('**/' + seg + '/**');
      else out.push(p.endsWith('/**') ? p : p + '/**');
    } else {
      out.push(p);
    }
  }
  return out;
}

/* ----------------------------- rg 探测 ----------------------------- */

/**
 * 探测 rg（不含任何本机硬编码路径）：
 * ① 显式指定的环境变量 RG_PATH ② PATH 上的 rg（Windows 同时试 rg.exe）③ 都没有 → ok:false。
 * RG_PATH 显式指定但不可用时直接报错（不再回落到 PATH），避免"以为用了指定版本其实没用"。
 */
export function findRgBinary() {
  const env = process.env.RG_PATH;
  if (env && String(env).trim() !== '') {
    const p = path.resolve(String(env).trim());
    if (isExecutableFile(p)) return { ok: true, path: p, source: 'RG_PATH' };
    return {
      ok: false, path: p, source: 'RG_PATH',
      reason: `RG_PATH 指向的可执行文件不存在或不可执行：${toPosix(p)}`,
    };
  }
  const dirs = String(process.env.PATH || '').split(path.delimiter);
  for (const d of dirs) {
    if (!d) continue;
    for (const name of ['rg.exe', 'rg']) {
      const p = path.join(d, name);
      if (isExecutableFile(p)) return { ok: true, path: p, source: 'PATH' };
    }
  }
  return { ok: false, path: null, source: 'none', reason: 'PATH 上未找到 rg，且未设置环境变量 RG_PATH' };
}

/** 测试用桩：注入 rg 调用（仅 selftest 使用，生产恒为 null）。 */
let runRgStub = null;
export function __setRunRgStub(fn) { runRgStub = fn || null; }

/**
 * 运行 rg，逐行回调（不整块缓冲 stdout）。
 * onLine 收到的是 stdout 的每一行（已去掉行尾）。
 *
 * 两种取输出方式：
 * ① 管道（默认，生产环境）：spawn 默认 stdio='pipe'。
 * ② 文件描述符（兜底）：部分受限沙箱禁止子进程用命名管道（spawn 报 EPERM），
 *    此时改为把 stdout/stderr 重定向到临时文件（stdio 传 fd），跑完再读。
 *    两种方式的语义完全一致。
 */
let pipeSpawnUsable = true;

function runRgPiped(rgPath, args, timeoutMs, onLine) {
  return new Promise((resolve) => {
    let child = null;
    try {
      child = spawn(rgPath, args, { windowsHide: true });
    } catch (e) {
      resolve({ code: -1, stderr: String((e && e.message) || e), killed: false, spawnError: true, lines: [], ephem: e && e.code === 'EPERM' });
      return;
    }
    let err = '';
    let killed = false;
    let pending = '';
    const lines = [];
    const timer = timeoutMs ? setTimeout(() => { killed = true; try { child.kill(); } catch { /* ignore */ } }, timeoutMs) : null;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      pending += chunk;
      let idx;
      while ((idx = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, idx);
        pending = pending.slice(idx + 1);
        if (onLine) { try { onLine(line); } catch { /* ignore */ } }
        else lines.push(line);
      }
    });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => {
      if (timer) clearTimeout(timer);
      resolve({ code: -1, stderr: err + String((e && e.message) || e), killed, spawnError: true, lines, ephem: e && e.code === 'EPERM' });
    });
    child.on('close', code => {
      if (timer) clearTimeout(timer);
      if (pending.length) { if (onLine) { try { onLine(pending); } catch { /* ignore */ } } else lines.push(pending); }
      resolve({ code, stderr: err, killed, spawnError: false, lines });
    });
  });
}

function runRgViaFiles(rgPath, args, timeoutMs, onLine) {
  let dir = null, outFd = null, errFd = null;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-rg-'));
    outFd = fs.openSync(path.join(dir, 'out.txt'), 'w');
    errFd = fs.openSync(path.join(dir, 'err.txt'), 'w');
  } catch (e) {
    try { if (outFd !== null) fs.closeSync(outFd); } catch { /* ignore */ }
    try { if (errFd !== null) fs.closeSync(errFd); } catch { /* ignore */ }
    try { if (dir) fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    return Promise.resolve({ code: -1, stderr: `无法创建临时目录：${(e && e.message) || e}`, killed: false, spawnError: true, lines: [] });
  }
  return new Promise((resolve) => {
    let child = null;
    let killed = false;
    try {
      child = spawn(rgPath, args, { windowsHide: true, stdio: ['ignore', outFd, errFd] });
    } catch (e) {
      resolve({ code: -1, stderr: String((e && e.message) || e), killed: false, spawnError: true, lines: [] });
      return;
    }
    const timer = timeoutMs ? setTimeout(() => { killed = true; try { child.kill(); } catch { /* ignore */ } }, timeoutMs) : null;
    child.on('error', e => {
      if (timer) clearTimeout(timer);
      resolve({ code: -1, stderr: String((e && e.message) || e), killed, spawnError: true, lines: [] });
    });
    child.on('close', code => {
      if (timer) clearTimeout(timer);
      resolve({ code, killed, spawnError: false });
    });
  }).then(r => {
    let stdout = '', stderr = '';
    try { fs.closeSync(outFd); } catch { /* ignore */ }
    try { fs.closeSync(errFd); } catch { /* ignore */ }
    try { stdout = fs.readFileSync(path.join(dir, 'out.txt'), 'utf8'); } catch { /* ignore */ }
    try { stderr = fs.readFileSync(path.join(dir, 'err.txt'), 'utf8'); } catch { /* ignore */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    const lines = [];
    const body = stdout.split('\n');
    for (let i = 0; i < body.length; i++) {
      const line = body[i];
      if (i === body.length - 1 && line === '') continue;
      if (onLine) { try { onLine(line); } catch { /* ignore */ } } else lines.push(line);
    }
    return Object.assign(r, { stdout, stderr, lines });
  });
}

async function runRg(rgPath, args, opts) {
  if (runRgStub) return runRgStub(rgPath, args, opts);
  const options = opts || {};
  const timeoutMs = options.timeoutMs || 0;
  const onLine = options.onLine || null;
  if (pipeSpawnUsable) {
    const r = await runRgPiped(rgPath, args, timeoutMs, onLine);
    if (r.ephem) {
      pipeSpawnUsable = false;
      return runRgViaFiles(rgPath, args, timeoutMs, onLine);
    }
    return r;
  }
  return runRgViaFiles(rgPath, args, timeoutMs, onLine);
}

/** rg --count-matches 的输出行 "path:count" → {path, count}。 */
function parseCountLine(line) {
  const i = line.lastIndexOf(':');
  if (i <= 0) return null;
  const count = Number(line.slice(i + 1));
  if (!Number.isFinite(count)) return null;
  return { path: line.slice(0, i), count };
}

/** stderr 里的 "os error" 行 → 不可读文件计数。 */
function countUnreadable(stderr) {
  let n = 0;
  for (const line of String(stderr || '').split('\n')) {
    if (/os error \d+/i.test(line)) n++;
  }
  return n;
}

/**
 * stderr 的不可读明细（`rg: <path>: <message> (os error N)`）→ skippedSamples 条目。
 * 解析不出路径、或路径命中敏感规则时，只保留 reason（绝不带 path）。
 */
function unreadableSamples(stderr, rootAbs, sensitiveRules) {
  const out = [];
  for (const raw of String(stderr || '').split('\n')) {
    const line = raw.trim();
    if (!line || !/os error \d+/i.test(line)) continue;
    const m = /^rg:\s+(.+?):\s+[\s\S]*\(os error \d+\)$/i.exec(line);
    const p = m ? m[1].trim() : '';
    if (!p) { out.push({ reason: 'unreadable' }); continue; }
    if (isSensitivePath(p, rootAbs, sensitiveRules)) out.push({ reason: 'unreadable' });
    else out.push({ path: toPosix(p), reason: 'unreadable' });
  }
  return out;
}

/* ----------------------------- 工具主体 ----------------------------- */

function intArg(v, dflt, min, max) {
  if (v === undefined || v === null) return dflt;
  const n = Number(v);
  if (!Number.isFinite(n) || Math.floor(n) !== n) return null;
  if (min !== undefined && n < min) return null;
  if (max !== undefined && n > max) return null;
  return n;
}

function strArrayArg(v, name) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new Error(`${name} 必须是字符串数组`);
  for (const x of v) if (typeof x !== 'string') throw new Error(`${name} 必须是字符串数组`);
  return v.slice();
}

/**
 * 核心检索。返回结构见 README。
 * 只读：本函数只做「枚举 + 检索」，不写任何文件。
 */
async function searchContentImpl(rawArgs) {
  const t0 = Date.now();
  const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {};

  /* ---- 参数校验 ---- */
  const query = args.query;
  if (typeof query !== 'string' || query.length === 0) {
    return errorResult('invalid_args', 'query 必填，且必须是非空字符串');
  }
  const mode = args.mode === undefined || args.mode === null ? 'literal' : args.mode;
  if (!MODES.has(mode)) return errorResult('invalid_args', `mode 只能是 literal 或 regex（收到：${JSON.stringify(mode)}）`);
  const output = args.output === undefined || args.output === null ? 'files' : args.output;
  if (!OUTPUT_MODES.has(output)) return errorResult('invalid_args', `output 只能是 matches / files / count（收到：${JSON.stringify(output)}）`);
  const encoding = args.encoding === undefined || args.encoding === null ? 'auto' : args.encoding;
  if (!ENCODINGS.has(encoding)) return errorResult('invalid_args', `encoding 只能是 auto / utf-8 / gb18030 / big5 / utf-16le / utf-16be（收到：${JSON.stringify(encoding)}）`);

  let include = [];
  let exclude = [];
  try { include = strArrayArg(args.include, 'include'); } catch (e) { return errorResult('invalid_args', e.message); }
  const hasExclude = Object.prototype.hasOwnProperty.call(args, 'exclude') && args.exclude !== undefined && args.exclude !== null;
  try { exclude = hasExclude ? strArrayArg(args.exclude, 'exclude') : DEFAULT_EXCLUDES.slice(); }
  catch (e) { return errorResult('invalid_args', e.message); }

  const caseSensitive = args.case_sensitive === undefined || args.case_sensitive === null ? true : !!args.case_sensitive;
  const respectGitignore = args.respect_gitignore === undefined || args.respect_gitignore === null ? false : !!args.respect_gitignore;
  const followSymlinks = args.follow_symlinks === undefined || args.follow_symlinks === null ? false : !!args.follow_symlinks;
  const multiline = args.multiline === undefined || args.multiline === null ? false : !!args.multiline;
  const onlyMatching = args.only_matching === undefined || args.only_matching === null ? false : !!args.only_matching;

  const contextLines = intArg(args.context_lines, 0, 0, 1000);
  if (contextLines === null) return errorResult('invalid_args', 'context_lines 必须是 ≥ 0 的整数');
  const maxResults = intArg(args.max_results, 500, 0, 1000000);
  if (maxResults === null) return errorResult('invalid_args', 'max_results 必须是 ≥ 0 的整数');
  const offset = intArg(args.offset, 0, 0, 1000000);
  if (offset === null) return errorResult('invalid_args', 'offset 必须是 ≥ 0 的整数');
  const maxFiles = intArg(args.max_files, 5000, 1, 10000000);
  if (maxFiles === null) return errorResult('invalid_args', 'max_files 必须是 ≥ 1 的整数');
  const maxMatchesPerFile = intArg(args.max_matches_per_file, 50, 1, 100000);
  if (maxMatchesPerFile === null) return errorResult('invalid_args', 'max_matches_per_file 必须是 ≥ 1 的整数');
  const maxContext = intArg(args.max_context, 200, 0, 100000);
  if (maxContext === null) return errorResult('invalid_args', 'max_context 必须是 ≥ 0 的整数');
  const maxColumns = intArg(args.max_columns, 500, 1, 1000000);
  if (maxColumns === null) return errorResult('invalid_args', 'max_columns 必须是 ≥ 1 的整数');
  // tail：每文件只保留「行号最大的 N 条命中」（追加式日志取最新几条）；仅 matches 模式有效
  const tailProvided = Object.prototype.hasOwnProperty.call(args, 'tail') && args.tail !== undefined && args.tail !== null;
  let tailLen = 0;
  if (tailProvided) {
    const t = intArg(args.tail, null, 1, 1000000);
    if (t === null) return errorResult('invalid_args', `tail 必须是 ≥ 1 的整数（收到：${JSON.stringify(args.tail)}）`);
    if (output !== 'matches') return errorResult('invalid_args', `tail 只对 output='matches' 有效（当前 output=${JSON.stringify(output)}）；files/count 模式请改用 offset 翻页，或先 output='matches' 再取尾部`);
    tailLen = t;
  }

  /* ---- 根目录 ---- */
  const rootInput = args.path === undefined || args.path === null ? process.cwd() : String(args.path);
  if (rootInput.trim() === '') return errorResult('invalid_args', 'path 不能为空字符串');
  const rootAbs = path.resolve(rootInput);
  let rootStat = null;
  try { rootStat = fs.statSync(rootAbs); } catch { rootStat = null; }
  if (!rootStat) return errorResult('not_found', `搜索根不存在：${toPosix(rootAbs)}`);
  // path 既可以是目录，也可以是单个文件（rg 原生支持 `rg PATTERN somefile`）
  const rootIsFile = rootStat.isFile();
  if (!rootIsFile && !rootStat.isDirectory()) return errorResult('invalid_args', `搜索根必须是目录或文件：${toPosix(rootAbs)}`);

  /* ---- rg 探测 ---- */
  const rg = findRgBinary();
  if (!rg.ok) {
    return errorResult('dependency_unavailable',
      `${rg.reason}。请安装 ripgrep（https://github.com/BurntSushi/ripgrep）并加入 PATH，或用环境变量 RG_PATH 指向 rg 可执行文件（RG_PATH 优先于 PATH）。`,
      { expected: rg.path ? [toPosix(rg.path)] : [], installHint: '安装 ripgrep 后重试，或用 RG_PATH 环境变量指向 rg 可执行文件' });
  }
  const rgPath = rg.path;

  /* ---- 敏感规则 ---- */
  const sensitiveRules = loadSensitiveRules();
  const sensGlobs = sensitiveGlobs(sensitiveRules);

  /* ---- 通用 rg 参数 ---- */
  const baseArgs = ['--hidden'];
  if (!respectGitignore) baseArgs.push('--no-ignore-vcs');
  if (followSymlinks) baseArgs.push('--follow');
  const patternArgs = mode === 'literal' ? ['--fixed-strings', '-e', query] : ['-e', query];
  const encodingArgs = encoding === 'auto' ? [] : ['--encoding', encoding];
  const caseArgs = caseSensitive ? [] : ['-i'];
  const multilineArgs = multiline ? ['-U'] : [];
  // only_matching=true 时真正忽略 context_lines：不向 rg 传 -C（因此不会产生任何上下文行）
  const contextArgs = (contextLines > 0 && !onlyMatching) ? ['-C', String(contextLines)] : [];
  const globArgs = [];
  // include 白名单：rg 侧只传「超集」glob（'**/' + pat）；精确语义统一由 JS 侧 matchGlobPattern 决定
  for (const g of include) {
    const gp = String(g).replace(/\\/g, '/');
    globArgs.push('--glob', gp.startsWith('**/') ? gp : '**/' + gp);
  }
  for (const g of exclude) globArgs.push('--glob', '!' + g);
  for (const g of sensGlobs) globArgs.push('--glob', '!' + g);

  const hints = [];
  let newlineHinted = false;
  let truncated = false;
  let truncatedBy = null;
  let tailApplied = null;   // 仅当传了 tail 时写入返回值（实际生效的尾长）
  // 截断原因的优先级（数字大的优先成为 truncatedBy）
  const TRUNC_PRIORITY = { max_matches_per_file: 60, max_context: 55, max_columns: 50, scan_limit: 40, max_results: 30 };
  function markTruncated(by) {
    truncated = true;
    if (!truncatedBy || (TRUNC_PRIORITY[by] || 0) > (TRUNC_PRIORITY[truncatedBy] || 0)) truncatedBy = by;
  }
  const skippedSamples = [];
  let binarySkipped = 0;
  let sensitiveSkipped = 0;
  let unreadable = 0;

  /* ---- 枚举候选文件（用于敏感计数 + 文件预算） ---- */
  const enumArgs = ['--files', '--hidden'];
  if (!respectGitignore) enumArgs.push('--no-ignore-vcs');
  if (followSymlinks) enumArgs.push('--follow');
  for (const g of include) {
    const gp = String(g).replace(/\\/g, '/');
    enumArgs.push('--glob', gp.startsWith('**/') ? gp : '**/' + gp);
  }
  for (const g of exclude) enumArgs.push('--glob', '!' + g);

  const deadline = t0 + SCAN_TIME_BUDGET_MS;
  const allFiles = [];
  if (rootIsFile) {
    // 单文件目标：不需要枚举（也不该被 include/exclude 的 glob 误伤）
    allFiles.push(toPosix(rootAbs));
  } else {
    enumArgs.push(rootAbs);
    const enumRes = await runRg(rgPath, enumArgs, { timeoutMs: Math.max(1000, deadline - Date.now()) });
    if (enumRes.spawnError) return errorResult('io_error', `调用 rg 失败：${String(enumRes.stderr || '').trim().slice(0, 500)}`);
    const enumStderr = String(enumRes.stderr || '');
    const enumUnreadable = countUnreadable(enumStderr);
    // 只有「局部不可读」（stderr 含 os error）才降级为部分结果；其余 exit 2 仍整体报错，不许吞
    const enumPartial = enumRes.code !== 0 && enumRes.code !== 1 && /os error/i.test(enumStderr);
    if (enumRes.code !== 0 && enumRes.code !== 1 && !enumPartial) {
      return errorResult('io_error', `rg --files 失败（exit ${enumRes.code}）：${enumStderr.trim().slice(0, 500)}`);
    }
    if (enumPartial) {
      // rg 遇 ACL 拒绝列举会 exit 2 中止，但已枚举到的文件仍在 enumRes.lines 里 → 保留部分结果
      for (const s of unreadableSamples(enumStderr, rootAbs, sensitiveRules)) {
        if (skippedSamples.length >= 10) break;
        skippedSamples.push(s);
      }
      hints.push(`有 ${enumUnreadable} 个目录/文件不可读（明细见 skippedSamples），本次结果不完整；若只需其余部分可直接使用本次结果；若要覆盖这些路径，请缩小 path 或显式传 exclude 排除它们。`);
    }
    unreadable += enumUnreadable;
    for (const line of enumRes.lines) {
      const p = line.trim();
      if (p) allFiles.push(p);
    }
    allFiles.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }

  // 敏感文件：路径与文件名都不返回，只计数（skippedSamples 里也不带 path）
  const sensitiveFiltered = [];
  const sensitivePaths = new Set();
  for (const f of allFiles) {
    const rule = isSensitivePath(f, rootAbs, sensitiveRules);
    if (rule) {
      sensitiveSkipped++;
      sensitivePaths.add(toPosix(f));
      if (skippedSamples.length < 10) skippedSamples.push({ reason: 'sensitive' });
      continue;
    }
    sensitiveFiltered.push(f);
  }

  // include 白名单的 JS 侧过滤：与 rg 的 glob 语义解耦，避免 rg glob 写法差异导致 0 命中
  const scanCandidates = [];
  for (const f of sensitiveFiltered) {
    if (include.length && !include.some(g => matchGlobPattern(g, f, rootAbs))) continue;
    scanCandidates.push(f);
  }

  /* ---- 文件预算 ---- */
  let scanFiles = null;
  if (rootIsFile) {
    // 单文件目标：直接把这个文件交给 rg（等价于 `rg PATTERN somefile`），不走目录递归
    scanFiles = scanCandidates.slice();
  } else if (scanCandidates.length > maxFiles) {
    scanFiles = scanCandidates.slice(0, maxFiles);
    markTruncated('scan_limit');
    hints.push('扫描预算用尽（max_files），结果是部分的，可缩小 path 或增大 maxFiles 重试');
  }

  const remainingMs = () => Math.max(500, deadline - Date.now());

  /* ---- 检索 ---- */
  const searchGlobs = globArgs;
  let records = [];   // {path, matches, lines?, lineTruncated?}

  if (output === 'matches') {
    // JSON 流式解析：逐条事件处理
    const byPath = new Map();
    let storedLines = 0;
    let storeOverflow = false;
    const perFileCap = maxMatchesPerFile;
    const tailCap = tailLen;          // >0 表示 tail 生效：tail 优先于 max_matches_per_file
    let tailDropped = false;          // 至少一个文件因 tail 只保留了尾部 N 条
    // tail 生效时按「入队后丢最旧」的环形策略保留尾部 N 条命中行：行号仍升序，内存有界
    const ringPushMatch = (f, entry) => {
      f.lines.push(entry);
      f.hitCount++;
      storedLines++;
      if (tailCap > 0 && f.hitCount > tailCap) {
        const idx = f.lines.findIndex((x) => !x.context);
        if (idx >= 0) { f.lines.splice(idx, 1); f.hitCount--; storedLines--; }
        f.lineTruncated = true;
        tailDropped = true;
      }
    };
    const perContextCap = maxContext;
    let anyColumnTrunc = false;
    let perFileTruncated = false;   // 至少一个文件被 max_matches_per_file 截断
    let contextTruncated = false;   // 至少一个文件的上下文行被 max_context 截断

    const handleJsonLine = (line) => {
      const s = line.trim();
      if (!s || s[0] !== '{') return;
      let ev;
      try { ev = JSON.parse(s); } catch { return; }
      const d = ev.data || {};
      const p = d.path && d.path.text ? d.path.text : null;
      if (!p) return;
      let f = byPath.get(p);
      if (!f) { f = { path: p, matches: 0, lines: [], binary: false, colTrunc: false, hitCount: 0, ctxCount: 0, lineTruncated: false }; byPath.set(p, f); }
      if (ev.type === 'match' || ev.type === 'context') {
        const text = d.lines && typeof d.lines.text === 'string' ? d.lines.text.replace(/\r?\n$/, '') : '';
        const lineNo = typeof d.line_number === 'number' ? d.line_number : null;
        if (ev.type === 'context') {
          // 上下文行上限：超限时显式标记（不再静默丢弃）
          if (f.ctxCount >= perContextCap) { contextTruncated = true; return; }
          let t = text;
          let tr = false;
          if (t.length > maxColumns) { t = t.slice(0, maxColumns) + ' …[truncated]'; tr = true; }
          if (tr) { f.colTrunc = true; anyColumnTrunc = true; }
          f.lines.push({ line: lineNo, text: t, context: true });
          f.ctxCount++;
          return;
        }
        const subs = Array.isArray(d.submatches) ? d.submatches : [];
        if (onlyMatching) {
          for (const sub of subs) {
            if (tailCap === 0 && f.hitCount >= perFileCap) { f.lineTruncated = true; perFileTruncated = true; break; }
            if (storedLines >= MAX_STORED_LINES) { storeOverflow = true; break; }
            let t = sub && sub.match && typeof sub.match.text === 'string' ? sub.match.text : '';
            let tr = false;
            if (t.length > maxColumns) { t = t.slice(0, maxColumns) + ' …[truncated]'; tr = true; }
            if (tr) { f.colTrunc = true; anyColumnTrunc = true; }
            ringPushMatch(f, { line: lineNo, text: t });
          }
        } else {
          if (tailCap === 0 && f.hitCount >= perFileCap) { f.lineTruncated = true; perFileTruncated = true; return; }
          if (storedLines >= MAX_STORED_LINES) { storeOverflow = true; return; }
          let t = text;
          let tr = false;
          if (t.length > maxColumns) { t = t.slice(0, maxColumns) + ' …[truncated]'; tr = true; }
          if (tr) { f.colTrunc = true; anyColumnTrunc = true; }
          ringPushMatch(f, { line: lineNo, text: t });
        }
      } else if (ev.type === 'end') {
        const st = d.stats || {};
        if (typeof st.matches === 'number') f.matches = st.matches;
        if (d.binary_offset !== null && d.binary_offset !== undefined) f.binary = true;
      }
    };

    const searchArgs = [...baseArgs, '--json', ...patternArgs, ...encodingArgs, ...caseArgs, ...multilineArgs, ...contextArgs, '--binary'];
    if (scanFiles === null) {
      const r = await runRg(rgPath, [...searchArgs, ...searchGlobs, rootAbs], { timeoutMs: remainingMs(), onLine: handleJsonLine });
      if (r.spawnError) return errorResult('io_error', `调用 rg 失败：${String(r.stderr || '').trim().slice(0, 500)}`);
      if (r.code !== 0 && r.code !== 1) {
        const se = String(r.stderr || '');
        if (/newline|multiline/i.test(se)) {
          if (!newlineHinted) { newlineHinted = true; hints.push('查询含换行但未开启 multiline=true → 视为无命中'); }
        } else if (/os error/i.test(se)) {
          unreadable += countUnreadable(se); // 局部不可读：返回部分结果，不当错误
        } else {
          return errorResult('io_error', `rg 检索失败（exit ${r.code}）：${se.trim().slice(0, 500)}`);
        }
      }
      if (r.killed) { markTruncated('scan_limit'); hints.push('扫描预算用尽（墙钟），结果是部分的，可缩小 path 重试'); }
      unreadable += countUnreadable(r.stderr);
    } else {
      const chunks = [];
      let cur = [], curLen = 0;
      for (const f of scanFiles) {
        if (curLen + f.length + 3 > CHUNK_PATH_BUDGET && cur.length) { chunks.push(cur); cur = []; curLen = 0; }
        cur.push(f); curLen += f.length + 3;
      }
      if (cur.length) chunks.push(cur);
      for (const c of chunks) {
        if (Date.now() > deadline) { markTruncated('scan_limit'); hints.push('扫描预算用尽（墙钟），结果是部分的，可缩小 path 重试'); break; }
        const r = await runRg(rgPath, [...searchArgs, '--', ...c], { timeoutMs: remainingMs(), onLine: handleJsonLine });
        if (r.spawnError) return errorResult('io_error', `调用 rg 失败：${String(r.stderr || '').trim().slice(0, 500)}`);
        if (r.code !== 0 && r.code !== 1) {
          const se = String(r.stderr || '');
          if (/newline|multiline/i.test(se)) {
            if (!newlineHinted) { newlineHinted = true; hints.push('查询含换行但未开启 multiline=true → 视为无命中'); }
          } else if (/os error/i.test(se)) {
            unreadable += countUnreadable(se);
          } else {
            return errorResult('io_error', `rg 检索失败（exit ${r.code}）：${se.trim().slice(0, 500)}`);
          }
          break;
        }
        if (r.killed) { markTruncated('scan_limit'); hints.push('扫描预算用尽（墙钟），结果是部分的，可缩小 path 重试'); break; }
        unreadable += countUnreadable(r.stderr);
      }
    }

    for (const f of byPath.values()) {
      if (sensitivePaths.has(toPosix(f.path)) || isSensitivePath(f.path, rootAbs, sensitiveRules)) {
        // 双保险：敏感文件绝不出现在结果里（路径/文件名都不外泄）
        continue;
      }
      if (f.binary) {
        binarySkipped++;
        if (skippedSamples.length < 10) skippedSamples.push({ path: toPosix(f.path), reason: 'binary' });
        continue;
      }
      records.push({ path: f.path, matches: f.matches, lines: f.lines, lineTruncated: f.lineTruncated });
    }
    if (perFileTruncated) {
      markTruncated('max_matches_per_file');
      hints.push(`每文件命中行数受 max_matches_per_file=${maxMatchesPerFile} 限制，部分文件的行内容被截断（该文件标记 lineTruncated=true），可增大该参数或用 offset 翻页`);
    }
    if (tailCap > 0) {
      // tail 优先：每文件命中行数超过 tail 时只保留尾部 N 条（truncatedBy 复用 max_matches_per_file，靠 tailApplied 区分）
      if (tailDropped) {
        markTruncated('max_matches_per_file');
        hints.push(`tail=${tailCap} 生效：每个文件只保留行号最大的最后 ${tailCap} 条命中（更早的命中行已丢弃，该文件标记 lineTruncated=true）；truncatedBy 复用 max_matches_per_file，用 tailApplied 区分`);
      }
      const maxRetained = records.reduce((m, r) => Math.max(m, r.lines.filter((l) => !l.context).length), 0);
      // tailApplied = min(tail, 各文件保留命中行数的最大值)：tail 大于命中总数时等于实际命中数
      tailApplied = Math.min(tailCap, maxRetained);
    }
    if (contextTruncated) {
      markTruncated('max_context');
      hints.push(`部分文件的上下文行超过 max_context=${maxContext}，上下文行被截断`);
    }
    if (anyColumnTrunc) {
      markTruncated('max_columns');
      hints.push(`部分行超过 max_columns=${maxColumns}，已截断并标记`);
    }
    if (storeOverflow) {
      markTruncated('scan_limit');
      hints.push('命中行过多，超出内存护栏，部分行内容未保留');
    }
    records.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  } else {
    // files / count：用 --count-matches（便宜）。跑两遍：
    // A = 不带 --binary（rg 天然跳过二进制）→ 结果集；B = 带 --binary → 多出来的即被跳过的二进制文件。
    const countArgs = [...baseArgs, ...patternArgs, ...encodingArgs, ...caseArgs, ...multilineArgs];
    const runCount = async (extra) => {
      const out = new Map();
      const extraArgs = extra ? [extra] : [];
      let chunkPaths = null; // 当前批次显式传入的文件（单文件时 rg 只输出数字）
      const collect = (line) => {
        let rec = parseCountLine(line);
        // rg 对「显式传入的单个文件」只输出数字（不带路径），这里补回路径
        if (!rec && chunkPaths && chunkPaths.length === 1) {
          const n = Number(String(line).trim());
          if (Number.isFinite(n)) rec = { path: chunkPaths[0], count: n };
        }
        if (rec) out.set(rec.path, rec.count);
      };
      if (scanFiles === null) {
        const r = await runRg(rgPath, [...countArgs, ...extraArgs, '--count-matches', ...searchGlobs, rootAbs], { timeoutMs: remainingMs(), onLine: collect });
        if (r.spawnError) return { ok: false, err: `调用 rg 失败：${String(r.stderr || '').trim().slice(0, 500)}` };
        if (r.code !== 0 && r.code !== 1) {
          const se = String(r.stderr || '');
          if (/newline|multiline/i.test(se)) {
            if (!newlineHinted) { newlineHinted = true; hints.push('查询含换行但未开启 multiline=true → 视为无命中'); }
          } else if (/os error/i.test(se)) {
            unreadable += countUnreadable(se);
          } else {
            return { ok: false, err: `rg 检索失败（exit ${r.code}）：${se.trim().slice(0, 500)}` };
          }
        }
        if (r.killed) { markTruncated('scan_limit'); hints.push('扫描预算用尽（墙钟），结果是部分的，可缩小 path 重试'); }
        unreadable += countUnreadable(r.stderr);
        return { ok: true, out };
      }
      const chunks = [];
      let cur = [], curLen = 0;
      for (const f of scanFiles) {
        if (curLen + f.length + 3 > CHUNK_PATH_BUDGET && cur.length) { chunks.push(cur); cur = []; curLen = 0; }
        cur.push(f); curLen += f.length + 3;
      }
      if (cur.length) chunks.push(cur);
      for (const c of chunks) {
        if (Date.now() > deadline) { markTruncated('scan_limit'); hints.push('扫描预算用尽（墙钟），结果是部分的，可缩小 path 重试'); break; }
        chunkPaths = c;
        const r = await runRg(rgPath, [...countArgs, ...extraArgs, '--count-matches', '--', ...c], { timeoutMs: remainingMs(), onLine: collect });
        if (r.spawnError) return { ok: false, err: `调用 rg 失败：${String(r.stderr || '').trim().slice(0, 500)}` };
        if (r.code !== 0 && r.code !== 1) {
          const se = String(r.stderr || '');
          if (/newline|multiline/i.test(se)) {
            if (!newlineHinted) { newlineHinted = true; hints.push('查询含换行但未开启 multiline=true → 视为无命中'); }
          } else if (/os error/i.test(se)) {
            unreadable += countUnreadable(se);
          } else {
            return { ok: false, err: `rg 检索失败（exit ${r.code}）：${se.trim().slice(0, 500)}` };
          }
          break;
        }
        if (r.killed) { markTruncated('scan_limit'); hints.push('扫描预算用尽（墙钟），结果是部分的，可缩小 path 重试'); break; }
        unreadable += countUnreadable(r.stderr);
      }
      return { ok: true, out };
    };

    const a = await runCount('');
    if (!a.ok) return errorResult('io_error', a.err);
    const b = await runCount('--binary');
    if (!b.ok) return errorResult('io_error', b.err);
    for (const [p] of b.out) {
      if (sensitivePaths.has(toPosix(p)) || isSensitivePath(p, rootAbs, sensitiveRules)) continue;
      if (!a.out.has(p)) {
        binarySkipped++;
        if (skippedSamples.length < 10) skippedSamples.push({ path: toPosix(p), reason: 'binary' });
      }
    }
    for (const [p, c] of a.out) {
      if (sensitivePaths.has(toPosix(p)) || isSensitivePath(p, rootAbs, sensitiveRules)) continue;
      records.push({ path: p, matches: c, lines: [] });
    }
    records.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  }

  /* ---- include 白名单：JS 侧统一过滤（任何分支都生效，保证结果集不随扫描分支变化） ---- */
  if (include.length) {
    records = records.filter(r => include.some(g => matchGlobPattern(g, r.path, rootAbs)));
  }

  /* ---- 分页 / 上限 ---- */
  let files = [];
  let totals = { files: 0, matches: 0 };

  if (output === 'matches') {
    // 扁平化成"命中行"序列（上下文行不计入 max_results），按 path 顺序，再套 offset / max_results
    const flat = [];
    for (const rec of records) {
      for (const ln of rec.lines) {
        if (ln.context) continue;
        flat.push({ path: rec.path, matches: rec.matches, ln, lineTruncated: rec.lineTruncated });
      }
    }
    const page = flat.slice(offset, offset + maxResults);
    if (offset + maxResults < flat.length) {
      markTruncated('max_results');
      hints.push(`结果被 max_results=${maxResults} 截断（只计命中行，上下文行不占名额），可用 offset=${offset + maxResults} 继续翻页`);
    }
    const keep = new Map();
    for (const it of page) {
      let e = keep.get(it.path);
      if (!e) { e = { path: it.path, matches: it.matches, lines: [], lineTruncated: !!it.lineTruncated }; keep.set(it.path, e); }
      e.lines.push(it.ln);
    }
    // 把属于本页命中行的上下文行补回（上下文行不占 max_results 名额）
    for (const rec of records) {
      const e = keep.get(rec.path);
      if (!e || !e.lines.length) continue;
      const hits = e.lines.map(l => l.line).filter(n => typeof n === 'number');
      if (!hits.length) continue;
      const ctx = rec.lines.filter(l => l.context && typeof l.line === 'number' && hits.some(h => h >= l.line - contextLines && h <= l.line + contextLines));
      if (ctx.length) e.lines = e.lines.concat(ctx).sort((a, b) => (a.line || 0) - (b.line || 0));
    }
    files = [...keep.values()].map(e => {
      const o = { path: toPosix(e.path), matches: e.matches, lines: e.lines };
      if (e.lineTruncated) o.lineTruncated = true;
      return o;
    });
    files.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
    totals = { files: files.length, matches: files.reduce((s, f) => s + f.matches, 0) };
  } else {
    // files / count：条目 = 文件
    const page = records.slice(offset, offset + maxResults);
    if (offset + maxResults < records.length) {
      markTruncated('max_results');
      hints.push(`结果被 max_results=${maxResults} 截断，可用 offset=${offset + maxResults} 继续翻页`);
    }
    totals = { files: page.length, matches: page.reduce((s, r) => s + r.matches, 0) };
    if (output === 'files') files = page.map(r => ({ path: toPosix(r.path), matches: r.matches }));
  }

  /* ---- 编码提示 ---- */
  if (encoding === 'auto' && totals.matches === 0) {
    hints.push("若目标含非 UTF-8 文本（如 GB18030/GBK 中文），可用 encoding='gb18030' 重试");
  }

  /* ---- 正则元字符提示（literal 模式下 0 命中时）---- */
  const REGEX_META = /[|.^$*+?(){}\[\]]/;
  if (totals.matches === 0 && mode === 'literal' && REGEX_META.test(query)) {
    hints.push("query 含正则元字符，但当前 mode='literal'（按字面量匹配，| 等会被当作普通字符）。若要用正则语义（如用 | 表示「或」），请传 mode='regex' 重试");
  }

  const res = {
    ok: true,
    mode: output,
    query,
    root: toPosix(rootAbs),
    encoding,
  };
  if (output === 'files' || output === 'matches') res.files = files;
  res.totals = totals;
  res.truncated = truncated;
  res.truncatedBy = truncatedBy;
  if (tailLen > 0) res.tailApplied = tailApplied;   // 未传 tail 时不出现该字段（向后兼容）
  res.limits = { maxResults, maxFiles, maxMatchesPerFile, maxColumns, maxContext };
  res.excludesApplied = exclude.slice();
  res.onlyMatchingApplied = onlyMatching;
  res.skipped = { binary: binarySkipped, sensitive: sensitiveSkipped, unreadable };
  res.skippedSamples = skippedSamples;
  res.hint = hints.length ? hints.join('；') : null;
  res.elapsedMs = Date.now() - t0;
  return res;
}

/** 本次实际生效的排除模式（刻意不叫 exclude，避免与入参混淆）。 */
function resolveExcludesApplied(rawArgs) {
  const a = rawArgs && typeof rawArgs === 'object' ? rawArgs : {};
  const has = Object.prototype.hasOwnProperty.call(a, 'exclude') && a.exclude !== undefined && a.exclude !== null;
  if (!has) return DEFAULT_EXCLUDES.slice();
  if (!Array.isArray(a.exclude) || a.exclude.some(x => typeof x !== 'string')) return [];
  return a.exclude.slice();
}

/** 唯一入口：任何返回分支（成功 / 部分结果 / 错误）都带 excludesApplied。 */
export async function searchContent(rawArgs) {
  const res = await searchContentImpl(rawArgs);
  if (res && typeof res === 'object' && !Object.prototype.hasOwnProperty.call(res, 'excludesApplied')) {
    res.excludesApplied = resolveExcludesApplied(rawArgs);
  }
  return res;
}

/* ----------------------------- MCP 协议层 ----------------------------- */

const TOOL = {
  name: 'search_content',
  description: [
    '按内容检索（ripgrep 驱动，只读）。',
    '第一步用 output="files"（默认）拿到「哪些文件提到了 X」+ 每文件命中数，再用支持 read_text(start_line,count) 的精读工具读少数几行（两段式，避免一次灌爆上下文）。',
    'output="count" 只给 totals；output="matches" 才给行号与行内容。',
    'path 可以是目录，也可以是单个文件（文件时只搜那一个文件）。',
    '警告：exclude 省略时用默认排除清单（node_modules/.git/.venv/venv/__pycache__，实测大幅减少遍历与输出条目）；显式传 exclude:[] 表示完全不做排除，遍历与输出条目会暴涨。',
    '警告：encoding="auto" 等于 rg 的按字节匹配；搜非 UTF-8 的中文必须显式给 encoding="gb18030"（rg 用 Rust regex 方言，不支持 PCRE2 语法）。',
    '命中任何上限都会返回 truncated:true + truncatedBy，取值仅 5 个：max_results / max_columns / max_context / max_matches_per_file / scan_limit。',
    'max_results 只数命中行（matches 模式）或文件条数（files/count 模式）；上下文行不计入 max_results。',
    'only_matching=true 时真正忽略 context_lines（不下发 -C，返回体不含任何上下文行，并标记 onlyMatchingApplied=true）。',
    'max_context（默认 200，上界 1e5）限制每文件保留的上下文行数，超限 → truncated:true + truncatedBy=max_context + hint。',
    'include 语义：无 "/" 的模式按 basename 匹配任意层级，含 "/" 的模式按相对搜索根的路径匹配（* 不跨 /，**/ 是可空前缀）；rg 侧只传超集 glob，JS 侧白名单在所有分支统一过滤，结果集不随目录大小/预算变化。exclude 只在 rg 侧生效；path 指向单个文件时跳过 rg --files 枚举，显式 exclude 对该单文件不生效。',
    '敏感文件（内置默认规则 .env*、*.pem、*.key、.ssh/**、.aws/**、*.credentials.yaml；可用环境变量 RG_PROTECTED_RULES 指向 JSON 文件覆盖）既不返回路径也不返回内容，只计入 skipped.sensitive。',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索串（必填，非空）' },
      mode: {
        type: 'string', enum: ['literal', 'regex'], default: 'literal',
        description: 'literal=字面量（默认；query 里的 | . * + ? ( ) [ ] 等按普通文本匹配，速度快）；regex=Rust regex 方言（想用 | 表示「或」、. 表示任意字符、^$ 锚定时选它；不引 PCRE2）',
      },
      path: { type: 'string', description: '搜索根（任何可读目录或单个文件；默认服务进程工作目录 process.cwd()；指向单个文件时跳过 rg --files 枚举，显式 exclude 对该单文件不生效)' },
      include: {
        type: 'array', items: { type: 'string' },
        description: '只搜匹配这些 glob 的文件（如 ["*.md","*.py"]）；空=不限扩展名。不含 "/" 的模式=匹配任意层级的 basename（如 ["index.mjs"]）；含 "/" 的模式=按相对搜索根的路径匹配（* 不跨 /，**/ 是可空前缀，故 **/*.mjs 也命中根层文件）；rg 侧只传超集 glob，JS 侧白名单在所有分支统一过滤，结果集不随目录大小/预算变化',
      },
      exclude: {
        type: 'array', items: { type: 'string' },
        description: '排除 glob，只在 rg 侧生效。省略=默认排除 **/node_modules/**、**/.git/**、**/.venv/**、**/venv/**、**/__pycache__/**；显式传 [] = 完全不做排除（扫描量暴涨，慎用）；path 指向单个文件时跳过 rg --files 枚举，显式 exclude 对该单文件不生效',
      },
      encoding: {
        type: 'string', enum: ['auto', 'utf-8', 'gb18030', 'big5', 'utf-16le', 'utf-16be'], default: 'auto',
        description: 'auto=按字节匹配（rg 默认）；搜非 UTF-8 中文必须显式给 gb18030',
      },
      case_sensitive: {
        type: 'boolean', default: true,
        description: '默认大小写敏感（明确优于 smart-case）；不确定大小写形式或搜自然语言文本时可设 false',
      },
      context_lines: { type: 'integer', minimum: 0, default: 0, description: '命中行前后各取几行（默认不取，省上下文）；上界 1000，超过上界会被归一或拒绝，以 README 参数表为准；上下文行不计入 max_results；only_matching=true 时忽略本项' },
      output: {
        type: 'string', enum: ['matches', 'files', 'count'], default: 'files',
        description: 'files=只回文件+每文件命中数（第一步）；matches=回行号与行内容；count=只回 totals',
      },
      max_results: { type: 'integer', minimum: 0, default: 500, description: '最多返回多少条结果条目（matches 模式=只数命中行；files/count 模式=文件条数；上下文行不计入）；上界 1e6，超过上界会被归一或拒绝，以 README 参数表为准' },
      offset: { type: 'integer', minimum: 0, default: 0, description: '跳过前 N 条再应用 max_results（分页用，避免重扫）；上界 1e6，超过上界会被归一或拒绝，以 README 参数表为准' },
      max_files: { type: 'integer', minimum: 1, default: 5000, description: '最多扫描多少文件（超限 → 部分结果 + truncatedBy=scan_limit）；上界 1e7，超过上界会被归一或拒绝，以 README 参数表为准' },
      max_matches_per_file: { type: 'integer', minimum: 1, default: 50, description: '每文件最多返回多少条（只作用于 matches 模式的行内容；触发时 truncatedBy=max_matches_per_file）；上界 1e5，超过上界会被归一或拒绝，以 README 参数表为准' },
      tail: { type: 'integer', minimum: 1, maximum: 1000000, description: '仅 output="matches" 有效：每个文件只保留行号最大的最后 N 条命中（用于追加式日志取最新 N 条；升序返回下前 N 条是最旧）。与 max_matches_per_file 互斥且 tail 优先：传了 tail 时该文件的 max_matches_per_file 不再生效。结果仍按行号升序，返回体带 tailApplied（= min(tail, 各文件保留命中行数的最大值)；单文件时即该文件的命中数）；trigger 截断时 truncatedBy 复用 max_matches_per_file' },
      max_context: { type: 'integer', minimum: 0, default: 200, description: '每文件最多保留多少条上下文行（默认 200；上界 1e5，超过上界会被归一或拒绝，以 README 参数表为准；触发时 truncated:true + truncatedBy=max_context + hint）' },
      max_columns: { type: 'integer', minimum: 1, default: 500, description: '超长行只回截断提示，避免一行撑爆上下文；上界 1e6，超过上界会被归一或拒绝，以 README 参数表为准' },
      multiline: { type: 'boolean', default: false, description: '跨行匹配（行号以起始行为准）' },
      only_matching: { type: 'boolean', default: false, description: '只回匹配片段而非整行；开启时真正忽略 context_lines（不返回任何上下文行），返回体标记 onlyMatchingApplied=true' },
      respect_gitignore: {
        type: 'boolean', default: false,
        description: '默认不遵守（宁可多搜，不静默漏）；若目标是 git 仓库且想排除被 ignore 的文件，可设 true',
      },
      follow_symlinks: { type: 'boolean', default: false, description: '默认不跟随符号链接' },
    },
    required: ['query'],
    additionalProperties: false,
  },
};

function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

function respond(id, result) { send({ jsonrpc: '2.0', id, result }); }
function respondError(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

async function handleMessage(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const id = msg.id;
  const method = msg.method;
  try {
    if (method === 'initialize') {
      respond(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'mcp-rg-search', version: '0.1.0' },
      });
    } else if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
      /* 通知：不回包 */
    } else if (method === 'ping') {
      respond(id, {});
    } else if (method === 'tools/list') {
      respond(id, { tools: [TOOL] });
    } else if (method === 'tools/call') {
      const params = msg.params || {};
      if (params.name !== 'search_content') {
        respond(id, { content: [{ type: 'text', text: JSON.stringify(errorResult('invalid_args', `未知工具：${params.name}`)) }], isError: true });
        return;
      }
      const res = await searchContent(params.arguments || {});
      respond(id, { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }], isError: !res.ok });
    } else if (id !== undefined) {
      respondError(id, -32601, `Method not found: ${method}`);
    }
  } catch (e) {
    if (id !== undefined) respondError(id, -32603, String((e && e.message) || e));
  }
}

export function startServer() {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line) handleMessage(line);
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

const isMain = !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) startServer();
