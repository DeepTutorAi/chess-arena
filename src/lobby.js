// Avatar vocabulary is owned by src/online.js (same list the server
// validates) — re-exported here for the lobby's tests and helpers.
export { AVATAR_GLYPHS } from './online.js';
import { AVATAR_GLYPHS } from './online.js';

const TIME_CATEGORY = Object.freeze({
  unlimited: 'unlimited',
  bullet_1_0: 'bullet',
  bullet_1_1: 'bullet',
  blitz_3_1_5: 'blitz',
  blitz_5_0: 'blitz',
  rapid_10_0: 'rapid',
  rapid_15_0: 'rapid',
  classical_30_0: 'rapid',
});

export const AVATAR_ATLAS = Object.freeze({
  knight: '0% 0%', king: '50% 0%', rook: '100% 0%',
  bishop: '0% 100%', pawns: '50% 100%', shield: '100% 100%',
});

export function roomAction(room) {
  if (room.status === 'waiting' && room.openColor) return 'join';
  if (room.status === 'active' && room.allowSpectators) return 'watch';
  return 'unavailable';
}

export function filterLobbyRooms(rooms, { tab = 'all', time = 'all', search = '' } = {}) {
  const query = String(search).trim().toLocaleLowerCase('en-US');
  return rooms.filter((room) => {
    const action = roomAction(room);
    if (tab === 'open' && action !== 'join') return false;
    if (tab === 'watch' && action !== 'watch') return false;
    if (time !== 'all' && TIME_CATEGORY[room.timeControlId] !== time) return false;
    return !query
      || room.title.toLocaleLowerCase('en-US').includes(query)
      || room.host.name.toLocaleLowerCase('en-US').includes(query);
  });
}

export function formatRoomAge(createdAt, now = Date.now()) {
  const elapsed = Math.max(0, now - createdAt);
  if (elapsed < 60_000) return 'เมื่อสักครู่';
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `${minutes} นาที`;
  return `${Math.floor(minutes / 60)} ชั่วโมง`;
}

const TIME_LABELS = Object.freeze({
  unlimited: 'ไม่จำกัดเวลา',
  bullet_1_0: '1 นาที',
  bullet_1_1: '1+1',
  blitz_3_1_5: '3+1.5',
  blitz_5_0: '5 นาที',
  rapid_10_0: '10 นาที',
  rapid_15_0: '15 นาที',
  classical_30_0: '30 นาที',
});

