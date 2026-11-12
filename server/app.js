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
  deleteOrderRow,
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
const TIENDA_ID_DEFAULT = 'tienda-principal';

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

function pedidoDesdeFila(row) {
  const p = parsePayloadRow(row);
  if (!p) return null;
  if (!String(p.tiendaId || '').trim()) p.tiendaId = TIENDA_ID_DEFAULT;
  const rowId = Number(row && row.id);
  const sid = Number(p.storageId);
  if (!Number.isFinite(sid) || sid <= 0) {
    p.storageId = Number.isFinite(rowId) ? rowId : Number(p.id);
  }
  return p;
}

function idAlmacenPedidoServidor(p, row) {
  const sid = Number(p && p.storageId);
  if (Number.isFinite(sid) && sid > 0) return sid;
  const rowId = Number(row && row.id);
  if (Number.isFinite(rowId) && rowId > 0) return rowId;
  const id = Number(p && p.id);
  return Number.isFinite(id) ? id : NaN;
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

function claveRutaMensajero(uid) {
  return `route_u${uid}`;
}

function claveRutaRevMensajero(uid) {
  return `route_rev_u${uid}`;
}

async function leerRutaMensajero(uid) {
  let route = [];
  try {
    route = JSON.parse((await getMeta(claveRutaMensajero(uid))) || '[]');
  } catch (_e) {
    route = [];
  }
  if (!Array.isArray(route)) return [];
  return route.map((id) => Number(id)).filter((id) => Number.isFinite(id));
}

async function escribirRutaMensajero(uid, route) {
  const clean = (route || []).map((id) => Number(id)).filter((id) => Number.isFinite(id));
  await setMeta(claveRutaMensajero(uid), JSON.stringify(clean));
}

async function leerRutaRevMensajero(uid) {
  return Math.max(0, Math.floor(Number((await getMeta(claveRutaRevMensajero(uid))) || '0') || 0));
}

async function escribirRutaRevMensajero(uid, rev) {
  await setMeta(claveRutaRevMensajero(uid), String(Math.max(0, Math.floor(Number(rev) || 0))));
}

async function leerOrderIndexAdmin() {
  let orderIndex = [];
  try {
    orderIndex = JSON.parse((await getMeta('order_index')) || '[]');
  } catch (_e) {
    orderIndex = [];
  }
  if (!Array.isArray(orderIndex)) return [];
  return orderIndex.map((id) => Number(id)).filter((id) => Number.isFinite(id));
}

async function idsAsignadosMensajero(uid) {
  const mine = new Set();
  const rows = await getAllOrdersRows();
  for (const row of rows) {
    if (row.id == null) continue;
    const p = parsePayloadRow(row);
    if (!p) continue;
    if (String(p.assignedTo || '') === String(uid)) mine.add(Number(row.id));
  }
  return mine;
}

async function listarAsignadosMensajero(uid) {
  const rows = await getAllOrdersRows();
  const out = [];
  for (const row of rows) {
    const p = pedidoDesdeFila(row);
    if (!p) continue;
    if (String(p.assignedTo || '') !== String(uid)) continue;
    const rowId = Number(row.id);
    if (!Number.isFinite(rowId) || rowId <= 0) continue;
    out.push({ rowId, pedido: p });
  }
  return out;
}

function resolverFilaAsignada(asignados, raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const porAlmacen = asignados.filter((a) => a.rowId === n || Number(a.pedido.storageId) === n);
  if (porAlmacen.length >= 1) return porAlmacen[0].rowId;
  const porNumero = asignados.filter((a) => Number(a.pedido.id) === n);
  if (porNumero.length === 1) return porNumero[0].rowId;
  return null;
}

function clavePedidoServidor(p) {
  const id = Number(p && p.id);
  if (!Number.isFinite(id) || id <= 0) return '';
  const tid = String((p && p.tiendaId) || '').trim() || 'principal';
  return `${tid}::${id}`;
}

/**
 * Conserva el orden que ya tiene el mensajero.
 * Los pedidos recién asignados se agregan al final, sin repetir el mismo pedido.
 */
async function sincronizarRutaMensajeroConservandoOrden(uid) {
  const asignados = await listarAsignadosMensajero(uid);
  const adminOrder = await leerOrderIndexAdmin();
  const prev = await leerRutaMensajero(uid);
  const route = [];
  const seen = new Set();
  const push = (raw) => {
    const id = resolverFilaAsignada(asignados, raw);
    if (id == null || seen.has(id)) return;
    seen.add(id);
    route.push(id);
  };
  for (const id of prev) push(id);
  for (const id of adminOrder) push(id);
  for (const item of asignados) push(item.rowId);
  await escribirRutaMensajero(uid, route);
  return route;
}

async function quitarIdDeRutaMensajero(uid, orderId) {
  const id = Number(orderId);
  if (!Number.isFinite(id)) return;
  const route = (await leerRutaMensajero(uid)).filter((x) => x !== id);
  await escribirRutaMensajero(uid, route);
}

async function podarRutasMensajeros(idsVigentes) {
  const keep = new Set(
    (idsVigentes || []).map((id) => Number(id)).filter((id) => Number.isFinite(id))
  );
  const users = await listUsers();
  for (const u of users) {
    if (!u || u.role !== 'mensajero') continue;
    const route = await leerRutaMensajero(u.id);
    const filtered = route.filter((id) => keep.has(id));
    if (filtered.length !== route.length) {
      await escribirRutaMensajero(u.id, filtered);
    }
  }
}

async function buildOrdersResponseForUser(user, extra = {}) {
  const rows = await getAllOrdersRows();
  const byId = new Map();
  for (const row of rows) {
    const p = pedidoDesdeFila(row);
    if (p && p.id != null) byId.set(Number(row.id), p);
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
    for (const [id, p] of byId) {
      if (seen.has(id)) continue;
      ordered.push(p);
      seen.add(id);
    }
    return { orders: ordered, orderIndex: ordered.map((p) => idAlmacenPedidoServidor(p)), ...extra };
  }

  const asignados = await listarAsignadosMensajero(user.id);
  const byRow = new Map(asignados.map((item) => [item.rowId, item.pedido]));
  const routeIds = await leerRutaMensajero(user.id);

  const ordered = [];
  const seenRow = new Set();
  const seenClave = new Set();
  const pushPedido = (rowId) => {
    if (rowId == null || seenRow.has(rowId)) return;
    const p = byRow.get(rowId);
    if (!p) return;
    const clave = clavePedidoServidor(p);
    if (!clave || seenClave.has(clave)) return;
    seenRow.add(rowId);
    seenClave.add(clave);
    ordered.push(p);
  };
  for (const rawId of routeIds) pushPedido(resolverFilaAsignada(asignados, rawId));
  for (const rawId of orderIndex) pushPedido(resolverFilaAsignada(asignados, rawId));
  for (const item of asignados) pushPedido(item.rowId);

  let routeNotice = null;
  try {
    routeNotice = JSON.parse((await getMeta(`route_notice_u${user.id}`)) || 'null');
  } catch (_e) {
    routeNotice = null;
  }

  const routeRevision = await leerRutaRevMensajero(user.id);
  return {
    orders: ordered,
    orderIndex: ordered.map((p) => idAlmacenPedidoServidor(p)),
    routeNotice,
    routeRevision,
    ...extra,
  };
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

const TARIFA_PAGO_MENSAJERO_HISTORIAL = 12000;

function idTiendaDiaHistorial(d) {
  const id = String((d && d.tiendaId) || '').trim();
  return id || TIENDA_ID_DEFAULT;
}

function claveDiaHistorial(d) {
  if (!d || !d.fecha) return '';
  return `${d.fecha}::${idTiendaDiaHistorial(d)}`;
}

function normalizarPedidoHistorialSnap(p) {
  if (!p || typeof p !== 'object') return null;
  const id = Number(p.id);
  if (!Number.isFinite(id)) return null;
  const estado = String(p.estado || '').trim();
  const estadosOk = new Set(['entregado', 'devuelto', 'sin_entregar']);
  const snap = {
    id,
    tiendaId: String(p.tiendaId || TIENDA_ID_DEFAULT),
    nombre: String(p.nombre || '').trim().slice(0, 120),
    estado: estadosOk.has(estado) ? estado : 'entregado',
    montoNequi: Math.max(0, Number(p.montoNequi) || 0),
    montoDaviplata: Math.max(0, Number(p.montoDaviplata) || 0),
    montoEfectivo: Math.max(0, Number(p.montoEfectivo) || 0),
  };
  if (p.valor != null && Number.isFinite(Number(p.valor))) {
    snap.valor = Math.max(0, Number(p.valor));
  }
  if (p.pagaMensajero != null) snap.pagaMensajero = !!p.pagaMensajero;
  const sid = Number(p.storageId);
  if (Number.isFinite(sid) && sid > 0) snap.storageId = sid;
  return snap;
}

function metricasDesdePedidosHistorial(pedidos) {
  const lista = Array.isArray(pedidos) ? pedidos : [];
  let entregados = 0;
  let devueltos = 0;
  let sinEntregar = 0;
  let pagadosNequi = 0;
  let recogidoTotal = 0;
  let recogidoEfectivo = 0;
  let recogidoNequi = 0;
  let recogidoDaviplata = 0;
  let pagos = 0;
  for (const p of lista) {
    if (!p) continue;
    if (p.estado === 'devuelto') devueltos += 1;
    else if (p.estado === 'sin_entregar') sinEntregar += 1;
    else entregados += 1;
    if (p.estado === 'entregado') {
      const tieneValor = p.valor != null && Number.isFinite(Number(p.valor));
      const valor = tieneValor
        ? Number(p.valor)
        : Number(p.montoNequi || 0) + Number(p.montoDaviplata || 0) + Number(p.montoEfectivo || 0);
      recogidoTotal += valor;
      recogidoEfectivo += Number(p.montoEfectivo || 0);
      recogidoNequi += Number(p.montoNequi || 0);
      recogidoDaviplata += Number(p.montoDaviplata || 0);
      if (Number(p.montoNequi || 0) > 0) pagadosNequi += 1;
    }
    const paga =
      p.pagaMensajero != null
        ? !!p.pagaMensajero
        : p.estado === 'entregado' || p.estado === 'devuelto';
    if (paga) pagos += 1;
  }
  const pagadoMensajero = pagos * TARIFA_PAGO_MENSAJERO_HISTORIAL;
  return {
    entregados,
    devueltos,
    sinEntregar,
    pagadosNequi,
    recogidoTotal,
    recogidoEfectivo,
    recogidoNequi,
    recogidoDaviplata,
    pagadoMensajero,
    aEntregarTienda: Math.max(recogidoTotal - pagadoMensajero, 0),
  };
}

function resumenGuardadoMensajero(m) {
  if (!m || !m.resumenGuardado || typeof m.resumenGuardado !== 'object') return null;
  const r = m.resumenGuardado;
  const pagadoMensajero = Math.max(0, Number(r.pagadoMensajero) || 0);
  const recogidoTotal = Math.max(0, Number(r.recogidoTotal) || 0);
  return {
    entregados: Math.max(0, Number(r.entregados) || 0),
    devueltos: Math.max(0, Number(r.devueltos) || 0),
    sinEntregar: Math.max(0, Number(r.sinEntregar) || 0),
    pagadosNequi: Math.max(0, Number(r.pagadosNequi) || 0),
    recogidoTotal,
    recogidoEfectivo: Math.max(0, Number(r.recogidoEfectivo) || 0),
    recogidoNequi: Number(r.recogidoNequi) || 0,
    recogidoDaviplata: Number(r.recogidoDaviplata) || 0,
    pagadoMensajero,
    aEntregarTienda: Math.max(0, recogidoTotal - pagadoMensajero),
  };
}

function metricasDeBucketHistorial(m) {
  return resumenGuardadoMensajero(m) || metricasDesdePedidosHistorial(m && m.pedidos);
}

function sumarMetricasHistorial(base, delta, signo) {
  const keys = [
    'entregados',
    'devueltos',
    'sinEntregar',
    'pagadosNequi',
    'recogidoTotal',
    'recogidoEfectivo',
    'recogidoNequi',
    'recogidoDaviplata',
    'pagadoMensajero',
  ];
  const out = {};
  for (const k of keys) {
    out[k] = Number(base[k] || 0) + signo * Number(delta[k] || 0);
  }
  out.aEntregarTienda = Math.max(0, out.recogidoTotal - out.pagadoMensajero);
  return out;
}

function normalizarMensajeroHistorial(m) {
  if (!m || typeof m !== 'object') return null;
  const userId =
    m.userId == null || String(m.userId).trim() === '' ? null : String(m.userId).trim();
  const pedidos = Array.isArray(m.pedidos)
    ? m.pedidos.map(normalizarPedidoHistorialSnap).filter(Boolean)
    : [];
  const resumen = resumenGuardadoMensajero(m);
  return {
    userId,
    nombre: String(m.nombre || (userId ? `Usuario ${userId}` : 'Sin asignar')).trim().slice(0, 80),
    entregados: Math.max(0, Number(m.entregados) || 0),
    pedidos,
    ...(resumen ? { resumenGuardado: resumen } : {}),
  };
}

/** Vista del repartidor: solo sus pedidos y sus totales. */
function diaHistorialParaMensajero(dia, userId) {
  if (!dia) return null;
  const uid = String(userId);
  const propios = (dia.porMensajero || []).filter((m) => m && String(m.userId || '') === uid);
  if (propios.length === 0) return null;
  const pedidos = propios.flatMap((m) => (Array.isArray(m.pedidos) ? m.pedidos : []));
  const metricas = metricasDesdePedidosHistorial(pedidos);
  return {
    ...dia,
    ...metricas,
    porMensajero: propios,
  };
}

/**
 * El mensajero actualiza solo su parte del día.
 * El resto de repartidores y la duración del historial no cambian.
 */
function fusionarDiaConAporteMensajero(prev, incoming, userId, nombreFallback) {
  const uid = String(userId);
  let propios = (incoming.porMensajero || []).filter((m) => m && String(m.userId || '') === uid);
  if (propios.length === 0 && Array.isArray(incoming.porMensajero) && incoming.porMensajero.length > 0) {
    propios = incoming.porMensajero.map((m) => ({ ...m, userId: uid }));
  }
  const pedidos = propios.flatMap((m) => (Array.isArray(m.pedidos) ? m.pedidos : []));
  const metricas = metricasDesdePedidosHistorial(pedidos);
  const bucket = normalizarMensajeroHistorial({
    userId: uid,
    nombre: (propios[0] && propios[0].nombre) || nombreFallback || `Mensajero ${uid}`,
    entregados: metricas.entregados,
    pedidos,
    resumenGuardado: metricas,
  });
  const anteriores = prev && Array.isArray(prev.porMensajero) ? prev.porMensajero : [];
  const previoPropio = anteriores.find((m) => m && String(m.userId || '') === uid) || null;
  const otros = anteriores.filter((m) => m && String(m.userId || '') !== uid);
  const porMensajero = bucket && bucket.pedidos.length > 0 ? [...otros, bucket] : otros;
  const oldM = previoPropio ? metricasDeBucketHistorial(previoPropio) : metricasDesdePedidosHistorial([]);
  const base = prev
    ? {
        entregados: prev.entregados,
        devueltos: prev.devueltos,
        sinEntregar: prev.sinEntregar,
        pagadosNequi: prev.pagadosNequi,
        recogidoTotal: prev.recogidoTotal,
        recogidoEfectivo: prev.recogidoEfectivo,
        recogidoNequi: prev.recogidoNequi,
        recogidoDaviplata: prev.recogidoDaviplata,
        pagadoMensajero: prev.pagadoMensajero,
      }
    : metricasDesdePedidosHistorial([]);
  const totales = prev ? sumarMetricasHistorial(sumarMetricasHistorial(base, oldM, -1), metricas, 1) : metricas;
  return normalizarDiaHistorial({
    fecha: incoming.fecha,
    tiendaId: incoming.tiendaId,
    ...totales,
    porMensajero,
    actualizadoEn: Math.floor(Date.now() / 1000),
  });
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
    tiendaId: idTiendaDiaHistorial(d),
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
    const key = claveDiaHistorial(d);
    if (key) map.set(key, d);
  }
  for (const d of incoming || []) {
    if (!d || !d.fecha) continue;
    const key = claveDiaHistorial(d);
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
  asyncHandler(async (req, res) => {
    const { dias, config } = await cargarHistorialDiasFiltrados();
    if (req.user && req.user.role === 'mensajero') {
      const propios = dias
        .map((d) => diaHistorialParaMensajero(d, req.user.id))
        .filter(Boolean);
      res.json({ dias: propios, config, alcance: 'propio' });
      return;
    }
    if (!req.user || req.user.role !== 'admin') {
      res.status(403).json({ error: 'No autorizado' });
      return;
    }
    res.json({ dias, config, alcance: 'todos' });
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
    const prev = actuales.find((d) => claveDiaHistorial(d) === claveDiaHistorial(dia)) || null;
    let diaGuardado = dia;
    if (req.user && req.user.role === 'mensajero') {
      // No reemplaza el día completo: solo su parte. La retención la define el admin.
      diaGuardado = fusionarDiaConAporteMensajero(
        prev,
        dia,
        req.user.id,
        req.user.username
      );
      if (!diaGuardado) {
        res.status(400).json({ error: 'Día de historial inválido' });
        return;
      }
      if (!diaHistorialTieneActividad(diaGuardado) && prev && diaHistorialTieneActividad(prev)) {
        res.json({ ok: true, dia: prev, config: cfg, conservado: true });
        return;
      }
    } else if (!diaHistorialTieneActividad(dia) && prev && diaHistorialTieneActividad(prev)) {
      // No borrar un día con datos si llega un resumen vacío.
      res.json({ ok: true, dia: prev, config: cfg, conservado: true });
      return;
    }
    const sinEste = actuales.filter((d) => claveDiaHistorial(d) !== claveDiaHistorial(dia));
    diaGuardado.actualizadoEn = Math.floor(Date.now() / 1000);
    const dias = filtrarDiasPorRetencion([...sinEste, diaGuardado], cfg.retencionDias).sort((a, b) =>
      b.fecha.localeCompare(a.fecha)
    );
    await setMeta(HISTORIAL_DIAS_META, JSON.stringify(dias));
    const diaRespuesta =
      req.user && req.user.role === 'mensajero'
        ? diaHistorialParaMensajero(diaGuardado, req.user.id) || diaGuardado
        : diaGuardado;
    res.json({ ok: true, dia: diaRespuesta, config: cfg });
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

// --- Tiendas (para quién trabaja el usuario) ---
const TIENDAS_META_KEY = 'tiendas_v1';
const TIENDA_ACTIVA_META_KEY = 'usuario_tienda_activa_v1';
const TIENDA_DEFAULT = { id: TIENDA_ID_DEFAULT, nombre: 'Tienda principal' };

function parseJsonMeta(raw, fallback) {
  try {
    const v = JSON.parse(String(raw || ''));
    return v && typeof v === 'object' ? v : fallback;
  } catch (_e) {
    return fallback;
  }
}

const TELEFONO_CONFIRMACION_DEFAULT = '3213153165';

function normalizarTelefonoConfirmacion(raw) {
  return String(raw || '').replace(/\D/g, '').slice(0, 15);
}

function serializarTiendaCatalogo(t) {
  const id = String(t && t.id ? t.id : '').trim();
  const nombre = String(t && t.nombre ? t.nombre : '').trim();
  let telefonoConfirmacion = normalizarTelefonoConfirmacion(t && t.telefonoConfirmacion);
  if (!telefonoConfirmacion && id === TIENDA_ID_DEFAULT) {
    telefonoConfirmacion = TELEFONO_CONFIRMACION_DEFAULT;
  }
  return { id, nombre, telefonoConfirmacion };
}

async function asegurarCatalogoTiendas() {
  const data = parseJsonMeta(await getMeta(TIENDAS_META_KEY), null);
  if (data && Array.isArray(data.tiendas) && data.tiendas.length) {
    const tiendas = data.tiendas.map(serializarTiendaCatalogo).filter((t) => t.id && t.nombre);
    if (tiendas.length) {
      return { tiendas, defaultId: data.defaultId || tiendas[0].id };
    }
  }
  const inicial = {
    tiendas: [serializarTiendaCatalogo(TIENDA_DEFAULT)],
    defaultId: TIENDA_DEFAULT.id,
  };
  await setMeta(TIENDAS_META_KEY, JSON.stringify(inicial));
  return inicial;
}

async function mapaTiendaActivaUsuarios() {
  const raw = parseJsonMeta(await getMeta(TIENDA_ACTIVA_META_KEY), {});
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

app.get(
  '/api/tiendas',
  asyncHandler(authMiddleware),
  asyncHandler(async (req, res) => {
    const catalogo = await asegurarCatalogoTiendas();
    const mapa = await mapaTiendaActivaUsuarios();
    const uid = String(req.user.id);
    let activaId = String(mapa[uid] || catalogo.defaultId || catalogo.tiendas[0].id);
    if (!catalogo.tiendas.some((t) => t.id === activaId)) {
      activaId = catalogo.defaultId || catalogo.tiendas[0].id;
    }
    res.json({
      tiendas: catalogo.tiendas,
      defaultId: catalogo.defaultId,
      tiendaActivaId: activaId,
    });
  })
);

app.post(
  '/api/tiendas',
  asyncHandler(authMiddleware),
  requireAdmin,
  asyncHandler(async (req, res) => {
    const nombre = String(req.body?.nombre || '').trim();
    if (nombre.length < 2) {
      res.status(400).json({ error: 'Indica un nombre de tienda (mínimo 2 caracteres).' });
      return;
    }
    const catalogo = await asegurarCatalogoTiendas();
    const repetida = catalogo.tiendas.some(
      (t) => String(t.nombre).toLowerCase() === nombre.toLowerCase()
    );
    if (repetida) {
      res.status(400).json({ error: 'Ya hay una tienda con ese nombre.' });
      return;
    }
    const id = `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const telefonoConfirmacion = normalizarTelefonoConfirmacion(req.body?.telefonoConfirmacion);
    catalogo.tiendas.push({ id, nombre, telefonoConfirmacion });
    await setMeta(TIENDAS_META_KEY, JSON.stringify(catalogo));
    const mapa = await mapaTiendaActivaUsuarios();
    mapa[String(req.user.id)] = id;
    await setMeta(TIENDA_ACTIVA_META_KEY, JSON.stringify(mapa));
    const tienda = serializarTiendaCatalogo({ id, nombre, telefonoConfirmacion });
    res.status(201).json({
      ok: true,
      tienda,
      tiendas: catalogo.tiendas,
      tiendaActivaId: id,
    });
  })
);

app.put(
  '/api/tiendas/activa',
  asyncHandler(authMiddleware),
  asyncHandler(async (req, res) => {
    const catalogo = await asegurarCatalogoTiendas();
    const id = String(req.body?.id || '').trim();
    if (!catalogo.tiendas.some((t) => t.id === id)) {
      res.status(400).json({ error: 'Esa tienda no existe.' });
      return;
    }
    const mapa = await mapaTiendaActivaUsuarios();
    mapa[String(req.user.id)] = id;
    await setMeta(TIENDA_ACTIVA_META_KEY, JSON.stringify(mapa));
    res.json({ ok: true, tiendaActivaId: id, tiendas: catalogo.tiendas });
  })
);

app.put(
  '/api/tiendas/:id',
  asyncHandler(authMiddleware),
  requireAdmin,
  asyncHandler(async (req, res) => {
    const catalogo = await asegurarCatalogoTiendas();
    const id = String(req.params.id || '').trim();
    const ix = catalogo.tiendas.findIndex((t) => String(t.id) === id);
    if (ix < 0) {
      res.status(400).json({ error: 'Esa tienda no existe.' });
      return;
    }
    const actual = catalogo.tiendas[ix];
    const nombre = String(req.body?.nombre != null ? req.body.nombre : actual.nombre || '').trim();
    if (nombre.length < 2) {
      res.status(400).json({ error: 'Indica un nombre de tienda (mínimo 2 caracteres).' });
      return;
    }
    const telefonoConfirmacion = normalizarTelefonoConfirmacion(req.body?.telefonoConfirmacion);
    if (telefonoConfirmacion && (telefonoConfirmacion.length < 10 || telefonoConfirmacion.length > 15)) {
      res.status(400).json({ error: 'El número de confirmación debe tener entre 10 y 15 dígitos.' });
      return;
    }
    const repetida = catalogo.tiendas.some(
      (t) => String(t.id) !== id && String(t.nombre).toLowerCase() === nombre.toLowerCase()
    );
    if (repetida) {
      res.status(400).json({ error: 'Ya hay una tienda con ese nombre.' });
      return;
    }
    catalogo.tiendas[ix] = serializarTiendaCatalogo({
      ...actual,
      nombre,
      telefonoConfirmacion,
    });
    await setMeta(TIENDAS_META_KEY, JSON.stringify(catalogo));
    res.json({ ok: true, tienda: catalogo.tiendas[ix], tiendas: catalogo.tiendas });
  })
);

app.delete(
  '/api/tiendas/:id',
  asyncHandler(authMiddleware),
  requireAdmin,
  asyncHandler(async (req, res) => {
    const catalogo = await asegurarCatalogoTiendas();
    const id = String(req.params.id || '').trim();
    if (!catalogo.tiendas.some((t) => String(t.id) === id)) {
      res.status(400).json({ error: 'Esa tienda no existe.' });
      return;
    }
    if (catalogo.tiendas.length <= 1) {
      res.status(400).json({ error: 'Debe quedar al menos una tienda.' });
      return;
    }
    catalogo.tiendas = catalogo.tiendas.filter((t) => String(t.id) !== id);
    if (!catalogo.tiendas.some((t) => String(t.id) === String(catalogo.defaultId))) {
      catalogo.defaultId = catalogo.tiendas[0].id;
    }
    await setMeta(TIENDAS_META_KEY, JSON.stringify(catalogo));
    const mapa = await mapaTiendaActivaUsuarios();
    const fallback = catalogo.defaultId || catalogo.tiendas[0].id;
    let mapaCambio = false;
    for (const uid of Object.keys(mapa)) {
      if (String(mapa[uid]) === id) {
        mapa[uid] = fallback;
        mapaCambio = true;
      }
    }
    if (mapaCambio) await setMeta(TIENDA_ACTIVA_META_KEY, JSON.stringify(mapa));
    const uid = String(req.user.id);
    let activaId = String(mapa[uid] || fallback);
    if (!catalogo.tiendas.some((t) => String(t.id) === activaId)) activaId = fallback;
    res.json({
      ok: true,
      tiendas: catalogo.tiendas,
      tiendaActivaId: activaId,
    });
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

async function marcarCatalogoPedidosActualizado() {
  await setMeta('orders_updated_ms', String(Date.now()));
}

app.get('/api/orders', asyncHandler(authMiddleware), asyncHandler(async (req, res) => {
  const lastRev = Number((await getMeta('orders_client_rev_v1')) || '0') || 0;
  const updatedAt = Number((await getMeta('orders_updated_ms')) || '0') || 0;
  res.json(await buildOrdersResponseForUser(req.user, { clientRevision: lastRev, updatedAt }));
}));

app.delete(
  '/api/orders/:id',
  asyncHandler(authMiddleware),
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json({ error: 'Id de pedido inválido' });
      return;
    }
    const rows = await getAllOrdersRows();
    const row = rows.find((r) => Number(r.id) === id);
    if (!row) {
      res.status(404).json({ error: 'Pedido no encontrado' });
      return;
    }
    const pedido = pedidoDesdeFila(row) || {};
    const esAdmin = req.user.role === 'admin';
    const esDueno = String(pedido.assignedTo || '') === String(req.user.id);
    if (!esAdmin && !esDueno) {
      res.status(403).json({ error: 'No puedes eliminar este pedido' });
      return;
    }
    await deleteOrderRow(id);
    let orderIndex = [];
    try {
      orderIndex = JSON.parse((await getMeta('order_index')) || '[]');
    } catch (_e) {
      orderIndex = [];
    }
    if (!Array.isArray(orderIndex)) orderIndex = [];
    orderIndex = orderIndex.map((x) => Number(x)).filter((x) => Number.isFinite(x) && x !== id);
    await setMeta('order_index', JSON.stringify(orderIndex));
    if (pedido.assignedTo) await quitarIdDeRutaMensajero(pedido.assignedTo, id);
    const lastRev = Number((await getMeta('orders_client_rev_v1')) || '0') || 0;
    await setMeta('orders_client_rev_v1', String(lastRev + 1));
    await marcarCatalogoPedidosActualizado();
    res.json({ ok: true });
  })
);

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
      orderIndex = orders.map((p) => idAlmacenPedidoServidor(p));
    }
    await withOrdersWriteLock(async () => {
      const clientRev = Number(req.body?.clientRevision);
      const lastRev = Number((await getMeta('orders_client_rev_v1')) || '0') || 0;
      const clientUpdatedAt = Number(req.body?.clientUpdatedAt) || 0;
      const serverUpdatedAt = Number((await getMeta('orders_updated_ms')) || '0') || 0;
      if (
        (Number.isFinite(clientRev) && clientRev > 0 && clientRev < lastRev) ||
        (serverUpdatedAt && clientUpdatedAt && clientUpdatedAt + 1500 < serverUpdatedAt)
      ) {
        res.status(409).json({
          error: 'Hay una versión más nueva de los pedidos en el servidor',
          code: 'STALE_ORDERS',
          lastRevision: lastRev,
          updatedAt: serverUpdatedAt,
        });
        return;
      }
      const rows = orders
        .filter((p) => p && p.id != null && Number.isFinite(Number(p.id)))
        .map((p) => {
          if (!String(p.tiendaId || '').trim()) p.tiendaId = TIENDA_ID_DEFAULT;
          const almacen = idAlmacenPedidoServidor(p);
          p.storageId = almacen;
          return {
            id: almacen,
            payload: JSON.stringify(p),
          };
        })
        .filter((r) => Number.isFinite(r.id) && r.id > 0);
      await replaceAllOrders(rows);
      const idsVigentes = orderIndex.map((oid) => Number(oid)).filter(Number.isFinite);
      await setMeta('order_index', JSON.stringify(idsVigentes));
      await podarRutasMensajeros(idsVigentes);
      const nextRev = Math.max(
        Number.isFinite(clientRev) && clientRev > 0 ? Math.floor(clientRev) : 0,
        lastRev + 1
      );
      await setMeta('orders_client_rev_v1', String(nextRev));
      await marcarCatalogoPedidosActualizado();
      res.json(
        await buildOrdersResponseForUser(req.user, {
          clientRevision: nextRev,
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
      orderIndex = orders.map((p) => idAlmacenPedidoServidor(p));
    }
    const uid = String(req.user.id);
    const existingRows = await getAllOrdersRows();
    const existingIds = new Set(existingRows.map((r) => Number(r.id)));
    for (const p of orders) {
      if (!p || p.id == null) continue;
      const id = idAlmacenPedidoServidor(p);
      if (!existingIds.has(id)) continue;
      if (String(p.assignedTo || '') !== uid) continue;
      if (!String(p.tiendaId || '').trim()) p.tiendaId = TIENDA_ID_DEFAULT;
      p.storageId = id;
      await upsertOrderRow(id, p);
    }
    const mine = await idsAsignadosMensajero(uid);
    const clientRoute = orderIndex
      .map((oid) => Number(oid))
      .filter((oid) => Number.isFinite(oid) && mine.has(oid));
    const seen = new Set(clientRoute);
    const prevRoute = await leerRutaMensajero(uid);
    const clientRev = Math.max(0, Math.floor(Number(req.body?.routeRevision) || 0));
    const serverRev = await leerRutaRevMensajero(uid);
    if (clientRev >= serverRev) {
      for (const id of prevRoute) {
        if (!mine.has(id) || seen.has(id)) continue;
        clientRoute.push(id);
        seen.add(id);
      }
      const adminOrder = await leerOrderIndexAdmin();
      for (const id of adminOrder) {
        if (!mine.has(id) || seen.has(id)) continue;
        clientRoute.push(id);
        seen.add(id);
      }
      for (const id of mine) {
        if (seen.has(id)) continue;
        clientRoute.push(id);
        seen.add(id);
      }
      await escribirRutaMensajero(uid, clientRoute);
      await escribirRutaRevMensajero(uid, Math.max(clientRev, serverRev));
    } else {
      await sincronizarRutaMensajeroConservandoOrden(uid);
    }
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
    const prevAssigned = p.assignedTo == null || String(p.assignedTo).trim() === '' ? null : String(p.assignedTo).trim();
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

    if (prevAssigned && prevAssigned !== String(p.assignedTo || '')) {
      await quitarIdDeRutaMensajero(prevAssigned, orderId);
    }
    if (p.assignedTo) {
      await sincronizarRutaMensajeroConservandoOrden(p.assignedTo);
    }
    await marcarCatalogoPedidosActualizado();
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
    const prevPorPedido = new Map();
    for (const raw of orderIds) {
      const id = Number(raw);
      if (!Number.isFinite(id)) continue;
      const r = byId.get(id);
      if (!r) continue;
      const p = parsePayloadRow(r);
      if (!p) continue;
      const prev =
        p.assignedTo == null || String(p.assignedTo).trim() === '' ? null : String(p.assignedTo).trim();
      prevPorPedido.set(id, prev);
      p.assignedTo = String(uid);
      await upsertOrderRow(id, p);
    }
    const otros = new Set();
    for (const prev of prevPorPedido.values()) {
      if (prev && prev !== String(uid)) otros.add(prev);
    }
    for (const otroUid of otros) {
      await sincronizarRutaMensajeroConservandoOrden(otroUid);
    }
    await sincronizarRutaMensajeroConservandoOrden(uid);
    await marcarCatalogoPedidosActualizado();

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
    const asignados = await listarAsignadosMensajero(userId);
    const incoming = [];
    const seenIncoming = new Set();
    for (const raw of filtered) {
      const id = resolverFilaAsignada(asignados, raw);
      if (id == null || seenIncoming.has(id)) continue;
      seenIncoming.add(id);
      incoming.push(id);
    }
    const prev = [];
    const seenPrev = new Set();
    for (const raw of await leerRutaMensajero(userId)) {
      const id = resolverFilaAsignada(asignados, raw);
      if (id == null || seenPrev.has(id)) continue;
      seenPrev.add(id);
      prev.push(id);
    }
    const incomingSet = new Set(incoming);
    const existentes = incoming.filter((id) => seenPrev.has(id));
    const nuevos = incoming.filter((id) => !seenPrev.has(id));
    const merged = [];
    const seen = new Set();
    let cursor = 0;
    for (const id of prev) {
      if (incomingSet.has(id)) {
        const next = existentes[cursor++];
        if (next != null && !seen.has(next)) {
          merged.push(next);
          seen.add(next);
        }
      } else if (!seen.has(id)) {
        merged.push(id);
        seen.add(id);
      }
    }
    for (const id of nuevos) {
      if (seen.has(id)) continue;
      merged.push(id);
      seen.add(id);
    }
    for (const item of asignados) {
      if (seen.has(item.rowId)) continue;
      merged.push(item.rowId);
      seen.add(item.rowId);
    }
    await escribirRutaMensajero(userId, merged);
    const prevRev = await leerRutaRevMensajero(userId);
    await escribirRutaRevMensajero(userId, prevRev + 1);

    const notice = {
      at: Date.now(),
      by: req.user ? { id: req.user.id, username: req.user.username } : null,
      message: String(req.body?.message || 'Un administrador modificó el orden de tus pedidos.'),
    };
    await setMeta(`route_notice_u${userId}`, JSON.stringify(notice));
    res.json({ ok: true, userId: String(userId), count: merged.length });
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
