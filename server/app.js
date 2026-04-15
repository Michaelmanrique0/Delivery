try {
  require('dotenv').config();
} catch (_e) {
  /* dotenv opcional */
}

const path = require('path');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { sendTransactionalMail } = require('./mail');
const {
  normalizeEmail,
  userCount,
  getUserRowByEmail,
  getUserById,
  createUser,
  updateUserRole,
  updateUserPasswordHash,
  listUsers,
  getAllOrdersRows,
  upsertOrderRow,
  replaceAllOrders,
  getMeta,
  setMeta,
  createVerifyEmailToken,
  createPasswordResetToken,
  consumeVerifyEmailToken,
  consumePasswordResetToken,
  setUserEmailVerified,
  deleteUserById,
} = require('./data');

const PORT = Number(process.env.PORT || 3847);
const JWT_SECRET = process.env.JWT_SECRET || 'dev-delivery-cambia-esto-en-produccion';
const SALT_ROUNDS = 10;

function correoValido(emailNorm) {
  const e = String(emailNorm || '');
  if (e.length < 5 || e.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

function publicAppBaseUrl(req) {
  const explicit = String(process.env.PUBLIC_APP_URL || '')
    .trim()
    .replace(/\/$/, '');
  if (explicit) return explicit;

  const vercelHost = String(process.env.VERCEL_URL || '')
    .trim()
    .replace(/\/$/, '')
    .replace(/^https?:\/\//i, '');
  if (vercelHost) {
    const proto = String(req.get('x-forwarded-proto') || req.protocol || 'https')
      .split(',')[0]
      .trim();
    return `${proto}://${vercelHost}`.replace(/\/$/, '');
  }

  return String(`${req.protocol}://${req.get('host') || `localhost:${PORT}`}`).replace(/\/$/, '');
}

/** Si es true: verificación y recuperación devuelven enlaces en JSON (sin Resend ni SMTP). Solo para despliegues controlados. */
function authLinksInResponseEnabled() {
  const v = String(process.env.AUTH_LINKS_IN_RESPONSE || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function buildVerifyUrl(token, req) {
  const base = publicAppBaseUrl(req);
  return `${base}/?verify=${encodeURIComponent(token)}`;
}

function buildResetUrl(token, req) {
  const base = publicAppBaseUrl(req);
  return `${base}/?reset=${encodeURIComponent(token)}`;
}

async function enviarCorreoConfirmacion(email, token, req) {
  const base = publicAppBaseUrl(req);
  const link = `${base}/?verify=${encodeURIComponent(token)}`;
  const subject = 'Confirma tu correo — gestión de pedidos';
  const text =
    `Hola,\n\nAbre este enlace para confirmar tu correo (válido 48 horas):\n${link}\n\nSi no creaste una cuenta, ignora este mensaje.\n`;
  const html = `<p>Hola,</p><p>Confirma tu correo con el siguiente enlace (válido 48 horas).</p><p><a href="${link}">Confirmar correo</a></p><p style="font-size:12px;color:#666;word-break:break-all">${link}</p>`;
  await sendTransactionalMail({ to: email, subject, html, text });
}

async function enviarCorreoRecuperacion(email, token, req) {
  const base = publicAppBaseUrl(req);
  const link = `${base}/?reset=${encodeURIComponent(token)}`;
  const subject = 'Restablecer contraseña — gestión de pedidos';
  const text =
    `Hola,\n\nPara crear una contraseña nueva, abre este enlace (válido 1 hora):\n${link}\n\nSi no solicitaste el cambio, ignora este mensaje.\n`;
  const html = `<p>Hola,</p><p>Para elegir una <strong>contraseña nueva</strong>, usa el botón o enlace (válido 1 hora).</p><p><a href="${link}">Restablecer contraseña</a></p><p style="font-size:12px;color:#666;word-break:break-all">${link}</p>`;
  await sendTransactionalMail({ to: email, subject, html, text });
}

const mensajeCorreoEnviadoGenerico =
  'Si existe una cuenta con ese correo, te enviamos un mensaje. Revisa la bandeja de entrada, la carpeta de spam y el apartado de promociones. ' +
  'Si tu cuenta aún no tiene el correo confirmado, el asunto será de confirmación (no de contraseña) hasta que confirmes.';

function mailDeliveryConfigured() {
  const from = String(process.env.MAIL_FROM || '').trim();
  if (!from) return false;
  const resend = String(process.env.RESEND_API_KEY || '').trim();
  const smtp = String(process.env.SMTP_HOST || '').trim();
  return !!(resend || smtp);
}

function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch((err) => {
      // eslint-disable-next-line no-console
      console.error(err);
      if (!res.headersSent) {
        res.status(500).json({ error: String(err.message || err) || 'Error interno' });
      }
    });
  };
}

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '15mb' }));

