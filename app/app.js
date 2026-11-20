/* קוראים בכיף — Hebrew reading & writing practice for grades 3–6.
 * Plain JS, no build step. State in localStorage, audio recordings in IndexedDB.
 * Pedagogy (see RESEARCH.md): echo/shadow reading with a model, repeated reading,
 * pre-taught hard words, find-it-in-the-text comprehension, morphology games,
 * scaffolded writing with gentle feedback, effort-based rewards, no timers shown to the child.
 */
'use strict';

const C = window.CONTENT || { texts: [], friendLetters: [], roots: [], sentences: [], combine: [], stories: [] };
const app = document.getElementById('app');

/* ================= helpers ================= */
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
const NIKUD = /[֑-ׇֽֿׁׂׅׄ]/g;
const strip = s => String(s || '').replace(NIKUD, '');
const FINALS = { 'ך': 'כ', 'ם': 'מ', 'ן': 'נ', 'ף': 'פ', 'ץ': 'צ' };
const normFinal = s => s.replace(/[ךםןףץ]/g, c => FINALS[c]);
const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const pick = a => a[Math.floor(Math.random() * a.length)];
const todayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const wordsOf = s => String(s).trim().split(/\s+/).filter(Boolean);
const wait = ms => new Promise(r => setTimeout(r, ms));

/* ================= server API & login ================= */
const API = {
  async call(path, { method = 'GET', body } = {}) {
    let r;
    try {
      r = await fetch('/api' + path, { method, credentials: 'same-origin',
        headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    } catch { const e = new Error('אין חיבור לאינטרנט'); e.status = 0; throw e; }
    let data = {};
    try { data = await r.json(); } catch { }
    if (!r.ok) { const e = new Error(data.error || 'משהו השתבש, נסו שוב'); e.status = r.status; throw e; }
    return data;
  }
};
let user = null; // { id, username, display_name, gender, avatar, role, must_change }
const isAdmin = () => user?.role === 'admin';

/* ================= state (per user, cached on device, synced to server) ================= */
const LEGACY_KEY = 'kria.v1';
const userKey = () => `kria.u.${user?.id ?? 'guest'}`;
const DEFAULTS = {
  profile: { name: '', gender: 'm', avatar: '🦊' },
  settings: { nikud: 'full', size: 26, spacing: 1, rate: 0.85, voice: '', ttsNikud: true, record: true },
  weeklyGoal: 4,
  stars: 0, stickers: [],
  days: {}, reads: {}, games: {}, dict: [], stories: [], answers: [], custom: [],
  updatedAt: 0
};
function normalize(s) {
  s = s && typeof s === 'object' ? s : {};
  return { ...structuredClone(DEFAULTS), ...s,
    profile: { ...DEFAULTS.profile, ...(s.profile || {}) },
    settings: { ...DEFAULTS.settings, ...(s.settings || {}) } };
}
let state = normalize({});
function readLocal(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } }
function save() {
  state.updatedAt = Date.now();
  try { localStorage.setItem(userKey(), JSON.stringify(state)); } catch (e) { console.warn(e); }
  scheduleSync();
}

let syncTimer = null, dirty = false;
function scheduleSync() {
  if (!user || user.must_change) return;
  dirty = true; clearTimeout(syncTimer); syncTimer = setTimeout(pushProgress, 4000);
}
async function pushProgress() {
  if (!user || user.must_change || !dirty) return;
  dirty = false;
  try { await API.call('/progress', { method: 'PUT', body: { data: state } }); }
  catch (e) { dirty = true; if (e.status === 401) { user = null; render(); } }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && dirty && user && !user.must_change) {
    dirty = false;
    fetch('/api/progress', { method: 'PUT', keepalive: true, credentials: 'same-origin',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: state }) }).catch(() => { dirty = true; });
  }
});
window.addEventListener('online', () => { if (dirty) pushProgress(); });

/* After login: take the newer of the device copy and the server copy */
async function loadUserState() {
  const local = readLocal(userKey());
  let server = null, serverAt = 0, fetched = false;
  try { const r = await API.call('/progress'); server = r.data; serverAt = r.updated_at || 0; fetched = true; } catch { }
  let chosen = local && (local.updatedAt || 0) > serverAt ? local : (server || local);
  // first login of a child on a device that was used before accounts existed: adopt that progress
  if (!chosen && !isAdmin()) {
    const legacy = readLocal(LEGACY_KEY);
    if (legacy && (legacy.stars || Object.keys(legacy.days || {}).length)) { chosen = legacy; localStorage.removeItem(LEGACY_KEY); }
  }
  state = normalize(chosen);
  state.profile = { ...state.profile, name: user.display_name, gender: user.gender, avatar: user.avatar };
  applySettings();
  try { localStorage.setItem(userKey(), JSON.stringify(state)); } catch { }
  if (fetched && chosen && chosen !== server) { dirty = true; pushProgress(); }
}
async function afterLogin(u, isNew = false) {
  user = u;
  try { localStorage.setItem('kria.user', JSON.stringify(u)); } catch { }
  if (!u.must_change) await loadUserState();
  location.hash = u.must_change ? '#/password' : (isNew && u.role !== 'admin' ? '#/welcome' : '#/home');
  render();
}
async function logout() {
  if (dirty) await pushProgress();
  try { await API.call('/logout', { method: 'POST' }); } catch { }
  user = null; parentOk = false; state = normalize({});
  try { localStorage.removeItem('kria.user'); } catch { }
  await loadConfig();
  location.hash = '#/login'; render();
}
function day(k = todayKey()) { return state.days[k] || (state.days[k] = { mins: 0, acts: 0, did: {} }); }
function markDid(kind) { const d = day(); d.acts++; d.did[kind] = true; save(); }

/* gendered Hebrew: G('קרא', 'קראי') */
const G = (m, f) => state.profile.gender === 'f' ? f : m;
const disp = s => state.settings.nikud === 'full' ? s : strip(s);

function applySettings() {
  const r = document.documentElement.style;
  r.setProperty('--rs', state.settings.size + 'px');
  const sp = [[0, 0.15], [0.03, 0.25], [0.08, 0.4], [0.14, 0.55]][state.settings.spacing] || [0.03, 0.25];
  r.setProperty('--ls', sp[0] + 'em');
  r.setProperty('--ws', sp[1] + 'em');
}

/* ================= stickers & stars ================= */
const STICKERS = ['🦄', '🐬', '🚀', '🦖', '🌈', '🐙', '⚽', '🎸', '🦁', '🍕', '🐢', '🎨', '🦋', '🏰', '🐼', '🌋', '🛸', '🦜', '🍦', '🐳',
  '🎡', '🦒', '🏆', '🐝', '🌻', '🦉', '🎈', '🐧', '🍉', '🦀', '🌙', '⭐', '🐨', '🧩', '🎪', '🐯', '🦩', '🚂', '🍩', '👑'];
const STARS_PER_STICKER = 10;
function addStars(n) {
  state.stars += n;
  const fresh = [];
  while (state.stickers.length < Math.min(STICKERS.length, Math.floor(state.stars / STARS_PER_STICKER))) {
    const s = STICKERS[state.stickers.length];
    state.stickers.push(s); fresh.push(s);
  }
  save();
  const pill = document.querySelector('[data-stars]');
  if (pill) pill.textContent = `⭐ ${state.stars}`;
  if (fresh.length) setTimeout(() => celebrate(fresh[fresh.length - 1], 'מדבקה חדשה!', G('קיבלת מדבקה לאוסף שלך', 'קיבלת מדבקה לאוסף שלך')), 400);
}

/* ================= UI bits ================= */
let toastTimer;
function toast(msg, ms = 2800) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}
function confetti(n = 24) {
  const set = ['⭐', '🎉', '✨', '🌟', '💜', '🎈'];
  for (let i = 0; i < n; i++) {
    const c = h('div', { class: 'confetti', style: `left:${Math.random() * 100}vw;animation-duration:${1.6 + Math.random() * 1.6}s;animation-delay:${Math.random() * .5}s` }, pick(set));
    document.body.append(c); setTimeout(() => c.remove(), 4000);
  }
}
function celebrate(big, title, sub, onClose) {
  confetti();
  const ov = h('div', { class: 'overlay', onclick: () => { ov.remove(); onClose && onClose(); } },
    h('div', { class: 'pop stack' },
      h('div', { class: 'big' }, big), h('h2', {}, title), sub ? h('p', {}, sub) : null,
      h('button', { class: 'btn-big btn-full' }, 'יש! 🙌')));
  document.body.append(ov);
}
const PRAISE = ['כל הכבוד!', 'מעולה!', 'יופי!', 'איזה כיף!', 'וואו!', 'מצוין!'];
const praise = () => pick(PRAISE);

function sayBtn(text, cls = 'icon-btn btn-ghost') {
  return h('button', { class: cls, 'aria-label': 'השמעה', title: 'השמעה', onclick: e => { e.stopPropagation(); say(text); } }, '🔊');
}
function mascot(text) {
  return h('div', { class: 'mascot' }, h('div', { class: 'owl', 'aria-hidden': 'true' }, '🦉'),
    h('div', { class: 'bubble' }, h('div', { class: 'grow' }, text), sayBtn(text, 'icon-btn btn-ghost say')));
}
function topbar(title, back = '#/home') {
  return h('div', { class: 'topbar' },
    h('button', { class: 'icon-btn btn-ghost', 'aria-label': 'חזרה', onclick: () => { location.hash = back; } }, '→'),
    h('div', { class: 'title' }, title),
    h('span', { class: 'pill', 'data-stars': '' }, `⭐ ${state.stars}`));
}
function seg(options, value, onChange) {
  const wrap = h('div', { class: 'seg' });
  for (const [v, label] of options) {
    wrap.append(h('button', { class: v === value ? 'cur' : '', onclick: () => {
      wrap.querySelectorAll('button').forEach(b => b.classList.remove('cur'));
      wrap.children[options.findIndex(o => o[0] === v)].classList.add('cur');
      onChange(v);
    } }, label));
  }
  return wrap;
}

/* ================= audio: TTS, playback, recording ================= */
const TTS = {
  voices: [], voice: null,
  init() {
    if (!('speechSynthesis' in window)) return;
    const pickVoice = () => {
      this.voices = speechSynthesis.getVoices().filter(v => /^(he|iw)\b/i.test(v.lang));
      this.voice = this.voices.find(v => v.name === state.settings.voice) || this.voices.find(v => v.localService) || this.voices[0] || null;
    };
    pickVoice();
    speechSynthesis.addEventListener?.('voiceschanged', pickVoice);
  },
  speak(text, { onword, rate } = {}) {
    return new Promise(res => {
      if (!this.voice) { res(false); return; }
      const spoken = state.settings.ttsNikud ? text : strip(text);
      const u = new SpeechSynthesisUtterance(spoken);
      u.voice = this.voice; u.lang = this.voice.lang; u.rate = rate || state.settings.rate;
      if (onword) {
        const starts = []; let pos = 0;
        for (const w of spoken.split(' ')) { starts.push(pos); pos += w.length + 1; }
        u.onboundary = e => {
          if (e.name && e.name !== 'word') return;
          let i = 0; while (i + 1 < starts.length && starts[i + 1] <= e.charIndex) i++;
          onword(i);
        };
      }
      let done = false; const fin = ok => { if (!done) { done = true; res(ok); } };
      u.onend = () => fin(true); u.onerror = () => fin(false);
      // Safety net: some engines never fire onend
      setTimeout(() => fin(true), 2500 + spoken.length * 160 / (u.rate || 1));
      speechSynthesis.speak(u);
    });
  }
};
let curAudio = null, playToken = 0, warnedNoVoice = false;
function stopAll() {
  playToken++;
  try { speechSynthesis.cancel(); } catch { }
  if (curAudio) { curAudio.pause(); curAudio = null; }
  document.querySelectorAll('.speaking').forEach(e => e.classList.remove('speaking'));
  document.querySelectorAll('.wspeak').forEach(e => e.classList.remove('wspeak'));
}
function playBlob(blob) {
  return new Promise(res => {
    const a = new Audio(URL.createObjectURL(blob));
    curAudio = a;
    a.onended = () => res(true); a.onerror = () => res(false); a.onpause = () => res(false);
    a.play().catch(() => res(false));
  });
}
function noVoiceWarning() {
  if (warnedNoVoice) return; warnedNoVoice = true;
  toast('במכשיר הזה אין קול בעברית. הורה יכול להקליט קריאה באזור ההורים 🎙️', 5000);
}
async function say(text) {
  stopAll();
  if (!TTS.voice) { noVoiceWarning(); return false; }
  return TTS.speak(text);
}

const Rec = {
  mr: null, chunks: [], stream: null, t0: 0,
  supported() { return !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder); },
  async start() {
    stopAll();
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/aac'];
    const t = types.find(t => MediaRecorder.isTypeSupported?.(t));
    this.mr = new MediaRecorder(this.stream, t ? { mimeType: t } : undefined);
    this.chunks = [];
    this.mr.ondataavailable = e => e.data.size && this.chunks.push(e.data);
    this.t0 = Date.now();
    this.mr.start();
  },
  stop() {
    return new Promise(res => {
      if (!this.mr || this.mr.state === 'inactive') { res(null); return; }
      const mr = this.mr;
      mr.onstop = () => {
        const blob = new Blob(this.chunks, { type: mr.mimeType || 'audio/mp4' });
        this.stream.getTracks().forEach(t => t.stop());
        this.mr = null;
        res({ blob, secs: Math.round((Date.now() - this.t0) / 1000) });
      };
      mr.stop();
    });
  },
  cancel() { if (this.mr) { this.mr.onstop = null; try { this.mr.stop(); } catch { } this.stream?.getTracks().forEach(t => t.stop()); this.mr = null; } }
};