function element(document, tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function avatarEmblem(document, avatar, className = '') {
  const emblem = element(document, 'span', `lobby-atlas-emblem avatar-${avatar} ${className}`.trim(), AVATAR_GLYPHS[avatar] ?? '♞');
  emblem.style.backgroundPosition = AVATAR_ATLAS[avatar] ?? AVATAR_ATLAS.knight;
  emblem.style.backgroundImage = `url("${new URL('./assets/lobby/lobby-emblems.webp', document.baseURI).toString()}")`;
  emblem.setAttribute('aria-hidden', 'true');
  return emblem;
}

export function createLobbyView({
  root,
  client,
  profile,
  recentRooms = [],
  onCreate = () => {},
  onJoin = () => {},
  onWatch = () => {},
  onReconnect = () => {},
  onClose = () => {},
  document = globalThis.document,
  setTimeoutImpl = globalThis.setTimeout,
  clearTimeoutImpl = globalThis.clearTimeout,
} = {}) {
  if (!root || !client || !document) throw new Error('Lobby view requires root, client, and document');
  const state = {
    rooms: [],
    serverTime: Date.now(),
    stale: false,
    loading: true,
    tab: 'all',
    time: 'all',
    search: '',
    destroyed: false,
    timer: null,
    abortController: null,
  };

  root.className = 'live-lobby-overlay';
  root.style.setProperty('--lobby-hall-url', `url("${new URL('./assets/lobby/night-tournament-hall.webp', document.baseURI).toString()}")`);
  root.innerHTML = '';
  const topbar = element(document, 'header', 'live-lobby-topbar');
  const close = element(document, 'button', 'lobby-back-btn', '← หน้าแรก');
  close.type = 'button';
  close.onclick = onClose;
  const identity = element(document, 'div', 'live-lobby-identity');
  identity.append(
    element(document, 'span', 'live-lobby-kicker', 'CHESS ARENA ONLINE'),
    element(document, 'h1', null, 'Live Tournament Lobby'),
  );
  const create = element(document, 'button', 'lobby-create-btn', '+ CREATE ROOM');
  create.type = 'button';
  create.onclick = onCreate;
  topbar.append(close, identity, create);

  const hero = element(document, 'section', 'live-lobby-hero');
  const heroCopy = element(document, 'div', 'live-lobby-hero-copy');
  heroCopy.append(
    element(document, 'span', 'live-lobby-live', '● LIVE ROOMS'),
    element(document, 'h2', null, 'เลือกโต๊ะ แล้วเข้าสู่เกมทันที'),
    element(document, 'p', null, 'ห้องทั้งหมดด้านล่างมาจากเซิร์ฟเวอร์จริง — JOIN เพื่อเล่น หรือ WATCH เพื่อชมการแข่งขัน'),
  );
  const profilePill = element(document, 'div', 'lobby-profile-pill');
  const profileGlyph = avatarEmblem(document, profile?.avatar ?? 'knight', 'lobby-avatar-glyph');
  const profileName = element(document, 'input', 'lobby-profile-name');
  profileName.value = profile?.name || '';
  profileName.maxLength = 40;
  profileName.placeholder = 'ชื่อที่แสดง';
  profileName.setAttribute('aria-label', 'ชื่อที่แสดง');
  const profileAvatar = element(document, 'select', 'lobby-avatar-select');
  profileAvatar.setAttribute('aria-label', 'ตราประจำตัว');
  for (const avatar of Object.keys(AVATAR_GLYPHS)) {
    const option = element(document, 'option', null, `${AVATAR_GLYPHS[avatar]} ${avatar}`);
    option.value = avatar;
    option.selected = avatar === (profile?.avatar ?? 'knight');
    profileAvatar.appendChild(option);
  }
  profileAvatar.onchange = () => {
    profileGlyph.textContent = AVATAR_GLYPHS[profileAvatar.value];
    profileGlyph.style.backgroundPosition = AVATAR_ATLAS[profileAvatar.value];
  };
  profilePill.append(profileGlyph, profileName, profileAvatar);
  hero.append(heroCopy, profilePill);

  const controls = element(document, 'section', 'live-lobby-controls');
  const tabs = element(document, 'div', 'lobby-tabs');
  const tabLabels = { all: 'ALL', open: 'OPEN', watch: 'WATCH' };
  for (const [value, label] of Object.entries(tabLabels)) {
    const button = element(document, 'button', `lobby-filter-tab${value === 'all' ? ' active' : ''}`, label);
    button.type = 'button';
    button.dataset.tab = value;
    button.onclick = () => {
      state.tab = value;
      for (const other of tabs.querySelectorAll('button')) other.classList.toggle('active', other === button);
      renderRooms();
    };
    tabs.appendChild(button);
  }
  const search = element(document, 'input', 'lobby-search');
  search.type = 'search';
  search.placeholder = 'ค้นหาชื่อห้องหรือเจ้าของ…';
  search.setAttribute('aria-label', 'ค้นหาห้อง');
  search.oninput = () => { state.search = search.value; renderRooms(); };
  const time = element(document, 'select', 'lobby-time-filter');
  time.setAttribute('aria-label', 'กรองรูปแบบเวลา');
  for (const [value, label] of Object.entries({ all: 'เวลาทั้งหมด', bullet: 'Bullet', blitz: 'Blitz', rapid: 'Rapid', unlimited: 'Unlimited' })) {
    const option = element(document, 'option', null, label);
    option.value = value;
    time.appendChild(option);
  }
  time.onchange = () => { state.time = time.value; renderRooms(); };
  const refreshButton = element(document, 'button', 'lobby-refresh-btn', '↻ REFRESH');
  refreshButton.type = 'button';
  controls.append(tabs, search, time, refreshButton);

  const meta = element(document, 'div', 'lobby-meta-row');
  const roomCount = element(document, 'span', 'lobby-room-count', 'กำลังโหลดห้อง…');
  const updated = element(document, 'span', 'lobby-updated');
  meta.append(roomCount, updated);
  const alert = element(document, 'div', 'lobby-alert');
  alert.setAttribute('role', 'alert');
  alert.hidden = true;
  const grid = element(document, 'section', 'live-room-grid');
  grid.setAttribute('aria-live', 'polite');
  const recent = element(document, 'section', 'lobby-recent-section');

  root.append(topbar, hero, controls, meta, alert, grid, recent);

  function renderSkeletons() {
    grid.innerHTML = '';
    for (let index = 0; index < 3; index += 1) {
      const skeleton = element(document, 'div', 'live-room-card skeleton');
      skeleton.setAttribute('aria-hidden', 'true');
      grid.appendChild(skeleton);
    }
  }

  function renderRecent() {
    recent.innerHTML = '';
    if (!recentRooms.length) return;
    recent.appendChild(element(document, 'h2', null, 'Recent / Reconnect'));
    const list = element(document, 'div', 'recent-room-list');
    for (const room of recentRooms) {
      const item = element(document, 'article', 'recent-room-item');
      const copy = element(document, 'div');
      copy.append(element(document, 'strong', null, room.title || 'ห้องออนไลน์'), element(document, 'span', null, 'RECENT · ตรวจสถานะเมื่อเชื่อมต่อ'));
      const button = element(document, 'button', 'room-action secondary', 'RECONNECT');
      button.type = 'button';
      button.onclick = () => onReconnect(room);
      item.append(copy, button);
      list.appendChild(item);
    }
    recent.appendChild(list);
  }

  function renderRooms() {
    if (state.loading) { renderSkeletons(); return; }
    const visible = filterLobbyRooms(state.rooms, state);
    grid.innerHTML = '';
    roomCount.textContent = `${state.rooms.length} ห้องจากเซิร์ฟเวอร์`;
    updated.textContent = state.stale ? 'รายการอาจไม่ใช่สถานะล่าสุด' : 'อัปเดตล่าสุดเมื่อสักครู่';
    if (!visible.length) {
      const empty = element(document, 'div', 'lobby-empty-state');
      const emptyArt = element(document, 'img', 'lobby-empty-art');
      emptyArt.src = './assets/lobby/empty-lobby.webp';
      emptyArt.alt = '';
      emptyArt.onerror = () => emptyArt.remove();
      empty.append(
        emptyArt,
        element(document, 'div', 'lobby-empty-icon', '♞'),
        element(document, 'h3', null, 'ยังไม่มีห้องสาธารณะในหมวดนี้'),
        element(document, 'p', null, 'เปิดโต๊ะใหม่แล้วชวนผู้เล่นจาก Lobby ได้ทันที'),
      );
      const button = element(document, 'button', 'lobby-create-btn', '+ CREATE ROOM');
      button.type = 'button';
      button.onclick = onCreate;
      empty.appendChild(button);
      grid.appendChild(empty);
      return;
    }

    for (const room of visible) {
      const action = roomAction(room);
      const card = element(document, 'article', `live-room-card state-${action}`);
      const head = element(document, 'div', 'live-room-card-head');
      const emblem = avatarEmblem(document, room.host.avatar, 'lobby-emblem');
      const heading = element(document, 'div', 'live-room-heading');
      heading.append(element(document, 'span', 'room-state-label', action === 'join' ? 'OPEN TABLE' : action === 'watch' ? 'LIVE MATCH' : 'UNAVAILABLE'));
      heading.appendChild(element(document, 'h3', null, room.title));
      head.append(emblem, heading);
      const host = element(document, 'div', 'live-room-host');
      host.append(element(document, 'span', 'lobby-avatar-mini', AVATAR_GLYPHS[room.host.avatar] ?? '♞'));
      const names = element(document, 'div');
      names.append(element(document, 'strong', null, room.host.name), element(document, 'span', null, room.guest ? ` vs ${room.guest.name}` : ` · รอฝ่าย${room.openColor === 'w' ? 'ขาว' : 'ดำ'}`));
      host.appendChild(names);
      const facts = element(document, 'div', 'live-room-facts');
      facts.append(
        element(document, 'span', null, TIME_LABELS[room.timeControlId] ?? room.timeControlId),
        element(document, 'span', null, room.guest ? '2/2' : '1/2'),
        element(document, 'span', null, `ผู้ชม ${room.spectatorCount}`),
        element(document, 'span', null, formatRoomAge(room.createdAt, state.serverTime)),
      );
      const button = element(document, 'button', `room-action ${action}`, action === 'join' ? 'JOIN' : action === 'watch' ? 'WATCH' : 'UNAVAILABLE');
      button.type = 'button';
      button.disabled = state.stale || action === 'unavailable';
      button.onclick = () => {
        const currentProfile = { name: profileName.value.trim(), avatar: profileAvatar.value };
        if (!currentProfile.name) {
          profileName.focus();
          alert.hidden = false;
          alert.textContent = 'กรุณาใส่ชื่อที่แสดงก่อนเข้าห้อง';
          return;
        }
        if (action === 'join') onJoin(room, currentProfile);
        else onWatch(room, currentProfile);
      };
      card.append(head, host, facts, button);
      grid.appendChild(card);
    }
  }

  async function refresh() {
    if (state.destroyed) return;
    state.abortController?.abort();
    state.abortController = new AbortController();
    refreshButton.disabled = true;
    alert.hidden = true;
    try {
      const result = await client.listLobby({ status: 'all', time: 'all', search: '' }, state.abortController.signal);
      if (state.destroyed) return;
      state.rooms = result.rooms;
      state.serverTime = result.serverTime;
      state.stale = false;
    } catch (error) {
      if (error?.name === 'AbortError' || state.destroyed) return;
      state.stale = state.rooms.length > 0;
      alert.hidden = false;
      alert.textContent = state.stale
        ? 'เชื่อมต่อ Lobby ไม่สำเร็จ — รายการอาจไม่ใช่สถานะล่าสุด กด Refresh เพื่อลองใหม่'
        : 'โหลด Lobby ไม่สำเร็จ กรุณาตรวจการเชื่อมต่อแล้วลองใหม่';
    } finally {
      state.loading = false;
      refreshButton.disabled = false;
      renderRooms();
      schedule();
    }
  }

  function schedule() {
    if (state.destroyed || document.visibilityState === 'hidden') return;
    if (state.timer !== null) clearTimeoutImpl(state.timer);
    state.timer = setTimeoutImpl(() => { state.timer = null; refresh(); }, 8_000);
  }

  function onVisibility() {
    if (document.visibilityState === 'hidden') {
      if (state.timer !== null) clearTimeoutImpl(state.timer);
      state.timer = null;
      state.abortController?.abort();
    } else refresh();
  }

  refreshButton.onclick = refresh;
  document.addEventListener('visibilitychange', onVisibility);
  renderSkeletons();
  renderRecent();
  const ready = refresh();

  return {
    client,
    ready,
    refresh,
    /** Surface join/watch failures on the lobby itself — the game log lives
     *  behind this fullscreen overlay, so ui.log is invisible here. */
    showError(message) {
      alert.hidden = false;
      alert.textContent = message;
    },
    destroy() {
      state.destroyed = true;
      if (state.timer !== null) clearTimeoutImpl(state.timer);
      state.abortController?.abort();
      document.removeEventListener('visibilitychange', onVisibility);
    },
  };
}