function signToken(userRow) {
  return jwt.sign(
    { sub: userRow.id, role: userRow.role, username: userRow.username },
    JWT_SECRET,
    { expiresIn: '30d' }
  );
}

async function authMiddleware(req, res, next) {
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m) {
    res.status(401).json({ error: 'No autorizado' });
    return;
  }
  try {
    const payload = jwt.verify(m[1], JWT_SECRET);
    const user = await getUserById(payload.sub);
    if (!user) {
      res.status(401).json({ error: 'Usuario no válido' });
      return;
    }
    req.user = user;
    next();
  } catch (_e) {
    res.status(401).json({ error: 'Sesión inválida o expirada' });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    res.status(403).json({ error: 'Solo administradores' });
    return;
  }
  next();
}

function parsePayloadRow(row) {
  if (!row || row.payload == null) return null;
  if (typeof row.payload === 'object') return row.payload;
  try {
    return JSON.parse(row.payload);
  } catch (_e) {
    return null;
  }
}

/** Quita asignación de pedidos a un mensajero antes de borrar su cuenta. */
async function unassignOrdersFromUser(userId) {
  const uid = String(userId);
  const rows = await getAllOrdersRows();
  for (const row of rows) {
    const p = parsePayloadRow(row);
    if (!p || p.id == null) continue;
    if (String(p.assignedTo || '') !== uid) continue;
    p.assignedTo = null;
    await upsertOrderRow(Number(row.id), p);
  }
}

async function buildOrdersResponseForUser(user) {
  const rows = await getAllOrdersRows();
  const byId = new Map();
  for (const row of rows) {
    const p = parsePayloadRow(row);
    if (p && p.id != null) byId.set(Number(p.id), p);
  }

  let orderIndex = [];
  try {
    orderIndex = JSON.parse((await getMeta('order_index')) || '[]');
  } catch (_e) {
    orderIndex = [];
  }
  if (!Array.isArray(orderIndex)) orderIndex = [];

  if (user.role === 'admin') {
    const seen = new Set();
    const ordered = [];
    for (const rawId of orderIndex) {
      const id = Number(rawId);
      if (!Number.isFinite(id)) continue;
      const p = byId.get(id);
      if (p) {
        ordered.push(p);
        seen.add(id);
      }
    }
    const restIds = [...byId.keys()].filter((id) => !seen.has(id)).sort((a, b) => a - b);
    for (const id of restIds) ordered.push(byId.get(id));
    return { orders: ordered, orderIndex: ordered.map((p) => p.id) };
  }

  const mine = [];
  for (const row of rows) {
    const p = parsePayloadRow(row);
    if (!p) continue;
    if (String(p.assignedTo || '') === String(user.id)) mine.push(p);
  }
  const byMine = new Map(mine.map((p) => [Number(p.id), p]));

  const routeKey = `route_u${user.id}`;
  let routeIds = [];
  try {
    routeIds = JSON.parse((await getMeta(routeKey)) || '[]');
  } catch (_e) {
    routeIds = [];
  }
  if (!Array.isArray(routeIds)) routeIds = [];

  const ordered = [];
  const seen = new Set();
  for (const rawId of routeIds) {
    const id = Number(rawId);
    if (!Number.isFinite(id)) continue;
    const p = byMine.get(id);
    if (p) {
      ordered.push(p);
      seen.add(id);
    }
  }
  // Si el mensajero aún no tiene ruta guardada (o faltan ids), respeta el orden del admin (order_index).
  for (const rawId of orderIndex) {
    const id = Number(rawId);
    if (!Number.isFinite(id)) continue;
    if (seen.has(id)) continue;
    const p = byMine.get(id);
    if (p) {
      ordered.push(p);
      seen.add(id);
    }
  }
  for (const p of mine) {
    const id = Number(p.id);
    if (!seen.has(id)) ordered.push(p);
  }

  let routeNotice = null;
  try {
    routeNotice = JSON.parse((await getMeta(`route_notice_u${user.id}`)) || 'null');
  } catch (_e) {
    routeNotice = null;
  }

  return { orders: ordered, orderIndex: ordered.map((p) => p.id), routeNotice };
}

