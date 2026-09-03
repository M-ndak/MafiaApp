let roomCode = null;
let hostToken = null;
let maxPlayers = 0;
let allRoles = [];
let selectedRoleIds = new Set();
let ws = null;

const setupCard = document.getElementById('setup-card');
const roomCard = document.getElementById('room-card');
const gameoverCard = document.getElementById('gameover-card');
const setupError = document.getElementById('setup-error');
const roleError = document.getElementById('role-error');
const assignError = document.getElementById('assign-error');
const rosterError = document.getElementById('roster-error');

document.getElementById('create-room-btn').addEventListener('click', createRoom);
document.getElementById('save-roles-btn').addEventListener('click', saveRoles);
document.getElementById('assign-btn').addEventListener('click', assignRoles);
document.getElementById('mafia-wins-btn').addEventListener('click', () => setWinner('mafia'));
document.getElementById('innocents-win-btn').addEventListener('click', () => setWinner('innocent'));
document.getElementById('new-game-btn').addEventListener('click', startNewGame);

// --- Try to resume an existing session first (survives page refresh) ---
window.addEventListener('DOMContentLoaded', tryResumeSession);

async function tryResumeSession() {
  const saved = localStorage.getItem('mafia_host_session');
  if (!saved) return;
  let session;
  try {
    session = JSON.parse(saved);
  } catch (e) {
    localStorage.removeItem('mafia_host_session');
    return;
  }
  try {
    const res = await fetch(`/api/rooms/${session.roomCode}/host_state?host_token=${session.hostToken}`);
    if (!res.ok) {
      localStorage.removeItem('mafia_host_session');
      return;
    }
    const state = await res.json();
    roomCode = session.roomCode;
    hostToken = session.hostToken;
    maxPlayers = state.max_players;

    setupCard.style.display = 'none';
    roomCard.style.display = 'block';
    document.getElementById('room-code').textContent = roomCode;
    document.getElementById('max-players-label').textContent = maxPlayers;

    await loadRoles();
    selectedRoleIds = new Set(state.selected_roles || []);
    document.querySelectorAll('.role-item').forEach(div => {
      if (selectedRoleIds.has(div.dataset.roleId)) div.classList.add('selected');
    });

    renderHostState(state);
    renderQR();
    connectWS();

    if (state.ended) {
      showWinner(state.winner);
    }
  } catch (e) {
    localStorage.removeItem('mafia_host_session');
  }
}

async function createRoom() {
  setupError.textContent = '';
  const mp = parseInt(document.getElementById('max-players').value, 10);
  const password = document.getElementById('host-password').value;
  if (!mp || mp < 2) {
    setupError.textContent = 'Enter a valid number of participants (2+).';
    return;
  }
  if (!password) {
    setupError.textContent = 'Enter the host password.';
    return;
  }
  try {
    const res = await fetch('/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ max_players: mp, password })
    });
    if (!res.ok) throw new Error((await res.json()).detail || 'Failed to create room');
    const data = await res.json();
    roomCode = data.room_code;
    hostToken = data.host_token;
    maxPlayers = mp;

    localStorage.setItem('mafia_host_session', JSON.stringify({ roomCode, hostToken }));

    setupCard.style.display = 'none';
    roomCard.style.display = 'block';
    document.getElementById('room-code').textContent = roomCode;
    document.getElementById('max-players-label').textContent = mp;

    // Load roles + connect the live socket first, independent of QR rendering,
    // so a QR failure can never block the rest of the UI.
    await loadRoles();
    connectWS();
    renderQR();
  } catch (e) {
    setupError.textContent = e.message;
  }
}

function renderQR() {
  const joinUrl = `${window.location.origin}/join?code=${roomCode}`;
  const box = document.getElementById('qr-box');
  box.innerHTML = '';
  try {
    const qr = qrcode(0, 'M');
    qr.addData(joinUrl);
    qr.make();
    const img = document.createElement('div');
    img.innerHTML = qr.createImgTag(6, 8);
    box.appendChild(img);
  } catch (e) {
    console.warn('QR generation failed:', e);
  }
  const link = document.createElement('p');
  link.innerHTML = `<a href="${joinUrl}" style="color:inherit;">${joinUrl}</a>`;
  box.appendChild(link);
}

