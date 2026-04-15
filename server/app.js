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
  return String(
    process.env.PUBLIC_APP_URL || `${req.protocol}://${req.get('host') || `localhost:${PORT}`}`
  ).replace(/\/$/, '');
}

async function enviarCorreoConfirmacion(email, token, req) {
  const base = publicAppBaseUrl(req);
  const link = `${base}/?verify=${encodeURIComponent(token)}`;
  const subject = 'Confirma tu correo â€” gestiÃ³n de pedidos';
  const text =
    `Hola,\n\nAbre este enlace para confirmar tu correo (vÃ¡lido 48 horas):\n${link}\n\nSi no creaste una cuenta, ignora este mensaje.\n`;
  const html = `<p>Hola,</p><p>Confirma tu correo con el siguiente enlace (vÃ¡lido 48 horas).</p><p><a href="${link}">Confirmar correo</a></p><p style="font-size:12px;color:#666;word-break:break-all">${link}</p>`;
  await sendTransactionalMail({ to: email, subject, html, text });
}

async function enviarCorreoRecuperacion(email, token, req) {
  const base = publicAppBaseUrl(req);
  const link = `${base}/?reset=${encodeURIComponent(token)}`;
  const subject = 'Restablecer contraseÃ±a â€” gestiÃ³n de pedidos';
  const text =
    `Hola,\n\nPara crear una contraseÃ±a nueva, abre este enlace (vÃ¡lido 1 hora):\n${link}\n\nSi no solicitaste el cambio, ignora este mensaje.\n`;
  const html = `<p>Hola,</p><p>Para elegir una <strong>contraseÃ±a nueva</strong>, usa el botÃ³n o enlace (vÃ¡lido 1 hora).</p><p><a href="${link}">Restablecer contraseÃ±a</a></p><p style="font-size:12px;color:#666;word-break:break-all">${link}</p>`;
  await sendTransactionalMail({ to: email, subject, html, text });
}

const mensajeCorreoEnviadoGenerico =
  'Si existe una cuenta con ese correo, te enviamos un mensaje. Revisa la bandeja de entrada, la carpeta de spam y el apartado de promociones. ' +
  'Si tu cuenta aÃºn no tiene el correo confirmado, el asunto serÃ¡ de confirmaciÃ³n (no de contraseÃ±a) hasta que confirmes.';

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
      res.status(401).json({ error: 'Usuario no vÃ¡lido' });
      return;
    }
    req.user = user;
    next();
  } catch (_e) {
    res.status(401).json({ error: 'SesiÃ³n invÃ¡lida o expirada' });
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

/** Quita asignaciÃ³n de pedidos a un mensajero antes de borrar su cuenta. */
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
  for (const p of mine) {
    if (!seen.has(Number(p.id))) ordered.push(p);
  }
  return { orders: ordered, orderIndex: ordered.map((p) => p.id) };
}

// --- Auth ---

app.get(
  '/api/auth/status',
  asyncHandler(async (_req, res) => {
    res.json({
      hasUsers: (await userCount()) > 0,
      mailConfigured: mailDeliveryConfigured(),
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
      res.status(400).json({ error: 'Indica un correo electrÃ³nico vÃ¡lido.' });
      return;
    }
    if (password.length < 6) {
      res.status(400).json({ error: 'La contraseÃ±a debe tener al menos 6 caracteres' });
      return;
    }
    const count = await userCount();
    const role = count === 0 ? 'admin' : 'mensajero';
    if (await getUserRowByEmail(email)) {
      res.status(400).json({ error: 'Ya existe una cuenta con ese correo. Usa otro correo o inicia sesiÃ³n.' });
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
          'No pudimos enviar el correo de confirmaciÃ³n. Configura RESEND_API_KEY (o SMTP) y MAIL_FROM en el servidor, o revisa los logs.',
        detail: String(err.message || err),
      });
      return;
    }

    res.status(201).json({
      needsEmailVerification: true,
      email: user.email,
      message: 'Te enviamos un correo para confirmar tu cuenta. Abre el enlace y luego podrÃ¡s iniciar sesiÃ³n.',
    });
  })
);

