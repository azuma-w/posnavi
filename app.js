const STORAGE_KEYS = {
  houses: 'posnavi_houses_v04',
  sessions: 'posnavi_sessions_v04',
  currentSession: 'posnavi_current_session_v04'
};

const state = {
  houses: load(STORAGE_KEYS.houses, []),
  sessions: load(STORAGE_KEYS.sessions, []),
  currentSession: load(STORAGE_KEYS.currentSession, null),
  markers: new Map(),
  sessionMarkers: new Map(),
  undo: null,
  suppressMapClickUntil: 0
};

const map = L.map('map', { tap: true }).setView([43.0308, 141.4029], 15);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 20,
  attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

const sessionButton = document.getElementById('sessionButton');
const sessionStatus = document.getElementById('sessionStatus');
const sessionDialog = document.getElementById('sessionDialog');
const sessionForm = document.getElementById('sessionForm');
const houseForm = document.getElementById('houseForm');
const toast = document.getElementById('toast');
const toastMessage = document.getElementById('toastMessage');
const undoButton = document.getElementById('undoButton');

function load(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) : fallback;
  } catch (error) {
    console.error(error);
    return fallback;
  }
}

function save(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function uid(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function formatDateTime(iso) {
  if (!iso) return '-';
  return new Intl.DateTimeFormat('ja-JP', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit'
  }).format(new Date(iso));
}

function todayText(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function clearUndo() {
  if (state.undo?.timer) clearTimeout(state.undo.timer);
  state.undo = null;
  undoButton.hidden = true;
}

function showToast(message, undoAction = null) {
  clearTimeout(showToast.timer);
  clearUndo();
  toastMessage.textContent = message;
  toast.style.display = 'flex';

  if (undoAction) {
    undoButton.hidden = false;
    state.undo = {
      action: undoAction,
      timer: setTimeout(() => {
        clearUndo();
        toast.style.display = 'none';
      }, 3000)
    };
  } else {
    showToast.timer = setTimeout(() => {
      toast.style.display = 'none';
    }, 1800);
  }
}

undoButton.addEventListener('click', () => {
  if (!state.undo) return;
  const action = state.undo.action;
  clearUndo();
  action();
  toastMessage.textContent = '取り消しました';
  toast.style.display = 'flex';
  showToast.timer = setTimeout(() => toast.style.display = 'none', 1200);
});

function markerClass(status, isSession = false, isIdle = false) {
  if (isSession) return 'marker-session';
  const base = {
    'no-posting': 'marker-no-posting',
    caution: 'marker-caution',
    multi: 'marker-multi',
    normal: ''
  }[status] || '';
  return `${base} ${isIdle ? 'marker-idle' : ''}`.trim();
}

function getPreviousEntry(houseId) {
  for (const session of state.sessions) {
    const entries = Object.values(session.entries || {});
    const found = entries.find(entry => entry.houseId === houseId || entry.id === houseId);
    if (found) return { ...found, session };
  }
  return null;
}

function getHouseCurrentCopies(houseId) {
  return Number(state.currentSession?.entries?.[houseId]?.copies || 0);
}

function markerHtml({ main, previous = null, status = 'normal', isSession = false, isIdle = false, targetType, targetId }) {
  const prev = previous
    ? `<span class="marker-prev" aria-hidden="true">前回 ${Number(previous.copies || 0)}</span>`
    : '';
  return `
    <div class="marker-wrap ${markerClass(status, isSession, isIdle)}" data-target-type="${targetType}" data-target-id="${targetId}">
      <span class="marker-main">${escapeHtml(main)}</span>
      <button class="marker-menu" type="button" aria-label="詳細を開く">…</button>
      ${prev}
    </div>`;
}

function createHouseIcon(house) {
  const current = getHouseCurrentCopies(house.id);
  const main = house.status === 'no-posting' ? '×' : (current > 0 ? current : '⌂');
  const previous = getPreviousEntry(house.id);
  return L.divIcon({
    className: '',
    html: markerHtml({
      main,
      previous,
      status: house.status,
      isIdle: current === 0,
      targetType: 'house',
      targetId: house.id
    }),
    iconSize: [54, 46],
    iconAnchor: [14, 18]
  });
}

function createFreeIcon(entry) {
  return L.divIcon({
    className: '',
    html: markerHtml({
      main: entry.copies,
      isSession: true,
      targetType: 'spot',
      targetId: entry.id
    }),
    iconSize: [54, 40],
    iconAnchor: [14, 18]
  });
}

function bindMarkerInteractions(marker, targetType, targetId, normalAction) {
  let pressTimer = null;
  let longPressed = false;

  const openDetails = () => {
    longPressed = true;
    state.suppressMapClickUntil = Date.now() + 500;
    openDetail(targetType, targetId);
  };

  marker.on('mousedown touchstart', () => {
    longPressed = false;
    clearTimeout(pressTimer);
    pressTimer = setTimeout(openDetails, 550);
  });

  marker.on('mouseup touchend touchcancel mouseout', () => {
    clearTimeout(pressTimer);
  });

  marker.on('click', event => {
    L.DomEvent.stopPropagation(event);
    if (longPressed) {
      longPressed = false;
      return;
    }
    normalAction();
  });

  marker.on('add', () => {
    requestAnimationFrame(() => {
      const el = marker.getElement();
      const menu = el?.querySelector('.marker-menu');
      if (!menu) return;
      L.DomEvent.disableClickPropagation(menu);
      L.DomEvent.on(menu, 'click', event => {
        L.DomEvent.stop(event);
        state.suppressMapClickUntil = Date.now() + 500;
        openDetail(targetType, targetId);
      });
    });
  });
}

function renderMarkers() {
  state.markers.forEach(marker => marker.remove());
  state.markers.clear();
  state.sessionMarkers.forEach(marker => marker.remove());
  state.sessionMarkers.clear();

  for (const house of state.houses) {
    const marker = L.marker([house.lat, house.lng], { icon: createHouseIcon(house), keyboard: false }).addTo(map);
    marker.bindTooltip(house.address || '登録住宅');
    bindMarkerInteractions(marker, 'house', house.id, () => handleHouseTap(house));
    state.markers.set(house.id, marker);
  }

  if (!state.currentSession) return;

  for (const entry of Object.values(state.currentSession.entries || {})) {
    if (entry.houseId || !Number.isFinite(entry.lat) || !Number.isFinite(entry.lng)) continue;
    const marker = L.marker([entry.lat, entry.lng], { icon: createFreeIcon(entry), keyboard: false }).addTo(map);
    marker.bindTooltip(`${entry.copies}部`);
    bindMarkerInteractions(marker, 'spot', entry.id, () => incrementFreeEntry(entry.id));
    state.sessionMarkers.set(entry.id, marker);
  }
}

function handleHouseTap(house) {
  if (!state.currentSession) {
    openDetail('house', house.id);
    return;
  }

  if (house.status === 'no-posting') {
    showToast('この場所は配布不可です');
    return;
  }

  const previousEntry = state.currentSession.entries[house.id]
    ? structuredClone(state.currentSession.entries[house.id])
    : null;
  const nextCopies = Number(previousEntry?.copies || 0) + 1;

  state.currentSession.entries[house.id] = {
    id: house.id,
    houseId: house.id,
    address: house.address,
    lat: house.lat,
    lng: house.lng,
    copies: nextCopies,
    updatedAt: new Date().toISOString()
  };

  persistCurrentSession();
  showToast(`${nextCopies}部を記録`, () => {
    if (previousEntry) state.currentSession.entries[house.id] = previousEntry;
    else delete state.currentSession.entries[house.id];
    persistCurrentSession();
  });
}

function incrementFreeEntry(id) {
  if (!state.currentSession) return;
  const entry = state.currentSession.entries[id];
  if (!entry) return;
  const previousCopies = Number(entry.copies || 0);
  entry.copies = previousCopies + 1;
  entry.updatedAt = new Date().toISOString();
  persistCurrentSession();
  showToast(`${entry.copies}部を記録`, () => {
    const current = state.currentSession?.entries?.[id];
    if (!current) return;
    current.copies = previousCopies;
    current.updatedAt = new Date().toISOString();
    persistCurrentSession();
  });
}

map.on('click', event => {
  if (!state.currentSession || Date.now() < state.suppressMapClickUntil) return;

  const id = uid('spot');
  const newEntry = {
    id,
    houseId: null,
    address: '地図上の配布地点',
    lat: Number(event.latlng.lat),
    lng: Number(event.latlng.lng),
    copies: 1,
    updatedAt: new Date().toISOString()
  };
  state.currentSession.entries[id] = newEntry;
  persistCurrentSession();
  showToast('1部を記録', () => {
    delete state.currentSession.entries[id];
    persistCurrentSession();
  });
});

function persistCurrentSession() {
  save(STORAGE_KEYS.currentSession, state.currentSession);
  renderMarkers();
  updateSessionUI();
}

function updateSessionUI() {
  if (!state.currentSession) {
    sessionStatus.textContent = '配布は開始されていません';
    sessionButton.textContent = '配布開始';
    sessionButton.classList.add('primary');
    return;
  }

  const total = Object.values(state.currentSession.entries || {})
    .reduce((sum, entry) => sum + Number(entry.copies || 0), 0);
  sessionStatus.textContent = `${total}部｜${formatDateTime(state.currentSession.startedAt)}開始`;
  sessionButton.textContent = '配布終了';
}

sessionButton.addEventListener('click', () => {
  if (state.currentSession) finishSession();
  else sessionDialog.showModal();
});

sessionForm.addEventListener('submit', event => {
  event.preventDefault();
  state.currentSession = {
    id: uid('session'),
    area: '未設定エリア',
    flyer: document.getElementById('sessionFlyer').value.trim(),
    startedAt: new Date().toISOString(),
    endedAt: null,
    entries: {}
  };
  save(STORAGE_KEYS.currentSession, state.currentSession);
  sessionDialog.close();
  sessionForm.reset();
  updateSessionUI();
  renderMarkers();
  showToast('配布を開始しました');
});

function finishSession() {
  const entries = Object.values(state.currentSession.entries || {});
  const total = entries.reduce((sum, entry) => sum + Number(entry.copies || 0), 0);
  if (!confirm(`配布を終了しますか？\n配布部数：${total}部`)) return;

  const finished = {
    ...state.currentSession,
    endedAt: new Date().toISOString(),
    totalCopies: total,
    visitedCount: entries.length
  };
  state.sessions.unshift(finished);
  save(STORAGE_KEYS.sessions, state.sessions);
  state.currentSession = null;
  localStorage.removeItem(STORAGE_KEYS.currentSession);
  clearUndo();
  updateSessionUI();
  renderMarkers();
  renderHistory();
  showToast('配布記録を保存しました');
}

function openPanel(id) {
  document.querySelectorAll('.panel').forEach(panel => panel.hidden = true);
  document.getElementById(id).hidden = false;
  if (id === 'masterPanel') renderMaster();
  if (id === 'historyPanel') renderHistory();
  if (id === 'registerPanel' && !document.getElementById('houseId').value) prepareNewHouse();
}

function openDetail(type, id) {
  const content = document.getElementById('detailContent');

  if (type === 'house') {
    const house = state.houses.find(item => item.id === id);
    if (!house) return;
    const current = getHouseCurrentCopies(house.id);
    const history = getHouseHistory(house.id);
    const previous = history[0];
    content.innerHTML = `
      <dl class="detail-grid">
        <dt>住所・建物名</dt><dd>${escapeHtml(house.address)}</dd>
        <dt>今回</dt><dd>${current}部</dd>
        <dt>前回</dt><dd>${previous ? `${previous.copies}部` : '記録なし'}</dd>
        <dt>基本部数</dt><dd>${house.defaultCopies}部</dd>
        <dt>区分</dt><dd>${typeLabel(house.type)}</dd>
        <dt>状態</dt><dd>${statusLabel(house.status)}</dd>
        <dt>メモ</dt><dd>${escapeHtml(house.memo || '-')}</dd>
      </dl>
      <div class="card-actions">
        <button id="detailJump">地図へ戻る</button>
        <button id="detailEdit" class="primary">編集する</button>
      </div>
      <section class="history-mini">
        <h3>配布履歴</h3>
        ${history.length
          ? history.slice(0, 10).map(item => `<p>${formatDateTime(item.session.startedAt)}：${item.copies}部</p>`).join('')
          : '<p>まだ履歴はありません。</p>'}
      </section>`;
    openPanel('detailPanel');
    document.getElementById('detailJump').addEventListener('click', () => {
      document.getElementById('detailPanel').hidden = true;
      map.setView([house.lat, house.lng], Math.max(map.getZoom(), 18));
    });
    document.getElementById('detailEdit').addEventListener('click', () => openHouseEditor(house.id));
    return;
  }

  const entry = state.currentSession?.entries?.[id];
  if (!entry) return;
  content.innerHTML = `
    <dl class="detail-grid">
      <dt>場所</dt><dd>${escapeHtml(entry.address || '地図上の配布地点')}</dd>
      <dt>今回</dt><dd>${entry.copies}部</dd>
      <dt>登録時刻</dt><dd>${formatDateTime(entry.updatedAt)}</dd>
    </dl>
    <div class="card-actions">
      <button id="spotMinus">1部減らす</button>
      <button id="spotDelete" class="danger">この記録を削除</button>
    </div>`;
  openPanel('detailPanel');
  document.getElementById('spotMinus').addEventListener('click', () => {
    const target = state.currentSession?.entries?.[id];
    if (!target) return;
    if (target.copies <= 1) delete state.currentSession.entries[id];
    else target.copies -= 1;
    persistCurrentSession();
    document.getElementById('detailPanel').hidden = true;
    showToast('記録を修正しました');
  });
  document.getElementById('spotDelete').addEventListener('click', () => {
    if (!confirm('この配布記録を削除しますか？')) return;
    delete state.currentSession.entries[id];
    persistCurrentSession();
    document.getElementById('detailPanel').hidden = true;
    showToast('配布記録を削除しました');
  });
}

function getHouseHistory(houseId) {
  const history = [];
  for (const session of state.sessions) {
    const entry = Object.values(session.entries || {}).find(item => item.houseId === houseId || item.id === houseId);
    if (entry) history.push({ ...entry, session });
  }
  return history;
}

document.querySelectorAll('[data-panel]').forEach(button => {
  button.addEventListener('click', () => openPanel(button.dataset.panel));
});
document.querySelectorAll('.close-panel').forEach(button => {
  button.addEventListener('click', () => button.closest('.panel').hidden = true);
});

function prepareNewHouse() {
  houseForm.reset();
  document.getElementById('houseId').value = '';
  document.getElementById('defaultCopies').value = 1;
  const center = map.getCenter();
  document.getElementById('houseLat').value = center.lat.toFixed(6);
  document.getElementById('houseLng').value = center.lng.toFixed(6);
  document.getElementById('deleteHouse').hidden = true;
}

document.getElementById('useMapCenter').addEventListener('click', () => {
  const center = map.getCenter();
  document.getElementById('houseLat').value = center.lat.toFixed(6);
  document.getElementById('houseLng').value = center.lng.toFixed(6);
  showToast('地図中央の位置を入力しました');
});

houseForm.addEventListener('submit', event => {
  event.preventDefault();
  const id = document.getElementById('houseId').value || uid('house');
  const house = {
    id,
    address: document.getElementById('houseAddress').value.trim(),
    lat: Number(document.getElementById('houseLat').value),
    lng: Number(document.getElementById('houseLng').value),
    defaultCopies: Number(document.getElementById('defaultCopies').value),
    type: document.getElementById('houseType').value,
    status: document.getElementById('houseStatus').value,
    memo: document.getElementById('houseMemo').value.trim(),
    updatedAt: new Date().toISOString()
  };
  const index = state.houses.findIndex(item => item.id === id);
  if (index >= 0) state.houses[index] = house;
  else state.houses.push(house);
  save(STORAGE_KEYS.houses, state.houses);
  renderMarkers();
  renderMaster();
  document.getElementById('registerPanel').hidden = true;
  showToast('住宅情報を保存しました');
});

function openHouseEditor(id) {
  const house = state.houses.find(item => item.id === id);
  if (!house) return;
  document.getElementById('houseId').value = house.id;
  document.getElementById('houseAddress').value = house.address;
  document.getElementById('houseLat').value = house.lat;
  document.getElementById('houseLng').value = house.lng;
  document.getElementById('defaultCopies').value = house.defaultCopies;
  document.getElementById('houseType').value = house.type;
  document.getElementById('houseStatus').value = house.status;
  document.getElementById('houseMemo').value = house.memo || '';
  document.getElementById('deleteHouse').hidden = false;
  openPanel('registerPanel');
}

document.getElementById('deleteHouse').addEventListener('click', () => {
  const id = document.getElementById('houseId').value;
  const house = state.houses.find(item => item.id === id);
  if (!house || !confirm(`${house.address}を削除しますか？`)) return;
  state.houses = state.houses.filter(item => item.id !== id);
  save(STORAGE_KEYS.houses, state.houses);
  renderMarkers();
  document.getElementById('registerPanel').hidden = true;
  showToast('削除しました');
});

function renderMaster(filter = '') {
  const list = document.getElementById('masterList');
  const q = filter.trim().toLowerCase();
  const houses = state.houses.filter(house => {
    const text = `${house.address} ${house.memo || ''}`.toLowerCase();
    return !q || text.includes(q);
  });
  if (!houses.length) {
    list.innerHTML = '<p>登録された住宅はありません。</p>';
    return;
  }
  list.innerHTML = houses.map(house => {
    const previous = getPreviousEntry(house.id);
    return `
      <article class="card">
        <h3>${escapeHtml(house.address)}</h3>
        <p>基本部数：${house.defaultCopies}部／前回：${previous ? `${previous.copies}部` : '記録なし'}</p>
        <p>状態：${statusLabel(house.status)}／区分：${typeLabel(house.type)}</p>
        ${house.memo ? `<p>メモ：${escapeHtml(house.memo)}</p>` : ''}
        <div class="card-actions">
          <button data-jump="${house.id}">地図へ</button>
          <button data-detail="${house.id}">詳細</button>
          <button data-edit="${house.id}">編集</button>
        </div>
      </article>`;
  }).join('');

  list.querySelectorAll('[data-jump]').forEach(button => {
    button.addEventListener('click', () => {
      const house = state.houses.find(item => item.id === button.dataset.jump);
      map.setView([house.lat, house.lng], 18);
      document.getElementById('masterPanel').hidden = true;
    });
  });
  list.querySelectorAll('[data-detail]').forEach(button => {
    button.addEventListener('click', () => openDetail('house', button.dataset.detail));
  });
  list.querySelectorAll('[data-edit]').forEach(button => {
    button.addEventListener('click', () => openHouseEditor(button.dataset.edit));
  });
}

function renderHistory() {
  const list = document.getElementById('historyList');
  const date = document.getElementById('historyDate').value;
  const area = document.getElementById('historyArea').value.trim().toLowerCase();
  const sessions = state.sessions.filter(session => {
    const dateOk = !date || todayText(session.startedAt) === date;
    const areaOk = !area || (session.area || '').toLowerCase().includes(area);
    return dateOk && areaOk;
  });
  if (!sessions.length) {
    list.innerHTML = '<p>該当する配布履歴はありません。</p>';
    return;
  }
  list.innerHTML = sessions.map(session => `
    <article class="card">
      <h3>${escapeHtml(session.area || '未設定エリア')}</h3>
      <p>${formatDateTime(session.startedAt)} ～ ${formatDateTime(session.endedAt)}</p>
      <p>配布物：${escapeHtml(session.flyer || '-')}</p>
      <p>配布部数：${session.totalCopies || 0}部／訪問：${session.visitedCount || 0}件</p>
      <details>
        <summary>配布先を見る</summary>
        ${Object.values(session.entries || {}).map(entry => `<p>${escapeHtml(entry.address || '地図上の配布地点')}：${entry.copies}部</p>`).join('') || '<p>記録なし</p>'}
      </details>
    </article>`).join('');
}

document.getElementById('historyDate').addEventListener('change', renderHistory);
document.getElementById('historyArea').addEventListener('input', renderHistory);
document.getElementById('clearHistoryFilter').addEventListener('click', () => {
  document.getElementById('historyDate').value = '';
  document.getElementById('historyArea').value = '';
  renderHistory();
});

document.getElementById('searchButton').addEventListener('click', runSearch);
document.getElementById('searchInput').addEventListener('keydown', event => {
  if (event.key === 'Enter') runSearch();
});
function runSearch() {
  const q = document.getElementById('searchInput').value.trim();
  if (!q) return;
  renderMaster(q);
  openPanel('masterPanel');
}

function statusLabel(value) {
  return ({ normal: '通常', 'no-posting': '配布不可', caution: '要注意', multi: '複数部予定' })[value] || value;
}
function typeLabel(value) {
  return ({ house: '戸建て', apartment: '集合住宅', company: '会社・店舗', other: 'その他' })[value] || value;
}
function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

window.addEventListener('resize', () => setTimeout(() => map.invalidateSize(), 100));
updateSessionUI();
renderMarkers();
renderHistory();
setTimeout(() => map.invalidateSize(), 100);
