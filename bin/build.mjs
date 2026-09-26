#!/usr/bin/env node
/* Сборка сценарных карт: flows/*.json → <out>/<id>.full.html + главная <out>/index.html.

   Берём настоящий шаблон и runtime Archify (vendor/archify/assets/template.html: темы, поиск, фокус,
   guided views, паспорт узла), а SVG собираем сами из данных флоу — все шаги, ветки, подписи.

   Раскладка — слоистый граф (Sugiyama-lite): ряд = длиннейший путь от входа, порядок в ряду —
   барицентр соседей (меньше пересечений), длинные рёбра идут через невидимые узлы-заглушки,
   чтобы не резать чужие блоки. Поток сверху вниз; если ширина превышает layout.maxVerticalWidth —
   горизонтальный вариант той же раскладки. Актёр показан цветом узла и в паспорте.

   node bin/build.mjs --project=examples/shop               # все флоу проекта + главная
   node bin/build.mjs --project=examples/shop checkout      # один флоу (главная не пересобирается)
   node bin/build.mjs --project=… checkout --horizontal | --vertical   # принудительная ориентация
*/
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { esc, renderDefinitions, renderSemanticSigil, renderCards, applyTemplate, textUnits } from '../vendor/archify/renderers/shared/utils.mjs';
import { svgRootAttrs, svgAccessibleText, focusNodeAttrs, focusNodeTitle, focusEdgeAttrs } from '../vendor/archify/renderers/shared/cli.mjs';
import { fittedNodeFontSize } from '../vendor/archify/renderers/shared/text-fit.mjs';
import { loadProject, listFlows, parseArgs } from '../engine/config.mjs';
import { THEME_HEAD, CHROME_CSS, CHROME_SCRIPT, chromeHeader } from '../engine/page-chrome.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const kitRoot = path.resolve(here, '..');

const { opts: ARGS, positional: ARG_IDS } = parseArgs(process.argv.slice(2));
let PROJECT;
try { PROJECT = loadProject(ARGS.project); } catch (e) { console.error(e.message); process.exit(1); }
const flowsDir = PROJECT.flowsDir;
const outDir = PROJECT.outDir;
const codeRoot = PROJECT.codeRoot;
const ACTORS = PROJECT.actors;
const RULES = PROJECT.rules;

/* Настройки раскладки: встроенные → layout из конфига проекта → layout внутри самого флоу. */
const cfgFor = (flow) => {
  const cfg = Object.assign({}, PROJECT.layout, flow.layout || {});
  cfg.actorTypes = Object.fromEntries(Object.entries(ACTORS).map(([id, a]) => [id, a.type || 'external']));
  return cfg;
};

const ACTOR_NAME = Object.fromEntries(Object.entries(ACTORS).map(([id, a]) => [id, a.name || id]));
const KIND_NAME = { entry: 'вход', step: 'шаг', branch: 'ветвление', wait: 'ожидание', terminal: 'финиш' };
const OUTCOME_TYPE = { ok: 'backend', bad: 'security', warn: 'cloud', info: 'external' };
const OUTCOME_SIGIL = { ok: 'success', bad: 'failure', warn: 'waiting', info: 'neutral' };
const TONE_TEXT = { ok: 't-backend', bad: 't-security', warn: 't-cloud', info: 't-frontend', pause: 't-database' };
const ARROW = { default: ['a-default', 'arrowhead'], emphasis: ['a-emphasis', 'arrowhead-emphasis'], security: ['a-security', 'arrowhead-security'], dashed: ['a-dashed', 'arrowhead-dashed'] };

const plural = (n, one, few, many) => { const m10 = n % 10, m100 = n % 100; return n + ' ' + (m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? few : many); };
const safe = (v) => JSON.stringify(v).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026');
const pick = (o, f) => { if (!o) return undefined; const c = o['custom_' + f]; return (c === undefined || c === null || c === '' || (Array.isArray(c) && !c.length)) ? o[f] : c; };
const attnOf = (o) => { const r = (o && (o.custom_attention || o.attention)) || []; return (Array.isArray(r) ? r : [r]).filter((x) => typeof x === 'string' && x.trim()); };
const unitsW = (text, font) => textUnits(text) * font * 0.6;

/* ---------- самопроверка данных: перенесена из старой общей карты (legacy/index.html) ----------
   Правила — RULES.md: структура шагов, strict-подписи, достижимость, пресеты до финиша,
   параллельные линии через spawns. Раскладочные проверки старого полотна сюда не переносились:
   у Archify своя раскладка, а связность путей сборщик проверяет сам. */
const validationErrors = [];
function validateFlow(fl, flowId) {
  const errs = [];
  const tag = `${flowId}: `;
  const FF = fl.steps || {};
  const outsF = (id) => { const n = FF[id]; if (!n || n.kind === 'terminal') return []; if (n.branches) return n.branches; if (n.next) return [{ to: n.next }]; return []; };
  const spawnsF = (id) => (FF[id] && FF[id].spawns) || [];
  const reach = (from) => { const seen = new Set(); const walk = (id) => { if (seen.has(id) || !FF[id]) return; seen.add(id); outsF(id).forEach((b) => walk(b.to)); }; walk(from); return seen; };

  for (const key of ['id', 'name', 'group', 'root', 'steps', 'presets']) if (fl[key] === undefined) errs.push(tag + `нет обязательного поля ${key}`);
  if (!FF[fl.root]) errs.push(tag + `точка входа ${fl.root} не описана`);

  const spawnRoots = [...new Set(Object.keys(FF).flatMap(spawnsF))];
  const ROOTS = [fl.root, ...spawnRoots].filter((r) => FF[r]);
  const main = reach(fl.root);
  const track = {};                       /* шаг → корень его параллельной линии */
  spawnRoots.forEach((t) => reach(t).forEach((id) => { if (!main.has(id) && !track[id]) track[id] = t; }));

  Object.keys(FF).forEach((id) => {
    const n = FF[id];
    if (!['entry', 'step', 'branch', 'wait', 'terminal'].includes(n.kind)) errs.push(tag + `${id}: kind=${n.kind}`);
    if (!n.actor || !ACTOR_NAME[n.actor]) errs.push(tag + `${id}: actor=${n.actor} — нет в actors конфига (${Object.keys(ACTOR_NAME).join(', ')})`);
    if (RULES.requireFile && !n.file) errs.push(tag + `${id}: не заполнен file`);
    if (!pick(n, 'what')) errs.push(tag + `${id}: не заполнен what`);
    if (n.attention !== undefined && !Array.isArray(n.attention)) errs.push(tag + `${id}: attention должен быть списком строк`);
    if (Array.isArray(n.attention) && n.attention.some((a) => typeof a !== 'string' || !a.trim())) errs.push(tag + `${id}: в attention пустая строка или не строка`);
    if (n.kind === 'terminal') {
      if (n.next || n.branches) errs.push(tag + `${id}: у terminal есть переходы`);
      if (!['ok', 'bad', 'warn', 'info'].includes(n.outcome)) errs.push(tag + `${id}: outcome=${n.outcome}`);
    } else if (!n.next && !(n.branches && n.branches.length)) {
      errs.push(tag + `${id}: нет ни next, ни branches`);
    }
    outsF(id).forEach((b) => { if (!FF[b.to]) errs.push(tag + `${id} → неизвестный узел ${b.to}`); });
    spawnsF(id).forEach((t) => {
      if (!FF[t]) { errs.push(tag + `${id}: spawns → неизвестный шаг ${t}`); return; }
      if (main.has(t)) errs.push(tag + `${id}: spawns → ${t} достижим обычными переходами, это не отдельная линия`);
      if (track[id] === t) errs.push(tag + `${id}: spawns → ${t} запускает собственную линию`);
    });

    if (!fl.strict) return;
    const eTitle = String(pick(n, 'title') || '');
    if (/::|^(POST|GET|PUT|PATCH|DELETE) /.test(eTitle) && !pick(n, 'code')) errs.push(tag + `${id}: в заголовке техническое имя, а code не заполнен`);
    if (n.kind === 'branch') {
      if (!new RegExp(RULES.branchTitle).test(eTitle)) errs.push(tag + `${id}: заголовок развилки должен быть вопросом`);
      (n.branches || []).forEach((b, i) => {
        const bShort = pick(b, 'short'), bHint = pick(b, 'hint');
        if (!bShort) errs.push(tag + `${id}: ветка ${i + 1} без short`);
        else if (bShort.length > RULES.shortMax) errs.push(tag + `${id}: short «${bShort}» длиннее ${RULES.shortMax} символов`);
        if (!bHint) errs.push(tag + `${id}: ветка ${i + 1} без hint`);
        else if (bHint.length > RULES.hintMax) errs.push(tag + `${id}: hint «${bHint}» длиннее ${RULES.hintMax} символов`);
        if (!b.cond) errs.push(tag + `${id}: ветка ${i + 1} без cond`);
      });
    }
    if (n.kind === 'terminal' && !new RegExp(RULES.terminalTitle).test(eTitle)) errs.push(tag + `${id}: заголовок финиша не по шаблону rules.terminalTitle (${RULES.terminalTitle})`);
  });

  const seen = new Set(); ROOTS.forEach((r) => reach(r).forEach((id) => seen.add(id)));
  Object.keys(FF).forEach((id) => { if (!seen.has(id)) errs.push(tag + `${id}: недостижим от точек входа`); });
  if (!Object.keys(FF).some((id) => FF[id].kind === 'terminal' && FF[id].outcome === 'ok')) errs.push(tag + 'нет ни одного успешного финиша');

  (fl.presets || []).forEach((p) => {
    const name = pick(p, 'name');
    const path = p.path || [];
    if (!ROOTS.includes(path[0])) errs.push(tag + `preset "${name}": старт не точка входа — ${path[0]}`);
    for (let k = 0; k < path.length - 1; k++) if (!outsF(path[k]).some((b) => b.to === path[k + 1])) errs.push(tag + `preset "${name}": нет перехода ${path[k]} → ${path[k + 1]}`);
    const last = FF[path[path.length - 1]];
    if (!last || last.kind !== 'terminal') errs.push(tag + `preset "${name}": последний шаг не финиш`);
    if (!pick(p, 'note') && !pick(p, 'biz')) errs.push(tag + `preset "${name}": нет подписи note`);
    if (!p.sub) return;
    if (!spawnRoots.includes(p.sub[0])) errs.push(tag + `preset "${name}": sub стартует не с параллельной линии — ${p.sub[0]}`);
    for (let k = 0; k < p.sub.length - 1; k++) if (!outsF(p.sub[k]).some((b) => b.to === p.sub[k + 1])) errs.push(tag + `preset "${name}": в sub нет перехода ${p.sub[k]} → ${p.sub[k + 1]}`);
    const subLast = FF[p.sub[p.sub.length - 1]];
    if (!subLast || subLast.kind !== 'terminal') errs.push(tag + `preset "${name}": sub не заканчивается финишем`);
  });
  return errs;
}