// --- Auth ---

app.get(
  '/api/auth/status',
  asyncHandler(async (_req, res) => {
    res.json({
      hasUsers: (await userCount()) > 0,
      mailConfigured: mailDeliveryConfigured(),
      authLinksInResponse: authLinksInResponseEnabled(),
    });
  })
);

app.post(
  '/api/auth/register',
  asyncHandler(async (req, res) => {
    const username = String(req.body?.username || '').trim();
    const email = normalizeEmail(req.body?.email || '');
    const password = String(req.body?.password || '');
    if (username.length < 1) {
      res.status(400).json({ error: 'Indica un nombre para mostrar en la app.' });
      return;
    }
    if (!correoValido(email)) {
      res.status(400).json({ error: 'Indica un correo electrónico válido.' });
      return;
    }
    if (password.length < 6) {
      res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
      return;
    }
    const count = await userCount();
    const role = count === 0 ? 'admin' : 'mensajero';
    if (await getUserRowByEmail(email)) {
      res.status(400).json({ error: 'Ya existe una cuenta con ese correo. Usa otro correo o inicia sesión.' });
      return;
    }
    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    const primerUsuario = count === 0;
    const emailVerified = primerUsuario;
    const user = await createUser(username, email, hash, role, { emailVerified });

    if (primerUsuario) {
      const token = signToken(user);
      res.status(201).json({
        token,
        user: { id: user.id, username: user.username, email: user.email, role: user.role },
      });
      return;
    }

    if (authLinksInResponseEnabled()) {
      const verifyToken = await createVerifyEmailToken(user.id);
      res.status(201).json({
        needsEmailVerification: true,
        email: user.email,
        message:
          'Tu cuenta está creada. Copia el enlace que ves abajo para confirmar el correo (no se envía mensaje al buzón en este modo).',
        verifyUrl: buildVerifyUrl(verifyToken, req),
      });
      return;
    }

    let verifyToken;
    try {
      verifyToken = await createVerifyEmailToken(user.id);
      await enviarCorreoConfirmacion(email, verifyToken, req);
    } catch (err) {
      try {
        await deleteUserById(user.id);
      } catch (_e) {}
      res.status(503).json({
        error:
          'No pudimos enviar el correo de confirmación. Configura RESEND_API_KEY (o SMTP) y MAIL_FROM, o activa AUTH_LINKS_IN_RESPONSE=true para obtener el enlace en pantalla.',
        detail: String(err.message || err),
      });
      return;
    }

    res.status(201).json({
      needsEmailVerification: true,
      email: user.email,
      message: 'Te enviamos un correo para confirmar tu cuenta. Abre el enlace y luego podrás iniciar sesión.',
    });
  })
);