async function loadRoles() {
  const res = await fetch('/api/roles');
  const data = await res.json();
  allRoles = data.roles;
  const grid = document.getElementById('role-grid');
  grid.innerHTML = '';
  allRoles.forEach(role => {
    const div = document.createElement('div');
    div.className = 'role-item';
    div.dataset.roleId = role.id;
    div.innerHTML = `
      <div class="name">${role.name} <span class="tag ${role.team}">${role.team}</span></div>
      <div class="desc">${role.description}</div>
    `;
    div.addEventListener('click', () => {
      if (selectedRoleIds.has(role.id)) {
        selectedRoleIds.delete(role.id);
        div.classList.remove('selected');
      } else {
        selectedRoleIds.add(role.id);
        div.classList.add('selected');
      }
    });
    grid.appendChild(div);
  });
}

async function saveRoles() {
  roleError.textContent = '';
  try {
    const res = await fetch(`/api/rooms/${roomCode}/select_roles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host_token: hostToken, role_ids: Array.from(selectedRoleIds) })
    });
    if (!res.ok) throw new Error((await res.json()).detail || 'Failed to save roles');
    roleError.style.color = 'var(--good)';
    roleError.textContent = 'Roles saved!';
    setTimeout(() => { roleError.textContent = ''; roleError.style.color = ''; }, 1800);
  } catch (e) {
    roleError.textContent = e.message;
  }
}

async function assignRoles() {
  assignError.textContent = '';
  if (selectedRoleIds.size === 0) {
    assignError.textContent = 'Select at least one role before assigning (save first).';
    return;
  }
  if (!confirm('Assign roles now? This locks the room and cannot be undone.')) return;
  try {
    const res = await fetch(`/api/rooms/${roomCode}/assign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host_token: hostToken })
    });
    if (!res.ok) throw new Error((await res.json()).detail || 'Failed to assign roles');
  } catch (e) {
    assignError.textContent = e.message;
  }
}

async function markDead(playerToken) {
  await fetch(`/api/rooms/${roomCode}/mark_dead`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ host_token: hostToken, player_token: playerToken })
  });
}

async function markAlive(playerToken) {
  await fetch(`/api/rooms/${roomCode}/mark_alive`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ host_token: hostToken, player_token: playerToken })
  });
}

async function useDeadPrivilege(playerToken, kind) {
  await fetch(`/api/rooms/${roomCode}/use_dead_privilege`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ host_token: hostToken, player_token: playerToken, kind })
  });
}

async function kickPlayer(playerToken, playerName) {
  if (!confirm(`Remove ${playerName} from the room? They will be disconnected immediately.`)) return;
  try {
    const res = await fetch(`/api/rooms/${roomCode}/kick_player`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host_token: hostToken, player_token: playerToken })
    });
    if (!res.ok) throw new Error((await res.json()).detail || 'Failed to remove player');
  } catch (e) {
    rosterError.textContent = e.message;
  }
}

async function setWinner(winner) {
  rosterError.textContent = '';
  const label = winner === 'mafia' ? 'the Mafia' : 'the Innocents';
  if (!confirm(`Declare ${label} the winner? This ends the game for everyone.`)) return;
  try {
    const res = await fetch(`/api/rooms/${roomCode}/set_winner`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host_token: hostToken, winner })
    });
    if (!res.ok) throw new Error((await res.json()).detail || 'Failed to set winner');
    const data = await res.json();
    showWinner(data.winner);
  } catch (e) {
    rosterError.textContent = e.message;
  }
}

async function startNewGame() {
  try {
    const res = await fetch(`/api/rooms/${roomCode}/new_game`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host_token: hostToken })
    });
    if (!res.ok) throw new Error((await res.json()).detail || 'Failed to start new game');
    selectedRoleIds = new Set();
    document.querySelectorAll('.role-item').forEach(div => div.classList.remove('selected'));
    gameoverCard.style.display = 'none';
    roomCard.style.display = 'block';
  } catch (e) {
    rosterError.textContent = e.message;
  }
}