/* Точечные правки runtime Archify в нашей копии шаблона: камера не прыгает при выборе узла,
   появляется зум к точке под курсором. Каждая замена обязана сработать — иначе версия шаблона изменилась. */
function patchTemplate(template) {
  const patches = [
    ["if (typeof active === 'string') return reveal([active], { includeNeighbors: true, reason: 'focus-sync' });", "if (typeof active === 'string') return false; /* scenario-map: без прыжка камеры при выборе шага */"],
    ["if (Array.isArray(active) && active.length) return reveal(active, { reason: 'selection-sync' });", "if (Array.isArray(active) && active.length) return false;"],
    ["      return {\n        zoomIn: function () { zoom(state.scale + 0.25); },",
      `      function zoomAt(clientX, clientY, next) {
        interruptCamera();
        var previous = state.scale;
        next = Math.max(0.3, Math.min(4, next));
        if (next === previous) return;
        var base = container.getBoundingClientRect();
        var px = clientX - base.left + container.scrollLeft;
        var py = clientY - base.top + container.scrollTop;
        var contentX = (px - state.x) / previous;
        var contentY = (py - state.y) / previous;
        state.scale = next;
        state.x = px - contentX * next;
        state.y = py - contentY * next;
        state.mode = 'manual';
        apply();
      }
      return {
        zoomAt: zoomAt,
        zoomIn: function () { zoom(state.scale + 0.05); },
        zoomOut: function () { zoom(state.scale - 0.05); },`],
    ["        zoomOut: function () { zoom(state.scale - 0.25); },\n", ''],
    ["inBtn.addEventListener('click', function () { zoom(state.scale + 0.25); });", "inBtn.addEventListener('click', function () { zoom(state.scale + 0.05); });"],
    ["outBtn.addEventListener('click', function () { zoom(state.scale - 0.25); });", "outBtn.addEventListener('click', function () { zoom(state.scale - 0.05); });"],
    ['next = Math.max(1, Math.min(3, Math.round(next * 4) / 4));', 'next = Math.max(0.3, Math.min(4, Math.round(next * 20) / 20));'],
    ['inBtn.disabled = state.scale >= 3;', 'inBtn.disabled = state.scale >= 4;'],
    ['outBtn.disabled = state.scale <= 1;', 'outBtn.disabled = state.scale <= 0.3;'],
    /* масштаб меньше 100 %: полотно центрируем по ширине и убираем пустоту под уменьшенной схемой */
    ["        state.x = Math.min(0, Math.max(width - width * state.scale, state.x));\n        state.y = Math.min(0, Math.max(height - height * state.scale, state.y));",
      "        if (state.scale < 1) { state.x = (width - width * state.scale) / 2; state.y = 0; return; }\n        state.x = Math.min(0, Math.max(width - width * state.scale, state.x));\n        state.y = Math.min(0, Math.max(height - height * state.scale, state.y));"],
    ["        svg.style.transform = 'translate(' + state.x + 'px,' + state.y + 'px) scale(' + state.scale + ')';",
      "        svg.style.transform = 'translate(' + state.x + 'px,' + state.y + 'px) scale(' + state.scale + ')';\n        svg.style.marginBottom = state.scale < 1 ? (-(svg.clientHeight || 0) * (1 - state.scale)) + 'px' : '';"],
    ["Archify.view.reveal([id], { includeNeighbors: true, reason: 'focus' });", 'void 0; /* scenario-map: без прыжка камеры */', 'all'],
  ];
  let out = template;
  for (const [from, to, mode] of patches) {
    if (!out.includes(from)) throw new Error(`patchTemplate: не найден фрагмент шаблона:\n${from}`);
    out = mode === 'all' ? out.replaceAll(from, () => to) : out.replace(from, () => to);
  }
  return out;
}
/* переводы строк нормализуем: git с autocrlf на Windows отдаёт шаблон в CRLF, и патчи не находят фрагменты */
const template = patchTemplate(fs.readFileSync(path.join(kitRoot, 'vendor/archify/assets/template.html'), 'utf8').replace(/\r\n?/g, '\n'));

