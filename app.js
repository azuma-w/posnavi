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
  sessionMarkers: new Map()
};

const map = L.map('map').setView([43.0308, 141.4029], 15);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 20,
  attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

const sessionButton = document.getElementById('sessionButton');
const sessionStatus = document.getElementById('sessionStatus');
const sessionDialog = document.getElementById('sessionDialog');
const sessionForm = document.getElementById('sessionForm');
const houseForm = document.getElementById('houseForm');

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
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.style.display = 'block';
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.style.display = 'none', 1800);
}

function markerClass(status) {
  return {
    'no-posting': 'marker-no-posting',
    'caution': 'marker-caution',
    'multi': 'marker-multi',
    'normal': 'marker-normal'
  }[status] || 'marker-normal';
}

function markerText(house) {
  if (house.status === 'no-posting') return '×';
  const current = state.currentSession?.entries?.[house.id];
  if (current) return current.copies;
  return house.defaultCopies || 1;
}

function createIcon(house) {
  return L.divIcon({
    className: '',
    html: `<div class="marker-label ${markerClass(house.status)}">${markerText(house)}</div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14]
  });
}

function createSessionIcon(entry) {
  return L.divIcon({
    className: '',
    html: `<div class="marker-label marker-session">${entry.copies}</div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15]
  });
}

function renderMarkers() {
  state.markers.forEach(marker => marker.remove());
  state.markers.clear();
  state.sessionMarkers.forEach(marker => marker.remove());
  state.sessionMarkers.clear();

  for (const house of state.houses) {
    const marker = L.marker([house.lat, house.lng], { icon: createIcon(house) }).addTo(map);
    marker.bindTooltip(house.address || '登録住宅');
    marker.on('click', () => handleHouseClick(house));
    state.markers.set(house.id, marker);
  }

  if (!state.currentSession) return;

  for (const entry of Object.values(state.currentSession.entries || {})) {
    if (entry.houseId || !Number.isFinite(entry.lat) || !Number.isFinite(entry.lng)) continue;
    const marker = L.marker([entry.lat, entry.lng], { icon: createSessionIcon(entry) }).addTo(map);
    marker.bindTooltip(`${entry.copies}部`);
    marker.on('click', () => incrementFreeEntry(entry.id));
    state.sessionMarkers.set(entry.id, marker);
  }
}

function handleHouseClick(house) {
  if (!state.currentSession) {
    openHouseEditor(house.id);
    return;
  }

  if (house.status === 'no-posting') {
    showToast('この場所は配布不可に登録されています');
    return;
  }

  const existing = state.currentSession.entries[house.id];
  const step = house.defaultCopies || 1;
  const copies = existing ? existing.copies + step : step;

  state.currentSession.entries[house.id] = {
    id: house.id,
    houseId: house.id,
    address: house.address,
    lat: house.lat,
    lng: house.lng,
    copies,
    updatedAt: new Date().toISOString()
  };

  persistCurrentSession();
  showToast(`${house.address}：${copies}部`);
}

function incrementFreeEntry(id) {
  if (!state.currentSession) return;
  const entry = state.currentSession.entries[id];
  if (!entry) return;
  entry.copies += 1;
  entry.updatedAt = new Date().toISOString();
  persistCurrentSession();
  showToast(`${entry.copies}部`);
}

map.on('click', (event) => {
  if (!state.currentSession) return;

  const id = uid('spot');
  state.currentSession.entries[id] = {
    id,
    houseId: null,
    address: '地図上の配布地点',
    lat: Number(event.latlng.lat),
    lng: Number(event.latlng.lng),
    copies: 1,
    updatedAt: new Date().toISOString()
  };

  persistCurrentSession();
  showToast('1部を記録しました');
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

  sessionStatus.textContent = `${total}部｜開始 ${formatDateTime(state.currentSession.startedAt)}`;
  sessionButton.textContent = '配布終了';
}

sessionButton.addEventListener('click', () => {
  if (state.currentSession) {
    finishSession();
  } else {
    sessionDialog.showModal();
  }
});

sessionForm.addEventListener('submit', (event) => {
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
  const total = entries.reduce((sum, e) => sum + Number(e.copies || 0), 0);
  const ok = confirm(`配布を終了しますか？\n配布部数：${total}部`);
  if (!ok) return;

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

houseForm.addEventListener('submit', (event) => {
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

  list.innerHTML = houses.map(house => `
    <article class="card">
      <h3>${escapeHtml(house.address)}</h3>
      <p>基本部数：${house.defaultCopies}部</p>
      <p>状態：${statusLabel(house.status)}／区分：${typeLabel(house.type)}</p>
      ${house.memo ? `<p>メモ：${escapeHtml(house.memo)}</p>` : ''}
      <div class="card-actions">
        <button data-jump="${house.id}">地図へ</button>
        <button data-edit="${house.id}">編集</button>
      </div>
    </article>
  `).join('');

  list.querySelectorAll('[data-jump]').forEach(button => {
    button.addEventListener('click', () => {
      const house = state.houses.find(item => item.id === button.dataset.jump);
      map.setView([house.lat, house.lng], 18);
      document.getElementById('masterPanel').hidden = true;
    });
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
    </article>
  `).join('');
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

updateSessionUI();
renderMarkers();
renderHistory();
