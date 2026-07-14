const $ = (id) => document.getElementById(id);
const next = new URLSearchParams(location.search).get('next') || '/';
let mode = 'login'; // 'login' | 'register'

// If already signed in, skip straight through.
fetch('/api/auth/me').then((r) => r.json()).then((d) => { if (d.user) location.href = next; });

function setMode(m) {
  mode = m;
  const register = m === 'register';
  $('heading').textContent = register ? 'Create your account' : 'Sign in';
  $('subheading').textContent = register
    ? 'Set up an account to upload and send documents.'
    : 'Access your documents and send new ones for signature.';
  $('submitBtn').textContent = register ? 'Create account' : 'Sign in';
  $('nameLabel').style.display = register ? '' : 'none';
  $('name').style.display = register ? '' : 'none';
  $('password').autocomplete = register ? 'new-password' : 'current-password';
  $('toggleText').textContent = register ? 'Already have an account?' : 'New to InkWell?';
  $('toggleLink').textContent = register ? 'Sign in' : 'Create an account';
  $('error').style.display = 'none';
}

$('toggleLink').onclick = (e) => { e.preventDefault(); setMode(mode === 'login' ? 'register' : 'login'); };

async function submit() {
  const email = $('email').value.trim();
  const password = $('password').value;
  const name = $('name').value.trim();
  if (!email || !password) return showError('Enter your email and password.');
  $('submitBtn').disabled = true;
  const url = mode === 'register' ? '/api/auth/register' : '/api/auth/login';
  const body = mode === 'register' ? { email, password, name } : { email, password };
  const res = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await res.json();
  $('submitBtn').disabled = false;
  if (!res.ok) return showError(data.error || 'Something went wrong.');
  location.href = next;
}

function showError(msg) {
  const e = $('error');
  e.textContent = msg;
  e.style.display = '';
}

$('submitBtn').onclick = submit;
[$('email'), $('password'), $('name')].forEach((el) =>
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); })
);