function build(flowId, force) {
  const FLOW = JSON.parse(fs.readFileSync(path.join(flowsDir, `${flowId}.json`), 'utf8'));
  if (FLOW.id !== undefined && FLOW.id !== flowId) validationErrors.push(`${flowId}: id в файле «${FLOW.id}» не совпадает с именем файла`);
  const cfg = cfgFor(FLOW);
  const S_ALL = FLOW.steps;
  const S = S_ALL;
  const IDS = Object.keys(S);
  validationErrors.push(...validateFlow(FLOW, flowId));

  const outsAll = (id) => {
    const n = S[id];
    if (!n || n.kind === 'terminal') return [];
    if (n.branches) return n.branches.map((b) => ({ ...b, plain: false }));
    if (n.next) return [{ to: n.next, tone: 'ok', plain: true }];
    return [];
  };
  const spawnsAll = (id) => (S[id] && S[id].spawns) || [];
  const outs = outsAll, spawns = spawnsAll;
  const typeOf = (id) => {
    const s = S[id];
    if (s.kind === 'terminal') return OUTCOME_TYPE[s.outcome] || 'external';
    return cfg.stepTypes?.[id] || cfg.actorTypes[s.actor] || 'external';
  };

  /* Раскладка и SVG считаются для набора блоков: полный граф — для «Все сценарии»,
     подмножество — для конкретного сценария, чтобы на карте не оставалось дыр и
     оборванных стрелок от скрытых блоков. */
  function renderGraph(IDS_IN, opts = {}) {
  const inSet0 = new Set(IDS_IN);
  /* Фоновая задача рисуется отдельной карточкой при каждом блоке, который её запускает
     (как в карте пути транзакции): исходный узел задачи заменяется клонами `задача@блок`. */
  const CLONE = opts.cloneSpawns !== false;
  const spawnedIds = new Set();
  if (CLONE) IDS_IN.forEach((u) => spawnsAll(u).forEach((t) => { if (inSet0.has(t)) spawnedIds.add(t); }));
  const clones = {};
  const IDS = [];
  for (const u of IDS_IN) {
    if (spawnedIds.has(u)) continue;
    IDS.push(u);
    if (!CLONE) continue;
    for (const t of spawnsAll(u)) {
      if (!inSet0.has(t)) continue;
      const cid = `${t}@${u}`;
      clones[cid] = S_ALL[t];
      IDS.push(cid);
    }
  }
  const S = Object.assign({}, S_ALL, clones);
  const baseOf = (id) => String(id).split('@')[0];
  /* тип узла — по локальному S, где есть и клоны задач */
  const typeOf = (id) => {
    const s = S[id];
    if (s.kind === 'terminal') return OUTCOME_TYPE[s.outcome] || 'external';
    return cfg.stepTypes?.[baseOf(id)] || cfg.actorTypes[s.actor] || 'external';
  };
  const inSet = new Set(IDS);
  const outs = (id) => outsAll(baseOf(id)).filter((b) => inSet.has(b.to));
  const spawns = (id) => CLONE
    ? spawnsAll(id).filter((t) => inSet0.has(t)).map((t) => `${t}@${id}`).filter((c) => inSet.has(c))
    : spawnsAll(baseOf(id)).filter((t) => inSet.has(t));
  const rootId = inSet.has(FLOW.root) ? FLOW.root : IDS[0];

  /* ---- ранги: длиннейший путь от входа, обратные рёбра не считаются ---- */
  const back = new Set();
  {
    const st = {};
    const walk = (u) => {
      st[u] = 1;
      for (const e of [...outs(u), ...spawns(u).map((t) => ({ to: t }))]) {
        if (!S[e.to]) continue;
        if (st[e.to] === 1) back.add(`${u}>${e.to}`); else if (st[e.to] === undefined) walk(e.to);
      }
      st[u] = 2;
    };
    walk(rootId);
    IDS.forEach((n) => { if (st[n] === undefined) walk(n); });
  }
  const rank = {};
  {
    const lift = (n, v) => { if (rank[n] !== undefined && rank[n] >= v) return false; rank[n] = v; return true; };
    lift(rootId, 0);
    for (let g = 0; g < IDS.length + 2; g += 1) {
      let moved = false;
      for (const u of IDS) {
        if (rank[u] === undefined) continue;
        for (const e of [...outs(u), ...spawns(u).map((t) => ({ to: t }))]) {
          if (S[e.to] && !back.has(`${u}>${e.to}`) && lift(e.to, rank[u] + 1)) moved = true;
        }
      }
      if (!moved) break;
    }
    IDS.forEach((n) => { if (rank[n] === undefined) rank[n] = 0; });
  }
  /* Фоновая задача рисуется рядом с блоком, который её запускает, а не в конце ленты:
     ставим ей ранг запускающего блока. */
  if (CLONE) {
    for (const id of IDS) {
      for (const t of spawns(id)) {
        if (S[t] && rank[t] !== undefined) rank[t] = rank[id];
      }
    }
  }
  const RANKS = Math.max(...IDS.map((n) => rank[n])) + 1;

  /* ---- узлы: текст и размеры (label / sublabel / tag как у Archify) ---- */
  const NODE_W = 184, TERM_W = 160;
  const wrapLabel = (text, width) => {
    const maxUnits = Math.floor((width - 14) / (10 * 0.6));
    const words = String(text).split(/\s+/); const lines = []; let cur = '';
    for (const w of words) { const t = cur ? `${cur} ${w}` : w; if (textUnits(t) <= maxUnits || !cur) cur = t; else { lines.push(cur); cur = w; } }
    if (cur) lines.push(cur);
    return lines;
  };
  const N = {};
  for (const id of IDS) {
    const s = S[id];
    const w = s.kind === 'terminal' ? TERM_W : NODE_W;
    const lines = wrapLabel(pick(s, 'title'), w);
    const font = lines.length > 2 ? 9 : 10;
    const sub = pick(s, 'code') || '';
    const tags = [];
    if (attnOf(s).length) tags.push('⚠ обратить внимание');
    if (pick(s, 'note')) tags.push('⏸ примечание');
    if (s.kind === 'terminal' && s.outcome) tags.unshift(`финиш · ${s.outcome}`);
    const tag = tags.join(' · ');
    const h = 18 + lines.length * (font + 2) + (sub ? 11 : 0) + 30;
    const type = typeOf(id);
    const sigil = s.kind === 'terminal' ? (OUTCOME_SIGIL[s.outcome] || 'neutral') : s.kind === 'entry' ? 'start' : s.kind === 'wait' ? 'waiting' : type;
    N[id] = { id, lines, font, sub, tag, h, w, type, sigil, r: rank[id], real: true };
  }

  /* ---- рёбра ---- */
  const mainPath = new Set();
  (FLOW.presets[0]?.path || []).forEach((id, i, p) => { if (i) mainPath.add(`${p[i - 1]}>${id}`); });
  const EDGES = [];
  for (const u of IDS) {
    const seen = {};
    for (const e of outs(u)) {
      if (!S[e.to]) continue;
      const key = `${u}>${e.to}`;
      if (seen[key]) { seen[key].labels.push(e); continue; }
      const ed = { from: u, to: e.to, key, labels: [e], tone: e.tone || 'ok', paused: !!e.paused, plain: !!e.plain,
        kind: u === e.to ? 'self' : (back.has(key) || rank[e.to] <= rank[u] ? 'back' : 'fwd') };
      seen[key] = ed; EDGES.push(ed);
    }
    for (const t of spawns(u)) if (S[t]) EDGES.push({ from: u, to: t, key: `${u}>${t}`, labels: [], tone: 'info', spawn: true, kind: rank[t] === rank[u] ? 'side' : rank[t] < rank[u] ? 'back' : 'fwd' });
  }
  const edgeLabel = (e) => {
    if (e.spawn) return e.kind === 'side' ? (e.firstSide ? 'запускает' : '') : '⇉ параллельно';
    const l = e.labels.filter((x) => !x.plain && pick(x, 'short'));
    if (!l.length) return '';
    const shorts = [...new Set(l.map((x) => String(pick(x, 'short')).toUpperCase()))];
    if (shorts.length > 1) return shorts.join(' / ');
    const hints = [...new Set(l.map((x) => pick(x, 'hint')).filter(Boolean))];
    const tail = hints.length > 1 ? `${hints.length} причины` : (hints[0] || '');
    const full = shorts[0] + (tail ? ` · ${tail}` : '');
    return textUnits(full) > 30 ? shorts[0] + (hints.length > 1 ? ` · ${hints.length} причины` : '') : full;
  };
  const edgeVariant = (e) => (e.paused || e.spawn || e.kind === 'back') ? 'dashed' : e.tone === 'bad' ? 'security' : mainPath.has(e.key) ? 'emphasis' : 'default';

  /* ---- заглушки для длинных рёбер: занимают место в промежуточных рядах ---- */
  const DUMMY_W = 18;
  for (const e of EDGES.filter((x) => x.kind === 'fwd')) {
    e.chain = [];
    for (let r = N[e.from].r + 1; r < N[e.to].r; r += 1) {
      const id = `~${e.key}~${r}`;
      N[id] = { id, w: DUMMY_W, h: 0, r, real: false, edge: e };
      e.chain.push(id);
    }
  }
  const ALL = Object.keys(N);

  /* ---- раскладка в осях (u — вдоль потока, v — поперёк) ---- */
  function layout(vertical) {
    const along = (n) => (vertical ? n.h : n.w);
    const across = (n) => (vertical ? n.w : n.h);
    const GAP = vertical ? (cfg.colGap ?? 34) : 22, ROW_GAP = vertical ? (cfg.rowGap ?? 92) : 120, U0 = vertical ? 40 : 60, V0 = vertical ? 70 : 40;
    /* ряды и связи между соседними рядами (с учётом заглушек) */
    const rows = Array.from({ length: RANKS }, () => []);
    ALL.forEach((id) => rows[N[id].r].push(id));
    const down = {}, up = {};
    const link = (a, b) => { (down[a] ||= []).push(b); (up[b] ||= []).push(a); };
    for (const e of EDGES.filter((x) => x.kind === 'fwd')) {
      const seq = [e.from, ...e.chain, e.to];
      for (let i = 1; i < seq.length; i += 1) link(seq[i - 1], seq[i]);
    }
    /* порядок в ряду: барицентр соседей, несколько проходов вниз/вверх */
    const pos = {};
    const setPos = () => rows.forEach((row) => row.forEach((id, i) => { pos[id] = i; }));
    setPos();
    const bary = (id, nb) => { const arr = (nb[id] || []).map((x) => pos[x]); return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : pos[id]; };
    for (let sweep = 0; sweep < 8; sweep += 1) {
      const downward = sweep % 2 === 0;
      const order = downward ? rows.map((_, i) => i) : rows.map((_, i) => rows.length - 1 - i);
      for (const r of order) {
        const nb = downward ? up : down;
        const keyed = rows[r].map((id) => ({ id, b: bary(id, nb) }));
        keyed.sort((x, y) => x.b - y.b || pos[x.id] - pos[y.id]);
        rows[r] = keyed.map((k) => k.id);
        setPos();
      }
    }
    /* координаты вдоль потока */
    const rowU = [], rowA = [];
    let u = U0;
    rows.forEach((row, r) => { const a = Math.max(0, ...row.map((id) => along(N[id]))); rowU[r] = u; rowA[r] = a; u += a + ROW_GAP; });
    const UMAX = u - ROW_GAP + 40;
    /* координаты поперёк: к барицентру родителей, без наложений, ряд центрируется по своим родителям */
    const center = (id) => N[id].v + across(N[id]) / 2;
    rows.forEach((row, r) => {
      const ideal = row.map((id) => {
        const parents = (up[id] || []).filter((p) => N[p].v !== undefined);
        if (!parents.length) return null;
        return parents.reduce((a, p) => a + center(p), 0) / parents.length - across(N[id]) / 2;
      });
      let cursor = -Infinity;
      row.forEach((id, i) => {
        const want = ideal[i] === null ? cursor + GAP : ideal[i];
        N[id].v = Math.max(want, cursor === -Infinity ? want : cursor + GAP);
        if (!Number.isFinite(N[id].v)) N[id].v = 0;
        cursor = N[id].v + across(N[id]);
      });
      /* сдвиг ряда: суммарное отклонение от идеала → 0 */
      const dev = row.map((id, i) => (ideal[i] === null ? null : N[id].v - ideal[i])).filter((d) => d !== null);
      const shift = dev.length ? dev.reduce((a, b) => a + b, 0) / dev.length : 0;
      row.forEach((id) => { N[id].v -= shift; });
      row.forEach((id) => { N[id].u = rowU[r]; });
    });
    /* выпрямление длинных рёбер: заглушки одной цепочки — на одну линию, если место свободно */
    const rowOf = (id) => rows[N[id].r];
    const fits = (id, v) => rowOf(id).every((o) => o === id || v + across(N[id]) + GAP <= N[o].v || N[o].v + across(N[o]) + GAP <= v);
    for (let pass = 0; pass < 2; pass += 1) {
      for (const e of EDGES.filter((x) => x.kind === "fwd" && x.chain.length)) {
        const src = N[e.from], dst = N[e.to];
        const target = (src.v + across(src) / 2 + dst.v + across(dst) / 2) / 2 - DUMMY_W / 2;
        const cand = [target, ...e.chain.map((d) => N[d].v)];
        const ok = cand.find((v) => e.chain.every((d) => fits(d, v)));
        if (ok !== undefined) e.chain.forEach((d) => { N[d].v = ok; });
      }
    }
    const minV = Math.min(...ALL.map((id) => N[id].v));
    ALL.forEach((id) => { N[id].v += V0 - minV; });
    /* Фоновые задачи одного блока ставим колонкой справа от него, а не в ряд:
       так читается «блок запускает эти задачи», и линии не идут сквозь соседей. */
    let uMaxExtra = 0;
    if (CLONE) {
      const byParent = {};
      ALL.forEach((id) => { if (String(id).includes('@')) { const par = String(id).split('@')[1]; (byParent[par] ||= []).push(id); } });
      for (const [par, kids] of Object.entries(byParent)) {
        const pn = N[par]; if (!pn) continue;
        kids.sort((a, b) => N[a].v - N[b].v);
        let cu = pn.u;
        for (const k of kids) {
          N[k].v = pn.v + across(pn) + GAP + 26;
          N[k].u = cu;
          cu += along(N[k]) + 14;
        }
        uMaxExtra = Math.max(uMaxExtra, cu - 14 - (pn.u + along(pn)));
      }
    }
    const UMAX2 = UMAX + Math.max(0, uMaxExtra);
    const VMAX = Math.max(...ALL.map((id) => N[id].v + across(N[id]))) + 40;
    const W = vertical ? VMAX : UMAX2, H = vertical ? UMAX2 : VMAX;
    return { vertical, rows, rowU, rowA, W, H, VMAX, UMAX: UMAX2, U0, along, across };
  }
  let L = layout(true);
  const useVertical = force === 'vertical' ? true : force === 'horizontal' ? false : L.W <= (cfg.maxVerticalWidth || 3000);
  if (!useVertical) L = layout(false);
  const { vertical } = L;
  const XY = (u, v) => (vertical ? [v, u] : [u, v]);
  const rect = (n) => { const [x, y] = XY(n.u, n.v); return { x, y, w: n.w, h: n.h }; };
  const uEnd = (n) => n.u + L.along(n), vEnd = (n) => n.v + L.across(n), vMid = (n) => n.v + L.across(n) / 2, uMid = (n) => n.u + L.along(n) / 2;

  /* ---- порты и каналы ---- */
  const outP = {}, inP = {};
  for (const e of EDGES.filter((x) => x.kind === 'fwd')) { (outP[e.from] ||= []).push(e); (inP[e.to] ||= []).push(e); }
  const clampV = (n, x) => Math.max(n.v + 12, Math.min(vEnd(n) - 12, x));
  const firstV = (e) => (e.chain.length ? vMid(N[e.chain[0]]) : vMid(N[e.to]));
  const lastV = (e) => (e.chain.length ? vMid(N[e.chain.at(-1)]) : vMid(N[e.from]));
  for (const arr of Object.values(outP)) { arr.sort((a, b) => firstV(a) - firstV(b)); arr.forEach((e, i) => { e.pv = clampV(N[e.from], vMid(N[e.from]) + (i - (arr.length - 1) / 2) * 14); }); }
  for (const arr of Object.values(inP)) { arr.sort((a, b) => lastV(a) - lastV(b)); arr.forEach((e, i) => { e.qv = clampV(N[e.to], vMid(N[e.to]) + (i - (arr.length - 1) / 2) * 14); }); }
  /* канал над рядом r: свой слот каждому горизонтальному отрезку, длинные — дальше от ряда */
  const chanSeg = Array.from({ length: RANKS }, () => []);
  for (const e of EDGES.filter((x) => x.kind === 'fwd')) {
    const seq = [{ v: e.pv }, ...e.chain.map((d) => ({ v: vMid(N[d]) })), { v: e.qv }];
    e.segs = [];
    for (let i = 1; i < seq.length; i += 1) {
      const r = N[e.from].r + i;
      const seg = { e, i, a: Math.min(seq[i - 1].v, seq[i].v), b: Math.max(seq[i - 1].v, seq[i].v) };
      chanSeg[r].push(seg); e.segs.push(seg);
    }
  }
  chanSeg.forEach((segs, r) => {
    segs.sort((x, y) => (y.b - y.a) - (x.b - x.a));
    const slots = [];
    for (const seg of segs) {
      let k = 0;
      while ((slots[k] || []).some((o) => o.a < seg.b + 10 && seg.a < o.b + 10)) k += 1;
      (slots[k] ||= []).push(seg);
      seg.slot = k;
    }
    const n = slots.length;
    segs.forEach((seg) => { seg.u = L.rowU[r] - 14 - (n - 1 - seg.slot) * 9; });
  });
  { const seen = new Set(); for (const e of EDGES) { if (e.kind !== 'side') continue; if (!seen.has(e.from)) { e.firstSide = true; seen.add(e.from); } } }
  const corridorV = L.VMAX - 26;
  let backSlots = 0;
  for (const e of EDGES.filter((x) => x.kind === 'back')) { e.cv = corridorV + backSlots * 10; backSlots += 1; }
  function route(e) {
    const a = N[e.from], b = N[e.to];
    let pts, label;
    if (e.kind === 'self') {
      pts = [[uEnd(a) - 10, vEnd(a)], [uEnd(a) - 10, vEnd(a) + 16], [a.u - 12, vEnd(a) + 16], [a.u - 12, vEnd(a) - 28], [a.u, vEnd(a) - 28]];
      label = [a.u - 20, vEnd(a) + 16];
    } else if (e.kind === 'back') {
      pts = [[uMid(a), vEnd(a)], [uMid(a), e.cv], [uMid(b), e.cv], [uMid(b), vEnd(b)]];
      label = [uMid(b) - 10, (vEnd(b) + e.cv) / 2];
    } else if (e.kind === 'side') {
      /* фоновая задача справа от блока: линия от правого края блока в зазор, вниз до уровня
         карточки задачи и к её левому краю; подпись «запускает» — у первой карточки */
      const gapV = (vEnd(a) + b.v) / 2;
      const ua = Math.min(uMid(a), uMid(b));
      pts = Math.abs(uMid(a) - uMid(b)) < 2
        ? [[uMid(a), vEnd(a)], [uMid(a), b.v]]
        : [[ua, vEnd(a)], [ua, gapV], [uMid(b), gapV], [uMid(b), b.v]];
      label = [ua - 9, gapV];
    } else {
      pts = [[uEnd(a), e.pv]];
      const vs = [e.pv, ...e.chain.map((d) => vMid(N[d])), e.qv];
      e.segs.forEach((seg, i) => { pts.push([seg.u, vs[i]]); pts.push([seg.u, vs[i + 1]]); });
      pts.push([b.u, e.qv]);
      pts = pts.filter((p, i) => i === 0 || p[0] !== pts[i - 1][0] || p[1] !== pts[i - 1][1]);
      const s0 = e.segs[0], sl = e.segs.at(-1);
      if (Math.abs(s0.b - s0.a) >= 30) label = [s0.u, (s0.a + s0.b) / 2];
      else { label = [(uEnd(a) + s0.u) / 2, e.pv]; e.beside = true; }
    }
    const xy = pts.map(([pu, pv]) => XY(pu, pv));
    return { d: xy.map((p, i) => `${i ? 'L' : 'M'} ${p[0]} ${p[1]}`).join(' '), points: xy, label: XY(label[0], label[1]) };
  }

  /* ---- SVG ---- */
  const meta = { title: pick(FLOW, 'name'), locale: 'en', visual_preset: 'classic', quality_profile: 'standard' };
  const out = [];
  out.push(`      <svg viewBox="0 0 ${Math.ceil(L.W)} ${Math.ceil(L.H)}" ${svgRootAttrs(meta)} data-orientation="${vertical ? 'vertical' : 'horizontal'}">`);
  out.push(svgAccessibleText({ ...meta, subtitle: pick(FLOW, 'what') }, 'workflow'));
  if (opts.withDefs !== false) out.push(renderDefinitions());
  out.push('        <rect width="100%" height="100%" fill="url(#grid)" />');
  out.push('        <!-- Phase headers -->');
  /* Этапы: если флоу сам объявил stages + stage у блоков, фазы считаются по ним,
     иначе берётся ручной список из CONFIG. */
  const autoPhases = FLOW.stages
    ? Object.entries(FLOW.stages).map(([key, label]) => {
        const ids = IDS.filter((id) => S[id].stage === key && N[id]);
        if (!ids.length) return null;
        const sorted = ids.slice().sort((a, b) => N[a].r - N[b].r);
        return { label, from: sorted[0], to: sorted[sorted.length - 1], variant: 'default' };
      }).filter(Boolean)
    : null;
  for (const [pi, p] of (autoPhases || cfg.phases || []).entries()) {
    const c1 = rank[p.from] ?? 0, c2 = p.to === null || rank[p.to] === undefined ? RANKS - 1 : rank[p.to];
    const uA = L.rowU[Math.min(c1, c2)] - 10, uB = L.rowU[Math.max(c1, c2)] + L.rowA[Math.max(c1, c2)] + 10;
    const [cls] = ARROW[p.variant] || ARROW.default; const accent = p.variant === 'emphasis' ? 't-backend' : p.variant === 'security' ? 't-security' : p.variant === 'dashed' ? 't-database' : 't-muted';
    const lw = unitsW(p.label, 8) + 14;
    if (vertical && cfg.phaseStyle === 'divider') {
      /* этап-разделитель, как в карте пути транзакции: номер в кружке, название и линия на всю ширину */
      const y = uA - 12, label = p.label.toUpperCase(), tw = unitsW(label, 9) + 6;
      out.push(`        <circle cx="34" cy="${y}" r="8" class="c-mask" stroke-width="1"/>`);
      out.push(`        <text x="34" y="${y}" class="${accent}" font-size="8" font-weight="600" text-anchor="middle" dominant-baseline="central">${pi + 1}</text>`);
      out.push(`        <text x="48" y="${y}" class="${accent}" font-size="9" font-weight="600" letter-spacing="1.2" dominant-baseline="central">${esc(label)}</text>`);
      out.push(`        <line x1="${52 + tw}" y1="${y}" x2="${Math.ceil(L.W) - 24}" y2="${y}" class="a-dashed" stroke-width="1"/>`);
    } else if (vertical) {
      const x = 26, mid = (uA + uB) / 2;
      out.push(`        <line x1="${x}" y1="${uA}" x2="${x}" y2="${uB}" class="${cls}" stroke-width="1.1"/>`);
      out.push(`        <rect x="${x - 8}" y="${mid - lw / 2}" width="16" height="${lw}" rx="4" class="c-mask"/>`);
      out.push(`        <text x="${x}" y="${mid}" class="${accent}" font-size="8" font-weight="600" text-anchor="middle" transform="rotate(-90 ${x} ${mid})" dominant-baseline="middle">${esc(p.label)}</text>`);
    } else {
      const y = 30, mid = (uA + uB) / 2;
      out.push(`        <line x1="${uA}" y1="${y}" x2="${uB}" y2="${y}" class="${cls}" stroke-width="1.1"/>`);
      out.push(`        <rect x="${mid - lw / 2}" y="${y - 8}" width="${lw}" height="16" rx="4" class="c-mask"/>`);
      out.push(`        <text x="${mid}" y="${y + 4}" class="${accent}" font-size="8" font-weight="600" text-anchor="middle">${esc(p.label)}</text>`);
    }
  }
  out.push('        <!-- Edge paths -->');
  const routes = new Map();
  EDGES.forEach((e, i) => {
    const r = route(e); routes.set(e, r);
    const [cls, marker] = ARROW[edgeVariant(e)];
    out.push(`        <path ${focusEdgeAttrs(baseOf(e.from), baseOf(e.to), edgeLabel(e), i, e.key.replace('>', '--').replace(/@/g, '-at-'))} data-composition-points="${r.points.map((p) => p.join(',')).join(';')}" d="${r.d}" class="${cls}" stroke-width="${edgeVariant(e) === 'emphasis' ? 1.9 : 1.4}" marker-end="url(#${marker})"/>`);
  });
  out.push('        <!-- Nodes -->');
  for (const id of IDS) {
    const n = N[id], s = S[id], R = rect(n);
    const phase = (cfg.phases || []).find((p) => { const c1 = rank[p.from] ?? 0, c2 = p.to === null || rank[p.to] === undefined ? RANKS - 1 : rank[p.to]; return n.r >= Math.min(c1, c2) && n.r <= Math.max(c1, c2); });
    const context = [`${KIND_NAME[s.kind] || s.kind} · ${ACTOR_NAME[s.actor] || s.actor}`, phase ? phase.label : null].filter(Boolean).join(' › ');
    const passport = { kind: n.type, sublabel: n.sub || undefined, tag: n.tag || undefined, context };
    const cx = R.x + R.w / 2;
    let ty = R.y + 18 + n.font;
    const sigil = renderSemanticSigil(n.sigil, { x: R.x + 6, y: R.y + 6 }).replace(/class="semantic-sigil s-[a-z]+"/, `class="semantic-sigil s-${n.type}"`);
    out.push(`        <g ${focusNodeAttrs(baseOf(id), pick(s, 'title'), passport, 'en')}>`);
    out.push(`          ${focusNodeTitle(pick(s, 'title'), passport)}`);
    out.push(`          <rect x="${R.x}" y="${R.y}" width="${R.w}" height="${R.h}" rx="${s.kind === 'branch' ? 14 : 6}" class="c-mask"/>`);
    out.push(`          <rect x="${R.x}" y="${R.y}" width="${R.w}" height="${R.h}" rx="${s.kind === 'branch' ? 14 : 6}" class="c-${n.type}" stroke-width="${s.kind === 'branch' ? 2 : 1.5}"${s.kind === 'wait' ? ' stroke-dasharray="5,3"' : ''}/>`);
    out.push(`          ${sigil}`);
    if (s.kind === 'branch') out.push(`          <text x="${R.x + R.w - 8}" y="${R.y + 14}" class="t-${n.type}" font-size="10" font-weight="700" text-anchor="end">?</text>`);
    n.lines.forEach((line, i) => { out.push(`          <text${i === 0 ? ' data-node-label=""' : ''}${i === 0 && n.sub ? ' data-detail-anchor=""' : ''} x="${cx}" y="${ty}" class="t-primary" font-size="${n.font}" font-weight="600" text-anchor="middle">${esc(line)}</text>`); ty += n.font + 2; });
    if (n.sub) { out.push(`          <text data-detail="context" x="${cx}" y="${ty + 7}" class="t-muted" font-size="${fittedNodeFontSize(n.sub, R.w, 7.5, 6)}" text-anchor="middle">${esc(n.sub)}</text>`); ty += 11; }
    if (n.tag) out.push(`          <text data-detail="fine" x="${R.x + 10}" y="${R.y + R.h - 9}" class="t-${n.type}" font-size="${fittedNodeFontSize(n.tag, R.w - 62, 7, 6)}">${esc(n.tag)}</text>`);
    /* кнопки «детали» нет: паспорт блока открывается кликом по карточке */
    out.push('        </g>');
  }
  out.push('        <!-- Edge labels -->');
  EDGES.forEach((e, i) => {
    const text = edgeLabel(e);
    if (!text) return;
    const r = routes.get(e);
    const w = unitsW(text, 8) + 8;
    let [lx, ly] = r.label;
    if (e.kind === 'fwd' && e.beside) { if (vertical) lx += w / 2 + 6; else ly -= 8; }
    else if (e.kind === 'fwd') ly -= 3;
    else if (e.kind === 'back') { if (vertical) lx -= w / 2 + 4; else ly -= 8; }
    const cls = e.spawn ? 't-frontend' : e.paused ? 't-database' : (TONE_TEXT[e.tone] || 't-muted');
    out.push(`        <g data-detail="context" ${focusEdgeAttrs(e.from, e.to, text, i, e.key.replace('>', '--'))}>`);
    out.push(`          <rect x="${lx - w / 2}" y="${ly - 10}" width="${w}" height="14" rx="3" class="c-mask"/>`);
    out.push(`          <text x="${lx}" y="${ly}" class="${cls}" font-size="8" text-anchor="middle">${esc(text)}</text>`);
    out.push('        </g>');
  });
  {
    const kinds = [...new Set(IDS.map((id) => N[id].type))];
    /* подпись цвета = актёры этого флоу с таким цветом; явный layout.legend важнее */
    const names = {};
    for (const id of IDS) {
      const s = S[id]; if (s.kind === 'terminal') continue;
      const t = typeOf(id), nm = ACTOR_NAME[s.actor] || s.actor;
      (names[t] ||= []).includes(nm) || names[t].push(nm);
    }
    Object.keys(names).forEach((t) => { names[t] = names[t].join(', '); });
    Object.assign(names, cfg.legend || {});
    if (!names.external) names.external = 'финиш info';
    const outcomeNote = { backend: ' · финиш ok', security: ' · финиш bad', cloud: ' · финиш warn' };
    let x = 24; const y = L.H - 14;
    out.push('        <!-- Legend -->');
    out.push('        <g data-legend="">');
    out.push(`          <text x="${x}" y="${y}" class="t-primary" font-size="12" font-weight="650">Legend</text>`); x += 58;
    for (const k of kinds) {
      const label = (names[k] || k) + (IDS.some((id) => S[id].kind === 'terminal' && N[id].type === k) ? (outcomeNote[k] || '') : '');
      const w = 14 + 5 + unitsW(label, 7.5);
      out.push(`          <g data-legend-semantic-kind="${k}" data-legend-x="${x}" data-legend-baseline="${y}" data-legend-width="${w}"><rect x="${x}" y="${y - 8}" width="14" height="9" rx="2" class="c-${k}" stroke-width="1"/><text x="${x + 19}" y="${y}" class="t-muted" font-size="7.5" font-weight="500">${esc(label)}</text></g>`);
      x += w + 12;
    }
    out.push('        </g>');
  }
  out.push('      </svg>');
  return { markup: out.join('\n'), edges: EDGES, w: Math.ceil(L.W), h: Math.ceil(L.H), vertical };
  }

  /* полный граф + по графу на сценарий (блоки пути и запущенные ими фоновые задачи) */
  const fullGraph = renderGraph(IDS, { withDefs: true, cloneSpawns: false });
  const scenarioIds = (preset) => {
    const ids = new Set(preset.path || []);
    (preset.path || []).forEach((id) => spawnsAll(id).forEach((t) => ids.add(t)));
    return IDS.filter((id) => ids.has(id));
  };
  const graphs = [{ key: 'all', markup: fullGraph.markup, w: fullGraph.w, h: fullGraph.h }].concat(
    FLOW.presets.map((preset, i) => {
      const g = renderGraph(scenarioIds(preset), { withDefs: true });
      /* У каждого графа свои id: иначе маркеры стрелок и градиенты ссылаются на defs
         первого (скрытого) SVG, и наконечники не рисуются вовсе. */
      const prefix = `s${i}-`;
      const markup = g.markup
        .replace(/ id="([^"]+)"/g, (m, v) => ` id="${prefix}${v}"`)
        .replace(/url\(#([^)]+)\)/g, (m, v) => `url(#${prefix}${v})`)
        .replace(/href="#([^"]+)"/g, (m, v) => `href="#${prefix}${v}"`)
        .replace(/aria-labelledby="([^"]+)"/g, (m, v) => `aria-labelledby="${v.split(/\s+/).map((x) => prefix + x).join(' ')}"`);
      return { key: String(i), markup, w: g.w, h: g.h };
    })
  );
  const EDGES = fullGraph.edges;
  /* Графы лежат прямыми детьми контейнера: runtime Archify ищет ':scope > svg', обёртки его ломают. */
  const svg = [
    '      <!-- ARCHIFY:SVG_SLOT_START -->',
    ...graphs.map((g) => g.markup.replace('<svg viewBox=', `<svg data-graph="${g.key}"${g.key === 'all' ? '' : ' hidden'} viewBox=`)),
    '      <!-- ARCHIFY:SVG_SLOT_END -->',
  ].join(String.fromCharCode(10));

  /* ---- guided views из пресетов, карточки, source evidence из file:строка ---- */
  const views = FLOW.presets.map((p, i) => ({ id: `p${i + 1}`, label: pick(p, 'name'), focus: [...new Set([...(p.path || []), ...(p.sub || [])])], note: pick(p, 'note') || pick(p, 'biz') || '' }));
  const entries = IDS.filter((id) => S[id].kind === 'entry');
  const terms = IDS.filter((id) => S[id].kind === 'terminal');
  const attn = IDS.filter((id) => attnOf(S[id]).length);
  const cards = [
    { dot: 'cyan', title: `Входы · ${entries.length}`, items: entries.map((id) => `${pick(S[id], 'title')} — ${pick(S[id], 'code') || ''}`) },
    { dot: 'emerald', title: `Исходы · ${terms.length}`, items: ['ok', 'warn', 'info', 'bad'].flatMap((t) => terms.filter((id) => S[id].outcome === t).map((id) => `${t}: ${pick(S[id], 'title')}`)) },
    { dot: 'rose', title: attn.length ? `Обратить внимание · ${attn.length}` : 'Как читать', items: attn.length ? attn.map((id) => `${pick(S[id], 'title')}: ${attnOf(S[id])[0]}`) : ['Клик по узлу — паспорт шага', 'Guided views сверху — сценарии', 'R — маршрут между шагами'] },
  ];
  const repo = repoInfo();
  const evidenceNodes = {};
  if (repo) {
    for (const id of IDS) {
      const s = S[id]; const refs = [];
      for (const m of String(s.file || '').matchAll(/([^\s:,;]+\.[\p{L}\p{N}]+)(?::(\d+)(?:-(\d+))?)?/gu)) {
        const p = m[1].replace(/\\/g, '/');
        if (!fs.existsSync(path.join(codeRoot, p))) continue;
        const line = m[2] ? Number(m[2]) : undefined, endLine = m[3] ? Number(m[3]) : undefined;
        /* у документов (.md и т.п.) GitHub/GitLab показывают строки только в «сыром» виде */
        const plain = line && /\.(md|markdown|mdx|rst|adoc|asciidoc)$/i.test(p) ? '?plain=1' : '';
        const frag = line ? `${plain}#L${line}${endLine && endLine !== line ? `-${endLine}` : ''}` : '';
        const href = repo.host === 'gitlab' ? `${repo.url}/-/blob/${repo.revision}/${repo.prefix}${p}${frag}` : `${repo.url}/blob/${repo.revision}/${repo.prefix}${p}${frag.replace('-', '-L')}`;
        refs.push({ path: p, line, endLine, href, label: s.anchor ? s.anchor.slice(s.anchor.indexOf('::') + 2) : p.split('/').pop() });
      }
      if (refs.length) evidenceNodes[id] = refs;
    }
  }
  const sourceEvidence = repo && Object.keys(evidenceNodes).length ? { verified: true, repository: { url: repo.url, revision: repo.revision, shortRevision: repo.shortRevision }, nodes: evidenceNodes } : null;

  let html = applyTemplate(template, {
    title: pick(FLOW, 'name'),
    subtitle: `${pick(FLOW, 'entry')} · ${plural(views.length, 'сценарий', 'сценария', 'сценариев')}`,
    svg,
    cards: `    <!-- ARCHIFY:CARDS_SLOT_START -->\n${renderCards(cards)}\n    <!-- ARCHIFY:CARDS_SLOT_END -->`,
    locale: 'en',
    visualPreset: 'classic',
    guidedViews: views,
    sourceEvidence,
  });

  /* ---- паспорт шага: детали из flows/*.json внутри Semantic passport Archify ---- */
  const stepData = {};
  for (const id of IDS) {
    const s = S[id];
    stepData[id] = {
      title: pick(s, 'title') || id, kind: s.kind, actor: s.actor, outcome: s.outcome || null, stage: s.stage || null, todo: pick(s, 'todo') || null,
      code: pick(s, 'code') || null, file: s.file || null, anchor: s.anchor || null,
      what: pick(s, 'what') || '', effects: pick(s, 'effects') || [], note: pick(s, 'note') || null, attention: attnOf(s),
      branches: s.kind === 'branch' ? outs(id).map((b) => ({ to: b.to, toTitle: pick(S[b.to], 'title') || b.to, short: pick(b, 'short') || '', label: pick(b, 'label') || '', cond: b.cond || '', tone: b.tone || 'ok', paused: !!b.paused })) : [],
      next: s.kind !== 'branch' ? outs(id).map((b) => ({ to: b.to, toTitle: pick(S[b.to], 'title') || b.to })) : [],
      spawns: spawns(id).map((t) => ({ to: t, toTitle: pick(S[t], 'title') || t })),
      incoming: EDGES.filter((e) => e.to === id).map((e) => ({ from: e.from, fromTitle: pick(S[e.from], 'title'), spawn: !!e.spawn })),
    };
  }
  const chains = FLOW.presets.map((p) => ({ name: pick(p, 'name'), note: pick(p, 'note') || pick(p, 'biz') || '', path: p.path || [], sub: p.sub || [] }));
  const inject = fs.readFileSync(path.join(kitRoot, 'engine/passport-inject.html'), 'utf8')
    .replace('/*__STEPS__*/{}', () => safe(stepData))
    .replace('/*__CHAINS__*/[]', () => safe(chains))
    .replace('/*__ROOT__*/""', () => safe(FLOW.root))
    .replaceAll('/*__START_ZOOM__*/1.25', () => String(cfg.startZoom ?? 1.25))
    .replace('/*__PX_PER_UNIT__*/0', () => String(cfg.pxPerUnit ?? 0))
    .replace('/*__STAGES__*/{}', () => safe(FLOW.stages || {}))
    .replace('/*__ACTORS__*/{}', () => safe(ACTOR_NAME));
  html = html.replace(/<\/body>/, () => `${inject}\n  </body>`);
  /* «назад» — к главной проекта карт: в левом верхнем углу, перед заголовком флоу */
  html = html.replace('<div class="pulse-dot"></div>', () => `<a class="sm-back" href="index.html" title="Все карты проекта">← Все карты</a>\n        <div class="pulse-dot"></div>`)
    .replace('</head>', () => `<style>
    .sm-back { flex: none; display: inline-flex; align-items: center; min-height: 2.25rem; padding: .375rem .75rem; border-radius: .625rem;
      border: 1px solid var(--toolbar-border); background: var(--toolbar-bg); color: var(--toolbar-text); font-size: .75rem; font-weight: 500;
      text-decoration: none; white-space: nowrap; box-shadow: 0 4px 14px rgba(0, 0, 0, .08); }
    .sm-back:hover { background: var(--toolbar-hover); }
  </style>
</head>`);
  const outPath = path.join(outDir, `${flowId}.full.html`);
  fs.writeFileSync(outPath, html);
  buildSummary.push({ id: flowId, name: pick(FLOW, 'name'), group: FLOW.group || 'other', order: FLOW.order ?? 999, what: pick(FLOW, 'what') || '', entry: pick(FLOW, 'entry') || '', steps: IDS.length, edges: EDGES.length, scenarios: views.length, attention: attn.length, file: `${flowId}.full.html`, anchors: IDS.map((id) => S[id].anchor).filter(Boolean) });
  console.log(`${path.relative(process.cwd(), outPath)}
  ${plural(IDS.length, 'блок', 'блока', 'блоков')} · ${plural(EDGES.length, 'переход', 'перехода', 'переходов')} · ${plural(views.length, 'сценарий', 'сценария', 'сценариев')} · граф ${fullGraph.w}×${fullGraph.h} · ссылки на источник: ${Object.keys(evidenceNodes).length} · ${(html.length / 1024).toFixed(0)} KB`);
}