function showWinner(winner) {
  roomCard.style.display = 'none';
  gameoverCard.style.display = 'block';
  const heading = document.getElementById('winner-heading');
  const sub = document.getElementById('winner-sub');
  if (winner === 'mafia') {
    heading.textContent = 'The Mafia Wins';
    heading.style.color = 'var(--danger)';
    sub.textContent = 'The underworld has taken over the town.';
  } else {
    heading.textContent = 'The Innocents Win';
    heading.style.color = 'var(--good)';
    sub.textContent = 'Justice prevails \u2014 the town is safe.';
  }
}

function connectWS() {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${window.location.host}/ws/host/${roomCode}/${hostToken}`);
  ws.onmessage = (evt) => {
    const msg = JSON.parse(evt.data);
    if (msg.type === 'host_state') {
      renderHostState(msg.data);
    } else if (msg.type === 'game_ended') {
      showWinner(msg.data.winner);
    }
  };
}

function renderHostState(state) {
  document.getElementById('player-count').textContent = state.player_count;

  const list = document.getElementById('player-list');
  list.innerHTML = '';
  state.players.forEach(p => {
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="dot ${p.connected ? 'online' : ''}"></span>
      <span class="pname">${p.name}</span>
      <button class="kick-btn kick-lobby-btn" data-token="${p.token}" data-name="${p.name}">Kick</button>
    `;
    list.appendChild(li);
  });
  list.querySelectorAll('.kick-lobby-btn').forEach(btn => {
    btn.addEventListener('click', () => kickPlayer(btn.dataset.token, btn.dataset.name));
  });

  const preSection = document.getElementById('pre-assign-section');
  const rosterSection = document.getElementById('roster-section');

  if (!state.assigned) {
    preSection.style.display = 'block';
    rosterSection.style.display = 'none';
    return;
  }

  preSection.style.display = 'none';
  rosterSection.style.display = 'block';

  const roster = document.getElementById('roster-list');
  roster.innerHTML = '';
  state.players.forEach(p => {
    const row = document.createElement('div');
    row.className = 'roster-row' + (p.alive ? '' : ' dead');

    const deadControls = p.alive ? '' : `
      <span class="privilege-count">Convos left: ${p.dead_convo_left}</span>
      <button class="secondary use-convo-btn" data-token="${p.token}" ${p.dead_convo_left <= 0 ? 'disabled' : ''}>Use Convo</button>
      <span class="privilege-count">Votes left: ${p.dead_vote_left}</span>
      <button class="secondary use-vote-btn" data-token="${p.token}" ${p.dead_vote_left <= 0 ? 'disabled' : ''}>Use Vote</button>
    `;

    row.innerHTML = `
      <div class="who">
        <div class="pname">${p.name}</div>
        <div class="prole">${p.role_name || 'Unassigned'}${p.role_team ? ` &middot; ${p.role_team}` : ''}</div>
      </div>
      <span class="status-pill ${p.alive ? 'alive' : 'dead'}">${p.alive ? 'Alive' : 'Dead'}</span>
      <div class="roster-actions">
        ${deadControls}
        <button class="${p.alive ? 'danger' : 'secondary'} toggle-life-btn" data-token="${p.token}">
          ${p.alive ? 'Mark Dead' : 'Revive'}
        </button>
        <button class="kick-btn kick-roster-btn" data-token="${p.token}" data-name="${p.name}">Kick</button>
      </div>
    `;
    roster.appendChild(row);
  });

  roster.querySelectorAll('.toggle-life-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const token = btn.dataset.token;
      const row = state.players.find(p => p.token === token);
      if (row && row.alive) {
        markDead(token);
      } else {
        markAlive(token);
      }
    });
  });
  roster.querySelectorAll('.use-convo-btn').forEach(btn => {
    btn.addEventListener('click', () => useDeadPrivilege(btn.dataset.token, 'convo'));
  });
  roster.querySelectorAll('.use-vote-btn').forEach(btn => {
    btn.addEventListener('click', () => useDeadPrivilege(btn.dataset.token, 'vote'));
  });
  roster.querySelectorAll('.kick-roster-btn').forEach(btn => {
    btn.addEventListener('click', () => kickPlayer(btn.dataset.token, btn.dataset.name));
  });
}
