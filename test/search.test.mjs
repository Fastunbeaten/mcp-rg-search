#!/usr/bin/env node
// mcp-rg-search 自测：≥15 条断言，覆盖参数语义、三种输出模式、分页、编码、敏感文件、
// 上限显式、rg 缺失、排除清单、max_columns / only_matching / multiline / 大小写，
// 以及与 rg 原生 --json 结果的逐路径对拍。
// 运行：node test/search.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  searchContent, findRgBinary, loadSensitiveRules, isSensitivePath,
  DEFAULT_EXCLUDES, sensitiveGlobs, __setRunRgStub,
} from '../index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');   // 仓库根（测试从 test/ 子目录运行）
const FIX = path.join(ROOT, '.tmp', 'fixtures');
// 保证不存在的路径（用于 not_found / rg 缺失分支），不指向任何本机目录
const MISSING = toPosix(path.join(os.tmpdir(), 'mcp-rg-selftest-missing-dir'));
const MISSING_RG = toPosix(path.join(os.tmpdir(), 'mcp-rg-selftest-missing-rg', 'rg.exe'));
const GB_BYTES = Buffer.from([0xB0, 0xFC, 0xB9, 0xDC, 0xC0, 0xED, 0xC3, 0xFC, 0xC1, 0xEE, 0xB2, 0xE2, 0xCA, 0xD4, 0x0A]);

// 返回体字段白名单：新增任何顶层返回字段时，必须同轮在此登记，否则 F1 断言 FAIL。
// 允许"条件出现"的字段（如 onlyMatchingApplied）一并预先列出；本断言是子集判定（⊆），不是全等。
// 已按 index.mjs 逐处核实：成功体（res 对象 850-867）、错误体 errorResult()（ok/error/reason + extra）、
// searchContent 包装层补的 excludesApplied（881-886）、dependency_unavailable 的 expected/installHint（447）。
const KNOWN_RESULT_FIELDS = new Set([
  'ok', 'mode', 'query', 'root', 'encoding',
  'files', 'totals', 'truncated', 'truncatedBy', 'limits',
  'excludesApplied', 'onlyMatchingApplied', 'skipped', 'skippedSamples', 'hint', 'elapsedMs',
  'tailApplied',
  'error', 'reason', 'expected', 'installHint',
]);

const results = [];
function assert(name, cond, detail) {
  results.push({ name, ok: !!cond, detail: cond ? '' : (detail === undefined ? '' : String(detail)) });
  const mark = cond ? 'PASS' : 'FAIL';
  process.stdout.write(`[${mark}] ${name}${cond ? '' : '  << ' + String(detail)}\n`);
}
function toPosix(p) { return String(p).replace(/\\/g, '/'); }

/* ----------------------------- 夹具 ----------------------------- */

function makeFixtures() {
  fs.rmSync(FIX, { recursive: true, force: true });
  fs.mkdirSync(path.join(FIX, 'node_modules', 'pkg'), { recursive: true });
  fs.mkdirSync(path.join(FIX, 'deep'), { recursive: true });
  fs.mkdirSync(path.join(FIX, 'src', 'nested'), { recursive: true });
  fs.mkdirSync(path.join(FIX, 'budget', 'src', 'a_deep'), { recursive: true });
  const w = (rel, text) => fs.writeFileSync(path.join(FIX, rel), text, { encoding: 'utf8' });
  w('node_modules/pkg/needle.txt', 'cordis.patch inside node_modules\n');
  w('.env', 'SECRET_TOKEN=.envvalue\n');
  w('key.pem', '-----BEGIN PRIVATE KEY----- pencil\n');
  w('note.txt', 'plain cordis.patch here\n');
  w('page.txt', 'needle one\nneedle two\nneedle three\n');
  w('case.txt', 'Needle capital\n');
  w('multi.txt', 'foo\nbar\n');
  w('index.mjs', 'needle inside index.mjs\n');
  w('deep/deep.mjs', 'needle inside deep/deep.mjs\n');
  w('rootlevel.mjs', 'needle inside rootlevel.mjs\n');
  w('src/one.mjs', 'needle inside src/one.mjs\n');
  w('src/nested/two.mjs', 'needle inside src/nested/two.mjs\n');
  w('budget/src/aaa.mjs', 'needle inside budget aaa\n');
  w('budget/src/zzz.mjs', 'no match inside budget zzz\n');
  w('budget/src/a_deep/hit.mjs', 'needle inside budget a_deep\n');
  const ctxBody = [];
  for (let i = 1; i <= 30; i++) ctxBody.push(i === 15 ? 'needle at line 15' : ('filler line ' + i));
  w('ctx.txt', ctxBody.join('\n') + '\n');
  w('long.txt', 'x'.repeat(600) + ' needle ' + 'y'.repeat(600) + '\n');
  fs.writeFileSync(path.join(FIX, 'gb.txt'), GB_BYTES);
}

/* ---------------------- rg 原生对拍（独立于 index.mjs） ---------------------- */

