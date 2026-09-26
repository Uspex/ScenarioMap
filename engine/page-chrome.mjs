/* Шапка страниц-оглавлений (главная проекта карт, витрина демо): кнопка «назад» и переключатель темы.

   Тема хранится под тем же ключом, что и у карт Archify (localStorage 'archify-theme'), и ставится
   атрибутом data-theme на <html> — выбор на главной сохраняется на картах и обратно. Без сохранённого
   выбора тема берётся из системы; ?theme=light|dark в адресе важнее всего, как и у Archify.

   Кнопка «назад»: ссылка, если адрес известен (config.back у проекта), иначе history.back() — и она
   видна, только когда есть куда возвращаться. */
import { esc } from '../vendor/archify/renderers/shared/utils.mjs';

/* Скрипт в <head> до первой отрисовки — без вспышки не той темы. */
export const THEME_HEAD = `<script>
(function () {
  var t = null;
  try { var p = new URLSearchParams(location.search).get('theme'); if (p === 'light' || p === 'dark') t = p; } catch (_) {}
  if (!t) { try { t = localStorage.getItem('archify-theme'); } catch (_) {} }
  if (t !== 'light' && t !== 'dark') t = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', t);
})();
</script>`;

export const CHROME_CSS = `
  .top{position:sticky;top:0;z-index:10;display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 -32px 24px;padding:12px 32px;background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:blur(8px);border-bottom:1px solid var(--line)}
  @media (max-width:640px){.top{margin:0 -16px 20px;padding:10px 16px}}
  .top-l,.top-r{display:flex;align-items:center;gap:8px;min-width:0}
  .top .brand{font-size:.74rem;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .btn{display:inline-flex;align-items:center;gap:6px;min-height:36px;padding:0 12px;border:1px solid var(--line);border-radius:10px;background:var(--panel);color:var(--ink);font:inherit;font-size:.74rem;text-decoration:none;cursor:pointer;white-space:nowrap}
  .btn:hover{border-color:var(--accent);color:var(--accent)}
  .btn:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
  .btn[hidden]{display:none}`;

/* back: { href, label } — ссылка; null — history.back(); false — без кнопки (стартовая страница).
   brand — подпись рядом с кнопкой. */
export function chromeHeader({ back = null, brand = '' } = {}) {
  const backBtn = back === false ? '' : back && back.href
    ? `<a class="btn" href="${esc(back.href)}">← ${esc(back.label || 'Назад')}</a>`
    : `<button class="btn" type="button" id="sm-back" hidden>← Назад</button>`;
  return `<header class="top">
  <div class="top-l">${backBtn}${brand ? `<span class="brand">${esc(brand)}</span>` : ''}</div>
  <div class="top-r"><button class="btn" type="button" id="sm-theme" aria-label="Сменить тему">◐ <span id="sm-theme-label">Тема</span></button></div>
</header>`;
}

export const CHROME_SCRIPT = `<script>
(function () {
  var html = document.documentElement, btn = document.getElementById('sm-theme'), label = document.getElementById('sm-theme-label');
  function show() { var dark = html.getAttribute('data-theme') === 'dark'; label.textContent = dark ? 'Тёмная' : 'Светлая'; btn.setAttribute('aria-pressed', dark ? 'false' : 'true'); }
  btn.addEventListener('click', function () {
    var next = html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    html.setAttribute('data-theme', next);
    try { localStorage.setItem('archify-theme', next); } catch (_) {}
    show();
  });
  show();
  var back = document.getElementById('sm-back');
  if (back && (history.length > 1 || document.referrer)) { back.hidden = false; back.addEventListener('click', function () { history.back(); }); }
})();
</script>`;
