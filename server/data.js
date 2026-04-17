/**
 * Persistencia en Supabase (PostgreSQL).
 * Requiere: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (solo servidor; nunca en el cliente).
 * Tokens de recuperación de contraseña: supabase/migrations/002_email_verify_and_tokens.sql
 */
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = String(process.env.SUPABASE_URL || '').trim();
const SUPABASE_SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  // eslint-disable-next-line no-console
  console.error(
    '\n[delivery] Configura las variables de entorno SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY.\n' +
      'Copia .env.example a .env y rellena los valores del panel de Supabase (Project Settings → API).\n' +
      'Ejecuta el SQL en supabase/migrations/001 … 003_username_not_unique.sql en el SQL Editor.\n'
  );
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const T = {
  users: 'delivery_users',
  orders: 'delivery_orders',
  meta: 'delivery_app_meta',
  emailTokens: 'delivery_email_tokens',
};

const TOKEN_KIND = {
  PASSWORD_RESET: 'password_reset',
};

function normalizeEmail(s) {
  return String(s || '')
    .trim()
    .toLowerCase();
}

function mapUserPublic(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: String(row.username),
    email: row.email != null ? String(row.email) : null,
    role: row.role,
    created_at: Number(row.created_at),
  };
}

function mapUserRow(row) {
  if (!row) return null;
  const ev = row.email_verified_at;
  return {
    id: row.id,
    username: String(row.username),
    email: row.email != null ? String(row.email) : null,
    password_hash: row.password_hash,
    role: row.role,
    created_at: Number(row.created_at),
    email_verified_at: ev != null && ev !== '' ? Number(ev) : null,
  };
}

async function getMeta(key) {
  const { data, error } = await supabase.from(T.meta).select('value').eq('key', key).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return data.value != null ? String(data.value) : null;
}

async function setMeta(key, value) {
  const { error } = await supabase.from(T.meta).upsert({ key, value: String(value) }, { onConflict: 'key' });
  if (error) throw error;
}

async function userCount() {
  const { count, error } = await supabase.from(T.users).select('*', { count: 'exact', head: true });
  if (error) throw error;
  return count || 0;
}

async function getUserRowByEmail(email) {
  const e = normalizeEmail(email);
  if (!e) return null;
  const { data, error } = await supabase.from(T.users).select('*').eq('email', e).maybeSingle();
  if (error) throw error;
  return mapUserRow(data);
}

async function getUserById(id) {
  const { data, error } = await supabase.from(T.users).select('id, username, email, role, created_at').eq('id', id).maybeSingle();
  if (error) throw error;
  return mapUserPublic(data);
}

async function createUser(username, email, passwordHash, role) {
  const em = email != null && String(email).trim() !== '' ? normalizeEmail(email) : null;
  const row = {
    username: String(username).trim(),
    email: em,
    password_hash: passwordHash,
    role,
    created_at: Math.floor(Date.now() / 1000),
    email_verified_at: em ? Math.floor(Date.now() / 1000) : null,
  };
  const { data, error } = await supabase.from(T.users).insert(row).select('id, username, email, role, created_at').single();
  if (error) throw error;
  return mapUserPublic(data);
}

async function updateUserRole(id, role) {
  const { error } = await supabase.from(T.users).update({ role }).eq('id', id);
  if (error) throw error;
  return getUserById(id);
}

async function updateUserPasswordHash(id, passwordHash) {
  const { data, error } = await supabase.from(T.users).update({ password_hash: passwordHash }).eq('id', id).select('id').maybeSingle();
  if (error) throw error;
  return !!data;
}

async function updateUserEmail(id, email) {
  const em = email != null && String(email).trim() !== '' ? normalizeEmail(email) : null;
  const { error } = await supabase.from(T.users).update({ email: em }).eq('id', id);
  if (error) throw error;
  return true;
}

/** Borrado de usuario (p. ej. desde el panel admin). */
async function deleteUserById(userId) {
  const { error } = await supabase.from(T.users).delete().eq('id', userId);
  if (error) throw error;
}

