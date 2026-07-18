// Shared auth guard for authoring pages. Redirects to /login.html when not signed
// in, and renders the signed-in user + a logout control into #userbox if present.
export async function requireSession() {
  let data;
  try {
    data = await (await fetch('/api/auth/me')).json();
  } catch {
    data = { user: null };
  }
  if (!data.user) {
    location.href = `/login.html?next=${encodeURIComponent(location.pathname + location.search)}`;
    return null;
  }
  renderUserbox(data.user);
  return data;
}

function renderUserbox(user) {
  const box = document.getElementById('userbox');
  if (!box) return;
  box.innerHTML = `<a class="muted" href="/settings.html" title="Account settings" style="font-size:13px; text-decoration:none">${esc(user.email)} ⚙</a>
    <button class="btn ghost sm" id="logoutBtn">Log out</button>`;
  document.getElementById('logoutBtn').onclick = async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    location.href = '/login.html';
  };
}

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
