#!/usr/bin/env node
/* Каркас проекта карт и новых флоу.

   node bin/init.mjs <каталог> [--title="Мой проект"] [--code-root=..] [--mode=code|docs]
                                                                         новый проект: конфиг + пример флоу
   node bin/init.mjs <каталог> --flow=<id> [--name="Название"]           добавить в проект заготовку флоу

   --mode=code (по умолчанию) — карты по репозиторию: шаги ссылаются на функции, codeRoot — корень кода.
   --mode=docs — объясняющие карты по документации: шаги ссылаются на разделы .md / .rst / .adoc,
                 codeRoot — корень документации, актёры — люди и роли, а не слои кода.

   Заготовка флоу сразу проходит самопроверку сборщика: вход → развилка → успех / отказ, два сценария.
   Дальше её переписывают по docs/RULES.md. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_NAME, DEFAULT_ACTORS, DOCS_ACTORS, MODES, loadProject, parseArgs } from '../engine/config.mjs';

const kitRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { opts, positional } = parseArgs(process.argv.slice(2));
const dir = path.resolve(positional[0] || '.');
const schemaRel = (from, file) => path.relative(from, path.join(kitRoot, 'schema', file)).replace(/\\/g, '/');

function flowTemplate(id, name, flowsDir, mode) {
  if (mode === 'docs') return docsFlowTemplate(id, name, flowsDir);
  return {
    $schema: schemaRel(flowsDir, 'flow.schema.json'),
    id,
    order: 1,
    name,
    group: 'main',
    tone: 'ok',
    entry: 'POST /api/example',
    what: 'Два-три предложения: о чём флоу, где начинается и чем может закончиться.',
    root: 'in.request',
    strict: true,
    stages: { start: 'Запрос', result: 'Итог' },
    steps: {
      'in.request': { kind: 'entry', actor: 'user', stage: 'start', title: 'Пользователь отправляет запрос', code: 'POST /api/example', what: 'Вход в сценарий: что делает человек или система и какие данные приходят.', next: 'br.valid' },
      'br.valid': {
        kind: 'branch', actor: 'api', stage: 'start', title: 'Данные запроса корректны?', code: 'ExampleController::handle',
        what: 'Проверка входных данных. Условие каждой ветки — дословно из кода.',
        branches: [
          { short: 'да', hint: 'всё заполнено', cond: 'validate(input) === true', to: 'fin.ok', tone: 'ok' },
          { short: 'нет', hint: 'ошибка валидации', cond: 'иначе', to: 'fin.invalid', tone: 'bad' },
        ],
      },
      'fin.ok': { kind: 'terminal', actor: 'api', stage: 'result', outcome: 'ok', title: 'Финиш: запрос выполнен', what: 'Что получил пользователь и что изменилось в системе.', effects: ['HTTP 200'] },
      'fin.invalid': { kind: 'terminal', actor: 'api', stage: 'result', outcome: 'bad', title: 'Отказ 422 — данные не прошли проверку', what: 'Какие поля проверяются и что видит пользователь.', effects: ['HTTP 422'] },
    },
    presets: [
      { name: 'Успешный запрос', tone: 'ok', note: 'основной путь', path: ['in.request', 'br.valid', 'fin.ok'] },
      { name: 'Ошибка в данных', tone: 'bad', note: 'пользователь ошибся в форме', path: ['in.request', 'br.valid', 'fin.invalid'] },
    ],
  };
}

/* Заготовка объясняющего флоу: сценарий из документации «человек хочет X → что происходит → чем кончается». */
function docsFlowTemplate(id, name, flowsDir) {
  return {
    $schema: schemaRel(flowsDir, 'flow.schema.json'),
    id,
    order: 1,
    name,
    group: 'main',
    tone: 'ok',
    entry: 'Пользователь хочет …',
    what: 'Два-три предложения: какую задачу человека объясняет сценарий, по каким разделам документации он собран.',
    root: 'in.goal',
    strict: true,
    stages: { start: 'Начало', work: 'Процесс', result: 'Итог' },
    steps: {
      'in.goal': { kind: 'entry', actor: 'user', stage: 'start', title: 'Пользователь начинает сценарий', code: 'README.md → раздел', what: 'С чего начинается сценарий: цель человека и что у него есть на входе. file — «путь:строка» раздела документации.', next: 'br.ready' },
      'br.ready': {
        kind: 'branch', actor: 'system', stage: 'work', title: 'Условие из документации выполнено?', code: 'раздел документации',
        what: 'Развилка, описанная в документации. cond — дословная цитата правила, а не пересказ.',
        branches: [
          { short: 'да', hint: 'условие выполнено', cond: '«цитата из документации»', to: 'fin.ok', tone: 'ok' },
          { short: 'нет', hint: 'чего не хватает', cond: 'иначе', to: 'fin.stop', tone: 'bad' },
        ],
      },
      'fin.ok': { kind: 'terminal', actor: 'system', stage: 'result', outcome: 'ok', title: 'Финиш: задача решена', what: 'Что получил человек и как это проверить.', effects: ['наблюдаемый результат'] },
      'fin.stop': { kind: 'terminal', actor: 'system', stage: 'result', outcome: 'bad', title: 'Тупик: условие не выполнено', what: 'Что видит человек и что документация советует делать дальше.' },
    },
    presets: [
      { name: 'Основной путь', tone: 'ok', note: 'как задумано документацией', path: ['in.goal', 'br.ready', 'fin.ok'] },
      { name: 'Условие не выполнено', tone: 'bad', note: 'типовая причина остановки', path: ['in.goal', 'br.ready', 'fin.stop'] },
    ],
  };
}

