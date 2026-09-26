/* Загрузка проекта карт: scenario-map.config.json + пути относительно него.

   Проект — любой каталог с файлом scenario-map.config.json. Инструмент (этот каталог) лежит где угодно:
   рядом с проектом, в node_modules, в отдельном репозитории. Все пути в конфиге — относительно файла конфига. */
import fs from 'node:fs';
import path from 'node:path';

export const CONFIG_NAME = 'scenario-map.config.json';

/* Откуда берётся правда о системе:
     code — репозиторий: шаги ссылаются на функции и методы, scan следит за правками кода;
     docs — документация (README, вики, регламенты в .md / .rst / .adoc): шаги ссылаются на разделы,
            scan следит за правками текста. В одном проекте file может указывать и туда, и туда. */
export const MODES = ['code', 'docs'];

/* Актёры по умолчанию: id → подпись и цвет Archify (frontend | backend | database | cloud | security | messagebus | external).
   Проект, который объявил свои actors, получает ровно их — без слияния с этим списком.
   DOCS_ACTORS — заготовка init --mode=docs: для объясняющих карт важнее люди и роли, чем слои кода. */
export const DEFAULT_ACTORS = {
  user: { name: 'пользователь', type: 'frontend' },
  app: { name: 'приложение / интерфейс', type: 'frontend' },
  api: { name: 'API', type: 'backend' },
  service: { name: 'сервис', type: 'backend' },
  db: { name: 'база данных', type: 'database' },
  queue: { name: 'очередь / фоновая задача', type: 'messagebus' },
  external: { name: 'внешняя система', type: 'cloud' },
  payment: { name: 'платёжная система', type: 'security' },
};

export const DOCS_ACTORS = {
  user: { name: 'пользователь', type: 'frontend' },
  team: { name: 'команда / сотрудник', type: 'cloud' },
  system: { name: 'система', type: 'backend' },
  data: { name: 'данные / хранилище', type: 'database' },
  process: { name: 'автоматика / фоновый процесс', type: 'messagebus' },
  external: { name: 'внешний сервис', type: 'external' },
};

export const DEFAULT_RULES = {
  /* заголовок финиша у strict-флоу: «Отказ 409 — причина», «Финиш: …», «Тупик: …» или код в начале */
  terminalTitle: '^(Отказ|Финиш|Тупик|\\d{3})',
  /* заголовок развилки у strict-флоу — вопрос */
  branchTitle: '[?]$',
  shortMax: 14,
  hintMax: 34,
  /* true — каждый шаг обязан ссылаться на код (file). Для карт бизнес-процессов без кода — false */
  requireFile: false,
};

export const DEFAULT_LAYOUT = {
  maxVerticalWidth: 3000,
  pxPerUnit: 1.45,
  startZoom: 1,
  rowGap: 52,
  colGap: 28,
  phaseStyle: 'divider',
  phases: [],
};

export function parseArgs(argv) {
  const opts = {}; const positional = [];
  for (const a of argv) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
    if (m) opts[m[1]] = m[2] ?? true; else positional.push(a);
  }
  return { opts, positional };
}

export function loadProject(projectArg) {
  let file = path.resolve(projectArg || process.cwd());
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, CONFIG_NAME);
  if (!fs.existsSync(file)) {
    throw new Error(`не найден ${CONFIG_NAME}: ${file}\nУкажи --project=<каталог с конфигом> или создай проект: node bin/init.mjs <каталог>`);
  }
  const dir = path.dirname(file);
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  const rel = (p, def) => path.resolve(dir, p ?? def);
  let groups = config.groups ?? [];
  if (typeof groups === 'string') groups = JSON.parse(fs.readFileSync(rel(groups), 'utf8'));
  let entrypoints = config.entrypoints ?? [];
  if (typeof entrypoints === 'string') entrypoints = fs.existsSync(rel(entrypoints)) ? JSON.parse(fs.readFileSync(rel(entrypoints), 'utf8')) : [];
  const mode = config.mode ?? 'code';
  if (!MODES.includes(mode)) throw new Error(`${file}: mode="${mode}" — допустимо ${MODES.join(' | ')}`);
  return {
    file,
    dir,
    config,
    mode,
    title: config.title || 'Сценарные карты',
    description: config.description || '',
    flowsDir: rel(config.flows, 'flows'),
    outDir: rel(config.out, 'maps'),
    codeRoot: rel(config.codeRoot, '.'),
    repository: config.repository ?? null,
    /* кнопка «назад» на главной проекта: { href, label }; без неё — возврат по истории браузера */
    back: config.back ?? null,
    groups,
    entrypoints,
    actors: config.actors || DEFAULT_ACTORS,
    rules: Object.assign({}, DEFAULT_RULES, config.rules || {}),
    layout: Object.assign({}, DEFAULT_LAYOUT, config.layout || {}),
    scan: Object.assign({ outcomeCodePatterns: [] }, config.scan || {}),
  };
}

export function listFlows(project) {
  if (!fs.existsSync(project.flowsDir)) return [];
  return fs.readdirSync(project.flowsDir).filter((f) => f.endsWith('.json') && !f.startsWith('_')).map((f) => f.replace(/\.json$/, '')).sort();
}
