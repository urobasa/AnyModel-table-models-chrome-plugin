/**
 * AnyModel: таблица моделей.
 * Контент-скрипт для /app/model-catalog: тянет каталог (/api/me/models) и
 * статусы (/api/status/models), рисует быструю таблицу в Shadow DOM.
 * Клик по колонке — критерий сортировки №1, Shift+клик — добавить №2/№3.
 */
(() => {
  if (window.__amtLoaded) return;
  window.__amtLoaded = true;

  const API_MODELS = '/api/me/models?kinds=llm,decision,image,video,audio';
  const API_STATUS = '/api/status/models';
  const BASE_PRICE = 0.05; // $ за 1M токенов при коэффициенте 1

  // Ранг статуса для сортировки и цвета
  const STATUS = {
    operational: { ru: 'Работает', rank: 0, color: '#22c55e' },
    elevated:    { ru: 'Нагрузка', rank: 1, color: '#eab308' },
    degraded:    { ru: 'Частичные сбои', rank: 2, color: '#f97316' },
    outage:      { ru: 'Недоступна', rank: 3, color: '#ef4444' },
    nodata:      { ru: 'Нет данных', rank: 4, color: '#6b7280' },
  };

  const KIND_RU = { llm: 'LLM', image: 'Фото', video: 'Видео', audio: 'Аудио', decision: 'LLM' };

  // Окна аптайма и веса часовых состояний bars:
  // o=ок, e=кратковременные сбои, d=частичные сбои, x=недоступна, '-'=запросов не было
  const WIN_RU = { '6h': '6ч', '12h': '12ч', '24h': '24ч', '168h': '7д' };
  const WIN_HOURS = { '6h': 6, '12h': 12, '24h': 24, '168h': 168 };
  const BAR_W = { o: 1, e: 0.5, d: 0.25, x: 0 };
  // Значки возможностей: ключ capabilities -> буква + подпись
  const CAPS = [
    ['vision', 'V', 'Vision (картинки на вход)'],
    ['imageOutput', 'I', 'Генерация изображений'],
    ['audioInput', 'A', 'Аудио на вход'],
    ['search', 'S', 'Поиск'],
    ['tools', 'T', 'Инструменты'],
    ['reasoning', 'R', 'Reasoning'],
    ['pdf', 'P', 'PDF'],
  ];

  const COLS = [
    { key: 'name',     title: 'Модель',        sort: 'text' },
    { key: 'kind',     title: 'Тип',           sort: 'text' },
    { key: 'priceIn',  title: '$/1M вход',     sort: 'num' },
    { key: 'priceOut', title: '$/1M выход',    sort: 'num' },
    { key: 'ctx',      title: 'Ctx',           sort: 'num' },
    { key: 'maxOut',   title: 'Max out',       sort: 'num' },
    { key: 'caps',     title: 'Возм.',         sort: null },
    { key: 'status',   title: 'Статус',        sort: 'status' },
    { key: '_upv',     title: 'Uptime',        sort: 'num' }, // значение зависит от state.window
  ];

  const DEFAULT_STATE = {
    mode: 'table',            // 'table' | 'cards'
    q: '',
    kind: 'all',              // all | llm | image | video | audio
    avail: 'all',             // all | ok | okwarn | broken
    ctxMin: null,             // в токенах
    priceMax: null,           // $/1M за вход
    window: '6h',             // окно аптайма: 6h | 12h | 24h | 168h
    sort: [{ key: 'priceIn', dir: 1 }, { key: 'ctx', dir: -1 }],
  };

  let state = { ...DEFAULT_STATE };
  let rows = [];
  let statusTime = null;
  let loadError = null;
  let lastStatusModels = [];
  let statusWarn = null;
  let statusBusy = false;

  // ---------- данные ----------

  async function fetchJson(url) {
    const r = await fetch(url, { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    return r.json();
  }

  async function loadStatus() {
    const st = await fetchJson(API_STATUS);
    statusTime = st.generatedAt ? new Date(st.generatedAt) : new Date();
    lastStatusModels = st.models || [];
    return st;
  }

  // Одновременно — только один запрос статусов, чтобы медленный старый ответ
  // не перезаписал более свежий
  async function refreshStatus() {
    if (statusBusy) return;
    statusBusy = true;
    try {
      const st = await loadStatus();
      applyStatusUpdate(st);
      statusWarn = null;
    } catch (e) {
      statusWarn = 'обновление статусов не удалось: ' + String((e && e.message) || e);
    }
    statusBusy = false;
  }

  async function loadAll() {
    loadError = null;
    statusWarn = null;
    // каталог обязателен; сбой статусов не должен прятать таблицу
    let cat = null, catErr = null, stErr = null;
    await Promise.all([
      fetchJson(API_MODELS).then((r) => { cat = r; }).catch((e) => { catErr = e; }),
      loadStatus().catch((e) => { stErr = e; }),
    ]);
    if (catErr) { loadError = String((catErr && catErr.message) || catErr); rows = []; return; }
    if (stErr) statusWarn = 'статусы недоступны: ' + String((stErr && stErr.message) || stErr);
    try {
      const names = cat.names || {};
      // матчинг только по полному id: один slug бывает у разных провайдеров (ag/ и cc/)
      const byId = new Map();
      for (const m of lastStatusModels) byId.set(m.id, m);
      const map = new Map();
      for (const x of cat.data || []) {
        if (map.has(x.id)) continue; // мультимодальные приходят из обоих kinds-запросов
        const slug = x.id.split('/')[1];
        const c = x.capabilities || {};
        const b = (x.billing && x.billing.coefficient) || {};
        const s = byId.get(x.id) || null;
        map.set(x.id, {
          id: x.id,
          name: names[slug] || (s && s.name) || x.id,
          vendor: (s && s.vendorName) || x.owned_by || '',
          kind: s ? (s.kind === 'decision' ? 'llm' : s.kind)
                  : (c.imageOutput ? 'image' : c.audioOutput ? 'audio' : 'llm'),
          ctx: c.contextWindow ?? x.context_length ?? 0,
          maxOut: c.maxOutput ?? x.max_completion_tokens ?? 0,
          cIn: b.input ?? 0,
          cOut: b.output ?? 0,
          priceIn: (b.input ?? 0) * BASE_PRICE,
          priceOut: (b.output ?? 0) * BASE_PRICE,
          caps: c,
          status: s ? (STATUS[s.status] ? s.status : 'nodata') : 'nodata',
          uptime: s && s.uptime != null ? s.uptime : null,
          bars: s ? s.bars || null : null,
        });
      }
      rows = [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru'));
      inheritStatus();
    } catch (e) {
      loadError = String(e && e.message || e);
      rows = [];
    }
  }

  // Производные модели (-review, -medium/-low и т.п.) наследуют статус базовой модели:
  // cx/gpt-5.6-luna-review <- cx/gpt-5.6-luna, ag/...-medium <- ag/...-high
  const DERIVED_SUFFIXES = ['-review', '-non-reasoning', '-reasoning', '-medium', '-low'];
  function inheritStatus() {
    const byId = new Map();
    for (const m of lastStatusModels) byId.set(m.id, m);
    for (const r of rows) {
      if (r.status !== 'nodata') { r.inheritedFrom = null; continue; }
      r.inheritedFrom = null;
      const pre = r.id.split('/')[0], slug = r.id.split('/')[1];
      for (const suf of DERIVED_SUFFIXES) {
        if (!slug.endsWith(suf)) continue;
        const base = slug.slice(0, -suf.length);
        let m = byId.get(pre + '/' + base);
        if (!m && (suf === '-medium' || suf === '-low'))
          m = byId.get(pre + '/' + base + '-high'); // главная модель линейки
        if (m && STATUS[m.status]) {
          r.status = m.status; r.uptime = m.uptime ?? null; r.bars = m.bars || null;
          r.inheritedFrom = m.id;
          if (m.kind && m.kind !== 'decision') r.kind = m.kind;
          break;
        }
      }
    }
  }

  // Аптайм выбранного окна: 7д — серверное значение, короче — оценка по bars
  function uptimeWin(r) {
    if (state.window === '168h') return r.uptime;
    if (!r.bars) return null;
    const tail = r.bars.slice(-WIN_HOURS[state.window]);
    let sum = 0, cnt = 0;
    for (const ch of tail) {
      if (ch === '-') continue; // часы без запросов не учитываем
      sum += BAR_W[ch] ?? 0;
      cnt++;
    }
    return cnt ? sum / cnt : null;
  }

  // ---------- форматирование ----------

  const fmtPrice = (p) => (p === 0 ? 'free' : '$' + p.toFixed(p < 0.1 ? 3 : 2));
  const fmtTok = (t) => !t ? '—' : t >= 1000000 ? (t / 1000000).toFixed(t % 1000000 ? 1 : 0) + 'M'
                              : t >= 1000 ? Math.round(t / 1000) + 'K' : String(t);
  const fmtUptime = (u) => u == null ? '—' : (u * 100).toFixed(1) + '%';
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtTime = (d) => d ? d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '—';

  function parseTok(s) {
    if (!s) return null;
    const m = String(s).trim().toLowerCase().match(/^(\d+(?:[.,]\d+)?)([km]?)$/);
    if (!m) return NaN;
    const n = parseFloat(m[1].replace(',', '.'));
    return Math.round(n * (m[2] === 'm' ? 1e6 : m[2] === 'k' ? 1e3 : 1));
  }

  // ---------- фильтрация и сортировка ----------

  function visible(r) {
    if (state.q) {
      const hay = (r.name + ' ' + r.vendor + ' ' + r.id).toLowerCase();
      if (!hay.includes(state.q)) return false;
    }
    if (state.kind !== 'all' && r.kind !== state.kind) return false;
    const st = r.status;
    if (state.avail === 'ok' && st !== 'operational') return false;
    if (state.avail === 'okwarn' && st !== 'operational' && st !== 'elevated') return false;
    if (state.avail === 'broken' && st !== 'outage' && st !== 'degraded') return false;
    if (state.ctxMin != null && (r.ctx || 0) < state.ctxMin) return false;
    if (state.priceMax != null && r.priceIn > state.priceMax) return false;
    return true;
  }

  // сравнение по колонке (каскад вызывается в sortRows)
  function cmpBy(rowsA, rowsB, key, type) {
    let va, vb;
    if (type === 'status') { va = STATUS[rowsA.status].rank; vb = STATUS[rowsB.status].rank; }
    else if (type === 'text') { va = rowsA[key]; vb = rowsB[key]; return va.localeCompare(vb, 'ru'); }
    else { va = rowsA[key]; vb = rowsB[key]; if (va == null) va = -Infinity; if (vb == null) vb = -Infinity; }
    return (va > vb) - (va < vb);
  }

  function sortRows(list) {
    const s = state.sort.filter((x) => x);
    return list.sort((a, b) => {
      for (const so of s) {
        const col = COLS.find((c) => c.key === so.key);
        if (!col || !col.sort) continue;
        const r = cmpBy(a, b, so.key, col.sort);
        if (r) return r * so.dir;
      }
      return a.name.localeCompare(b.name, 'ru');
    });
  }

  // ---------- DOM: хост и shadow ----------

  const host = document.createElement('div');
  host.id = 'anymodel-table-host';
  const shadow = host.attachShadow({ mode: 'open' });
  let ui = {};

  const CSS = `
    :host { all: initial; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
    * { box-sizing: border-box; }
    .chip { position: fixed; right: 20px; bottom: 20px; z-index: 2147483647; cursor: pointer;
      background: #f59e0b; color: #231000; border: 2px solid #fff; border-radius: 12px;
      padding: 12px 18px; font-size: 15px; font-weight: 800;
      box-shadow: 0 6px 24px rgba(245,158,11,.55), 0 0 0 1px rgba(0,0,0,.25); }
    .chip:hover { transform: scale(1.06); }
    .chip::after { content: ''; position: absolute; inset: -7px; border-radius: 16px;
      border: 2px solid rgba(245,158,11,.75); animation: amt-pulse 1.6s ease-out infinite; }
    @keyframes amt-pulse { 0% { transform: scale(.96); opacity: 1; } 100% { transform: scale(1.15); opacity: 0; } }
    .panel { display: flex; flex-direction: column; min-height: 100vh; padding: 16px;
      background: var(--bg); color: var(--fg); font-size: 14px; }
    :root, .panel { --bg:#0d1117; --fg:#e6edf3; --muted:#8b949e; --line:#30363d; --head:#161b22;
      --row:#0d1117; --row2:#131a23; --accent:#2563eb; }
    @media (prefers-color-scheme: light) { .panel { --bg:#ffffff; --fg:#1f2328; --muted:#656d76;
      --line:#d0d7de; --head:#f6f8fa; --row:#ffffff; --row2:#f6f8fa; } }
    .bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 8px; }
    .bar input, .bar select { background: var(--head); color: var(--fg); border: 1px solid var(--line);
      border-radius: 8px; padding: 7px 10px; font-size: 13px; }
    .bar input[type=text] { width: 200px; }
    .bar input.ctx { width: 110px; } .bar input.price { width: 110px; }
    button { background: #21262d; color: var(--fg); border: 1px solid var(--line); border-radius: 8px;
      padding: 7px 12px; font-size: 13px; cursor: pointer; }
    button:hover { border-color: var(--accent); }
    button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
    .presets { display: flex; flex-wrap: wrap; gap: 8px; margin: 2px 0 8px; }
    .presets button { font-size: 12px; padding: 5px 10px; color: var(--muted); }
    .hint { color: var(--muted); font-size: 12px; margin: 0 0 10px; }
    .meta { color: var(--muted); font-size: 12px; margin: 0 0 8px; }
    .err { color: #ef4444; margin: 24px 0; }
    .scroll { flex: 1; overflow: auto; border: 1px solid var(--line); border-radius: 10px; max-height: calc(100vh - 130px); }
    table { border-collapse: collapse; width: 100%; }
    thead th { position: sticky; top: 0; background: var(--head); text-align: left; padding: 8px 10px;
      font-size: 12px; color: var(--muted); border-bottom: 1px solid var(--line); white-space: nowrap;
      cursor: pointer; user-select: none; z-index: 2; }
    thead th.nosort { cursor: default; }
    tbody td { padding: 6px 10px; border-bottom: 1px solid var(--line); white-space: nowrap; }
    tbody tr:nth-child(even) { background: var(--row2); }
    tbody tr:hover { background: rgba(37,99,235,.12); }
    td.model b { display: block; }
    td.model small { color: var(--muted); font-size: 11px; }
    .num { font-variant-numeric: tabular-nums; }
    .free { color: #22c55e; font-weight: 600; }
    .cap { display: inline-block; min-width: 16px; text-align: center; margin-right: 3px; padding: 1px 3px;
      font-size: 10px; font-weight: 700; border: 1px solid var(--line); border-radius: 5px; color: var(--muted); }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600;
      color: #fff; background: var(--sc, #6b7280); }
    .ord { display: inline-block; min-width: 14px; color: var(--accent); font-weight: 700; }
  `;

  function renderShell() {
    shadow.innerHTML = '';
    const style = document.createElement('style');
    style.textContent = CSS;
    shadow.appendChild(style);

    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.textContent = '⚙ Таблица моделей';
    chip.onclick = () => { state.mode = 'table'; saveState(); applyMode(); };

    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.innerHTML = `
      <div class="bar">
        <button class="primary" data-act="cards">⟨ Карточки (оригинал)</button>
        <input type="text" placeholder="Поиск: имя, провайдер, id…" data-f="q">
        <select data-f="kind">
          <option value="all">Все типы</option><option value="llm">LLM</option>
          <option value="image">Фото</option><option value="video">Видео</option><option value="audio">Аудио</option>
        </select>
        <select data-f="avail">
          <option value="all">Любой статус</option><option value="ok">Работает</option>
          <option value="okwarn">Работает + нагрузка</option><option value="broken">Только со сбоями</option>
        </select>
        <input class="ctx" type="text" placeholder="Ctx ≥ (128K/1M)" data-f="ctxMin">
        <input class="price" type="text" placeholder="$вход ≤ /1M" data-f="priceMax">
        <select data-f="window" title="Окно расчёта аптайма">
          <option value="6h">Аптайм 6ч</option>
          <option value="12h">Аптайм 12ч</option>
          <option value="24h">Аптайм 24ч</option>
          <option value="168h">Аптайм 7д</option>
        </select>
        <button data-act="reset" title="Сбросить фильтры и сортировку">✕ Сброс</button>
        <button data-act="refresh" title="Обновить статусы">↻</button>
      </div>
      <div class="presets">
        <button data-preset="cheapwide">Дёшево + широкий ctx + работает</button>
        <button data-preset="maxctx">Максимальный ctx</button>
        <button data-preset="expensive">Самая дорогая</button>
        <button data-preset="free">Бесплатные</button>
      </div>
      <div class="hint">Клик по колонке — критерий №1 · Shift+клик — добавить критерий №2/№3 · повторный Shift+клик по последнему — убрать. Цена = коэффициент × $0.05 за 1M токенов.</div>
      <div class="meta"></div>
      <div class="err" hidden></div>
      <div class="scroll"><table>
        <thead><tr></tr></thead>
        <tbody></tbody>
      </table></div>
    `;
    shadow.appendChild(panel);
    shadow.appendChild(chip);

    ui = {
      chip, panel,
      q: panel.querySelector('[data-f=q]'),
      kind: panel.querySelector('[data-f=kind]'),
      avail: panel.querySelector('[data-f=avail]'),
      ctxMin: panel.querySelector('[data-f=ctxMin]'),
      priceMax: panel.querySelector('[data-f=priceMax]'),
      window: panel.querySelector('[data-f=window]'),
      meta: panel.querySelector('.meta'),
      err: panel.querySelector('.err'),
      thead: panel.querySelector('thead tr'),
      tbody: panel.querySelector('tbody'),
    };

    // события фильтров
    ui.q.oninput = () => { state.q = ui.q.value.trim().toLowerCase(); saveState(); renderRows(); };
    ui.kind.onchange = () => { state.kind = ui.kind.value; saveState(); renderRows(); };
    ui.avail.onchange = () => { state.avail = ui.avail.value; saveState(); renderRows(); };
    ui.ctxMin.onchange = () => { const v = parseTok(ui.ctxMin.value); state.ctxMin = isNaN(v) ? null : v;
      ui.ctxMin.style.borderColor = (v == null || isNaN(v)) && ui.ctxMin.value ? '#ef4444' : '';
      if (state.ctxMin) ui.ctxMin.value = fmtTok(state.ctxMin); saveState(); renderRows(); };
    ui.priceMax.onchange = () => { const v = parseFloat(ui.priceMax.value.replace(',', '.'));
      state.priceMax = isNaN(v) ? null : v; saveState(); renderRows(); };
    ui.window.onchange = () => { state.window = ui.window.value; saveState(); renderHead(); renderRows(); };
    panel.querySelector('[data-act=reset]').onclick = () => {
      state = { ...DEFAULT_STATE, mode: state.mode, window: state.window };
      syncControls(); saveState(); renderHead(); renderRows();
    };
    panel.querySelector('[data-act=cards]').onclick = () => { state.mode = 'cards'; saveState(); applyMode(); };
    panel.querySelector('[data-act=refresh]').onclick = async (e) => {
      e.target.disabled = true;
      await refreshStatus();
      e.target.disabled = false; renderRows();
    };
    panel.querySelectorAll('[data-preset]').forEach((b) => { b.onclick = () => applyPreset(b.dataset.preset); });

    renderHead();
  }

  function applyPreset(name) {
    const P = {
      cheapwide: { avail: 'ok', sort: [{ key: 'priceIn', dir: 1 }, { key: 'ctx', dir: -1 }] },
      maxctx:    { sort: [{ key: 'ctx', dir: -1 }] },
      expensive: { sort: [{ key: 'priceIn', dir: -1 }, { key: 'priceOut', dir: -1 }] },
      free:      { priceMax: 0, sort: [{ key: 'ctx', dir: -1 }] },
    }[name];
    if (!P) return;
    Object.assign(state, P);
    syncControls(); saveState(); renderHead(); renderRows();
  }

  function applyStatusUpdate(st) {
    // подтянуть новые статусы в уже собранные строки (без перезагрузки каталога)
    lastStatusModels = st.models || [];
    const byId = new Map();
    for (const m of lastStatusModels) byId.set(m.id, m);
    for (const r of rows) {
      const m = byId.get(r.id);
      if (m) {
        r.status = STATUS[m.status] ? m.status : 'nodata';
        r.uptime = m.uptime ?? null; r.bars = m.bars || null;
        r.kind = m.kind === 'decision' ? 'llm' : (m.kind || r.kind);
      } else { r.status = 'nodata'; r.uptime = null; r.bars = null; }
    }
    inheritStatus();
  }

  function renderHead() {
    ui.thead.innerHTML = '';
    for (const col of COLS) {
      const th = document.createElement('th');
      th.textContent = col.key === '_upv' ? 'Uptime ' + WIN_RU[state.window] : col.title;
      if (col.key === '_upv') th.title =
        '7д — значение сервера; 6/12/24ч — оценка по часовым интервалам: оки=1, кратковр.=0.5, частичные=0.25, недоступна=0; часы без запросов исключены';
      const idx = state.sort.findIndex((s) => s.key === col.key);
      if (col.sort) {
        if (idx >= 0) {
          const so = state.sort[idx];
          const ord = document.createElement('span');
          ord.className = 'ord';
          ord.textContent = (idx + 1) + (so.dir === 1 ? '↑' : '↓');
          th.appendChild(ord);
        }
        th.onclick = (e) => {
          const i = state.sort.findIndex((s) => s.key === col.key);
          if (!e.shiftKey) {
            // одиночный клик: сделать критерием №1 (или развернуть, если уже №1)
            if (i === 0) state.sort[0].dir *= -1;
            else state.sort = [{ key: col.key, dir: col.sort === 'num' || col.sort === 'status' ? 1 : 1 }, ...state.sort];
          } else {
            if (i >= 0) state.sort.splice(i, 1); // снять критерий
            else state.sort.push({ key: col.key, dir: 1 });
          }
          if (!state.sort.length) state.sort = [{ ...DEFAULT_STATE.sort[0] }];
          saveState(); renderHead(); renderRows();
        };
      } else th.className = 'nosort';
      ui.thead.appendChild(th);
    }
  }

  function renderRows() {
    if (loadError) {
      ui.err.hidden = false;
      ui.err.textContent = 'Не удалось получить данные: ' + loadError +
        '. Если вы разлогинились — войдите и обновите страницу.';
      ui.tbody.innerHTML = '';
      ui.meta.textContent = '';
      return;
    }
    ui.err.hidden = true;
    const list = rows.filter(visible);
    for (const r of list) r._upv = uptimeWin(r);
    sortRows(list);
    const frag = document.createDocumentFragment();
    for (const r of list) {
      const tr = document.createElement('tr');

      const tdName = document.createElement('td');
      tdName.className = 'model';
      tdName.innerHTML = `<b>${esc(r.name)}</b><small>${esc(r.vendor)} · ${esc(r.id)}</small>`;
      tr.appendChild(tdName);

      const tdKind = document.createElement('td');
      tdKind.textContent = KIND_RU[r.kind] || r.kind;
      tr.appendChild(tdKind);

      const tdPin = document.createElement('td');
      tdPin.className = 'num' + (r.priceIn === 0 ? ' free' : '');
      tdPin.textContent = fmtPrice(r.priceIn);
      tr.appendChild(tdPin);

      const tdPout = document.createElement('td');
      tdPout.className = 'num' + (r.priceOut === 0 ? ' free' : '');
      tdPout.textContent = fmtPrice(r.priceOut);
      tr.appendChild(tdPout);

      const tdCtx = document.createElement('td');
      tdCtx.className = 'num';
      tdCtx.textContent = fmtTok(r.ctx);
      tdCtx.title = r.ctx ? r.ctx.toLocaleString('ru-RU') + ' токенов' : '';
      tr.appendChild(tdCtx);

      const tdMax = document.createElement('td');
      tdMax.className = 'num';
      tdMax.textContent = fmtTok(r.maxOut);
      tr.appendChild(tdMax);

      const tdCaps = document.createElement('td');
      for (const [k, letter, title] of CAPS) {
        if (r.caps && r.caps[k]) {
          const s = document.createElement('span');
          s.className = 'cap'; s.textContent = letter; s.title = title;
          tdCaps.appendChild(s);
        }
      }
      tr.appendChild(tdCaps);

      const tdSt = document.createElement('td');
      const st = STATUS[r.status] || STATUS.nodata;
      const inhTitle = r.inheritedFrom ? ` title="Унаследовано от ${esc(r.inheritedFrom)}"` : '';
      tdSt.innerHTML = `<span class="badge" style="--sc:${st.color}"${inhTitle}>${st.ru}</span>`;
      tr.appendChild(tdSt);

      const tdUp = document.createElement('td');
      tdUp.className = 'num';
      tdUp.textContent = fmtUptime(r._upv);
      tdUp.title = r._upv != null ? 'Окно ' + WIN_RU[state.window] + (r.inheritedFrom ? ' · унаследовано' : '') : '';
      tr.appendChild(tdUp);

      frag.appendChild(tr);
    }
    ui.tbody.innerHTML = '';
    ui.tbody.appendChild(frag);
    ui.meta.textContent = `Показано ${list.length} из ${rows.length} · статус на ${fmtTime(statusTime)}` +
      ` · аптайм: ${WIN_RU[state.window]}` + (statusWarn ? ' · ⚠ ' + statusWarn : '');
  }

  function syncControls() {
    ui.q.value = state.q || '';
    ui.kind.value = state.kind;
    ui.avail.value = state.avail;
    ui.ctxMin.value = state.ctxMin ? fmtTok(state.ctxMin) : '';
    ui.priceMax.value = state.priceMax != null ? state.priceMax : '';
    ui.window.value = state.window;
  }

  // ---------- режим отображения ----------

  function applyMode() {
    document.body.dataset.amtMode = state.mode;
    ui.panel.style.display = state.mode === 'table' ? 'flex' : 'none';
    ui.chip.style.display = state.mode === 'cards' ? 'block' : 'none';
    if (state.mode === 'table') window.scrollTo(0, 0);
  }

  // скрывать оригинальную страницу, когда показана таблица
  function ensureHideStyle() {
    if (document.getElementById('anymodel-table-hide-style')) return;
    const st = document.createElement('style');
    st.id = 'anymodel-table-hide-style';
    st.textContent = 'body[data-amt-mode="table"] > *:not(#anymodel-table-host){display:none!important}';
    (document.head || document.documentElement).appendChild(st);
  }

  // ---------- состояние ----------

  let saveTimer = null;
  function saveState() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { chrome.storage.local.set({ amtState: state }); } catch {}
    }, 250);
  }

  async function restoreState() {
    try {
      const { amtState } = await chrome.storage.local.get('amtState');
      if (amtState) state = { ...DEFAULT_STATE, ...amtState };
    } catch {}
    // защита от битого/устаревшего состояния в storage
    state.mode = state.mode === 'cards' ? 'cards' : 'table';
    if (!WIN_RU[state.window]) state.window = DEFAULT_STATE.window;
    if (typeof state.ctxMin !== 'number' || state.ctxMin < 0) state.ctxMin = null;
    if (typeof state.priceMax !== 'number' || state.priceMax < 0) state.priceMax = null;
    if (!Array.isArray(state.sort)) state.sort = [];
    state.sort = state.sort.filter((s) => s && COLS.some((c) => c.key === s.key && c.sort));
    if (!state.sort.length) state.sort = [{ ...DEFAULT_STATE.sort[0] }];
  }

  // ---------- запуск ----------

  let mountObserver = null;

  function mount() {
    if (!document.body) { setTimeout(mount, 150); return; }
    ensureHideStyle();
    if (!host.isConnected) document.body.appendChild(host);
    // SPA может пересобрать body — вернём хост, если его удалили
    if (!mountObserver) {
      mountObserver = new MutationObserver(() => {
        if (active && !host.isConnected) document.body.appendChild(host);
      });
      mountObserver.observe(document.body, { childList: true });
    }
  }

  // ---------- SPA-навигация ----------
  // Контент-скрипт инжектится только при загрузке документа; переходы внутри
  // сайта (history.pushState) новой загрузки не вызывают — опрашиваем маршрут.
  // (Патчить history из контент-скрипта бесполезно: изолированный мир.)
  const isCatalogRoute = () => location.pathname.startsWith('/app/model-catalog');
  let active = false;

  async function activate() {
    if (active) return;
    active = true;
    mount();
    applyMode();
    ui.meta.textContent = 'Загрузка данных…';
    await loadAll();
    renderRows();
  }

  function deactivate() {
    active = false;
    if (document.body) delete document.body.dataset.amtMode; // вернуть оригинальную страницу
    host.remove();
  }

  function onRouteChange() {
    if (isCatalogRoute()) { if (!active) activate(); }
    else if (active) deactivate();
  }

  (async function init() {
    renderShell();
    await restoreState();
    syncControls();
    // автообновление статусов каждые 2 минуты (только на активном маршруте)
    setInterval(() => { if (active) refreshStatus().then(() => renderRows()); }, 120000);
    setInterval(onRouteChange, 400); // отслеживание SPA-переходов
    onRouteChange();
  })();
})();
