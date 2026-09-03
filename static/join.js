const params = new URLSearchParams(window.location.search);
const codeParam = params.get('code');
if (codeParam) {
  document.getElementById('room-code').value = codeParam.toUpperCase();
}

document.getElementById('join-btn').addEventListener('click', joinRoom);

async function joinRoom() {
  const errorEl = document.getElementById('join-error');
  errorEl.textContent = '';
  const code = document.getElementById('room-code').value.trim().toUpperCase();
  const name = document.getElementById('player-name').value.trim();
  if (!code || !name) {
    errorEl.textContent = 'Enter both room code and your name.';
    return;
  }
  try {
    const res = await fetch(`/api/rooms/${code}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    if (!res.ok) throw new Error((await res.json()).detail || 'Failed to join');
    const data = await res.json();
    window.location.href = `/play/${data.room_code}/${data.player_token}`;
  } catch (e) {
    errorEl.textContent = e.message;
  }
}