app.post(
  '/api/auth/check-email-for-recovery',
  asyncHandler(async (req, res) => {
    const email = normalizeEmail(req.body?.email || '');
    if (!correoValido(email)) {
      res.status(400).json({ error: 'Indica un correo electrónico válido.' });
      return;
    }
    const row = await getUserRowByEmail(email);
    res.json({ exists: !!row });
  })
);

app.post(
  '/api/auth/forgot-password',
  asyncHandler(async (req, res) => {
    const email = normalizeEmail(req.body?.email || '');
    if (!correoValido(email)) {
      res.status(400).json({ error: 'Indica un correo electrónico válido.' });
      return;
    }
    const row = await getUserRowByEmail(email);
    if (!row) {
      // eslint-disable-next-line no-console
      console.log('[delivery] forgot-password: correo no asociado a ninguna cuenta.');
      res.status(404).json({ error: 'No hay ninguna cuenta registrada con ese correo.' });
      return;
    }
    const tieneCorreo = !!row.email;
    const verificado = tieneCorreo && row.email_verified_at != null;
    if (authLinksInResponseEnabled()) {
      if (!verificado) {
        const vtoken = await createVerifyEmailToken(row.id);
        // eslint-disable-next-line no-console
        console.log('[delivery] forgot-password: token de CONFIRMACIÓN (sin correo; AUTH_LINKS_IN_RESPONSE).');
        res.json({
          ok: true,
          pendingEmailVerification: true,
          message:
            'Tu cuenta aún no tiene el correo confirmado. Pulsa «Confirmar correo» para continuar y luego podrás elegir una contraseña nueva.',
          verifyToken: vtoken,
          verifyUrl: buildVerifyUrl(vtoken, req),
        });
      } else {
        const token = await createPasswordResetToken(row.id);
        // eslint-disable-next-line no-console
        console.log('[delivery] forgot-password: token RESTABLECER contraseña (sin correo; AUTH_LINKS_IN_RESPONSE).');
        res.json({
          ok: true,
          message: 'Elige una contraseña nueva (válido 1 hora; no se envía correo en este modo).',
          resetToken: token,
          resetUrl: buildResetUrl(token, req),
        });
      }
      return;
    }
    try {
      if (!verificado) {
        const vtoken = await createVerifyEmailToken(row.id);
        await enviarCorreoConfirmacion(email, vtoken, req);
        // eslint-disable-next-line no-console
        console.log('[delivery] forgot-password: enviado correo de CONFIRMACIÓN (cuenta sin correo verificado).');
      } else {
        const token = await createPasswordResetToken(row.id);
        await enviarCorreoRecuperacion(email, token, req);
        // eslint-disable-next-line no-console
        console.log('[delivery] forgot-password: enviado correo de RESTABLECER contraseña.');
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[delivery] forgot-password: fallo al enviar correo:', err);
      res.status(503).json({
        error: 'No se pudo enviar el correo. Revisa la configuración del servidor (correo y URL pública).',
        detail: String(err.message || err),
      });
      return;
    }
    // eslint-disable-next-line no-console
    console.log('[delivery] forgot-password: envío correcto hacia', email.replace(/(^.).*(@.+$)/, '$1***$2'));
    res.json({ ok: true, message: mensajeCorreoEnviadoGenerico });
  })
);

app.post(
  '/api/auth/verify-email',
  asyncHandler(async (req, res) => {
    const token = String(req.body?.token || '').trim();
    if (!token) {
      res.status(400).json({ error: 'Falta el token de verificación.' });
      return;
    }
    const userId = await consumeVerifyEmailToken(token);
    if (!userId) {
      res.status(400).json({
        error: 'El enlace no es válido o ha caducado. Pide un nuevo correo de confirmación desde la pantalla de acceso.',
      });
      return;
    }
    await setUserEmailVerified(userId);
    res.json({ ok: true, message: 'Correo confirmado. Ya puedes iniciar sesión.' });
  })
);

app.post(
  '/api/auth/resend-verification',
  asyncHandler(async (req, res) => {
    const email = normalizeEmail(req.body?.email || '');
    if (!correoValido(email)) {
      res.status(400).json({ error: 'Indica un correo electrónico válido.' });
      return;
    }
    const row = await getUserRowByEmail(email);
    if (!row || !row.email) {
      res.json({ ok: true, message: mensajeCorreoEnviadoGenerico });
      return;
    }
    if (row.email_verified_at != null) {
      res.json({ ok: true, message: 'Ese correo ya está confirmado. Puedes iniciar sesión.' });
      return;
    }
    if (authLinksInResponseEnabled()) {
      const vtoken = await createVerifyEmailToken(row.id);
      res.json({
        ok: true,
        message: 'Copia el enlace de abajo para confirmar tu correo (no se envía mensaje al buzón en este modo).',
        verifyUrl: buildVerifyUrl(vtoken, req),
      });
      return;
    }
    try {
      const vtoken = await createVerifyEmailToken(row.id);
      await enviarCorreoConfirmacion(email, vtoken, req);
    } catch (err) {
      res.status(503).json({
        error: 'No se pudo enviar el correo. Revisa la configuración del servidor.',
        detail: String(err.message || err),
      });
      return;
    }
    res.json({ ok: true, message: 'Si el correo existe y falta confirmar, te enviamos un nuevo enlace.' });
  })
);

app.post(
  '/api/auth/reset-password',
  asyncHandler(async (req, res) => {
    const token = String(req.body?.token || '').trim();
    const password = String(req.body?.password || '');
    if (!token) {
      res.status(400).json({ error: 'Falta el token de recuperación.' });
      return;
    }
    if (password.length < 6) {
      res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
      return;
    }
    const userId = await consumePasswordResetToken(token);
    if (!userId) {
      res.status(400).json({ error: 'El enlace no es válido o ha caducado. Solicita uno nuevo.' });
      return;
    }
    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    await updateUserPasswordHash(userId, hash);
    const user = await getUserById(userId);
    const jwtToken = signToken(user);
    res.json({
      token: jwtToken,
      user: { id: user.id, username: user.username, email: user.email, role: user.role },
    });
  })
);

app.post(
  '/api/auth/login',
  asyncHandler(async (req, res) => {
    const email = normalizeEmail(req.body?.login || req.body?.email || '');
    const password = String(req.body?.password || '');
    if (!correoValido(email)) {
      res.status(400).json({ error: 'Inicia sesión solo con tu correo electrónico registrado.' });
      return;
    }
    const row = await getUserRowByEmail(email);
    if (!row) {
      res.status(401).json({ error: 'Correo o contraseña incorrectos' });
      return;
    }
    if (row.email && row.email_verified_at == null) {
      res.status(403).json({
        error:
          'Debes confirmar tu correo antes de entrar. Revisa tu bandeja (y spam) o usa «Reenviar correo de confirmación».',
        code: 'EMAIL_NOT_VERIFIED',
      });
      return;
    }
    const ok = await bcrypt.compare(password, row.password_hash);
    if (!ok) {
      res.status(401).json({ error: 'Correo o contraseña incorrectos' });
      return;
    }
    const user = await getUserById(row.id);
    const token = signToken(user);
    res.json({
      token,
      user: { id: user.id, username: user.username, email: user.email, role: user.role },
    });
  })
);

app.get('/api/me', asyncHandler(authMiddleware), (req, res) => {
  res.json({ user: req.user });
});

// --- Users (admin) ---

app.get('/api/users', asyncHandler(authMiddleware), requireAdmin, asyncHandler(async (_req, res) => {
  res.json({ users: await listUsers() });
}));

app.post(
  '/api/users',
  asyncHandler(authMiddleware),
  requireAdmin,
  asyncHandler(async (req, res) => {
    const username = String(req.body?.username || '').trim();
    const email = normalizeEmail(req.body?.email || '');
    const password = String(req.body?.password || '');
    const role = String(req.body?.role || 'mensajero');
    if (!['admin', 'mensajero'].includes(role)) {
      res.status(400).json({ error: 'Rol inválido' });
      return;
    }
    if (username.length < 1) {
      res.status(400).json({ error: 'Indica un nombre para mostrar en la app.' });
      return;
    }
    if (!correoValido(email)) {
      res.status(400).json({ error: 'Indica un correo electrónico válido.' });
      return;
    }
    if (password.length < 6) {
      res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
      return;
    }
    if (await getUserRowByEmail(email)) {
      res.status(400).json({ error: 'Ya existe una cuenta con ese correo.' });
      return;
    }
    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    const user = await createUser(username, email, hash, role, { emailVerified: true });
    res.status(201).json({ user });
  })
);

app.patch(
  '/api/users/:id/password',
  asyncHandler(authMiddleware),
  requireAdmin,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id < 1) {
      res.status(400).json({ error: 'Id inválido' });
      return;
    }
    const password = String(req.body?.password || '');
    if (password.length < 6) {
      res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
      return;
    }
    const target = await getUserById(id);
    if (!target) {
      res.status(404).json({ error: 'Usuario no encontrado' });
      return;
    }
    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    await updateUserPasswordHash(id, hash);
    res.json({ ok: true });
  })
);

