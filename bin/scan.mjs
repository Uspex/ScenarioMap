#!/usr/bin/env node
/* Сверка сценарных карт с источником — кодом на любом языке или документацией.

   Шаг привязан к источнику тремя полями:
     file        — путь:строка относительно codeRoot (пишет человек или агент: место, где принимается решение
                   или где это правило записано в документации);
     anchor      — путь::символ (функция / метод / раздел документа), переживает сдвиг строк; ставит --anchors;
     fingerprint — sha1 тела символа без комментариев и пробелов (12 знаков); ставит --anchors.

   node bin/scan.mjs --project=examples/shop               отчёт о расхождениях (exit 2, если есть)
   node bin/scan.mjs --project=… --flow=checkout            только один флоу
   node bin/scan.mjs --project=… --anchors                  записать / обновить anchor + fingerprint
   node bin/scan.mjs --project=… --json                     машиночитаемый отчёт
   node bin/scan.mjs --project=… --outline[=<подкаталог>]   оглавление документации под codeRoot: разделы с
                                                            file и anchor — опись для карты по документации

   Подписи (title / what / short / hint) скрипт НИКОГДА не трогает — только сообщает, что источник изменился.

   Код: символ ищется эвристикой по объявлениям: function / func / fn / fun / def / sub, методы классов JS/TS,
   const x = (…) =>, методы Java / C# / Kotlin с модификаторами. Границы тела — по фигурным скобкам,
   для Python — по отступам, для Ruby — до парного end. Этого хватает для сверки «метод правили / метод исчез»;
   точный разбор AST не нужен.
   Документация (.md .markdown .mdx .rst .adoc .txt): символ — раздел, имя — текст заголовка, тело — от
   заголовка до следующего заголовка того же или более высокого уровня. Правка текста раздела = «раздел изменился». */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadProject, listFlows, parseArgs } from '../engine/config.mjs';

const { opts } = parseArgs(process.argv.slice(2));
let P;
try { P = loadProject(opts.project); } catch (e) { console.error(e.message); process.exit(1); }