function nativeRgFiles(rgPath, query, opts) {
  const o = opts || {};
  const root = path.resolve(o.root);
  const mode = o.mode || 'literal';
  const encoding = o.encoding || 'auto';
  const rules = loadSensitiveRules();
  const args = ['--json', '--hidden'];
  if (!o.respectGitignore) args.push('--no-ignore-vcs');
  if (mode === 'literal') args.push('--fixed-strings');
  if (encoding !== 'auto') args.push('--encoding', encoding);
  args.push('-e', query);
  for (const g of DEFAULT_EXCLUDES) args.push('--glob', '!' + g);
  for (const g of sensitiveGlobs(rules)) args.push('--glob', '!' + g);
  args.push(root);
  // 用文件描述符取输出（受限沙箱下管道 spawn 会报 EPERM）
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-rg-native-'));
  const outFd = fs.openSync(path.join(dir, 'out.json'), 'w');
  const errFd = fs.openSync(path.join(dir, 'err.txt'), 'w');
  return new Promise((resolve) => {
    const child = spawn(rgPath, args, { windowsHide: true, stdio: ['ignore', outFd, errFd] });
    child.on('error', () => resolve(new Set()));
    child.on('close', () => {
      try { fs.closeSync(outFd); } catch { /* ignore */ }
      try { fs.closeSync(errFd); } catch { /* ignore */ }
      let text = '';
      try { text = fs.readFileSync(path.join(dir, 'out.json'), 'utf8'); } catch { /* ignore */ }
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      const paths = new Set();
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        const p = ev.data && ev.data.path && ev.data.path.text;
        if (p) paths.add(p);
      }
      const out = new Set();
      for (const p of paths) {
        const abs = toPosix(p);
        if (isSensitivePath(abs, root, rules)) continue; // 敏感文件：与本工具同一口径排除
        out.add(abs);
      }
      resolve(out);
    });
  });
}

/* ----------------------------- 主测试 ----------------------------- */