const write = (file, data) => {
  if (fs.existsSync(file)) { console.error(`уже есть, не перезаписываю: ${file}`); process.exitCode = 1; return false; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  console.log(`создан ${path.relative(process.cwd(), file)}`);
  return true;
};

if (opts.flow) {
  const P = loadProject(dir);
  const id = String(opts.flow);
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(id)) { console.error('id флоу — латиница, цифры, - и _'); process.exit(1); }
  const flow = flowTemplate(id, opts.name || id, P.flowsDir, P.mode);
  flow.group = (P.groups[0] && P.groups[0].id) || 'main';
  /* у проекта свои актёры — подставляем первого, чтобы заготовка прошла самопроверку */
  const actorIds = Object.keys(P.actors);
  for (const s of Object.values(flow.steps)) if (!P.actors[s.actor]) s.actor = actorIds[0];
  write(path.join(P.flowsDir, `${id}.json`), flow);
} else {
  const mode = opts.mode === undefined ? 'code' : String(opts.mode);
  if (!MODES.includes(mode)) { console.error(`--mode=${mode}: допустимо ${MODES.join(' | ')}`); process.exit(1); }
  const docs = mode === 'docs';
  const config = {
    $schema: schemaRel(dir, 'config.schema.json'),
    title: opts.title || 'Сценарные карты',
    description: docs ? 'Что это за проект и на какие вопросы читателя отвечают карты.' : 'Что это за система и для кого эти карты.',
    mode,
    flows: 'flows',
    out: 'maps',
    codeRoot: opts['code-root'] || '..',
    groups: [{ id: 'main', title: 'Основные сценарии', hint: 'коротко: что за область' }],
    actors: docs ? DOCS_ACTORS : DEFAULT_ACTORS,
    rules: { requireFile: false },
    scan: { outcomeCodePatterns: docs ? [] : ['status\\((\\d{3})\\)'] },
    entrypoints: [],
  };
  if (write(path.join(dir, CONFIG_NAME), config)) {
    write(path.join(dir, 'flows', 'example.json'), flowTemplate('example', 'Пример флоу', path.join(dir, 'flows'), mode));
    const rel = (path.relative(process.cwd(), dir) || '.').replace(/\\/g, '/');
    const kit = (path.relative(process.cwd(), kitRoot) || '.').replace(/\\/g, '/');
    const outline = docs ? `\n  node ${kit}/bin/scan.mjs --project=${rel} --outline   # оглавление документации` : '';
    console.log(`\nДальше:${outline}\n  node ${kit}/bin/build.mjs --project=${rel}\n  открыть ${rel}/maps/index.html`);
  }
}
