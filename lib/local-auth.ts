import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { InputError } from './task-engine.ts';
import { ProviderError } from './providers.ts';

export type LocalUser = { id: string; email: string; name: string; avatar: string | null; role: 'admin' | 'member' };
const TTL_SECONDS = 30 * 24 * 60 * 60;
export const authCookie = (token: string) => `actiondesk_auth=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${token ? TTL_SECONDS : 0}`;
export function cookieValue(header: string | undefined, name: string) {
  return header?.split(';').map(v => v.trim()).find(v => v.startsWith(`${name}=`))?.slice(name.length + 1) ?? '';
}
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
const publicUser = (row: Record<string, any>): LocalUser => ({ id: row.id, email: row.email, name: row.name, avatar: row.avatar, role: row.role });
function credentials(raw: unknown) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new InputError('請提供電子郵件與密碼。');
  const body = raw as Record<string, unknown>;
  if (typeof body.email !== 'string' || body.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim())) throw new InputError('請填寫有效的電子郵件。');
  if (typeof body.password !== 'string' || body.password.length < 10 || body.password.length > 128) throw new InputError('密碼須為 10–128 字元。');
  return { email: body.email.trim().toLowerCase(), password: body.password, body };
}
function nameOf(value: unknown) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80 || /[\u0000-\u001F\u007F]/.test(value)) throw new InputError('顯示名稱須為 1–80 字元。');
  return value.trim();
}
function avatarOf(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !value || value.length > 100000) throw new InputError('頭像須為表情符號或小於 100KB 的 PNG、JPEG、WebP 圖片。');
  if (/^preset:[0-9]$/.test(value)) return value;
  if (value.length <= 32 && /^[\p{Extended_Pictographic}\p{Emoji_Component}\u200D\uFE0F]+$/u.test(value)) return value;
  const match = value.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) throw new InputError('頭像僅支援表情符號與 PNG、JPEG、WebP 圖片，不接受外部網址或 SVG。');
  const bytes = Buffer.from(match[2], 'base64');
  const valid = bytes.toString('base64') === match[2] && (match[1] === 'png' ? bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    : match[1] === 'jpeg' ? bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))
      : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP');
  if (!valid) throw new InputError('頭像圖片格式無效。');
  return value;
}

/** Persistent local accounts; only password hashes and hashed session tokens are stored. */
export function localAuth(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS local_users (
    id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,name TEXT NOT NULL,avatar TEXT,
    role TEXT NOT NULL CHECK(role IN ('admin','member')),password_salt TEXT NOT NULL,password_hash TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS local_sessions (token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,expires_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS local_sessions_user ON local_sessions(user_id);`);
  function issue(user: LocalUser) {
    const token = randomBytes(32).toString('hex');
    db.prepare('DELETE FROM local_sessions WHERE expires_at <= ?').run(Date.now());
    db.prepare('INSERT INTO local_sessions(token_hash,user_id,expires_at) VALUES (?,?,?)').run(tokenHash(token), user.id, Date.now() + TTL_SECONDS * 1000);
    return { user, token };
  }
  function logout(token: string) { if (/^[a-f0-9]{64}$/.test(token)) db.prepare('DELETE FROM local_sessions WHERE token_hash=?').run(tokenHash(token)); }
  function lookup(token: string): LocalUser | null {
    if (!/^[a-f0-9]{64}$/.test(token)) return null;
    const row = db.prepare('SELECT u.* FROM local_users u JOIN local_sessions s ON s.user_id=u.id WHERE s.token_hash=? AND s.expires_at>?').get(tokenHash(token), Date.now());
    return row ? publicUser(row) : null;
  }
  return {
    lookup, logout,
    register(raw: unknown) {
      const { email, password, body } = credentials(raw), name = nameOf(body.name);
      const salt = randomBytes(16).toString('hex'), hash = scryptSync(password, salt, 64).toString('hex'), id = randomUUID();
      let role: LocalUser['role'];
      db.exec('BEGIN IMMEDIATE');
      try {
        if (db.prepare('SELECT id FROM local_users WHERE email=?').get(email)) throw new ProviderError('此電子郵件已註冊，請登入。', 409);
        role = db.prepare('SELECT id FROM local_users LIMIT 1').get() ? 'member' : 'admin';
        db.prepare('INSERT INTO local_users(id,email,name,avatar,role,password_salt,password_hash,created_at) VALUES (?,?,?,NULL,?,?,?,?)').run(id, email, name, role, salt, hash, Date.now());
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      return issue({ id, email, name, avatar: null, role });
    },
    login(raw: unknown) {
      const { email, password } = credentials(raw);
      const row = db.prepare('SELECT * FROM local_users WHERE email=?').get(email);
      const hash = scryptSync(password, typeof row?.password_salt === 'string' ? row.password_salt : 'missing-account-fixed-salt', 64);
      const expected = typeof row?.password_hash === 'string' ? Buffer.from(row.password_hash, 'hex') : Buffer.alloc(64);
      if (!row || expected.length !== hash.length || !timingSafeEqual(hash, expected)) throw new ProviderError('電子郵件或密碼不正確。', 401);
      return issue(publicUser(row));
    },
    profile(user: LocalUser, raw: unknown) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new InputError('請提供顯示名稱與頭像。');
      const body = raw as Record<string, unknown>;
      const name = Object.hasOwn(body, 'name') ? nameOf(body.name) : user.name;
      const avatar = Object.hasOwn(body, 'avatar') ? avatarOf(body.avatar) : user.avatar;
      db.prepare('UPDATE local_users SET name=?,avatar=? WHERE id=?').run(name, avatar, user.id);
      return { ...user, name, avatar };
    },
  };
}