const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'else', 'do', 'try', 'with', 'new', 'typeof', 'await', 'yield', 'foreach', 'elseif', 'using', 'lock', 'synchronized', 'match', 'when', 'sizeof', 'constructor']);
const DECLS = [
  /* function name( · func (r *T) Name( · fn name( · fun name( · def name · sub name — PHP, JS, Go, Rust, Kotlin, Python, Ruby, Perl */
  /\b(?:function|func|fn|fun|def|sub)\s+(?:\([^)]*\)\s*)?\*?\s*(?:self\.)?([A-Za-z_$][\w$]*[?!]?)/,
  /* const name = async (…) => · export const name = x => */
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/,
  /* name: async function (…) / name: (…) => — методы в объектах */
  /^\s*([A-Za-z_$][\w$]*)\s*:\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>)/,
  /* Java / C# / TS с модификаторами: public async Task<Order> Place(…) { */
  /^\s*(?:(?:public|private|protected|internal|static|final|override|virtual|abstract|async|sealed|readonly|export)\s+)+(?:[\w<>[\],.?]+\s+)*?([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/,
  /* метод класса JS/TS без модификаторов: async placeOrder(req, res) { */
  /^\s*(?:async\s+)?(?:get\s+|set\s+|static\s+)?\*?([A-Za-z_$][\w$]*)\s*\([^;]*\)\s*(?::\s*[^={;]+)?\{\s*$/,
];

function symbolAt(line) {
  for (const re of DECLS) {
    const m = re.exec(line);
    if (m && !KEYWORDS.has(m[1])) return m[1];
  }
  return null;
}

/* Убрать строки и комментарии, чтобы скобки внутри них не ломали подсчёт. Возвращает текст той же длины. */
function maskCode(src, ext) {
  const hashComments = ['.py', '.rb', '.sh', '.pl', '.php', '.yml', '.yaml', '.r'].includes(ext);
  let out = ''; let i = 0; const n = src.length;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') { out += ' '; i++; } continue; }
    if (c === '/' && d === '*') { out += '  '; i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i++; } out += '  '; i += 2; continue; }
    if (c === '#' && hashComments && !(ext === '.php' && d === '[')) { while (i < n && src[i] !== '\n') { out += ' '; i++; } continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; out += q; i++;
      while (i < n && src[i] !== q) { if (src[i] === '\\') { out += ' '; i++; } out += src[i] === '\n' ? '\n' : ' '; i++; }
      out += q; i++; continue;
    }
    out += c; i++;
  }
  return out;
}

const DOC_EXTS = ['.md', '.markdown', '.mdx', '.rst', '.adoc', '.asciidoc', '.txt'];
const sha = (text) => crypto.createHash('sha1').update(text.replace(/\s+/g, '')).digest('hex').slice(0, 12);

/* Заголовки документа: [{ level, name, line }] (строки с 1). Markdown — # и подчёркивание ===/---,
   AsciiDoc — = / ==, reStructuredText — строка, подчёркнутая повтором одного знака. Блоки кода пропускаются. */
function docHeadings(lines, ext) {
  const adoc = ext === '.adoc' || ext === '.asciidoc', rst = ext === '.rst';
  const fenceRe = adoc ? /^(-{4,}|\.{4,}|={4,})\s*$/ : rst ? null : /^\s*(`{3,}|~{3,})/;
  const clean = (s) => s.replace(/\s+#+\s*$/, '').replace(/`([^`]*)`/g, '$1').replace(/(\*\*|__)(.+?)\1/g, '$2').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim();
  const out = []; const rstLevels = []; let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i], u = lines[i + 1] ?? '';
    const f = fenceRe && fenceRe.exec(l);
    if (f) { const mark = f[1][0]; if (!fence) fence = mark; else if (fence === mark) fence = null; continue; }
    if (fence) continue;
    let m;
    if (adoc) {
      if ((m = /^(={1,6})\s+(\S.*)$/.exec(l))) out.push({ level: m[1].length, name: clean(m[2]), line: i + 1 });
    } else if (rst) {
      if (l.trim() && /^([=\-~^"'`#*+:.])\1{2,}\s*$/.test(u) && u.trim().length >= l.trim().length) {
        const ch = u.trim()[0]; if (!rstLevels.includes(ch)) rstLevels.push(ch);
        out.push({ level: rstLevels.indexOf(ch) + 1, name: clean(l), line: i + 1 }); i++;
      }
    } else if ((m = /^(#{1,6})\s+(\S.*)$/.exec(l))) {
      out.push({ level: m[1].length, name: clean(m[2]), line: i + 1 });
    } else if (l.trim() && !/^\s*[-*>|]/.test(l) && /^(={3,}|-{3,})\s*$/.test(u)) {
      out.push({ level: u.trim()[0] === '=' ? 1 : 2, name: clean(l), line: i + 1 }); i++;
    }
  }
  return out.filter((h) => h.name);
}

/* Разделы документа как символы: тело — до следующего заголовка того же или более высокого уровня.
   Текст до первого заголовка — раздел с именем файла. */
function parseDocSections(lines, ext, file) {
  const hs = docHeadings(lines, ext);
  const out = [];
  const push = (name, level, from, to) => {
    const body = lines.slice(from - 1, to).join('\n');
    out.push({ name, level, line: from, lineEnd: to, body, masked: body, fingerprint: sha(body), doc: true });
  };
  const firstLine = hs.length ? hs[0].line : lines.length + 1;
  if (firstLine > 1 && lines.slice(0, firstLine - 1).some((l) => l.trim())) push(path.basename(file), 0, 1, firstLine - 1);
  hs.forEach((h, k) => {
    const next = hs.slice(k + 1).find((x) => x.level <= h.level);
    push(h.name, h.level, h.line, next ? next.line - 1 : lines.length);
  });
  return out;
}

/* Символы файла: [{ name, line, lineEnd, body }] (строки с 1). */
function parseSymbols(abs) {
  const src = fs.readFileSync(abs, 'utf8').replace(/\r\n?/g, '\n');
  const ext = path.extname(abs).toLowerCase();
  if (DOC_EXTS.includes(ext)) return parseDocSections(src.split('\n'), ext, abs);
  const lines = src.split('\n');
  const masked = maskCode(src, ext).split('\n');
  const indent = (s) => s.match(/^\s*/)[0].replace(/\t/g, '    ').length;
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const name = symbolAt(masked[i]);
    if (!name) continue;
    let end = i;
    if (ext === '.py') {
      const base = indent(lines[i]);
      let j = i + 1;
      while (j < lines.length && !/:\s*(#.*)?$/.test(masked[j - 1]) && j - i < 10) j++;   /* многострочная сигнатура */
      for (; j < lines.length; j++) { if (lines[j].trim() === '') continue; if (indent(lines[j]) <= base) break; end = j; }
    } else if (ext === '.rb') {
      const base = indent(lines[i]);
      for (let j = i + 1; j < lines.length; j++) { if (/^\s*end\b/.test(masked[j]) && indent(lines[j]) === base) { end = j; break; } end = j; }
    } else {
      /* тело ищем после списка параметров: в них бывают фигурные скобки — function f({ id }) */
      let depth = 0, started = false, paren = 0, afterParams = false;
      const col = Math.max(0, masked[i].indexOf(name));
      scan: for (let j = i; j < lines.length && (started || j - i < 8); j++) {
        const text = j === i ? masked[j].slice(col) : masked[j];
        for (const ch of text) {
          if (!afterParams && !started) {
            if (ch === '(') { paren++; continue; }
            if (ch === ')') { paren--; if (paren === 0) afterParams = true; continue; }
            if (paren > 0) continue;
          }
          if (!started && ch === ';') break scan;               /* объявление без тела: интерфейс, абстрактный метод */
          if (ch === '{') { depth++; started = true; }
          else if (ch === '}' && started) { depth--; if (depth === 0) { end = j; break scan; } }
        }
      }
      if (!started) {
        /* однострочная стрелочная функция без скобок: const f = x => x + 1; */
        if (!/=>/.test(masked[i])) continue;
      }
    }
    const bodyMasked = masked.slice(i, end + 1).join('\n');
    /* отпечаток: код без комментариев, литералы строк сохраняем (их смена — тоже смена логики) */
    const bodyNoComments = stripComments(lines.slice(i, end + 1).join('\n'), ext);
    out.push({ name, line: i + 1, lineEnd: end + 1, body: lines.slice(i, end + 1).join('\n'), masked: bodyMasked,
      fingerprint: sha(bodyNoComments) });
  }
  return out;
}

function stripComments(src, ext) {
  const masked = maskCode(src, ext);
  /* символы, которые маска заменила пробелами вне кавычек, — комментарии; строки восстанавливаем из исходника */
  let out = ''; let inStr = null;
  for (let i = 0; i < src.length; i++) {
    const m = masked[i], c = src[i];
    if (inStr) { out += c; if (m === inStr) inStr = null; continue; }
    if (m === '"' || m === "'" || m === '`') { inStr = m; out += c; continue; }
    out += m === ' ' && c !== ' ' ? ' ' : c;
  }
  return out;
}

/* Самый внутренний символ, в тело которого попадает строка. */
function symbolAtLine(symbols, line) {
  let best = null;
  for (const s of symbols) if (s.line <= line && line <= s.lineEnd && (!best || s.line >= best.line)) best = s;
  return best;
}

const cache = new Map();
const symbolsOf = (rel) => {
  if (!cache.has(rel)) {
    const abs = path.join(P.codeRoot, rel);
    cache.set(rel, fs.existsSync(abs) && fs.statSync(abs).isFile() ? parseSymbols(abs) : null);
  }
  return cache.get(rel);
};

/* file: «путь:строка» — путь может быть на любом языке, но без пробелов и двоеточий */
const FILE_RE = /^([^\s:]+\.[\p{L}\p{N}]+):(\d+)/u;
/* anchor: «путь::символ»; у раздела документа в имени могут быть свои «::», поэтому режем по первому */
const symbolOfAnchor = (a) => { const s = String(a); const i = s.indexOf('::'); return i < 0 ? s : s.slice(i + 2); };

/* ---- --outline: оглавление документации — опись для карты по документации ---- */
if (opts.outline) {
  const SKIP = new Set(['node_modules', '.git', '.idea', '.vscode', 'vendor', 'dist', 'build', 'coverage', '.next', 'target']);
  const base = path.resolve(P.codeRoot, typeof opts.outline === 'string' ? opts.outline : '.');
  const outAbs = path.resolve(P.outDir);
  const docs = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP.has(e.name) && !e.name.startsWith('.') && abs !== outAbs) walk(abs); continue; }
      if (DOC_EXTS.includes(path.extname(e.name).toLowerCase())) docs.push(abs);
    }
  };
  if (!fs.existsSync(base)) { console.error(`нет каталога ${base}`); process.exit(1); }
  fs.statSync(base).isDirectory() ? walk(base) : docs.push(base);
  const outline = docs.map((abs) => {
    const rel = path.relative(P.codeRoot, abs).replace(/\\/g, '/');
    const sections = parseSymbols(abs).map((s) => ({ level: s.level, name: s.name, file: `${rel}:${s.line}`, anchor: `${rel}::${s.name}`, lines: s.lineEnd - s.line + 1 }));
    return { file: rel, sections };
  });
  if (opts.json) { console.log(JSON.stringify(outline, null, 2)); process.exit(0); }
  const total = outline.reduce((a, d) => a + d.sections.length, 0);
  console.log(`Документация под ${path.relative(process.cwd(), base) || '.'}: ${outline.length} файлов, ${total} разделов\n`);
  for (const d of outline) {
    console.log(d.file);
    for (const s of d.sections) console.log(`  ${'  '.repeat(Math.max(0, s.level - 1))}${s.name}  ·  ${s.file} (${s.lines} стр.)`);
  }
  console.log('\nfile шага — «путь:строка» из списка; anchor и fingerprint поставит --anchors.');
  process.exit(0);
}

const codeRes = (P.scan.outcomeCodePatterns || []).map((r) => new RegExp(r, 'g'));
const report = { ok: 0, changed: [], missing: [], moved: [], skipped: [], codes: [], custom: 0 };
const hasCustom = (o) => Object.entries(o || {}).some(([k, v]) => k.startsWith('custom_') && v !== null && v !== '' && !(Array.isArray(v) && !v.length));
const touched = [];

for (const flowId of listFlows(P)) {
  if (opts.flow && opts.flow !== flowId) continue;
  const file = path.join(P.flowsDir, `${flowId}.json`);
  const flow = JSON.parse(fs.readFileSync(file, 'utf8'));
  let dirty = false;
  const terminalTitles = Object.values(flow.steps || {}).filter((s) => s.kind === 'terminal').map((s) => String(s.custom_title || s.title || ''));
  const codesSeen = new Set();

  for (const [id, step] of Object.entries(flow.steps || {})) {
    const tag = `${flowId} · ${id}`;
    if (hasCustom(step)) report.custom++;
    (step.branches || []).forEach((b) => { if (hasCustom(b)) report.custom++; });

    const m = FILE_RE.exec(String(step.file || ''));
    if (!m) { report.skipped.push({ step: tag, why: step.file ? 'file не вида путь:строка' : 'нет file', file: step.file || '' }); continue; }
    const [, rel, lineStr] = m; const line = Number(lineStr);
    const symbols = symbolsOf(rel);
    if (!symbols) { report.missing.push({ step: tag, why: 'файла нет', file: rel }); continue; }

    const anchorName = step.anchor ? symbolOfAnchor(step.anchor) : null;
    const byName = anchorName ? symbols.filter((s) => s.name === anchorName) : [];
    const sym = byName.length ? (byName.find((s) => s.line <= line && line <= s.lineEnd) || byName[0]) : symbolAtLine(symbols, line);
    if (!sym) {
      if (anchorName && !opts.anchors) report.missing.push({ step: tag, why: `символ ${anchorName} исчез из файла`, file: rel });
      else report.missing.push({ step: tag, why: 'строка не внутри функции, метода или раздела', file: `${rel}:${line}` });
      continue;
    }
    const anchor = `${rel}::${sym.name}`;

    if (opts.anchors) {
      if (step.anchor !== anchor || step.fingerprint !== sym.fingerprint) {
        /* перепривязка к символу по строке: если строка ушла в другой символ, берём его */
        const atLine = symbolAtLine(symbols, line) || sym;
        flow.steps[id].anchor = `${rel}::${atLine.name}`;
        flow.steps[id].fingerprint = atLine.fingerprint;
        dirty = true;
      }
    } else {
      if (anchorName && anchorName !== sym.name) { report.missing.push({ step: tag, why: `символ ${anchorName} исчез из файла`, file: rel }); continue; }
      if (step.fingerprint && step.fingerprint !== sym.fingerprint) { report.changed.push({ step: tag, anchor, doc: !!sym.doc, file: `${rel}:${sym.line}`, title: step.custom_title || step.title || '' }); continue; }
      if (!step.anchor) { report.skipped.push({ step: tag, why: 'нет anchor — прогони --anchors', file: rel }); continue; }
      if (line < sym.line || line > sym.lineEnd) { report.moved.push({ step: tag, anchor, was: `${rel}:${line}`, now: `${rel}:${sym.line}-${sym.lineEnd}` }); continue; }
      report.ok++;
    }

    /* исходы, которых нет на карте: коды ответа из тела символа против заголовков финишей */
    for (const re of codeRes) {
      for (const cm of sym.body.matchAll(re)) {
        const code = cm[1];
        if (!code || codesSeen.has(code) || terminalTitles.some((t) => t.includes(code))) continue;
        codesSeen.add(code);
        report.codes.push({ flow: flowId, code, anchor });
      }
    }
  }
  if (dirty) { fs.writeFileSync(file, JSON.stringify(flow, null, 2) + '\n'); touched.push(`${flowId}.json`); }
}

if (opts.anchors) {
  console.log(`anchor + fingerprint записаны: ${touched.length ? touched.join(', ') : 'нечего обновлять'}`);
  if (report.missing.length) { console.log(`\nНе привязались (${report.missing.length}):`); report.missing.forEach((r) => console.log(`  · ${r.step} — ${r.why} (${r.file})`)); }
  console.log('Дальше: node bin/build.mjs --project=…');
  process.exit(0);
}
if (opts.json) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.changed.length || report.missing.length ? 2 : 0);
}