async function listUsers() {
  const { data, error } = await supabase
    .from(T.users)
    .select('id, username, email, role, created_at')
    .order('id', { ascending: true });
  if (error) throw error;
  return (data || []).map(mapUserPublic);
}

async function deleteTokensForUserKind(userId, kind) {
  const { error } = await supabase.from(T.emailTokens).delete().eq('user_id', userId).eq('kind', kind);
  if (error) throw error;
}

async function insertEmailToken(userId, kind, expiresMs) {
  const token = crypto.randomBytes(24).toString('hex');
  const { error } = await supabase.from(T.emailTokens).insert({
    token,
    user_id: userId,
    kind,
    expires_ms: expiresMs,
  });
  if (error) throw error;
  return token;
}

/** Token válido 1 h para restablecer contraseña. */
async function createPasswordResetToken(userId) {
  await deleteTokensForUserKind(userId, TOKEN_KIND.PASSWORD_RESET);
  const expiresMs = Date.now() + 60 * 60 * 1000;
  return insertEmailToken(userId, TOKEN_KIND.PASSWORD_RESET, expiresMs);
}

async function consumeEmailToken(token, kind) {
  const t = String(token || '').trim();
  const now = Date.now();
  const { data: row, error: selErr } = await supabase
    .from(T.emailTokens)
    .select('user_id')
    .eq('token', t)
    .eq('kind', kind)
    .gt('expires_ms', now)
    .maybeSingle();
  if (selErr) throw selErr;
  if (!row) return null;
  const { error: delErr } = await supabase.from(T.emailTokens).delete().eq('token', t);
  if (delErr) throw delErr;
  return Number(row.user_id);
}

async function consumePasswordResetToken(token) {
  return consumeEmailToken(token, TOKEN_KIND.PASSWORD_RESET);
}

async function getAllOrdersRows() {
  const { data, error } = await supabase.from(T.orders).select('id, payload');
  if (error) throw error;
  return (data || []).map((o) => ({
    id: Number(o.id),
    payload: typeof o.payload === 'string' ? o.payload : JSON.stringify(o.payload),
  }));
}

async function upsertOrderRow(id, payloadObj) {
  const row = {
    id: Number(id),
    payload: payloadObj,
    updated_at: Math.floor(Date.now() / 1000),
  };
  const { error } = await supabase.from(T.orders).upsert(row, { onConflict: 'id' });
  if (error) throw error;
}

async function deleteOrderRow(id) {
  const { error } = await supabase.from(T.orders).delete().eq('id', id);
  if (error) throw error;
}

async function replaceAllOrders(orderRows) {
  const { data: existing, error: selErr } = await supabase.from(T.orders).select('id');
  if (selErr) throw selErr;
  const allIds = (existing || []).map((r) => r.id);
  const delChunk = 300;
  for (let i = 0; i < allIds.length; i += delChunk) {
    const part = allIds.slice(i, i + delChunk);
    const { error: delErr } = await supabase.from(T.orders).delete().in('id', part);
    if (delErr) throw delErr;
  }
  const rows = [];
  for (const r of orderRows) {
    try {
      const obj = typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload;
      rows.push({
        id: Number(r.id),
        payload: obj,
        updated_at: Math.floor(Date.now() / 1000),
      });
    } catch (_e) {}
  }
  if (rows.length === 0) return;
  const chunk = 500;
  for (let i = 0; i < rows.length; i += chunk) {
    const part = rows.slice(i, i + chunk);
    const { error } = await supabase.from(T.orders).insert(part);
    if (error) throw error;
  }
}

module.exports = {
  normalizeEmail,
  getMeta,
  setMeta,
  userCount,
  getUserRowByEmail,
  getUserById,
  createUser,
  updateUserRole,
  updateUserPasswordHash,
  updateUserEmail,
  deleteUserById,
  listUsers,
  getAllOrdersRows,
  upsertOrderRow,
  deleteOrderRow,
  replaceAllOrders,
  createPasswordResetToken,
  consumePasswordResetToken,
};