/* Репозиторий для ссылок «открыть в GitLab/GitHub» из паспорта: repository из конфига, иначе git в codeRoot. */
let repoCache;
function repoInfo() {
  if (repoCache !== undefined) return repoCache;
  repoCache = null;
  const conf = PROJECT.repository;
  if (conf === false) return repoCache;   /* repository: false — ссылки на код не строить */
  const git = (cmd) => execSync(cmd, { cwd: codeRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    let url = conf && conf.url, revision = conf && conf.revision, prefix = (conf && conf.path) || '';
    if (!url) {
      url = git('git remote get-url origin');
      prefix = path.relative(git('git rev-parse --show-toplevel'), codeRoot).replace(/\\/g, '/');
    }
    if (!revision) revision = git('git rev-parse HEAD');
    url = url.replace(/\.git$/, '').replace(/^git@([^:]+):/, 'https://$1/').replace(/\/$/, '');
    if (prefix && !prefix.endsWith('/')) prefix += '/';
    repoCache = { url, revision, prefix, shortRevision: String(revision).slice(0, 8), host: (conf && conf.host) || (/gitlab/i.test(url) ? 'gitlab' : 'github') };
  } catch { repoCache = null; }
  return repoCache;
}

const buildSummary = [];
const force = ARGS.horizontal ? 'horizontal' : ARGS.vertical ? 'vertical' : null;
const ids = ARG_IDS;
const allIds = listFlows(PROJECT);
if (!allIds.length) { console.error(`в ${flowsDir} нет ни одного флоу (*.json)`); process.exit(1); }
fs.mkdirSync(outDir, { recursive: true });
for (const id of (ids.length ? ids : allIds)) {
  if (!fs.existsSync(path.join(flowsDir, `${id}.json`))) { console.error(`нет файла ${path.join(flowsDir, id + '.json')}`); process.exitCode = 1; continue; }
  try { build(id, force); }
  catch (e) { console.error(`флоу "${id}": ${e.message}`); process.exitCode = 1; }
}

/* ---- главная страница: карты по разделам (groups) + покрытие входных точек (entrypoints) ---- */
if (!ids.length && buildSummary.length) {
  const groups = PROJECT.groups.length ? PROJECT.groups : [{ id: 'other', title: 'Флоу' }];
  const groupIds = groups.map((g) => g.id);
  buildSummary.forEach((f) => { if (!groupIds.includes(f.group)) validationErrors.push(`${f.id}: раздел «${f.group}» не описан в groups конфига`); });

  /* Покрытие: входная точка описана, если хоть у одного шага любого флоу anchor совпал с её anchor. */
  const EP = PROJECT.entrypoints || [];
  const anchorsAll = new Set(buildSummary.flatMap((f) => f.anchors));
  EP.forEach((e, i) => {
    if (!e.anchor) validationErrors.push(`entrypoints[${i}] «${e.name || '?'}»: нет anchor`);
    if (e.group && !groupIds.includes(e.group)) validationErrors.push(`entrypoints[${i}] «${e.name || e.anchor}»: раздел «${e.group}» не описан в groups`);
  });
  const epCovered = (e) => anchorsAll.has(e.anchor);
  const stat = (gid) => { const list = EP.filter((e) => (e.group || 'other') === gid); const covered = list.filter(epCovered).length; return list.length ? { total: list.length, covered, open: list.length - covered } : null; };

  const byGroup = {};
  buildSummary.forEach((f) => { (byGroup[f.group] ||= []).push(f); });
  const bar = (covered, total) => `<div class="bar"><i style="width:${total ? Math.round(covered / total * 100) : 0}%"></i></div>`;
  const pointRow = (x) => `<li><code>${esc(x.kind || '•')}</code> ${esc(x.name || x.anchor)}<small>${esc(x.anchor || '')}</small></li>`;
  const details = (title, items) => items.length ? `<details><summary>${esc(title)} (${items.length})</summary><ul class="points">${items.map(pointRow).join('')}</ul></details>` : '';

  const attnTotal = buildSummary.reduce((a, f) => a + f.attention, 0);
  const covTotal = EP.length ? { total: EP.length, covered: EP.filter(epCovered).length } : null;
  /* подписи главной зависят от того, что описывают карты: код (входные точки) или документацию (разделы) */
  const DOCS = PROJECT.mode === 'docs';
  const epWord = DOCS ? ['раздела документации', 'разделов документации'] : ['входной точки', 'входных точек'];
  const totals = (covTotal || attnTotal) ? `<div class="sum">
      ${covTotal ? `<div class="row"><b>${covTotal.covered}</b> из ${covTotal.total} ${covTotal.total % 10 === 1 && covTotal.total % 100 !== 11 ? epWord[0] : epWord[1]} описано${covTotal.total - covTotal.covered ? ` <em>· ${covTotal.total - covTotal.covered} не покрыто</em>` : ''}</div>
      ${bar(covTotal.covered, covTotal.total)}
      <div class="row muted">покрытие считается по привязке шагов (anchor) против списка entrypoints проекта: ${DOCS ? 'какие разделы документации уже объяснены картами' : 'какие входы в код уже описаны картами'}</div>` : ''}
      ${attnTotal ? `<div class="row"><em>⚠ ${plural(attnTotal, 'замечание', 'замечания', 'замечаний')} «обратить внимание»</em> <span class="muted">— возможные ошибки и слабые места; ищите ⚠ на картах</span></div>` : ''}
    </div>` : '';

  const sections = groups.map((g) => {
    const st = stat(g.id), flows = (byGroup[g.id] || []).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
    if (!flows.length && !st) return '';
    const nums = st ? `<b>${st.covered}</b> из ${st.total}${st.open ? ` <em>${st.open} не покрыто</em>` : ''} ${bar(st.covered, st.total)}` : '';
    const empty = st && st.covered ? 'Отдельных флоу нет: покрытые входы описаны шагами флоу других разделов.' : 'Область не описана — ни одного флоу.';
    return `
    <section>
      <h2><span>${esc(g.title || g.id)}<small>${esc(g.hint || '')}</small></span><span class="nums">${nums}</span></h2>
      ${flows.length ? `<div class="cards">${flows.map((f) => `
        <a class="card" href="${f.file}">
          <b>${esc(f.name)}</b>
          <span class="entry">${esc(f.entry)}</span>
          <p>${esc(f.what)}</p>
          <span class="meta">${plural(f.steps, 'блок', 'блока', 'блоков')} · ${plural(f.scenarios, 'сценарий', 'сценария', 'сценариев')} · ${plural(f.edges, 'переход', 'перехода', 'переходов')}${f.attention ? ` · <em>⚠ ${f.attention}</em>` : ''}</span>
        </a>`).join('')}
      </div>` : `<p class="empty">${empty}</p>`}
      ${details(DOCS ? 'Необъяснённые разделы документации' : 'Непокрытые входные точки', EP.filter((e) => (e.group || 'other') === g.id && !epCovered(e)))}
    </section>`;
  }).join('');

  const total = buildSummary.reduce((a, f) => ({ steps: a.steps + f.steps, scenarios: a.scenarios + f.scenarios }), { steps: 0, scenarios: 0 });
  const index = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(PROJECT.title)}</title>
${THEME_HEAD}
<style>
  :root{--bg:#f6f7f9;--panel:#fff;--ink:#0f172a;--muted:#64748b;--line:#e2e8f0;--accent:#0369a1;--warn:#b91c1c;--ok:#16a34a;color-scheme:light}
  :root[data-theme=dark]{--bg:#0b1220;--panel:#111a2b;--ink:#e6edf7;--muted:#8b99b3;--line:#1f2b40;--accent:#38bdf8;--warn:#f87171;--ok:#4ade80;color-scheme:dark}${CHROME_CSS}
  html,body{margin:0;background:var(--bg);color:var(--ink);font-family:'JetBrains Mono',ui-monospace,Menlo,Consolas,monospace}
  body{padding:0 32px 48px}
  @media (max-width:640px){body{padding:0 16px 40px}}
  h1{margin:0 0 6px;font-size:1.3rem}
  .sub{color:var(--muted);font-size:.8rem;margin-bottom:18px;line-height:1.5}
  em{font-style:normal;color:var(--warn)}
  .muted{color:var(--muted)}
  .mode{display:inline-block;margin-right:8px;padding:1px 8px;border:1px solid var(--line);border-radius:999px;color:var(--accent);font-size:.7rem}
  .sum{border:1px solid var(--line);border-radius:12px;background:var(--panel);padding:14px 16px;margin-bottom:28px;font-size:.8rem;display:flex;flex-direction:column;gap:6px}
  .sum .row b{font-size:1.1rem}
  .bar{height:6px;border-radius:3px;background:var(--line);overflow:hidden;min-width:120px}
  .bar i{display:block;height:100%;background:var(--ok)}
  section{margin:0 0 30px}
  h2{font-size:.95rem;margin:0 0 12px;display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap}
  h2 small{color:var(--muted);font-size:.72rem;font-weight:400;margin-left:12px}
  h2 .nums{font-size:.74rem;font-weight:400;display:flex;align-items:center;gap:8px}
  .cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(320px,100%),1fr));gap:12px}
  .card{display:flex;flex-direction:column;gap:6px;padding:14px 16px;border:1px solid var(--line);border-radius:12px;background:var(--panel);color:inherit;text-decoration:none;transition:border-color .15s,transform .15s}
  .card:hover{border-color:var(--accent);transform:translateY(-1px)}
  .card b{font-size:.92rem;line-height:1.3}
  .card .entry{font-size:.68rem;color:var(--accent);word-break:break-all}
  .card p{margin:0;font-size:.74rem;line-height:1.5;color:var(--muted);display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}
  .card .meta{font-size:.68rem;color:var(--muted);margin-top:auto;padding-top:4px}
  .empty{font-size:.76rem;color:var(--muted);margin:0}
  details{margin-top:10px;font-size:.74rem}
  summary{cursor:pointer;color:var(--accent)}
  .points{list-style:none;margin:8px 0 0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(min(360px,100%),1fr));gap:4px 16px}
  .points li{display:flex;gap:8px;align-items:baseline;padding:2px 0;border-bottom:1px dashed var(--line)}
  .points code{color:var(--muted);min-width:44px}
  .points small{margin-left:auto;color:var(--muted);font-size:.66rem;text-align:right;word-break:break-all}
  footer{margin-top:40px;font-size:.68rem;color:var(--muted)}
