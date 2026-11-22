// ==UserScript==
// @name         Вестмарш — календарь игр
// @namespace    https://vestmarch.noncensored.ru/
// @version      1.10.0
// @description  Лента-календарь над списком игр (свои игры, отметки «занят», накладки) и на странице «Простой» — подсказки в карточках проектов (проверка или вклад), кнопка «Влить все ОД», пустая «История ручных изменений» скрыта. Звёздочки у пунктов меню — избранное в шапке.
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
  const VM_GAME_HOURS = 4;     // сайт не отдаёт длительность игр — для поиска накладок считаем столько часов
  const DEFAULT_OWN_HOURS = 4; // длительность своей игры по умолчанию
  const OWN_KEY = 'vmcal.own.v1'; // свои игры хранятся в localStorage этого сайта, только в этом браузере

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

  const rpc = (method, args) => rpcNs('games', method, args);

  async function rpcNs(ns, method, args) {
    const res = await fetch(`/api/backend/${ns}/${method}`, {
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

  // ---------- свои игры: хранятся только в этом браузере ----------
  // { entries: [{ id, kind, title, master, place, desc, image, hours, sessions: [{ id, date, time, hours, every, until, skip }] }], lastKind }
  // Ваншот — запись ровно с одной сессией, заводится одним окном. Модуль и кампания сперва заводятся отдельно
  // (название, описание, картинка), потом к ним добавляются только сессии: выбрал из списка и поставил время.
  // Картинка — уменьшенный JPEG в data:-URL (~20–40 КБ), чтобы всё жило в localStorage.

  const KINDS = ['oneshot', 'module', 'campaign'];
  const KIND_LABEL = { oneshot: 'ваншот', module: 'модуль', campaign: 'кампания' };
  const KIND_TITLE = { oneshot: 'Ваншот', module: 'Модуль', campaign: 'Кампания' };
  const KIND_ACC = { oneshot: 'ваншот', module: 'модуль', campaign: 'кампанию' }; // «удалить кого/что»
  const REPEAT_LABEL = ['Не повторять', 'Каждую неделю', 'Раз в 2 недели', 'Раз в 3 недели', 'Раз в 4 недели'];
  const REPEAT_SHORT = ['', 'каждую неделю', 'раз в 2 недели', 'раз в 3 недели', 'раз в 4 недели'];
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const TIME_RE = /^\d{2}:\d{2}$/;
  const IMAGE_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
  const CROP_W = 480; // картинка своей игры хранится ровно в пропорции миниатюры на карточке (3:1)
  const CROP_H = 160;
  const CROP_MAX_ZOOM = 5;
  const DESC_MAX = 1000;

  const newId = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const clampHours = (x) => {
    const n = Number(x);
    return Number.isFinite(n) && n > 0 ? Math.min(24, Math.max(0.5, Math.round(n * 2) / 2)) : DEFAULT_OWN_HOURS;
  };
  const cleanText = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

  function normSession(x, fallbackHours) {
    const time = typeof x?.time === 'string' ? x.time.slice(0, 5) : '';
    if (!x || !DATE_RE.test(x.date) || !TIME_RE.test(time)) return null;
    const every = [0, 1, 2, 3, 4].includes(x.every) ? x.every : 0;
    return {
      id: typeof x.id === 'string' ? x.id : newId(),
      date: x.date,
      time,
      hours: clampHours(x.hours ?? fallbackHours),
      every,
      until: every && DATE_RE.test(x.until || '') ? x.until : '',
      skip: every && Array.isArray(x.skip) ? x.skip.filter((d) => DATE_RE.test(d)) : [],
      place: cleanText(x.place, 80), // пусто — место кампании/модуля по умолчанию
    };
  }

  function normEntry(x) {
    if (!x || !KINDS.includes(x.kind)) return null;
    const title = cleanText(x.title, 80);
    if (!title) return null;
    const hours = clampHours(x.hours);
    const sessions = (Array.isArray(x.sessions) ? x.sessions : []).map((s) => normSession(s, hours)).filter(Boolean);
    if (x.kind === 'oneshot' && sessions.length === 0) return null;
    return {
      id: typeof x.id === 'string' ? x.id : newId(),
      kind: x.kind,
      title,
      master: cleanText(x.master, 60),
      place: cleanText(x.place, 80),
      desc: cleanText(x.desc, DESC_MAX),
      image: typeof x.image === 'string' && x.image.length < 400_000 && IMAGE_RE.test(x.image) ? x.image : '',
      hours,
      sessions: x.kind === 'oneshot' ? sessions.slice(0, 1) : sessions,
    };
  }

  // Отметка «занят»: { id, from, to, note }; to пусто — один день. Дни сравниваем строками YYYY-MM-DD.
  function normBusy(x) {
    if (!x || !DATE_RE.test(x.from)) return null;
    const to = DATE_RE.test(x.to || '') && x.to > x.from ? x.to : '';
    return { id: typeof x.id === 'string' ? x.id : newId(), from: x.from, to, note: cleanText(x.note, 120) };
  }
  const busyOn = (busy, dayIso) => busy.find((b) => b.from <= dayIso && dayIso <= (b.to || b.from)) || null;

  function loadOwn() {
    try {
      const raw = JSON.parse(localStorage.getItem(OWN_KEY) || 'null');
      const entries = (Array.isArray(raw?.entries) ? raw.entries : []).map(normEntry).filter(Boolean);
      const busy = (Array.isArray(raw?.busy) ? raw.busy : []).map(normBusy).filter(Boolean);
      return { entries, busy, lastKind: KINDS.includes(raw?.lastKind) ? raw.lastKind : 'oneshot' };
    } catch {
      return { entries: [], busy: [], lastKind: 'oneshot' };
    }
  }

  // Меняет сохранённые игры и перерисовывает ленту. false — сохранить не удалось (окно тогда не закрываем).
  function updateOwn(change) {
    const store = loadOwn();
    change(store);
    try {
      localStorage.setItem(OWN_KEY, JSON.stringify({
        v: 1,
        entries: store.entries.map(normEntry).filter(Boolean),
        busy: store.busy.map(normBusy).filter(Boolean),
        lastKind: store.lastKind,
      }));
    } catch (e) {
      alert(e?.name === 'QuotaExceededError'
        ? 'Не удалось сохранить: в браузере кончилось место для этого сайта. Уберите картинки у старых игр или удалите лишние.'
        : 'Не удалось сохранить: браузер не даёт этому сайту хранить данные (например, в приватном режиме).');
      return false;
    }
    render();
    return true;
  }

  function loadImage(blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => resolve({ img, url });
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('не удалось открыть картинку'));
      };
      img.src = url;
    });
  }

  // Окно кадрирования поверх текущего окна. Рамка 3:1 — то, что попадёт на карточку; вокруг затемнён остаток картинки.
  // Перетаскивание сдвигает картинку, ползунок / −+ / колесо / два пальца меняют масштаб.
  // Результат — JPEG CROP_W×CROP_H в data:-URL (~15–30 КБ) или null, если окно закрыли.
  async function cropImage(blob) {
    const { img, url } = await loadImage(blob);
    const W = img.naturalWidth;
    const H = img.naturalHeight;
    img.className = 'vmcal-crop-img';
    img.alt = '';
    img.draggable = false;
    img.style.width = `${W}px`;
    img.style.height = `${H}px`;

    return new Promise((resolve) => {
      const win = h('div', { class: 'vmcal-crop-win' });
      const stage = h('div', { class: 'vmcal-crop' }, img, win);
      const zoom = h('input', { type: 'range', min: 1, max: CROP_MAX_ZOOM, step: 0.01, value: 1, 'aria-label': 'Масштаб' });
      const dlg = h('dialog', { class: 'vmcal-dialog vmcal-crop-dialog', 'aria-label': 'Участок картинки', tabindex: -1 },
        h('div', { class: 'vmcal-form' },
          h('h3', null, 'Участок картинки'),
          stage,
          h('div', { class: 'vmcal-zoom' },
            h('button', { type: 'button', class: 'vmcal-btn small', 'aria-label': 'Уменьшить', onclick: () => zoomTo(z / 1.25) }, '−'),
            zoom,
            h('button', { type: 'button', class: 'vmcal-btn small', 'aria-label': 'Увеличить', onclick: () => zoomTo(z * 1.25) }, '+'),
          ),
          h('p', { class: 'vmcal-hint' }, 'Перетащите картинку, чтобы в рамку попал нужный участок. Масштаб — ползунком, колесом мыши или двумя пальцами.'),
          h('div', { class: 'vmcal-actions' },
            h('div', { class: 'vmcal-actions-main' },
              h('button', { type: 'button', class: 'vmcal-btn', onclick: () => finish(null) }, 'Отмена'),
              h('button', { type: 'button', class: 'vmcal-btn primary', onclick: () => finish(output()) }, 'Готово'),
            ),
          ),
        ),
      );

      // x, y — где левый верхний угол картинки относительно рамки; s0 — масштаб, при котором картинка ровно закрывает рамку.
      let fw = 0, fh = 0, ox = 0, oy = 0, s0 = 1, z = 1, x = 0, y = 0, stageW = 0;
      const scale = () => s0 * z;
      const apply = () => {
        x = Math.min(0, Math.max(fw - W * scale(), x)); // рамка всегда целиком закрыта картинкой
        y = Math.min(0, Math.max(fh - H * scale(), y));
        img.style.transform = `translate(${x + ox}px, ${y + oy}px) scale(${scale()})`;
        zoom.value = z;
      };
      // масштаб вокруг точки (px, py) рамки: эта точка картинки остаётся на месте
      function zoomTo(nz, px = fw / 2, py = fh / 2) {
        const ix = (px - x) / scale();
        const iy = (py - y) / scale();
        z = Math.min(CROP_MAX_ZOOM, Math.max(1, nz));
        x = px - ix * scale();
        y = py - iy * scale();
        apply();
      }
      function layout() {
        const sw = stage.clientWidth;
        if (!sw || sw === stageW) return;
        stageW = sw;
        // центр видимого участка сохраняем при смене размера окна
        const cx = fw ? (fw / 2 - x) / scale() : W / 2;
        const cy = fh ? (fh / 2 - y) / scale() : H / 2;
        ox = Math.round(sw * 0.07);
        fw = sw - 2 * ox;
        fh = fw * CROP_H / CROP_W;
        oy = Math.round(fh * 0.4);
        stage.style.height = `${Math.round(fh + 2 * oy)}px`;
        Object.assign(win.style, { left: `${ox}px`, top: `${oy}px`, width: `${fw}px`, height: `${fh}px` });
        s0 = Math.max(fw / W, fh / H);
        x = fw / 2 - cx * scale();
        y = fh / 2 - cy * scale();
        apply();
      }
      function output() {
        const canvas = document.createElement('canvas');
        canvas.width = CROP_W;
        canvas.height = CROP_H;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff'; // прозрачный PNG в JPEG иначе станет чёрным
        ctx.fillRect(0, 0, CROP_W, CROP_H);
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, -x / scale(), -y / scale(), fw / scale(), fh / scale(), 0, 0, CROP_W, CROP_H);
        return canvas.toDataURL('image/jpeg', 0.85);
      }

      // перетаскивание одним указателем, щипок двумя (мышь, палец, перо — всё через pointer events)
      const pts = new Map();
      let last = null;
      const local = (e) => {
        const r = stage.getBoundingClientRect();
        return { x: e.clientX - r.left - ox, y: e.clientY - r.top - oy };
      };
      const snapshot = () => {
        const p = [...pts.values()];
        if (p.length === 1) return { x: p[0].x, y: p[0].y };
        return { d: Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y), mx: (p[0].x + p[1].x) / 2, my: (p[0].y + p[1].y) / 2 };
      };
      stage.addEventListener('pointerdown', (e) => {
        stage.setPointerCapture(e.pointerId);
        pts.set(e.pointerId, local(e));
        last = snapshot();
        stage.classList.add('is-dragging');
      });
      stage.addEventListener('pointermove', (e) => {
        if (!pts.has(e.pointerId)) return;
        pts.set(e.pointerId, local(e));
        const now = snapshot();
        if (pts.size === 1 && last && 'x' in last) {
          x += now.x - last.x;
          y += now.y - last.y;
          apply();
        } else if (pts.size >= 2 && last && 'd' in last && last.d > 0) {
          x += now.mx - last.mx;
          y += now.my - last.my;
          zoomTo(z * (now.d / last.d), now.mx, now.my);
        }
        last = now;
      });
      const release = (e) => {
        pts.delete(e.pointerId);
        last = pts.size ? snapshot() : null;
        if (!pts.size) stage.classList.remove('is-dragging');
      };
      stage.addEventListener('pointerup', release);
      stage.addEventListener('pointercancel', release);
      stage.addEventListener('wheel', (e) => {
        e.preventDefault();
        const p = local(e);
        zoomTo(z * Math.exp(-e.deltaY * 0.0015), p.x, p.y);
      }, { passive: false });
      zoom.addEventListener('input', () => zoomTo(Number(zoom.value)));

      const ro = new ResizeObserver(layout);
      let done = false;
      function finish(result) {
        if (done) return;
        done = true;
        ro.disconnect();
        URL.revokeObjectURL(url);
        dlg.close();
        resolve(result);
      }
      dlg.addEventListener('cancel', (e) => { e.preventDefault(); finish(null); }); // Esc
      dlg.addEventListener('close', () => { dlg.remove(); finish(null); });

      document.body.append(dlg);
      dlg.showModal(); // поверх окна игры: модальные окна складываются стопкой
      dlg.focus();
      layout();
      ro.observe(stage);
    });
  }

  // Картинка из буфера обмена по кнопке. null — картинки в буфере нет; исключение — браузер не дал прочитать буфер.
  async function readClipboardImage() {
    if (!navigator.clipboard?.read) throw new Error('clipboard.read не поддерживается');
    for (const item of await navigator.clipboard.read()) {
      const type = item.types.find((t) => t.startsWith('image/'));
      if (type) return item.getType(type);
    }
    return null;
  }

  // Все сессии своих игр, попадающие в дни [from, to).
  function ownOccurrences(entries, from, to) {
    const out = [];
    for (const entry of entries) {
      for (const session of entry.sessions) {
        const first = parseDate(session.date);
        const step = session.every * 7;
        const until = session.until ? parseDate(session.until) : null;
        const skip = new Set(session.skip);
        for (let n = step && first < from ? Math.ceil(dayDiff(first, from) / step) : 0; ; n++) {
          const day = addDays(first, n * step);
          if (day >= to || (until && day > until)) break;
          if (day >= from && !skip.has(isoDate(day))) {
            const start = withTime(day, session.time);
            out.push({
              entry, session, day: isoDate(day), start, end: new Date(+start + session.hours * 3_600_000),
              place: session.place || entry.place,
            });
          }
          if (!step) break;
        }
      }
    }
    return out;
  }

  // Накладки: свои сессии против игр Вестмарша и друг против друга.
  // vm: id игры → свои сессии в это время; own: сессия → с чем она конфликтует (ваши записи и другие свои игры).
  function findClashes(upcoming, occ) {
    const vm = new Map();
    const own = new Map();
    const add = (map, key, item) => {
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(item);
    };
    const hit = (a, b) => a.start < b.end && b.start < a.end;
    const spans = upcoming.filter((g) => g.status !== 'done').map((g) => {
      const start = new Date(g.startsAt);
      return { g, start, end: new Date(+start + VM_GAME_HOURS * 3_600_000) };
    });
    for (const o of occ) {
      const mine = { title: o.entry.title, label: KIND_LABEL[o.entry.kind], start: o.start, end: o.end };
      for (const s of spans) {
        if (!hit(o, s)) continue;
        add(vm, s.g.id, mine);
        if (cache.mine.has(s.g.id)) add(own, o, { title: s.g.title, label: 'Вестмарш, вы записаны', start: s.start, end: s.end });
      }
      for (const p of occ) {
        if (p !== o && hit(o, p)) add(own, o, { title: p.entry.title, label: KIND_LABEL[p.entry.kind], start: p.start, end: p.end });
      }
    }
    return { vm, own };
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
  const pad2 = (n) => String(n).padStart(2, '0');
  const isoDate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const parseDate = (s) => {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d);
  };
  const withTime = (day, hhmm) => {
    const [hh, mm] = hhmm.split(':').map(Number);
    return new Date(day.getFullYear(), day.getMonth(), day.getDate(), hh, mm);
  };
  const dayDiff = (a, b) => Math.round((startOfDay(b) - startOfDay(a)) / 86_400_000);
  const timeRange = (a, b) => `${fmtTime.format(a)}–${fmtTime.format(b)}`;

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

  function clashNode(list) {
    const names = [...new Set(list.map((c) => c.title))].join(', ');
    const details = list.map((c) => `${c.title} (${c.label}), ${timeRange(c.start, c.end)}`).join('\n');
    return h('div', { class: 'vmcal-card-clash', title: details }, `⚠ Накладка: ${names}`);
  }

  const busyNode = (busy) => h('div', { class: 'vmcal-card-clash', title: busy.note || 'Вы отметили этот день как занятый' },
    `⛔ Вы заняты${busy.note ? `: ${busy.note}` : ''}`);

  function buildCard(g, signup, clash, busy) {
    busy = g.status === 'done' ? null : busy;
    const start = new Date(g.startsAt);
    const href = `/games/${g.id}`;
    const img = SHOW_IMAGES ? imageUrl(g) : null;
    const meta = [g.masterName, `ур. ${levelText(g)}`, priceText(g.priceRub)].filter(Boolean).join(' · ');
    return h('a', {
      class: `vmcal-card status-${g.status}${signup ? ' is-mine' : ''}${clash || busy ? ' is-clash' : ''}`,
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
        busy && busyNode(busy),
        clash && clashNode(clash),
      ),
    );
  }

  function buildOwnCard(o, clash, busy) {
    const { entry, session } = o;
    const parts = [entry.master, o.place, REPEAT_SHORT[session.every]].filter(Boolean);
    if (!parts.length && entry.desc) parts.push(entry.desc.split('\n')[0]);
    const meta = parts.join(' · ');
    const tip = [
      entry.title,
      entry.master && `Мастер: ${entry.master}`,
      o.place && `Место: ${o.place}`,
      entry.desc && `\n${entry.desc}`,
      '\nНажмите, чтобы изменить',
    ];
    return h('button', {
      type: 'button',
      class: `vmcal-card is-own${clash || busy ? ' is-clash' : ''}`,
      title: tip.filter(Boolean).join('\n'),
      onclick: () => openSession(o),
    },
      SHOW_IMAGES && entry.image ? h('img', { class: 'vmcal-thumb', src: entry.image, alt: '' }) : null,
      h('div', { class: 'vmcal-card-body' },
        h('div', { class: 'vmcal-card-top' },
          h('span', { class: 'vmcal-time' }, timeRange(o.start, o.end)),
          h('span', { class: 'vmcal-status vmcal-kind' }, KIND_LABEL[entry.kind]),
        ),
        h('div', { class: 'vmcal-card-title' }, entry.title),
        meta ? h('div', { class: 'vmcal-card-meta' }, meta) : null,
        busy && busyNode(busy),
        clash && clashNode(clash),
      ),
    );
  }

  // Окно дня (клик по заголовку дня): отметка «занят» с заметкой, при желании на несколько дней; оттуда же — своя игра.
  function openDay(dayIso) {
    const store = loadOwn();
    const rec = busyOn(store.busy, dayIso);
    const day = parseDate(dayIso);
    const fmtIso = (s) => fmtDate.format(parseDate(s));
    const check = h('input', { type: 'checkbox', checked: !!rec });
    const note = textInput(rec?.note || '', 120, false, 'День рождения, командировка…');
    const until = h('input', { type: 'date', value: rec?.to || '', min: rec?.from || dayIso });
    const details = h('div', { class: 'vmcal-stack' },
      field('Заметка для себя', note),
      field('По какой день (если занят несколько дней)', until),
    );
    const sync = () => {
      details.hidden = !check.checked;
      until.disabled = !check.checked; // скрытое поле не должно мешать проверке формы
    };
    check.addEventListener('change', sync);
    sync();
    const dow = fmtDow.format(day);
    showDialog(`${dow[0].toUpperCase()}${dow.slice(1)}, ${fmtDate.format(day)}`, [
      h('label', { class: 'vmcal-check' }, check, h('span', null, h('b', null, 'Занят'), ' — в этот день не могу играть')),
      details,
      rec?.to ? h('p', { class: 'vmcal-hint' }, `Отметка стоит на ${fmtIso(rec.from)}–${fmtIso(rec.to)}. Если снять галочку, снимется целиком.`) : null,
      h('div', { class: 'vmcal-day-add' }, linkBtn('＋ Добавить свою игру на этот день', () => openAdd({ day: dayIso }))),
    ], 'Сохранить', () => updateOwn((st) => {
      st.busy = st.busy.filter((b) => b.id !== rec?.id);
      if (check.checked) st.busy.push({ id: rec?.id || newId(), from: rec?.from || dayIso, to: until.value, note: note.value });
    }));
  }

  // ---------- окна добавления и правки своих игр ----------

  const field = (label, ...inputs) => h('label', { class: 'vmcal-field' }, h('span', null, label), ...inputs);
  const textInput = (value, max, required, placeholder) => h('input', {
    type: 'text', value, maxlength: max, required, placeholder, autocomplete: 'off', pattern: required ? '.*\\S.*' : null,
  });
  const descInput = (value) => h('textarea', { maxlength: DESC_MAX, rows: 3, placeholder: 'Система, что взять с собой — по желанию' }, value);

  // Уникальные непустые имена без учёта регистра, в исходном порядке.
  function uniqueNames(list) {
    const seen = new Set();
    const out = [];
    for (const v of list) {
      const name = typeof v === 'string' ? v.trim() : '';
      if (name && !seen.has(name.toLowerCase())) {
        seen.add(name.toLowerCase());
        out.push(name);
      }
    }
    return out;
  }

  // Подсказки: сначала то, что вы уже вводили (последнее — выше), потом мастера из игр Вестмарша.
  const knownMasters = () => uniqueNames([
    ...loadOwn().entries.map((e) => e.master).reverse(),
    ...(cache?.games || []).map((g) => g.masterName).sort((a, b) => String(a).localeCompare(String(b), 'ru')),
  ]);
  const knownPlaces = () => uniqueNames(loadOwn().entries.flatMap((e) => [e.place, ...e.sessions.map((s) => s.place)]).reverse());

  // Поля с подсказками браузера (<datalist>): вариант можно выбрать или вписать свой.
  let listSeq = 0;
  function suggestInput(value, max, placeholder, options) {
    const id = `vmcal-list-${++listSeq}`;
    return [
      h('input', { type: 'text', value: value || '', maxlength: max, placeholder, autocomplete: 'off', list: id }),
      h('datalist', { id }, options.map((v) => h('option', { value: v }))),
    ];
  }

  // Мастер и место. У ваншота место своё, у кампании и модуля — место по умолчанию для сессий.
  function masterPlaceFields(e, placeLabel = 'Место проведения') {
    const [master, masterList] = suggestInput(e.master, 60, 'Имя мастера', knownMasters());
    const [place, placeList] = suggestInput(e.place, 80, 'Discord, клуб…', knownPlaces());
    return {
      node: h('div', { class: 'vmcal-row two' }, field('Мастер', master, masterList), field(placeLabel, place, placeList)),
      read: () => ({ master: master.value, place: place.value }),
    };
  }

  // Место конкретной сессии кампании или модуля: пусто — как обычно (место по умолчанию видно серым в поле).
  function sessionPlaceField(value, fallback) {
    const [input, list] = suggestInput(value, 80, '', knownPlaces());
    const setDefault = (v) => { input.placeholder = v ? `Как обычно: ${v}` : 'Discord, клуб…'; };
    setDefault(fallback);
    return { node: field('Место проведения', input, list), value: () => input.value, setDefault };
  }
  const linkBtn = (label, onclick) => h('button', { type: 'button', class: 'vmcal-link', onclick }, label);
  // Кнопка действия в окне: если action вернул false (например, отказ в confirm), окно не закрываем.
  const dangerBtn = (label, action) => h('button', {
    type: 'button',
    class: 'vmcal-btn danger',
    onclick: (e) => {
      const dlg = e.currentTarget.closest('dialog');
      if (action() !== false) dlg.close();
    },
  }, label);

  // Поле картинки: файл (с телефона — из галереи), буфер обмена (кнопкой или Ctrl+V в окне), затем кадрирование.
  function imageField(initial) {
    let value = initial || '';
    const preview = h('img', { class: 'vmcal-img-preview', alt: '' });
    const file = h('input', { type: 'file', accept: 'image/*', hidden: true });
    const status = h('p', { class: 'vmcal-hint vmcal-img-status' });
    const say = (text) => {
      status.textContent = text;
      status.hidden = !text;
    };
    const sync = () => {
      preview.hidden = !value;
      if (value) preview.src = value;
      else preview.removeAttribute('src');
      clearBtn.hidden = !value;
    };
    const take = async (blob) => {
      say('');
      try {
        const result = await cropImage(blob);
        if (result) value = result;
      } catch {
        say('Не получилось открыть эту картинку.');
      }
      sync();
    };
    const fileBtn = h('button', { type: 'button', class: 'vmcal-btn small', onclick: () => file.click() }, 'Файл…');
    const pasteBtn = h('button', {
      type: 'button',
      class: 'vmcal-btn small',
      title: 'Вставить скопированную картинку (или Ctrl+V в этом окне)',
      onclick: async () => {
        say('');
        let blob;
        try {
          blob = await readClipboardImage();
        } catch {
          say('Браузер не дал прочитать буфер обмена. Нажмите Ctrl+V прямо в этом окне.');
          return;
        }
        if (blob) take(blob);
        else say('В буфере нет картинки. Скопируйте саму картинку: правой кнопкой по ней → «Копировать картинку».');
      },
    }, 'Из буфера');
    const clearBtn = linkBtn('убрать', () => {
      value = '';
      say('');
      sync();
    });
    file.addEventListener('change', () => {
      const f = file.files?.[0];
      file.value = '';
      if (f) take(f);
    });
    const node = h('div', { class: 'vmcal-field' },
      h('span', null, 'Картинка'),
      h('div', { class: 'vmcal-img' }, preview, h('div', { class: 'vmcal-img-actions' }, fileBtn, pasteBtn, clearBtn), file),
      status,
    );
    // Ctrl+V в окне: забираем только картинки, текст вставляется в поля как обычно.
    const onPaste = (e) => {
      if (!node.isConnected) {
        document.removeEventListener('paste', onPaste); // окно закрыто
        return;
      }
      if (!node.getClientRects().length || document.querySelector('dialog.vmcal-crop-dialog')) return; // поле скрыто или уже кадрируем
      const f = [...(e.clipboardData?.files || [])].find((x) => x.type.startsWith('image/'));
      if (!f) return;
      if (e.target.matches?.('input, textarea') && e.clipboardData.getData('text/plain')) return; // в поле вставляют текст
      e.preventDefault();
      take(f);
    };
    document.addEventListener('paste', onPaste);
    say('');
    sync();
    return { node, value: () => value };
  }

  function showDialog(heading, fields, submitLabel, onSubmit, extra = []) {
    for (const old of document.querySelectorAll('dialog.vmcal-dialog')) old.close();
    const dlg = h('dialog', { class: 'vmcal-dialog', 'aria-label': heading, tabindex: -1 });
    const form = h('form', { class: 'vmcal-form' },
      h('h3', null, heading),
      ...fields,
      h('div', { class: 'vmcal-actions' },
        extra.length ? h('div', { class: 'vmcal-actions-extra' }, extra) : null,
        h('div', { class: 'vmcal-actions-main' },
          h('button', { type: 'button', class: 'vmcal-btn', onclick: () => dlg.close() }, 'Отмена'),
          h('button', { type: 'submit', class: 'vmcal-btn primary' }, submitLabel),
        ),
      ),
    );
    // onSubmit вернул false — сохранить не вышло, окно оставляем с введёнными данными
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (onSubmit() !== false) dlg.close();
    });
    // Закрытие кликом по затемнению (но не когда выделение текста в поле закончилось за пределами окна).
    let downOnBackdrop = false;
    dlg.addEventListener('pointerdown', (e) => { downOnBackdrop = e.target === dlg; });
    dlg.addEventListener('click', (e) => { if (downOnBackdrop && e.target === dlg) dlg.close(); });
    dlg.addEventListener('close', () => dlg.remove());
    dlg.append(form);
    // В <body>, а не в ленту: лента перерисовывается целиком и унесла бы открытое окно.
    document.body.append(dlg);
    dlg.showModal();
    // фокус на само окно: иначе браузер ставит его на первую кнопку и рисует вокруг неё рамку
    dlg.focus();
    return dlg;
  }

  // Поля одной сессии: дата, время, длительность и (для модулей и кампаний) повтор.
  function sessionFields(s) {
    const date = h('input', { type: 'date', required: true, value: s.date });
    const time = h('input', { type: 'time', required: true, value: s.time });
    const hours = h('input', { type: 'number', required: true, min: 0.5, max: 24, step: 0.5, value: s.hours, inputmode: 'decimal' });
    const every = h('select', null, REPEAT_LABEL.map((t, i) => h('option', { value: i, selected: s.every === i }, t)));
    const until = h('input', { type: 'date', value: s.until || '' });
    const dateField = field('Дата', date);
    const untilField = field('До (необязательно)', until);
    const repeatRow = h('div', { class: 'vmcal-row two' }, field('Повтор', every), untilField);
    let repeatable = true;
    const sync = () => {
      const repeating = repeatable && every.value !== '0';
      untilField.hidden = !repeating;
      until.disabled = !repeating; // скрытое поле не должно мешать проверке формы
      until.min = date.value;
      dateField.firstChild.textContent = repeating ? 'Первая дата' : 'Дата';
    };
    every.addEventListener('change', sync);
    date.addEventListener('change', sync);
    sync();
    return {
      nodes: [h('div', { class: 'vmcal-row' }, dateField, field('Начало', time), field('Часов', hours)), repeatRow],
      setRepeatable(v) {
        repeatable = v;
        repeatRow.hidden = !v;
        sync();
      },
      setHours(v) { hours.value = v; },
      read() {
        const ev = repeatable ? Number(every.value) : 0;
        return { date: date.value, time: time.value.slice(0, 5), hours: clampHours(hours.value), every: ev, until: ev ? until.value : '' };
      },
    };
  }

  // «Своя игра». Ваншот заводится целиком здесь же; для модуля или кампании — выбрать заведённую и поставить время.
  function openAdd(opts = {}) {
    const store = loadOwn();
    let kind = KINDS.includes(opts.kind) ? opts.kind : store.lastKind;
    const sf = sessionFields({ date: opts.day || isoDate(new Date()), time: '19:00', hours: DEFAULT_OWN_HOURS, every: 0, until: '' });
    // после создания или правки модуля/кампании возвращаемся сюда же, с уже выбранной записью и прежней датой
    const back = (entryId, k) => openAdd({ day: sf.read().date || opts.day, kind: k || kind, entryId });
    const segBtns = KINDS.map((k) => h('button', { type: 'button', 'data-kind': k, onclick: () => setKind(k) }, KIND_TITLE[k]));

    const title = textInput('', 80, true);
    const who = masterPlaceFields({});
    const desc = descInput('');
    const image = imageField('');
    const oneshotBox = h('div', { class: 'vmcal-stack' }, field('Название', title), who.node, field('Описание', desc), image.node);

    const pick = h('select', { onchange: () => syncPick() });
    const pickField = field('', pick);
    const chosen = () => (kind !== 'oneshot' && pick.value ? store.entries.find((x) => x.id === pick.value) : null);
    const editLink = linkBtn('изменить', () => {
      const entry = chosen();
      if (entry) openEntry(entry, { then: back });
    });
    const createEntry = () => openEntry(null, { kind, then: back });
    const newLink = linkBtn('', createEntry);
    const seriesBox = h('div', { class: 'vmcal-stack' }, pickField, h('div', { class: 'vmcal-links' }, editLink, newLink));
    const emptyText = h('p');
    const emptyBtn = h('button', { type: 'button', class: 'vmcal-btn primary', onclick: createEntry });
    const emptyBox = h('div', { class: 'vmcal-empty' }, emptyText, emptyBtn);
    const sessionPlace = sessionPlaceField('', '');
    const sessionBox = h('div', { class: 'vmcal-stack' }, sf.nodes, sessionPlace.node);

    const dlg = showDialog('Своя игра', [
      h('div', { class: 'vmcal-seg', role: 'group', 'aria-label': 'Тип игры' }, segBtns),
      oneshotBox, seriesBox, emptyBox, sessionBox,
      h('p', { class: 'vmcal-hint' }, 'Хранится только в этом браузере. Игры Вестмарша в то же время будут отмечены ⚠.'),
    ], 'Добавить', () => {
      // у ваншота место хранится в самой записи, у сессии кампании/модуля — только если отличается от обычного
      const session = { id: newId(), ...sf.read(), skip: [], place: kind === 'oneshot' ? '' : sessionPlace.value() };
      const entryId = chosen()?.id;
      if (kind !== 'oneshot' && !entryId) return false;
      return updateOwn((st) => {
        st.lastKind = kind;
        if (kind === 'oneshot') {
          st.entries.push({
            id: newId(), kind, title: title.value, ...who.read(), desc: desc.value, image: image.value(), hours: session.hours, sessions: [session],
          });
        } else {
          st.entries.find((x) => x.id === entryId)?.sessions.push(session);
        }
      });
    });
    const submitBtn = dlg.querySelector('.vmcal-actions-main [type=submit]');

    function setKind(k) {
      kind = k;
      for (const b of segBtns) b.setAttribute('aria-pressed', String(b.dataset.kind === k));
      const series = k !== 'oneshot';
      const existing = store.entries.filter((x) => x.kind === k);
      const none = series && existing.length === 0;
      oneshotBox.hidden = series;
      title.required = !series;
      seriesBox.hidden = !series || none;
      emptyBox.hidden = !none;
      sessionBox.hidden = none;
      sessionPlace.node.hidden = !series; // у ваншота место — в общих полях выше
      submitBtn.hidden = none;
      pick.replaceChildren(...existing.map((x) => h('option', { value: x.id, selected: x.id === opts.entryId }, x.title)));
      const isModule = k === 'module';
      pickField.firstChild.textContent = KIND_TITLE[k];
      newLink.textContent = isModule ? '＋ новый модуль' : '＋ новая кампания';
      emptyText.textContent = isModule
        ? 'Модулей пока нет. Сначала заведите модуль: название, мастер, место, описание, картинка. Потом останется выбрать его и поставить время.'
        : 'Кампаний пока нет. Сначала заведите кампанию: название, мастер, место, описание, картинка. Потом останется выбрать её и поставить время.';
      emptyBtn.textContent = isModule ? '＋ Завести модуль' : '＋ Завести кампанию';
      sf.setRepeatable(series);
      syncPick();
    }
    function syncPick() {
      const entry = chosen();
      if (entry) sf.setHours(entry.hours);
      sessionPlace.setDefault(entry?.place);
    }
    setKind(kind);
  }

  // Клик по своей карточке: правка этой сессии (у ваншота — и названия, описания, картинки).
  function openSession(o) {
    const { entry, session } = o;
    const oneshot = entry.kind === 'oneshot';
    const sf = sessionFields(session);
    sf.setRepeatable(!oneshot);
    let title = null;
    let who = null;
    let desc = null;
    let image = null;
    let place = null;
    let head;
    if (oneshot) {
      title = textInput(entry.title, 80, true);
      who = masterPlaceFields(entry);
      desc = descInput(entry.desc);
      image = imageField(entry.image);
      head = [field('Название', title), who.node, field('Описание', desc), image.node];
    } else {
      const whoLine = [entry.master && `Мастер: ${entry.master}`, entry.place && `Обычно: ${entry.place}`].filter(Boolean).join(' · ');
      place = sessionPlaceField(session.place, entry.place);
      head = [h('div', { class: 'vmcal-entry-head' },
        entry.image ? h('img', { src: entry.image, alt: '' }) : null,
        h('div', null,
          h('div', null, h('b', null, `${KIND_TITLE[entry.kind]} «${entry.title}»`), ' · ', linkBtn('изменить', () => openEntry(entry))),
          whoLine ? h('p', { class: 'vmcal-who' }, whoLine) : null,
          entry.desc ? h('p', { class: 'vmcal-desc' }, entry.desc) : null,
        ),
      )];
    }
    const withEntry = (fn) => updateOwn((st) => {
      const e = st.entries.find((x) => x.id === entry.id);
      if (e) fn(st, e);
    });
    const removeSession = () => withEntry((st, e) => {
      e.sessions = e.sessions.filter((x) => x.id !== session.id);
      if (oneshot) st.entries = st.entries.filter((x) => x !== e);
    });

    const extra = [];
    if (session.every) {
      extra.push(dangerBtn(`Убрать ${fmtDate.format(o.start)}`, () => withEntry((st, e) => {
        e.sessions.find((x) => x.id === session.id)?.skip.push(o.day);
      })));
      extra.push(dangerBtn('Удалить все повторы', () => {
        if (!confirm(`Удалить все сессии «${entry.title}» (${REPEAT_SHORT[session.every]})?`)) return false;
        return removeSession();
      }));
    } else {
      extra.push(dangerBtn('Удалить', () => {
        if (!confirm(oneshot ? `Удалить «${entry.title}»?` : `Удалить сессию «${entry.title}» ${fmtDate.format(o.start)}?`)) return false;
        return removeSession();
      }));
    }

    showDialog(oneshot ? 'Ваншот' : 'Сессия', [...head, ...sf.nodes, place?.node], 'Сохранить', () => {
      const next = { ...sf.read(), place: place ? place.value() : '' };
      return withEntry((st, e) => {
        const s = e.sessions.find((x) => x.id === session.id);
        if (!s) return;
        // пропуски привязаны к датам старой серии: при смене даты или шага повтора они теряют смысл
        if (next.date !== s.date || next.every !== s.every) s.skip = [];
        Object.assign(s, next);
        if (oneshot) Object.assign(e, { title: title.value, ...who.read(), desc: desc.value, image: image.value(), hours: s.hours });
      });
    }, extra);
  }

  // Модуль или кампания как сущность: заводится один раз (название, описание, картинка), сессии добавляются отдельно.
  // then(id, kind) — куда вернуться после сохранения или удаления (id = null после удаления).
  function openEntry(entry, { kind = 'campaign', then } = {}) {
    const isNew = !entry;
    const base = entry || { kind, title: '', master: '', place: '', desc: '', image: '', hours: DEFAULT_OWN_HOURS, sessions: [] };
    const id = entry?.id || newId();
    const kindSel = h('select', null, ['campaign', 'module'].map((k) => h('option', { value: k, selected: base.kind === k }, KIND_TITLE[k])));
    const hours = h('input', { type: 'number', required: true, min: 0.5, max: 24, step: 0.5, value: base.hours, inputmode: 'decimal' });
    const title = textInput(base.title, 80, true);
    const who = masterPlaceFields(base, 'Место по умолчанию');
    const desc = descInput(base.desc);
    const image = imageField(base.image);
    const count = base.sessions.length;
    showDialog(isNew ? (base.kind === 'module' ? 'Новый модуль' : 'Новая кампания') : `${KIND_TITLE[base.kind]} «${base.title}»`, [
      h('div', { class: 'vmcal-row two' }, field('Тип', kindSel), field('Обычно часов', hours)),
      field('Название', title),
      who.node,
      field('Описание', desc),
      image.node,
      h('p', { class: 'vmcal-hint' }, isNew
        ? 'Заводится один раз. Потом в «Своя игра» останется выбрать из списка и поставить время.'
        : `Сессий в календаре: ${count}. Новую сессию добавляет кнопка «Своя игра».`),
    ], isNew ? 'Завести' : 'Сохранить', () => {
      const data = {
        kind: kindSel.value, title: title.value, ...who.read(), desc: desc.value, image: image.value(), hours: clampHours(hours.value),
      };
      const ok = updateOwn((st) => {
        const e = st.entries.find((x) => x.id === id);
        if (e) Object.assign(e, data);
        else st.entries.push({ id, ...data, sessions: [] });
      });
      if (ok && then) then(id, data.kind);
      return ok;
    }, isNew ? [] : [dangerBtn('Удалить', () => {
      if (!confirm(`Удалить ${KIND_ACC[base.kind]} «${base.title}» вместе со всеми сессиями (${count})?`)) return false;
      const ok = updateOwn((st) => { st.entries = st.entries.filter((x) => x.id !== id); });
      if (ok && then) then(null, base.kind);
      return ok;
    })]);
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
      h('button', {
        type: 'button', class: 'vmcal-add', title: 'Добавить свой ваншот, модуль или кампанию', onclick: () => openAdd(),
      }, '＋ Своя игра'),
      h('div', { class: 'vmcal-nav' },
        h('button', { type: 'button', 'aria-label': 'Назад', title: 'Назад', onclick: () => scrollBy(-1) }, '‹'),
        h('button', { type: 'button', 'aria-label': 'Вперёд', title: 'Вперёд', onclick: () => scrollBy(1) }, '›'),
      ),
    );
  }

  function buildStrip(upcoming, occ, clashes, busyList, today, total) {
    // В каждом дне сначала «своё» (ваши записи и свои игры), потом остальное; внутри — по времени.
    const byDay = new Map();
    const put = (date, item) => {
      const k = dayKey(date);
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k).push(item);
    };
    for (const g of upcoming) {
      const start = new Date(g.startsAt);
      const signup = cache.mine.get(g.id);
      put(start, { at: +start, first: !!signup, signed: !!signup, make: (busy) => buildCard(g, signup, clashes.vm.get(g.id), busy) });
    }
    for (const o of occ) put(o.start, { at: +o.start, first: true, make: (busy) => buildOwnCard(o, clashes.own.get(o), busy) });

    const days = [];
    for (let i = 0; i < total; i++) {
      const d = addDays(today, i);
      const iso = isoDate(d);
      const busy = busyOn(busyList, iso);
      const items = (byDay.get(dayKey(d)) || []).sort((a, b) => (b.first - a.first) || (a.at - b.at));
      const dow = d.getDay();
      const cls = ['vmcal-day'];
      if (i === 0) cls.push('is-today');
      if (dow === 0 || dow === 6) cls.push('is-weekend');
      if (items.length === 0 && !busy) cls.push('is-empty');
      if (items.some((x) => x.signed)) cls.push('has-mine');
      if (busy) cls.push('is-busy');
      const openHere = () => openDay(iso);
      days.push(h('li', { class: cls.join(' ') },
        h('div', {
          class: 'vmcal-day-head', role: 'button', tabindex: 0, title: 'Отметить, что заняты, или добавить свою игру',
          onclick: openHere,
          onkeydown: (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              openHere();
            }
          },
        },
          h('span', { class: 'vmcal-dow' }, fmtDow.format(d)),
          h('span', { class: 'vmcal-date' }, fmtDate.format(d)),
          i === 0 ? h('span', { class: 'vmcal-rel' }, 'сегодня') : i === 1 ? h('span', { class: 'vmcal-rel' }, 'завтра') : null,
        ),
        h('div', { class: 'vmcal-day-body' },
          busy && h('button', { type: 'button', class: 'vmcal-busy', title: 'Изменить отметку', onclick: openHere },
            h('b', null, '⛔ Занят'),
            busy.note ? h('span', null, busy.note) : null,
          ),
          items.map((x) => x.make(busy)),
        ),
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
    const { entries, busy } = loadOwn();
    // Лента — до последней игры Вестмарша, разовой своей игры или отметки «занят» (повторы ленту не растягивают).
    let last = today;
    for (const g of upcoming) last = new Date(Math.max(+last, +startOfDay(new Date(g.startsAt))));
    for (const e of entries) for (const s of e.sessions) if (!s.every) last = new Date(Math.max(+last, +parseDate(s.date)));
    for (const b of busy) last = new Date(Math.max(+last, +parseDate(b.to || b.from)));
    const total = Math.min(MAX_DAYS, Math.max(MIN_DAYS, dayDiff(today, last) + 1));
    const occ = ownOccurrences(entries, today, addDays(today, total));
    const clashes = findClashes(upcoming, occ);
    const strip = buildStrip(upcoming, occ, clashes, busy, today, total);
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

  // ---------- «Простой»: подсказки в карточках «Проектов Оплота» ----------
  // Правила проекта Оплота: вклад «+1» — 1 ОД за 1 прогресс. Проверка — 1 ОД: успех +2 прогресса, натуральная 20 —
  // всегда успех и +3 прогресса, провал — 1 истощение, натуральная 1 — 2 истощения; снять одно истощение стоит 2 ОД.
  // Считаем только для персонажа, выбранного на странице: кнопки карточки тратят именно его ОД.
  // Модификатор — той же функцией сайта, что и сама страница (владения, экспертиза, бард, порядок, эффекты).
  // Инструменты предлагаем, только если у персонажа есть владение ими, сам инструмент в инвентаре или мультиинструмент.

  const DT_REFRESH_MS = 30_000;
  const isDowntimePage = () => location.pathname.replace(/\/+$/, '') === '/downtime';
  let dtBase = null;      // { loggedIn, helpers, chars, projects, catalog, at } — общее для всех персонажей
  let dtLoading = null;
  let dtError = null;
  const dtExtras = new Map();        // id персонажа → { full, mechanics, items, multitool, baseAt } — грузим только выбранного
  const dtExtrasLoading = new Set();
  const dtOptionsCache = new Map();  // варианты проверок для пары «персонаж + проект»
  const dtOpenCards = new Set();     // в каких карточках раскрыт список «Все проверки» (переживает перерисовку и смену персонажа)

  // Функции сайта достаём из его же webpack-модулей: так расчёт совпадает со страницей и следует за её правками.
  let wpRequire = null;
  function siteRequire() {
    if (wpRequire) return wpRequire;
    try {
      (self.webpackChunk_N_E = self.webpackChunk_N_E || []).push([[`vmdt-${Math.random()}`], {}, (r) => { wpRequire = r; }]);
    } catch { /* нет webpack — значит, сайт сильно поменялся */ }
    return wpRequire;
  }
  // Модуль по номеру; если номер сменился после обновления сайта — ищем по приметам в исходнике (только среди подходящих).
  function siteModule(id, keys, hints) {
    const req = siteRequire();
    if (!req) return null;
    const fits = (m) => m && keys.every((k) => typeof m[k] === 'function');
    try {
      const m = req(id);
      if (fits(m)) return m;
    } catch { /* нет такого модуля */ }
    if (!hints?.length) return null;
    for (const [mid, factory] of Object.entries(req.m || {})) {
      let src = '';
      try { src = Function.prototype.toString.call(factory); } catch { continue; }
      if (!hints.every((x) => src.includes(x))) continue;
      try {
        const m = req(mid);
        if (fits(m)) return m;
      } catch { /* не тот */ }
    }
    return null;
  }
  // Номера модулей — с обновления сайта в ноябре 2026 (раньше были 68943, 51226, 85119); если сменятся — найдём по приметам.
  function siteHelpers() {
    const sk = siteModule(57486, ['w7'], ['jackOfAllTrades', 'abilityShort', 'checkBonusTargets']);
    if (!sk) return null;
    let tools = null;
    try {
      if (['J3', 'T_', 'Zm', 'HE', '$R'].every((k) => typeof sk[k] === 'function') && sk.Zm(5) === 3 && sk.J3(14) === 2) tools = sk;
    } catch { /* без инструментов */ }
    const fx = siteModule(81031, ['ed'], ['blockedEffectCategories']);
    const mt = siteModule(55777, ['_s'], ['мультиинструмент']);
    // Игровой справочник сайта (навыки, характеристики, черты): функции расчёта принимают его последним аргументом.
    const rules = siteModule(55777, ['KG', '$W'], ['Не загружен игровой справочник']);
    const refs = siteModule(52308, ['K7'], ['FetchReferences']);
    return {
      skill: sk.w7,
      tools,
      mergeEffects: fx ? fx.ed : null,
      isMultitool: mt ? mt._s : (name) => /мультиинструмент|manifold/i.test(name || ''),
      buildRules: rules ? rules.KG : null,
      fetchReferences: refs ? refs.K7 : () => rpcNs('references', 'FetchReferences', []),
    };
  }

  // Справочник один на всех и меняется редко — грузим один раз за сессию (как и сам сайт).
  let dtRules = null;
  async function dtLoadRules(helpers) {
    if (!helpers.buildRules) return undefined; // старая версия сайта — функции обходятся без справочника
    if (!dtRules) {
      dtRules = Promise.resolve(helpers.fetchReferences()).then((refs) => helpers.buildRules(refs || []));
      dtRules.catch(() => { dtRules = null; });
    }
    try {
      return await dtRules;
    } catch {
      throw new Error('не загрузился игровой справочник сайта');
    }
  }

  async function dtLoadBase() {
    const helpers = siteHelpers();
    if (!helpers) throw new Error('не нашёл на странице расчёт навыков — похоже, сайт обновился');
    const userId = await fetchUserId();
    if (!userId) return { loggedIn: false, at: Date.now() };
    const [chars, projects, catalog, rules] = await Promise.all([
      rpcNs('characters', 'FetchCharacters', []),
      rpcNs('downtime', 'FetchStrongholdProjects', []),
      rpcNs('tools', 'FetchToolCatalog', []).catch(() => []),
      dtLoadRules(helpers),
    ]);
    return {
      loggedIn: true,
      helpers,
      rules,
      chars: (chars || []).filter((c) => c && c.ownerId === userId && !c.isDead),
      allProjects: (projects || []).filter(Boolean),
      projects: (projects || []).filter((p) => p && (p.status === 'active' || p.isInfinite)
        && ((p.skills?.length || 0) + (p.tools?.length || 0)) > 0),
      catalog: catalog || [],
      at: Date.now(),
    };
  }

  // Эффекты (бонусы к проверкам) и инвентарь (свои инструменты, мультиинструмент) — только для выбранного персонажа.
  async function dtLoadExtras(base, char) {
    const { helpers } = base;
    let mechanics = [];
    if (helpers.mergeEffects) {
      try {
        const fx = await rpcNs('effects', 'FetchCharacterEffects', [char.id]);
        mechanics = helpers.mergeEffects((fx || [])
          .filter((e) => e && e.isActive && (e.remainingGames == null || e.remainingGames > 0))
          .map((e) => e.mechanics));
      } catch { /* без эффектов */ }
    }
    let items = [];
    try { items = (await rpcNs('economy', 'FetchCharacterItems', [char.id])) || []; } catch { /* без инвентаря */ }
    const multitool = items.some((it) => it && it.attuned && helpers.isMultitool(it.name));
    return { full: { ...char, effectMechanics: mechanics }, mechanics, items, multitool };
  }

  function dtRefresh(force) {
    if (dtLoading) return dtLoading;
    if (!force && dtBase && Date.now() - dtBase.at < DT_REFRESH_MS) return Promise.resolve();
    dtLoading = dtLoadBase()
      .then((b) => { dtBase = b; dtError = null; dtOptionsCache.clear(); })
      .catch((e) => { dtError = e; })
      .finally(() => { dtLoading = null; schedule(); });
    return dtLoading;
  }
  // после действий на странице (проверка, отдых, вклад) истощение и проекты меняются — пересчитываем чуть позже
  let dtSoonTimer = 0;
  const dtRefreshSoon = () => {
    window.clearTimeout(dtSoonTimer);
    dtSoonTimer = window.setTimeout(() => { if (isDowntimePage()) dtRefresh(true); }, 3000);
  };

  // Выбор персонажа на странице — <select>, где варианты вида «Имя · 5 ОД · ист. 0».
  const dtCharSelect = () => document.querySelector('.downtime-char-pick select')
    || [...document.querySelectorAll('main select')].find((s) => [...s.options].some((o) => o.textContent.includes('ист.'))) || null;
  const dtSelectedCharId = () => dtCharSelect()?.value || null;
  function dtCurrentChar() {
    if (!dtBase?.loggedIn) return null;
    const id = dtSelectedCharId();
    if (id) return dtBase.chars.find((c) => String(c.id) === String(id)) || null;
    return dtBase.chars.length === 1 ? dtBase.chars[0] : null;
  }
  // Данные выбранного персонажа: отдаём, что есть (пусть и от прошлой загрузки), и догружаем свежие в фоне.
  function dtEnsureExtras(char) {
    const entry = dtExtras.get(char.id) || null;
    if ((!entry || entry.baseAt !== dtBase.at) && !dtExtrasLoading.has(char.id)) {
      const base = dtBase;
      dtExtrasLoading.add(char.id);
      dtLoadExtras(base, char)
        .then((x) => dtExtras.set(char.id, { ...x, baseAt: base.at }))
        .catch(() => dtExtras.set(char.id, { full: { ...char, effectMechanics: [] }, mechanics: [], items: [], multitool: false, baseAt: base.at }))
        .finally(() => { dtExtrasLoading.delete(char.id); schedule(); });
    }
    return entry;
  }
  // Сколько ОД у выбранного персонажа: блок «Очки действий» (или текст варианта в списке). ∞ — тестовый персонаж.
  function dtCurrentAp() {
    const v = document.querySelector('.downtime-status-ap-value');
    const head = (v?.firstChild?.textContent || '').trim();
    if (head === '∞') return Infinity;
    if (/^\d+$/.test(head)) return Number(head);
    const txt = dtCharSelect()?.selectedOptions?.[0]?.textContent || '';
    if (txt.includes('∞')) return Infinity;
    const m = /(\d+)\s*ОД/.exec(txt);
    return m ? Number(m[1]) : null;
  }

  // Вероятности на d20: натуральная 20 — крит. успех, натуральная 1 — крит. провал, остальное — сравнение с СЛ.
  // s — все успехи (включая натуральную 20), cs — из них крит. успехи, f — обычные провалы, c — натуральная 1.
  // С преимуществом берётся бо́льшая из двух костей: P(выпало r) = (2r − 1) / 400.
  function dtOdds(mod, dc, adv = false) {
    const w = (r) => (adv ? (2 * r - 1) / 400 : 1 / 20);
    let s = 0;
    let f = 0;
    for (let r = 2; r <= 19; r++) {
      if (r + mod >= dc) s += w(r);
      else f += w(r);
    }
    return { s: s + w(20), cs: w(20), f, c: w(1) };
  }
  // Прогресс на одно потраченное ОД с учётом лечения истощения:
  // (2·обычный успех + 3·крит. успех) / (1 + 2·провал + 4·крит. провал). У вклада «+1» — ровно 1.
  const dtGain = (o) => (2 * (o.s - o.cs) + 3 * o.cs) / (1 + 2 * o.f + 4 * o.c);
  const dtSameName = (a, b) => {
    const x = String(a || '').trim().toLowerCase();
    const y = String(b || '').trim().toLowerCase();
    return !!x && !!y && (x === y || x.startsWith(`${y} `) || x.startsWith(`${y} (`));
  };

  // Варианты проверки проекта для одного персонажа, лучшие сверху.
  function dtOptionsFor(project, char, extras) {
    const key = `${dtBase.at}|${extras.baseAt}|${char.id}|${project.id}`;
    const hit = dtOptionsCache.get(key);
    if (hit) return hit;
    const { helpers, catalog, rules } = dtBase;
    const exhaustion = Math.max(0, Number(char.exhaustion) || 0);
    const T = helpers.tools;
    const projectTools = (project.tools || []).map((name) => catalog.find((t) => t && t.name === name)).filter(Boolean);
    let toolProfs = null; // инструменты, которыми персонаж владеет (класс, предыстория, черты, эффекты)
    try { toolProfs = T ? new Set(T.HE(extras.full, rules)) : null; } catch { /* без владений */ }
    // Как на сайте: навык проверяется с преимуществом, если среди инструментов проекта есть связанный с ним,
    // и персонаж этим инструментом владеет (или у него настроенный мультиинструмент).
    const advantage = (skill) => projectTools.some((t) => (t.relatedSkills || []).includes(skill)
      && (extras.multitool || !!toolProfs?.has(t.name)));
    const out = [];
    let failed = 0;
    for (const skill of project.skills || []) {
      try {
        const b = helpers.skill(extras.full, skill, rules);
        const adv = advantage(skill);
        const note = (b.expertise ? 'экспертиза' : b.trained ? 'владение' : b.jackOfAllTrades ? 'мастер на все руки' : 'без владения')
          + (adv ? ', преимущество' : '');
        out.push({ label: skill, note, adv, mod: (b.abilityMod || 0) + (b.pb || 0) + (b.orderBonus || 0) + (b.checkBonus || 0) - exhaustion });
      } catch { failed++; /* навык, которого функция сайта не знает */ }
    }
    if (T) {
      for (const tool of projectTools) {
        try {
          const proficient = extras.multitool || !!toolProfs?.has(tool.name);
          const owned = extras.items.some((it) => dtSameName(it?.name, tool.name));
          if (!proficient && !owned) continue; // ни владения, ни инструмента — такой проверки у персонажа нет
          const abilityMod = tool.abilityKey ? T.J3(T.T_(extras.full, rules)[tool.abilityKey]) : 0;
          const pb = proficient ? T.Zm(char.level ?? 1) : 0;
          const bonus = Number(T.$R(extras.mechanics, 'tool', tool.name)) || 0;
          const note = extras.multitool ? 'мультиинструмент' : proficient ? 'владение' : 'свой, без владения';
          out.push({ label: tool.name, note, adv: false, mod: abilityMod + pb + bonus - exhaustion });
        } catch { failed++; }
      }
    }
    const dc = Number(project.checkDc) || 0;
    for (const o of out) {
      o.odds = dtOdds(o.mod, dc, o.adv);
      o.gain = dtGain(o.odds);
    }
    out.sort((a, b) => b.gain - a.gain || b.mod - a.mod);
    out.broken = !out.length && failed > 0; // расчёт сайта не сработал ни разу — это не «нечем проверять»
    dtOptionsCache.set(key, out);
    return out;
  }

  const signed = (n) => (n >= 0 ? `+${n}` : `−${Math.abs(n)}`);
  const pct = (x) => `${Math.round(x * 100)}%`;
  const per10 = (gain) => (Math.round(gain * 100) / 10).toLocaleString('ru-RU', { maximumFractionDigits: 1 });
  const deltaPct = (gain) => {
    const d = Math.round((gain - 1) * 100);
    return d === 0 ? '±0%' : `${d > 0 ? '+' : '−'}${Math.abs(d)}%`;
  };
  const tone = (gain) => (gain >= 1.02 ? 'is-good' : gain <= 0.98 ? 'is-bad' : 'is-even');
  const dtCardTitle = (card) => card.querySelector('.downtime-card-main > strong')?.firstChild?.textContent?.trim() ?? '';

  // Насколько проверка лучше вклада «+1» и как это показать. Проверка выгоднее меньше чем на 10% — «незначительно»,
  // нейтральный серый, без подсветки кнопок. Выгоднее на 10%+ — от салатового к зелёному (+40% и выше).
  // Невыгодна — от оранжевого к красному (−60% и ниже), а «+1» подсвечиваем как лучшее действие.
  // Пороги сравниваем с тем же округлённым процентом, что видит игрок (иначе 1,65/1,5 = 1,0999… дало бы «+10%», но «незначительно»).
  const DT_SIGNIFICANT_PCT = 10;
  const dtDeltaRounded = (gain) => Math.round((gain - 1) * 100);
  function dtTone(gain) {
    const p = dtDeltaRounded(gain);
    if (p >= DT_SIGNIFICANT_PCT) return { h: Math.round(90 + 40 * Math.min(1, (p - DT_SIGNIFICANT_PCT) / 30)), s: 60, best: 'check' };
    if (p > 0) return { h: 60, s: 12, best: null };
    if (p === 0) return { h: 45, s: 8, best: null };
    return { h: Math.round(35 * Math.max(0, 1 + p / 60)), s: 72, best: 'plus' };
  }
  const dtToneStyle = (gain) => {
    const t = dtTone(gain);
    return `--vmdt-h:${t.h};--vmdt-s:${t.s}%`;
  };
  function dtVerdictText(gain) {
    const p = dtDeltaRounded(gain);
    const shown = deltaPct(gain);
    if (p >= DT_SIGNIFICANT_PCT) return `Проверка выгоднее: ${shown}`;
    if (p > 0) return `Проверка незначительно выгоднее: ${shown}`;
    if (p === 0) return `Без разницы: ${shown}`;
    return `Проверка невыгоднее: ${shown}`;
  }

  // Подсказка под кнопками карточки: на сколько процентов проверка выгоднее или невыгоднее вклада «+1», и все варианты.
  function dtVerdict(options, char, title) {
    const tip = 'Подсказка закладки «Календарь Вестмарша»: на сколько больше (или меньше) прогресса на каждое ОД даёт проверка '
      + 'лучшим навыком, чем вклад «+1». Учтено: успех +2, натуральная 20 — +3, провал — истощение, натуральная 1 — два истощения; '
      + 'снять истощение стоит 2 ОД; преимущество — если персонаж владеет связанным с навыком инструментом проекта.';
    if (!options.length) {
      const node = h('div', { class: 'vmdt-verdict is-none', title: tip }, options.broken
        ? 'Подсказка закладки не смогла посчитать проверку — похоже, сайт поменял расчёт навыков'
        : 'Проверка недоступна: нет подходящих навыков и инструментов');
      node.dataset.key = node.textContent;
      return node;
    }
    const best = options[0];
    const exhaustion = Math.max(0, Number(char.exhaustion) || 0);
    const rows = options.map((o) => h('li', {
      class: 'vmdt-row',
      style: dtToneStyle(o.gain),
      title: `${o.adv ? 'с преимуществом: ' : ''}успех ${pct(o.odds.s)} (из них натуральная 20 — ${pct(o.odds.cs)}, +3), провал ${pct(o.odds.f)}, `
        + `натуральная 1 — ${pct(o.odds.c)}; 10 ОД → ${per10(o.gain)} прогресса вместо 10`,
    },
      h('span', { class: 'vmdt-skill' }, `${o.label} ${signed(o.mod)}`, h('span', { class: 'vmdt-note' }, ` · ${o.note}`)),
      h('b', { class: 'vmdt-delta' }, deltaPct(o.gain)),
    ));
    const node = h('div', { class: 'vmdt-verdict', style: dtToneStyle(best.gain), title: tip },
      h('div', { class: 'vmdt-vline' },
        h('b', { class: 'vmdt-vpct' }, dtVerdictText(best.gain)),
        h('span', { class: 'vmdt-vskill' }, ` · ${best.label} ${signed(best.mod)}${best.adv ? ' с преимуществом' : ''}`
          + `${exhaustion > 0 ? ` (с истощением −${exhaustion})` : ''}`),
      ),
      h('details', {
        class: 'vmdt-more',
        open: dtOpenCards.has(title),
        ontoggle: (e) => { if (e.currentTarget.open) dtOpenCards.add(title); else dtOpenCards.delete(title); },
      },
        h('summary', null, `Все проверки (${options.length})`),
        h('ol', { class: 'vmdt-rows' }, rows),
      ),
    );
    node.dataset.key = `${best.gain.toFixed(4)}|${node.textContent}`;
    return node;
  }

  // Раскраска родных кнопок: «Проверка» — цветом выгоды, а лучшее из двух действий — зелёной обводкой.
  // Кнопки рисует React: свои пометки держим в data-атрибутах и style (их React не трогает) и меняем только при изменении.
  const dtCheckButton = (card) => [...card.querySelectorAll('.downtime-card-actions button')].find((b) => b.textContent.trim().startsWith('Проверка')) || null;
  function dtMark(btn, attr, value) {
    if (!btn) return;
    if (value == null) {
      if (btn.hasAttribute(attr)) btn.removeAttribute(attr);
    } else if (btn.getAttribute(attr) !== value) {
      btn.setAttribute(attr, value);
    }
  }
  // state: undefined — данных нет, снимаем пометки; { best } — лучший вариант проверки (null, если проверять нечем).
  function dtPaintButtons(card, state) {
    const check = dtCheckButton(card);
    const plus = dtPlusButton(card);
    const best = state ? state.best : null;
    const tone = best ? dtTone(best.gain) : null;
    dtMark(check, 'data-vmdt-check', tone ? `${tone.h}/${tone.s}` : null);
    if (check) {
      const want = tone ? [String(tone.h), `${tone.s}%`] : null;
      for (const [i, prop] of ['--vmdt-h', '--vmdt-s'].entries()) {
        const cur = check.style.getPropertyValue(prop);
        if (want && cur !== want[i]) check.style.setProperty(prop, want[i]);
        else if (!want && cur) check.style.removeProperty(prop);
      }
    }
    dtMark(check, 'data-vmdt-best', state && tone?.best === 'check' ? '' : null);
    dtMark(plus, 'data-vmdt-best', state && (!best || tone?.best === 'plus') ? '' : null);
  }

  // Карточки рисует React страницы: подсказку ставим в правую колонку сразу под кнопками и меняем только при изменении.
  function ensureCardHints() {
    if (!isDowntimePage()) return;
    const cards = [...document.querySelectorAll('li.downtime-card')];
    if (!cards.length) return;
    if (!dtBase && !dtLoading && !dtError) dtRefresh(false);
    const char = dtCurrentChar();
    const extras = char ? dtEnsureExtras(char) : null;
    let errorShown = false;
    for (const card of cards) {
      const legacy = card.querySelector('.downtime-card-main > .vmdt-card-hint'); // плашка прошлой версии закладки
      if (legacy) legacy.remove();
      const side = card.querySelector('.downtime-card-side');
      if (!side) continue;
      const actions = side.querySelector(':scope > .downtime-card-actions');
      const old = side.querySelector(':scope > .vmdt-verdict');
      let node = null;
      let state;
      if (dtError && !errorShown) {
        node = h('div', { class: 'vmdt-verdict is-none' }, `Подсказка закладки недоступна: ${dtError.message}.`);
        node.dataset.key = node.textContent;
        errorShown = true;
      } else if (char && extras) {
        const title = dtCardTitle(card);
        const project = dtBase.projects.find((p) => p.title === title);
        if (project) {
          const options = dtOptionsFor(project, char, extras);
          state = { best: options[0] || null };
          node = dtVerdict(options, char, title);
        }
      }
      dtPaintButtons(card, state);
      if (!node) {
        if (old) old.remove();
        continue;
      }
      if (old && old.dataset.key === node.dataset.key) {
        if (actions && old.previousElementSibling !== actions) actions.after(old); // React дорисовал кнопки ниже — переставляем
        continue;
      }
      if (old) old.remove();
      if (actions) actions.after(node);
      else side.append(node);
    }
  }

  // ---- «Влить все ОД»: жмём родную кнопку «+1 · 1 ОД» по очереди ----
  // Не шлём запросы сами: страница обрабатывает каждое нажатие как обычно (списывает ОД, обновляет цифры, пишет сообщения).
  // После каждого нажатия ждём, пока ОД уменьшатся; если сайт очко не списал — останавливаемся.

  let dtPour = null;        // { title, done, target, abort } — идёт вливание
  let dtPourResult = null;  // { title, text, until } — короткое «Готово» на кнопке

  const waitUntil = (cond, ms) => new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      let ok = false;
      try { ok = !!cond(); } catch { /* ждём дальше */ }
      if (ok) return resolve(true);
      if (Date.now() - t0 > ms) return resolve(false);
      setTimeout(tick, 120);
    };
    tick();
  });

  const dtCardByTitle = (title) => [...document.querySelectorAll('li.downtime-card')].find((c) => dtCardTitle(c) === title) || null;
  const dtPlusButton = (card) => (card
    ? [...card.querySelectorAll('.downtime-card-actions button')].find((b) => !b.classList.contains('vmdt-pour') && b.textContent.trim().startsWith('+1')) || null
    : null);

  async function dtPourClick(title) {
    if (dtPour) {
      if (dtPour.title === title) {
        dtPour.abort = true; // второе нажатие — «Стоп»
        schedule();
      }
      return;
    }
    const ap = dtCurrentAp();
    if (!Number.isFinite(ap) || ap < 1) return;
    const opt = dtCharSelect()?.selectedOptions?.[0]?.textContent || '';
    const name = opt.split('·')[0].trim();
    const exhaustion = Number(/ист\.\s*(\d+)/.exec(opt)?.[1] || 0);
    const char = dtCurrentChar();
    const extras = char ? dtExtras.get(char.id) : null;
    const project = char && extras ? dtBase.projects.find((p) => p.title === title) : null;
    const best = project ? dtOptionsFor(project, char, extras)[0] : null;
    const lines = [`Влить все ${ap} ОД${name ? ` персонажа ${name}` : ''} в «${title}» простым вкладом (+1 за каждое ОД)?`];
    if (best && best.gain >= 1.02) {
      lines.push('', `Подсказка: здесь выгоднее проверка — ${best.label} ${signed(best.mod)}, ${deltaPct(best.gain)} к вкладу.`);
    }
    if (exhaustion > 0) lines.push('', `У персонажа истощение ${exhaustion}: снять его можно только за ОД (2 за уровень).`);
    if (!window.confirm(lines.join('\n'))) return;

    dtPour = { title, done: 0, target: ap, abort: false };
    schedule();
    let reason = '';
    try {
      while (!dtPour.abort && dtPour.done < dtPour.target) {
        const before = dtCurrentAp();
        if (!Number.isFinite(before) || before < 1) break;
        // кнопка может быть занята прошлым нажатием или перерисована страницей — ищем заново
        await waitUntil(() => { const b = dtPlusButton(dtCardByTitle(title)); return b && !b.disabled; }, 6000);
        const plus = dtPlusButton(dtCardByTitle(title));
        if (!plus || plus.disabled) { reason = 'кнопка «+1» недоступна'; break; }
        plus.click();
        const spent = await waitUntil(() => { const a = dtCurrentAp(); return a != null && a < before; }, 12000);
        if (!spent) { reason = 'сайт не списал ОД'; break; }
        dtPour.done += 1;
        schedule();
      }
    } finally {
      const { done, abort } = dtPour;
      dtPour = null;
      dtPourResult = {
        title,
        text: abort ? `Остановлено: влито ${done}` : reason ? `Влито ${done} — ${reason}` : `Готово: влито ${done}`,
        until: Date.now() + 4000,
      };
      setTimeout(() => { dtPourResult = null; schedule(); }, 4100);
      schedule();
      dtRefreshSoon();
    }
  }

  // Кнопка «Влить все» в ряду действий карточки — рядом с «+1 · 1 ОД»; текст и доступность обновляем только при изменении.
  function ensurePourButtons() {
    if (!isDowntimePage()) return;
    const ap = dtCurrentAp();
    for (const card of document.querySelectorAll('li.downtime-card')) {
      const actions = card.querySelector('.downtime-card-actions');
      const plus = dtPlusButton(card);
      const title = dtCardTitle(card);
      let btn = actions ? actions.querySelector(':scope > .vmdt-pour') : null;
      const running = dtPour?.title === title;
      const result = dtPourResult && dtPourResult.title === title && Date.now() < dtPourResult.until ? dtPourResult : null;
      const show = !!plus && (running || !!result || (Number.isFinite(ap) && ap >= 2));
      if (!show) {
        if (btn) btn.remove();
        continue;
      }
      if (!btn) {
        btn = h('button', { type: 'button', class: 'btn ghost vmdt-pour', onclick: () => dtPourClick(title) });
        actions.append(btn);
      }
      const label = running
        ? (dtPour.abort ? 'Останавливаю…' : `Стоп · ${dtPour.done}/${dtPour.target}`)
        : result ? result.text : `Влить все · ${ap} ОД`;
      if (btn.textContent !== label) btn.textContent = label;
      const disabled = running ? dtPour.abort : !!result || !!dtPour || plus.disabled;
      if (btn.disabled !== disabled) btn.disabled = disabled;
      const tip = running ? 'Остановить вливание' : 'Нажать «+1 · 1 ОД» за каждое оставшееся очко действий';
      if (btn.title !== tip) btn.title = tip;
    }
  }

  // ---- «История ручных изменений»: пустую не показываем ----
  // Сайт ставит свёрнутый блок в каждую карточку проекта, а записи грузит, только когда его раскроют. Мы заранее
  // спрашиваем тем же запросом, что и сайт, есть ли записи, и пустой блок прячем. Ответ помним, пока проект не
  // изменится: сайт пересоздаёт блок с ключом «id:updatedAt», его и берём из React (запасной путь — по названию).
  const DT_HISTORY_PARALLEL = 3;
  const dtHistory = new Map(); // «id:updatedAt» → 'loading' | 'empty' | 'has' | 'error'
  let dtHistoryBusy = 0;

  function dtHistoryRef(box, card) {
    try {
      const fk = Object.keys(box).find((k) => k.startsWith('__reactFiber'));
      for (let f = fk ? box[fk] : null, i = 0; f && i < 6; f = f.return, i++) {
        const id = f.memoizedProps?.projectId;
        if (id != null) return { id, key: f.key != null ? String(f.key) : String(id) };
      }
    } catch { /* без React — ищем по названию */ }
    const p = dtBase?.loggedIn ? dtBase.allProjects.find((x) => x.title === dtCardTitle(card)) : null;
    return p ? { id: p.id, key: `${p.id}:${p.updatedAt ?? ''}` } : null;
  }

  function ensureHistoryBlocks() {
    if (!isDowntimePage()) return;
    for (const card of document.querySelectorAll('li.downtime-card')) {
      const box = card.querySelector('details.downtime-adjustment-history');
      if (!box) continue;
      const ref = dtHistoryRef(box, card);
      const state = ref ? dtHistory.get(ref.key) : undefined;
      if (ref && state === undefined && dtHistoryBusy < DT_HISTORY_PARALLEL) {
        dtHistory.set(ref.key, 'loading');
        dtHistoryBusy++;
        rpcNs('downtime', 'FetchStrongholdProjectAdjustments', [ref.id])
          .then((list) => dtHistory.set(ref.key, Array.isArray(list) && !list.length ? 'empty' : 'has'))
          .catch(() => dtHistory.set(ref.key, 'error')) // не знаем — оставляем как у сайта
          .finally(() => { dtHistoryBusy--; schedule(); });
      }
      dtMark(box, 'data-vmdt-empty', state === 'empty' && !box.open ? '' : null);
    }
  }

  // ---------- встраивание в страницу ----------

  const isGamesPage =() => location.pathname.replace(/\/+$/, '') === '/games';

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

  // ---------- избранное в верхнем меню ----------
  // У каждого пункта меню (и в выпадающих «Мир», «Гильдия»…, и в мобильном) — звёздочка. Отмеченные пункты
  // показываются в шапке между «Вестмаршем» и меню. Хранится в localStorage сайта, только в этом браузере.

  const FAV_KEY = 'vmcal.fav.v1';
  const FAV_ID = 'vmfav';
  let favSig = '';

  function loadFav() {
    try {
      const raw = JSON.parse(localStorage.getItem(FAV_KEY) || '[]');
      if (!Array.isArray(raw)) return [];
      return raw
        .filter((f) => f && typeof f.href === 'string' && f.href.startsWith('/'))
        .map((f) => ({ href: f.href, label: String(f.label || f.href) }));
    } catch {
      return [];
    }
  }
  function saveFav(list) {
    try {
      localStorage.setItem(FAV_KEY, JSON.stringify(list));
    } catch {
      alert('Не удалось сохранить избранное: браузер не даёт писать в хранилище сайта.');
    }
  }

  const routePath = (p) => p.replace(/[?#].*$/, '').replace(/\/+$/, '') || '/';
  // Текст пункта без нашей звёздочки
  const linkLabel = (a) => [...a.childNodes]
    .filter((n) => !(n.nodeType === 1 && n.classList.contains('vmfav-star')))
    .map((n) => n.textContent).join('').replace(/\s+/g, ' ').trim();
  const menuLinks = () => document.querySelectorAll('header.topbar nav.nav-desktop a[href^="/"], nav.nav-mobile a[href^="/"]');
  // Вставлять в шапку можно только после гидратации React, иначе он перерисует её и сотрёт наши узлы
  const reactReady = (el) => Object.keys(el).some((k) => k.startsWith('__reactFiber')) || Date.now() - startedAt > HYDRATION_FALLBACK_MS;

  function toggleFav(a) {
    const href = a.getAttribute('href');
    const list = loadFav();
    const i = list.findIndex((f) => f.href === href);
    if (i >= 0) list.splice(i, 1);
    else list.push({ href, label: linkLabel(a) || href });
    saveFav(list);
    ensureFavorites();
  }

  function makeStar(a) {
    // Звёздочка внутри ссылки: клик гасим, чтобы не сработал переход по пункту и не закрылось меню
    const act = (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleFav(a);
    };
    return h('span', {
      class: 'vmfav-star', role: 'button', tabindex: 0,
      onclick: act,
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') act(e); },
    });
  }

  // Переход без перезагрузки страницы: иначе скрипт, запущенный закладкой, выгрузится
  function goTo(href) {
    try {
      if (typeof window.next?.router?.push === 'function') {
        window.next.router.push(href);
        return;
      }
    } catch { /* ниже запасные пути */ }
    const native = [...menuLinks()].find((a) => a.getAttribute('href') === href);
    if (native) native.click();
    else location.assign(href);
  }

  function ensureFavorites() {
    const header = document.querySelector('header.topbar');
    if (!header || !reactReady(header)) return;
    const fav = loadFav();
    const favHrefs = new Set(fav.map((f) => f.href));
    let renamed = false;

    for (const a of menuLinks()) {
      const href = a.getAttribute('href');
      let star = a.querySelector(':scope > .vmfav-star');
      if (!star) a.append(star = makeStar(a));
      const on = favHrefs.has(href);
      if (star.dataset.on !== String(on)) {
        star.dataset.on = String(on);
        star.textContent = on ? '★' : '☆';
        star.title = on ? 'Убрать из избранного' : 'В избранное — пункт появится слева в шапке';
        star.setAttribute('aria-label', star.title);
        star.setAttribute('aria-pressed', String(on));
      }
      // сайт переименовал пункт — подпись в избранном тоже меняем
      const f = on ? fav.find((x) => x.href === href) : null;
      const label = f ? linkLabel(a) : '';
      if (f && label && f.label !== label) {
        f.label = label;
        renamed = true;
      }
    }
    if (renamed) saveFav(fav);

    let bar = document.getElementById(FAV_ID);
    if (!fav.length) {
      bar?.remove();
      favSig = '';
      return;
    }
    const path = routePath(location.pathname);
    const sig = JSON.stringify([fav, path]);
    if (!bar || sig !== favSig) {
      const fresh = h('nav', { id: FAV_ID, class: 'vmfav', 'aria-label': 'Избранное' },
        fav.map((f) => {
          const to = routePath(f.href);
          const active = path === to || (to !== '/' && path.startsWith(`${to}/`));
          return h('a', {
            class: `nav-top-link vmfav-link${active ? ' active' : ''}`,
            href: f.href,
            title: `${f.label} — убрать из избранного можно звёздочкой в меню`,
            'aria-current': active ? 'page' : null,
            onclick: (e) => {
              if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; // в новой вкладке — как обычно
              e.preventDefault();
              goTo(f.href);
            },
          }, f.label);
        }));
      if (bar) bar.replaceWith(fresh);
      bar = fresh;
      favSig = sig;
    }
    const brand = header.querySelector(':scope > a.brand');
    if (brand ? bar.previousElementSibling !== brand : header.firstElementChild !== bar) {
      if (brand) brand.after(bar);
      else header.prepend(bar);
    }
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
      ensureCardHints();
      ensurePourButtons();
      ensureHistoryBlocks();
      ensureFavorites();
    });
  }

  const onReturn = () => {
    if (document.visibilityState !== 'visible') return;
    if (isGamesPage() && document.getElementById(ROOT_ID)) refresh(false);
    if (isDowntimePage() && document.querySelector('li.downtime-card')) dtRefresh(false);
  };

  // Цвета берём из переменных темы сайта — так блок сам подстраивается под светлую и тёмную тему.
  const CSS_TEXT = `
/* Лента стоит первой внутри <main> над панелью «Игры». Сайт центрирует колонку 960px боковыми полями <main>
   (padding-inline: max(1rem, (100% - 960px)/2)). Пока лента есть, поля снимаем с <main> и отдаём остальному
   содержимому — оно стоит там же, где у сайта, а лента занимает всю ширину. max-width — на случай старой вёрстки. */
main.main:has(> #vmcal) { --vmcal-gutter: max(1rem, (100% - 960px) / 2); width: 100%; max-width: none; padding-inline: 0; }
main.main:has(> #vmcal) > :not(#vmcal) { width: auto; max-width: none; margin-inline: var(--vmcal-gutter); }
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

/* «Простой»: подсказка под кнопками карточки, раскраска кнопок, «Влить все» */
.vmdt-verdict { --vmdt-h: 45; --vmdt-s: 10%; align-self: stretch; margin-top: .5rem; font-size: .84rem; line-height: 1.35; text-align: right; }
.vmdt-verdict.is-none { color: var(--ink-soft); }
.vmdt-vpct { font-size: .95rem; color: hsl(var(--vmdt-h) var(--vmdt-s, 70%) 30%); }
.vmdt-vskill { color: var(--ink-soft); }
.vmdt-more { margin-top: .15rem; }
.vmdt-more summary { cursor: pointer; color: var(--ink-soft); font-size: .8rem; }
.vmdt-rows { list-style: none; margin: .3rem 0 0; padding: 0; display: grid; gap: .15rem; text-align: left; }
.vmdt-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: .6rem; align-items: baseline;
  padding: .15rem .45rem; border-radius: 6px; border-left: 3px solid hsl(var(--vmdt-h) var(--vmdt-s, 70%) 45%);
  background: hsl(var(--vmdt-h) var(--vmdt-s, 70%) 45% / .09); }
.vmdt-skill { min-width: 0; }
.vmdt-note { color: var(--ink-soft); }
.vmdt-delta { text-align: right; white-space: nowrap; color: hsl(var(--vmdt-h) var(--vmdt-s, 70%) 30%); }
[data-theme=dark] .vmdt-vpct, [data-theme=dark] .vmdt-delta { color: hsl(var(--vmdt-h) var(--vmdt-s, 70%) 68%); }
.downtime-card .downtime-card-actions button.btn[data-vmdt-check] { border-color: hsl(var(--vmdt-h) var(--vmdt-s, 65%) 42%);
  color: hsl(var(--vmdt-h) var(--vmdt-s, 70%) 27%); background: hsl(var(--vmdt-h) var(--vmdt-s, 70%) 45% / .15); }
[data-theme=dark] .downtime-card .downtime-card-actions button.btn[data-vmdt-check] { border-color: hsl(var(--vmdt-h) var(--vmdt-s, 60%) 55%);
  color: hsl(var(--vmdt-h) var(--vmdt-s, 70%) 72%); background: hsl(var(--vmdt-h) var(--vmdt-s, 60%) 50% / .2); }
.downtime-card details.downtime-adjustment-history[data-vmdt-empty] { display: none; }
.downtime-card .downtime-card-actions button.btn[data-vmdt-best] { box-shadow: 0 0 0 2px hsl(130 55% 38%), 0 0 0 5px hsl(130 55% 40% / .2); }
@media (max-width: 640px) {
  .vmdt-verdict { text-align: left; }
}

/* свои игры и накладки */
#vmcal, .vmcal-dialog { --vmcal-own: #3e5aa8; --vmcal-own-soft: rgba(62,90,168,.09); --vmcal-on-own: #fff;
  --vmcal-busy-soft: rgba(122,46,46,.08); }
[data-theme=dark] #vmcal, [data-theme=dark] .vmcal-dialog { --vmcal-own: #a5b4f0; --vmcal-own-soft: rgba(165,180,240,.13); --vmcal-on-own: #151522;
  --vmcal-busy-soft: rgba(224,112,112,.13); }
/* отметка «занят» */
.vmcal-day.is-busy .vmcal-day-head { border-color: var(--danger, #a33); background: var(--vmcal-busy-soft); }
.vmcal-day.is-busy .vmcal-dow { color: var(--danger, #a33); }
.vmcal-busy { display: grid; gap: .15rem; width: 100%; margin: 0; padding: .45rem .55rem; border: 1.5px dashed var(--danger, #a33);
  border-radius: var(--radius, 12px); background: var(--vmcal-busy-soft); color: var(--ink); font: inherit; font-size: .8rem;
  text-align: left; cursor: pointer; }
.vmcal-busy:hover { border-style: solid; }
.vmcal-busy b { color: var(--danger, #a33); font-size: .88rem; }
.vmcal-busy span { color: var(--ink-soft); overflow: hidden; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; }
.vmcal-check { display: flex; align-items: center; gap: .65rem; padding: .75rem .85rem; border: 1px solid var(--line-medium, var(--line));
  border-radius: 10px; font-size: .95rem; cursor: pointer; }
.vmcal-check input { flex: none; width: 1.25rem; height: 1.25rem; margin: 0; accent-color: var(--danger, #a33); }
.vmcal-check:has(input:checked) { border-color: var(--danger, #a33); background: var(--vmcal-busy-soft); }
.vmcal-check b { color: var(--danger, #a33); }
.vmcal-day-add { padding-top: .65rem; border-top: 1px solid var(--line); font-size: .9rem; }
.vmcal-add { margin-left: auto; padding: .3rem .85rem; border-radius: 999px; border: 1px dashed var(--vmcal-own); background: var(--vmcal-own-soft);
  color: var(--vmcal-own); font: inherit; font-size: .82rem; font-weight: 700; white-space: nowrap; cursor: pointer; }
.vmcal-add:hover { border-style: solid; }
.vmcal-add + .vmcal-nav { margin-left: 0; }
.vmcal-day-head { cursor: pointer; }
.vmcal-day-head:hover, .vmcal-day-head:focus-visible { border-color: var(--vmcal-own); outline: none; }
button.vmcal-card { appearance: none; width: 100%; margin: 0; padding: 0; font: inherit; text-align: left; cursor: pointer; }
.vmcal-card.is-own { border: 1.5px dashed var(--vmcal-own);
  background: linear-gradient(var(--vmcal-own-soft), var(--vmcal-own-soft)), var(--card-bg); }
.vmcal-card.is-own:hover { border-style: solid; border-color: var(--vmcal-own); }
.vmcal-kind { color: var(--vmcal-own); }
.vmcal-card.is-clash { box-shadow: inset 4px 0 0 var(--danger, #a33); }
.vmcal-card-clash { font-size: .75rem; font-weight: 700; color: var(--danger, #a33);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* окно добавления */
.vmcal-dialog { width: min(28rem, calc(100vw - 1.5rem)); max-height: calc(100dvh - 2rem); padding: 0; overflow: auto;
  border: 1px solid var(--line); border-radius: var(--radius, 12px); background: var(--control-bg-elevated, #fff);
  color: var(--ink); box-shadow: 0 24px 64px rgba(0,0,0,.35); color-scheme: light; }
[data-theme=dark] .vmcal-dialog { color-scheme: dark; }
.vmcal-dialog::backdrop { background: rgba(12,12,20,.5); }
.vmcal-dialog [hidden] { display: none !important; }
.vmcal-form { display: grid; gap: .75rem; padding: 1.1rem 1.15rem 1rem; }
.vmcal-form h3 { margin: 0; font-family: Fraunces, Georgia, serif; font-size: 1.15rem; line-height: 1.25; }
.vmcal-seg { display: grid; grid-template-columns: repeat(3, 1fr); gap: .2rem; padding: .2rem; border-radius: 999px;
  border: 1px solid var(--line); background: var(--surface-muted, rgba(0,0,0,.04)); }
.vmcal-seg button { padding: .45rem .4rem; border: 0; border-radius: 999px; background: transparent; color: var(--ink-soft);
  font: inherit; font-size: .9rem; font-weight: 600; cursor: pointer; }
.vmcal-seg button[aria-pressed=true] { background: var(--vmcal-own); color: var(--vmcal-on-own); }
.vmcal-row { display: grid; grid-template-columns: 1.35fr 1fr .75fr; gap: .6rem; }
.vmcal-row.two { grid-template-columns: 1fr 1fr; }
.vmcal-stack { display: grid; gap: .75rem; }
.vmcal-field { display: grid; gap: .25rem; min-width: 0; font-size: .78rem; font-weight: 600; color: var(--ink-soft); }
.vmcal-field input, .vmcal-field select, .vmcal-field textarea { box-sizing: border-box; width: 100%; min-width: 0; height: 2.5rem;
  padding: 0 .6rem; border: 1px solid var(--line-medium, var(--line)); border-radius: 8px; background: var(--control-bg, transparent);
  color: var(--ink); font: inherit; font-size: 16px; font-weight: 400; }
.vmcal-field textarea { height: auto; min-height: 4.6rem; padding: .5rem .6rem; line-height: 1.35; resize: vertical; }
.vmcal-field input:focus, .vmcal-field select:focus, .vmcal-field textarea:focus { outline: 2px solid var(--vmcal-own); outline-offset: -1px; }
.vmcal-img { display: flex; align-items: center; gap: .75rem; min-height: 2.5rem; }
.vmcal-img-preview { flex: none; width: 7.5rem; height: 2.5rem; object-fit: cover; border-radius: 6px; border: 1px solid var(--line); }
.vmcal-img-actions { display: flex; flex-wrap: wrap; align-items: center; gap: .4rem .6rem; font-weight: 400; }
.vmcal-img-actions .vmcal-link { margin-left: .2rem; }
.vmcal-img-status { font-weight: 400; }
/* кадрирование */
.vmcal-crop-dialog { width: min(34rem, calc(100vw - 1.5rem)); }
.vmcal-crop { position: relative; overflow: hidden; border-radius: 10px; background: #111; touch-action: none;
  cursor: grab; user-select: none; -webkit-user-select: none; }
.vmcal-crop.is-dragging { cursor: grabbing; }
.vmcal-crop-img { position: absolute; left: 0; top: 0; max-width: none; max-height: none; transform-origin: 0 0;
  pointer-events: none; user-select: none; -webkit-user-drag: none; }
.vmcal-crop-win { position: absolute; border-radius: 4px; outline: 2px solid #fff; pointer-events: none;
  box-shadow: 0 0 0 100vmax rgba(10,10,18,.6); }
.vmcal-zoom { display: flex; align-items: center; gap: .6rem; }
.vmcal-zoom input { flex: 1 1 auto; min-width: 0; accent-color: var(--vmcal-own); }
.vmcal-zoom .vmcal-btn { flex: none; width: 2.25rem; padding: .3rem 0; font-size: 1.1rem; line-height: 1; }
.vmcal-btn.small { padding: .35rem .85rem; font-size: .85rem; }
.vmcal-links { display: flex; flex-wrap: wrap; gap: .25rem 1.1rem; margin-top: -.35rem; font-size: .85rem; }
.vmcal-empty { display: grid; justify-items: start; gap: .65rem; padding: .85rem .9rem; border: 1px dashed var(--vmcal-own);
  border-radius: 10px; background: var(--vmcal-own-soft); }
.vmcal-empty p { margin: 0; font-size: .9rem; line-height: 1.4; }
.vmcal-entry-head { display: flex; align-items: flex-start; gap: .75rem; font-size: .95rem; }
.vmcal-entry-head img { flex: none; width: 7.5rem; height: 2.5rem; object-fit: cover; border-radius: 6px; }
.vmcal-who { margin: .2rem 0 0; font-size: .85rem; }
.vmcal-desc { margin: .25rem 0 0; font-size: .82rem; line-height: 1.35; color: var(--ink-soft); white-space: pre-line;
  overflow: hidden; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; }
.vmcal-hint { margin: 0; font-size: .78rem; color: var(--ink-soft); }
.vmcal-link { padding: 0; border: 0; background: none; color: var(--vmcal-own); font: inherit; font-weight: 600;
  text-decoration: underline; cursor: pointer; }
.vmcal-dialog:focus { outline: none; }
.vmcal-actions { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; margin-top: .25rem; }
.vmcal-actions-extra, .vmcal-actions-main { display: flex; flex-wrap: wrap; gap: .5rem; }
.vmcal-actions-main { margin-left: auto; }
.vmcal-btn { padding: .5rem 1rem; border-radius: 999px; border: 1px solid var(--line-medium, var(--line)); background: transparent;
  color: var(--ink); font: inherit; font-size: .9rem; font-weight: 600; cursor: pointer; }
.vmcal-btn:hover { border-color: var(--vmcal-own); }
.vmcal-btn.primary { border-color: var(--vmcal-own); background: var(--vmcal-own); color: var(--vmcal-on-own); }
.vmcal-btn.danger { color: var(--danger, #a33); }
.vmcal-btn.danger:hover { border-color: var(--danger, #a33); }
@media (max-width: 480px) {
  .vmcal-row { grid-template-columns: 1fr 1fr; }
  .vmcal-row > :first-child { grid-column: 1 / -1; }
  .vmcal-row.two > :first-child { grid-column: auto; }
}
@media (max-width: 720px) {
  main.main:has(> #vmcal) { --vmcal-gutter: max(.625rem, (100% - 960px) / 2); }
  #vmcal { margin-inline: .625rem; padding: .7rem .6rem .5rem; }
}
@media (max-width: 640px) {
  .vmcal-day { width: 10.5rem; }
  .vmcal-thumb { height: 52px; }
  .vmcal-nav { display: none; }
}

/* ---------- избранное в шапке ---------- */
:root { --vmfav-gold: #b8860b; }
[data-theme="dark"] { --vmfav-gold: #e3b54f; }
.vmfav { display: flex; align-items: center; gap: .1rem .3rem; flex: 0 1 auto; min-width: 0; overflow-x: auto;
  scrollbar-width: none; padding-right: .75rem; border-right: 1px solid var(--line); }
.vmfav::-webkit-scrollbar { display: none; }
.vmfav::before { content: "★"; flex: none; margin-right: .1rem; font-size: .8rem; color: var(--vmfav-gold); }
.vmfav .vmfav-link { display: inline-flex; align-items: center; flex: none; padding: .35rem .45rem; border-radius: 8px;
  font-size: .88rem; font-weight: 600; color: var(--ink-soft); white-space: nowrap; text-decoration: none; box-shadow: none; }
.vmfav .vmfav-link:hover { color: var(--ink); }
.vmfav .vmfav-link.active { color: var(--ink); box-shadow: inset 0 -2px 0 var(--moss); }
.vmfav-star { display: inline-flex; align-items: center; justify-content: center; flex: none; width: 1.5em; height: 1.5em;
  margin-left: auto; border-radius: 6px; font-size: .95em; font-weight: 400; line-height: 1; color: var(--ink-soft);
  opacity: .35; cursor: pointer; user-select: none; transition: opacity .15s, color .15s, transform .15s; }
a:hover > .vmfav-star { opacity: .75; }
.vmfav-star[data-on="true"] { color: var(--vmfav-gold); opacity: 1; }
.vmfav-star:hover, .vmfav-star:focus-visible { opacity: 1; color: var(--vmfav-gold); transform: scale(1.2); outline: none; }
/* в выпадающих и мобильном меню: название слева, звёздочка справа */
.app-shell :is(.nav-desktop .nav-group__links, .nav-mobile) a:has(> .vmfav-star) { display: flex; align-items: center; gap: .5rem; }
/* верхние пункты («Игры», «Мастера»…): звёздочка в уголке и только при наведении — меню не раздвигается */
.app-shell .nav-desktop .nav-top-link { position: relative; }
.app-shell .nav-desktop .nav-top-link > .vmfav-star { position: absolute; top: -.45rem; right: -.55rem; width: 1.15rem; height: 1.15rem;
  font-size: .78rem; opacity: 0; }
.app-shell .nav-desktop .nav-top-link:hover > .vmfav-star, .app-shell .nav-desktop .nav-top-link > .vmfav-star:focus-visible { opacity: .85; }
.app-shell .nav-desktop .nav-top-link > .vmfav-star:hover { opacity: 1; }
@media (max-width: 1100px), (orientation: landscape) and (max-height: 540px) {
  /* планшет: меню спрятано в «бургер» — избранное занимает место между «Вестмаршем» и кнопками, лишнее листается */
  .topbar:has(> #vmfav) > .brand { flex: 0 0 auto; }
  .vmfav { flex: 1 1 0; padding-right: 0; border-right: 0; gap: 0; }
  .vmfav .vmfav-link { padding: .3rem .4rem; font-size: .85rem; }
  .app-shell .nav-mobile .vmfav-star { width: 2.25rem; height: 2.25rem; margin-block: -.5rem; font-size: 1.15rem; opacity: .45; }
  .app-shell .nav-mobile .vmfav-star[data-on="true"] { opacity: 1; }
}
@media (max-width: 600px) {
  /* телефон: в одной строке с «Вестмаршем» места на пару слов — избранное отдельной строкой под ним */
  .topbar:has(> #vmfav) { flex-wrap: wrap; row-gap: .35rem; }
  .topbar:has(> #vmfav) > .brand { flex: 1 1 auto; }
  .vmfav { order: 10; flex: 1 0 100%; margin-inline: -.2rem; }
}
`;

  injectStyle();
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  document.addEventListener('visibilitychange', onReturn);
  window.addEventListener('focus', onReturn);
  // свои игры поменяли в другой вкладке — перерисовываем
  window.addEventListener('storage', (e) => { if (e.key === OWN_KEY) render(); });
  // избранное поменяли в другой вкладке — перестраиваем шапку
  window.addEventListener('storage', (e) => { if (e.key === FAV_KEY) schedule(); });
  // если страница ещё не «ожила» при запуске — повторяем, когда истечёт запасной срок гидратации
  setTimeout(schedule, HYDRATION_FALLBACK_MS + 100);
  // на «Простое» после нажатий кнопок страницы (проверка, отдых, вклад) пересчитываем подсказку
  document.addEventListener('click', (e) => {
    if (isDowntimePage() && e.target.closest?.('button')) dtRefreshSoon();
  }, true);
  // выбрали на странице другого персонажа — подсказки в карточках про него
  document.addEventListener('change', (e) => {
    if (isDowntimePage() && e.target instanceof HTMLSelectElement) schedule();
  }, true);
  schedule();
})();
