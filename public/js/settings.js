import { requireSession } from '/js/session.js';

const el = (id) => document.getElementById(id);
const session = await requireSession();
if (session) {
  el('whoami').textContent = `Signed in as ${session.user.email}`;
  el('nameInput').value = session.user.name || '';
}

el('saveName').onclick = async () => {
  el('saveName').disabled = true;
  const res = await fetch('/api/auth/profile', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: el('nameInput').value }),
  });
  el('saveName').disabled = false;
  const data = await res.json();
  if (!res.ok) return toast(data.error || 'Could not save.');
  toast('Name updated.');
};

el('savePass').onclick = async () => {
  const current = el('curPass').value;
  const next = el('newPass').value;
  if (next !== el('newPass2').value) return toast('New passwords do not match.');
  el('savePass').disabled = true;
  const res = await fetch('/api/auth/password', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ current, next }),
  });
  el('savePass').disabled = false;
  const data = await res.json();
  if (!res.ok) return toast(data.error || 'Could not change password.');
  el('curPass').value = el('newPass').value = el('newPass2').value = '';
  toast(`Password changed.${data.revokedSessions ? ` Signed out ${data.revokedSessions} other session(s).` : ''}`);
};

function toast(msg) {
  const t = el('toast'); t.textContent = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3200);
}