app.post(
  '/api/auth/forgot-password',
  asyncHandler(async (req, res) => {
    const email = normalizeEmail(req.body?.email || '');
    if (!correoValido(email)) {
      res.status(400).json({ error: 'Indica un correo electrÃ³nico vÃ¡lido.' });
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
    try {
      if (!verificado) {
        const vtoken = await createVerifyEmailToken(row.id);
        await enviarCorreoConfirmacion(email, vtoken, req);
        // eslint-disable-next-line no-console
        console.log('[delivery] forgot-password: enviado correo de CONFIRMACIÃ“N (cuenta sin correo verificado).');
      } else {
        const token = await createPasswordResetToken(row.id);
        await enviarCorreoRecuperacion(email, token, req);
        // eslint-disable-next-line no-console
        console.log('[delivery] forgot-password: enviado correo de RESTABLECER contraseÃ±a.');
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[delivery] forgot-password: fallo al enviar correo:', err);
      res.status(503).json({
        error: 'No se pudo enviar el correo. Revisa la configuraciÃ³n del servidor (correo y URL pÃºblica).',
        detail: String(err.message || err),
      });
      return;
    }
    // eslint-disable-next-line no-console
    console.log('[delivery] forgot-password: envÃ­o correcto hacia', email.replace(/(^.).*(@.+$)/, '$1***$2'));
    res.json({ ok: true, message: mensajeCorreoEnviadoGenerico });
  })
);

app.post(
  '/api/auth/verify-email',
  asyncHandler(async (req, res) => {
    const token = String(req.body?.token || '').trim();
    if (!token) {
      res.status(400).json({ error: 'Falta el token de verificaciÃ³n.' });
      return;
    }
    const userId = await consumeVerifyEmailToken(token);
    if (!userId) {
      res.status(400).json({
        error: 'El enlace no es vÃ¡lido o ha caducado. Pide un nuevo correo de confirmaciÃ³n desde la pantalla de acceso.',
      });
      return;
    }
    await setUserEmailVerified(userId);
    res.json({ ok: true, message: 'Correo confirmado. Ya puedes iniciar sesiÃ³n.' });
  })
);

app.post(
  '/api/auth/resend-verification',
  asyncHandler(async (req, res) => {
    const email = normalizeEmail(req.body?.email || '');
    if (!correoValido(email)) {
      res.status(400).json({ error: 'Indica un correo electrÃ³nico vÃ¡lido.' });
      return;
    }
    const row = await getUserRowByEmail(email);
    if (!row || !row.email) {
      res.json({ ok: true, message: mensajeCorreoEnviadoGenerico });
      return;
    }
    if (row.email_verified_at != null) {
      res.json({ ok: true, message: 'Ese correo ya estÃ¡ confirmado. Puedes iniciar sesiÃ³n.' });
      return;
    }
    try {
      const vtoken = await createVerifyEmailToken(row.id);
      await enviarCorreoConfirmacion(email, vtoken, req);
    } catch (err) {
      res.status(503).json({
        error: 'No se pudo enviar el correo. Revisa la configuraciÃ³n del servidor.',
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
      res.status(400).json({ error: 'Falta el token de recuperaciÃ³n.' });
      return;
    }
    if (password.length < 6) {
      res.status(400).json({ error: 'La contraseÃ±a debe tener al menos 6 caracteres' });
      return;
    }
    const userId = await consumePasswordResetToken(token);
    if (!userId) {
      res.status(400).json({ error: 'El enlace no es vÃ¡lido o ha caducado. Solicita uno nuevo.' });
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
      res.status(400).json({ error: 'Inicia sesiÃ³n solo con tu correo electrÃ³nico registrado.' });
      return;
    }
    const row = await getUserRowByEmail(email);
    if (!row) {
      res.status(401).json({ error: 'Correo o contraseÃ±a incorrectos' });
      return;
    }
    if (row.email && row.email_verified_at == null) {
      res.status(403).json({
        error:
          'Debes confirmar tu correo antes de entrar. Revisa tu bandeja (y spam) o usa Â«Reenviar correo de confirmaciÃ³nÂ».',
        code: 'EMAIL_NOT_VERIFIED',
      });
      return;
    }
    const ok = await bcrypt.compare(password, row.password_hash);
    if (!ok) {
      res.status(401).json({ error: 'Correo o contraseÃ±a incorrectos' });
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
      res.status(400).json({ error: 'Rol invÃ¡lido' });
      return;
    }
    if (username.length < 1) {
      res.status(400).json({ error: 'Indica un nombre para mostrar en la app.' });
      return;
    }
    if (!correoValido(email)) {
      res.status(400).json({ error: 'Indica un correo electrÃ³nico vÃ¡lido.' });
      return;
    }
    if (password.length < 6) {
      res.status(400).json({ error: 'La contraseÃ±a debe tener al menos 6 caracteres' });
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
      res.status(400).json({ error: 'Id invÃ¡lido' });
      return;
    }
    const password = String(req.body?.password || '');
    if (password.length < 6) {
      res.status(400).json({ error: 'La contraseÃ±a debe tener al menos 6 caracteres' });
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
      res.status(400).json({ error: 'Id invÃ¡lido' });
      return;
    }
    if (id === req.user.id) {
      res.status(400).json({ error: 'No puedes cambiar tu propio rol desde aquÃ­' });
      return;
    }
    const role = String(req.body?.role || '');
    if (!['admin', 'mensajero'].includes(role)) {
      res.status(400).json({ error: 'Rol invÃ¡lido' });
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
      res.status(400).json({ error: 'Id invÃ¡lido' });
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
        res.status(400).json({ error: 'No puedes eliminar el Ãºnico administrador del sistema' });
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
        res.status(403).json({ error: 'No puedes modificar pedidos que no te estÃ¡n asignados' });
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
      res.status(400).json({ error: 'Id de pedido invÃ¡lido' });
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
        res.status(400).json({ error: 'userId invÃ¡lido' });
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
      res.status(400).json({ error: 'Indica userId o null para quitar asignaciÃ³n' });
      return;
    }
    const uid = Number(assignUserId);
    if (!Number.isFinite(uid)) {
      res.status(400).json({ error: 'userId invÃ¡lido' });
      return;
    }
    const u = await getUserById(uid);
    if (!u || u.role !== 'mensajero') {
      res.status(400).json({ error: 'Solo puedes asignar a mensajeros' });
      return;
    }
    if (!Array.isArray(orderIds) || orderIds.length === 0) {
      res.status(400).json({ error: 'orderIds debe ser un array no vacÃ­o' });
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
    res.json({ ok: true, assignedTo: String(uid), count: orderIds.length });
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