console.log(`Сверено с источником: ${report.ok} шагов совпало`);
if (report.custom) console.log(`Ручных подписей (custom_*): ${report.custom} — автоматика их не трогает`);
const section = (title, list, fmt) => { if (!list.length) return; console.log(`\n${title} (${list.length}):`); list.forEach((r) => console.log(fmt(r))); };
section('МЕТОД ИЛИ РАЗДЕЛ ИЗМЕНИЛСЯ — проверь, что шаг всё ещё описан верно', report.changed, (r) => `  · ${r.step} — «${r.title}»\n    ${r.doc ? 'раздел' : 'метод'} ${r.anchor} (${r.file})`);
section('ШАГ ОСИРОТЕЛ — кода или раздела больше нет', report.missing, (r) => `  · ${r.step} — ${r.why} (${r.file})`);
section('СТРОКА ВНЕ СИМВОЛА — ссылка file устарела', report.moved, (r) => `  · ${r.step} — ${r.was}, а символ теперь ${r.now}`);
section('КОДЫ ОТВЕТА БЕЗ ФИНИША — возможно, исход не описан', report.codes, (r) => `  · ${r.flow}: код ${r.code} в ${r.anchor}`);
if (report.skipped.length) {
  console.log(`\nБез привязки к источнику (${report.skipped.length}) — норма для wait, действий людей и внешних систем:`);
  report.skipped.slice(0, 8).forEach((r) => console.log(`  · ${r.step} — ${r.why}`));
  if (report.skipped.length > 8) console.log(`  … и ещё ${report.skipped.length - 8}`);
}
const bad = report.changed.length || report.missing.length;
console.log(bad ? '\nЕсть расхождения — смотри список выше.' : '\nРасхождений нет.');
process.exit(bad ? 2 : 0);