const DB = {
  db: null,
  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((res, rej) => {
      const r = indexedDB.open('kria', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('rec', { keyPath: 'id', autoIncrement: true });
      r.onsuccess = () => { this.db = r.result; res(this.db); };
      r.onerror = () => rej(r.error);
    });
  },
  async run(mode, fn) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const t = db.transaction('rec', mode);
      const req = fn(t.objectStore('rec'));
      t.oncomplete = () => res(req && req.result);
      t.onerror = () => rej(t.error);
    });
  },
  add: rec => DB.run('readwrite', s => s.add(rec)),
  all: () => DB.run('readonly', s => s.getAll()),
  del: id => DB.run('readwrite', s => s.delete(id))
};
let models = {}; // `${textId}:${i}` -> record (parent's model reading of a sentence)
async function loadModels() {
  try {
    const all = await DB.all();
    models = {};
    for (const r of all) if (r.kind === 'model') models[`${r.textId}:${r.sent}`] = r;
  } catch (e) { console.warn('IndexedDB unavailable', e); }
}

/* ================= texts ================= */
function allTexts() { return [...C.texts, ...state.custom]; }
function getText(id) { return allTexts().find(t => t.id === id); }
function flat(text) { return text.paragraphs.flat(); }
function readsOf(id) { return state.reads[id] || []; }
function recommendedText() {
  const ts = allTexts();
  if (!ts.length) return null;
  const once = ts.find(t => readsOf(t.id).length === 1);       // repeated reading first
  if (once) return once;
  const fresh = ts.filter(t => !readsOf(t.id).length).sort((a, b) => a.level - b.level)[0];
  if (fresh) return fresh;
  return ts.slice().sort((a, b) => readsOf(a.id).length - readsOf(b.id).length)[0];
}
const LEVEL = { 1: '🌱 קל', 2: '🌿 בינוני', 3: '🌳 מאתגר' };

/* Render a text into a reader element. Each sentence: span.s[data-i]; each word: span.w */
function renderReader(text, { onWord } = {}) {
  const mode = state.settings.nikud;
  const box = h('div', { class: 'reader', dir: 'rtl' });
  let i = 0;
  for (const para of text.paragraphs) {
    const p = h('p');
    for (const s of para) {
      const sEl = h('span', { class: 's', 'data-i': i });
      wordsOf(s).forEach((w, wi) => {
        const wEl = h('span', { class: 'w', 'data-wi': wi }, mode === 'full' ? w : strip(w));
        wEl.addEventListener('click', () => {
          if (mode === 'tap') { wEl.textContent = w; wEl.classList.add('nik'); }
          onWord ? onWord(w, wEl) : say(w);
        });
        sEl.append(wEl, ' ');
      });
      p.append(sEl, ' ');
      i++;
    }
    box.append(p);
  }
  return box;
}
function sentEl(reader, i) { return reader.querySelector(`.s[data-i="${i}"]`); }

/* Read sentence i aloud: parent's recording if exists, else TTS with word highlighting */
async function readSentence(text, i, reader) {
  const s = flat(text)[i];
  const el = reader && sentEl(reader, i);
  el?.classList.add('speaking');
  el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  let ok;
  const m = models[`${text.id}:${i}`];
  if (m) ok = await playBlob(m.blob);
  else if (TTS.voice) {
    const ws = el ? [...el.querySelectorAll('.w')] : [];
    ok = await TTS.speak(s, { onword: wi => { ws.forEach(w => w.classList.remove('wspeak')); ws[wi]?.classList.add('wspeak'); } });
    ws.forEach(w => w.classList.remove('wspeak'));
  } else { noVoiceWarning(); ok = false; }
  el?.classList.remove('speaking');
  return ok;
}

/* ================= router ================= */
let current = '';
const routes = {};
function render() {
  stopAll(); Rec.cancel();
  let [, name = 'home', ...args] = (location.hash || '#/home').split('/');
  // not logged in: only login / register; must change password: only that screen
  if (!user && name !== 'login' && name !== 'register') name = 'login';
  else if (user?.must_change) name = 'password';
  else if (user && (name === 'login' || name === 'register' || name === 'onboard')) name = 'home';
  current = name;
  document.body.classList.toggle('auth-screen', name === 'login' || name === 'register');
  app.replaceChildren();
  const fn = routes[name] || routes.home;
  const el = fn(...args.map(decodeURIComponent));
  if (el) app.append(el);
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', render);

/* time on task: counts while the app is visible on a practice screen */
setInterval(() => {
  if (document.visibilityState === 'visible' && ['read', 'game', 'story', 'write', 'library', 'games'].includes(current)) {
    day().mins = Math.round((day().mins + 0.25) * 100) / 100; save();
  }
}, 15000);

/* ================= login / register / password ================= */
const AVATARS = ['🦊', '🐱', '🐶', '🐼', '🦁', '🐸', '🐵', '🦄', '🐯', '🐰', '🐨', '🐧'];
function avatarPicker(cur, onPick) {
  const avs = h('div', { class: 'chips' }, AVATARS.map(a => h('button', { type: 'button', class: 'chip' + (a === cur ? ' sel' : ''), style: 'font-size:32px', onclick: e => {
    avs.querySelectorAll('.chip').forEach(c => c.classList.remove('sel')); e.currentTarget.classList.add('sel'); onPick(a);
  } }, a)));
  return avs;
}
function pwField(placeholder, autocomplete) {
  const inp = h('input', { type: 'password', placeholder, autocomplete, dir: 'ltr', style: 'text-align:right' });
  const eye = h('button', { type: 'button', class: 'icon-btn btn-ghost', 'aria-label': 'הצגת סיסמה', onclick: () => {
    inp.type = inp.type === 'password' ? 'text' : 'password'; eye.textContent = inp.type === 'password' ? '👁️' : '🙈';
  } }, '👁️');
  return { inp, el: h('div', { class: 'row', style: 'flex-wrap:nowrap' }, inp, eye) };
}
function errBox() { return h('div', { class: 'tip hidden', role: 'alert' }); }
function showErr(box, msg) { box.textContent = '⚠️ ' + msg; box.classList.remove('hidden'); }
function busy(btn, on, label) { btn.disabled = on; if (label) btn.textContent = label; }

/* Landing page with login / register tabs — same structure as LinguaDov */
let siteConfig = { registration: false, approval: false };
async function loadConfig() { try { siteConfig = await API.call('/config'); } catch { } }
const HELLOS = ['שָׁלוֹם!', 'קוֹרְאִים?', 'כׇּל הַכָּבוֹד!', 'בּוֹאוּ נִקְרָא', 'יוֹפִי!', 'מְעוּלֶּה!'];
let helloTimer = null, deferredInstall = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredInstall = e; });
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
async function installApp() {
  if (deferredInstall) { deferredInstall.prompt(); try { await deferredInstall.userChoice; } catch { } deferredInstall = null; return; }
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const safari = ios && !/CriOS|FxiOS|EdgiOS/.test(navigator.userAgent);
  const steps = ios
    ? [safari ? null : 'באייפון ההתקנה עובדת רק מ־Safari. פתחו את הכתובת ב־Safari.', 'לחצו על כפתור השיתוף ⬆️ בתחתית Safari', 'בחרו "הוספה למסך הבית" ➕', 'לחצו "הוסף" — וינשופי 🦉 יופיע במסך הבית']
    : ['פתחו את תפריט הדפדפן ⋮', 'בחרו "התקנת אפליקציה" או "הוספה למסך הבית"', 'אשרו — וינשופי 🦉 יופיע במסך הבית'];
  const ov = h('div', { class: 'overlay', onclick: e => { if (e.target === ov) ov.remove(); } },
    h('div', { class: 'pop stack', style: 'text-align:right' }, h('h2', {}, '📲 התקנת קוראים בכיף'),
      h('ol', { style: 'margin:0;padding-inline-start:22px;line-height:1.9' }, steps.filter(Boolean).map(s => h('li', {}, s))),
      h('button', { class: 'btn-full', onclick: () => ov.remove() }, 'הבנתי')));
  document.body.append(ov);
}