async function main() {
  makeFixtures();

  /* --- A1 rg 探测 --- */
  const rg = findRgBinary();
  assert('A1 rg 二进制可探测', rg.ok && /rg(\.exe)?$/i.test(rg.path), JSON.stringify(rg));

  /* --- A2 缺 query --- */
  const r_noq = await searchContent({});
  assert('A2 缺 query → invalid_args', r_noq.ok === false && r_noq.error === 'invalid_args', JSON.stringify(r_noq));

  /* --- A3 非法 mode / output / encoding --- */
  const r_m1 = await searchContent({ query: 'x', mode: 'pcre' });
  const r_m2 = await searchContent({ query: 'x', output: 'weird' });
  const r_m3 = await searchContent({ query: 'x', encoding: 'shift-jis' });
  assert('A3 非法 mode/output/encoding → invalid_args',
    r_m1.error === 'invalid_args' && r_m2.error === 'invalid_args' && r_m3.error === 'invalid_args',
    JSON.stringify([r_m1.error, r_m2.error, r_m3.error]));

  /* --- A4 root 不存在 → not_found --- */
  const r_nf = await searchContent({ query: 'x', path: MISSING });
  assert('A4 root 不存在 → not_found', r_nf.ok === false && r_nf.error === 'not_found', JSON.stringify(r_nf));

  /* --- A5 rg 缺失 → dependency_unavailable（不是 0 命中） --- */
  const oldRg = process.env.RG_PATH;
  const oldPath = process.env.PATH;
  process.env.RG_PATH = MISSING_RG;
  // PATH 上也要清掉 rg，才真正走到「都找不到」分支（探测顺序：PATH → RG_PATH）
  process.env.PATH = path.join(FIX, '__empty_path__');
  const r_dep = await searchContent({ query: 'needle', path: FIX });
  if (oldRg === undefined) delete process.env.RG_PATH; else process.env.RG_PATH = oldRg;
  if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
  assert('A5 PATH 无 rg 且 RG_PATH 指向不存在 → dependency_unavailable（≠0 命中）',
    r_dep.ok === false && r_dep.error === 'dependency_unavailable' && !r_dep.totals,
    JSON.stringify(r_dep));

  /* --- A6 files 模式结构：只有 path + matches，无行内容 --- */
  const r_files = await searchContent({ query: 'cordis.patch', path: FIX, output: 'files' });
  const hasLines = r_files.files && r_files.files.some(f => 'lines' in f);
  assert('A6 files 模式：path+命中数、无行内容',
    r_files.ok && Array.isArray(r_files.files) && r_files.files.length > 0 && !hasLines
    && r_files.files.every(f => typeof f.path === 'string' && typeof f.matches === 'number'),
    JSON.stringify(r_files).slice(0, 400));

  /* --- A7 matches 模式结构：行号 + 行内容 --- */
  const r_match = await searchContent({ query: 'needle', path: FIX, output: 'matches' });
  const first = r_match.files && r_match.files[0];
  assert('A7 matches 模式：带行号与行内容',
    r_match.ok && first && Array.isArray(first.lines) && first.lines.length > 0
    && typeof first.lines[0].line === 'number' && typeof first.lines[0].text === 'string',
    JSON.stringify(r_match).slice(0, 400));

  /* --- A8 count 模式：只有 totals --- */
  const r_count = await searchContent({ query: 'cordis.patch', path: FIX, output: 'count' });
  assert('A8 count 模式：只回 totals，无 files',
    r_count.ok && r_count.files === undefined && r_count.totals && r_count.totals.files > 0
    && r_count.totals.matches > 0,
    JSON.stringify(r_count).slice(0, 300));

  /* --- A9 offset 分页：与不 offset 的第 N..N+k 条逐条相同 --- */
  const full = await searchContent({ query: 'needle', path: FIX, output: 'matches', max_results: 100 });
  const flatFull = full.files.flatMap(f => f.lines.map(l => `${f.path}|${l.line}|${l.text}`));
  const page = await searchContent({ query: 'needle', path: FIX, output: 'matches', offset: 2, max_results: 2 });
  const flatPage = page.files.flatMap(f => f.lines.map(l => `${f.path}|${l.line}|${l.text}`));
  assert('A9 offset 分页与整页切片逐条相同',
    flatPage.length === 2 && flatFull.slice(2, 4).join('\n') === flatPage.join('\n'),
    JSON.stringify([flatFull.slice(2, 4), flatPage]));

  /* --- A10 max_results 生效 + truncated/truncatedBy --- */
  const r_cap = await searchContent({ query: 'needle', path: FIX, output: 'files', max_results: 1 });
  assert('A10 max_results 截断且 truncatedBy=max_results',
    r_cap.ok && r_cap.files.length === 1 && r_cap.truncated === true && r_cap.truncatedBy === 'max_results',
    JSON.stringify(r_cap).slice(0, 300));

  /* --- A11 编码：gb18030 能搜到；auto 搜不到且有 hint --- */
  const r_gb = await searchContent({ query: '包管理命令', path: FIX, output: 'files', encoding: 'gb18030' });
  const r_auto = await searchContent({ query: '包管理命令', path: FIX, output: 'files', encoding: 'auto' });
  const gbHit = r_gb.files && r_gb.files.some(f => f.path.endsWith('/gb.txt'));
  assert('A11a encoding=gb18030 能搜到 GB18030 样本', r_gb.ok && gbHit, JSON.stringify(r_gb).slice(0, 300));
  assert('A11b encoding=auto 搜不到且 hint 提示 gb18030',
    r_auto.ok && r_auto.totals.matches === 0 && /gb18030/.test(String(r_auto.hint || '')),
    JSON.stringify(r_auto).slice(0, 300));

  /* --- A12 敏感文件：路径与内容都不出现 --- */
  const r_env = await searchContent({ query: '.env', path: FIX, output: 'matches' });
  const envLeak = (r_env.files || []).some(f => f.path.includes('.env') || (f.lines || []).some(l => /envvalue/.test(l.text)));
  const r_pem = await searchContent({ query: 'pencil', path: FIX, output: 'matches' });
  const pemLeak = (r_pem.files || []).some(f => f.path.includes('.pem') || (f.lines || []).some(l => /PRIVATE KEY/.test(l.text)));
  assert('A12a 敏感文件（.env）路径与内容都不返回，且 skipped.sensitive>0',
    r_env.ok && !envLeak && r_env.skipped.sensitive > 0, JSON.stringify(r_env).slice(0, 400));
  assert('A12b 敏感文件（*.pem）路径与内容都不返回',
    r_pem.ok && !pemLeak && r_pem.skipped.sensitive > 0, JSON.stringify(r_pem).slice(0, 400));

  /* --- A13 max_files=1 → 部分结果 + scan_limit + hint（不是报错） --- */
  const r_budget = await searchContent({ query: 'cordis.patch', path: FIX, output: 'files', max_files: 1 });
  assert('A13 max_files=1 → ok:true + truncated + scan_limit + hint',
    r_budget.ok === true && r_budget.truncated === true && r_budget.truncatedBy === 'scan_limit'
    && typeof r_budget.hint === 'string' && r_budget.hint.length > 0,
    JSON.stringify(r_budget).slice(0, 400));

  /* --- A14 排除清单：默认排除 node_modules；exclude:[] 时能搜到 --- */
  const r_def = await searchContent({ query: 'cordis.patch', path: FIX, output: 'files' });
  const r_noex = await searchContent({ query: 'cordis.patch', path: FIX, output: 'files', exclude: [] });
  const defHit = (r_def.files || []).some(f => f.path.includes('node_modules'));
  const noexHit = (r_noex.files || []).some(f => f.path.includes('node_modules'));
  assert('A14 默认排除 node_modules；exclude:[] 时能搜到',
    r_def.ok && r_noex.ok && !defHit && noexHit,
    JSON.stringify([(r_def.files || []).map(f => f.path), (r_noex.files || []).map(f => f.path)]));

  /* --- A15 max_columns：超长行只回截断标记 --- */
  const r_col = await searchContent({ query: 'needle', path: FIX, output: 'matches', max_columns: 40 });
  const longLine = (r_col.files || []).flatMap(f => f.lines || []).find(l => l.text.includes('truncated'));
  assert('A15 max_columns 超长行截断并标记',
    r_col.ok && !!longLine && longLine.text.length < 120 && r_col.truncated === true && r_col.truncatedBy === 'max_columns',
    JSON.stringify(r_col).slice(0, 400));

  /* --- A16 only_matching：只回匹配片段 --- */
  const r_only = await searchContent({ query: 'needle', path: FIX, output: 'matches', only_matching: true, include: ['long.txt'] });
  const onlyTexts = (r_only.files || []).flatMap(f => f.lines || []).map(l => l.text);
  assert('A16 only_matching 只回匹配片段',
    r_only.ok && onlyTexts.length > 0 && onlyTexts.every(t => t === 'needle'),
    JSON.stringify(onlyTexts).slice(0, 200));

  /* --- A17 multiline：跨行匹配能命中 --- */
  const r_ml = await searchContent({ query: 'foo\nbar', path: FIX, output: 'matches', multiline: true, include: ['multi.txt'] });
  const r_noml = await searchContent({ query: 'foo\nbar', path: FIX, output: 'matches', multiline: false, include: ['multi.txt'] });
  assert('A17 multiline 跨行命中（不开则不命中）',
    r_ml.ok && r_ml.totals.matches > 0 && r_noml.ok && r_noml.totals.matches === 0,
    JSON.stringify([r_ml.totals, r_noml.totals]));

  /* --- A18 case_sensitive=false --- */
  const r_cs = await searchContent({ query: 'needle', path: FIX, output: 'files', case_sensitive: false, include: ['case.txt'] });
  const r_cs1 = await searchContent({ query: 'needle', path: FIX, output: 'files', case_sensitive: true, include: ['case.txt'] });
  assert('A18 case_sensitive=false 命中；默认 true 不命中',
    r_cs.ok && r_cs.totals.files === 1 && r_cs1.ok && r_cs1.totals.files === 0,
    JSON.stringify([r_cs.totals, r_cs1.totals]));

  /* --- A19 结果顺序确定 --- */
  const r1 = await searchContent({ query: 'cordis.patch', path: FIX, output: 'files' });
  const r2 = await searchContent({ query: 'cordis.patch', path: FIX, output: 'files' });
  assert('A19 结果顺序确定（两次运行完全一致）',
    JSON.stringify(r1.files.map(f => f.path)) === JSON.stringify(r2.files.map(f => f.path)),
    JSON.stringify(r1.files.map(f => f.path)));

  /* --- A20..A27 与 rg 原生对拍：4 条真实查询 × 2 个根 --- */
  const queries = [
    { q: 'needle', mode: 'literal' },
    { q: 'search_content', mode: 'literal' },
    { q: 'skip', mode: 'literal' },
    { q: 'skip[a-z]*', mode: 'regex' },
  ];
  // 只对本次运行真实存在的两个根对拍：夹具目录 + 本仓库目录
  const roots = [toPosix(FIX), toPosix(ROOT)];
  for (const root of roots) {
    for (const it of queries) {
      const mine = await searchContent({
        query: it.q, mode: it.mode, path: root, output: 'files',
        max_files: 1000000, max_results: 1000000,
      });
      const theirs = await nativeRgFiles(rg.path, it.q, { root, mode: it.mode });
      const mySet = new Set((mine.files || []).map(f => toPosix(f.path)));
      const missing = [...theirs].filter(p => !mySet.has(p));
      const extra = [...mySet].filter(p => !theirs.has(p));
      assert(`A20 对拍 ${root} «${it.q}»（${it.mode}）逐路径一致`,
        mine.ok && missing.length === 0 && extra.length === 0,
        JSON.stringify({ missing: missing.slice(0, 5), extra: extra.slice(0, 5), mine: mySet.size, theirs: theirs.size }));
    }
  }

  /* --- A29/A30 敏感路径绝不外泄（整个响应序列化检查 + files[] 检查） --- */
  const r_leak = await searchContent({ query: 'needle', path: FIX, output: 'matches', max_results: 500 });
  const leakJson = JSON.stringify(r_leak);
  const forbidden = ['.env', '.pem', '.credentials.yaml', 'envvalue', 'PRIVATE KEY', 'key.pem'];
  const leaked = forbidden.filter(tok => leakJson.includes(tok));
  const sensSamples = (r_leak.skippedSamples || []).filter(s => s.reason === 'sensitive');
  assert('A29 敏感文件的路径/文件名不出现在整个响应里（只允许 skipped.sensitive 计数）',
    r_leak.ok && leaked.length === 0 && typeof r_leak.skipped.sensitive === 'number' && r_leak.skipped.sensitive > 0
    && sensSamples.every(s => !('path' in s) && !('name' in s) && !('file' in s)),
    JSON.stringify({ leaked, skipped: r_leak.skipped, sensSamples }).slice(0, 500));
  assert('A30 files[] 里没有敏感路径（逐条按敏感规则复判）',
    (r_leak.files || []).every(f => !forbidden.some(tok => String(f.path).includes(tok)))
    && (r_leak.files || []).every(f => !isSensitivePath(f.path, FIX, loadSensitiveRules())),
    JSON.stringify((r_leak.files || []).map(f => f.path)).slice(0, 400));

  /* --- A30b 子目录里的敏感文件（.credentials.yaml / *.pem）不外泄 --- */
  const credDir = path.join(FIX, 'creds');
  fs.mkdirSync(credDir, { recursive: true });
  fs.writeFileSync(path.join(credDir, '.credentials.yaml'), 'token: zzzcredvalue\n', { encoding: 'utf8' });
  fs.writeFileSync(path.join(credDir, 'server.pem'), '-----BEGIN CERTIFICATE-----\nzzzcacert\n', { encoding: 'utf8' });
  const r_leak2 = await searchContent({ query: 'zzzcredmarker', path: FIX, output: 'files', max_files: 200 });
  const leakJson2 = JSON.stringify(r_leak2);
  const forbidden2 = ['.credentials.yaml', '.pem', 'zzzcredvalue', 'zzzcacert'];
  const leaked2 = forbidden2.filter(tok => leakJson2.includes(tok));
  assert('A30b 子目录敏感文件（.credentials.yaml / *.pem）路径与内容不外泄',
    r_leak2.ok && leaked2.length === 0 && r_leak2.skipped.sensitive > 0
    && (r_leak2.skippedSamples || []).filter(s => s.reason === 'sensitive').every(s => !('path' in s)),
    JSON.stringify({ leaked2, skipped: r_leak2.skipped, samples: r_leak2.skippedSamples }).slice(0, 500));

  /* --- A31 运行时 dependency_unavailable（子进程 + 不存在的 RG_PATH） --- */
  const depDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-rg-dep-'));
  const depOut = path.join(depDir, 'out.txt');
  const depErr = path.join(depDir, 'err.txt');
  const depIn = path.join(depDir, 'in.jsonl');
  fs.writeFileSync(depIn, JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'search_content', arguments: { query: 'needle', path: FIX } },
  }) + '\n', 'utf8');
  const depInFd = fs.openSync(depIn, 'r');
  const depOutFd = fs.openSync(depOut, 'w');
  const depErrFd = fs.openSync(depErr, 'w');
  const BAD_RG = MISSING_RG;
  let depText = '';
  let depExited = false;
  let depExitCode = null;
  await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'index.mjs')], {
      env: Object.assign({}, process.env, { RG_PATH: BAD_RG, PATH: depDir }),
      windowsHide: true,
      stdio: [depInFd, depOutFd, depErrFd],
    });
    let done = false;
    const finish = () => { if (!done) { done = true; clearInterval(poll); clearTimeout(bail); resolve(); } };
    const poll = setInterval(() => {
      try { depText = fs.readFileSync(depOut, 'utf8'); } catch { /* ignore */ }
      if (depText.includes('dependency_unavailable')) {
        // 响应已落盘：停轮询，等子进程自己因 stdin EOF 自然退出
        clearInterval(poll);
      }
    }, 80);
    const bail = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } finish(); }, 25000);
    child.on('error', () => finish());
    child.on('close', (code) => { depExited = true; depExitCode = code; finish(); });
  });
  try { fs.closeSync(depInFd); } catch { /* ignore */ }
  try { fs.closeSync(depOutFd); } catch { /* ignore */ }
  try { fs.closeSync(depErrFd); } catch { /* ignore */ }
  let depPayload = null;
  try {
    const firstLine = String(depText || '').split('\n').find(l => l.trim().startsWith('{'));
    if (firstLine) {
      const rpc = JSON.parse(firstLine);
      const txt = rpc.result && rpc.result.content && rpc.result.content[0] && rpc.result.content[0].text;
      if (txt) depPayload = JSON.parse(txt);
    }
  } catch { /* ignore */ }
  assert('A31 运行时（子进程 + 不存在的 RG_PATH）→ dependency_unavailable（≠0 命中）',
    !!depPayload && depPayload.ok === false && depPayload.error === 'dependency_unavailable' && !depPayload.totals,
    JSON.stringify(depPayload).slice(0, 400));
  fs.rmSync(depDir, { recursive: true, force: true });
  assert('A31b 子进程已回收（无残留）+ 临时目录已清理',
    depExited && depExitCode !== null && !fs.existsSync(depDir),
    JSON.stringify({ depExited, depExitCode, depDir }));

  /* --- B1 path 指向单个文件 → ok:true，files 只有那一个 --- */
  const oneFile = toPosix(path.join(FIX, 'index.mjs'));
  const r_file = await searchContent({ query: 'needle', path: oneFile, output: 'files' });
  assert('B1 path 指向单个文件 → ok:true 且 files 只有该文件（命中数正确）',
    r_file.ok === true && Array.isArray(r_file.files) && r_file.files.length === 1
    && r_file.files[0].path === oneFile && r_file.files[0].matches >= 1
    && r_file.totals.files === 1 && r_file.totals.matches >= 1,
    JSON.stringify(r_file).slice(0, 400));

  /* --- B1b 单文件 + matches 模式也能拿到行内容 --- */
  const r_file_m = await searchContent({ query: 'needle', path: oneFile, output: 'matches' });
  assert('B1b path 指向单个文件 + output=matches → 有行内容',
    r_file_m.ok === true && r_file_m.files.length === 1 && r_file_m.files[0].lines.length >= 1
    && typeof r_file_m.files[0].lines[0].line === 'number',
    JSON.stringify(r_file_m).slice(0, 400));

  /* --- B2 include:["index.mjs"] 对目录检索 → 命中该文件 --- */
  const r_inc = await searchContent({ query: 'needle', path: FIX, output: 'files', include: ['index.mjs'] });
  const incHit = (r_inc.files || []).filter(f => f.path.endsWith('/index.mjs'));
  assert('B2 include:["index.mjs"] 对目录检索 → 命中该文件（count ≥ 1）',
    r_inc.ok === true && incHit.length >= 1 && incHit.some(f => f.matches >= 1)
    && (r_inc.files || []).every(f => f.path.endsWith('/index.mjs')),
    JSON.stringify((r_inc.files || []).map(f => [f.path, f.matches])).slice(0, 400));

  /* --- B2b 真实目录（本仓库）+ include:["index.mjs"] --- */
  const repoIndex = toPosix(path.join(ROOT, 'index.mjs'));
  const r_inc_real = await searchContent({ query: 'function', path: toPosix(ROOT), output: 'files', include: ['index.mjs'] });
  assert('B2b 真实目录 + include:["index.mjs"] → 命中仓库根 index.mjs',
    r_inc_real.ok === true && (r_inc_real.files || []).some(f => f.path === repoIndex),
    JSON.stringify((r_inc_real.files || []).map(f => [f.path, f.matches])).slice(0, 400));

  /* --- B3 include:["*.mjs"] 回归（含子目录同名文件） --- */
  const r_star = await searchContent({ query: 'needle', path: FIX, output: 'files', include: ['*.mjs'] });
  const starPaths = (r_star.files || []).map(f => f.path);
  assert('B3 include:["*.mjs"] 仍正常（命中 index.mjs 与 deep/deep.mjs，不含 .txt）',
    r_star.ok === true && starPaths.some(p => p.endsWith('/index.mjs'))
    && starPaths.some(p => p.endsWith('/deep/deep.mjs'))
    && !starPaths.some(p => p.endsWith('.txt')),
    JSON.stringify(starPaths).slice(0, 400));

  /* --- B3b include 递归通配（双星号 + 斜杠 + .mjs）回归 --- */
  const r_glob2 = await searchContent({ query: 'needle', path: FIX, output: 'files', include: ['**/*.mjs'] });
  const g2 = (r_glob2.files || []).map(f => f.path);
  assert('B3b include:["**/*.mjs"] 仍正常',
    r_glob2.ok === true && g2.some(p => p.endsWith('/index.mjs')) && g2.some(p => p.endsWith('/deep/deep.mjs')),
    JSON.stringify(g2).slice(0, 400));

  /* --- B4 path 不存在 → 仍为 not_found --- */
  const r_nf2 = await searchContent({ query: 'needle', path: toPosix(path.join(FIX, '__no_such_file__.mjs')) });
  const r_nf3 = await searchContent({ query: 'needle', path: MISSING });
  assert('B4 path 不存在（文件/目录两种写法）→ 仍为 not_found',
    r_nf2.ok === false && r_nf2.error === 'not_found' && r_nf3.ok === false && r_nf3.error === 'not_found',
    JSON.stringify([r_nf2, r_nf3]).slice(0, 400));

  /* --- B5 单文件 + 不匹配的 include → ok:true，0 命中（不是报错） --- */
  const r_file_inc = await searchContent({ query: 'needle', path: oneFile, output: 'files', include: ['*.md'] });
  assert('B5 单文件 + 不匹配的 include → ok:true 且 0 命中',
    r_file_inc.ok === true && r_file_inc.totals.files === 0,
    JSON.stringify(r_file_inc).slice(0, 300));

  /* --- C1 include 双星号模式（** 加 .mjs）必须命中根层 .mjs（不再静默丢弃根层文件） --- */
  const r_c1 = await searchContent({ query: 'needle', path: FIX, output: 'files', include: ['**/*.mjs'] });
  const c1paths = (r_c1.files || []).map(f => f.path);
  assert('C1 include:["**/*.mjs"] 命中根层 .mjs 文件（rootlevel.mjs）',
    r_c1.ok === true && c1paths.some(p => p.endsWith('/rootlevel.mjs'))
    && c1paths.some(p => p.endsWith('/deep/deep.mjs')),
    JSON.stringify(c1paths).slice(0, 400));

  /* --- C2 include 的单星号不跨斜杠（src 下的模式不命中 src/nested/two.mjs） --- */
  const r_c2 = await searchContent({ query: 'needle', path: FIX, output: 'files', include: ['src/*.mjs'] });
  const c2paths = (r_c2.files || []).map(f => f.path);
  assert('C2 include:["src/*.mjs"] → * 不跨 /（命中 src/one.mjs，不命中 src/nested/two.mjs）',
    r_c2.ok === true && c2paths.some(p => p.endsWith('/src/one.mjs'))
    && !c2paths.some(p => p.endsWith('/src/nested/two.mjs')),
    JSON.stringify(c2paths).slice(0, 400));

  /* --- C3 分块分支（max_files=1）与正常分支（max_files=100）的 include 结果集一致 --- */
  const budgetRoot = path.join(FIX, 'budget');
  const r_c3a = await searchContent({ query: 'needle', path: budgetRoot, output: 'files', include: ['src/*.mjs'], max_files: 100 });
  const r_c3b = await searchContent({ query: 'needle', path: budgetRoot, output: 'files', include: ['src/*.mjs'], max_files: 1 });
  const c3a = (r_c3a.files || []).map(f => f.path).sort();
  const c3b = (r_c3b.files || []).map(f => f.path).sort();
  assert('C3 分块分支与正常分支 include 结果集一致（max_files=1 vs 100）',
    r_c3a.ok === true && r_c3b.ok === true
    && r_c3b.truncated === true && r_c3b.truncatedBy === 'scan_limit'
    && c3a.length === c3b.length && c3a.join('|') === c3b.join('|')
    && !c3b.some(p => p.includes('a_deep')),
    JSON.stringify({ c3a, c3b, trunc: r_c3b.truncatedBy }).slice(0, 400));

  /* --- C4 max_matches_per_file 截断：不再静默丢弃 --- */
  const r_c4 = await searchContent({ query: 'needle', path: FIX, output: 'matches', include: ['page.txt'], max_matches_per_file: 1 });
  const c4f = (r_c4.files || [])[0];
  assert('C4 max_matches_per_file 截断 → truncated + truncatedBy=max_matches_per_file + lineTruncated + hint',
    r_c4.ok === true && r_c4.truncated === true && r_c4.truncatedBy === 'max_matches_per_file'
    && !!c4f && c4f.lineTruncated === true && c4f.lines.length === 1
    && /max_matches_per_file/.test(String(r_c4.hint || '')),
    JSON.stringify(r_c4).slice(0, 400));

  /* --- C5 only_matching=true 真正忽略 context_lines（不返回任何上下文行） --- */
  const r_c5 = await searchContent({ query: 'needle', path: FIX, output: 'matches', include: ['page.txt'], only_matching: true, context_lines: 2 });
  const c5lines = (r_c5.files || []).flatMap(f => f.lines || []);
  assert('C5 only_matching + context_lines → 无上下文行（onlyMatchingApplied=true，文本全是匹配片段）',
    r_c5.ok === true && r_c5.onlyMatchingApplied === true && c5lines.length > 0
    && c5lines.every(l => l.context === undefined && l.text === 'needle'),
    JSON.stringify(c5lines).slice(0, 300));

  /* --- C6 上下文行截断：不再静默丢弃 --- */
  const r_c6 = await searchContent({ query: 'needle', path: FIX, output: 'matches', include: ['ctx.txt'], context_lines: 20, max_context: 5 });
  assert('C6 上下文行截断 → truncated + truncatedBy=max_context + hint',
    r_c6.ok === true && r_c6.truncated === true && r_c6.truncatedBy === 'max_context'
    && /max_context/.test(String(r_c6.hint || '')),
    JSON.stringify(r_c6).slice(0, 400));

  /* --- C7 单文件：count 模式 totals 正确 + files 模式路径正确（chunkPaths 回填分支） --- */
  const r_c7a = await searchContent({ query: 'needle', path: oneFile, output: 'count' });
  const r_c7b = await searchContent({ query: 'needle', path: oneFile, output: 'files' });
  assert('C7 单文件 + count 模式 totals.matches 正确；files 模式 files[0].path 正确（chunkPaths 回填）',
    r_c7a.ok === true && r_c7a.totals.files === 1 && r_c7a.totals.matches === 1
    && r_c7b.ok === true && r_c7b.files.length === 1 && r_c7b.files[0].path === oneFile
    && r_c7b.files[0].matches === 1,
    JSON.stringify([r_c7a.totals, (r_c7b.files || []).map(f => [f.path, f.matches])]).slice(0, 400));

  /* --- D1 枚举阶段局部不可读（rg exit 2 + os error 5）→ 降级为部分结果，不整条归零 --- */
  const ACL_DIR = toPosix(path.join(FIX, 'node_modules'));
  const keepLines = [toPosix(path.join(FIX, 'note.txt')), toPosix(path.join(FIX, 'page.txt'))];
  const okCountLines = [keepLines[0] + ':1', keepLines[1] + ':3'];
  __setRunRgStub(async (rgPath, args, o) => {
    const onLine = o && o.onLine;
    if (args.includes('--files')) {
      return { code: 2, stderr: `rg: ${ACL_DIR}: 拒绝访问。 (os error 5)\n`, stdout: keepLines.join('\n'), lines: keepLines, killed: false, spawnError: false };
    }
    for (const l of okCountLines) if (onLine) onLine(l);
    return { code: 0, stderr: '', stdout: okCountLines.join('\n'), lines: okCountLines, killed: false, spawnError: false };
  });
  const r_ur = await searchContent({ query: 'cordis.patch', path: FIX, output: 'files', max_results: 10 });
  const urSamples = (r_ur.skippedSamples || []).filter(s => s.reason === 'unreadable');
  assert('D1 枚举 exit 2 + os error → ok:true，unreadable>0，样本带不可读路径，hint 可执行',
    r_ur.ok === true && r_ur.skipped.unreadable > 0 && urSamples.length > 0
    && urSamples.some(s => s.path === ACL_DIR)
    && typeof r_ur.hint === 'string' && /不可读/.test(r_ur.hint) && /exclude/.test(r_ur.hint)
    && r_ur.totals.files >= 1,
    JSON.stringify(r_ur).slice(0, 600));

  /* --- D2 敏感路径的 unreadable 样本不得带 path --- */
  __setRunRgStub(async (rgPath, args) => {
    if (args.includes('--files')) {
      return { code: 2, stderr: `rg: ${toPosix(path.join(FIX, '.env'))}: 拒绝访问。 (os error 5)\n`, stdout: '', lines: [], killed: false, spawnError: false };
    }
    return { code: 0, stderr: '', stdout: '', lines: [], killed: false, spawnError: false };
  });
  const r_ur_sens = await searchContent({ query: 'needle', path: FIX, output: 'files' });
  const sensUr = (r_ur_sens.skippedSamples || []).filter(s => s.reason === 'unreadable');
  assert('D2 敏感路径的 unreadable 样本不带 path（且响应全文不出现 .env）',
    r_ur_sens.ok === true && sensUr.length > 0 && sensUr.every(s => !('path' in s) && !('name' in s) && !('file' in s))
    && !JSON.stringify(r_ur_sens).includes('.env'),
    JSON.stringify({ sensUr, skipped: r_ur_sens.skipped }).slice(0, 400));

  /* --- D3 excludesApplied：默认 / 显式 / 空数组 三个分支 --- */
  __setRunRgStub(null);
  const r_ex_def = await searchContent({ query: 'cordis.patch', path: FIX, output: 'files' });
  const r_ex_my = await searchContent({ query: 'cordis.patch', path: FIX, output: 'files', exclude: ['**/budget/**'] });
  const r_ex_none = await searchContent({ query: 'cordis.patch', path: FIX, output: 'files', exclude: [] });
  assert('D3 excludesApplied：省略=默认清单、显式=传入值、exclude:[]→[]',
    Array.isArray(r_ex_def.excludesApplied) && r_ex_def.excludesApplied.join('|') === DEFAULT_EXCLUDES.join('|')
    && JSON.stringify(r_ex_my.excludesApplied) === JSON.stringify(['**/budget/**'])
    && Array.isArray(r_ex_none.excludesApplied) && r_ex_none.excludesApplied.length === 0,
    JSON.stringify([r_ex_def.excludesApplied, r_ex_my.excludesApplied, r_ex_none.excludesApplied]).slice(0, 500));

  /* --- D4 exit 2 但 stderr 无 os error → 仍 io_error（不被误降级），且错误体也带 excludesApplied --- */
  __setRunRgStub(async () => ({ code: 2, stderr: 'rg: regex parse error: unclosed group\n', stdout: '', lines: [], killed: false, spawnError: false }));
  const r_e2 = await searchContent({ query: 'x', path: FIX, output: 'files' });
  __setRunRgStub(null);
  assert('D4 exit 2 无 os error → 仍 io_error，错误体带 excludesApplied',
    r_e2.ok === false && r_e2.error === 'io_error'
    && Array.isArray(r_e2.excludesApplied) && r_e2.excludesApplied.length === DEFAULT_EXCLUDES.length,
    JSON.stringify(r_e2).slice(0, 400));

  /* --- F1/F2 返回体顶层字段白名单（新增字段未登记 → FAIL） --- */
  const r_f1 = await searchContent({ query: 'needle', path: FIX, output: 'files' });
  const unknownF1 = Object.keys(r_f1).filter(k => !KNOWN_RESULT_FIELDS.has(k));
  assert('F1 成功响应顶层字段 ⊆ KNOWN_RESULT_FIELDS',
    r_f1.ok === true && unknownF1.length === 0,
    unknownF1.map(n => `新增字段 ${n} 未在 KNOWN_RESULT_FIELDS 登记`).join('；') || JSON.stringify(Object.keys(r_f1)));
  const r_f2 = await searchContent({ query: 'x', path: MISSING });
  const unknownF2 = Object.keys(r_f2).filter(k => !KNOWN_RESULT_FIELDS.has(k));
  assert('F2 错误响应（not_found）顶层字段 ⊆ KNOWN_RESULT_FIELDS',
    r_f2.ok === false && r_f2.error === 'not_found' && unknownF2.length === 0,
    unknownF2.map(n => `新增字段 ${n} 未在 KNOWN_RESULT_FIELDS 登记`).join('；') || JSON.stringify(Object.keys(r_f2)));

  /* --- T1–T6 tail（每文件只保留最后 N 条命中；夹具现场创建） --- */
  const tailFile = path.join(FIX, 'tail.log');
  const tailBody = [];
  for (let i = 1; i <= 6; i++) tailBody.push('tailneedle line ' + i);
  fs.writeFileSync(tailFile, tailBody.join('\n') + '\n', { encoding: 'utf8' });
  const tailLinesOf = (r) => (r.files && r.files[0] && Array.isArray(r.files[0].lines) ? r.files[0].lines : []);

  const rT1 = await searchContent({ query: 'tailneedle', path: FIX, output: 'matches', tail: 3 });
  const t1 = tailLinesOf(rT1);
  assert('T1 tail=3 → 只回最后 3 条命中，且行号升序',
    rT1.ok === true && t1.length === 3 && t1.map(l => l.line).join(',') === '4,5,6',
    JSON.stringify(t1));

  assert('T2a tail=3 时 tailApplied === 3', rT1.tailApplied === 3, 'tailApplied=' + JSON.stringify(rT1.tailApplied));
  const rT2 = await searchContent({ query: 'tailneedle', path: FIX, output: 'matches' });
  assert('T2b 不传 tail → 返回体无 tailApplied 字段（且 6 条命中全回）',
    Object.prototype.hasOwnProperty.call(rT2, 'tailApplied') === false && tailLinesOf(rT2).length === 6,
    'keys=' + JSON.stringify(Object.keys(rT2)));

  const rT3 = await searchContent({ query: 'tailneedle', path: FIX, output: 'matches', tail: 2, max_matches_per_file: 1 });
  const t3 = tailLinesOf(rT3);
  assert('T3 tail 与 max_matches_per_file 同传 → tail 优先（max=1 仍回 2 条且 tailApplied=2）',
    rT3.ok === true && t3.length === 2 && t3.map(l => l.line).join(',') === '5,6' && rT3.tailApplied === 2,
    JSON.stringify(t3) + ' tailApplied=' + JSON.stringify(rT3.tailApplied));

  const rT4 = await searchContent({ query: 'tailneedle', path: FIX, output: 'files', tail: 3 });
  assert('T4 output=files + tail → ok:false + invalid_args（不静默忽略）',
    rT4.ok === false && rT4.error === 'invalid_args' && /tail/.test(String(rT4.reason)),
    JSON.stringify(rT4).slice(0, 300));

  for (const bad of [0, -1, 1.5, 'abc']) {
    const rBadTail = await searchContent({ query: 'tailneedle', path: FIX, output: 'matches', tail: bad });
    assert('T5 tail=' + JSON.stringify(bad) + ' → invalid_args',
      rBadTail.ok === false && rBadTail.error === 'invalid_args' && /tail/.test(String(rBadTail.reason)),
      JSON.stringify(rBadTail).slice(0, 300));
  }

  const rT6 = await searchContent({ query: 'tailneedle', path: FIX, output: 'matches', tail: 999 });
  const t6 = tailLinesOf(rT6);
  assert('T6 tail(999) > 命中总数(6) → 回全部 6 条，tailApplied=6（取 min(tail, 命中数)）',
    t6.length === 6 && rT6.tailApplied === 6 && rT6.truncated === false,
    JSON.stringify({ n: t6.length, tailApplied: rT6.tailApplied, truncated: rT6.truncated }));

  /* --- M1–M3 正则元字符提示（literal 模式 0 命中时；空文件夹具保证 0 命中） --- */
  const metaDir = path.join(FIX, 'metahint');
  fs.mkdirSync(metaDir, { recursive: true });
  fs.writeFileSync(path.join(metaDir, 'empty.txt'), '', { encoding: 'utf8' });
  const META_HINT_RE = /mode='regex'/;
  const ENC_HINT_RE = /encoding='gb18030'/;

  const rM1 = await searchContent({ query: 'zzzmeta_aaa|zzzmeta_bbb', path: metaDir, mode: 'literal', output: 'files' });
  assert('M1 literal + query 含 | + 0 命中 → hint 含 mode=\'regex\'',
    rM1.ok === true && rM1.totals.matches === 0 && META_HINT_RE.test(String(rM1.hint)),
    JSON.stringify(rM1).slice(0, 400));

  const rM2 = await searchContent({ query: 'zzzmeta_aaa|zzzmeta_bbb', path: metaDir, mode: 'regex', output: 'files' });
  assert('M2 regex 模式 + 同样 query + 0 命中 → 不出现该 hint',
    rM2.ok === true && rM2.totals.matches === 0 && !META_HINT_RE.test(String(rM2.hint)),
    JSON.stringify(rM2).slice(0, 400));

  const rM3 = await searchContent({ query: 'zzzmeta_plain', path: metaDir, mode: 'literal', output: 'files' });
  assert('M3 literal + query 无元字符 + 0 命中 → 无该 hint，但 encoding=' + "auto" + ' 的 hint 仍在',
    rM3.ok === true && rM3.totals.matches === 0
    && !META_HINT_RE.test(String(rM3.hint)) && ENC_HINT_RE.test(String(rM3.hint)),
    JSON.stringify(rM3).slice(0, 400));
  fs.rmSync(metaDir, { recursive: true, force: true });

  /* --- A28 临时样本已清理 --- */
  fs.rmSync(FIX, { recursive: true, force: true });
  assert('A28 临时样本目录已清理', !fs.existsSync(FIX), FIX);

  const pass = results.filter(r => r.ok).length;
  const fail = results.length - pass;
  process.stdout.write(`\n断言总数 ${results.length} · 通过 ${pass} · 失败 ${fail}\n`);
  if (fail) {
    process.stdout.write('失败项：\n');
    for (const r of results.filter(x => !x.ok)) process.stdout.write(`  - ${r.name}: ${r.detail}\n`);
  }
  process.exit(fail ? 1 : 0);
}

main().catch(e => {
  process.stderr.write(`selftest 崩溃：${(e && e.stack) || e}\n`);
  try { fs.rmSync(FIX, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(2);
});