app.patch(
  '/api/users/:id',
  asyncHandler(authMiddleware),
  requireAdmin,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id < 1) {
      res.status(400).json({ error: 'Id inválido' });
      return;
    }
    if (id === req.user.id) {
      res.status(400).json({ error: 'No puedes cambiar tu propio rol desde aquí' });
      return;
    }
    const role = String(req.body?.role || '');
    if (!['admin', 'mensajero'].includes(role)) {
      res.status(400).json({ error: 'Rol inválido' });
      return;
    }
    const target = await getUserById(id);
    if (!target) {
      res.status(404).json({ error: 'Usuario no encontrado' });
      return;
    }
    await updateUserRole(id, role);
    res.json({ user: await getUserById(id) });
  })
);

app.delete(
  '/api/users/:id',
  asyncHandler(authMiddleware),
  requireAdmin,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id < 1) {
      res.status(400).json({ error: 'Id inválido' });
      return;
    }
    if (id === req.user.id) {
      res.status(400).json({ error: 'No puedes eliminar tu propia cuenta' });
      return;
    }
    const target = await getUserById(id);
    if (!target) {
      res.status(404).json({ error: 'Usuario no encontrado' });
      return;
    }
    if (target.role === 'admin') {
      const users = await listUsers();
      const admins = users.filter((u) => u.role === 'admin');
      if (admins.length <= 1) {
        res.status(400).json({ error: 'No puedes eliminar el único administrador del sistema' });
        return;
      }
    }
    await unassignOrdersFromUser(id);
    await deleteUserById(id);
    res.json({ ok: true });
  })
);

