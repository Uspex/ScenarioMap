#!/usr/bin/env node
/* Сверка сценарных карт с кодом — для любого языка.

   Шаг привязан к коду тремя полями:
     file        — путь:строка относительно codeRoot (пишет человек или агент: место, где принимается решение);
     anchor      — путь::символ (функция / метод), переживает сдвиг строк; ставит --anchors;
     fingerprint — sha1 тела символа без комментариев и пробелов (12 знаков); ставит --anchors.

   node bin/scan.mjs --project=examples/shop               отчёт о расхождениях (exit 2, если есть)
   node bin/scan.mjs --project=… --flow=checkout            только один флоу
   node bin/scan.mjs --project=… --anchors                  записать / обновить anchor + fingerprint
   node bin/scan.mjs --project=… --json                     машиночитаемый отчёт

   Подписи (title / what / short / hint) скрипт НИКОГДА не трогает — только сообщает, что код изменился.

   Символ ищется эвристикой по объявлениям: function / func / fn / fun / def / sub, методы классов JS/TS,
   const x = (…) =>, методы Java / C# / Kotlin с модификаторами. Границы тела — по фигурным скобкам,
   для Python — по отступам, для Ruby — до парного end. Этого хватает для сверки «метод правили / метод исчез»;
   точный разбор AST не нужен. */
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

/* Символы файла: [{ name, line, lineEnd, body }] (строки с 1). */
function parseSymbols(abs) {
  const src = fs.readFileSync(abs, 'utf8').replace(/\r\n?/g, '\n');
  const ext = path.extname(abs).toLowerCase();
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
      fingerprint: crypto.createHash('sha1').update(bodyNoComments.replace(/\s+/g, '')).digest('hex').slice(0, 12) });
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

    const m = /^([\w./-]+\.[A-Za-z0-9]+):(\d+)/.exec(String(step.file || ''));
    if (!m) { report.skipped.push({ step: tag, why: step.file ? 'file не вида путь:строка' : 'нет file', file: step.file || '' }); continue; }
    const [, rel, lineStr] = m; const line = Number(lineStr);
    const symbols = symbolsOf(rel);
    if (!symbols) { report.missing.push({ step: tag, why: 'файла нет', file: rel }); continue; }

    const anchorName = step.anchor ? String(step.anchor).split('::').pop() : null;
    const byName = anchorName ? symbols.filter((s) => s.name === anchorName) : [];
    const sym = byName.length ? (byName.find((s) => s.line <= line && line <= s.lineEnd) || byName[0]) : symbolAtLine(symbols, line);
    if (!sym) {
      if (anchorName && !opts.anchors) report.missing.push({ step: tag, why: `символ ${anchorName} исчез из файла`, file: rel });
      else report.missing.push({ step: tag, why: 'строка не внутри функции или метода', file: `${rel}:${line}` });
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
      if (step.fingerprint && step.fingerprint !== sym.fingerprint) { report.changed.push({ step: tag, anchor, file: `${rel}:${sym.line}`, title: step.custom_title || step.title || '' }); continue; }
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

console.log(`Сверено с кодом: ${report.ok} шагов совпало`);
if (report.custom) console.log(`Ручных подписей (custom_*): ${report.custom} — автоматика их не трогает`);
const section = (title, list, fmt) => { if (!list.length) return; console.log(`\n${title} (${list.length}):`); list.forEach((r) => console.log(fmt(r))); };
section('МЕТОД ИЗМЕНИЛСЯ — проверь, что шаг всё ещё описан верно', report.changed, (r) => `  · ${r.step} — «${r.title}»\n    ${r.anchor} (${r.file})`);
section('ШАГ ОСИРОТЕЛ — кода больше нет', report.missing, (r) => `  · ${r.step} — ${r.why} (${r.file})`);
section('СТРОКА ВНЕ МЕТОДА — ссылка file устарела', report.moved, (r) => `  · ${r.step} — ${r.was}, а метод теперь ${r.now}`);
section('КОДЫ ОТВЕТА БЕЗ ФИНИША — возможно, исход не описан', report.codes, (r) => `  · ${r.flow}: код ${r.code} в ${r.anchor}`);
if (report.skipped.length) {
  console.log(`\nБез привязки к коду (${report.skipped.length}) — норма для wait, действий людей и внешних систем:`);
  report.skipped.slice(0, 8).forEach((r) => console.log(`  · ${r.step} — ${r.why}`));
  if (report.skipped.length > 8) console.log(`  … и ещё ${report.skipped.length - 8}`);
}
const bad = report.changed.length || report.missing.length;
console.log(bad ? '\nЕсть расхождения — смотри список выше.' : '\nРасхождений нет.');
process.exit(bad ? 2 : 0);