</style></head><body>
${chromeHeader({ back: PROJECT.back, brand: 'сценарные карты' })}
<h1>${esc(PROJECT.title)}</h1>
<div class="sub"><span class="mode">${DOCS ? 'карта по документации' : 'карта кода'}</span>${PROJECT.description ? esc(PROJECT.description) + '<br>' : ''}${plural(buildSummary.length, 'карта', 'карты', 'карт')} · ${plural(total.steps, 'блок', 'блока', 'блоков')} · ${plural(total.scenarios, 'сценарий', 'сценария', 'сценариев')}.
Каждая карта: селектор сценариев (первый пункт — всё дерево), клик по блоку — путь до него и паспорт справа, кнопка «Сводка».</div>
${totals}
${sections}
<footer>Собрано scenario-map-kit</footer>
${CHROME_SCRIPT}
</body></html>`;
  fs.writeFileSync(path.join(outDir, 'index.html'), index);
  console.log(`${path.relative(process.cwd(), path.join(outDir, 'index.html'))}\n  главная: ${plural(buildSummary.length, 'карта', 'карты', 'карт')}${EP.length ? `, покрытие ${covTotal.covered}/${covTotal.total} ${epWord[1]}` : ''}`);
}

/* ---- итог самопроверки данных ---- */
if (validationErrors.length) {
  console.error(`\nОшибки данных (${validationErrors.length}):\n` + validationErrors.map((e) => '  ' + e).join('\n'));
  process.exitCode = 1;
} else if (buildSummary.length) {
  const total = buildSummary.reduce((a, f) => ({ steps: a.steps + f.steps, scenarios: a.scenarios + f.scenarios }), { steps: 0, scenarios: 0 });
  console.log(`\nСамопроверка: ${buildSummary.length} флоу, ${plural(total.steps, 'шаг', 'шага', 'шагов')}, ${plural(total.scenarios, 'сценарий', 'сценария', 'сценариев')} — данные целостны`);
}