// --- Orders ---

app.get('/api/orders', asyncHandler(authMiddleware), asyncHandler(async (req, res) => {
  res.json(await buildOrdersResponseForUser(req.user));
}));

app.put(
  '/api/orders',
  asyncHandler(authMiddleware),
  requireAdmin,
  asyncHandler(async (req, res) => {
    const orders = req.body?.orders;
    let orderIndex = req.body?.orderIndex;
    if (!Array.isArray(orders)) {
      res.status(400).json({ error: 'Se esperaba orders: []' });
      return;
    }
    if (!Array.isArray(orderIndex)) {
      orderIndex = orders.map((p) => p.id);
    }
    const rows = orders
      .filter((p) => p && p.id != null && Number.isFinite(Number(p.id)))
      .map((p) => ({
        id: Number(p.id),
        payload: JSON.stringify(p),
      }));
    await replaceAllOrders(rows);
    await setMeta(
      'order_index',
      JSON.stringify(orderIndex.map((oid) => Number(oid)).filter(Number.isFinite))
    );
    res.json(await buildOrdersResponseForUser(req.user));
  })
);

app.put(
  '/api/orders/messenger',
  asyncHandler(authMiddleware),
  asyncHandler(async (req, res) => {
    if (req.user.role !== 'mensajero') {
      res.status(403).json({ error: 'Solo mensajeros usan esta ruta' });
      return;
    }
    const orders = req.body?.orders;
    let orderIndex = req.body?.orderIndex;
    if (!Array.isArray(orders)) {
      res.status(400).json({ error: 'Se esperaba orders: []' });
      return;
    }
    if (!Array.isArray(orderIndex)) {
      orderIndex = orders.map((p) => p.id);
    }
    const uid = String(req.user.id);
    for (const p of orders) {
      if (!p || p.id == null) continue;
      if (String(p.assignedTo || '') !== uid) {
        res.status(403).json({ error: 'No puedes modificar pedidos que no te están asignados' });
        return;
      }
      await upsertOrderRow(Number(p.id), p);
    }
    const validIds = new Set(orders.filter((p) => String(p.assignedTo || '') === uid).map((p) => Number(p.id)));
    const filteredRoute = orderIndex.map((oid) => Number(oid)).filter((oid) => Number.isFinite(oid) && validIds.has(oid));
    await setMeta(`route_u${req.user.id}`, JSON.stringify(filteredRoute));
    res.json(await buildOrdersResponseForUser(req.user));
  })
);

