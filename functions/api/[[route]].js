// ===== קוראים בכיף – שרת ה-API (Cloudflare Pages Functions + D1) =====
// כניסה, הרשמה, סנכרון התקדמות וניהול משתמשים. סיסמאות נשמרות כ-PBKDF2 עם salt.
const SESSION_DAYS = 365;
const ROLES = ["admin", "student"];
const MAX_FAILS = 5;
const LOCK_MS = 10 * 60 * 1000;
const PBKDF2_ITER = 100000;

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
const fail = (msg, status = 400) => json({ error: msg }, status);

// ---------- הצפנה ----------
const enc = new TextEncoder();
const toHex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (h) => new Uint8Array(h.match(/../g).map((x) => parseInt(x, 16)));
async function hashPassword(password, saltHex) {
  const salt = saltHex ? fromHex(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITER }, key, 256);
  return { hash: toHex(bits), salt: toHex(salt) };
}
const sha256 = async (s) => toHex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
const randomToken = () => toHex(crypto.getRandomValues(new Uint8Array(32)));

// ---------- מסד נתונים ----------
let ready = false;
async function init(env) {
  if (ready) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      display_name TEXT NOT NULL,
      gender TEXT NOT NULL DEFAULT 'm',
      avatar TEXT NOT NULL DEFAULT '🦊',
      pass_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'student',
      blocked INTEGER NOT NULL DEFAULT 0,
      must_change INTEGER NOT NULL DEFAULT 0,
      failed INTEGER NOT NULL DEFAULT 0,
      locked_until INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      last_active INTEGER
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at INTEGER NOT NULL
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS progress (
      user_id INTEGER PRIMARY KEY,
      data TEXT NOT NULL,
      stars INTEGER NOT NULL DEFAULT 0,
      reads INTEGER NOT NULL DEFAULT 0,
      days INTEGER NOT NULL DEFAULT 0,
      minutes INTEGER NOT NULL DEFAULT 0,
      stories INTEGER NOT NULL DEFAULT 0,
      last_day TEXT,
      updated_at INTEGER NOT NULL
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS reg_log (ip TEXT NOT NULL, ts INTEGER NOT NULL)`),
  ]);
  // משתמש שנרשם בעצמו ממתין לאישור מנהל (כשהאפשרות פעילה). משתמשים קיימים מאושרים.
  const cols = (await env.DB.prepare("PRAGMA table_info(users)").all()).results.map((c) => c.name);
  if (!cols.includes("approved")) {
    try { await env.DB.prepare("ALTER TABLE users ADD COLUMN approved INTEGER NOT NULL DEFAULT 1").run(); } catch {}
  }
  // מנהל ראשוני: admin / admin — חובה להחליף סיסמה בכניסה הראשונה (האתר ציבורי)
  const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").first();
  if (n === 0) {
    const { hash, salt } = await hashPassword("admin");
    await env.DB.prepare(
      "INSERT OR IGNORE INTO users (username, display_name, avatar, pass_hash, salt, role, must_change, created_at) VALUES ('admin', 'מנהל', '🦉', ?, ?, 'admin', 1, ?)"
    ).bind(hash, salt, Date.now()).run();
  }
  ready = true;
}

const DEFAULT_SETTINGS = { registration: true, approval: false };
async function getSettings(env) {
  const { results } = await env.DB.prepare("SELECT key, value FROM settings").all();
  const out = { ...DEFAULT_SETTINGS };
  for (const r of results) if (r.key in out) out[r.key] = r.value === "1";
  return out;
}

function getCookie(request, name) {
  const m = (request.headers.get("cookie") || "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? m[1] : null;
}
function sessionCookie(token, request, maxAge) {
  const secure = new URL(request.url).protocol === "https:" ? " Secure;" : "";
  return `sid=${token}; Path=/; HttpOnly;${secure} SameSite=Lax${maxAge === null ? "" : `; Max-Age=${maxAge}`}`;
}
async function startSession(env, request, user, remember = true) {
  const token = randomToken();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
      .bind(await sha256(token), user.id, now + (remember ? SESSION_DAYS : 1) * 86400000),
    env.DB.prepare("UPDATE users SET failed = 0, locked_until = 0, last_active = ? WHERE id = ?").bind(now, user.id),
    env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now),
  ]);
  return json(publicUser(user), 200, { "set-cookie": sessionCookie(token, request, remember ? SESSION_DAYS * 86400 : null) });
}
async function currentUser(env, request) {
  const sid = getCookie(request, "sid");
  if (!sid) return null;
  const user = await env.DB.prepare(
    "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?"
  ).bind(await sha256(sid), Date.now()).first();
  return !user || user.blocked || user.approved === 0 ? null : user;
}
const publicUser = (u) => ({
  id: u.id, username: u.username, display_name: u.display_name, gender: u.gender, avatar: u.avatar,
  role: u.role, must_change: !!u.must_change,
});
async function readBody(request) {
  try { return await request.json(); } catch { return {}; }
}

const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,30}$/;
const USERNAME_ERR = "שם משתמש: 3–30 תווים באנגלית או ספרות (אפשר גם נקודה, מקף, קו תחתון)";
const validPassword = (p, username) => {
  if (typeof p !== "string" || p.length < 6) return "הסיסמה חייבת להכיל לפחות 6 תווים";
  if (p.length > 100) return "הסיסמה ארוכה מדי";
  if (p.toLowerCase() === "admin" || p.toLowerCase() === String(username).toLowerCase()) return "בחרו סיסמה אחרת – זו קלה מדי לניחוש";
  return null;
};
const cleanGender = (g) => (g === "f" ? "f" : "m");
const cleanAvatar = (a) => (typeof a === "string" && a.length <= 8 && a.trim() ? a.trim() : "🦊");

// סיכום התקדמות לטבלת המנהל (מתוך מצב האפליקציה של הילד)
const num = (x) => (Number.isFinite(x) ? Math.max(0, Math.floor(x)) : 0);
function summarize(d) {
  const days = d && typeof d.days === "object" ? d.days : {};
  const active = Object.entries(days).filter(([, v]) => v && v.acts > 0).map(([k]) => k).sort();
  return {
    stars: num(d?.stars),
    reads: Object.values(d?.reads || {}).reduce((a, r) => a + (Array.isArray(r) ? r.length : 0), 0),
    days: active.length,
    minutes: Math.round(Object.values(days).reduce((a, v) => a + (Number(v?.mins) || 0), 0)),
    stories: Array.isArray(d?.stories) ? d.stories.length : 0,
    last_day: active.length ? active[active.length - 1] : null,
  };
}

// ---------- ניתוב ----------
export async function onRequest(context) {
  const { request, env, params } = context;
  if (!env.DB) return fail("מסד הנתונים לא מחובר (DB binding חסר)", 500);
  try {
    await init(env);
    const path = "/" + [].concat(params.route || []).join("/");
    const method = request.method;

    if (path === "/login" && method === "POST") {
      const { username = "", password = "", remember = true } = await readBody(request);
      const user = await env.DB.prepare("SELECT * FROM users WHERE username = ?").bind(String(username).trim()).first();
      if (!user) { await hashPassword(String(password)); return fail("שם משתמש או סיסמה לא נכונים", 401); }
      if (user.locked_until > Date.now()) return fail("יותר מדי ניסיונות. נסו שוב בעוד כמה דקות.", 429);
      const { hash } = await hashPassword(String(password), user.salt);
      if (!safeEqual(hash, user.pass_hash)) {
        const failed = user.failed + 1;
        await env.DB.prepare("UPDATE users SET failed = ?, locked_until = ? WHERE id = ?")
          .bind(failed >= MAX_FAILS ? 0 : failed, failed >= MAX_FAILS ? Date.now() + LOCK_MS : 0, user.id).run();
        return fail("שם משתמש או סיסמה לא נכונים", 401);
      }
      if (user.blocked) return fail("המשתמש חסום. פנו למנהל.", 403);
      if (user.approved === 0) return fail("המשתמש עוד ממתין לאישור המנהל. נסו שוב מאוחר יותר.", 403);
      return startSession(env, request, user, remember !== false);
    }

    if (path === "/config" && method === "GET") {
      const st = await getSettings(env);
      return json({ registration: st.registration, approval: st.approval });
    }

    if (path === "/register" && method === "POST") {
      const st = await getSettings(env);
      if (!st.registration) return fail("ההרשמה סגורה כרגע. בקשו מהמנהל לפתוח לכם משתמש.", 403);
      const ip = request.headers.get("cf-connecting-ip") || "local";
      const hourAgo = Date.now() - 3600000;
      const { n: recent } = await env.DB.prepare("SELECT COUNT(*) AS n FROM reg_log WHERE ip = ? AND ts > ?").bind(ip, hourAgo).first();
      if (recent >= 5) return fail("יותר מדי הרשמות מהחיבור הזה. נסו שוב בעוד שעה.", 429);
      const b = await readBody(request);
      const username = String(b.username || "").trim();
      const display = String(b.display_name || "").trim();
      if (!display) return fail("כתבו את השם שלכם");
      if (display.length > 30) return fail("השם ארוך מדי");
      if (!USERNAME_RE.test(username)) return fail(USERNAME_ERR);
      const bad = validPassword(b.password, username);
      if (bad) return fail(bad);
      if (await env.DB.prepare("SELECT id FROM users WHERE username = ?").bind(username).first()) return fail("שם המשתמש הזה כבר תפוס – בחרו שם אחר");
      const h = await hashPassword(b.password);
      const now = Date.now();
      await env.DB.batch([
        env.DB.prepare("INSERT INTO users (username, display_name, gender, avatar, pass_hash, salt, role, approved, created_at) VALUES (?, ?, ?, ?, ?, ?, 'student', ?, ?)")
          .bind(username, display, cleanGender(b.gender), cleanAvatar(b.avatar), h.hash, h.salt, st.approval ? 0 : 1, now),
        env.DB.prepare("INSERT INTO reg_log (ip, ts) VALUES (?, ?)").bind(ip, now),
        env.DB.prepare("DELETE FROM reg_log WHERE ts < ?").bind(hourAgo),
      ]);
      if (st.approval) return json({ pending: true }, 201);
      const user = await env.DB.prepare("SELECT * FROM users WHERE username = ?").bind(username).first();
      return startSession(env, request, user);
    }

    if (path === "/logout" && method === "POST") {
      const sid = getCookie(request, "sid");
      if (sid) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(sid)).run();
      return json({ ok: true }, 200, { "set-cookie": sessionCookie("", request, 0) });
    }

    // ----- מכאן – רק משתמשים מחוברים -----
    const me = await currentUser(env, request);
    if (!me) return fail("יש להתחבר", 401);

    if (path === "/me" && method === "GET") {
      await env.DB.prepare("UPDATE users SET last_active = ? WHERE id = ?").bind(Date.now(), me.id).run();
      return json(publicUser(me));
    }

    if (path === "/password" && method === "POST") {
      const { current = "", next = "" } = await readBody(request);
      const { hash } = await hashPassword(String(current), me.salt);
      if (!safeEqual(hash, me.pass_hash)) return fail("הסיסמה הנוכחית לא נכונה");
      const bad = validPassword(next, me.username);
      if (bad) return fail(bad);
      const h = await hashPassword(next);
      const sid = await sha256(getCookie(request, "sid"));
      await env.DB.batch([
        env.DB.prepare("UPDATE users SET pass_hash = ?, salt = ?, must_change = 0 WHERE id = ?").bind(h.hash, h.salt, me.id),
        env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?").bind(me.id, sid),
      ]);
      return json({ ok: true });
    }

    if (me.must_change) return fail("יש להחליף סיסמה קודם", 403);

    if (path === "/profile" && method === "PUT") {
      const b = await readBody(request);
      const d = String(b.display_name || me.display_name).trim();
      if (!d || d.length > 30) return fail("שם לא תקין");
      await env.DB.prepare("UPDATE users SET display_name = ?, gender = ?, avatar = ? WHERE id = ?")
        .bind(d, cleanGender(b.gender ?? me.gender), cleanAvatar(b.avatar ?? me.avatar), me.id).run();
      return json(publicUser({ ...me, display_name: d, gender: cleanGender(b.gender ?? me.gender), avatar: cleanAvatar(b.avatar ?? me.avatar) }));
    }

    if (path === "/progress" && method === "GET") {
      const row = await env.DB.prepare("SELECT data, updated_at FROM progress WHERE user_id = ?").bind(me.id).first();
      return json({ data: row ? JSON.parse(row.data) : null, updated_at: row?.updated_at || 0 });
    }

    if (path === "/progress" && method === "PUT") {
      const text = await request.text();
      if (text.length > 500000) return fail("הנתונים גדולים מדי", 413);
      let data;
      try { data = JSON.parse(text).data; } catch { return fail("נתונים לא תקינים"); }
      if (!data || typeof data !== "object") return fail("נתונים לא תקינים");
      const s = summarize(data);
      const now = Date.now();
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO progress (user_id, data, stars, reads, days, minutes, stories, last_day, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, stars = excluded.stars, reads = excluded.reads, days = excluded.days,
          minutes = excluded.minutes, stories = excluded.stories, last_day = excluded.last_day, updated_at = excluded.updated_at`)
          .bind(me.id, JSON.stringify(data), s.stars, s.reads, s.days, s.minutes, s.stories, s.last_day, now),
        env.DB.prepare("UPDATE users SET last_active = ? WHERE id = ?").bind(now, me.id),
      ]);
      return json({ ok: true, updated_at: now });
    }

    // ----- ניהול (מנהלים בלבד) -----
    if (path.startsWith("/admin/")) {
      if (me.role !== "admin") return fail("אין לכם הרשאה לדף הזה", 403);

      if (path === "/admin/users" && method === "GET") {
        const { results } = await env.DB.prepare(`
          SELECT u.id, u.username, u.display_name, u.gender, u.avatar, u.role, u.blocked, u.must_change, u.approved, u.created_at, u.last_active,
                 COALESCE(p.stars,0) AS stars, COALESCE(p.reads,0) AS reads, COALESCE(p.days,0) AS days,
                 COALESCE(p.minutes,0) AS minutes, COALESCE(p.stories,0) AS stories, p.last_day
          FROM users u LEFT JOIN progress p ON p.user_id = u.id ORDER BY u.created_at`).all();
        return json({ users: results, me: me.id });
      }

      const det = path.match(/^\/admin\/users\/(\d+)\/progress$/);
      if (det && method === "GET") {
        const row = await env.DB.prepare("SELECT data FROM progress WHERE user_id = ?").bind(Number(det[1])).first();
        return json({ data: row ? JSON.parse(row.data) : null });
      }

      if (path === "/admin/settings" && method === "GET") return json(await getSettings(env));
      if (path === "/admin/settings" && method === "PUT") {
        const b = await readBody(request);
        const stmts = [];
        for (const k of Object.keys(DEFAULT_SETTINGS)) {
          if (typeof b[k] === "boolean")
            stmts.push(env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(k, b[k] ? "1" : "0"));
        }
        if (!stmts.length) return fail("אין מה לעדכן");
        await env.DB.batch(stmts);
        return json(await getSettings(env));
      }

      if (path === "/admin/users" && method === "POST") {
        const b = await readBody(request);
        const username = String(b.username || "").trim();
        const display = String(b.display_name || "").trim() || username;
        const role = ROLES.includes(b.role) ? b.role : "student";
        if (!USERNAME_RE.test(username)) return fail(USERNAME_ERR);
        if (display.length > 30) return fail("השם ארוך מדי");
        const bad = validPassword(b.password, username);
        if (bad) return fail(bad);
        if (await env.DB.prepare("SELECT id FROM users WHERE username = ?").bind(username).first()) return fail("שם המשתמש הזה כבר קיים");
        const h = await hashPassword(b.password);
        await env.DB.prepare("INSERT INTO users (username, display_name, gender, pass_hash, salt, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .bind(username, display, cleanGender(b.gender), h.hash, h.salt, role, Date.now()).run();
        return json({ ok: true }, 201);
      }

      const m = path.match(/^\/admin\/users\/(\d+)$/);
      if (m) {
        const id = Number(m[1]);
        const target = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first();
        if (!target) return fail("המשתמש לא נמצא", 404);
        if (method === "DELETE") {
          if (id === me.id) return fail("אי אפשר למחוק את המשתמש של עצמכם");
          await env.DB.batch([
            env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(id),
            env.DB.prepare("DELETE FROM progress WHERE user_id = ?").bind(id),
            env.DB.prepare("DELETE FROM users WHERE id = ?").bind(id),
          ]);
          return json({ ok: true });
        }
        if (method === "PATCH") {
          const b = await readBody(request);
          const stmts = [];
          if (b.role !== undefined) {
            if (!ROLES.includes(b.role)) return fail("תפקיד לא תקין");
            if (id === me.id) return fail("אי אפשר לשנות את התפקיד של עצמכם");
            stmts.push(env.DB.prepare("UPDATE users SET role = ? WHERE id = ?").bind(b.role, id));
          }
          if (b.blocked !== undefined) {
            if (id === me.id) return fail("אי אפשר לחסום את עצמכם");
            stmts.push(env.DB.prepare("UPDATE users SET blocked = ? WHERE id = ?").bind(b.blocked ? 1 : 0, id));
            if (b.blocked) stmts.push(env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(id));
          }
          if (b.password !== undefined) {
            const bad = validPassword(b.password, target.username);
            if (bad) return fail(bad);
            const h = await hashPassword(b.password);
            // סיסמה שהמנהל קבע – הילד יכול להמשיך איתה (לילדים קטנים החלפה כפויה מבלבלת)
            stmts.push(env.DB.prepare("UPDATE users SET pass_hash = ?, salt = ?, failed = 0, locked_until = 0 WHERE id = ?").bind(h.hash, h.salt, id));
            stmts.push(env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(id));
          }
          if (b.approved === true) stmts.push(env.DB.prepare("UPDATE users SET approved = 1 WHERE id = ?").bind(id));
          if (b.reset_progress) stmts.push(env.DB.prepare("DELETE FROM progress WHERE user_id = ?").bind(id));
          if (!stmts.length) return fail("אין מה לעדכן");
          await env.DB.batch(stmts);
          return json({ ok: true });
        }
      }
    }

    return fail("לא נמצא", 404);
  } catch (e) {
    return fail("שגיאת שרת: " + (e && e.message ? e.message : e), 500);
  }
}
