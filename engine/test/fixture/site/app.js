// Shared state and helpers for the demo clinic app.
// All data lives in localStorage; a fresh browser context starts from the seed.

const DB_KEY = 'clinic-demo-db-v1';
const SESSION_KEY = 'clinic-demo-session';
const FLASH_KEY = 'clinic-demo-flash';

const USERS = {
  reception1: { password: 'demo123', role: 'reception', name: 'Sara Mitreva' },
  nurse1: { password: 'demo123', role: 'nurse', name: 'Bojan Kirov' },
};

const DOCTORS = ['Dr. Nikolovski', 'Dr. Stojanova', 'Dr. Ristov'];

const SEED = [
  { id: 1, time: '08:30', patient: 'Ana Petrova', dob: '1985-03-12', doctor: 'Dr. Nikolovski', status: 'Scheduled' },
  { id: 2, time: '08:45', patient: 'Anna Petrovska', dob: '1990-07-01', doctor: 'Dr. Nikolovski', status: 'Scheduled' },
  { id: 3, time: '09:00', patient: 'Marko Ilievski', dob: '1978-11-23', doctor: 'Dr. Stojanova', status: 'Checked in', insurance: 'Public' },
  { id: 4, time: '09:15', patient: 'Elena Trajkovska', dob: '2001-02-05', doctor: 'Dr. Stojanova', status: 'Scheduled' },
  { id: 5, time: '09:30', patient: 'Petar Georgiev', dob: '1965-09-30', doctor: 'Dr. Nikolovski', status: 'Scheduled' },
  { id: 6, time: '09:45', patient: 'Ivana Kostova', dob: '1995-12-17', doctor: 'Dr. Ristov', status: 'Scheduled' },
  { id: 7, time: '10:00', patient: 'Stefan Dimitrov', dob: '1982-06-08', doctor: 'Dr. Ristov', status: 'Checked in', insurance: 'Private' },
  { id: 8, time: '10:15', patient: 'Maja Angelovska', dob: '1970-04-22', doctor: 'Dr. Stojanova', status: 'Scheduled' },
];

function loadDb() {
  const raw = localStorage.getItem(DB_KEY);
  if (raw) return JSON.parse(raw);
  const db = { appointments: structuredClone(SEED), nextId: SEED.length + 1 };
  saveDb(db);
  return db;
}

function saveDb(db) {
  localStorage.setItem(DB_KEY, JSON.stringify(db));
}

function currentUser() {
  const raw = localStorage.getItem(SESSION_KEY);
  return raw ? JSON.parse(raw) : null;
}

function login(username, password) {
  const u = USERS[username.trim()];
  if (!u || u.password !== password) return null;
  const session = { username: username.trim(), role: u.role, name: u.name };
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  return session;
}

function logout() {
  localStorage.removeItem(SESSION_KEY);
  location.href = 'index.html';
}

function homeFor(role) {
  return role === 'nurse' ? 'triage.html' : 'worklist.html';
}

// Redirects to login if not signed in with the given role.
function requireRole(role) {
  const u = currentUser();
  if (!u) {
    location.replace('index.html');
    return null;
  }
  if (u.role !== role) {
    location.replace(homeFor(u.role));
    return null;
  }
  return u;
}

function renderHeader(user, active) {
  const nav = user.role === 'reception'
    ? [['worklist.html', 'Worklist'], ['register.html', 'Register walk-in']]
    : [['triage.html', 'Triage queue']];
  const header = document.querySelector('header.app-header');
  header.innerHTML = `
    <div class="brand">St. Luke Clinic</div>
    <nav aria-label="Main">
      ${nav.map(([href, label]) => `<a href="${href}"${active === href ? ' aria-current="page"' : ''}>${label}</a>`).join('')}
    </nav>
    <div class="user">
      <span>${user.name} (${user.role === 'nurse' ? 'Nurse' : 'Reception'})</span>
      <button type="button" class="secondary" id="logout">Log out</button>
    </div>`;
  header.querySelector('#logout').addEventListener('click', logout);
}

function toast(message) {
  let region = document.getElementById('toasts');
  if (!region) {
    region = document.createElement('div');
    region.id = 'toasts';
    region.setAttribute('role', 'status');
    region.setAttribute('aria-live', 'polite');
    document.body.appendChild(region);
  }
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  region.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

// A toast that survives a page navigation (shown on the next page load).
function flash(message) {
  localStorage.setItem(FLASH_KEY, message);
}

function showFlash() {
  const msg = localStorage.getItem(FLASH_KEY);
  if (msg) {
    localStorage.removeItem(FLASH_KEY);
    toast(msg);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function statusBadge(status) {
  const cls = status.toLowerCase().replace(/\s+/g, '-');
  return `<span class="badge ${cls}">${escapeHtml(status)}</span>`;
}