app.patch(
  '/api/orders/:orderId/assign',
  asyncHandler(authMiddleware),
  requireAdmin,
  asyncHandler(async (req, res) => {
    const orderId = Number(req.params.orderId);
    if (!Number.isFinite(orderId)) {
      res.status(400).json({ error: 'Id de pedido inválido' });
      return;
    }
    const rows = await getAllOrdersRows();
    const row = rows.find((r) => r.id === orderId);
    if (!row) {
      res.status(404).json({ error: 'Pedido no encontrado' });
      return;
    }
    const p = parsePayloadRow(row);
    if (!p) {
      res.status(500).json({ error: 'Pedido corrupto' });
      return;
    }
    const assignUserId = req.body?.userId;
    if (assignUserId === null || assignUserId === '' || assignUserId === undefined) {
      p.assignedTo = null;
    } else {
      const uid = Number(assignUserId);
      if (!Number.isFinite(uid)) {
        res.status(400).json({ error: 'userId inválido' });
        return;
      }
      const u = await getUserById(uid);
      if (!u || u.role !== 'mensajero') {
        res.status(400).json({ error: 'Solo puedes asignar a usuarios con rol mensajero' });
        return;
      }
      p.assignedTo = String(uid);
    }
    await upsertOrderRow(orderId, p);

    // Al asignar a un mensajero, copiar el orden actual del admin a su ruta.
    if (assignUserId !== null && assignUserId !== '' && assignUserId !== undefined) {
      const uid = Number(assignUserId);
      let orderIndex = [];
      try {
        orderIndex = JSON.parse((await getMeta('order_index')) || '[]');
      } catch (_e) {
        orderIndex = [];
      }
      if (!Array.isArray(orderIndex)) orderIndex = [];
      const rows2 = await getAllOrdersRows();
      const mineIds = new Set();
      for (const row2 of rows2) {
        if (row2.id == null) continue;
        const pp = parsePayloadRow(row2);
        if (!pp) continue;
        if (String(pp.assignedTo || '') === String(uid)) mineIds.add(Number(pp.id));
      }
      const route = orderIndex.map((x) => Number(x)).filter((x) => Number.isFinite(x) && mineIds.has(x));
      await setMeta(`route_u${uid}`, JSON.stringify(route));
    }
    res.json({ order: p });
  })
);