function authScreen(mode) {
  document.body.classList.add('auth-screen');
  clearInterval(helloTimer);
  const canReg = siteConfig.registration;
  if (!canReg) mode = 'login';
  const formBox = h('section', { class: 'land-form card' });

  const draw = m => {
    mode = m;
    history.replaceState(null, '', m === 'register' ? '#/register' : '#/login');
    const tabs = canReg
      ? h('div', { class: 'auth-tabs' },
        h('button', { type: 'button', class: m === 'login' ? 'on' : '', onclick: () => draw('login') }, 'כניסה'),
        h('button', { type: 'button', class: m === 'register' ? 'on' : '', onclick: () => draw('register') }, 'הרשמה'))
      : h('h2', {}, 'כניסה');
    formBox.replaceChildren(tabs, ...(m === 'register' ? registerForm() : loginForm()).filter(Boolean));
    formBox.querySelector('input')?.focus();
  };

  const loginForm = () => {
    const u = h('input', { type: 'text', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', dir: 'ltr', required: true });
    const pw = pwField('', 'current-password');
    const remember = h('input', { type: 'checkbox', checked: true, style: 'width:22px;height:22px' });
    const err = h('div', { class: 'form-error', role: 'alert' });
    const btn = h('button', { class: 'btn-big btn-full', type: 'submit' }, 'כניסה');
    const form = h('form', { class: 'stack', onsubmit: async e => {
      e.preventDefault();
      busy(btn, true, 'מתחברים...');
      try { await afterLogin(await API.call('/login', { method: 'POST', body: { username: u.value.trim(), password: pw.inp.value, remember: remember.checked } })); }
      catch (ex) { err.textContent = ex.message; busy(btn, false, 'כניסה'); pw.inp.value = ''; pw.inp.focus(); }
    } },
      h('label', { class: 'field' }, 'שם משתמש', u),
      h('label', { class: 'field' }, 'סיסמה', pw.el),
      h('label', { class: 'row remember' }, remember, 'להישאר מחובר במכשיר הזה'),
      err, btn);
    return [form, h('p', { class: 'muted center' }, canReg
      ? ['אין לכם משתמש? ', h('button', { type: 'button', class: 'link-btn', onclick: () => draw('register') }, 'הירשמו עכשיו – זה בחינם')]
      : 'אין לכם משתמש? בקשו מהמנהל לפתוח לכם אחד.')];
  };

  const registerForm = () => {
    const name = h('input', { type: 'text', autocomplete: 'name', maxlength: 30, required: true, placeholder: 'למשל: נועם' });
    const u = h('input', { type: 'text', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', dir: 'ltr', required: true,
      pattern: '[a-zA-Z0-9_.\\-]{3,30}', title: '3–30 תווים: אותיות באנגלית, ספרות, נקודה, מקף או קו תחתון', placeholder: 'noam' });
    const pw = pwField('', 'new-password');
    const pw2 = pwField('', 'new-password');
    [pw.inp, pw2.inp].forEach(i => { i.minLength = 6; i.required = true; });
    const err = h('div', { class: 'form-error', role: 'alert' });
    const btn = h('button', { class: 'btn-big btn-full', type: 'submit' }, 'יצירת משתמש');
    const form = h('form', { class: 'stack', onsubmit: async e => {
      e.preventDefault();
      if (pw.inp.value !== pw2.inp.value) { err.textContent = 'הסיסמאות לא זהות'; return; }
      busy(btn, true, 'יוצרים משתמש...');
      try {
        const r = await API.call('/register', { method: 'POST', body: { display_name: name.value.trim(), username: u.value.trim(), password: pw.inp.value } });
        if (r.pending) { clearInterval(helloTimer); formBox.replaceChildren(pendingBox(name.value.trim(), () => draw('login'))); return; }
        await afterLogin(r, true);
        toast(`🎉 ברוכים הבאים, ${r.display_name}!`);
      } catch (ex) { err.textContent = ex.message; busy(btn, false, 'יצירת משתמש'); }
    } },
      h('label', { class: 'field' }, 'השם שלכם', name),
      h('label', { class: 'field' }, 'שם משתמש (באנגלית)', u),
      h('label', { class: 'field' }, 'סיסמה (לפחות 6 תווים)', pw.el),
      h('label', { class: 'field' }, 'אימות סיסמה', pw2.el),
      err, btn);
    return [h('p', { class: 'muted', style: 'margin-top:0' }, 'פותחים משתמש ומתחילים לקרוא – בחינם. 🦉'), form,
      siteConfig.approval ? h('p', { class: 'muted center' }, 'לאחר ההרשמה המנהל יאשר את המשתמש שלכם.') : null,
      h('p', { class: 'muted center' }, 'כבר יש לכם משתמש? ', h('button', { type: 'button', class: 'link-btn', onclick: () => draw('login') }, 'כניסה'))];
  };

  const hello = h('span', {}, HELLOS[0]);
  let hi = 0;
  helloTimer = setInterval(() => {
    if (!hello.isConnected) { clearInterval(helloTimer); return; }
    hi = (hi + 1) % HELLOS.length;
    hello.classList.remove('hpop'); void hello.offsetWidth; hello.textContent = HELLOS[hi]; hello.classList.add('hpop');
  }, 1800);

  const page = h('div', { class: 'landing' },
    h('div', { class: 'land-bg', 'aria-hidden': 'true' }, ['📖', '✏️', '🔤', '⭐', '🌈', '🎈', '📚'].map((e, i) => h('span', { class: `fl fl${i}` }, e)),
      h('span', { class: 'blob b1' }), h('span', { class: 'blob b2' })),
    h('div', { class: 'land-grid' },
      h('section', { class: 'land-hero' },
        h('div', { class: 'land-logo' }, h('span', { class: 'land-owl' }, '🦉'), h('span', {}, 'קוראים ', h('b', {}, 'בכיף'))),
        h('div', {}, h('div', { class: 'hello-bubble', 'aria-hidden': 'true' }, hello)),
        h('h1', { class: 'land-title' }, 'קוראים בלי פחד', h('br'), h('span', { class: 'hl' }, '10 דקות ביום')),
        h('p', { class: 'land-sub' }, 'תרגול קריאה וכתיבה בעברית לילדים בכיתות ג–ו. ינשופי מקריא, קוראים כמו הד, משחקי מילים וכותבים סיפורים — בלי שעון ובלי לחץ. בחינם.'),
        h('div', { class: 'land-chips' }, ['👂 מקשיבים', '🔁 קוראים כמו הד', '🔍 מבינים', '✏️ כותבים', '🎮 משחקי מילים'].map(c => h('span', { class: 'land-chip' }, c))),
        h('div', { class: 'land-stats' },
          h('div', {}, h('b', {}, C.texts.length), h('span', {}, 'טקסטים')),
          h('div', {}, h('b', {}, GAMES.length), h('span', {}, 'משחקים')),
          h('div', {}, h('b', {}, '🎤'), h('span', {}, 'הקלטה עצמית')),
          h('div', {}, h('b', {}, '₪0'), h('span', {}, 'בחינם')))),
      formBox,
      h('section', { class: 'land-features' },
        [['🗺️', 'צעד אחרי צעד', 'מקשיבים, קוראים כמו הד, ואז קוראים לבד'],
         ['🦉', 'ינשופי מקריא', 'כל מילה קשה — נגיעה ושומעים אותה'],
         ['⭐', 'כוכבים ומדבקות', 'על כל מאמץ, בלי שעון ובלי לחץ'],
         ['📱', 'אפליקציה בטלפון', 'מתקינים למסך הבית בלחיצה']]
          .map(([e, t, s]) => h('div', { class: 'feat' }, h('span', {}, e), h('b', {}, t), h('small', {}, s))))),
    isStandalone() ? null : h('button', { class: 'land-install', onclick: installApp }, '📲 התקינו את קוראים בכיף כאפליקציה'));
  draw(mode);
  return page;
}
function pendingBox(name, back) {
  return h('div', { class: 'center stack' }, h('div', { style: 'font-size:3rem' }, '⏳'), h('h2', {}, `תודה ${name}!`),
    h('p', {}, 'המשתמש נוצר ומחכה לאישור המנהל. אחרי האישור אפשר להיכנס עם שם המשתמש והסיסמה שבחרתם.'),
    h('button', { class: 'btn-full', onclick: back }, 'חזרה לכניסה'));
}
routes.login = () => authScreen('login');
routes.register = () => authScreen('register');

/* First time after registering: pick how to be addressed and a character */
routes.welcome = () => {
  const p = { gender: state.profile.gender || 'm', avatar: state.profile.avatar || '🦊' };
  const err = errBox();
  const btn = h('button', { class: 'btn-big btn-full', onclick: async () => {
    busy(btn, true);
    try {
      user = await API.call('/profile', { method: 'PUT', body: { display_name: user.display_name, gender: p.gender, avatar: p.avatar } });
      localStorage.setItem('kria.user', JSON.stringify(user));
      Object.assign(state.profile, { gender: p.gender, avatar: p.avatar, setup: true }); save();
      location.hash = '#/home';
    } catch (e) { showErr(err, e.message); busy(btn, false); }
  } }, 'יאללה, מתחילים! 🚀');
  return h('div', { class: 'stack' },
    h('div', { class: 'center', style: 'font-size:72px;line-height:1' }, '🦉'),
    h('h1', { class: 'center' }, `שלום ${user.display_name}! 👋`),
    mascot('אני ינשופי. נקרא ונכתוב ביחד — לאט, בכיף, ובלי לחץ. רק עוד שתי שאלות קטנות:'),
    h('div', { class: 'card stack' },
      h('div', { class: 'field' }, h('label', {}, 'איך לפנות אליך?'), seg([['m', '👦 בן'], ['f', '👧 בת']], p.gender, v => { p.gender = v; })),
      h('div', { class: 'field' }, h('label', {}, 'בחר/י דמות'), avatarPicker(p.avatar, a => { p.avatar = a; }))),
    err, btn);
};


routes.password = () => {
  const forced = !!user?.must_change;
  const cur = pwField('הסיסמה הנוכחית', 'current-password');
  const nw = pwField('סיסמה חדשה', 'new-password');
  const nw2 = pwField('שוב את הסיסמה החדשה', 'new-password');
  const err = errBox();
  const btn = h('button', { class: 'btn-big btn-full', type: 'submit' }, 'שמירה ✓');
  const form = h('form', { class: 'card stack', onsubmit: async e => {
    e.preventDefault();
    if (nw.inp.value !== nw2.inp.value) { showErr(err, 'שתי הסיסמאות החדשות לא זהות'); return; }
    busy(btn, true);
    try {
      await API.call('/password', { method: 'POST', body: { current: cur.inp.value, next: nw.inp.value } });
      toast('הסיסמה הוחלפה ✓');
      await afterLogin({ ...user, must_change: false });
    } catch (ex) { showErr(err, ex.message); busy(btn, false); }
  } },
    h('div', { class: 'field' }, h('label', {}, 'סיסמה נוכחית'), cur.el),
    h('div', { class: 'field' }, h('label', {}, 'סיסמה חדשה'), nw.el),
    h('div', { class: 'field' }, h('label', {}, 'אימות'), nw2.el),
    err, btn);
  return h('div', { class: 'stack' },
    forced ? h('h1', {}, '🔐 החלפת סיסמה') : topbar('🔐 החלפת סיסמה', '#/parent/prefs'),
    forced ? h('div', { class: 'tip' }, 'זו הכניסה הראשונה עם הסיסמה הזמנית. כדי לשמור על האתר, בחרו עכשיו סיסמה חדשה (לא admin).') : null,
    form,
    forced ? h('button', { class: 'btn-ghost btn-small', onclick: logout }, 'יציאה') : null);
};

/* ================= home ================= */
const GAMES = [
  { id: 'letters', emo: '🔤', name: 'אותיות חברות', sub: 'ט או ת? כ או ח?' },
  { id: 'roots', emo: '🌳', name: 'עץ השורשים', sub: 'מילים מאותה משפחה' },
  { id: 'build', emo: '🧱', name: 'בונים משפט', sub: 'מסדרים מילים' },
  { id: 'combine', emo: '🔗', name: 'מחברים משפטים', sub: 'כי, אבל, ולכן' },
  { id: 'spell', emo: '👀', name: 'מסתכלים וכותבים', sub: 'המילון שלי' }
];
function weekDates() {
  const d = new Date(); d.setDate(d.getDate() - d.getDay()); // Sunday
  return Array.from({ length: 7 }, (_, i) => { const x = new Date(d); x.setDate(d.getDate() + i); return x; });
}
routes.home = () => {
  const t = recommendedText();
  const gameOfDay = GAMES[Math.floor(Date.now() / 864e5) % 4];
  const d = state.days[todayKey()] || { did: {} };
  const wk = weekDates();
  const practiced = wk.filter(x => (state.days[todayKey(x)]?.acts || 0) > 0).length;
  const DN = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'];
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'בוקר טוב' : hour < 18 ? 'צהריים טובים' : 'ערב טוב';
  const reread = t && readsOf(t.id).length === 1;

  const mission = (emo, title, sub, done, href) =>
    h('div', { class: 'mission' + (done ? ' done' : ''), onclick: () => { location.hash = href; } },
      h('div', { class: 'emo' }, emo), h('div', { class: 'grow' }, h('b', {}, title), h('div', { class: 'muted' }, sub)),
      h('div', { class: 'check' }, done ? '✅' : '◀'));

  return h('div', { class: 'stack' },
    h('div', { class: 'row between' },
      h('div', { class: 'hello' }, h('div', { class: 'avatar' }, state.profile.avatar),
        h('div', {}, h('h1', { style: 'margin:0' }, `${greet}, ${state.profile.name}!`))),
      h('span', { class: 'pill', 'data-stars': '' }, `⭐ ${state.stars}`)),
    mascot(practiced >= state.weeklyGoal
      ? G(`הגעת למטרה של השבוע! אתה אלוף 🏆`, `הגעת למטרה של השבוע! את אלופה 🏆`)
      : G('עשר דקות ביום עושות קסמים. מוכן?', 'עשר דקות ביום עושות קסמים. מוכנה?')),
    h('div', { class: 'card' },
      h('h2', {}, '🎯 המשימות של היום'),
      t ? mission('📖', reread ? `קוראים שוב: ${strip(t.title)}` : `קוראים: ${strip(t.title)}`,
        reread ? 'בפעם השנייה זה הרבה יותר קל!' : 'מקשיבים, קוראים ומבינים', d.did.read, `#/read/${t.id}`) : null,
      mission(gameOfDay.emo, `משחק: ${gameOfDay.name}`, gameOfDay.sub, d.did.game, `#/game/${gameOfDay.id}`),
      mission('✏️', 'כותבים סיפור קטן', 'בונים סיפור צעד אחרי צעד (בונוס)', d.did.write, '#/write')),
    h('div', { class: 'card' },
      h('div', { class: 'row between' }, h('h3', { style: 'margin:0' }, '☀️ השבוע שלי'),
        h('span', { class: 'muted' }, `${practiced} מתוך ${state.weeklyGoal} ימים`)),
      h('div', { class: 'week', style: 'margin-top:10px' }, wk.map((x, i) => {
        const on = (state.days[todayKey(x)]?.acts || 0) > 0;
        return h('div', { class: 'day' + (on ? ' on' : '') + (todayKey(x) === todayKey() ? ' today' : '') },
          h('div', { class: 'dot' }, on ? '☀️' : ''), DN[i]);
      }))),
    h('div', { class: 'grid' },
      h('div', { class: 'tile', onclick: () => location.hash = '#/library' }, h('div', { class: 'emo' }, '📚'), 'ספרייה', h('div', { class: 'sub' }, G('בחר טקסט', 'בחרי טקסט'))),
      h('div', { class: 'tile', onclick: () => location.hash = '#/games' }, h('div', { class: 'emo' }, '🎮'), 'משחקי מילים', h('div', { class: 'sub' }, 'כתיב ומשפטים')),
      h('div', { class: 'tile', onclick: () => location.hash = '#/write' }, h('div', { class: 'emo' }, '✏️'), 'כותבים', h('div', { class: 'sub' }, 'הסיפורים שלי')),
      h('div', { class: 'tile', onclick: () => location.hash = '#/stickers' }, h('div', { class: 'emo' }, '🏆'), 'המדבקות שלי', h('div', { class: 'sub' }, `${state.stickers.length} מדבקות`))),
    h('div', { class: 'row between', style: 'margin-top:20px' },
      h('button', { class: 'btn-ghost btn-small', onclick: () => location.hash = '#/settings' }, 'Aa תצוגה'),
      isAdmin() ? h('button', { class: 'btn-small', onclick: () => location.hash = '#/admin' }, '🛡️ ניהול') : null,
      isAdmin() ? h('button', { class: 'btn-small share-main', onclick: shareApp }, '📤 שיתוף') : null,
      h('button', { class: 'btn-ghost btn-small', onclick: () => location.hash = '#/parent' }, '👨‍👩‍👧 אזור הורים'),
      h('button', { class: 'btn-ghost btn-small', onclick: logout }, `🚪 יציאה (${user?.username || ''})`)));
};

/* ================= quick display settings (child) ================= */
routes.settings = () => {
  const sample = { id: '_sample', paragraphs: [['הַיֶּלֶד קָרָא סִיפּוּר עַל דּוֹלְפִין חָכָם.']] };
  const holder = h('div');
  const refresh = () => { applySettings(); holder.replaceChildren(renderReader(sample)); save(); };
  refresh();
  return h('div', { class: 'stack' }, topbar('Aa איך נוח לי לקרוא?'),
    holder,
    h('div', { class: 'card stack' },
      h('div', {}, h('label', {}, 'גודל אותיות'), seg([[22, 'א'], [26, 'א+'], [32, 'א++'], [38, 'א+++']], state.settings.size, v => { state.settings.size = v; refresh(); })),
      h('div', {}, h('label', {}, 'רווחים בין אותיות'), seg([[0, 'צפוף'], [1, 'רגיל'], [2, 'רחב'], [3, 'רחב מאוד']], state.settings.spacing, v => { state.settings.spacing = v; refresh(); })),
      h('div', {}, h('label', {}, 'ניקוד'), seg([['full', 'עם ניקוד'], ['tap', 'ניקוד בנגיעה'], ['none', 'בלי ניקוד']], state.settings.nikud, v => { state.settings.nikud = v; refresh(); })),
      h('p', { class: 'muted' }, '"ניקוד בנגיעה" — הטקסט בלי ניקוד, ונגיעה במילה מראה את הניקוד שלה ומקריאה אותה.')));
};

/* ================= library ================= */
routes.library = () => {
  const ts = allTexts();
  return h('div', { class: 'stack' }, topbar('📚 ספרייה'),
    mascot(G('בחר טקסט שמעניין אותך. אפשר לקרוא את אותו טקסט כמה פעמים — כל פעם זה נהיה קל יותר!',
      'בחרי טקסט שמעניין אותך. אפשר לקרוא את אותו טקסט כמה פעמים — כל פעם זה נהיה קל יותר!')),
    [1, 2, 3].map(lv => {
      const list = ts.filter(t => (t.level || 1) === lv);
      if (!list.length) return null;
      return h('div', { class: 'stack' }, h('h3', {}, LEVEL[lv]),
        h('div', { class: 'grid' }, list.map(t => {
          const n = readsOf(t.id).length;
          return h('div', { class: 'tile' + (n ? ' done' : ''), onclick: () => location.hash = `#/read/${t.id}` },
            h('div', { class: 'emo' }, t.emoji || '📄'), h('div', { style: 'font-family:var(--read)' }, disp(t.title)),
            h('div', { class: 'sub' }, n ? `קראתי ${n} ${n === 1 ? 'פעם' : 'פעמים'} ✓` : (t.genre === 'info' ? 'מידע' : 'סיפור')));
        })));
    }));
};

/* ================= reading flow ================= */
const STEPS = [
  { key: 'prep', emo: '🔑', name: 'מילים חשובות' },
  { key: 'listen', emo: '👂', name: 'מקשיבים' },
  { key: 'echo', emo: '🔁', name: 'קוראים כמו הד' },
  { key: 'solo', emo: '🎤', name: 'קוראים לבד' },
  { key: 'quiz', emo: '🔍', name: 'מבינים' },
  { key: 'write', emo: '✏️', name: 'כותבים' }
];
routes.read = id => {
  const text = getText(id);
  if (!text) { location.hash = '#/library'; return null; }
  const sents = flat(text);
  const S = { step: 0, done: new Set(), earned: 0, helps: 0 };
  const root = h('div', { class: 'stack' });
  const body = h('div', { class: 'stack' });
  const stepper = h('div', { class: 'stepper' });
  root.append(topbar(`${text.emoji || '📄'} ${strip(text.title)}`, '#/library'), stepper, body);

  const award = (key, n) => { if (!S.done.has(key)) { S.done.add(key); S.earned += n; addStars(n); } };
  const go = i => { stopAll(); Rec.cancel(); S.step = i; draw(); window.scrollTo(0, 0); };
  const next = () => go(S.step + 1);
  const nextBtn = (label = 'ממשיכים ◀', extra) => h('button', { class: 'btn-big btn-full ' + (extra || ''), onclick: next }, label);

  function draw() {
    stepper.replaceChildren(...STEPS.map((s, i) => h('button', {
      class: (i === S.step ? 'cur ' : '') + (S.done.has(s.key) ? 'ok' : ''), title: s.name, 'aria-label': s.name, onclick: () => go(i)
    }, s.emo)));
    body.replaceChildren();
    if (S.step >= STEPS.length) return body.append(finish());
    body.append(h('div', { class: 'step-name' }, `${STEPS[S.step].emo} ${STEPS[S.step].name}`));
    body.append(({ prep, listen, echo, solo, quiz, write })[STEPS[S.step].key]());
  }

  /* 1. pre-teach hard words */
  function prep() {
    const hw = text.hardWords || [];
    if (!hw.length) { award('prep', 1); return h('div', { class: 'stack' }, mascot('בטקסט הזה אין מילים קשות במיוחד. ממשיכים!'), nextBtn()); }
    return h('div', { class: 'stack' },
      h('div', { class: 'reading-title' }, text.emoji || '', ' ', disp(text.title)),
      mascot(G('לפני שקוראים, בוא נכיר כמה מילים מהטקסט. לחץ על 🔊 כדי לשמוע.', 'לפני שקוראים, בואי נכיר כמה מילים מהטקסט. לחצי על 🔊 כדי לשמוע.')),
      hw.map(w => h('div', { class: 'card hardword' }, sayBtn(w.word, 'icon-btn btn-blue'),
        h('div', { class: 'grow' }, h('div', { class: 'hw' }, disp(w.word)), w.hint ? h('div', { class: 'hint' }, disp(w.hint)) : null))),
      h('button', { class: 'btn-big btn-full', onclick: () => { award('prep', 1); next(); } }, 'הכרתי! ממשיכים ◀'));
  }

  /* 2. listen & follow (shadow reading) */
  function listen() {
    const reader = renderReader(text);
    let playing = false;
    const play = h('button', { class: 'btn-big btn-blue grow', onclick: async () => {
      if (playing) { stopAll(); return; }
      playing = true; play.textContent = '⏸ עצירה';
      const tok = ++playToken;
      for (let i = 0; i < sents.length; i++) {
        if (tok !== playToken) break;
        await readSentence(text, i, reader);
        await wait(250);
      }
      playing = false; play.textContent = '▶ שוב';
      if (tok === playToken) award('listen', 1);
    } }, '▶ ינשופי מקריא');
    return h('div', { class: 'stack' },
      mascot(G('ינשופי קורא ראשון. עקוב עם האצבע אחרי המילה הצהובה.', 'ינשופי קורא ראשון. עקבי עם האצבע אחרי המילה הצהובה.')),
      h('div', { class: 'reading-title' }, disp(text.title)), reader,
      h('div', { class: 'row' }, play),
      h('button', { class: 'btn-ghost btn-full', onclick: () => { award('listen', 1); next(); } }, 'הקשבתי ◀'));
  }

  /* 3. echo reading: model reads one sentence, child repeats it */
  function echo() {
    let i = 0;
    const reader = renderReader(text);
    reader.classList.add('focus');
    const counter = h('div', { class: 'muted center' });
    const bubble = h('div');
    const listenBtn = h('button', { class: 'btn-big btn-blue grow', onclick: () => modelRead() }, '🔊 ינשופי קורא');
    const meBtn = h('button', { class: 'btn-big btn-green grow', onclick: () => nextSentence() }, G('קראתי! ◀', 'קראתי! ◀'));
    const setCur = () => {
      reader.querySelectorAll('.s').forEach(e => e.classList.remove('cur'));
      sentEl(reader, i)?.classList.add('cur');
      sentEl(reader, i)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      counter.textContent = `משפט ${i + 1} מתוך ${sents.length}`;
      bubble.replaceChildren(mascot(G('קודם תקשיב, ואחר כך תקרא בקול את אותו משפט — כמו הד.', 'קודם תקשיבי, ואחר כך תקראי בקול את אותו משפט — כמו הד.')));
    };
    async function modelRead() { stopAll(); playToken++; await readSentence(text, i, reader); }
    function nextSentence() {
      if (i < sents.length - 1) { i++; setCur(); modelRead(); }
      else { award('echo', 2); celebrate('🔁', praise(), G('קראת את כל הטקסט כמו הד!', 'קראת את כל הטקסט כמו הד!'), next); }
    }
    setCur();
    return h('div', { class: 'stack' }, bubble, counter, reader, h('div', { class: 'row' }, listenBtn, meBtn));
  }

  /* 4. read alone, aloud; optional recording; tap a word for help; optional line focus */
  function solo() {
    let focusI = 0, started = 0;
    const reader = renderReader(text, { onWord: w => { S.helps++; say(w); } });
    const canRec = state.settings.record && Rec.supported();
    const focusNav = h('div', { class: 'row hidden' },
      h('button', { class: 'btn-ghost grow', onclick: () => moveFocus(-1) }, '▲ הקודם'),
      h('button', { class: 'btn-ghost grow', onclick: () => moveFocus(1) }, '▼ הבא'));
    const moveFocus = d => {
      focusI = Math.max(0, Math.min(sents.length - 1, focusI + d));
      reader.querySelectorAll('.s').forEach(e => e.classList.remove('cur'));
      sentEl(reader, focusI).classList.add('cur');
      sentEl(reader, focusI).scrollIntoView({ block: 'center', behavior: 'smooth' });
    };
    const focusBtn = h('button', { class: 'btn-ghost btn-small', onclick: () => {
      const on = reader.classList.toggle('focus');
      focusNav.classList.toggle('hidden', !on);
      focusBtn.textContent = on ? '📏 בלי סרגל' : '📏 סרגל קריאה';
      if (on) moveFocus(0);
    } }, '📏 סרגל קריאה');
    const after = h('div', { class: 'stack' });
    const startBtn = h('button', { class: 'btn-big btn-full ' + (canRec ? 'btn-orange' : 'btn-green'), onclick: async () => {
      if (!started) {
        if (canRec) {
          try { await Rec.start(); } catch { toast('אין גישה למיקרופון — אפשר לקרוא גם בלי הקלטה'); }
        }
        started = Date.now();
        startBtn.textContent = G('⏹ סיימתי לקרוא', '⏹ סיימתי לקרוא');
        if (Rec.mr) startBtn.classList.add('rec-on');
        return;
      }
      const secs = Math.max(1, Math.round((Date.now() - started) / 1000));
      const nWords = sents.reduce((a, s) => a + wordsOf(s).length, 0);
      const r = await Rec.stop();
      state.reads[text.id] = [...readsOf(text.id), { d: Date.now(), secs, wpm: Math.round(nWords / (secs / 60)), helps: S.helps, rec: !!r }];
      save();
      startBtn.classList.add('hidden');
      award('solo', 2);
      markDid('read');
      if (r) {
        await DB.add({ kind: 'child', uid: user?.id, textId: text.id, title: strip(text.title), d: Date.now(), secs: r.secs, blob: r.blob }).catch(() => {});
        after.append(h('button', { class: 'btn-big btn-blue btn-full', onclick: () => { stopAll(); playBlob(r.blob); } }, G('🎧 לשמוע את עצמי', '🎧 לשמוע את עצמי')));
      }
      after.append(mascot(G(`${praise()} קראת את כל הטקסט לבד!`, `${praise()} קראת את כל הטקסט לבד!`)), nextBtn());
      confetti(14);
    } }, canRec ? G('🎤 התחל לקרוא ולהקליט', '🎤 התחילי לקרוא ולהקליט') : G('▶ התחלתי לקרוא', '▶ התחלתי לקרוא'));
    return h('div', { class: 'stack' },
      mascot(G('עכשיו תורך לקרוא בקול. אין שעון ואין לחץ. מילה קשה? לחץ עליה ותשמע אותה.',
        'עכשיו תורך לקרוא בקול. אין שעון ואין לחץ. מילה קשה? לחצי עליה ותשמעי אותה.')),
      h('div', { class: 'row between' }, h('span', { class: 'muted' }, canRec ? 'ההקלטה נשמרת רק במכשיר הזה' : ''), focusBtn),
      h('div', { class: 'reading-title' }, disp(text.title)), reader, focusNav, startBtn, after,
      h('button', { class: 'btn-ghost btn-small', onclick: next }, 'לדלג ◀'));
  }

  /* 5. comprehension: questions with "find it in the text" hints */
  function quiz() {
    const qs = [...(text.questions || [])];
    if (text.gist) qs.push({ ...text.gist, sentence: -1, gist: true });
    if (!qs.length) { award('quiz', 1); return h('div', { class: 'stack' }, mascot('אין שאלות לטקסט הזה.'), nextBtn()); }
    let qi = 0;
    const wrap = h('div', { class: 'stack' });
    const drawQ = () => {
      const q = qs[qi];
      const order = shuffle(q.options.map((o, i) => i));
      const reader = renderReader(text);
      const textBox = h('div', { class: 'hidden' }, reader);
      const msg = h('div');
      const findBtn = h('button', { class: 'btn-ghost btn-full', onclick: () => {
        textBox.classList.remove('hidden');
        if (q.sentence >= 0) { const el = sentEl(reader, q.sentence); el?.classList.add('hint'); el?.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
      } }, '🔍 לחפש את התשובה בטקסט');
      let tries = 0;
      const opts = h('div', { class: 'options' }, order.map(oi => h('button', { class: 'opt', onclick: e => {
        const b = e.currentTarget;
        if (oi === q.answer) {
          b.classList.add('right');
          opts.querySelectorAll('.opt').forEach(x => x.disabled = true);
          addStars(1);
          msg.replaceChildren(mascot(tries ? `${praise()} ${G('חיפשת ומצאת!', 'חיפשת ומצאת!')}` : praise()));
          msg.append(h('button', { class: 'btn-big btn-full', onclick: () => { qi++; if (qi < qs.length) drawQ(); else { S.done.add('quiz'); next(); } } }, 'ממשיכים ◀'));
          if (q.sentence >= 0) { textBox.classList.remove('hidden'); sentEl(reader, q.sentence)?.classList.add('hint'); }
        } else {
          tries++;
          b.classList.add('notyet'); b.disabled = true;
          msg.replaceChildren(mascot(q.gist ? G('כמעט! תחשוב: על מה מדברים לאורך כל הטקסט?', 'כמעט! תחשבי: על מה מדברים לאורך כל הטקסט?')
            : G('כמעט! בוא נחפש ביחד בטקסט — המשפט הירוק עוזר.', 'כמעט! בואי נחפש ביחד בטקסט — המשפט הירוק עוזר.')));
          findBtn.click();
          if (q.gist) textBox.classList.remove('hidden');
        }
      } }, disp(q.options[oi]))));
      wrap.replaceChildren(
        h('div', { class: 'muted center' }, `שאלה ${qi + 1} מתוך ${qs.length}`),
        h('div', { class: 'card stack' },
          h('div', { class: 'row' }, h('div', { class: 'qtext grow' }, disp(q.q)),
            h('button', { class: 'icon-btn btn-ghost', 'aria-label': 'השמעת השאלה', onclick: async () => {
              stopAll(); const tok = playToken;
              for (const s of [q.q, ...order.map(i => q.options[i])]) { if (tok !== playToken) break; await TTS.speak(s); await wait(250); }
              if (!TTS.voice) noVoiceWarning();
            } }, '🔊')),
          opts),
        msg, findBtn, textBox);
    };
    drawQ();
    return wrap;
  }

  /* 6. write a short response with starters + word bank */
  function write() {
    const w = text.write;
    if (!w) return h('div', { class: 'stack' }, mascot('סיימנו! 🎉'), nextBtn('לסיום ◀'));
    const ta = h('textarea', { placeholder: G('כתוב כאן...', 'כתבי כאן...'), dir: 'rtl' });
    const out = h('div', { class: 'stack' });
    return h('div', { class: 'stack' },
      mascot(disp(w.prompt)),
      h('div', { class: 'muted' }, G('אפשר להתחיל ככה (לחץ כדי להוסיף):', 'אפשר להתחיל ככה (לחצי כדי להוסיף):')),
      h('div', { class: 'chips' }, (w.starters || []).map(s => h('button', { class: 'chip starter', onclick: () => insertText(ta, disp(s) + ' ') }, disp(s)))),
      h('div', { class: 'muted' }, 'מילים שיכולות לעזור:'),
      h('div', { class: 'chips' }, (w.wordBank || []).map(s => h('button', { class: 'chip', onclick: () => insertText(ta, disp(s) + ' ') }, disp(s)))),
      ta,
      h('div', { class: 'row' },
        h('button', { class: 'btn-ghost grow', onclick: () => ta.value.trim() ? say(ta.value) : toast('עוד לא כתבת כלום 🙂') }, G('🔊 תקריא לי מה כתבתי', '🔊 תקריא לי מה כתבתי')),
        h('button', { class: 'btn-green grow', onclick: () => {
          const txt = ta.value.trim();
          if (wordsOf(txt).length < 2) { toast(G('נסה לכתוב לפחות משפט אחד קטן ✏️', 'נסי לכתוב לפחות משפט אחד קטן ✏️')); return; }
          state.answers.push({ textId: text.id, title: strip(text.title), text: txt, d: Date.now() });
          save(); award('write', 2); markDid('write');
          out.replaceChildren(writingFeedback(txt), nextBtn('לסיום ◀'));
        } }, 'שמרתי ✓')),
      out,
      h('button', { class: 'btn-ghost btn-small', onclick: next }, 'לדלג ◀'));
  }

  function finish() {
    confetti(30);
    return h('div', { class: 'stack center' },
      h('div', { style: 'font-size:80px' }, '🏆'),
      h('h1', {}, `${praise()} ${state.profile.name}!`),
      h('p', {}, G(`סיימת את "${strip(text.title)}" והרווחת ${S.earned} כוכבים ⭐`, `סיימת את "${strip(text.title)}" והרווחת ${S.earned} כוכבים ⭐`)),
      mascot(readsOf(text.id).length < 2 ? 'רעיון: מחר אפשר לקרוא את הטקסט הזה שוב — ותראו כמה זה יהיה קל יותר!' : 'אפשר לבחור טקסט חדש בספרייה.'),
      h('div', { class: 'row' },
        h('button', { class: 'btn-big grow', onclick: () => location.hash = '#/home' }, '🏠 הביתה'),
        h('button', { class: 'btn-big btn-ghost grow', onclick: () => location.hash = '#/library' }, '📚 ספרייה')));
  }

  draw();
  return root;
};

function insertText(ta, s) {
  const start = ta.selectionStart ?? ta.value.length, end = ta.selectionEnd ?? ta.value.length;
  const before = ta.value.slice(0, start);
  const pad = before && !/\s$/.test(before) ? ' ' : '';
  ta.value = before + pad + s + ta.value.slice(end);
  const p = (before + pad + s).length;
  ta.focus(); ta.setSelectionRange(p, p);
}

/* Gentle feedback: strengths first, then ONE tip, under the text — never marks on it */
const CONNECTIVES = ['כי', 'אבל', 'לכן', 'ולכן', 'ואז', 'אחר כך', 'אחרי', 'בגלל', 'כש', 'אם', 'גם'];
function writingFeedback(txt) {
  const plain = strip(txt);
  const nW = wordsOf(plain).length;
  const nS = (plain.match(/[.!?]/g) || []).length || 1;
  const hasConn = CONNECTIVES.some(c => new RegExp(`(^|\\s|ו)${c}(\\s|$)`).test(plain));
  const strengths = [`כתבת ${nW} מילים ו־${nS} ${nS === 1 ? 'משפט' : 'משפטים'}! 🌟`];
  if (hasConn) strengths.push(G('השתמשת במילת קישור — ככה כותבים סופרים! 🔗', 'השתמשת במילת קישור — ככה כותבות סופרות! 🔗'));
  if (/[!?]/.test(plain)) strengths.push('יש לך סימני רגש בטקסט — הוא נשמע חי! 🎭');
  let tip;
  if (!/[.!?]\s*$/.test(plain)) tip = 'טיפ קטן לפעם הבאה: בסוף משפט שמים נקודה.';
  else if (!hasConn) tip = 'טיפ קטן לפעם הבאה: נסו לחבר משפטים עם "כי", "אבל" או "ואז".';
  else if (nW < 12) tip = 'טיפ קטן לפעם הבאה: אפשר להוסיף עוד משפט אחד — מה קרה אחר כך?';
  return h('div', { class: 'stack' },
    h('div', { class: 'feedback' }, strengths.map(s => h('div', {}, s))),
    tip ? h('div', { class: 'tip' }, '💡 ', tip) : null);
}

/* ================= games ================= */
routes.games = () => h('div', { class: 'stack' }, topbar('🎮 משחקי מילים'),
  mascot('משחקים קצרים שעוזרים לכתוב נכון ולהבין מילים. בלי שעון ובלי לחץ!'),
  h('div', { class: 'grid' }, GAMES.map(g => {
    const st = state.games[g.id];
    return h('div', { class: 'tile', onclick: () => location.hash = `#/game/${g.id}` },
      h('div', { class: 'emo' }, g.emo), g.name, h('div', { class: 'sub' }, st?.plays ? `שיחקתי ${st.plays} פעמים` : g.sub));
  })));

function gameStat(id, right, wrong) {
  const s = state.games[id] || (state.games[id] = { plays: 0, right: 0, wrong: 0 });
  s.right += right; s.wrong += wrong; save();
}
function gameDone(id, stars, onAgain) {
  const s = state.games[id] || (state.games[id] = { plays: 0, right: 0, wrong: 0 });
  s.plays++; save(); markDid('game'); addStars(stars);
  confetti(20);
  return h('div', { class: 'stack center' },
    h('div', { style: 'font-size:72px' }, '🎉'), h('h2', {}, praise()),
    h('p', {}, `הרווחת ${stars} כוכבים ⭐`),
    h('div', { class: 'row' },
      h('button', { class: 'btn-big grow', onclick: onAgain }, '🔁 עוד סיבוב'),
      h('button', { class: 'btn-big btn-ghost grow', onclick: () => location.hash = '#/games' }, 'משחק אחר')));
}
function addToDict(word) {
  const w = strip(word);
  const e = state.dict.find(x => x.w === w);
  if (e) e.miss++; else state.dict.push({ w, miss: 1, ok: 0, d: Date.now() });
  save();
}

routes.game = id => {
  const wrap = h('div', { class: 'stack' });
  const g = GAMES.find(x => x.id === id) || GAMES[0];
  const body = h('div', { class: 'stack' });
  wrap.append(topbar(`${g.emo} ${g.name}`, '#/games'), body);
  ({ letters: gLetters, roots: gRoots, build: gBuild, combine: gCombine, spell: gSpell })[g.id](body);
  return wrap;
};

/* --- אותיות חברות: choose the right homophone letter --- */
function gLetters(body) {
  const items = shuffle(C.friendLetters).slice(0, 6);
  let i = 0, right = 0, wrong = 0;
  const drawItem = () => {
    if (i >= items.length) { gameStat('letters', right, wrong); body.replaceChildren(gameDone('letters', 3, () => gLetters(body))); return; }
    const it = items[i];
    const letters = [...it.word];
    const gap = h('span', { class: 'gap' }, '?');
    const word = h('div', { class: 'bigword' }, letters.map((l, k) => k === it.pos ? gap : l));
    const msg = h('div');
    let missed = false;
    const choices = h('div', { class: 'letter-choices' }, shuffle(it.options).map(l => h('button', { class: 'btn-ghost', onclick: e => {
      if (l === it.answer) {
        gap.textContent = l; gap.classList.add('filled');
        choices.querySelectorAll('button').forEach(b => b.disabled = true);
        if (!missed) right++;
        say(it.word);
        msg.replaceChildren(h('div', { class: 'feedback stack' }, h('b', {}, praise()),
          it.family?.length ? h('div', {}, 'מאותה משפחה: ', h('span', { style: 'font-family:var(--read);font-weight:700' }, it.family.join(' · '))) : null),
          h('button', { class: 'btn-big btn-full', style: 'margin-top:12px', onclick: () => { i++; drawItem(); } }, 'הבא ◀'));
      } else {
        if (!missed) { wrong++; addToDict(it.word); }
        missed = true;
        e.currentTarget.classList.add('shake'); e.currentTarget.disabled = true;
        msg.replaceChildren(h('div', { class: 'tip' }, '💡 רמז: ', disp(it.clue || 'נסה/י את האות השנייה')));
      }
    } }, l)));
    body.replaceChildren(
      h('div', { class: 'muted center' }, `מילה ${i + 1} מתוך ${items.length}`),
      mascot(G('איזו אות חסרה? בחר את האות הנכונה.', 'איזו אות חסרה? בחרי את האות הנכונה.')),
      h('div', { class: 'card' }, word, choices), msg);
  };
  if (!items.length) body.append(mascot('אין עדיין מילים למשחק.')); else drawItem();
}

/* --- עץ השורשים: sort words to their root tree (tap word, then tap tree) --- */
function markRoot(word, root) {
  const r = [...normFinal(root)];
  let k = 0;
  return [...word].map(ch => {
    if (k < r.length && normFinal(ch) === r[k]) { k++; return h('span', { class: 'rootl' }, ch); }
    return ch;
  });
}
function gRoots(body) {
  const roots = shuffle(C.roots).slice(0, 3);
  const words = shuffle(roots.flatMap(r => shuffle(r.words).slice(0, 3).map(w => ({ w, root: r.root }))));
  let sel = null, wrong = 0, placed = 0;
  const pool = h('div', { class: 'chips', style: 'justify-content:center' });
  const msg = h('div');
  const trees = h('div', { class: 'trees' });
  const treeEls = {};
  roots.forEach(r => {
    const list = h('div', { class: 'chips', style: 'justify-content:center' });
    const t = h('div', { class: 'tree', onclick: () => {
      if (!sel) { toast(G('קודם בחר מילה 👆', 'קודם בחרי מילה 👆')); return; }
      if (sel.item.root === r.root) {
        list.append(h('span', { class: 'chip ok' }, markRoot(sel.item.w, r.root)));
        sel.el.remove(); sel = null; placed++;
        trees.querySelectorAll('.tree').forEach(x => x.classList.remove('target'));
        msg.replaceChildren(h('div', { class: 'feedback' }, praise()));
        if (placed === words.length) { gameStat('roots', words.length - wrong, wrong); setTimeout(() => body.replaceChildren(gameDone('roots', 3, () => gRoots(body))), 900); }
      } else {
        wrong++; t.classList.add('shake'); setTimeout(() => t.classList.remove('shake'), 400);
        msg.replaceChildren(h('div', { class: 'tip' }, `💡 חפש/י במילה "${sel.item.w}" את שלוש אותיות השורש. האם יש בה ${[...r.root].join(', ')}?`));
      }
    } }, h('div', { style: 'font-size:34px;text-align:center' }, '🌳'),
      h('div', { class: 'root' }, [...r.root].join('-')), h('div', { class: 'meaning' }, disp(r.meaning || '')), list);
    treeEls[r.root] = t; trees.append(t);
  });
  words.forEach(item => {
    const el = h('button', { class: 'chip', onclick: () => {
      pool.querySelectorAll('.chip').forEach(c => c.classList.remove('sel'));
      el.classList.add('sel'); sel = { item, el };
      trees.querySelectorAll('.tree').forEach(x => x.classList.add('target'));
      say(item.w);
    } }, item.w);
    pool.append(el);
  });
  body.replaceChildren(mascot(G('לכל מילה יש שורש — שלוש אותיות שעוברות בכל המשפחה. בחר מילה ואז לחץ על העץ שלה.',
    'לכל מילה יש שורש — שלוש אותיות שעוברות בכל המשפחה. בחרי מילה ואז לחצי על העץ שלה.')),
  h('div', { class: 'card' }, pool), msg, trees);
}

/* --- בונים משפט: order the tiles --- */
function gBuild(body) {
  const items = shuffle(C.sentences).slice(0, 5);
  let i = 0, right = 0, wrong = 0;
  const drawItem = () => {
    if (i >= items.length) { gameStat('build', right, wrong); body.replaceChildren(gameDone('build', 3, () => gBuild(body))); return; }
    const it = items[i];
    let pool = shuffle(it.tiles.map((t, k) => ({ t, k })));
    if (pool.every((p, k) => p.k === k) && pool.length > 1) pool.reverse();
    let ans = [];
    let missed = false;
    const ansRow = h('div', { class: 'answer-row' });
    const poolRow = h('div', { class: 'chips', style: 'justify-content:center;min-height:56px' });
    const msg = h('div');
    const paint = () => {
      ansRow.replaceChildren(...(ans.length ? ans.map((p, idx) => h('button', { class: 'chip sel', onclick: () => { ans.splice(idx, 1); pool.push(p); paint(); } }, disp(p.t)))
        : [h('span', { class: 'muted' }, G('לחץ על המילים לפי הסדר', 'לחצי על המילים לפי הסדר'))]));
      poolRow.replaceChildren(...pool.map((p, idx) => h('button', { class: 'chip', onclick: () => { pool.splice(idx, 1); ans.push(p); paint(); check(); } }, disp(p.t))));
    };
    const check = () => {
      if (pool.length) return;
      const ok = ans.every((p, k) => it.tiles[k] === p.t);
      if (ok) {
        if (!missed) right++;
        say(it.tiles.join(' '));
        ansRow.querySelectorAll('.chip').forEach(c => { c.className = 'chip ok'; c.disabled = true; });
        msg.replaceChildren(h('div', { class: 'feedback' }, praise(), ' ', it.emoji || ''),
          h('button', { class: 'btn-big btn-full', style: 'margin-top:12px', onclick: () => { i++; drawItem(); } }, 'הבא ◀'));
      } else {
        if (!missed) wrong++; missed = true;
        // keep the correct beginning, return the rest to the pool
        let k = 0; while (k < ans.length && ans[k].t === it.tiles[k]) k++;
        pool = shuffle(ans.slice(k)); ans = ans.slice(0, k);
        paint();
        msg.replaceChildren(h('div', { class: 'tip' }, k ? `💡 ההתחלה נכונה! מה בא אחרי "${disp(it.tiles[k - 1])}"?` : '💡 נסו לחשוב: מי עושה? מה עושה?'));
      }
    };
    paint();
    body.replaceChildren(h('div', { class: 'muted center' }, `משפט ${i + 1} מתוך ${items.length}`),
      mascot(G('סדר את המילים למשפט שיש בו היגיון.', 'סדרי את המילים למשפט שיש בו היגיון.')),
      h('div', { class: 'card stack' }, h('div', { class: 'center', style: 'font-size:48px' }, it.emoji || '🧱'), ansRow, poolRow), msg);
  };
  drawItem();
}

/* --- מחברים משפטים: choose the connective --- */
function gCombine(body) {
  const items = shuffle(C.combine).slice(0, 5);
  let i = 0, right = 0, wrong = 0;
  const drawItem = () => {
    if (i >= items.length) { gameStat('combine', right, wrong); body.replaceChildren(gameDone('combine', 3, () => gCombine(body))); return; }
    const it = items[i];
    const msg = h('div');
    let missed = false;
    const A = it.a.replace(/[.!?]\s*$/, '');
    const opts = h('div', { class: 'chips', style: 'justify-content:center' }, shuffle(it.options).map(o => h('button', { class: 'chip', style: 'font-size:24px', onclick: e => {
      if (o === it.answer) {
        if (!missed) right++;
        opts.querySelectorAll('.chip').forEach(c => c.disabled = true);
        e.currentTarget.className = 'chip ok';
        say(it.result);
        msg.replaceChildren(h('div', { class: 'feedback stack' }, h('b', {}, praise()), h('div', { class: 'qtext' }, disp(it.result))),
          h('button', { class: 'btn-big btn-full', style: 'margin-top:12px', onclick: () => { i++; drawItem(); } }, 'הבא ◀'));
      } else {
        if (!missed) wrong++; missed = true;
        e.currentTarget.disabled = true;
        msg.replaceChildren(h('div', { class: 'tip' }, '💡 ', G('תקשיב איך זה נשמע עם המילה הזאת — זה הגיוני?', 'תקשיבי איך זה נשמע עם המילה הזאת — זה הגיוני?')));
        say(`${A} ${o} ${it.b}`);
      }
    } }, disp(o))));
    body.replaceChildren(h('div', { class: 'muted center' }, `${i + 1} מתוך ${items.length}`),
      mascot(G('איזו מילה מחברת את שני המשפטים הכי טוב?', 'איזו מילה מחברת את שני המשפטים הכי טוב?')),
      h('div', { class: 'card stack' },
        h('div', { class: 'row' }, h('div', { class: 'qtext grow' }, disp(it.a)), sayBtn(it.a)),
        h('div', { class: 'center', style: 'font-size:28px' }, '🔗'),
        h('div', { class: 'row' }, h('div', { class: 'qtext grow' }, disp(it.b)), sayBtn(it.b)),
        opts), msg);
  };
  drawItem();
}

/* --- מסתכלים וכותבים (look, cover, write, check) from the personal dictionary --- */
function hebKeyboard(input, onEnter) {
  const rows = ['קראטוןםפ', 'שדגכעיחלךף', 'זסבהנמצתץ'];
  const add = c => { input.value += c; };
  return h('div', { class: 'kbd' },
    rows.map(r => h('div', { class: 'krow' }, [...r].map(c => h('button', { onclick: () => add(c) }, c)))),
    h('div', { class: 'krow' },
      h('button', { class: 'wide', onclick: () => { input.value = input.value.slice(0, -1); } }, '⌫ מחק'),
      h('button', { class: 'wide', onclick: () => add(' ') }, 'רווח'),
      h('button', { class: 'wide', style: 'background:var(--green);color:#fff', onclick: onEnter }, '✓ בדיקה')));
}
function gSpell(body) {
  let words = state.dict.slice().sort((a, b) => (b.miss - b.ok) - (a.miss - a.ok)).slice(0, 5).map(x => x.w);
  if (words.length < 5) words = [...words, ...shuffle(C.friendLetters.map(f => f.word).filter(w => !words.includes(w))).slice(0, 5 - words.length)];
  let i = 0, right = 0, wrong = 0;
  const drawItem = () => {
    if (i >= words.length) { gameStat('spell', right, wrong); body.replaceChildren(gameDone('spell', 3, () => gSpell(body))); return; }
    const w = words[i];
    let missed = false;
    const look = () => body.replaceChildren(
      h('div', { class: 'muted center' }, `מילה ${i + 1} מתוך ${words.length}`),
      mascot(G('1. תסתכל טוב על המילה. 2. נסתיר אותה. 3. תכתוב אותה מהזיכרון.', '1. תסתכלי טוב על המילה. 2. נסתיר אותה. 3. תכתבי אותה מהזיכרון.')),
      h('div', { class: 'card stack center' }, h('div', { class: 'bigword' }, w), h('div', {}, sayBtn(w, 'btn-blue')),
        h('button', { class: 'btn-big btn-full', onclick: writeIt }, G('👀 זכרתי — תסתיר!', '👀 זכרתי — תסתיר!'))));
    const writeIt = () => {
      const inp = h('input', { type: 'text', readonly: true, dir: 'rtl', style: 'font-family:var(--read);font-size:34px;text-align:center' });
      const msg = h('div');
      const check = () => {
        const v = inp.value.trim();
        if (!v) return;
        const entry = state.dict.find(x => x.w === w);
        if (normFinal(v) === normFinal(w) && v === w) {
          if (!missed) right++;
          if (entry) entry.ok++;
          save();
          msg.replaceChildren(h('div', { class: 'feedback' }, praise(), ' ', G('כתבת נכון!', 'כתבת נכון!')),
            h('button', { class: 'btn-big btn-full', style: 'margin-top:12px', onclick: () => { i++; drawItem(); } }, 'הבא ◀'));
        } else {
          if (!missed) wrong++; missed = true;
          const diff = h('div', { class: 'bigword diff' }, [...v].map((c, k) => c === w[k] ? c : h('span', { class: 'bad' }, c)));
          msg.replaceChildren(h('div', { class: 'tip stack' }, h('div', {}, 'כמעט! ככה כתבת:'), diff,
            h('div', {}, 'ככה כותבים:'), h('div', { class: 'bigword' }, w)),
            h('button', { class: 'btn-big btn-full', style: 'margin-top:12px', onclick: look }, '🔁 עוד ניסיון'));
        }
      };
      body.replaceChildren(mascot(G('עכשיו תכתוב את המילה מהזיכרון.', 'עכשיו תכתבי את המילה מהזיכרון.')),
        h('div', { class: 'card stack' }, h('div', { class: 'row' }, inp, sayBtn(w)), hebKeyboard(inp, check)), msg);
    };
    look();
  };
  drawItem();
}

/* ================= writing ================= */
routes.write = () => h('div', { class: 'stack' }, topbar('✏️ כותבים'),
  mascot(G('בוא נבנה סיפור ביחד, צעד אחרי צעד. אני אעזור עם מילים ורעיונות!', 'בואי נבנה סיפור ביחד, צעד אחרי צעד. אני אעזור עם מילים ורעיונות!')),
  h('h3', {}, 'סיפור חדש'),
  h('div', { class: 'grid' }, C.stories.map(s => h('div', { class: 'tile', onclick: () => location.hash = `#/story/${s.id}` },
    h('div', { class: 'emo' }, s.emoji), h('div', { style: 'font-family:var(--read)' }, disp(s.title))))),
  h('h3', {}, `📕 ספר הסיפורים שלי (${state.stories.length})`),
  state.stories.length ? h('div', { class: 'stack' }, state.stories.slice().reverse().map(s => h('div', { class: 'card stack' },
    h('div', { class: 'row' }, h('div', { style: 'font-size:30px' }, s.emoji), h('b', { class: 'grow' }, s.title), sayBtn(s.text)),
    h('div', { style: 'font-family:var(--read);font-size:19px;white-space:pre-wrap;line-height:1.9' }, s.text),
    h('div', { class: 'muted' }, new Date(s.d).toLocaleDateString('he-IL')))))
    : h('p', { class: 'muted' }, 'עוד אין סיפורים. הסיפור הראשון מחכה לך!'));

routes.story = id => {
  const st = C.stories.find(s => s.id === id);
  if (!st) { location.hash = '#/write'; return null; }
  const parts = {};
  let k = 0;
  const wrap = h('div', { class: 'stack' });
  const body = h('div', { class: 'stack' });
  wrap.append(topbar(`${st.emoji} ${strip(st.title)}`, '#/write'), body);
  const draw = () => {
    if (k >= st.steps.length) return finishStory();
    const step = st.steps[k];
    const ta = h('textarea', { dir: 'rtl', placeholder: G('כתוב משפט אחד או שניים...', 'כתבי משפט אחד או שניים...') });
    ta.value = parts[step.key] || '';
    body.replaceChildren(
      h('div', { class: 'stepper' }, st.steps.map((s, i) => h('button', { class: i === k ? 'cur' : (parts[s.key] ? 'ok' : ''), onclick: () => { parts[step.key] = ta.value; k = i; draw(); } }, String(i + 1)))),
      mascot(disp(step.label)),
      h('div', { class: 'muted' }, 'אפשר להתחיל ככה:'),
      h('div', { class: 'chips' }, (step.starters || []).map(s => h('button', { class: 'chip starter', onclick: () => insertText(ta, disp(s).replace(/\.\.\.$|…$/, '') + ' ') }, disp(s)))),
      h('div', { class: 'muted' }, 'מחסן מילים:'),
      h('div', { class: 'chips' }, (step.bank || []).map(s => h('button', { class: 'chip', onclick: () => insertText(ta, disp(s) + ' ') }, disp(s)))),
      ta,
      h('div', { class: 'row' },
        k > 0 ? h('button', { class: 'btn-ghost', onclick: () => { parts[step.key] = ta.value; k--; draw(); } }, '→ הקודם') : null,
        h('button', { class: 'btn-ghost', onclick: () => ta.value.trim() ? say(ta.value) : null }, '🔊 תקריא לי'),
        h('button', { class: 'btn-big grow', onclick: () => {
          if (!ta.value.trim()) { toast(G('כתוב לפחות כמה מילים ✏️', 'כתבי לפחות כמה מילים ✏️')); return; }
          parts[step.key] = ta.value.trim(); k++; draw();
        } }, k === st.steps.length - 1 ? 'סיימתי! ✓' : 'הבא ◀')));
  };
  const finishStory = () => {
    const text = st.steps.map(s => parts[s.key]).filter(Boolean).map(p => /[.!?]$/.test(p) ? p : p + '.').join('\n');
    const title = h('input', { type: 'text', value: strip(st.title) });
    const saved = h('div');
    body.replaceChildren(
      h('h2', { class: 'center' }, 'הסיפור שלי 📖'),
      h('div', { class: 'card', style: 'font-family:var(--read);font-size:21px;white-space:pre-wrap;line-height:2' }, text),
      h('button', { class: 'btn-big btn-blue btn-full', onclick: () => say(text) }, '🔊 ינשופי מקריא את הסיפור שלי'),
      writingFeedback(text),
      h('div', { class: 'field' }, h('label', {}, 'שם לסיפור'), title),
      h('button', { class: 'btn-big btn-green btn-full', onclick: e => {
        e.currentTarget.disabled = true;
        state.stories.push({ id: Date.now(), title: title.value.trim() || strip(st.title), emoji: st.emoji, text, d: Date.now() });
        save(); markDid('write'); addStars(4);
        celebrate('📕', 'הסיפור נשמר בספר שלך!', `הרווחת 4 כוכבים ⭐`, () => location.hash = '#/write');
      } }, '📕 לשמור בספר הסיפורים'),
      saved);
  };
  draw();
  return wrap;
};

/* ================= stickers ================= */
routes.stickers = () => {
  const nextIn = STARS_PER_STICKER - (state.stars % STARS_PER_STICKER);
  return h('div', { class: 'stack' }, topbar('🏆 המדבקות שלי'),
    mascot(state.stickers.length < STICKERS.length ? `עוד ${nextIn} כוכבים למדבקה הבאה! כוכבים מקבלים על כל מאמץ — לא רק על תשובות נכונות.` : 'אספת את כל המדבקות! 👑'),
    h('div', { class: 'stickers' }, STICKERS.map((s, i) => h('div', { class: 'sticker' + (i < state.stickers.length ? '' : ' locked') }, i < state.stickers.length ? s : '❔'))));
};

/* ================= parent area ================= */
let parentOk = false;
routes.parent = (tab = 'progress') => {
  if (!parentOk && !isAdmin()) {
    const a = 3 + Math.floor(Math.random() * 7), b = 6 + Math.floor(Math.random() * 4);
    const inp = h('input', { type: 'number', inputmode: 'numeric' });
    const go = () => { if (Number(inp.value) === a * b) { parentOk = true; render(); } else { inp.value = ''; inp.classList.add('shake'); setTimeout(() => inp.classList.remove('shake'), 400); } };
    inp.addEventListener('keydown', e => e.key === 'Enter' && go());
    return h('div', { class: 'stack' }, topbar('👨‍👩‍👧 אזור הורים'),
      h('div', { class: 'card stack' }, h('p', {}, 'כדי להיכנס, פתרו את התרגיל:'), h('h2', {}, `${a} × ${b} = ?`), inp,
        h('button', { class: 'btn-full', onclick: go }, 'כניסה')));
  }
  const TABS = [['progress', '📈 התקדמות'], ['recs', '🎧 הקלטות'], ['texts', '📄 טקסטים'], ['writing', '✏️ כתיבה'], ['prefs', '⚙️ הגדרות']];
  const body = h('div', { class: 'stack' });
  const wrap = h('div', { class: 'stack' }, topbar('👨‍👩‍👧 אזור הורים'),
    h('div', { class: 'tabs' }, TABS.map(([k, l]) => h('button', { class: k === tab ? 'cur' : '', onclick: () => location.hash = `#/parent/${k}` }, l))), body);
  ({ progress: pProgress, recs: pRecs, texts: pTexts, writing: pWriting, prefs: pPrefs })[tab]?.(body);
  return wrap;
};

function pProgress(body, st = state) {
  const days = Array.from({ length: 14 }, (_, i) => { const d = new Date(); d.setDate(d.getDate() - 13 + i); return d; });
  const mins = days.map(d => st.days[todayKey(d)]?.mins || 0);
  const max = Math.max(10, ...mins);
  const totalMins = Object.values(st.days).reduce((a, d) => a + (d.mins || 0), 0);
  const activeDays = Object.values(st.days).filter(d => d.acts > 0).length;
  const totalReads = Object.values(st.reads).reduce((a, r) => a + r.length, 0);
  body.append(
    h('div', { class: 'stats' },
      h('div', { class: 'stat' }, h('b', {}, activeDays), 'ימי תרגול'),
      h('div', { class: 'stat' }, h('b', {}, Math.round(totalMins)), 'דקות'),
      h('div', { class: 'stat' }, h('b', {}, totalReads), 'קריאות'),
      h('div', { class: 'stat' }, h('b', {}, st.stars), 'כוכבים')),
    h('div', { class: 'card stack' }, h('h3', {}, 'דקות תרגול — 14 ימים אחרונים'),
      h('div', { class: 'bars' }, mins.map(m => h('div', { class: 'b', style: `height:${(m / max) * 100}%` }, h('span', {}, m ? Math.round(m) : '')))),
      h('div', { class: 'bar-labels' }, days.map(d => h('span', {}, `${d.getDate()}/${d.getMonth() + 1}`)))),
    h('div', { class: 'card stack' }, h('h3', {}, 'קריאה לבד (שלב 4)'),
      h('p', { class: 'muted' }, 'מילים לדקה מחושבות מהזמן שבין "התחלתי" ל"סיימתי". חשוב להשוות רק לקריאות קודמות של הילד/ה, ולא להציג לילד/ה. "עזרה" = כמה פעמים נלחצה מילה כדי לשמוע אותה.'),
      totalReads ? h('table', {}, h('tr', {}, h('th', {}, 'טקסט'), h('th', {}, 'תאריך'), h('th', {}, 'מילים/דקה'), h('th', {}, 'עזרה')),
        Object.entries(st.reads).flatMap(([id, rs]) => rs.map((r, i) => h('tr', {},
          h('td', {}, i === 0 ? strip(getText(id)?.title || id) : (i + 1) + '×'),
          h('td', {}, new Date(r.d).toLocaleDateString('he-IL')), h('td', {}, r.wpm), h('td', {}, r.helps))))) : h('p', { class: 'muted' }, 'עוד אין קריאות.')),
    h('div', { class: 'card stack' }, h('h3', {}, 'משחקים'),
      Object.keys(st.games).length ? h('table', {}, h('tr', {}, h('th', {}, 'משחק'), h('th', {}, 'סיבובים'), h('th', {}, 'נכון בניסיון ראשון')),
        Object.entries(st.games).map(([k, g]) => h('tr', {}, h('td', {}, GAMES.find(x => x.id === k)?.name || k), h('td', {}, g.plays),
          h('td', {}, g.right + g.wrong ? Math.round(100 * g.right / (g.right + g.wrong)) + '%' : '—')))) : h('p', { class: 'muted' }, 'עוד לא שיחקו.')),
    h('div', { class: 'card stack' }, h('h3', {}, 'המילון האישי — מילים שהיו קשות בכתיב'),
      st.dict.length ? h('div', { class: 'chips' }, st.dict.map(d => h('span', { class: 'chip' + (d.ok >= 2 ? ' ok' : '') }, `${d.w} (${d.ok}/${d.miss + d.ok})`)))
        : h('p', { class: 'muted' }, 'עוד אין מילים.'),
      h('p', { class: 'muted' }, 'מילים שהילד/ה טעה/תה בהן במשחק "אותיות חברות" נכנסות לכאן, ומתורגלות במשחק "מסתכלים וכותבים". ירוק = נכתבה נכון לפחות פעמיים.')));
}

async function pRecs(body) {
  body.append(h('p', { class: 'muted' }, 'הקלטות הקריאה של הילד/ה (שלב "קוראים לבד"). נשמרות רק במכשיר הזה. כדאי להאזין יחד ולהגיד מה היה טוב.'));
  let recs = [];
  try { recs = (await DB.all()).filter(r => r.kind === 'child' && (r.uid == null || r.uid === user?.id)).sort((a, b) => b.d - a.d); } catch { }
  if (!recs.length) { body.append(h('p', {}, 'עוד אין הקלטות.')); return; }
  for (const r of recs) {
    const card = h('div', { class: 'card stack' },
      h('div', { class: 'row between' }, h('b', {}, r.title), h('span', { class: 'muted' }, `${new Date(r.d).toLocaleString('he-IL')} · ${r.secs} שנ׳`)),
      h('audio', { controls: true, preload: 'none', src: URL.createObjectURL(r.blob) }),
      h('button', { class: 'btn-ghost btn-small', onclick: async () => { if (confirm('למחוק את ההקלטה?')) { await DB.del(r.id); card.remove(); } } }, '🗑 מחיקה'));
    body.append(card);
  }
}

function pTexts(body) {
  const title = h('input', { type: 'text', placeholder: 'כותרת' });
  const emoji = h('input', { type: 'text', placeholder: 'אימוג׳י (לא חובה)', maxlength: 4 });
  let level = 1;
  const ta = h('textarea', { placeholder: 'הדביקו כאן את הטקסט (עדיף עם ניקוד). שורה ריקה = פסקה חדשה.', style: 'min-height:180px' });
  const hard = h('input', { type: 'text', placeholder: 'מילים קשות, מופרדות בפסיק. אפשר הסבר: מילה=הסבר' });
  const qBox = h('div', { class: 'stack' });
  const addQ = () => {
    const q = h('div', { class: 'card stack', style: 'background:var(--bg)' },
      h('input', { type: 'text', placeholder: 'שאלה', 'data-q': '' }),
      h('input', { type: 'text', placeholder: 'תשובה נכונה', 'data-o': '' }),
      h('input', { type: 'text', placeholder: 'תשובה לא נכונה', 'data-o': '' }),
      h('input', { type: 'text', placeholder: 'תשובה לא נכונה', 'data-o': '' }));
    qBox.append(q);
  };
  addQ();
  const prompt = h('input', { type: 'text', placeholder: 'משימת כתיבה (לא חובה), למשל: מה היית עושה במקום הדמות?' });
  body.append(
    h('div', { class: 'card stack' }, h('h3', {}, '➕ הוספת טקסט מהשיעור או מספר הלימוד'),
      h('p', { class: 'muted' }, 'טיפ: טקסט קצר (4–10 משפטים) עובד הכי טוב. אפשר לקבל ניקוד אוטומטי באתר "נקדן" של דיקטה ולבדוק אותו.'),
      title, emoji, h('div', {}, h('label', {}, 'רמה'), seg([[1, '🌱 קל'], [2, '🌿 בינוני'], [3, '🌳 מאתגר']], 1, v => { level = v; })),
      ta, hard, h('label', {}, 'שאלות הבנה'), qBox,
      h('button', { class: 'btn-ghost btn-small', onclick: addQ }, '+ עוד שאלה'), prompt,
      h('button', { class: 'btn-green btn-full', onclick: () => {
        const raw = ta.value.trim();
        if (!title.value.trim() || !raw) { toast('צריך כותרת וטקסט'); return; }
        const paragraphs = raw.split(/\n\s*\n/).map(p => (p.replace(/\n/g, ' ').match(/[^.!?]+[.!?]*["״']?/g) || []).map(s => s.trim()).filter(Boolean)).filter(p => p.length);
        const hardWords = hard.value.split(/[,،]/).map(s => s.trim()).filter(Boolean).map(s => { const [word, hint] = s.split('='); return { word: word.trim(), hint: (hint || '').trim() }; });
        const questions = [...qBox.children].map(q => ({
          q: q.querySelector('[data-q]').value.trim(),
          options: [...q.querySelectorAll('[data-o]')].map(o => o.value.trim()).filter(Boolean), answer: 0, sentence: -1
        })).filter(q => q.q && q.options.length >= 2);
        // "find it in the text" hint: the first sentence that contains the correct answer
        const fl = paragraphs.flat().map(strip);
        questions.forEach(q => { q.sentence = fl.findIndex(s => s.includes(strip(q.options[0]))); });
        const t = { id: 'c' + Date.now(), title: title.value.trim(), emoji: emoji.value.trim() || '📄', level, genre: 'custom', paragraphs, hardWords, questions,
          write: prompt.value.trim() ? { prompt: prompt.value.trim(), starters: [], wordBank: [] } : null };
        state.custom.push(t); save(); toast('הטקסט נוסף לספרייה ✓'); render();
      } }, 'הוספה לספרייה')),
    h('div', { class: 'card stack' }, h('h3', {}, '🎙️ הקלטת קריאה של הורה'),
      h('p', { class: 'muted' }, 'אפשר להקליט את עצמכם קוראים כל משפט. בשלבים "מקשיבים" ו"קוראים כמו הד" הילד/ה ישמע/תשמע את הקול שלכם במקום הקול הממוחשב. מומלץ במיוחד אם הקול הממוחשב לא טוב במכשיר.'),
      allTexts().map(t => {
        const n = flat(t).filter((_, i) => models[`${t.id}:${i}`]).length;
        return h('div', { class: 'row between', style: 'border-bottom:1px solid var(--line);padding:6px 0' },
          h('span', {}, `${t.emoji || '📄'} ${strip(t.title)}`, h('span', { class: 'muted' }, ` · ${n}/${flat(t).length}`)),
          h('div', { class: 'row' },
            h('button', { class: 'btn-small', onclick: () => location.hash = `#/model/${t.id}` }, '🎙️ הקלטה'),
            t.genre === 'custom' ? h('button', { class: 'btn-small btn-ghost', onclick: () => {
              if (!confirm('למחוק את הטקסט?')) return;
              state.custom = state.custom.filter(x => x.id !== t.id); save(); render();
            } }, '🗑') : null));
      })));
}

routes.model = id => {
  if (!parentOk && !isAdmin()) { location.hash = '#/parent'; return null; }
  const text = getText(id);
  if (!text) { location.hash = '#/parent/texts'; return null; }
  const list = h('div', { class: 'stack' });
  const draw = () => {
    list.replaceChildren(...flat(text).map((s, i) => {
      const m = models[`${text.id}:${i}`];
      const recBtn = h('button', { class: 'btn-small btn-orange', onclick: async () => {
        if (!Rec.mr) {
          try { await Rec.start(); } catch { toast('אין גישה למיקרופון'); return; }
          recBtn.textContent = '⏹ עצירה'; recBtn.classList.add('rec-on');
        } else {
          const r = await Rec.stop();
          if (r) {
            if (m) await DB.del(m.id);
            await DB.add({ kind: 'model', textId: text.id, sent: i, d: Date.now(), secs: r.secs, blob: r.blob });
            await loadModels(); draw();
          }
        }
      } }, m ? '🔁 הקלטה מחדש' : '🎙️ הקלטה');
      return h('div', { class: 'card stack' },
        h('div', { style: 'font-family:var(--read);font-size:22px;line-height:2' }, s),
        h('div', { class: 'row' }, recBtn,
          m ? h('button', { class: 'btn-small btn-blue', onclick: () => { stopAll(); playBlob(m.blob); } }, '▶ השמעה') : null,
          m ? h('button', { class: 'btn-small btn-ghost', onclick: async () => { await DB.del(m.id); await loadModels(); draw(); } }, '🗑') : null));
    }));
  };
  draw();
  return h('div', { class: 'stack' }, topbar(`🎙️ ${strip(text.title)}`, '#/parent/texts'),
    h('p', { class: 'muted' }, 'קראו כל משפט לאט ובבירור, עם הבעה. לחצו "הקלטה", קראו, ולחצו "עצירה".'), list);
};

function pWriting(body) {
  const items = [...state.answers.map(a => ({ ...a, kind: `תגובה ל"${a.title}"` })), ...state.stories.map(s => ({ ...s, kind: `סיפור: ${s.title}` }))].sort((a, b) => b.d - a.d);
  body.append(h('p', { class: 'muted' }, 'כל מה שהילד/ה כתב/ה. כדאי לקרוא יחד, להתחיל ממה שטוב, ולבחור רק דבר אחד לשפר.'));
  if (!items.length) { body.append(h('p', {}, 'עוד אין כתיבה.')); return; }
  items.forEach(it => body.append(h('div', { class: 'card stack' },
    h('div', { class: 'row between' }, h('b', {}, it.kind), h('span', { class: 'muted' }, new Date(it.d).toLocaleDateString('he-IL'))),
    h('div', { style: 'font-family:var(--read);font-size:19px;white-space:pre-wrap;line-height:1.9' }, it.text))));
}

function pPrefs(body) {
  const name = h('input', { type: 'text', value: state.profile.name });
  const voiceSel = h('select', {}, TTS.voices.length ? TTS.voices.map(v => h('option', { value: v.name, selected: v === TTS.voice }, `${v.name} (${v.lang})`)) : h('option', {}, 'לא נמצא קול עברי במכשיר'));
  voiceSel.addEventListener('change', () => { state.settings.voice = voiceSel.value; save(); TTS.voice = TTS.voices.find(v => v.name === voiceSel.value) || TTS.voice; });
  body.append(
    h('div', { class: 'card stack' }, h('h3', {}, '👤 פרופיל'),
      h('p', { class: 'muted' }, `משתמש: ${user?.username || ''}`),
      h('div', { class: 'field' }, h('label', {}, 'שם'), name),
      h('div', { class: 'field' }, h('label', {}, 'פנייה'), seg([['m', 'בן'], ['f', 'בת']], state.profile.gender, v => { state.profile.gender = v; })),
      h('div', { class: 'field' }, h('label', {}, 'דמות'), avatarPicker(state.profile.avatar, a => { state.profile.avatar = a; })),
      h('div', { class: 'row' },
        h('button', { class: 'btn-small', onclick: async () => {
          state.profile.name = name.value.trim() || state.profile.name; save();
          try {
            user = await API.call('/profile', { method: 'PUT', body: { display_name: state.profile.name, gender: state.profile.gender, avatar: state.profile.avatar } });
            localStorage.setItem('kria.user', JSON.stringify(user)); toast('נשמר ✓');
          } catch (e) { toast(e.message); }
        } }, 'שמירת פרופיל'),
        h('button', { class: 'btn-small btn-ghost', onclick: () => location.hash = '#/password' }, '🔐 החלפת סיסמה'))),
    h('div', { class: 'card stack' }, h('h3', {}, '🔊 קול'),
      h('div', { class: 'field' }, h('label', {}, 'קול עברי'), voiceSel),
      h('div', { class: 'field' }, h('label', {}, 'מהירות הקראה'), seg([[0.6, 'איטי מאוד'], [0.75, 'איטי'], [0.85, 'רגיל-איטי'], [1, 'רגיל']], state.settings.rate, v => { state.settings.rate = v; save(); })),
      h('div', { class: 'field' }, h('label', {}, 'לשלוח ניקוד למנוע הקול'), seg([[true, 'כן'], [false, 'לא']], state.settings.ttsNikud, v => { state.settings.ttsNikud = v; save(); })),
      h('p', { class: 'muted' }, 'אם הקול הממוחשב מבטא מילים לא נכון, נסו לשנות את האפשרות הזאת, או הקליטו את עצמכם (בלשונית טקסטים).'),
      h('button', { class: 'btn-small btn-blue', onclick: () => say('שָׁלוֹם! אֲנִי יַנְשׁוּפִי, וַאֲנִי אוֹהֵב לִקְרוֹא סִיפּוּרִים.') }, '▶ בדיקת קול')),
    h('div', { class: 'card stack' }, h('h3', {}, '🎯 מטרות והקלטה'),
      h('div', { class: 'field' }, h('label', {}, 'ימי תרגול בשבוע (מטרה)'), seg([[3, '3'], [4, '4'], [5, '5'], [6, '6']], state.weeklyGoal, v => { state.weeklyGoal = v; save(); })),
      h('div', { class: 'field' }, h('label', {}, 'הקלטת הילד/ה בקריאה לבד'), seg([[true, 'פעיל'], [false, 'כבוי']], state.settings.record, v => { state.settings.record = v; save(); })),
      h('p', { class: 'muted' }, 'תצוגה (גודל אותיות, רווחים, ניקוד) — בכפתור "Aa תצוגה" במסך הבית.')),
    h('div', { class: 'card stack' }, h('h3', {}, '💾 גיבוי'),
      h('p', { class: 'muted' }, 'ההתקדמות נשמרת בחשבון ומסתנכרנת בין מכשירים. ההקלטות נשמרות רק במכשיר שבו הוקלטו. אפשר גם להוריד קובץ גיבוי.'),
      h('div', { class: 'row' },
        h('button', { class: 'btn-small', onclick: () => {
          const a = h('a', { href: URL.createObjectURL(new Blob([JSON.stringify(state, null, 1)], { type: 'application/json' })), download: `kria-backup-${todayKey()}.json` });
          document.body.append(a); a.click(); a.remove();
        } }, '⬇️ הורדת גיבוי'),
        h('label', { class: 'btn btn-small btn-ghost', style: 'margin:0' }, '⬆️ שחזור מגיבוי',
          h('input', { type: 'file', accept: 'application/json', class: 'hidden', onchange: async e => {
            try { const s = JSON.parse(await e.target.files[0].text()); if (!s.profile) throw 0; state = normalize(s); save(); applySettings(); toast('שוחזר ✓'); render(); }
            catch { toast('הקובץ לא תקין'); }
          } })))),
    h('button', { class: 'btn-ghost btn-small', style: 'color:var(--orange)', onclick: () => {
      if (!confirm('לאפס את כל ההתקדמות (כוכבים, קריאות, כתיבה)? ההגדרות והטקסטים שהוספתם יישארו.')) return;
      Object.assign(state, { stars: 0, stickers: [], days: {}, reads: {}, games: {}, dict: [], stories: [], answers: [] }); save(); toast('אופס'); render();
    } }, 'איפוס התקדמות'));
}

/* ================= share / invite (same as LinguaDov) ================= */
const shareUrl = () => `${location.origin}/#/register`;
const defaultShareText = () =>
  '🦉 בואו לקרוא ב"קוראים בכיף"! 📖\nתרגול קריאה וכתיבה בעברית לילדים בכיתות ג–ו — ינשופי מקריא, משחקי מילים וסיפורים, בלי לחץ. בחינם.\nנרשמים כאן:';
function shareApp() {
  const url = shareUrl();
  const ta = h('textarea', { class: 'share-text', rows: 4, dir: 'rtl' });
  ta.value = defaultShareText();
  const text = () => ta.value.trim();
  const full = () => `${text()}\n${url}`;
  const open = u => window.open(u, '_blank', 'noopener');
  const close = () => ov.remove();
  const btn = (cls, emo, label, fn) => h('button', { type: 'button', class: `share-btn ${cls}`, onclick: fn }, h('span', {}, emo), label);
  const ov = h('div', { class: 'overlay', onclick: e => { if (e.target === ov) close(); } },
    h('div', { class: 'pop stack', style: 'text-align:right;max-width:440px' },
      h('h2', {}, '📤 שיתוף "קוראים בכיף"'),
      h('p', { class: 'muted', style: 'margin:0' }, 'ההודעה שתישלח (אפשר לערוך):'),
      ta,
      h('div', { class: 'share-link', dir: 'ltr' }, url),
      h('div', { class: 'share-grid' },
        navigator.share ? btn('native', '📲', 'כל אפשרויות השיתוף', async () => { try { await navigator.share({ title: 'קוראים בכיף', text: text(), url }); } catch { } }) : null,
        btn('wa', '💬', 'WhatsApp', () => open(`https://wa.me/?text=${encodeURIComponent(full())}`)),
        btn('tg', '✈️', 'Telegram', () => open(`https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text())}`)),
        btn('mail', '✉️', 'אימייל', () => { location.href = `mailto:?subject=${encodeURIComponent('בואו לקרוא ב"קוראים בכיף" 🦉')}&body=${encodeURIComponent(full())}`; }),
        btn('copy', '📋', 'העתקת קישור', async () => {
          try { await navigator.clipboard.writeText(full()); toast('הקישור וההודעה הועתקו ✅'); } catch { toast('לא הצלחנו להעתיק – סמנו והעתיקו ידנית'); }
        })),
      siteConfig.registration ? null : h('div', { class: 'tip' }, '⚠️ ההרשמה סגורה כרגע – מי שיקבל את הקישור לא יוכל להירשם. אפשר לפתוח אותה בדף הניהול.'),
      siteConfig.approval ? h('p', { class: 'muted', style: 'margin:0' }, 'שימו לב: אישור מנהל פעיל – תצטרכו לאשר כל מי שנרשם.') : null,
      h('button', { class: 'btn-ghost btn-full', onclick: close }, 'סגירה')));
  document.body.append(ov);
}

/* ================= admin ================= */
const fmtDate = t => t ? new Date(t).toLocaleDateString('he-IL') : '—';
routes.admin = (sub, id) => {
  if (!isAdmin()) { location.hash = '#/home'; return null; }
  const body = h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'טוען...'));
  const wrap = h('div', { class: 'stack' }, topbar(sub === 'user' ? '🛡️ ניהול · התקדמות' : '🛡️ ניהול משתמשים', sub === 'user' ? '#/admin' : '#/home'), body);
  (sub === 'user' ? adminUser(body, Number(id)) : adminList(body)).catch(e => body.replaceChildren(h('div', { class: 'tip' }, '⚠️ ', e.message)));
  return wrap;
};

async function adminList(body) {
  const [{ users, me }, settings] = await Promise.all([API.call('/admin/users'), API.call('/admin/settings')]);
  const act = async (fn, okMsg) => { try { await fn(); if (okMsg) toast(okMsg); render(); } catch (e) { toast(e.message); } };
  const patch = (u, b, msg) => act(() => API.call(`/admin/users/${u.id}`, { method: 'PATCH', body: b }), msg);

  // create user
  const nu = { gender: 'm', role: 'student' };
  const nName = h('input', { type: 'text', placeholder: 'שם (בעברית)' });
  const nUser = h('input', { type: 'text', placeholder: 'שם משתמש (באנגלית)', dir: 'ltr', style: 'text-align:right', autocapitalize: 'none' });
  const nPw = h('input', { type: 'text', placeholder: 'סיסמה (לפחות 6 תווים)', dir: 'ltr', style: 'text-align:right' });
  const err = errBox();
  siteConfig = { ...siteConfig, ...settings };

  body.replaceChildren(h('div', { class: 'stack' },
    h('div', { class: 'row' },
      h('button', { class: 'btn-big grow share-main', onclick: shareApp }, '📤 שיתוף האפליקציה'),
      h('button', { class: 'btn-big btn-ghost grow', onclick: () => document.getElementById('add-user')?.scrollIntoView({ behavior: 'smooth' }) }, '➕ משתמש חדש')),
    h('div', { class: 'stats' },
      h('div', { class: 'stat' }, h('b', {}, users.length), 'משתמשים'),
      h('div', { class: 'stat' }, h('b', {}, users.filter(u => u.last_day === todayKey()).length), 'תרגלו היום'),
      h('div', { class: 'stat' }, h('b', {}, users.reduce((a, u) => a + u.reads, 0)), 'קריאות'),
      h('div', { class: 'stat' }, h('b', {}, users.reduce((a, u) => a + u.minutes, 0)), 'דקות')),
    h('div', { class: 'card stack' }, h('h3', {}, '⚙️ הגדרות'),
      h('div', { class: 'field' }, h('label', {}, 'הרשמה עצמית במסך הכניסה'),
        seg([[true, 'פתוחה'], [false, 'סגורה']], settings.registration, v => act(() => API.call('/admin/settings', { method: 'PUT', body: { registration: v } }), 'נשמר ✓'))),
      h('div', { class: 'field' }, h('label', {}, 'משתמש חדש צריך אישור מנהל'),
        seg([[false, 'לא'], [true, 'כן']], settings.approval, v => act(() => API.call('/admin/settings', { method: 'PUT', body: { approval: v } }), 'נשמר ✓')))),
    users.some(u => u.approved === 0) ? h('div', { class: 'tip' }, `⏳ ${users.filter(u => u.approved === 0).length} משתמשים ממתינים לאישור`) : null,
    h('div', { class: 'card stack' }, h('h3', {}, '👥 משתמשים'),
      users.map(u => h('div', { class: 'card stack', style: 'background:var(--bg);box-shadow:none' + (u.blocked ? ';opacity:.6' : '') },
        h('div', { class: 'row between' },
          h('div', { class: 'row' }, h('span', { style: 'font-size:32px' }, u.avatar),
            h('div', {}, h('b', {}, u.display_name), u.role === 'admin' ? ' 🛡️' : '', u.blocked ? ' 🚫' : '', u.approved === 0 ? ' ⏳ ממתין לאישור' : '',
              h('div', { class: 'muted', dir: 'ltr', style: 'text-align:right' }, u.username))),
          h('button', { class: 'btn-small', onclick: () => location.hash = `#/admin/user/${u.id}` }, '📈 התקדמות')),
        h('div', { class: 'muted' }, `⭐ ${u.stars} · 📖 ${u.reads} קריאות · ☀️ ${u.days} ימים · ⏱️ ${u.minutes} דק׳ · 📕 ${u.stories} סיפורים`),
        h('div', { class: 'muted' }, `נרשם: ${fmtDate(u.created_at)} · פעיל לאחרונה: ${fmtDate(u.last_active)}`),
        u.id === me ? h('div', { class: 'muted' }, '(זה המשתמש שלך)') : h('div', { class: 'row' },
          u.approved === 0 ? h('button', { class: 'btn-small btn-green', onclick: () => patch(u, { approved: true }, 'אושר ✓') }, '✓ אישור') : null,
          h('button', { class: 'btn-small btn-ghost', onclick: () => {
            const p = prompt(`סיסמה חדשה ל-${u.username} (לפחות 6 תווים):`); if (p) patch(u, { password: p }, 'הסיסמה עודכנה ✓');
          } }, '🔑 סיסמה'),
          h('button', { class: 'btn-small btn-ghost', onclick: () => patch(u, { role: u.role === 'admin' ? 'student' : 'admin' }, 'עודכן ✓') }, u.role === 'admin' ? 'להפוך לתלמיד' : 'להפוך למנהל'),
          h('button', { class: 'btn-small btn-ghost', onclick: () => patch(u, { blocked: !u.blocked }, 'עודכן ✓') }, u.blocked ? 'ביטול חסימה' : '🚫 חסימה'),
          h('button', { class: 'btn-small btn-ghost', style: 'color:var(--orange)', onclick: () => {
            if (confirm(`למחוק את ${u.display_name} (${u.username}) וכל ההתקדמות שלו/ה? אי אפשר לבטל.`)) act(() => API.call(`/admin/users/${u.id}`, { method: 'DELETE' }), 'נמחק');
          } }, '🗑 מחיקה'))))),
    h('div', { class: 'card stack', id: 'add-user' }, h('h3', {}, '➕ הוספת משתמש'),
      nName, nUser, nPw,
      seg([['m', 'בן'], ['f', 'בת']], nu.gender, v => { nu.gender = v; }),
      seg([['student', 'תלמיד/ה'], ['admin', 'מנהל/ת']], nu.role, v => { nu.role = v; }),
      err,
      h('button', { class: 'btn-green', onclick: async () => {
        try {
          await API.call('/admin/users', { method: 'POST', body: { display_name: nName.value.trim(), username: nUser.value.trim(), password: nPw.value, gender: nu.gender, role: nu.role } });
          toast('המשתמש נוסף ✓'); render();
        } catch (e) { showErr(err, e.message); }
      } }, 'הוספה'))));
}

async function adminUser(body, id) {
  const [{ users }, { data }] = await Promise.all([API.call('/admin/users'), API.call(`/admin/users/${id}/progress`)]);
  const u = users.find(x => x.id === id);
  if (!u) throw new Error('המשתמש לא נמצא');
  body.replaceChildren(h('div', { class: 'row' }, h('span', { style: 'font-size:40px' }, u.avatar), h('h2', { style: 'margin:0' }, u.display_name)));
  if (!data) { body.append(h('p', {}, 'עוד אין התקדמות למשתמש הזה.')); return; }
  const st = normalize(data);
  pProgress(body, st);
  if (st.answers.length || st.stories.length) {
    body.append(h('h3', {}, '✏️ כתיבה'));
    [...st.answers.map(a => ({ ...a, kind: `תגובה ל"${a.title}"` })), ...st.stories.map(s => ({ ...s, kind: `סיפור: ${s.title}` }))]
      .sort((a, b) => b.d - a.d).forEach(it => body.append(h('div', { class: 'card stack' },
        h('div', { class: 'row between' }, h('b', {}, it.kind), h('span', { class: 'muted' }, fmtDate(it.d))),
        h('div', { style: 'font-family:var(--read);font-size:19px;white-space:pre-wrap;line-height:1.9' }, it.text))));
  }
}

/* ================= boot ================= */
async function boot() {
  TTS.init();
  app.replaceChildren(h('div', { class: 'center muted', style: 'padding:60px' }, 'טוען... ⏳'));
  await loadConfig();
  try { user = await API.call('/me'); }
  catch (e) { user = e.status === 0 || e.status >= 500 ? readLocal('kria.user') : null; } // offline: keep the last login
  if (user) { try { localStorage.setItem('kria.user', JSON.stringify(user)); } catch { } }
  else { try { localStorage.removeItem('kria.user'); } catch { } }
  if (user && !user.must_change) await loadUserState();
  applySettings();
  await loadModels();
  render();
}
boot();
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(e => console.warn('SW', e));
}
