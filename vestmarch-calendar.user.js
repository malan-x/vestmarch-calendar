// ==UserScript==
// @name         Вестмарш — календарь игр
// @namespace    https://vestmarch.noncensored.ru/
// @version      1.2.0
// @description  Лента-календарь над списком игр. Игры, на которые вы записаны, подсвечены и вынесены наверх.
// @homepageURL  https://malan-x.github.io/vestmarch-calendar/
// @updateURL    https://malan-x.github.io/vestmarch-calendar/vestmarch-calendar.user.js
// @downloadURL  https://malan-x.github.io/vestmarch-calendar/vestmarch-calendar.user.js
// @match        https://vestmarch.noncensored.ru/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

(function () {
  'use strict';
  if (location.hostname !== 'vestmarch.noncensored.ru') return;
  if (window.__vmcalLoaded) return; // защита от повторного запуска (скрипт + закладка)
  window.__vmcalLoaded = true;

  // ---------- настройки ----------
  const MIN_DAYS = 7;          // лента показывает минимум столько дней от сегодняшнего
  const MAX_DAYS = 45;         // и не больше столько
  const SHOW_IMAGES = true;    // обложки игр в карточках (уменьшенные, ~30 КБ каждая)
  const REFRESH_MS = 60_000;   // при возврате на вкладку обновлять данные не чаще раза в минуту

  const ROOT_ID = 'vmcal';
  const STYLE_ID = 'vmcal-style';
  const HYDRATION_FALLBACK_MS = 3000;
  const STATUS_LABEL = { open: 'Запись открыта', closed: 'Запись закрыта', done: 'Сыграно' };

  const fmtTime = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const fmtDow = new Intl.DateTimeFormat('ru-RU', { weekday: 'short' });
  const fmtDate = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit' });

  const startedAt = Date.now();
  let cache = null;       // { games, mine: Map<gameId, signup>, loggedIn, at }
  let loading = null;
  let loadError = null;

  // ---------- данные (тот же API, что использует сам сайт) ----------

  // Сервер кодирует Map/Set/undefined как { $backendType: ... } — разворачиваем так же, как клиент сайта.
  function decode(v) {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(decode);
    switch (v.$backendType) {
      case 'undefined': return undefined;
      case 'set': return new Set(v.values.map(decode));
      case 'map': return new Map(v.entries.map(([k, x]) => [decode(k), decode(x)]));
      case 'object': return Object.fromEntries(v.entries.map(([k, x]) => [k, decode(x)]));
      default: return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, decode(x)]));
    }
  }

  async function rpc(method, args) {
    const res = await fetch(`/api/backend/games/${method}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ args }),
    });
    const json = await res.json();
    if (!res.ok || json.error) throw new Error(json.error?.message || `HTTP ${res.status}`);
    return decode(json.data);
  }

  async function fetchUserId() {
    try {
      const res = await fetch('/api/auth/session', { credentials: 'same-origin' });
      if (!res.ok) return null;
      const json = await res.json();
      return json?.user?.id ?? null;
    } catch {
      return null;
    }
  }

  async function load() {
    const [games, userId] = await Promise.all([rpc('FetchGameSessions', []), fetchUserId()]);
    const mine = new Map();
    if (userId) {
      try {
        const signups = await rpc('FetchMyGameSignups', [userId]);
        for (const s of signups || []) if (s && s.gameId) mine.set(s.gameId, s);
      } catch {
        /* без подсветки, но календарь всё равно покажем */
      }
    }
    return { games: Array.isArray(games) ? games : [], mine, loggedIn: !!userId, at: Date.now() };
  }

  function refresh(force) {
    if (loading) return loading;
    if (!force && cache && Date.now() - cache.at < REFRESH_MS) return Promise.resolve(cache);
    loading = load()
      .then((d) => { cache = d; loadError = null; })
      .catch((e) => { loadError = e; })
      .finally(() => { loading = null; render(); });
    return loading;
  }

  // ---------- утилиты ----------

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid instanceof Node ? kid : String(kid));
    }
    return el;
  }

  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const dayKey = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  const byStart = (a, b) => a.startsAt.localeCompare(b.startsAt);

  function levelText(g) {
    return g.levelMax == null || g.levelMax === g.levelMin ? `${g.levelMin}` : `${g.levelMin}–${g.levelMax}`;
  }

  function priceText(p) {
    return p == null ? null : p === 0 ? 'бесплатно' : `${p} ₽`;
  }

  function imageUrl(g) {
    const src = Array.isArray(g.images) ? g.images[0] : null;
    if (!src) return null;
    const m = /^storage:\/\/([^/]+)\/(.+)$/.exec(src);
    const pub = m ? `/api/storage/public/${m[1]}/${m[2]}` : src;
    if (!pub.startsWith('/')) return pub;
    // ресайзер Next.js: исходники по 2–3 МБ, превью ~30 КБ
    return `/_next/image?url=${encodeURIComponent(pub)}&w=384&q=75`;
  }

  function mineLabel(s) {
    const name = (s.characterName || '').trim();
    return name ? `Вы записаны · ${name}` : 'Вы записаны';
  }

  function mineTitle(s) {
    const name = (s.characterName || '').trim();
    const summary = (s.characterSummary || '').trim();
    return [name, summary && `(${summary})`].filter(Boolean).join(' ') || 'Вы записаны';
  }

  // Переход без перезагрузки: кликаем по «родной» ссылке Next.js, если она есть на странице.
  function spaNavigate(e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const href = e.currentTarget.getAttribute('href');
    const native = document.querySelector(`a.game-card-link[href="${CSS.escape(href)}"]`);
    if (native) {
      e.preventDefault();
      native.click();
    }
  }

  // ---------- отрисовка ----------

  function buildCard(g, signup) {
    const start = new Date(g.startsAt);
    const href = `/games/${g.id}`;
    const img = SHOW_IMAGES ? imageUrl(g) : null;
    const meta = [g.masterName, `ур. ${levelText(g)}`, priceText(g.priceRub)].filter(Boolean).join(' · ');
    return h('a', {
      class: `vmcal-card status-${g.status}${signup ? ' is-mine' : ''}`,
      href,
      title: g.title,
      onclick: spaNavigate,
    },
      img && h('img', {
        class: 'vmcal-thumb', src: img, alt: '', loading: 'lazy', decoding: 'async',
        onerror: (e) => e.currentTarget.remove(),
      }),
      h('div', { class: 'vmcal-card-body' },
        h('div', { class: 'vmcal-card-top' },
          h('span', { class: 'vmcal-time' }, fmtTime.format(start)),
          h('span', { class: `vmcal-status status-${g.status}` }, STATUS_LABEL[g.status] || g.status),
        ),
        h('div', { class: 'vmcal-card-title' }, g.title, g.isTest ? h('span', { class: 'muted tiny' }, ' · тест') : null),
        h('div', { class: 'vmcal-card-meta' }, meta),
        signup && h('div', { class: 'vmcal-card-mine', title: mineTitle(signup) }, `✓ ${mineLabel(signup)}`),
      ),
    );
  }

  function buildHead(upcoming, strip) {
    let mineNode;
    if (!cache.loggedIn) {
      mineNode = h('span', { class: 'muted tiny' }, h('a', { href: '/auth' }, 'Войдите'), ', чтобы ваши записи подсвечивались');
    } else {
      const my = upcoming.filter((g) => cache.mine.has(g.id) && g.status !== 'done');
      mineNode = my.length === 0
        ? h('span', { class: 'muted tiny' }, 'Вы пока никуда не записаны')
        : [h('span', { class: 'vmcal-mine-label' }, 'Мои игры:'), ...my.map((g) => {
          const d = new Date(g.startsAt);
          return h('a', {
            class: 'vmcal-chip', href: `/games/${g.id}`, title: mineTitle(cache.mine.get(g.id)), onclick: spaNavigate,
          }, h('b', null, `${fmtDow.format(d)} ${fmtDate.format(d)}, ${fmtTime.format(d)}`), ` ${g.title}`);
        })];
    }
    const scrollBy = (dir) => strip.scrollBy({ left: dir * Math.max(200, strip.clientWidth * 0.8), behavior: 'smooth' });
    return h('div', { class: 'vmcal-head' },
      h('h2', { class: 'vmcal-title' }, 'Календарь'),
      h('div', { class: 'vmcal-mine' }, mineNode),
      h('div', { class: 'vmcal-nav' },
        h('button', { type: 'button', 'aria-label': 'Назад', title: 'Назад', onclick: () => scrollBy(-1) }, '‹'),
        h('button', { type: 'button', 'aria-label': 'Вперёд', title: 'Вперёд', onclick: () => scrollBy(1) }, '›'),
      ),
    );
  }

  function buildStrip(upcoming, today) {
    const byDay = new Map();
    for (const g of upcoming) {
      const k = dayKey(new Date(g.startsAt));
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k).push(g);
    }
    const last = startOfDay(new Date(upcoming[upcoming.length - 1].startsAt));
    const span = Math.round((last - today) / 86_400_000) + 1;
    const total = Math.min(MAX_DAYS, Math.max(MIN_DAYS, span));

    const days = [];
    for (let i = 0; i < total; i++) {
      const d = addDays(today, i);
      const games = (byDay.get(dayKey(d)) || []).slice().sort((a, b) => {
        const am = cache.mine.has(a.id) ? 0 : 1;
        const bm = cache.mine.has(b.id) ? 0 : 1;
        return am - bm || byStart(a, b);
      });
      const dow = d.getDay();
      const cls = ['vmcal-day'];
      if (i === 0) cls.push('is-today');
      if (dow === 0 || dow === 6) cls.push('is-weekend');
      if (games.length === 0) cls.push('is-empty');
      if (games.some((g) => cache.mine.has(g.id))) cls.push('has-mine');
      days.push(h('li', { class: cls.join(' ') },
        h('div', { class: 'vmcal-day-head' },
          h('span', { class: 'vmcal-dow' }, fmtDow.format(d)),
          h('span', { class: 'vmcal-date' }, fmtDate.format(d)),
          i === 0 ? h('span', { class: 'vmcal-rel' }, 'сегодня') : i === 1 ? h('span', { class: 'vmcal-rel' }, 'завтра') : null,
        ),
        h('div', { class: 'vmcal-day-body' }, games.map((g) => buildCard(g, cache.mine.get(g.id)))),
      ));
    }
    return h('ol', { class: 'vmcal-strip', 'aria-label': 'Ближайшие игры по дням' }, days);
  }

  function build() {
    if (!cache) {
      const msg = loadError ? `Календарь: не удалось загрузить игры (${loadError.message})` : 'Календарь: загружаю игры…';
      return [h('p', { class: 'muted tiny vmcal-note' }, msg)];
    }
    const today = startOfDay(new Date());
    const upcoming = cache.games.filter((g) => new Date(g.startsAt) >= today).sort(byStart);
    if (upcoming.length === 0) {
      return [h('p', { class: 'muted tiny vmcal-note' }, 'Календарь: ближайших игр нет.')];
    }
    const strip = buildStrip(upcoming, today);
    return [buildHead(upcoming, strip), strip];
  }

  function render() {
    const root = document.getElementById(ROOT_ID);
    if (!root) return;
    const oldStrip = root.querySelector('.vmcal-strip');
    const scroll = oldStrip ? oldStrip.scrollLeft : 0;
    root.replaceChildren(...build());
    const strip = root.querySelector('.vmcal-strip');
    if (strip && scroll) strip.scrollLeft = scroll;
  }

  // ---------- встраивание в страницу ----------

  const isGamesPage = () => location.pathname.replace(/\/+$/, '') === '/games';

  // Ждём, пока React «оживит» страницу: вставка до гидратации приведёт к перерисовке и потере блока.
  // Список игр (.games-section) появляется только после загрузки данных на клиенте, т.е. уже после гидратации.
  const pageReady = () =>
    !!document.querySelector('.games-section, .world-tag-filters') || Date.now() - startedAt > HYDRATION_FALLBACK_MS;

  function ensure() {
    const existing = document.getElementById(ROOT_ID);
    if (!isGamesPage()) {
      if (existing) existing.remove();
      return;
    }
    const head = document.querySelector('main section.panel > .games-head');
    if (!head || !pageReady()) return;
    const panel = head.parentElement;
    if (existing && existing.nextElementSibling === panel) return;
    if (existing) {
      panel.before(existing); // React пересоздал панель — переставляем ленту, не перерисовывая
      return;
    }
    panel.before(h('section', { id: ROOT_ID, class: 'vmcal' }));
    render();
    refresh(false);
  }

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    document.head.append(h('style', { id: STYLE_ID }, CSS_TEXT));
  }

  let scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      ensure();
    });
  }

  const onReturn = () => {
    if (document.visibilityState === 'visible' && isGamesPage() && document.getElementById(ROOT_ID)) refresh(false);
  };

  // Цвета берём из переменных темы сайта — так блок сам подстраивается под светлую и тёмную тему.
  const CSS_TEXT = `
/* Лента стоит первой внутри <main> над панелью «Игры». Пока она есть, <main> растягивается на всю ширину,
   а остальное содержимое остаётся прежней ширины (960px) по центру. */
main.main:has(> #vmcal) { width: 100%; }
main.main:has(> #vmcal) > :not(#vmcal) { width: min(960px, 100% - 2rem); margin-inline: auto; }
#vmcal { margin: 0 clamp(.5rem, 1.5vw, 1.5rem) 1.25rem; padding: .9rem 1rem .6rem; background: var(--surface);
  border: 1px solid var(--line); border-radius: var(--radius, 12px); box-shadow: var(--shadow, none); }
.vmcal-head { display: flex; flex-wrap: wrap; align-items: center; gap: .45rem .75rem; margin-bottom: .6rem; }
.vmcal-title { margin: 0; font-family: Fraunces, Georgia, serif; font-size: 1.05rem; }
.vmcal-mine { display: flex; flex-wrap: wrap; align-items: center; gap: .35rem; flex: 1 1 18rem; min-width: 0; }
.vmcal-mine-label { font-size: .8rem; font-weight: 600; color: var(--ink-soft); }
.vmcal-chip { display: inline-flex; align-items: baseline; gap: .3rem; max-width: 100%; padding: .2rem .65rem;
  border-radius: 999px; border: 1px solid var(--status-open-border, rgba(47,107,79,.15));
  background: var(--status-open-soft, rgba(47,107,79,.1)); color: var(--ink); font-size: .8rem;
  text-decoration: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.vmcal-chip b { color: var(--status-open, #2f6b4f); }
.vmcal-chip:hover { border-color: var(--status-open, #2f6b4f); }
.vmcal-nav { display: flex; gap: .3rem; margin-left: auto; }
.vmcal-nav button { width: 2rem; height: 2rem; padding: 0; border-radius: 999px; border: 1px solid var(--line);
  background: var(--control-bg-strong, transparent); color: var(--ink); font-size: 1.15rem; line-height: 1; cursor: pointer; }
.vmcal-nav button:hover { border-color: var(--umber); }
.vmcal-strip { list-style: none; margin: 0; padding: 0 0 .55rem; display: flex; align-items: stretch; gap: .5rem;
  overflow-x: auto; overscroll-behavior-x: contain; scroll-snap-type: x proximity; scrollbar-width: thin; }
.vmcal-day { flex: 0 0 auto; width: 12.5rem; display: flex; flex-direction: column; gap: .4rem; scroll-snap-align: start; }
.vmcal-day.is-empty { width: 3.1rem; }
.vmcal-day-head { display: flex; align-items: baseline; gap: .3rem; padding: .3rem .5rem; border-radius: 8px;
  background: var(--surface-muted, rgba(0,0,0,.04)); border: 1px solid var(--line-subtle, transparent);
  font-size: .78rem; color: var(--ink-soft); white-space: nowrap; }
.vmcal-day.is-empty .vmcal-day-head { flex-direction: column; align-items: center; gap: 0; padding: .3rem .2rem; }
.vmcal-dow { font-weight: 700; text-transform: uppercase; letter-spacing: .03em; }
.vmcal-day.is-weekend .vmcal-dow { color: var(--umber); }
.vmcal-date { font-weight: 600; color: var(--ink); }
.vmcal-rel { margin-left: auto; font-size: .72rem; }
.vmcal-day.is-today .vmcal-day-head { border-color: var(--moss); background: var(--accent-soft, rgba(138,148,96,.16)); }
.vmcal-day.has-mine .vmcal-day-head { border-color: var(--status-open, #2f6b4f); }
.vmcal-day-body { display: flex; flex-direction: column; gap: .4rem; flex: 1 1 auto; }
.vmcal-day.is-empty .vmcal-day-body { align-items: center; }
.vmcal-day.is-empty .vmcal-day-body::before { content: ''; flex: 1 1 auto; min-height: 3rem; border-left: 1px dashed var(--line); }
.vmcal-card { display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--line);
  border-radius: var(--radius, 12px); background: var(--card-bg); color: var(--ink); text-decoration: none;
  transition: border-color .15s ease, transform .15s ease; }
.vmcal-card:hover { border-color: var(--umber); transform: translateY(-1px); }
.vmcal-card.is-mine { border: 2px solid var(--status-open, #2f6b4f);
  background: linear-gradient(var(--status-open-soft, rgba(47,107,79,.1)), var(--status-open-soft, rgba(47,107,79,.1))), var(--card-bg); }
.vmcal-card.status-done { opacity: .6; }
.vmcal-thumb { display: block; width: 100%; height: 64px; object-fit: cover; }
.vmcal-card-body { display: grid; gap: .15rem; padding: .45rem .55rem .5rem; min-width: 0; }
.vmcal-card-top { display: flex; justify-content: space-between; align-items: baseline; gap: .4rem; }
.vmcal-time { font-weight: 700; font-size: .92rem; }
.vmcal-status { font-size: .72rem; font-weight: 600; white-space: nowrap; }
.vmcal-status.status-open { color: var(--status-open, #2f6b4f); }
.vmcal-status.status-closed { color: var(--umber); }
.vmcal-status.status-done { color: var(--ink-soft); }
.vmcal-card-title { font-weight: 700; font-size: .92rem; line-height: 1.2; overflow: hidden;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.vmcal-card-meta, .vmcal-card-mine { font-size: .75rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.vmcal-card-meta { color: var(--ink-soft); }
.vmcal-card-mine { font-weight: 700; color: var(--status-open, #2f6b4f); }
.vmcal-note { margin: .5rem 0 0; }
@media (max-width: 720px) {
  main.main:has(> #vmcal) > :not(#vmcal) { width: min(960px, 100% - 1.25rem); }
  #vmcal { margin-inline: .625rem; padding: .7rem .6rem .5rem; }
}
@media (max-width: 640px) {
  .vmcal-day { width: 10.5rem; }
  .vmcal-thumb { height: 52px; }
  .vmcal-nav { display: none; }
}
`;

  injectStyle();
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  document.addEventListener('visibilitychange', onReturn);
  window.addEventListener('focus', onReturn);
  schedule();
})();