app.post(
  '/api/orders/assign-bulk',
  asyncHandler(authMiddleware),
  requireAdmin,
  asyncHandler(async (req, res) => {
    const assignUserId = req.body?.userId;
    const orderIds = req.body?.orderIds;
    if (assignUserId === null || assignUserId === '' || assignUserId === undefined) {
      res.status(400).json({ error: 'Indica userId o null para quitar asignación' });
      return;
    }
    const uid = Number(assignUserId);
    if (!Number.isFinite(uid)) {
      res.status(400).json({ error: 'userId inválido' });
      return;
    }
    const u = await getUserById(uid);
    if (!u || u.role !== 'mensajero') {
      res.status(400).json({ error: 'Solo puedes asignar a mensajeros' });
      return;
    }
    if (!Array.isArray(orderIds) || orderIds.length === 0) {
      res.status(400).json({ error: 'orderIds debe ser un array no vacío' });
      return;
    }
    const rows = await getAllOrdersRows();
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const raw of orderIds) {
      const id = Number(raw);
      if (!Number.isFinite(id)) continue;
      const r = byId.get(id);
      if (!r) continue;
      const p = parsePayloadRow(r);
      if (!p) continue;
      p.assignedTo = String(uid);
      await upsertOrderRow(id, p);
    }

    // Copiar el orden del admin a la ruta del mensajero (incluyendo los recién asignados).
    let orderIndex = [];
    try {
      orderIndex = JSON.parse((await getMeta('order_index')) || '[]');
    } catch (_e) {
      orderIndex = [];
    }
    if (!Array.isArray(orderIndex)) orderIndex = [];
    const rows2 = await getAllOrdersRows();
    const mineIds = new Set();
    for (const row2 of rows2) {
      if (row2.id == null) continue;
      const pp = parsePayloadRow(row2);
      if (!pp) continue;
      if (String(pp.assignedTo || '') === String(uid)) mineIds.add(Number(pp.id));
    }
    const route = orderIndex.map((x) => Number(x)).filter((x) => Number.isFinite(x) && mineIds.has(x));
    await setMeta(`route_u${uid}`, JSON.stringify(route));

    res.json({ ok: true, assignedTo: String(uid), count: orderIds.length });
  })
);

// --- Routes (admin) ---
app.patch(
  '/api/routes/:userId',
  asyncHandler(authMiddleware),
  requireAdmin,
  asyncHandler(async (req, res) => {
    const userId = Number(req.params.userId);
    if (!Number.isFinite(userId) || userId < 1) {
      res.status(400).json({ error: 'userId inválido' });
      return;
    }
    const u = await getUserById(userId);
    if (!u || u.role !== 'mensajero') {
      res.status(400).json({ error: 'Solo puedes definir ruta para usuarios con rol mensajero' });
      return;
    }
    const routeIds = req.body?.routeIds;
    if (!Array.isArray(routeIds)) {
      res.status(400).json({ error: 'Se esperaba routeIds: []' });
      return;
    }
    const filtered = routeIds.map((x) => Number(x)).filter((x) => Number.isFinite(x));
    await setMeta(`route_u${userId}`, JSON.stringify(filtered));

    const notice = {
      at: Date.now(),
      by: req.user ? { id: req.user.id, username: req.user.username } : null,
      message: String(req.body?.message || 'Un administrador modificó el orden de tus pedidos.'),
    };
    await setMeta(`route_notice_u${userId}`, JSON.stringify(notice));
    res.json({ ok: true, userId: String(userId), count: filtered.length });
  })
);

const staticDir = path.join(__dirname, '..', 'public');
app.use(express.static(staticDir));

app.use((req, res) => {
  if (req.path.startsWith('/api')) {
    res.status(404).json({ error: 'No encontrado' });
    return;
  }
  res.sendFile(path.join(staticDir, 'index.html'));
});

module.exports = app;
