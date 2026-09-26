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
  createPasswordResetToken,
  consumePasswordResetToken,
  deleteUserById,
} = require('./data');
const {
  parsePaymentConfig,
  paymentConfigListo,
  validatePaymentConfig,
  getStorePaymentConfig,
  setStorePaymentConfig,
  getUserPaymentSettings,
  setUserPaymentSettings,
  resolveEffectivePaymentConfig,
} = require('./paymentConfig');
const {
  setPuedeModificarValor,
  enrichUserPublic,
  enrichUsersList,
} = require('./userPerms');

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

function buildResetUrl(token, req) {
  const base = publicAppBaseUrl(req);
  return `${base}/?reset=${encodeURIComponent(token)}`;
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
    req.user = await enrichUserPublic(user);
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

/** Un PUT a la vez: si dos guardados se cruzan, el viejo puede dejar otra vez los pedidos eliminados. */
let ordersWriteLock = Promise.resolve();
function withOrdersWriteLock(fn) {
  const run = ordersWriteLock.then(fn, fn);
  ordersWriteLock = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function buildOrdersResponseForUser(user, extra = {}) {
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
    // Solo lo que está en order_index: no reinyectar pedidos viejos que quedaron huérfanos.
    return { orders: ordered, orderIndex: ordered.map((p) => p.id), ...extra };
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

  return { orders: ordered, orderIndex: ordered.map((p) => p.id), routeNotice, ...extra };
}

// --- Auth ---

app.get(
  '/api/auth/status',
  asyncHandler(async (_req, res) => {
    res.json({
      hasUsers: (await userCount()) > 0,
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
    const user = await enrichUserPublic(await createUser(username, email, hash, role));
    const token = signToken(user);
    res.status(201).json({
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        puedeModificarValor: !!user.puedeModificarValor,
      },
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
    const token = await createPasswordResetToken(row.id);
    // eslint-disable-next-line no-console
    console.log('[delivery] forgot-password: token de restablecimiento (solo en app / enlace, sin correo).');
    res.json({
      ok: true,
      message: 'Escribe tu nueva contraseña abajo (enlace válido 1 hora). No se envía ningún correo.',
      resetToken: token,
      resetUrl: buildResetUrl(token, req),
    });
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
    const ok = await bcrypt.compare(password, row.password_hash);
    if (!ok) {
      res.status(401).json({ error: 'Correo o contraseña incorrectos' });
      return;
    }
    const user = await enrichUserPublic(await getUserById(row.id));
    const token = signToken(user);
    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        puedeModificarValor: !!user.puedeModificarValor,
      },
    });
  })
);

app.get('/api/me', asyncHandler(authMiddleware), (req, res) => {
  res.json({ user: req.user });
});

// --- Historial diario de entregas (admin) ---

const HISTORIAL_CONFIG_META = 'historial_entregas_config_v1';
const HISTORIAL_DIAS_META = 'historial_entregas_v1';
const HISTORIAL_RETENCION_DEFAULT = 30;

function parseHistorialDias(raw) {
  try {
    const arr = JSON.parse(raw || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch (_e) {
    return [];
  }
}

function parseHistorialConfig(raw) {
  try {
    const o = JSON.parse(raw || '{}');
    if (!o || typeof o !== 'object') return { retencionDias: HISTORIAL_RETENCION_DEFAULT };
    let dias = Number(o.retencionDias);
    if (!Number.isFinite(dias)) dias = HISTORIAL_RETENCION_DEFAULT;
    // 0 = no borrar automáticamente; máximo 3650 (~10 años)
    dias = Math.max(0, Math.min(3650, Math.floor(dias)));
    return { retencionDias: dias };
  } catch (_e) {
    return { retencionDias: HISTORIAL_RETENCION_DEFAULT };
  }
}

/** Conserva días cuya fecha >= hoy - retencionDias. Si retencionDias es 0, no elimina. */
function filtrarDiasPorRetencion(dias, retencionDias) {
  const n = Number(retencionDias);
  if (!Number.isFinite(n) || n <= 0) return Array.isArray(dias) ? dias : [];
  const hoy = new Date();
  hoy.setHours(12, 0, 0, 0);
  hoy.setDate(hoy.getDate() - Math.floor(n));
  const y = hoy.getFullYear();
  const m = String(hoy.getMonth() + 1).padStart(2, '0');
  const day = String(hoy.getDate()).padStart(2, '0');
  const limite = `${y}-${m}-${day}`;
  return (dias || []).filter((d) => d && String(d.fecha || '') >= limite);
}

function normalizarPedidoHistorialSnap(p) {
  if (!p || typeof p !== 'object') return null;
  const id = Number(p.id);
  if (!Number.isFinite(id)) return null;
  const estado = String(p.estado || '').trim();
  const estadosOk = new Set(['entregado', 'devuelto', 'sin_entregar']);
  return {
    id,
    nombre: String(p.nombre || '').trim().slice(0, 120),
    estado: estadosOk.has(estado) ? estado : 'entregado',
    montoNequi: Math.max(0, Number(p.montoNequi) || 0),
    montoDaviplata: Math.max(0, Number(p.montoDaviplata) || 0),
    montoEfectivo: Math.max(0, Number(p.montoEfectivo) || 0),
  };
}

function normalizarMensajeroHistorial(m) {
  if (!m || typeof m !== 'object') return null;
  const userId =
    m.userId == null || String(m.userId).trim() === '' ? null : String(m.userId).trim();
  const pedidos = Array.isArray(m.pedidos)
    ? m.pedidos.map(normalizarPedidoHistorialSnap).filter(Boolean)
    : [];
  return {
    userId,
    nombre: String(m.nombre || (userId ? `Usuario ${userId}` : 'Sin asignar')).trim().slice(0, 80),
    entregados: Math.max(0, Number(m.entregados) || 0),
    pedidos,
  };
}

function normalizarDiaHistorial(d) {
  if (!d || typeof d !== 'object') return null;
  const fecha = String(d.fecha || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return null;
  const porMensajero = Array.isArray(d.porMensajero)
    ? d.porMensajero.map(normalizarMensajeroHistorial).filter(Boolean)
    : [];
  return {
    fecha,
    entregados: Math.max(0, Number(d.entregados) || 0),
    devueltos: Math.max(0, Number(d.devueltos) || 0),
    sinEntregar: Math.max(0, Number(d.sinEntregar) || 0),
    pagadosNequi: Math.max(0, Number(d.pagadosNequi) || 0),
    recogidoTotal: Math.max(0, Number(d.recogidoTotal) || 0),
    recogidoEfectivo: Math.max(0, Number(d.recogidoEfectivo) || 0),
    recogidoNequi: Math.max(0, Number(d.recogidoNequi) || 0),
    recogidoDaviplata: Math.max(0, Number(d.recogidoDaviplata) || 0),
    pagadoMensajero: Math.max(0, Number(d.pagadoMensajero) || 0),
    aEntregarTienda: Math.max(
      0,
      Number(d.aEntregarTienda) ||
        Math.max(0, (Number(d.recogidoTotal) || 0) - (Number(d.pagadoMensajero) || 0))
    ),
    porMensajero,
    actualizadoEn: Number(d.actualizadoEn) || Math.floor(Date.now() / 1000),
  };
}

function diaHistorialTieneActividad(d) {
  if (!d) return false;
  return (
    Number(d.entregados || 0) > 0 ||
    Number(d.devueltos || 0) > 0 ||
    Number(d.sinEntregar || 0) > 0 ||
    Number(d.pagadosNequi || 0) > 0 ||
    Number(d.recogidoTotal || 0) > 0 ||
    Number(d.recogidoEfectivo || 0) > 0 ||
    Number(d.recogidoNequi || 0) > 0 ||
    Number(d.recogidoDaviplata || 0) > 0 ||
    Number(d.pagadoMensajero || 0) > 0 ||
    Number(d.aEntregarTienda || 0) > 0 ||
    (Array.isArray(d.porMensajero) && d.porMensajero.length > 0)
  );
}

/** Upsert por fecha: nunca borra un día solo porque no vino en el payload (salvo retención). */
function fusionarDiasHistorialServidor(actuales, incoming) {
  const map = new Map();
  for (const d of actuales || []) {
    if (d && d.fecha) map.set(String(d.fecha), d);
  }
  for (const d of incoming || []) {
    if (!d || !d.fecha) continue;
    const key = String(d.fecha);
    const prev = map.get(key);
    // No pisar un día con datos por uno vacío (p. ej. pedidos ya borrados del dispositivo).
    if (!diaHistorialTieneActividad(d) && prev && diaHistorialTieneActividad(prev)) continue;
    map.set(key, d);
  }
  return [...map.values()];
}

async function cargarHistorialConfig() {
  return parseHistorialConfig(await getMeta(HISTORIAL_CONFIG_META));
}

async function cargarHistorialDiasFiltrados() {
  const cfg = await cargarHistorialConfig();
  const dias = parseHistorialDias(await getMeta(HISTORIAL_DIAS_META))
    .map(normalizarDiaHistorial)
    .filter(Boolean);
  const filtrados = filtrarDiasPorRetencion(dias, cfg.retencionDias).sort((a, b) =>
    b.fecha.localeCompare(a.fecha)
  );
  if (filtrados.length !== dias.length) {
    await setMeta(HISTORIAL_DIAS_META, JSON.stringify(filtrados));
  }
  return { dias: filtrados, config: cfg };
}

app.get(
  '/api/historial-entregas/config',
  asyncHandler(authMiddleware),
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const config = await cargarHistorialConfig();
    res.json({ config });
  })
);

app.put(
  '/api/historial-entregas/config',
  asyncHandler(authMiddleware),
  requireAdmin,
  asyncHandler(async (req, res) => {
    const config = parseHistorialConfig(
      JSON.stringify({ retencionDias: req.body?.retencionDias })
    );
    await setMeta(HISTORIAL_CONFIG_META, JSON.stringify(config));
    const { dias } = await cargarHistorialDiasFiltrados();
    res.json({ ok: true, config, dias });
  })
);

app.get(
  '/api/historial-entregas',
  asyncHandler(authMiddleware),
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const { dias, config } = await cargarHistorialDiasFiltrados();
    res.json({ dias, config });
  })
);

app.put(
  '/api/historial-entregas',
  asyncHandler(authMiddleware),
  requireAdmin,
  asyncHandler(async (req, res) => {
    const incoming = Array.isArray(req.body?.dias) ? req.body.dias : null;
    if (!incoming) {
      res.status(400).json({ error: 'Se esperaba dias: []' });
      return;
    }
    const cfg = await cargarHistorialConfig();
    const actuales = parseHistorialDias(await getMeta(HISTORIAL_DIAS_META))
      .map(normalizarDiaHistorial)
      .filter(Boolean);
    const normalizados = incoming.map(normalizarDiaHistorial).filter(Boolean);
    const fusionados = fusionarDiasHistorialServidor(actuales, normalizados);
    const dias = filtrarDiasPorRetencion(fusionados, cfg.retencionDias).sort((a, b) =>
      b.fecha.localeCompare(a.fecha)
    );
    await setMeta(HISTORIAL_DIAS_META, JSON.stringify(dias));
    res.json({ ok: true, dias, config: cfg });
  })
);

/** Cualquier usuario autenticado puede upsert del día al cerrar entregas. */
app.post(
  '/api/historial-entregas/dia',
  asyncHandler(authMiddleware),
  asyncHandler(async (req, res) => {
    const dia = normalizarDiaHistorial(req.body?.dia);
    if (!dia) {
      res.status(400).json({ error: 'Día de historial inválido' });
      return;
    }
    const cfg = await cargarHistorialConfig();
    const actuales = parseHistorialDias(await getMeta(HISTORIAL_DIAS_META))
      .map(normalizarDiaHistorial)
      .filter(Boolean);
    // No borrar un día con datos si llega un resumen vacío.
    if (!diaHistorialTieneActividad(dia)) {
      const prev = actuales.find((d) => d.fecha === dia.fecha);
      if (prev && diaHistorialTieneActividad(prev)) {
        res.json({ ok: true, dia: prev, config: cfg, conservado: true });
        return;
      }
    }
    const sinEste = actuales.filter((d) => d.fecha !== dia.fecha);
    dia.actualizadoEn = Math.floor(Date.now() / 1000);
    const dias = filtrarDiasPorRetencion([...sinEste, dia], cfg.retencionDias).sort((a, b) =>
      b.fecha.localeCompare(a.fecha)
    );
    await setMeta(HISTORIAL_DIAS_META, JSON.stringify(dias));
    res.json({ ok: true, dia, config: cfg });
  })
);

// --- Medios de pago (tienda + personal por mensajero) ---

app.get(
  '/api/payment-config/me',
  asyncHandler(authMiddleware),
  asyncHandler(async (req, res) => {
    const tienda = await getStorePaymentConfig();
    if (req.user.role === 'admin') {
      res.json({
        role: 'admin',
        tienda,
        personal: tienda,
        usarMediosTienda: false,
        effective: tienda,
      });
      return;
    }
    const usuario = await getUserPaymentSettings(req.user.id);
    const effective = resolveEffectivePaymentConfig(usuario, tienda);
    res.json({
      role: 'mensajero',
      tienda,
      personal: usuario.personal,
      usarMediosTienda: usuario.usarMediosTienda,
      effective,
    });
  })
);

app.put(
  '/api/payment-config/me',
  asyncHandler(authMiddleware),
  asyncHandler(async (req, res) => {
    if (req.user.role !== 'mensajero') {
      res.status(403).json({ error: 'Solo mensajeros configuran medios personales aquí' });
      return;
    }
    const usarMediosTienda = !!req.body?.usarMediosTienda;
    const personal = parsePaymentConfig(req.body?.personal || {});
    const tienda = await getStorePaymentConfig();
    if (usarMediosTienda) {
      if (!paymentConfigListo(tienda)) {
        res.status(400).json({
          error: 'La tienda aún no tiene medios de pago configurados. Pide al administrador que los complete.',
        });
        return;
      }
    } else {
      const err = validatePaymentConfig(personal);
      if (err) {
        res.status(400).json({ error: err });
        return;
      }
    }
    await setUserPaymentSettings(req.user.id, { personal, usarMediosTienda });
    const effective = resolveEffectivePaymentConfig({ personal, usarMediosTienda }, tienda);
    res.json({ ok: true, personal, usarMediosTienda, tienda, effective });
  })
);

app.get(
  '/api/payment-config/tienda',
  asyncHandler(authMiddleware),
  requireAdmin,
  asyncHandler(async (_req, res) => {
    res.json({ tienda: await getStorePaymentConfig() });
  })
);

app.put(
  '/api/payment-config/tienda',
  asyncHandler(authMiddleware),
  requireAdmin,
  asyncHandler(async (req, res) => {
    const tienda = parsePaymentConfig(req.body?.tienda || req.body || {});
    const err = validatePaymentConfig(tienda);
    if (err) {
      res.status(400).json({ error: err });
      return;
    }
    await setStorePaymentConfig(tienda);
    res.json({ ok: true, tienda });
  })
);

// --- Users (admin) ---

app.get('/api/users', asyncHandler(authMiddleware), requireAdmin, asyncHandler(async (_req, res) => {
  res.json({ users: await enrichUsersList(await listUsers()) });
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
    const user = await enrichUserPublic(await createUser(username, email, hash, role));
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
    const target = await getUserById(id);
    if (!target) {
      res.status(404).json({ error: 'Usuario no encontrado' });
      return;
    }

    const tieneRole = Object.prototype.hasOwnProperty.call(req.body || {}, 'role');
    const tienePermValor = Object.prototype.hasOwnProperty.call(req.body || {}, 'puedeModificarValor');
    if (!tieneRole && !tienePermValor) {
      res.status(400).json({ error: 'Indica role y/o puedeModificarValor' });
      return;
    }

    if (tieneRole) {
      if (id === req.user.id) {
        res.status(400).json({ error: 'No puedes cambiar tu propio rol desde aquí' });
        return;
      }
      const role = String(req.body?.role || '');
      if (!['admin', 'mensajero'].includes(role)) {
        res.status(400).json({ error: 'Rol inválido' });
        return;
      }
      await updateUserRole(id, role);
      if (role !== 'mensajero') {
        await setPuedeModificarValor(id, false);
      }
    }

    if (tienePermValor) {
      const actualizado = await getUserById(id);
      const roleFinal = actualizado ? actualizado.role : target.role;
      if (roleFinal !== 'mensajero') {
        await setPuedeModificarValor(id, false);
      } else {
        await setPuedeModificarValor(id, !!req.body.puedeModificarValor);
      }
    }

    res.json({ user: await enrichUserPublic(await getUserById(id)) });
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
  const lastRev = Number((await getMeta('orders_client_rev_v1')) || '0') || 0;
  res.json(await buildOrdersResponseForUser(req.user, { clientRevision: lastRev }));
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
    await withOrdersWriteLock(async () => {
      const clientRev = Number(req.body?.clientRevision);
      const lastRev = Number((await getMeta('orders_client_rev_v1')) || '0') || 0;
      if (Number.isFinite(clientRev) && clientRev > 0 && clientRev < lastRev) {
        res.status(409).json({
          error: 'Hay una versión más nueva de los pedidos en el servidor',
          code: 'STALE_ORDERS',
          lastRevision: lastRev,
        });
        return;
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
      if (Number.isFinite(clientRev) && clientRev > 0) {
        await setMeta('orders_client_rev_v1', String(Math.floor(clientRev)));
      }
      res.json(
        await buildOrdersResponseForUser(req.user, {
          clientRevision: Number.isFinite(clientRev) && clientRev > 0 ? Math.floor(clientRev) : lastRev,
        })
      );
    });
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
    const existingRows = await getAllOrdersRows();
    const existingIds = new Set(existingRows.map((r) => Number(r.id)));
    for (const p of orders) {
      if (!p || p.id == null) continue;
      const id = Number(p.id);
      if (!existingIds.has(id)) continue;
      if (String(p.assignedTo || '') !== uid) continue;
      await upsertOrderRow(id, p);
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
app.use(
  express.static(staticDir, {
    setHeaders(res, filePath) {
      if (String(filePath).endsWith(`${path.sep}sw.js`) || String(filePath).endsWith('/sw.js')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Service-Worker-Allowed', '/');
      }
    },
  })
);

app.use((req, res) => {
  if (req.path.startsWith('/api')) {
    res.status(404).json({ error: 'No encontrado' });
    return;
  }
  res.sendFile(path.join(staticDir, 'index.html'));
});

module.exports = app;
