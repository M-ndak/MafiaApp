const body = document.body;
const roomCode = body.dataset.roomCode;
const playerToken = body.dataset.playerToken;

const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
const ws = new WebSocket(`${proto}://${window.location.host}/ws/player/${roomCode}/${playerToken}`);

ws.onmessage = (evt) => {
  const msg = JSON.parse(evt.data);
  if (msg.type === 'room_state') {
    const s = msg.data;
    document.getElementById('lobby-count').textContent = `${s.player_count}/${s.max_players} players joined`;
    if (s.ended) {
      showWinner(s.winner);
    }
  } else if (msg.type === 'role_reveal') {
    showRole(msg.data);
  } else if (msg.type === 'game_ended') {
    showWinner(msg.data.winner);
  } else if (msg.type === 'kicked') {
    showKicked();
  }
};

function showRole(role) {
  document.getElementById('waiting-card').style.display = 'none';
  const revealCard = document.getElementById('reveal-card');
  revealCard.style.display = 'block';
  document.getElementById('role-name').textContent = role.name;
  const tag = document.getElementById('role-tag');
  tag.textContent = role.team;
  tag.className = `tag ${role.team}`;
  document.getElementById('role-desc').textContent = role.description;
}

function showKicked() {
  document.getElementById('waiting-card').style.display = 'none';
  document.getElementById('reveal-card').style.display = 'none';
  const card = document.getElementById('gameover-card');
  card.style.display = 'block';
  const heading = document.getElementById('winner-heading');
  const sub = document.getElementById('winner-sub');
  heading.textContent = 'Removed';
  heading.style.color = 'var(--blood-red)';
  sub.textContent = 'The Don has removed you from this room.';
}

function showWinner(winner) {
  document.getElementById('waiting-card').style.display = 'none';
  document.getElementById('reveal-card').style.display = 'none';
  document.getElementById('gameover-card').style.display = 'block';
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
