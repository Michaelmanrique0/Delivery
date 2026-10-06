let pedidos = [];
let mapa = null;
let marcadores = [];
let rutaLayer = null;
let mapaAjustado = false;
/** Evita repetir el mismo aviso de ubicaciones cercanas en cada refresco del mapa. */
let firmaUltimoAvisoUbicacionesCercanas = '';
/** Debounce y cancelación para cálculo de ruta. */
let rutaRedrawTimer = null;
let rutaAbortController = null;
let nextPedidoId = 1;
let vistaPedidosActual = 'pendientes';
let vistaPedidosSeleccionadaManual = false;
const TELEFONO_SOPORTE = '3213153165';
/** Pedidos en este dispositivo (sin login). */
const CACHE_PEDIDOS_KEY = 'cachePedidos_v1';
/** Misma clave que antes; datos por usuario vivían en `cachePedidos_v1_<uuid>`. */
const CACHE_PEDIDOS_LEGACY_KEY = 'cachePedidos_v1';

/** Token legacy (una sola clave); se migra a token por usuario. */
const AUTH_TOKEN_LEGACY_KEY = 'deliveryAuthToken';
/** Usuario cuya sesión está activa en esta pestaña/navegador. */
const AUTH_ACTIVE_USER_KEY = 'deliveryAuthActiveUserId';
/** Id del usuario dueño del token activo (redundante con AUTH_ACTIVE_USER_KEY). */
const AUTH_USER_ID_KEY = 'deliveryAuthUserId';
/** Copia local de la sesión para entrar sin internet. */
const SESION_USUARIO_CACHE_KEY = 'deliverySesionUsuario_v1';

function authTokenStorageKey(userId) {
  return `deliveryAuthToken_${userId}`;
}
/** Pestaña auth guardada al recargar: `login` | `registro` (solo sessionStorage). */
const AUTH_TAB_SESSION_KEY = 'deliveryAuthTab';
/** Vista principal de la app tras recargar la pestaña (solo admin: usuarios y roles). */
const VISTA_APP_SESSION_KEY = 'deliveryVistaApp';
/** Usuario admin que abrió la vista guardada en sessionStorage. */
const VISTA_APP_USER_SESSION_KEY = 'deliveryVistaAppUserId';
const VISTA_APP_USUARIOS_ROLES = 'usuarios-roles';
const VISTA_APP_HISTORIAL_ENTREGAS = 'historial-entregas';
const HISTORIAL_ENTREGAS_CACHE_KEY = 'deliveryHistorialEntregas_v1';
const HISTORIAL_RETENCION_CACHE_KEY = 'deliveryHistorialRetencionDias_v1';
const HISTORIAL_RETENCION_DEFAULT_DIAS = 30;
/** Mismo id que el `<style>` inyectado en `index.html` antes del primer pintado. */
const PRE_RESTORE_USUARIOS_ROLES_STYLE_ID = 'preRestoreUsuariosRolesStyle';
let sesionUsuario = null;
let syncRemotoTimer = null;
/** Evita que un sync viejo pise cambios más recientes o que un refresh borre lo local. */
let syncPedidosEnCurso = false;
let syncPedidosRepetir = false;
const PEDIDOS_SYNC_PENDING_KEY = 'deliveryPedidosSyncPending_v1';
const PEDIDOS_REV_KEY = 'deliveryPedidosRev_v1';
/** Revisión local monotónica: evita que un PUT viejo gane a uno nuevo. */
let pedidosLocalRev = 0;
/** Lista de mensajeros para asignación (solo admin). */
let listaMensajerosCache = [];

function esSesionAdmin() {
  return !!sesionUsuario && sesionUsuario.role === 'admin';
}

function esSesionMensajero() {
  return !!sesionUsuario && sesionUsuario.role === 'mensajero';
}

/** Mensajero autorizado por admin a revisar/editar el valor del pedido. */
function mensajeroPuedeModificarValorPedido() {
  return esSesionMensajero() && !!sesionUsuario?.puedeModificarValor;
}

function appEstaOnline() {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

function guardarSesionUsuarioCache(user) {
  try {
    if (!user || user.id == null) {
      localStorage.removeItem(SESION_USUARIO_CACHE_KEY);
      return;
    }
    localStorage.setItem(
      SESION_USUARIO_CACHE_KEY,
      JSON.stringify({
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        puedeModificarValor: !!user.puedeModificarValor,
      })
    );
  } catch (_e) {}
}

function cargarSesionUsuarioCache() {
  try {
    const raw = localStorage.getItem(SESION_USUARIO_CACHE_KEY);
    if (!raw) return null;
    const u = JSON.parse(raw);
    if (!u || u.id == null) return null;
    return u;
  } catch (_e) {
    return null;
  }
}

/** Usuario mínimo desde el JWT local (sin validar firma). Solo para no perder la sesión si /api/me falla. */
function leerUsuarioBasicoDesdeToken(token) {
  try {
    const part = String(token || '').split('.')[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const json = JSON.parse(atob(b64));
    const id = json.sub != null ? json.sub : json.id;
    if (id == null) return null;
    return {
      id,
      username: json.username || 'Usuario',
      email: json.email || '',
      role: json.role === 'admin' ? 'admin' : 'mensajero',
    };
  } catch (_e) {
    return null;
  }
}

/** Restaura sesión local sin borrar el token. El cierre solo ocurre con el botón Salir. */
async function entrarConSesionLocalSiHayToken(token) {
  if (!token) return false;
  const cachedUser = cargarSesionUsuarioCache();
  const cachedUid = getAuthUserId() || (cachedUser ? String(cachedUser.id) : '');
  if (cachedUser && cachedUid && String(cachedUser.id) === cachedUid) {
    await entrarAppConSesion(cachedUser);
    return true;
  }
  const fromJwt = leerUsuarioBasicoDesdeToken(token);
  if (fromJwt) {
    if (cachedUser && String(cachedUser.id) === String(fromJwt.id)) {
      await entrarAppConSesion({ ...fromJwt, ...cachedUser });
    } else {
      await entrarAppConSesion(fromJwt);
    }
    return true;
  }
  return false;
}

function actualizarBannerOffline() {
  const banner = document.getElementById('bannerOffline');
  if (!banner) return;
  const offline = !appEstaOnline();
  banner.style.display = offline ? 'block' : 'none';
  banner.classList.toggle('is-visible', offline);
}

function configurarSoporteOfflineApp() {
  if (configurarSoporteOfflineApp._listo) return;
  configurarSoporteOfflineApp._listo = true;
  actualizarBannerOffline();
  window.addEventListener('online', () => {
    actualizarBannerOffline();
    mostrarToast('Conexión recuperada. Sincronizando…', 'success', 4000);
    void reintentarSyncTrasRecuperarConexion();
  });
  window.addEventListener('offline', () => {
    actualizarBannerOffline();
    mostrarToast('Sin internet. Seguirás viendo los pedidos guardados aquí.', 'warning', 6000);
  });
}

async function reintentarSyncTrasRecuperarConexion() {
  if (!sesionUsuario || !appEstaOnline()) return;
  try {
    if (hayPedidosSyncPendiente()) {
      await syncPedidosAlServidor();
    }
  } catch (e) {
    console.error(e);
  }
  try {
    if (!hayPedidosSyncPendiente()) {
      await refrescarPedidosDesdeApi();
      renderPedidos();
      actualizarMarcadores();
    }
  } catch (e) {
    console.error(e);
  }
  try {
    await refrescarPaymentConfigDesdeServidor();
  } catch (_e) {}
  if (esSesionAdmin()) {
    try {
      await cargarMensajerosParaAsignacion();
    } catch (_e) {}
  }
}

function getAuthActiveUserId() {
  try {
    return localStorage.getItem(AUTH_ACTIVE_USER_KEY) || '';
  } catch (_e) {
    return '';
  }
}

function getAuthToken() {
  try {
    const activeId = getAuthActiveUserId();
    if (activeId) {
      return localStorage.getItem(authTokenStorageKey(activeId)) || '';
    }
    return localStorage.getItem(AUTH_TOKEN_LEGACY_KEY) || '';
  } catch (_e) {
    return '';
  }
}

function setAuthToken(token, userId) {
  try {
    if (token && userId != null && userId !== '') {
      const uid = String(userId);
      localStorage.setItem(authTokenStorageKey(uid), token);
      localStorage.setItem(AUTH_ACTIVE_USER_KEY, uid);
      localStorage.setItem(AUTH_USER_ID_KEY, uid);
      localStorage.removeItem(AUTH_TOKEN_LEGACY_KEY);
    } else {
      const activeId = getAuthActiveUserId();
      if (activeId) localStorage.removeItem(authTokenStorageKey(activeId));
      localStorage.removeItem(AUTH_ACTIVE_USER_KEY);
      localStorage.removeItem(AUTH_USER_ID_KEY);
      localStorage.removeItem(AUTH_TOKEN_LEGACY_KEY);
    }
  } catch (_e) {}
}

function getAuthUserId() {
  return getAuthActiveUserId();
}

function migrarTokenLegacySiHaceFalta(userId) {
  try {
    const legacy = localStorage.getItem(AUTH_TOKEN_LEGACY_KEY);
    if (!legacy || !userId) return;
    const uid = String(userId);
    if (!localStorage.getItem(authTokenStorageKey(uid))) {
      localStorage.setItem(authTokenStorageKey(uid), legacy);
    }
    localStorage.setItem(AUTH_ACTIVE_USER_KEY, uid);
    localStorage.setItem(AUTH_USER_ID_KEY, uid);
    localStorage.removeItem(AUTH_TOKEN_LEGACY_KEY);
  } catch (_e) {}
}

function getCachePedidosStorageKey() {
  const uid = sesionUsuario?.id || getAuthActiveUserId();
  if (!uid) return CACHE_PEDIDOS_KEY;
  return `${CACHE_PEDIDOS_KEY}_${uid}`;
}

function getPedidosSyncPendingKey() {
  const uid = sesionUsuario?.id || getAuthActiveUserId();
  if (!uid) return PEDIDOS_SYNC_PENDING_KEY;
  return `${PEDIDOS_SYNC_PENDING_KEY}_${uid}`;
}

function getPedidosRevKey() {
  const uid = sesionUsuario?.id || getAuthActiveUserId();
  if (!uid) return PEDIDOS_REV_KEY;
  return `${PEDIDOS_REV_KEY}_${uid}`;
}

function hayPedidosSyncPendiente() {
  try {
    return localStorage.getItem(getPedidosSyncPendingKey()) === '1';
  } catch (_e) {
    return false;
  }
}

function marcarPedidosSyncPendiente(pendiente) {
  try {
    const key = getPedidosSyncPendingKey();
    if (pendiente) localStorage.setItem(key, '1');
    else localStorage.removeItem(key);
  } catch (_e) {}
}

function cargarPedidosLocalRev() {
  try {
    pedidosLocalRev = Math.max(0, Math.floor(Number(localStorage.getItem(getPedidosRevKey()) || '0') || 0));
  } catch (_e) {
    pedidosLocalRev = 0;
  }
  return pedidosLocalRev;
}

function bumpPedidosLocalRev() {
  cargarPedidosLocalRev();
  pedidosLocalRev += 1;
  try {
    localStorage.setItem(getPedidosRevKey(), String(pedidosLocalRev));
  } catch (_e) {}
  return pedidosLocalRev;
}

async function apiFetch(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  const t = getAuthToken();
  if (t) headers.Authorization = `Bearer ${t}`;
  if (options.body && typeof options.body === 'string' && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  return fetch(path, { ...options, headers });
}

async function apiJson(path, options = {}) {
  const res = await apiFetch(path, options);
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_e) {
    data = { error: text || 'Respuesta inválida' };
  }
  if (!res.ok) {
    const msg = (data && data.error) || res.statusText || 'Error';
    const err = new Error(msg);
    err.status = res.status;
    if (data && data.code) err.code = data.code;
    if (data && data.detail) err.detail = data.detail;
    throw err;
  }
  return data;
}

function programarSyncPedidosRemoto() {
  if (!sesionUsuario) return;
  if (!appEstaOnline()) return;
  if (syncPedidosEnCurso) {
    syncPedidosRepetir = true;
    return;
  }
  if (syncRemotoTimer) clearTimeout(syncRemotoTimer);
  syncRemotoTimer = setTimeout(() => {
    syncRemotoTimer = null;
    if (!appEstaOnline()) return;
    syncPedidosAlServidor().catch((e) => {
      console.error(e);
    });
  }, 450);
}

async function forzarSyncPedidosAhora() {
  if (!sesionUsuario || !appEstaOnline()) return;
  if (syncRemotoTimer) {
    clearTimeout(syncRemotoTimer);
    syncRemotoTimer = null;
  }
  await syncPedidosAlServidor();
}

function flushSyncPedidosAlSalir() {
  if (syncRemotoTimer) {
    clearTimeout(syncRemotoTimer);
    syncRemotoTimer = null;
  }
  if (!sesionUsuario || !appEstaOnline() || !hayPedidosSyncPendiente()) return;
  try {
    const token = getAuthToken();
    if (!token || !esSesionAdmin()) {
      void syncPedidosAlServidor().catch((e) => console.error(e));
      return;
    }
    const revEnviada = pedidosLocalRev || cargarPedidosLocalRev();
    const orders = JSON.parse(JSON.stringify(pedidos || []));
    const body = JSON.stringify({
      orders,
      orderIndex: orders.map((p) => p.id),
      clientRevision: revEnviada,
    });
    void fetch('/api/orders', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body,
      keepalive: true,
      credentials: 'same-origin',
    })
      .then((r) => {
        const revAhora = pedidosLocalRev || cargarPedidosLocalRev();
        // Solo quitar pendiente si no hubo cambios más nuevos mientras el PUT viajaba.
        if (r && r.ok && revEnviada === revAhora) marcarPedidosSyncPendiente(false);
      })
      .catch((e) => console.error(e));
  } catch (e) {
    console.error(e);
    void syncPedidosAlServidor().catch((err) => console.error(err));
  }
}

function hayAlgunModalAbierto() {
  const nodos = document.querySelectorAll(
    '.modal-no-entregado-backdrop, #modalDecision, #modalPagoEntregado, #modalConfigNotificacion'
  );
  for (const el of nodos) {
    if (el && el.style && el.style.display === 'flex') return true;
  }
  return false;
}

function configurarRefrescoPedidosMensajero() {
  if (configurarRefrescoPedidosMensajero._listo) return;
  configurarRefrescoPedidosMensajero._listo = true;
  window.setInterval(() => {
    if (!esSesionMensajero() || !appEstaOnline()) return;
    if (document.visibilityState === 'hidden') return;
    if (hayAlgunModalAbierto()) return;
    const antes = pedidos.map((p) => Number(p.id)).join(',');
    refrescarPedidosDesdeApi()
      .then(() => {
        const despues = pedidos.map((p) => Number(p.id)).join(',');
        if (antes === despues) return;
        renderPedidos();
        actualizarMarcadores();
      })
      .catch((e) => console.error(e));
  }, 4000);
}

function configurarFlushSyncPedidosAlSalir() {
  if (configurarFlushSyncPedidosAlSalir._listo) return;
  configurarFlushSyncPedidosAlSalir._listo = true;
  window.addEventListener('pagehide', flushSyncPedidosAlSalir);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushSyncPedidosAlSalir();
  });
}

function setAppLoadingVisible(visible, mensaje) {
  const el = document.getElementById('appLoadingOverlay');
  if (!el) return;
  const texto = el.querySelector('.app-loading-text');
  if (texto && mensaje) texto.textContent = String(mensaje);
  if (texto && !visible && !mensaje) {
    texto.textContent = 'Cargando pedidos, por favor espera...';
  }
  el.style.display = visible ? 'flex' : 'none';
  el.setAttribute('aria-hidden', visible ? 'false' : 'true');
}

async function mostrarLoadingYEsperarPintado(mensaje) {
  setAppLoadingVisible(true, mensaje || 'Cargando pedidos, por favor espera...');
  // Dos frames: permite que el overlay se pinte antes del trabajo pesado (crear tarjetas).
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

function nombreMensajeroPorId(userId) {
  if (userId == null || userId === '') return '';
  const m = listaMensajerosCache.find((x) => String(x.id) === String(userId));
  return m && m.username ? String(m.username) : '';
}

async function syncPedidosAlServidor() {
  if (!sesionUsuario) return;
  if (syncPedidosEnCurso) {
    syncPedidosRepetir = true;
    return;
  }
  syncPedidosEnCurso = true;
  try {
    do {
      syncPedidosRepetir = false;
      const revAlEnviar = pedidosLocalRev || cargarPedidosLocalRev();
      const orders = JSON.parse(JSON.stringify(pedidos || []));
      const orderIndex = orders.map((p) => p.id);
      try {
        if (esSesionAdmin()) {
          await apiJson('/api/orders', {
            method: 'PUT',
            body: JSON.stringify({ orders, orderIndex, clientRevision: revAlEnviar }),
          });
        } else {
          await apiJson('/api/orders/messenger', {
            method: 'PUT',
            body: JSON.stringify({ orders, orderIndex }),
          });
        }
      } catch (e) {
        if (e && e.code === 'STALE_ORDERS') {
          bumpPedidosLocalRev();
          syncPedidosRepetir = true;
          continue;
        }
        throw e;
      }
      if (revAlEnviar !== (pedidosLocalRev || cargarPedidosLocalRev())) {
        syncPedidosRepetir = true;
      }
    } while (syncPedidosRepetir);
    if (!syncPedidosRepetir) marcarPedidosSyncPendiente(false);
  } catch (e) {
    marcarPedidosSyncPendiente(true);
    throw e;
  } finally {
    syncPedidosEnCurso = false;
    if (syncPedidosRepetir && hayPedidosSyncPendiente()) {
      syncPedidosRepetir = false;
      window.setTimeout(() => {
        void syncPedidosAlServidor().catch((err) => console.error(err));
      }, 0);
    }
  }
}

function aplicarPedidosDesdeServidor(raw) {
  pedidos = deduplicarPedidosPorId((Array.isArray(raw) ? raw : []).map(normalizarPedidoEnMemoria));
  if (pedidos.length > 0) {
    nextPedidoId = Math.max(...pedidos.map((p) => p.id), 0) + 1;
  } else {
    nextPedidoId = 1;
  }
  guardarCachePedidos();
}

function avisarCambioOrdenSiHaceFalta(data) {
  if (!data || !data.routeNotice || !data.routeNotice.at) return;
  const at = Number(data.routeNotice.at) || 0;
  const key = `delivery_route_notice_seen_u${sesionUsuario ? sesionUsuario.id : '0'}`;
  let prev = 0;
  try { prev = Number(localStorage.getItem(key) || '0') || 0; } catch (_e) { prev = 0; }
  if (at > prev) {
    const msg = String(data.routeNotice.message || 'Se modificó el orden de tus pedidos.');
    mostrarToast(msg, 'info', 9000);
    try { localStorage.setItem(key, String(at)); } catch (_e) {}
  }
}

async function refrescarPedidosDesdeApi() {
  if (esSesionAdmin()) {
    if (hayPedidosSyncPendiente()) {
      await syncPedidosAlServidor();
      return;
    }
    const data = await apiJson('/api/orders', { method: 'GET' });
    if (hayPedidosSyncPendiente()) return;
    const serverRev = Number(data.clientRevision || 0) || 0;
    const localRev = pedidosLocalRev || cargarPedidosLocalRev();
    // Solo el admin puede subir su lista local si el servidor quedó atrás.
    if (localRev > 0 && serverRev < localRev) {
      marcarPedidosSyncPendiente(true);
      await syncPedidosAlServidor();
      return;
    }
    aplicarPedidosDesdeServidor(data.orders);
    marcarPedidosSyncPendiente(false);
    avisarCambioOrdenSiHaceFalta(data);
    return;
  }

  // Mensajero: el admin define qué pedidos existen. No reenviar los que ya se eliminaron.
  const data = await apiJson('/api/orders', { method: 'GET' });
  const delServidor = deduplicarPedidosPorId(
    (Array.isArray(data.orders) ? data.orders : []).map(normalizarPedidoEnMemoria)
  );
  if (hayPedidosSyncPendiente()) {
    const local = deduplicarPedidosPorId((cargarCachePedidos() || []).map(normalizarPedidoEnMemoria));
    const localPorId = new Map(local.map((p) => [Number(p.id), p]));
    let huboCambioLocal = false;
    pedidos = delServidor.map((p) => {
      const loc = localPorId.get(Number(p.id));
      if (!loc) return p;
      huboCambioLocal = true;
      return loc;
    });
    if (pedidos.length > 0) {
      nextPedidoId = Math.max(...pedidos.map((p) => p.id), 0) + 1;
    } else {
      nextPedidoId = 1;
    }
    guardarCachePedidos();
    if (huboCambioLocal) {
      marcarPedidosSyncPendiente(true);
      await syncPedidosAlServidor();
    } else {
      marcarPedidosSyncPendiente(false);
    }
  } else {
    aplicarPedidosDesdeServidor(delServidor);
    marcarPedidosSyncPendiente(false);
  }
  avisarCambioOrdenSiHaceFalta(data);
}

function escapeHtmlAttr(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Texto en HTML (tarjetas, popups), sin comillas para atributos. */
function escapeHtmlTexto(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function lineasProductosDesdeArray(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return [];
  return arr
    .map((p) => String(p || '').trim())
    .filter((p) => p.length > 0 && !/^cambio\.?$/i.test(p) && !esLineaPlantillaPedidoNoProducto(p));
}

/** Quita emojis/tonos de piel al inicio de línea (📍, 🙋🏻, etc.). */
function quitarPrefijoEmojiLinea(s) {
  let L = String(s || '').trim();
  for (let i = 0; i < 4; i++) {
    const next = L
      .replace(/^[\u200B-\u200D\uFEFF\uFE0F]+/g, '')
      .replace(
        /^(?:\p{Extended_Pictographic}|\p{Emoji_Presentation})(?:\u{1F3FB}|\u{1F3FC}|\u{1F3FD}|\u{1F3FE}|\u{1F3FF})?\uFE0F?(?:\u200D(?:\p{Extended_Pictographic}|\p{Emoji_Presentation})(?:\u{1F3FB}|\u{1F3FC}|\u{1F3FD}|\u{1F3FE}|\u{1F3FF})?\uFE0F?)*\s*/u,
        ''
      )
      .trim();
    if (next === L) break;
    L = next;
  }
  return L;
}

/**
 * Productos = solo lo que hay entre la línea "Producto(s)" y "¿Todo en orden?".
 */
function extraerProductosSoloDelBloque(bloque) {
  const text = String(bloque || '').replace(/\r\n/g, '\n');
  if (!text.trim()) return [];

  // Busca el último bloque Producto … ¿Todo en orden?
  const re = /(?:^|\n)[ \t]*Producto(?:s)?\b[^\n]*\n([\s\S]*?)(?=\n[ \t]*¿?\s*Todo\s+en\s+orden\b|$)/gi;
  let m;
  let chunk = '';
  while ((m = re.exec(text))) chunk = m[1] || '';
  if (!chunk) {
    // Respaldo: encabezado y producto en la misma línea
    const m2 = text.match(/(?:^|\n)[ \t]*Producto(?:s)?\b[^\n]*:\s*([^\n]+)/i);
    if (m2 && m2[1]) {
      const one = quitarPrefijoEmojiLinea(m2[1]);
      if (one && !esLineaResiduoGuiaNoProducto(one)) return [one];
    }
    return [];
  }

  const out = [];
  for (const raw of chunk.split('\n')) {
    let L = String(raw || '').trim();
    if (!L) continue;
    L = L.replace(/^\*+\s*/, '').replace(/\s*\*+$/, '');
    L = L.replace(/^[•\u2022\-\*]\s*/, '').replace(/^\d+[\.)]\s+/, '').trim();
    L = quitarPrefijoEmojiLinea(L);
    if (!L || /^[\uD800-\uDFFF]+$/.test(L)) continue;
    if (esLineaResiduoGuiaNoProducto(L)) continue;
    out.push(L);
  }
  return out;
}

/** Líneas que nunca deben aparecer como producto. */
function esLineaResiduoGuiaNoProducto(linea) {
  const L = quitarPrefijoEmojiLinea(
    String(linea || '')
      .trim()
      .replace(/^[*_~`•\u2022\-]+\s*/, '')
  );
  if (!L) return true;
  if (/^https?:/i.test(L)) return true;
  if (/^¿?\s*Todo\s+en\s+orden\b/i.test(L)) return true;
  if (/^Para\s+agilizar\b/i.test(L)) return true;
  if (/^Env[ií]o\b/i.test(L)) return true;
  if (/^Horario\b/i.test(L)) return true;
  if (/^\d+\s*:\s*$/.test(L)) return true;
  if (
    /^(?:Direcci[oó]n|Ubicaci[oó]n|Nombre|Tel[ée]fono|Celular|WhatsApp|M[oó]vil|Valor|Total|A\s+recoger|Por\s+cobrar|Recaudo|Pago|N[uú]mero)\b/i.test(
      L
    )
  ) {
    return true;
  }
  if (/recibir[aá]\s+el\s+pedido/i.test(L)) return true;
  if (/^quien\s+recib/i.test(L)) return true;
  if (/barrio\s+y\s+localidad/i.test(L)) return true;
  if (/^[\d\s+().-]{7,}$/.test(L) && L.replace(/\D/g, '').length >= 7) return true;
  if (/^\$?\s*[\d.,]+\s*$/.test(L)) return true;
  if (/^(?:Producto|Productos)\b/i.test(L) && !/:\s*\S/.test(L)) return true;
  if (/^(?:calle|carrera|cra\.?|cl\.?|kr\.?|av\.?|avenida|diagonal|transversal|tv\.?|conjunto)\b/i.test(L)) {
    return true;
  }
  return false;
}

function esLineaPlantillaPedidoNoProducto(linea) {
  return esLineaResiduoGuiaNoProducto(linea);
}

/** Solo "Valor a pagar" / "Valor a recoger". Nunca el $12.000 del Envío. */
function extraerValorAPagarDesdeBloque(bloque) {
  const text = String(bloque || '').replace(/\r\n/g, '\n');
  // Preferencia estricta: Valor a pagar / Valor a recoger
  let m = text.match(/Valor\s+a\s+pagar[^\n]*:\s*\n?[ \t]*([\d.,]+)/i);
  if (m) {
    const d = m[1].replace(/[^\d]/g, '');
    if (d) return d;
  }
  m = text.match(/Valor\s+a\s+recoger[^\n]*:\s*\n?[ \t]*([\d.,]+)/i);
  if (m) {
    const d = m[1].replace(/[^\d]/g, '');
    if (d) return d;
  }
  // 💰 Valor… (sin Envío)
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i].trim();
    if (/Env[ií]o/i.test(L)) continue;
    if (!/💰/.test(L) || !/\bValor\b/i.test(L)) continue;
    const mMisma = L.match(/:\s*\$?\s*([\d.,]+)/);
    if (mMisma) {
      const d = mMisma[1].replace(/[^\d]/g, '');
      if (d) return d;
    }
    for (let j = i + 1; j < lines.length; j++) {
      const n = lines[j].trim();
      if (!n) continue;
      if (/Env[ií]o|Horario|Producto|Todo\s+en\s+orden/i.test(n)) break;
      const d = n.replace(/[^\d]/g, '');
      if (d) return d;
      break;
    }
  }
  return null;
}

const PARSER_PEDIDOS_BUILD = '20260825f';

function lineasProductosPedidoNormalizadas(pedido) {
  return lineasProductosDesdeArray(pedido && pedido.productos);
}

/** Texto multilínea (p. ej. modal editar) → array `productos` del pedido. */
function productosPedidoDesdeTextoPlano(texto) {
  return lineasProductosDesdeArray(String(texto || '').split(/\r?\n/));
}

/** Un renglón por producto (WhatsApp / texto plano). */
function textoProductosEntregaParaSoporte(pedido) {
  const lineas = lineasProductosPedidoNormalizadas(pedido);
  if (lineas.length === 0) return 'No especificado';
  return lineas.join('\n');
}

/** Un renglón por producto en HTML (<br>), para tarjetas y mapa. */
function htmlProductosPedidoMultilinea(pedido) {
  const lineas = lineasProductosPedidoNormalizadas(pedido);
  if (lineas.length === 0) return 'No especificado';
  return lineas.map((t) => escapeHtmlTexto(t)).join('<br>');
}

function htmlProductosArrayMultilinea(productos) {
  const lineas = lineasProductosDesdeArray(productos);
  if (lineas.length === 0) return 'No especificado';
  return lineas.map((t) => escapeHtmlTexto(t)).join('<br>');
}

/**
 * Avisos flotantes desactivados a petición: no mostrar mensajes en esquina.
 * Las confirmaciones importantes siguen en modales / WhatsApp.
 */
function mostrarToast(_mensaje, _tipo = 'info', _duracionMs = 5200) {
  return;
}

function scrollToTopApp() {
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function scrollToMapaApp() {
  const el = document.getElementById('sectionMapaEntregas');
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  window.setTimeout(() => {
    try {
      if (mapa && typeof mapa.invalidateSize === 'function') mapa.invalidateSize();
    } catch (_e) {}
  }, 450);
}

let fabNavegacionScrollRaf = null;

function seccionMapaEstaEnVista() {
  const el = document.getElementById('sectionMapaEntregas');
  if (!el) return false;
  const r = el.getBoundingClientRect();
  const vh = window.innerHeight || 1;
  const overlap = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
  if (overlap < vh * 0.18) return false;
  return r.top < vh * 0.72 && r.bottom > vh * 0.2;
}

function actualizarVisibilidadFabNavegacion() {
  const fabUp = document.getElementById('fabNavegacionArriba');
  const fabMap = document.getElementById('fabNavegacionMapa');
  const y = window.scrollY ?? document.documentElement.scrollTop ?? 0;
  const margenArriba = 48;
  if (fabUp) {
    const mostrar = y > margenArriba;
    fabUp.classList.toggle('fab-app-btn--hidden', !mostrar);
    fabUp.setAttribute('aria-hidden', mostrar ? 'false' : 'true');
  }
  if (fabMap) {
    const enMapa = seccionMapaEstaEnVista();
    fabMap.classList.toggle('fab-app-btn--hidden', enMapa);
    fabMap.setAttribute('aria-hidden', enMapa ? 'true' : 'false');
  }
}

function programarActualizacionFabNavegacion() {
  if (fabNavegacionScrollRaf != null) return;
  fabNavegacionScrollRaf = requestAnimationFrame(() => {
    fabNavegacionScrollRaf = null;
    actualizarVisibilidadFabNavegacion();
  });
}

function configurarFabNavegacionScroll() {
  const run = () => programarActualizacionFabNavegacion();
  window.addEventListener('scroll', run, { passive: true });
  window.addEventListener('resize', run, { passive: true });
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(run).catch(() => {});
  }
  requestAnimationFrame(() => {
    run();
    window.setTimeout(run, 320);
  });
}

function exponerDebugAppDelivery() {
  try {
    window.__appDelivery = {
      recargarPedidos: () => {
        cargarPedidosDesdeLocalStorage();
        renderPedidos();
      },
    };
  } catch (_e) {}
}

function migrarCachePedidosDesdeClavesAntiguas() {
  if (!sesionUsuario?.id) return;
  try {
    const userKey = getCachePedidosStorageKey();
    if (localStorage.getItem(userKey)) return;
    const legacyUserKey = `${CACHE_PEDIDOS_LEGACY_KEY}_${sesionUsuario.id}`;
    const legacyUser = localStorage.getItem(legacyUserKey);
    if (legacyUser) {
      localStorage.setItem(userKey, legacyUser);
    }
  } catch (_e) {}
}

/** Normaliza texto tipo UUID en asignaciones legacy (import). */
function normalizarUuidAsignacion(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  return s.toLowerCase();
}

function limpiarCachePedidosLocal() {
  try {
    const userKey = getCachePedidosStorageKey();
    if (userKey) localStorage.removeItem(userKey);
    if (sesionUsuario?.id) {
      localStorage.removeItem(`${CACHE_PEDIDOS_LEGACY_KEY}_${sesionUsuario.id}`);
    }
  } catch (_e) {}
}
const CONFIG_NOTIFICACION_AYUDA_DEFAULT =
  'Configura tus medios de pago personales o marca la opción de usar los de la tienda. Se incluyen en el WhatsApp al notificar al cliente.';

/** Si el usuario guardó la config y luego intenta notificar, se reanuda el envío. */
let notificacionEnCaminoPendienteTrasConfig = null;

let paymentConfigEstado = {
  personal: mediosPagoVacio(),
  usarMediosTienda: false,
  tienda: mediosPagoVacio(),
  effective: mediosPagoVacio(),
};

function mediosPagoVacio() {
  return {
    tieneNequi: false,
    tieneDaviplata: false,
    numeroNequi: '',
    numeroDaviplata: '',
    nombreTitular: '',
    tieneLlave: false,
    llavePago: '',
  };
}

function boolConfigNotificacion(valor, predeterminado) {
  if (typeof valor === 'boolean') return valor;
  if (typeof valor === 'string') {
    const normalizado = valor.trim().toLowerCase();
    if (normalizado === 'false') return false;
    if (normalizado === 'true') return true;
  }
  return predeterminado;
}

function parsearMediosPagoCliente(cfg) {
  const g = cfg && typeof cfg === 'object' ? cfg : {};
  const legacyNum = String(g.numeroDigital || '').replace(/\D/g, '');
  let numeroNequi = String(g.numeroNequi || '').replace(/\D/g, '');
  let numeroDaviplata = String(g.numeroDaviplata || '').replace(/\D/g, '');
  if (!numeroNequi && legacyNum) numeroNequi = legacyNum;
  if (!numeroDaviplata && legacyNum) numeroDaviplata = legacyNum;
  return {
    tieneNequi: boolConfigNotificacion(g.tieneNequi, false),
    tieneDaviplata: boolConfigNotificacion(g.tieneDaviplata, false),
    numeroNequi,
    numeroDaviplata,
    nombreTitular: String(g.nombreTitular || '').trim(),
    tieneLlave: boolConfigNotificacion(g.tieneLlave, false),
    llavePago: String(g.llavePago || '').trim(),
  };
}

function mediosPagoNotificacionListos(cfg) {
  const c = parsearMediosPagoCliente(cfg);
  if (c.tieneNequi && c.numeroNequi) return true;
  if (c.tieneDaviplata && c.numeroDaviplata) return true;
  if (c.tieneLlave && c.llavePago) return true;
  return false;
}

function mensajeErrorMediosPago(cfg) {
  const c = parsearMediosPagoCliente(cfg);
  if (!c.tieneNequi && !c.tieneDaviplata && !c.tieneLlave) {
    return 'Marca al menos un medio de pago (Nequi, Daviplata o Bre-B).';
  }
  if (c.tieneNequi && !c.numeroNequi) {
    return 'Indica el número de Nequi o desmarca ese medio.';
  }
  if (c.tieneDaviplata && !c.numeroDaviplata) {
    return 'Indica el número de Daviplata o desmarca ese medio.';
  }
  if (c.tieneLlave && !c.llavePago) {
    return 'Indica la llave Bre-B o desmarca ese medio.';
  }
  if (!mediosPagoNotificacionListos(c)) {
    return 'Completa al menos un medio de pago con sus datos.';
  }
  return '';
}

function actualizarAvisoModalConfigNotificacion() {
  const ayuda = document.querySelector('#modalConfigNotificacion .config-notificacion-ayuda');
  const avisoTienda = document.getElementById('cfgAvisoMediosTienda');
  if (ayuda) {
    ayuda.textContent = notificacionEnCaminoPendienteTrasConfig
      ? 'Para enviar la notificación al cliente, completa tus medios de pago o usa los de la tienda y pulsa Guardar.'
      : CONFIG_NOTIFICACION_AYUDA_DEFAULT;
  }
  if (avisoTienda) {
    const listo = mediosPagoNotificacionListos(paymentConfigEstado.tienda);
    avisoTienda.textContent = listo
      ? 'Usarás los medios de pago configurados por la tienda en el panel de administración.'
      : 'La tienda aún no tiene medios de pago configurados. El administrador debe completarlos en Usuarios y roles.';
    avisoTienda.style.display = document.getElementById('cfgUsarMediosTienda')?.checked ? 'block' : 'none';
  }
}

function limpiarErrorConfigNotificacion() {
  const err = document.getElementById('configNotificacionError');
  if (err) err.textContent = '';
}

function mostrarErrorConfigNotificacion(texto) {
  const err = document.getElementById('configNotificacionError');
  if (err) err.textContent = String(texto || '');
}

function limpiarErrorMediosPagoTienda() {
  const err = document.getElementById('configTiendaError');
  if (err) err.textContent = '';
}

function mostrarErrorMediosPagoTienda(texto) {
  const err = document.getElementById('configTiendaError');
  if (err) err.textContent = String(texto || '');
}

async function refrescarPaymentConfigDesdeServidor() {
  if (!sesionUsuario) return;
  try {
    const data = await apiJson('/api/payment-config/me', { method: 'GET' });
    paymentConfigEstado = {
      personal: parsearMediosPagoCliente(data.personal),
      usarMediosTienda: !!data.usarMediosTienda,
      tienda: parsearMediosPagoCliente(data.tienda),
      effective: parsearMediosPagoCliente(data.effective),
    };
  } catch (e) {
    console.error(e);
  }
}

async function refrescarMediosPagoTiendaDesdeServidor() {
  if (!esSesionAdmin()) return;
  try {
    const data = await apiJson('/api/payment-config/tienda', { method: 'GET' });
    paymentConfigEstado.tienda = parsearMediosPagoCliente(data.tienda);
  } catch (e) {
    console.error(e);
  }
}

function leerMediosPagoPersonalDesdeUI() {
  const tieneNequi = document.getElementById('cfgTieneNequi');
  const tieneDaviplata = document.getElementById('cfgTieneDaviplata');
  const numeroNequi = document.getElementById('cfgNumeroNequi');
  const numeroDaviplata = document.getElementById('cfgNumeroDaviplata');
  const tieneLlave = document.getElementById('cfgTieneLlave');
  const llavePago = document.getElementById('cfgLlavePago');
  if (!tieneNequi || !tieneDaviplata || !numeroNequi || !numeroDaviplata || !tieneLlave || !llavePago) {
    return null;
  }
  return parsearMediosPagoCliente({
    tieneNequi: !!tieneNequi.checked,
    tieneDaviplata: !!tieneDaviplata.checked,
    numeroNequi: String(numeroNequi.value || '').replace(/\D/g, ''),
    numeroDaviplata: String(numeroDaviplata.value || '').replace(/\D/g, ''),
    tieneLlave: !!tieneLlave.checked,
    llavePago: String(llavePago.value || '').trim(),
  });
}

function leerMediosPagoTiendaDesdeUI() {
  const tieneNequi = document.getElementById('cfgTiendaTieneNequi');
  const tieneDaviplata = document.getElementById('cfgTiendaTieneDaviplata');
  const numeroNequi = document.getElementById('cfgTiendaNumeroNequi');
  const numeroDaviplata = document.getElementById('cfgTiendaNumeroDaviplata');
  const nombreTitular = document.getElementById('cfgTiendaNombreTitular');
  const tieneLlave = document.getElementById('cfgTiendaTieneLlave');
  const llavePago = document.getElementById('cfgTiendaLlavePago');
  if (!tieneNequi || !tieneDaviplata || !numeroNequi || !numeroDaviplata || !nombreTitular || !tieneLlave || !llavePago) {
    return null;
  }
  return parsearMediosPagoCliente({
    tieneNequi: !!tieneNequi.checked,
    tieneDaviplata: !!tieneDaviplata.checked,
    numeroNequi: String(numeroNequi.value || '').replace(/\D/g, ''),
    numeroDaviplata: String(numeroDaviplata.value || '').replace(/\D/g, ''),
    nombreTitular: String(nombreTitular.value || '').trim(),
    tieneLlave: !!tieneLlave.checked,
    llavePago: String(llavePago.value || '').trim(),
  });
}

function cargarCachePedidos() {
  try {
    const raw = localStorage.getItem(getCachePedidosStorageKey());
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch (_e) {
    return [];
  }
}

function guardarCachePedidos() {
  try {
    const lista = Array.isArray(pedidos) ? pedidos : [];
    const dedup = deduplicarPedidosPorId(lista);
    localStorage.setItem(getCachePedidosStorageKey(), JSON.stringify(dedup));
  } catch (err) {
    console.error('[app-delivery] No se pudo guardar en localStorage:', err);
    mostrarToast(
      'No se pudieron guardar los pedidos en este navegador. Revisa el modo privado o que no esté bloqueado el almacenamiento local.',
      'error',
      8000
    );
  }
}

/** Quita duplicados por id conservando el orden del array (datos: gana la última aparición de cada id). */
function deduplicarPedidosPorId(lista) {
  const arr = Array.isArray(lista) ? lista : [];
  const map = new Map();
  arr.forEach((p) => {
    const id = p && p.id != null ? Number(p.id) : null;
    if (!id || !Number.isFinite(id)) return;
    map.set(id, p);
  });
  const seen = new Set();
  const out = [];
  arr.forEach((p) => {
    const id = p && p.id != null ? Number(p.id) : null;
    if (!id || !Number.isFinite(id)) return;
    if (seen.has(id)) return;
    seen.add(id);
    const ultimo = map.get(id);
    if (ultimo) out.push(ultimo);
  });
  return out;
}

function actualizarVisibilidadConfigNotificacion() {
  const usarTienda = document.getElementById('cfgUsarMediosTienda');
  const personalWrap = document.getElementById('cfgPersonalMediosWrap');
  const nequiWrap = document.getElementById('cfgNumeroNequiWrap');
  const daviWrap = document.getElementById('cfgNumeroDaviplataWrap');
  const llaveWrap = document.getElementById('cfgLlaveWrap');
  const tieneNequi = document.getElementById('cfgTieneNequi');
  const tieneDaviplata = document.getElementById('cfgTieneDaviplata');
  const tieneLlave = document.getElementById('cfgTieneLlave');
  const usaTienda = !!(usarTienda && usarTienda.checked);
  if (personalWrap) {
    personalWrap.style.display = usaTienda ? 'none' : 'block';
    personalWrap.querySelectorAll('input').forEach((inp) => {
      inp.disabled = usaTienda;
    });
  }
  if (nequiWrap) nequiWrap.style.display = !usaTienda && tieneNequi?.checked ? 'block' : 'none';
  if (daviWrap) daviWrap.style.display = !usaTienda && tieneDaviplata?.checked ? 'block' : 'none';
  if (llaveWrap) llaveWrap.style.display = !usaTienda && tieneLlave?.checked ? 'block' : 'none';
  actualizarAvisoModalConfigNotificacion();
}

function actualizarVisibilidadMediosPagoTienda() {
  const nequiWrap = document.getElementById('cfgTiendaNumeroNequiWrap');
  const daviWrap = document.getElementById('cfgTiendaNumeroDaviplataWrap');
  const nombreWrap = document.getElementById('cfgTiendaNombreTitularWrap');
  const llaveWrap = document.getElementById('cfgTiendaLlaveWrap');
  const tieneNequi = document.getElementById('cfgTiendaTieneNequi');
  const tieneDaviplata = document.getElementById('cfgTiendaTieneDaviplata');
  const tieneLlave = document.getElementById('cfgTiendaTieneLlave');
  const mostrarNum = !!((tieneNequi && tieneNequi.checked) || (tieneDaviplata && tieneDaviplata.checked));
  if (nequiWrap) nequiWrap.style.display = tieneNequi?.checked ? 'block' : 'none';
  if (daviWrap) daviWrap.style.display = tieneDaviplata?.checked ? 'block' : 'none';
  if (nombreWrap) nombreWrap.style.display = mostrarNum ? 'block' : 'none';
  if (llaveWrap) llaveWrap.style.display = tieneLlave?.checked ? 'block' : 'none';
}

function cargarConfigNotificacionEnUI() {
  const usarTienda = document.getElementById('cfgUsarMediosTienda');
  const tieneNequi = document.getElementById('cfgTieneNequi');
  const tieneDaviplata = document.getElementById('cfgTieneDaviplata');
  const numeroNequi = document.getElementById('cfgNumeroNequi');
  const numeroDaviplata = document.getElementById('cfgNumeroDaviplata');
  const tieneLlave = document.getElementById('cfgTieneLlave');
  const llavePago = document.getElementById('cfgLlavePago');
  if (!usarTienda || !tieneNequi || !tieneDaviplata || !numeroNequi || !numeroDaviplata || !tieneLlave || !llavePago) {
    return;
  }

  const usarTiendaRow = usarTienda.closest('.config-check--destacado');
  if (usarTiendaRow) usarTiendaRow.style.display = esSesionMensajero() ? '' : 'none';

  const p = paymentConfigEstado.personal;
  usarTienda.checked = !!paymentConfigEstado.usarMediosTienda;
  tieneNequi.checked = !!p.tieneNequi;
  tieneDaviplata.checked = !!p.tieneDaviplata;
  numeroNequi.value = p.numeroNequi || '';
  numeroDaviplata.value = p.numeroDaviplata || '';
  tieneLlave.checked = !!p.tieneLlave;
  llavePago.value = p.llavePago || '';
  limpiarErrorConfigNotificacion();

  if (!usarTienda.dataset.bound) {
    usarTienda.dataset.bound = '1';
    usarTienda.onchange = () => actualizarVisibilidadConfigNotificacion();
  }
  [tieneNequi, tieneDaviplata, tieneLlave].forEach((el) => {
    el.onchange = () => actualizarVisibilidadConfigNotificacion();
  });
  actualizarVisibilidadConfigNotificacion();
}

function cargarMediosPagoTiendaEnUI() {
  const tieneNequi = document.getElementById('cfgTiendaTieneNequi');
  const tieneDaviplata = document.getElementById('cfgTiendaTieneDaviplata');
  const numeroNequi = document.getElementById('cfgTiendaNumeroNequi');
  const numeroDaviplata = document.getElementById('cfgTiendaNumeroDaviplata');
  const nombreTitular = document.getElementById('cfgTiendaNombreTitular');
  const tieneLlave = document.getElementById('cfgTiendaTieneLlave');
  const llavePago = document.getElementById('cfgTiendaLlavePago');
  if (!tieneNequi || !tieneDaviplata || !numeroNequi || !numeroDaviplata || !nombreTitular || !tieneLlave || !llavePago) {
    return;
  }
  const t = paymentConfigEstado.tienda;
  tieneNequi.checked = !!t.tieneNequi;
  tieneDaviplata.checked = !!t.tieneDaviplata;
  numeroNequi.value = t.numeroNequi || '';
  numeroDaviplata.value = t.numeroDaviplata || '';
  nombreTitular.value = t.nombreTitular || '';
  tieneLlave.checked = !!t.tieneLlave;
  llavePago.value = t.llavePago || '';
  limpiarErrorMediosPagoTienda();
  [tieneNequi, tieneDaviplata, tieneLlave].forEach((el) => {
    if (!el.dataset.bound) {
      el.dataset.bound = '1';
      el.onchange = () => actualizarVisibilidadMediosPagoTienda();
    }
  });
  actualizarVisibilidadMediosPagoTienda();
}

async function abrirConfigNotificacion() {
  await refrescarPaymentConfigDesdeServidor();
  actualizarAvisoModalConfigNotificacion();
  cargarConfigNotificacionEnUI();
  const modal = document.getElementById('modalConfigNotificacion');
  if (!modal) return;
  modal.style.display = 'flex';
}

function abrirConfigNotificacionParaNotificar(index, pedidoId, opciones) {
  notificacionEnCaminoPendienteTrasConfig = { index, pedidoId, opciones: opciones || {} };
  void abrirConfigNotificacion();
}

function cerrarConfigNotificacion() {
  notificacionEnCaminoPendienteTrasConfig = null;
  actualizarAvisoModalConfigNotificacion();
  limpiarErrorConfigNotificacion();
  cargarConfigNotificacionEnUI();
  const modal = document.getElementById('modalConfigNotificacion');
  if (!modal) return;
  modal.style.display = 'none';
}

function cerrarMenuUsuario() {
  const panel = document.getElementById('menuUsuarioPanel');
  const btn = document.getElementById('btnMenuUsuario');
  if (panel) panel.style.display = 'none';
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

function toggleMenuUsuario(ev) {
  if (ev && typeof ev.stopPropagation === 'function') ev.stopPropagation();
  const panel = document.getElementById('menuUsuarioPanel');
  const btn = document.getElementById('btnMenuUsuario');
  if (!panel || !btn) return;
  const abierto = panel.style.display === 'flex';
  panel.style.display = abierto ? 'none' : 'flex';
  btn.setAttribute('aria-expanded', abierto ? 'false' : 'true');
}

/** Menú hamburguesa: vista principal (pedidos / mapa) y scroll al inicio. */
function menuIrAlInicio() {
  cerrarMenuUsuario();
  const page = document.getElementById('pageUsuariosRoles');
  const enUsuariosRoles = page && page.style.display === 'block';
  if (enUsuariosRoles) {
    cerrarPaginaUsuariosRoles();
    return;
  }
  limpiarVistaAppSesion();
  scrollToTopApp();
}

function abrirConfigNotificacionDesdeMenu() {
  cerrarMenuUsuario();
  notificacionEnCaminoPendienteTrasConfig = null;
  void abrirConfigNotificacion();
}

async function guardarConfigNotificacionDesdeUI(mostrarMensaje = true) {
  const usarTienda = document.getElementById('cfgUsarMediosTienda');
  if (!usarTienda) return;

  const usarMediosTienda = !!usarTienda.checked;
  const personal = leerMediosPagoPersonalDesdeUI();
  if (!personal) return;

  if (!usarMediosTienda) {
    const errorCfg = mensajeErrorMediosPago(personal);
    if (errorCfg) {
      mostrarErrorConfigNotificacion(errorCfg);
      return;
    }
  } else if (!mediosPagoNotificacionListos(paymentConfigEstado.tienda)) {
    mostrarErrorConfigNotificacion(
      'La tienda aún no tiene medios de pago configurados. Pide al administrador que los complete en Usuarios y roles.'
    );
    return;
  }

  limpiarErrorConfigNotificacion();
  const pendiente = notificacionEnCaminoPendienteTrasConfig;
  notificacionEnCaminoPendienteTrasConfig = null;

  try {
    const data = await apiJson('/api/payment-config/me', {
      method: 'PUT',
      body: JSON.stringify({ personal, usarMediosTienda }),
    });
    paymentConfigEstado = {
      personal: parsearMediosPagoCliente(data.personal),
      usarMediosTienda: !!data.usarMediosTienda,
      tienda: parsearMediosPagoCliente(data.tienda),
      effective: parsearMediosPagoCliente(data.effective),
    };
  } catch (e) {
    mostrarErrorConfigNotificacion(String(e.message || e));
    if (pendiente) notificacionEnCaminoPendienteTrasConfig = pendiente;
    return;
  }

  actualizarAvisoModalConfigNotificacion();
  const modal = document.getElementById('modalConfigNotificacion');
  if (modal) modal.style.display = 'none';

  if (pendiente) {
    notificarEnCamino(pendiente.index, pendiente.pedidoId, pendiente.opciones);
    return;
  }

  cargarConfigNotificacionEnUI();
  if (mostrarMensaje) {
    mostrarToast('Tus medios de pago quedaron guardados.', 'success');
  }
}

async function guardarMediosPagoTiendaDesdeUI() {
  const tienda = leerMediosPagoTiendaDesdeUI();
  if (!tienda) return;
  const errorCfg = mensajeErrorMediosPago(tienda);
  if (errorCfg) {
    mostrarErrorMediosPagoTienda(errorCfg);
    return;
  }
  limpiarErrorMediosPagoTienda();
  try {
    const data = await apiJson('/api/payment-config/tienda', {
      method: 'PUT',
      body: JSON.stringify({ tienda }),
    });
    paymentConfigEstado.tienda = parsearMediosPagoCliente(data.tienda);
    mostrarToast('Medios de pago de la tienda guardados.', 'success');
    cargarMediosPagoTiendaEnUI();
  } catch (e) {
    mostrarErrorMediosPagoTienda(String(e.message || e));
  }
}

function construirBloquePagoNotificacion() {
  const cfg = parsearMediosPagoCliente(paymentConfigEstado.effective);
  const lineas = [];
  const nom = cfg.nombreTitular ? ` (${cfg.nombreTitular})` : '';
  if (cfg.tieneNequi && cfg.numeroNequi) {
    lineas.push(`- *Nequi*: ${cfg.numeroNequi}${nom}`);
  }
  if (cfg.tieneDaviplata && cfg.numeroDaviplata) {
    lineas.push(`- *Daviplata*: ${cfg.numeroDaviplata}${nom}`);
  }
  if (cfg.tieneLlave && cfg.llavePago) {
    lineas.push(`- *Llave / Bre-B*: ${cfg.llavePago}`);
  }
  if (lineas.length === 0) {
    return 'El pago puede ser en *efectivo*. Si no tienes efectivo, avísame para indicarte cómo pagar por *Nequi*, *Daviplata* o por la *llave*.';
  }
  return (
    'El pago puede ser en *efectivo*. Si no tienes la plata en efectivo, puedes pagar por *Nequi*, *Daviplata* o por la *llave*:\n' +
    lineas.join('\n')
  );
}

/** Detecta si el pedido es un cambio (método o texto del formato). */
function pedidoEsCambioParaNotificacion(pedido) {
  if (!pedido) return false;
  if (String(pedido.metodoPagoEntrega || '') === 'es_cambio') return true;
  const texto = [
    pedido.textoOriginal,
    pedido.nombre,
    pedido.direccion,
    Array.isArray(pedido.productos) ? pedido.productos.join(' ') : '',
  ]
    .map((x) => String(x || ''))
    .join('\n');
  return /\bes\s+un\s+cambio\b|\bcambio\s+de\s+producto\b|\bpedido\s+de\s+cambio\b|\bpara\s+cambio\b/i.test(
    texto
  );
}

function montoACobrarParaNotificacionEnCamino(pedido) {
  if (!pedido) return 0;
  if (pedidoEsCambioParaNotificacion(pedido)) return 0;
  if (String(pedido.metodoPagoEntrega || '') === 'pagado_tienda') return 0;
  const n = parseInt(pedido.valor || 0, 10);
  return Number.isFinite(n) ? n : 0;
}

function normalizarTextoParaWhatsApp(texto) {
  return String(texto || '')
    .normalize('NFKC')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '')
    .replace(/\u00A0/g, ' ')
    .replace(/[•·•]/g, '')
    .replace(/[^\x20-\x7E\u00A0-\u00FF\n\r\t]/g, '')
    .replace(/[ ]{2,}/g, ' ')
    .replace(/\r\n/g, '\n');
}

function copiarTextoAlPortapapeles(texto, mensajeExito) {
  const t = String(texto || '');
  if (!t) return Promise.resolve(false);
  const ok = () => {
    if (mensajeExito) mostrarToast(mensajeExito, 'success');
    return true;
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(t).then(ok, () => {
      try {
        const ta = document.createElement('textarea');
        ta.value = t;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        const copiado = document.execCommand('copy');
        document.body.removeChild(ta);
        if (copiado) return ok();
      } catch (_e) {}
      return false;
    });
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = t;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    const copiado = document.execCommand('copy');
    document.body.removeChild(ta);
    if (copiado) return Promise.resolve(ok());
  } catch (_e) {}
  return Promise.resolve(false);
}

function abrirWhatsAppConTexto(telefono, mensaje) {
  const limpio = String(telefono || '').replace(/\D/g, '');
  if (!limpio) return;
  const wa = limpio.startsWith('57') ? limpio : `57${limpio}`;
  const texto = encodeURIComponent(normalizarTextoParaWhatsApp(mensaje));
  const url = `https://api.whatsapp.com/send?phone=${wa}&text=${texto}&src=delivery&t=${Date.now()}`;
  window.open(url, '_blank');
}

/** Abre el chat de WhatsApp con el contacto, sin mensaje prellenado. */
function abrirWhatsAppChat(telefono) {
  const limpio = String(telefono || '').replace(/\D/g, '');
  if (!limpio) return;
  const wa = limpio.startsWith('57') ? limpio : `57${limpio}`;
  const ua = navigator.userAgent || '';
  const esMovil = /Android|iPhone|iPad|iPod|Mobile|webOS|BlackBerry|IEMobile|Opera Mini/i.test(ua);
  if (esMovil) {
    window.location.href = `whatsapp://send?phone=${wa}`;
    return;
  }
  window.open(`https://wa.me/${wa}`, '_blank');
}

/**
 * Intenta abrir WhatsApp en la app (móvil). En escritorio mantiene wa.me en pestaña nueva.
 */
function abrirWhatsAppPreferirApp(telefono, mensaje) {
  const limpio = String(telefono || '').replace(/\D/g, '');
  if (!limpio) return;
  const wa = limpio.startsWith('57') ? limpio : `57${limpio}`;
  const textoNorm = normalizarTextoParaWhatsApp(mensaje);
  const texto = encodeURIComponent(textoNorm);
  const ua = navigator.userAgent || '';
  const esMovil = /Android|iPhone|iPad|iPod|Mobile|webOS|BlackBerry|IEMobile|Opera Mini/i.test(ua);
  if (esMovil) {
    window.location.href = `whatsapp://send?phone=${wa}&text=${texto}`;
    return;
  }
  window.open(`https://wa.me/${wa}?text=${texto}`, '_blank');
}

// --- Teléfonos múltiples ---

function normalizarTelefonosDesdeTexto(raw) {
  const s = String(raw || '').trim();
  if (!s) return [];

  // Extrae todos los "bloques" que parezcan teléfono; luego deja solo dígitos.
  const matches = s.match(/\+?[\d\s().-]{7,}/g) || [];
  const out = [];
  const seen = new Set();
  for (const m of matches) {
    let t = String(m || '').trim();
    if (!t) continue;
    if (t.startsWith('+')) t = t.slice(1);
    t = t.replace(/\D/g, '');
    if (t.length < 7) continue;
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }

  // Heurística para casos donde antes se concatenaron dos teléfonos sin separador.
  // Ej: "30246933943147153587" (20 dígitos) -> ["3024693394","3147153587"].
  if (out.length === 1) {
    const solo = out[0];
    if (/^\d+$/.test(solo) && solo.length >= 14) {
      const partes = [];
      const pushChunks = (chunkLen) => {
        if (solo.length % chunkLen !== 0) return false;
        for (let i = 0; i < solo.length; i += chunkLen) {
          partes.push(solo.slice(i, i + chunkLen));
        }
        return partes.length >= 2;
      };

      // 12 dígitos: 57 + 10 (WhatsApp); 10 dígitos: celular local.
      if (pushChunks(12) || pushChunks(10)) {
        const out2 = [];
        const seen2 = new Set();
        for (const p of partes) {
          const t = String(p || '').replace(/\D/g, '');
          if (t.length < 7) continue;
          if (!seen2.has(t)) { seen2.add(t); out2.push(t); }
        }
        if (out2.length >= 2) return out2;
      }
    }
  }
  return out;
}

const LONGITUD_TELEFONO_LOCAL = 10;

function digitosTelefonoLocalCelular(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.startsWith('57') && d.length > LONGITUD_TELEFONO_LOCAL) {
    d = d.slice(2);
  }
  return d;
}

function analizarTelefonoLocalCelular(raw) {
  const digitos = digitosTelefonoLocalCelular(raw);
  const esperado = LONGITUD_TELEFONO_LOCAL;
  const rawTxt = String(raw || '').trim();
  if (!digitos) {
    return {
      valido: false,
      digitos: '',
      raw: rawTxt,
      cantidad: 0,
      tipo: 'faltan',
      diferencia: esperado,
      mensaje: `Pedido sin teléfono detectado: faltan ${esperado} números (deben ser ${esperado}).`,
    };
  }
  if (digitos.length < esperado) {
    const falta = esperado - digitos.length;
    return {
      valido: false,
      digitos,
      raw: rawTxt,
      cantidad: digitos.length,
      tipo: 'faltan',
      diferencia: falta,
      mensaje: `Teléfono con ${digitos.length} números: faltan ${falta} (deben ser ${esperado}). Número detectado: ${digitos}.`,
    };
  }
  if (digitos.length > esperado) {
    const sobra = digitos.length - esperado;
    return {
      valido: false,
      digitos,
      raw: rawTxt,
      cantidad: digitos.length,
      tipo: 'sobran',
      diferencia: sobra,
      mensaje: `Teléfono con ${digitos.length} números: sobran ${sobra} (deben ser ${esperado}). Número detectado: ${digitos}.`,
    };
  }
  return { valido: true, digitos, raw: rawTxt, cantidad: digitos.length };
}

function construirAvisoTelefonoDesdeCampos(campos) {
  const lista =
    Array.isArray(campos?.telefonos) && campos.telefonos.length
      ? campos.telefonos
      : campos?.telefono
        ? [campos.telefono]
        : [];
  if (!lista.length) {
    const analisis = analizarTelefonoLocalCelular('');
    return {
      mensaje: analisis.mensaje,
      tipo: analisis.tipo,
      diferencia: analisis.diferencia,
      digitos: analisis.digitos,
      raw: analisis.raw,
    };
  }
  const invalidos = lista.map((t) => analizarTelefonoLocalCelular(t)).filter((a) => !a.valido);
  if (!invalidos.length) return null;
  const primero = invalidos[0];
  const extra =
    invalidos.length > 1 ? ` (${invalidos.length} números con problema en el pedido)` : '';
  return {
    mensaje: primero.mensaje + extra,
    tipo: primero.tipo,
    diferencia: primero.diferencia,
    digitos: primero.digitos,
    raw: primero.raw,
  };
}

function sincronizarAvisoTelefonoPedido(pedido) {
  if (!pedido) return;
  const campos = {
    telefono: pedido.telefono,
    telefonos: obtenerTelefonosPedido(pedido),
  };
  const aviso = construirAvisoTelefonoDesdeCampos(campos);
  if (aviso) pedido.avisoTelefono = aviso;
  else delete pedido.avisoTelefono;
}

function construirMensajeNotificarVendedorTelefono(pedido) {
  const aviso = pedido?.avisoTelefono;
  if (!aviso) return '';
  const idPedido = pedido.id != null ? pedido.id : 'N/A';
  const nombre = String(pedido.nombre || '').trim() || 'Sin nombre';
  const productos = textoProductosEntregaParaSoporte(pedido);
  const detalle =
    aviso.tipo === 'sobran'
      ? `Sobran ${aviso.diferencia} número(s).`
      : `Faltan ${aviso.diferencia} número(s).`;
  const numeroTxt = aviso.digitos
    ? `Número detectado: ${aviso.digitos} (${aviso.cantidad != null ? aviso.cantidad : aviso.digitos.length} dígitos).`
    : 'No se detectó número de teléfono en el pedido.';
  return `Pedido #${idPedido} — teléfono del cliente incorrecto

Cliente: ${nombre}
${numeroTxt}
${detalle} Deben ser ${LONGITUD_TELEFONO_LOCAL} números.

Producto(s):
${productos}

Por favor revisar y corregir el pedido.`;
}

function actualizarBannerAvisosTelefono() {
  const host = document.getElementById('bannerAvisosTelefono');
  if (!host) return;
  const pendientes = pedidos.filter((p) => p && p.avisoTelefono && !p.cancelado);
  if (!pendientes.length) {
    host.style.display = 'none';
    host.innerHTML = '';
    return;
  }
  host.style.display = 'flex';
  host.innerHTML = pendientes
    .map((p) => {
      const id = p.id;
      const msg = String(p.avisoTelefono.mensaje || 'Teléfono incorrecto.');
      const titulo = `Pedido #${id}: ${msg}`;
      return (
        '<div class="banner-aviso-telefono-item" data-pedido-id="' +
        id +
        '">' +
        '<p class="banner-aviso-telefono-texto"><strong>Pedido #' +
        id +
        ':</strong> ' +
        msg.replace(/</g, '&lt;') +
        '</p>' +
        '<div class="banner-aviso-telefono-acciones">' +
        '<button type="button" class="btn-primary" onclick="notificarVendedorTelefonoInvalido(' +
        id +
        ')"><i class="fa-brands fa-whatsapp" aria-hidden="true"></i> Notificar al vendedor</button>' +
        '<button type="button" class="banner-aviso-telefono-cerrar" onclick="descartarAvisoTelefonoPedido(' +
        id +
        ')" aria-label="Cerrar aviso">×</button>' +
        '</div></div>'
      );
    })
    .join('');
}

function descartarAvisoTelefonoPedido(pedidoId) {
  const pedido = pedidos.find((p) => p && Number(p.id) === Number(pedidoId));
  if (!pedido) return;
  delete pedido.avisoTelefono;
  guardarPedidos();
  actualizarBannerAvisosTelefono();
}

function notificarVendedorTelefonoInvalido(pedidoId) {
  const pedido = pedidos.find((p) => p && Number(p.id) === Number(pedidoId));
  if (!pedido || !pedido.avisoTelefono) {
    mostrarToast('No hay aviso de teléfono para este pedido.', 'warning');
    return;
  }
  const mensaje = construirMensajeNotificarVendedorTelefono(pedido);
  const wa = obtenerSoporteWhatsApp();
  void copiarTextoAlPortapapeles(mensaje, 'Mensaje copiado. Pégalo en el chat del vendedor.').then((copiado) => {
    if (copiado) abrirWhatsAppChat(wa);
  });
}

function obtenerTelefonosPedido(pedido) {
  if (!pedido) return [];
  if (Array.isArray(pedido.telefonos) && pedido.telefonos.length) {
    return pedido.telefonos.map((t) => String(t || '').replace(/\D/g, '')).filter((t) => t.length >= 7);
  }
  // Legado: `pedido.telefono` puede venir con dos números en un solo texto.
  const legacy = normalizarTelefonosDesdeTexto(String(pedido.telefono || ''));
  return legacy;
}

function textoTelefonosPedidoParaUI(pedido) {
  const tels = obtenerTelefonosPedido(pedido);
  if (tels.length === 0) return '';
  return tels.join(' - ');
}

function textoTelefonosPedidoParaInput(pedido) {
  // Para inputs conviene un separador "pegable" y fácil de editar.
  return textoTelefonosPedidoParaUI(pedido);
}

function htmlTelefonosPedidoParaTarjeta(pedido) {
  const tels = obtenerTelefonosPedido(pedido);
  if (tels.length === 0) return '';
  // En una sola línea, separados por guión.
  return tels.join(' - ');
}

function claveTelefonoNotificacion(tel) {
  let d = String(tel || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.startsWith('57') && d.length > 10) d = d.slice(2);
  return d;
}

function obtenerTelefonosNotificadosEnCamino(pedido) {
  if (!Array.isArray(pedido?.telefonosNotificadosEnCamino)) return [];
  return pedido.telefonosNotificadosEnCamino.map(claveTelefonoNotificacion).filter(Boolean);
}

function registrarTelefonoNotificadoEnCamino(pedido, tel) {
  const key = claveTelefonoNotificacion(tel);
  if (!key || !pedido) return;
  if (!Array.isArray(pedido.telefonosNotificadosEnCamino)) pedido.telefonosNotificadosEnCamino = [];
  if (!pedido.telefonosNotificadosEnCamino.includes(key)) {
    pedido.telefonosNotificadosEnCamino.push(key);
  }
}

function obtenerTelefonosPendientesNotificacionEnCamino(pedido) {
  const todos = obtenerTelefonosPedido(pedido);
  const hechos = new Set(obtenerTelefonosNotificadosEnCamino(pedido));
  return todos.filter((t) => !hechos.has(claveTelefonoNotificacion(t)));
}

function tieneNotificacionEnCaminoParcial(pedido) {
  const todos = obtenerTelefonosPedido(pedido);
  const pendientes = obtenerTelefonosPendientesNotificacionEnCamino(pedido);
  return todos.length > 1 && pendientes.length > 0 && pendientes.length < todos.length;
}

function limpiarNotificacionEnCaminoPedido(pedido) {
  if (!pedido) return;
  pedido.notificadoEnCamino = false;
  pedido.telefonosNotificadosEnCamino = [];
}

function completarNotificacionEnCaminoPedido(pedido) {
  if (!pedido) return;
  pedido.notificadoEnCamino = true;
}

function seleccionarTelefonoConModal(tels, titulo, onElegir) {
  const telefonos = (Array.isArray(tels) ? tels : []).filter(Boolean);
  if (telefonos.length === 0) {
    mostrarAvisoEnApp('No hay número de teléfono disponible', titulo || 'Contacto');
    return;
  }
  if (telefonos.length === 1) {
    if (typeof onElegir === 'function') onElegir(telefonos[0], 0, telefonos);
    return;
  }
  const a = telefonos[0];
  const b = telefonos[1];
  mostrarModalDecision({
    titulo: titulo || 'Contacto',
    texto: '¿A cuál número deseas hacerlo?',
    textoConfirmar: a,
    claseConfirmar: 'btn-primary',
    textoSecundario: b,
    claseSecundario: 'btn-info',
    textoCancelar: 'Cancelar',
    onConfirmar: () => typeof onElegir === 'function' && onElegir(a, 0, telefonos),
    onSecundario: () => typeof onElegir === 'function' && onElegir(b, 1, telefonos),
    onCancelar: () => {}
  });
}

function pedidoNuevoBase() {
  return {
    assignedTo: null,
    createdBy: null,
    enCurso: false,
    haSidoEnrutado: false,
    posicionPendiente: null,
    entregado: false,
    noEntregado: false,
    envioRecogido: false,
    notificadoEnCamino: false,
    llegoDestino: false,
    cancelado: false,
    metodoPagoEntrega: '',
    montoNequi: 0,
    montoDaviplata: 0,
    montoEfectivo: 0
  };
}

function ajustarMapaConReintentos() {
  if (!mapa) return;
  const elMapa = document.getElementById('mapa');
  if (!elMapa) return;

  // Fuerza dimensiones mínimas en móviles cuando el layout flex aún no termina de calcular.
  if (elMapa.clientHeight < 240) {
    elMapa.style.minHeight = '320px';
  }

  [0, 120, 280, 500, 900].forEach(ms => {
    setTimeout(() => {
      if (!mapa) return;
      mapa.invalidateSize();
    }, ms);
  });
}

function initMap() {
  mapa = L.map('mapa').setView([4.6097, -74.0817], 12);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors',
    maxZoom: 19
  }).addTo(mapa);
  actualizarMarcadores();

  // En móviles Leaflet puede calcular mal dimensiones iniciales dentro de layouts flex.
  ajustarMapaConReintentos();
  window.addEventListener('resize', () => {
    if (!mapa) return;
    ajustarMapaConReintentos();
  });
  window.addEventListener('orientationchange', () => {
    if (!mapa) return;
    ajustarMapaConReintentos();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') ajustarMapaConReintentos();
  });
}

function limpiarTimestampsChat(texto) {
  let t = String(texto || '')
    .replace(/\u200E|\u200F|\u200B|\u200C|\u200D|\uFEFF/g, '')
    .replace(/\r\n/g, '\n');
  // [1:01 p. m., 24/3/2026] Valero Storee: al inicio de línea (cualquier longitud entre [ ])
  t = t.replace(/^\s*\[[^\]]+\]\s*[^:]+:\s*/gm, '');
  // Mismo patrón si quedó pegado a mitad de línea
  t = t.replace(/\s*\[[^\]]+\]\s*[^:]+:\s*/g, '');
  return t.replace(/\n{3,}/g, '\n\n').trim();
}

function patronUrlMapsRegexGlobal() {
  return /https?:\/\/(?:(?:www\.)?google\.com\/maps|maps\.google\.com|maps\.app\.goo\.gl|(?:www\.)?goo\.gl\/maps|maps\.apple\.com|maps\.apple)[^\s\n]*/gi;
}

function patronUrlMapsRegexUna() {
  return /https?:\/\/(?:(?:www\.)?google\.com\/maps|maps\.google\.com|maps\.app\.goo\.gl|(?:www\.)?goo\.gl\/maps|maps\.apple\.com|maps\.apple)[^\s\n]*/i;
}

function extraerTodasLasUrlsMapsEnTexto(texto) {
  const re = patronUrlMapsRegexGlobal();
  return [...String(texto || '').matchAll(re)].map(m => m[0].trim());
}

function elegirUrlMapsParaBloque(textoCompletoLimpio, bloque, indiceBloque, urlsGlobal) {
  const enBloque = bloque.match(patronUrlMapsRegexUna());
  if (enBloque) return enBloque[0].trim();
  if (urlsGlobal.length === 0) return '';
  if (urlsGlobal.length === 1) return urlsGlobal[0];

  // Si el bloque está numerado ("3:"), intenta escoger la URL que esté dentro de ese bloque
  // en el texto completo. Esto evita confusiones cuando hay URLs extra o el chat repite "N:".
  const numMatch = String(bloque || '').match(/(^|\n)\s*(\d+):\s*(\n|$)/m);
  if (numMatch && numMatch[2]) {
    const n = numMatch[2];
    const reInicio = new RegExp(`(^|\\n)\\s*${n}:\\s*(\\n|$)`, 'g');
    // Tomar el último inicio "n:" antes del bloque (si el chat repite "n:" varias veces).
    let inicioIdx = -1;
    let mm;
    while ((mm = reInicio.exec(textoCompletoLimpio))) inicioIdx = mm.index;
    if (inicioIdx >= 0) {
      const resto = textoCompletoLimpio.slice(inicioIdx);
      const mNext = resto.match(/\n\s*\d+:\s*(\n|$)/);
      const segmento = mNext ? resto.slice(0, mNext.index) : resto;
      const urlEnSegmento = segmento.match(patronUrlMapsRegexUna());
      if (urlEnSegmento) return urlEnSegmento[0].trim();
    }
  }

  // Respaldo: por índice del bloque dentro de las URLs globales.
  if (indiceBloque < urlsGlobal.length) return urlsGlobal[indiceBloque];
  const prefijo = bloque.split(/Para\s+agilizar/i)[0] || bloque;
  const muestra = prefijo.trim().slice(0, 200);
  const posBloque = muestra.length >= 20 ? textoCompletoLimpio.indexOf(muestra.slice(0, 40)) : -1;
  const corte = posBloque >= 0 ? textoCompletoLimpio.slice(0, posBloque + 1) : textoCompletoLimpio;
  let mejor = '';
  let mejorPos = -1;
  for (const u of urlsGlobal) {
    const p = corte.lastIndexOf(u);
    if (p > mejorPos) {
      mejorPos = p;
      mejor = u;
    }
  }
  if (mejor) return mejor;
  return urlsGlobal[Math.min(indiceBloque, urlsGlobal.length - 1)] || urlsGlobal[0];
}

function generarPedidoId(numeroPedido) {
  if (numeroPedido && !pedidos.some(p => p.id === numeroPedido)) {
    return numeroPedido;
  }
  return Math.max(...pedidos.map(p => p.id), 0) + 1;
}

/**
 * WhatsApp suele envolver etiquetas en *negrita* y usar "Dirección de entrega:", "Teléfono de contacto:", etc.
 * Sin esto los regex no encuentran el ':' donde lo esperan o quedan asteriscos en medio.
 */
function normalizarTextoParaExtraerPedido(s) {
  let t = String(s || '')
    .replace(/\uFF1A/g, ':')
    .replace(/\r\n/g, '\n');
  for (let i = 0; i < 6; i++) {
    const next = t.replace(/\*([^*\n]+)\*/g, '$1');
    if (next === t) break;
    t = next;
  }
  for (let i = 0; i < 6; i++) {
    const next = t.replace(/_([^_\n]+)_/g, '$1');
    if (next === t) break;
    t = next;
  }
  t = t.replace(/^\*+\s*/gm, '').replace(/\s*\*+$/gm, '');
  return t;
}

/** Delimitador de siguiente campo en plantillas de pedido (tras normalizar). */
const _RE_TONO_PIEL = '(?:\\u{1F3FB}|\\u{1F3FC}|\\u{1F3FD}|\\u{1F3FE}|\\u{1F3FF})?';
const _RE_EMOJI_NOMBRE = `🙋${_RE_TONO_PIEL}`;
const _RE_FIN_CAMPO_PEDIDO =
  `(?=${_RE_EMOJI_NOMBRE}|📲|💰|Nombre\\b|Tel[ée]fono|Celular|WhatsApp|M[oó]vil\\b|Producto\\b|Pedido\\b|(?:\\*|\\s)*¿?\\s*Todo\\s+en\\s+orden|Para agilizar|Env[ií]o|https?:|$)`;

/** Tras "Nombre:" puede venir dirección antes que teléfono; sin 📍/Dirección el capture se come ese bloque. */
const _RE_FIN_TRAS_NOMBRE = _RE_FIN_CAMPO_PEDIDO.replace(
  /\|\$\)/,
  '|📍|(?:(?:Direcci[oó]n|Ubicaci[oó]n|Direccion)\\b)|$)'
);

function extraerProductosLineasTrasEncabezado(b) {
  return extraerProductosSoloDelBloque(b);
}

/**
 * Si no hubo cifras en los patrones principales, busca un monto solo en líneas de valor/recaudo.
 * Evita el primer $ del texto (suele ser Envío ~12.000) cuando el valor a recoger es 0 o texto.
 */
function extraerMontoValorRespaldoSinEnvio(bloque) {
  const lineas = String(bloque || '').split('\n');
  const reEtiqueta = new RegExp(
    '^(?:💰\\s*)?(?:Valor\\s+a\\s+pagar|Valor\\s+a\\s+recoger|A\\s+recoger|Valor|Total|Por\\s+cobrar|Pago|Recaudo)\\b',
    'i'
  );
  for (const raw of lineas) {
    const L = raw.trim();
    if (!L) continue;
    if (/^(?:💰\s*)?Env[ií]o\b/i.test(L)) continue;
    const idxColon = L.indexOf(':');
    if (idxColon > 0 && /\benv[ií]o\b/i.test(L.slice(0, idxColon))) continue;
    if (!reEtiqueta.test(L)) continue;
    const mDolar = L.match(/\$\s*([\d.,]+)/);
    if (mDolar) {
      const d = mDolar[1].replace(/[^\d]/g, '');
      if (d !== '') return d;
    }
    const mCol = L.match(/:\s*([\d.,]+)\s*$/);
    if (mCol) {
      const d = mCol[1].replace(/[^\d]/g, '');
      if (d !== '') return d;
    }
  }
  return null;
}

function extraerCamposPedido(bloque) {
  const b = normalizarTextoParaExtraerPedido(bloque);
  const finCampo = _RE_FIN_CAMPO_PEDIDO;

  let direccion = '';
  const dirPatrones = [
    // Con dos puntos: "📍 Dirección: …" / "📍 …:"
    new RegExp(`📍[^:\\n]*:\\s*([\\s\\S]*?)${finCampo}`, 'iu'),
    new RegExp(
      `(?:Direcci[oó]n\\s+completa|Direcci[oó]n|Ubicaci[oó]n|Direccion)[^:\\n]*:\\s*([\\s\\S]*?)${finCampo}`,
      'iu'
    ),
    // Sin dos puntos (formato WhatsApp): "📍 Dirección completa barrio …\nKR …"
    new RegExp(
      `📍\\s*(?:Direcci[oó]n(?:\\s+completa)?|Ubicaci[oó]n)?\\s*([\\s\\S]*?)${finCampo}`,
      'iu'
    ),
    new RegExp(
      `(?:Direcci[oó]n\\s+completa|Direcci[oó]n|Ubicaci[oó]n)\\b\\s+([\\s\\S]*?)${finCampo}`,
      'iu'
    ),
  ];
  for (const re of dirPatrones) {
    const m = b.match(re);
    if (m && m[1]) {
      direccion = m[1].trim().replace(/\n\s*/g, ' ').trim();
      if (direccion) break;
    }
  }

  let nombre = '';
  const finNombre = _RE_FIN_TRAS_NOMBRE;
  const nomPatrones = [
    new RegExp(`${_RE_EMOJI_NOMBRE}[^:\\n]*:\\s*([\\s\\S]*?)${finNombre}`, 'iu'),
    // Sin dos puntos: "🙋🏻 Nombre de quien recibirá el pedido\nleonide"
    new RegExp(
      `${_RE_EMOJI_NOMBRE}\\s*(?:Nombre[^\\n]*)?\\n+\\s*([^\\n]+)`,
      'iu'
    ),
    new RegExp(`Nombre[^:\\n]*:\\s*([\\s\\S]*?)${finNombre}`, 'iu'),
    /(?:Recibe|A\s+nombre\s+de|Contacto)\s*:\s*([^\n]+)/i,
  ];
  for (const re of nomPatrones) {
    const m = b.match(re);
    if (m && m[1]) {
      nombre = m[1].trim().split('\n')[0].trim();
      if (nombre) break;
    }
  }

  let telefono = '';
  let telefonos = [];
  const telPatrones = [
    new RegExp(
      `📲[^:\\n]*:\\s*([\\s\\S]*?)(?=💰|Producto|Pedido|Horario|¿Todo|Para agilizar|Env[ií]o|https?:|$)`,
      'u'
    ),
    // Sin dos puntos: "📲 Número de celular\n3018284151"
    new RegExp(
      `📲\\s*(?:N[uú]mero\\s+de\\s+celular|Celular|Tel[ée]fono|WhatsApp|M[oó]vil)?\\s*\\n+\\s*([\\d\\s+().-]{7,})`,
      'iu'
    ),
    new RegExp(
      `📲\\s*(?:N[uú]mero\\s+de\\s+celular|Celular|Tel[ée]fono)?\\s+([\\d\\s+().-]{7,})`,
      'iu'
    ),
    /(?:Tel[ée]fono|N[uú]mero\s+de\s+celular|Celular|WhatsApp|M[oó]vil)[^:\n]*:\s*([^\n]+)/i,
    /(?:N[uú]mero\s+de\s+celular|Celular|Tel[ée]fono)\b\s*\n+\s*([\d\s+().-]{7,})/i,
  ];
  for (const re of telPatrones) {
    const m = b.match(re);
    if (m && m[1]) {
      const telRaw = m[1].trim().split('\n')[0].trim();
      telefonos = normalizarTelefonosDesdeTexto(telRaw);
      telefono = telefonos[0] || '';
      if (telefono && telefono.length >= 7) break;
      telefono = '';
      telefonos = [];
    }
  }

  let valor = '0';
  const valorLineas = extraerValorAPagarDesdeBloque(b);
  if (valorLineas) {
    valor = valorLineas;
  } else {
    const finValor =
      `(?=Env[ií]o|Horario|Producto|¿Todo|Para agilizar|📍|${_RE_EMOJI_NOMBRE}|📲|💰|https?:|\\n\\s*\\d+:\\s*\\n?\\s*Para|$)`;
    const valPatrones = [
      new RegExp(
        `(?:Valor\\s+a\\s+pagar|Valor\\s+a\\s+recoger)[^:\\n]*:\\s*([\\s\\S]*?)${finValor}`,
        'i'
      ),
      new RegExp(`💰(?!\\s*Env[ií]o\\b)[^:\\n]*:\\s*([\\s\\S]*?)${finValor}`, 'iu'),
    ];
    for (const re of valPatrones) {
      const m = b.match(re);
      if (m && m[1]) {
        const raw = m[1].trim().split('\n')[0].trim();
        if (/env[ií]o|pagados|gracias/i.test(raw)) continue;
        const soloDigitos = raw.replace(/[^\d]/g, '');
        if (soloDigitos) {
          valor = soloDigitos;
          break;
        }
      }
    }
    if (!valor || valor === '0') {
      const respaldo = extraerMontoValorRespaldoSinEnvio(b);
      if (respaldo != null) valor = respaldo;
    }
  }

  // Solo productos entre "Producto" y "¿Todo en orden?"
  const productos = extraerProductosSoloDelBloque(b);

  return { direccion, nombre, telefono, telefonos, valor, productos };
}

function fetchConTimeout(url, opciones, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { ...opciones, signal: controller.signal }).finally(() => clearTimeout(timer));
}

async function resolverUrlCorta(url) {
  const proxies = [
    `https://corsproxy.io/?${encodeURIComponent(url)}`,
    `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
    `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
  ];
  for (const proxyUrl of proxies) {
    try {
      const resp = await fetchConTimeout(proxyUrl, {}, 12000);
      const html = await resp.text();
      const coords = extraerCoordenadas(html);
      if (coords) return coords;
      const urlsEnHtml = html.match(/https?:\/\/(?:(?:www\.)?google\.[a-z.]+\/maps|maps\.apple\.com)[^\s"'<>]+/g) || [];
      for (const u of urlsEnHtml) {
        let decoded;
        try { decoded = decodeURIComponent(u); } catch (e) { decoded = u; }
        const c = extraerCoordenadas(decoded);
        if (c) return c;
      }
      const llMatch = html.match(/"latitude"\s*:\s*(-?\d+(?:\.\d+)?).*?"longitude"\s*:\s*(-?\d+(?:\.\d+)?)/s);
      if (llMatch) {
        const lat = parseFloat(llMatch[1]), lng = parseFloat(llMatch[2]);
        if (!isNaN(lat) && !isNaN(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) return { lat, lng };
      }
      const centerMatch = html.match(/center=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
      if (centerMatch) {
        const lat = parseFloat(centerMatch[1]), lng = parseFloat(centerMatch[2]);
        if (!isNaN(lat) && !isNaN(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) return { lat, lng };
      }
    } catch (e) { continue; }
  }
  return null;
}

async function geocodificarParaCoordenadas(direccion) {
  const limpia = direccion.replace(/#/g, ' ').replace(/\s+/g, ' ').trim();
  const consultas = [
    limpia + ', Bogotá, Colombia',
    limpia + ', Bogotá',
    limpia,
  ];
  for (const q of consultas) {
    try {
      const resp = await fetchConTimeout(
        `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=1&countrycodes=co`,
        { headers: { 'User-Agent': 'DeliveryApp/1.0' } },
        10000
      );
      const data = await resp.json();
      if (data && data.length > 0) {
        return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
      }
    } catch (e) { continue; }
  }
  return null;
}

function estaEnZonaOperacion(coords) {
  if (!coords) return false;
  // Bogota y alrededores operativos
  return coords.lat >= 4.1 && coords.lat <= 5.2 && coords.lng >= -74.7 && coords.lng <= -73.5;
}

async function obtenerCoordenadas(url, direccion) {
  const coords = extraerCoordenadas(url);
  if (coords && estaEnZonaOperacion(coords)) return coords;
  if (/goo\.gl|maps\.app|maps\.apple/i.test(url)) {
    const resuelto = await resolverUrlCorta(url);
    if (resuelto && estaEnZonaOperacion(resuelto)) return resuelto;
  }
  if (direccion) {
    const geocod = await geocodificarParaCoordenadas(direccion);
    if (geocod && estaEnZonaOperacion(geocod)) return geocod;
  }
  return null;
}

async function procesarPedido() {
  if (sesionUsuario && !esSesionAdmin()) {
    mostrarToast('Solo un administrador puede registrar pedidos desde aquí.', 'warning');
    return;
  }
  const texto = document.getElementById("textoPedido").value.trim();
  if (!texto) {
    mostrarToast('Por favor, pega el formato del pedido', 'warning');
    return;
  }

  if ((texto.match(/Para agilizar tu pedido/g) || []).length > 1) {
    await procesarMultiplesPedidos(texto);
    return;
  }

  await mostrarLoadingYEsperarPintado();
  try {
  const textoLimpio = limpiarTimestampsChat(texto);

  const numeroMatch = textoLimpio.match(/(\d+):\s*\n?\s*Para\s+agilizar/i) || textoLimpio.match(/^(\d+):/m);
  const numeroPedido = numeroMatch ? parseInt(numeroMatch[1]) : null;

  const campos = extraerCamposPedido(textoLimpio);

  const urlsEnPegado = extraerTodasLasUrlsMapsEnTexto(textoLimpio);
  const mapUrl = urlsEnPegado.length > 0
    ? elegirUrlMapsParaBloque(textoLimpio, textoLimpio, 0, urlsEnPegado)
    : '';

  if (!mapUrl) {
    mostrarToast(
      'No se encontró URL de Google Maps en el texto pegado.\n\nAsegúrate de incluir el enlace de Maps junto con el formato del pedido.',
      'error',
      8000
    );
    return;
  }

  const btnProcesar = document.querySelector('.btn-primary');
  const textoOriginalBtn = btnProcesar ? btnProcesar.textContent : '';
  if (btnProcesar) { btnProcesar.textContent = 'Procesando...'; btnProcesar.disabled = true; }

  const coords = await obtenerCoordenadas(mapUrl, campos.direccion);

  if (btnProcesar) { btnProcesar.textContent = textoOriginalBtn; btnProcesar.disabled = false; }

  if (!coords) {
    const raw = extraerCoordenadas(mapUrl);
    const msgFueraZona =
      raw && !estaEnZonaOperacion(raw)
        ? 'El enlace tiene coordenadas fuera de Bogotá y alrededores. Si el pedido es en zona, pega un enlace completo desde Maps o corrige la dirección para geocodificar.'
        : '';
    mostrarToast(
      (msgFueraZona ||
        'No se pudieron obtener coordenadas en zona desde la URL ni desde la dirección (enlace solo con nombre de lugar, enlace corto fallido, etc.).') +
        '\n\nSe guardará el pedido sin coordenadas. Abre el enlace, copia el enlace completo y pégalo en el apartado de abajo para aplicar.',
      'warning',
      12000
    );
  }

  const idxExistente =
    numeroPedido != null
      ? pedidos.findIndex((p) => Number(p.id) === Number(numeroPedido))
      : -1;
  const pedidoId = idxExistente >= 0 ? Number(numeroPedido) : generarPedidoId(numeroPedido);
  const mapUrlFinal = coords && coords.lat && coords.lng
    ? `https://www.google.com/maps?q=${coords.lat},${coords.lng}`
    : mapUrl;

  const productosLimpios = Array.isArray(campos.productos) ? campos.productos : [];
  const valorLimpio = String(campos.valor || '0').replace(/[^\d]/g, '') || '0';

  let pedidoFinalId = pedidoId;
  if (idxExistente >= 0) {
    const prev = pedidos[idxExistente];
    prev.nombre = campos.nombre;
    prev.telefono = campos.telefono;
    prev.telefonos = Array.isArray(campos.telefonos) ? campos.telefonos : [];
    prev.direccion = campos.direccion;
    prev.productos = productosLimpios;
    prev.valor = valorLimpio;
    prev.valorOriginal = null;
    prev.valorModificado = false;
    prev.textoOriginal = texto;
    prev.mapUrl = mapUrlFinal;
    prev.coords = coords && coords.lat && coords.lng ? { lat: coords.lat, lng: coords.lng } : null;
    sincronizarAvisoTelefonoPedido(prev);
    pedidoFinalId = prev.id;
  } else {
    const baseNuevo = pedidoNuevoBase();
    if (sesionUsuario) baseNuevo.createdBy = String(sesionUsuario.id);
    const nuevoPedido = {
      id: pedidoId,
      nombre: campos.nombre,
      telefono: campos.telefono,
      telefonos: Array.isArray(campos.telefonos) ? campos.telefonos : [],
      direccion: campos.direccion,
      productos: productosLimpios,
      valor: valorLimpio,
      valorOriginal: null,
      valorModificado: false,
      textoOriginal: texto,
      mapUrl: mapUrlFinal,
      coords: coords && coords.lat && coords.lng ? { lat: coords.lat, lng: coords.lng } : null,
      ...baseNuevo
    };
    sincronizarAvisoTelefonoPedido(nuevoPedido);
    pedidos.push(nuevoPedido);
    pedidoFinalId = nuevoPedido.id;
  }

  guardarPedidos();
  renderPedidos();
  void forzarSyncPedidosAhora().catch((e) => console.error(e));
  const pedidoAviso = pedidos.find((p) => Number(p.id) === Number(pedidoFinalId));
  if (pedidoAviso && pedidoAviso.avisoTelefono) scrollToTopApp();

  setTimeout(() => {
    if (!mapa) return;
    if (!coords) return;
    procesarURLMapaPedido(mapUrlFinal, pedidoFinalId, productosLimpios, () => {
      ajustarVistaMapa();
      dibujarRutaEntreMarcadores();
    });
  }, 500);

  document.getElementById("textoPedido").value = "";
  const prodTxt = productosLimpios.length ? productosLimpios.join(' · ') : '(sin producto)';
  const valorTxt = Number(valorLimpio || 0).toLocaleString('es-CO');
  mostrarToast(
    `Pedido #${pedidoFinalId} ${idxExistente >= 0 ? 'actualizado' : 'agregado'}. Productos: ${prodTxt}. Valor: $${valorTxt}`,
    'success',
    9000
  );
  } finally {
    setAppLoadingVisible(false);
  }
}

async function procesarMultiplesPedidos(texto) {
  if (sesionUsuario && !esSesionAdmin()) {
    mostrarToast('Solo un administrador puede registrar pedidos desde aquí.', 'warning');
    return;
  }
  await mostrarLoadingYEsperarPintado();
  try {
  const textoLimpio = limpiarTimestampsChat(texto);
  // Algunos chats no incluyen “¿Todo en orden?” o cambia el texto, así que partimos por cada “Para agilizar…”.
  const bloques = (() => {
    const s = String(textoLimpio || '');
    // Sin flag /m: el $ del lookahead es solo fin de cadena. Con /m, $ coincide al final de cada línea y
    // el bloque se corta en la primera línea que termina en “…datos:”, dejando 📍/🙋 fuera del match.
    const re = /(^|\n)\s*(\d+):\s*\n?\s*Para\s+agilizar[\s\S]*?(?=\n\s*\d+:\s*\n?\s*Para\s+agilizar|$)/gi;
    const encontrados = [];
    let m;
    while ((m = re.exec(s))) {
      const bloque = (m[0] || '').replace(/^\n/, '').trim();
      if (bloque) encontrados.push(bloque);
    }
    if (encontrados.length > 0) return encontrados;
    const legacy = s.split(/¿Todo en orden\?\s*😊?\s*/).map((b) => b.trim()).filter(Boolean);
    return legacy;
  })();
  const urlsGlobal = extraerTodasLasUrlsMapsEnTexto(textoLimpio);

  // Mapa de URLs por número de pedido, según el orden en el chat.
  // En el formato de WhatsApp suele aparecer:
  //   N:
  //   <url maps>
  //   N:
  //   Para agilizar...
  // Pero a veces llega como:
  //   <url maps>
  //   N:
  //   Para agilizar...
  // Si solo usamos urlsGlobal por índice, se puede desalinear y repetir ubicaciones.
  const urlsPorNumero = (() => {
    const map = new Map();
    let numActual = null;
    const lineas = String(textoLimpio || '').split('\n');
    const pushUrl = (n, u) => {
      if (n == null) return;
      const nn = Number(n);
      if (!Number.isFinite(nn)) return;
      if (!map.has(nn)) map.set(nn, []);
      map.get(nn).push(String(u || '').trim());
    };

    for (let i = 0; i < lineas.length; i++) {
      const line = String(lineas[i] || '').trim();
      const mNum = line.match(/^(\d+):\s*$/);
      if (mNum) {
        numActual = Number(mNum[1]);
        continue;
      }

      const mUrl = line.match(patronUrlMapsRegexUna());
      if (!mUrl) continue;

      const u = mUrl[0].trim();

      // Caso normal: "N:" antes de la URL.
      if (numActual != null) {
        pushUrl(numActual, u);
        continue;
      }

      // Caso común en chats: la URL llega justo antes del "N:".
      // Buscamos el próximo "N:" cercano, deteniéndonos si aparece otro URL o "Para agilizar".
      let numCercano = null;
      for (let j = i + 1; j < Math.min(i + 8, lineas.length); j++) {
        const t = String(lineas[j] || '').trim();
        if (!t) continue;
        const mNum2 = t.match(/^(\d+):\s*$/);
        if (mNum2) { numCercano = Number(mNum2[1]); break; }
        if (patronUrlMapsRegexUna().test(t)) break;
        if (/Para\s+agilizar/i.test(t)) break;
      }
      if (numCercano != null) pushUrl(numCercano, u);
    }
    return map;
  })();

  let agregados = 0;
  let errores = [];

  const btnProcesar = document.querySelector('.btn-primary');
  const textoOriginalBtn = btnProcesar ? btnProcesar.textContent : '';

  let indicePedidoEnLote = 0;
  for (const bloque of bloques) {
    // Antes se exigía 📍; algunos formatos lo omiten o lo cambian.
    if (!/Para\s+agilizar/i.test(bloque)) continue;

    const numMatch = bloque.match(/(\d+):\s*\n?\s*Para\s+agilizar/i) || bloque.match(/(\d+):\s*\n/);
    const numLabel = numMatch ? '#' + numMatch[1] : '?';
    const numeroPedido = numMatch ? parseInt(numMatch[1]) : null;

    // 1) Primero, usa URL asociada al número (si existe).
    let mapUrl = '';
    if (numeroPedido != null && urlsPorNumero.has(numeroPedido) && urlsPorNumero.get(numeroPedido).length > 0) {
      mapUrl = urlsPorNumero.get(numeroPedido).shift();
    }
    // 2) Si no hay, intenta heurística por bloque / índice.
    if (!mapUrl) mapUrl = elegirUrlMapsParaBloque(textoLimpio, bloque, indicePedidoEnLote, urlsGlobal);
    indicePedidoEnLote += 1;

    if (!mapUrl) {
      errores.push(`Pedido ${numLabel}: No se encontró URL de Maps`);
      continue;
    }

    const campos = extraerCamposPedido(bloque);

    if (btnProcesar) { btnProcesar.textContent = `Procesando pedido ${numLabel}...`; btnProcesar.disabled = true; }

    const coords = await obtenerCoordenadas(mapUrl, campos.direccion);
    const sinCoords = !coords;
    if (sinCoords) {
      errores.push(`Pedido ${numLabel}: No se pudieron extraer coordenadas (se guardó sin coordenadas)`);
    }

    const pedidoId = generarPedidoId(numeroPedido);
    const mapUrlFinal = coords && coords.lat && coords.lng
      ? `https://www.google.com/maps?q=${coords.lat},${coords.lng}`
      : mapUrl;

    const baseLote = pedidoNuevoBase();
    if (sesionUsuario) baseLote.createdBy = String(sesionUsuario.id);
    const nuevoPedido = {
      id: pedidoId,
      nombre: campos.nombre,
      telefono: campos.telefono,
      telefonos: Array.isArray(campos.telefonos) ? campos.telefonos : [],
      direccion: campos.direccion,
      productos: Array.isArray(campos.productos) ? campos.productos : [],
      valor: campos.valor || '0',
      valorOriginal: null,
      valorModificado: false,
      textoOriginal: bloque.trim(),
      mapUrl: mapUrlFinal,
      coords: coords && coords.lat && coords.lng ? { lat: coords.lat, lng: coords.lng } : null,
      ...baseLote
    };
    sincronizarAvisoTelefonoPedido(nuevoPedido);
    pedidos.push(nuevoPedido);

    agregados++;
  }

  if (btnProcesar) { btnProcesar.textContent = textoOriginalBtn; btnProcesar.disabled = false; }

  if (agregados > 0) {
    guardarPedidos();
    renderPedidos();
    void forzarSyncPedidosAhora().catch((e) => console.error(e));
    if (pedidos.some((p) => p && p.avisoTelefono)) scrollToTopApp();
    setTimeout(() => actualizarMarcadores(), 500);
    document.getElementById("textoPedido").value = "";
  }

  let msg = `Se agregaron ${agregados} pedido(s)`;
  if (errores.length > 0) {
    msg += `\n\n⚠️ ${errores.length} pedido(s) no agregado(s):\n${errores.join('\n')}`;
  }
  mostrarToast(msg, errores.length > 0 ? 'warning' : 'success', errores.length > 0 ? 12000 : 6000);
  } finally {
    setAppLoadingVisible(false);
  }
}

function guardarPedidos() {
  pedidos = deduplicarPedidosPorId(pedidos);
  guardarCachePedidos();
  if (!sesionUsuario) return;
  bumpPedidosLocalRev();
  marcarPedidosSyncPendiente(true);
  if (syncPedidosEnCurso) {
    syncPedidosRepetir = true;
    return;
  }
  programarSyncPedidosRemoto();
}

function actualizarPestañasListaPedidos(pendientes, enCurso, entregados, cancelados) {
  const tabs = document.querySelectorAll('#pedidosTabs [data-vista-pedidos]');
  const cfg = {
    pendientes: { icon: 'fa-regular fa-clock', texto: 'Pendientes' },
    enCurso: { icon: 'fa-solid fa-truck-fast', texto: 'En ruta' },
    entregados: { icon: 'fa-solid fa-circle-check', texto: 'Finalizados' },
    cancelados: { icon: 'fa-solid fa-ban', texto: 'Cancelados' }
  };
  tabs.forEach((btn) => {
    const vista = btn.getAttribute('data-vista-pedidos');
    if (!vista || !cfg[vista]) return;
    let n = 0;
    if (vista === 'pendientes') n = pendientes.length;
    else if (vista === 'enCurso') n = enCurso.length;
    else if (vista === 'entregados') n = entregados.length;
    else if (vista === 'cancelados') n = cancelados.length;
    const { icon, texto } = cfg[vista];
    btn.innerHTML = `<i class="${icon}"></i> ${texto} (${n})`;
    btn.hidden = vista !== 'pendientes' && n === 0;
    btn.classList.toggle('active', vista === vistaPedidosActual);
  });
}

function uidPedidoAsignado(p) {
  const v = p.assignedTo;
  if (v == null || v === '') return '';
  return String(v).trim();
}

function obtenerValorAReclamarPedido(pedido) {
  const metodo = pedido && pedido.metodoPagoEntrega ? String(pedido.metodoPagoEntrega) : '';
  if (metodo === 'pagado_tienda' || metodo === 'es_cambio') return 0;
  const n = parseInt((pedido && pedido.valor) || 0, 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Si el cliente pagó (en parte) en efectivo y las vueltas se dieron por Nequi/Daviplata,
 * ese monto de cambio se queda en efectivo físico y sale del medio digital.
 * Ej: cobran $75.000, billete $100.000, vueltas $25.000 por Nequi
 * → efectivo $100.000, Nequi -$25.000 (neto a tienda sigue $75.000).
 */
function aplicarAjusteVueltasDigitalesSobreMontos(datosPago) {
  const out = {
    metodo: datosPago.metodo,
    montoNequi: Number(datosPago.montoNequi || 0),
    montoDaviplata: Number(datosPago.montoDaviplata || 0),
    montoEfectivo: Number(datosPago.montoEfectivo || 0),
    dioCambio: !!datosPago.dioCambio,
    cambioMetodo: String(datosPago.cambioMetodo || ''),
    montoCambio: Number(datosPago.montoCambio || 0),
  };
  if (!out.dioCambio || out.montoCambio <= 0) return out;
  const medio = out.cambioMetodo;
  if (medio !== 'nequi' && medio !== 'daviplata') return out;

  const pagoIncluyeEfectivo =
    out.montoEfectivo > 0 ||
    out.metodo === 'efectivo' ||
    out.metodo === 'nequi_efectivo' ||
    out.metodo === 'daviplata_efectivo';
  if (!pagoIncluyeEfectivo) return out;

  out.montoEfectivo += out.montoCambio;
  if (medio === 'nequi') out.montoNequi -= out.montoCambio;
  else out.montoDaviplata -= out.montoCambio;
  out.ajusteVueltasDigitales = true;
  return out;
}

function formatearMontoConSigno(n) {
  const v = Number(n || 0);
  if (v < 0) return `-$${Math.abs(v).toLocaleString('es-CO')}`;
  return `$${v.toLocaleString('es-CO')}`;
}

/** Tarifa fija por envío entregado o no entregado con recogida en punto. */
const TARIFA_PAGO_MENSAJERO = 12000;

/** Mismos filtros y sumas que el resumen del mensajero (Nequi, Daviplata, domicilio, etc.). */
function calcularTotalesEntregaPedidos(arr) {
  const lista = Array.isArray(arr) ? arr : [];
  /** Pedidos aún no finalizados: lo que falta cobrar al cliente (sin domicilio). */
  const totalDelDia = lista
    .filter((p) => !p.cancelado && !p.entregado)
    .reduce((sum, p) => sum + obtenerValorAReclamarPedido(p), 0);
  /** Suma de valores de pedidos entregados; pagado en tienda / cambio aportan 0. */
  const recogidoDelDia = lista
    .filter((p) => p.entregado && !p.noEntregado)
    .reduce((sum, p) => sum + obtenerValorAReclamarPedido(p), 0);
  const enviosEntregados = lista.filter((p) => p.entregado && !p.noEntregado).length;
  const enviosNoEntregadosEnPunto = lista.filter((p) => p.noEntregado && p.envioRecogido).length;
  const pagoDomiciliario = (enviosEntregados + enviosNoEntregadosEnPunto) * TARIFA_PAGO_MENSAJERO;
  const entregarTienda = Math.max(recogidoDelDia - pagoDomiciliario, 0);
  const totalPagadoNequi = lista
    .filter((p) => p.entregado && !p.noEntregado)
    .reduce((sum, p) => sum + Number(p.montoNequi || 0), 0);
  const totalPagadoDaviplata = lista
    .filter((p) => p.entregado && !p.noEntregado)
    .reduce((sum, p) => sum + Number(p.montoDaviplata || 0), 0);
  const totalPagadoEfectivo = lista
    .filter((p) => p.entregado && !p.noEntregado)
    .reduce((sum, p) => sum + Number(p.montoEfectivo || 0), 0);
  const hayDatos =
    totalDelDia > 0 ||
    recogidoDelDia > 0 ||
    pagoDomiciliario > 0 ||
    entregarTienda > 0 ||
    totalPagadoNequi !== 0 ||
    totalPagadoDaviplata !== 0 ||
    totalPagadoEfectivo !== 0;
  return {
    totalDelDia,
    recogidoDelDia,
    pagoDomiciliario,
    entregarTienda,
    totalPagadoNequi,
    totalPagadoDaviplata,
    totalPagadoEfectivo,
    hayDatos,
  };
}

function htmlBloqueTotalesResumen(totales, opts = {}) {
  const ocultarNequi = !!(opts && opts.ocultarNequi);
  const ocultarTotalDelDia = !!(opts && opts.ocultarTotalDelDia);
  const showNequi = !ocultarNequi && totales.totalPagadoNequi !== 0 ? 'inline-flex' : 'none';
  const showDav = totales.totalPagadoDaviplata !== 0 ? 'inline-flex' : 'none';
  const showEfectivo = totales.totalPagadoEfectivo !== 0 ? 'inline-flex' : 'none';
  const showPagoDomiciliario = totales.pagoDomiciliario > 0 ? 'inline-flex' : 'none';
  const fmt = (x) => Number(x).toLocaleString('es-CO');
  const fmtNeto = (x) => {
    const v = Number(x || 0);
    if (v < 0) return `-${Math.abs(v).toLocaleString('es-CO')}`;
    return fmt(v);
  };
  const etiquetaNequi =
    totales.totalPagadoNequi < 0 ? 'Cambio enviado por Nequi (neto)' : 'Recogido por Nequi';
  const etiquetaDav =
    totales.totalPagadoDaviplata < 0 ? 'Cambio enviado por Daviplata (neto)' : 'Recogido por Daviplata';
  const bloqueTotalDelDia = ocultarTotalDelDia
    ? ''
    : `<div class="total-item total-total-dia">` +
      `<span class="total-icon icon-total-dia"><i class="fa-solid fa-sack-dollar"></i></span>` +
      `Pendiente por recoger: $${fmt(totales.totalDelDia)}` +
      `</div>`;
  const bloqueNequi = ocultarNequi
    ? ''
    : `<div class="total-item total-nequi" style="display:${showNequi}">` +
      `<span class="total-icon icon-nequi"><i class="fa-solid fa-mobile-screen-button"></i></span>` +
      `${etiquetaNequi}: $${fmtNeto(totales.totalPagadoNequi)}` +
      `</div>`;
  return (
    `<div class="totales-resumen">` +
    `<div class="total-item total-recogido-dia">` +
    `<span class="total-icon icon-recogido-dia"><i class="fa-solid fa-sack-dollar"></i></span>` +
    `Total recogido en el día: $${fmt(totales.recogidoDelDia)}` +
    `</div>` +
    `<div class="total-item total-pago-domiciliario" style="display:${showPagoDomiciliario}">` +
    `<span class="total-icon icon-pago-domiciliario"><i class="fa-solid fa-motorcycle"></i></span>` +
    `Pago a domiciliario: $${fmt(totales.pagoDomiciliario)}` +
    `</div>` +
    `<div class="total-item total-entregar-tienda">` +
    `<span class="total-icon icon-entregar-tienda"><i class="fa-solid fa-store"></i></span>` +
    `A entregar a tienda: $${fmt(totales.entregarTienda)}` +
    `</div>` +
    bloqueTotalDelDia +
    bloqueNequi +
    `<div class="total-item total-daviplata" style="display:${showDav}">` +
    `<span class="total-icon icon-daviplata"><i class="fa-solid fa-wallet"></i></span>` +
    `${etiquetaDav}: $${fmtNeto(totales.totalPagadoDaviplata)}` +
    `</div>` +
    `<div class="total-item total-efectivo" style="display:${showEfectivo}">` +
    `<span class="total-icon icon-efectivo"><i class="fa-solid fa-money-bill-wave"></i></span>` +
    `Recogido en efectivo: $${fmt(totales.totalPagadoEfectivo)}` +
    `</div>` +
    `</div>`
  );
}

/** Contenedor legacy: los totales van dentro de cada tarjeta en `usuariosRolesAsignaciones`. */
function renderTotalesAdminPorMensajero() {
  const hostAdmin = document.getElementById('totalesAdminPorMensajero');
  if (!hostAdmin) return;
  hostAdmin.innerHTML = '';
  hostAdmin.style.display = 'none';
  hostAdmin.setAttribute('hidden', '');
  hostAdmin.setAttribute('aria-hidden', 'true');
  if (!esSesionAdmin()) return;
}

function pedidoTieneCoordsValidas(p) {
  return !!(
    p &&
    p.coords &&
    Number.isFinite(Number(p.coords.lat)) &&
    Number.isFinite(Number(p.coords.lng)) &&
    Number(p.coords.lat) >= -90 &&
    Number(p.coords.lat) <= 90 &&
    Number(p.coords.lng) >= -180 &&
    Number(p.coords.lng) <= 180
  );
}

function distanciaMetrosHaversine(a, b) {
  if (!a || !b) return Infinity;
  const lat1 = Number(a.lat), lon1 = Number(a.lng);
  const lat2 = Number(b.lat), lon2 = Number(b.lng);
  if (!Number.isFinite(lat1) || !Number.isFinite(lon1) || !Number.isFinite(lat2) || !Number.isFinite(lon2)) return Infinity;
  const R = 6371000;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLon / 2);
  const c = s1 * s1 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * s2 * s2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(c)));
}

function idsPedidosConCoordsMuyPegadas(lista, umbralMetros) {
  const out = new Set();
  const items = (Array.isArray(lista) ? lista : [])
    .filter((p) => p && !p.cancelado && pedidoTieneCoordsValidas(p))
    .map((p) => ({ id: Number(p.id), coords: { lat: Number(p.coords.lat), lng: Number(p.coords.lng) } }))
    .filter((x) => Number.isFinite(x.id));
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const d = distanciaMetrosHaversine(items[i].coords, items[j].coords);
      if (d <= umbralMetros) {
        out.add(items[i].id);
        out.add(items[j].id);
      }
    }
  }
  return out;
}

function pedidoNecesitaCorregirLinkMaps(p, opts = {}) {
  if (!p || p.cancelado) return false;
  const url = String(p.mapUrl || '').trim();
  if (!url) return false;
  const idsPegadas = opts && opts.idsPegadas instanceof Set ? opts.idsPegadas : null;
  if (pedidoTieneCoordsValidas(p)) {
    if (idsPegadas && idsPegadas.has(Number(p.id))) return true;
    return false;
  }
  const ext = extraerCoordenadas(url);
  return !ext;
}

function renderPanelLinksMapsPendientes() {
  const panel = document.getElementById('mapLinksPendientesPanel');
  const host = document.getElementById('mapLinksPendientesLista');
  if (!panel || !host) return;

  const UMBRAL_COORDS_MUY_PEGADAS_M = 30;
  const idsPegadas = idsPedidosConCoordsMuyPegadas(pedidos, UMBRAL_COORDS_MUY_PEGADAS_M);
  const pendientes = pedidos.filter((p) => pedidoNecesitaCorregirLinkMaps(p, { idsPegadas }));
  if (!pendientes.length) {
    panel.style.display = 'none';
    host.innerHTML = '';
    return;
  }

  const rows = pendientes
    .map((p) => {
      const id = Number(p.id);
      const url = String(p.mapUrl || '').trim();
      const safeUrl = escapeHtmlTexto(url);
      return (
        `<div class="map-links-item">` +
        `<div class="map-links-row-top">` +
        `<div class="map-links-pedido-label">Pedido #${escapeHtmlTexto(String(id))}</div>` +
        `<div class="map-links-url">${safeUrl}</div>` +
        `</div>` +
        `<div class="map-links-actions">` +
        `<button type="button" class="btn-map-open" onclick="abrirLinkMapsPendiente(${id})">Abrir</button>` +
        `</div>` +
        `<div class="map-links-input-wrap">` +
        `<input id="mapFixInput_${id}" class="map-links-input" type="text" placeholder="Pega aquí el enlace completo de Google Maps" value="">` +
        `<button type="button" class="btn-map-apply" onclick="void aplicarLinkMapsPendiente(${id})">Aplicar</button>` +
        `</div>` +
        `</div>`
      );
    })
    .join('');

  host.innerHTML = rows;
  panel.style.display = 'block';
}

function abrirLinkMapsPendiente(pedidoId) {
  const p = pedidos.find((x) => Number(x.id) === Number(pedidoId));
  if (!p) return;
  const url = String(p.mapUrl || '').trim();
  if (!url) return;
  window.open(url, '_blank');
}

async function aplicarLinkMapsPendiente(pedidoId) {
  const p = pedidos.find((x) => Number(x.id) === Number(pedidoId));
  if (!p) return;
  const input = document.getElementById(`mapFixInput_${Number(pedidoId)}`);
  const nuevaUrl = input ? String(input.value || '').trim() : '';
  if (!nuevaUrl) {
    mostrarToast('Pega un enlace completo de Google Maps para aplicar.', 'warning');
    return;
  }
  const coords = await obtenerCoordenadas(nuevaUrl, p.direccion);
  if (!coords) {
    const raw = extraerCoordenadas(nuevaUrl);
    if (raw && !estaEnZonaOperacion(raw)) {
      mostrarToast(
        'El enlace sí tiene coordenadas, pero quedan fuera de la zona operativa (Bogotá y alrededores). Revisa que sea el domicilio correcto o pega un link con ubicación en zona.',
        'warning',
        12000
      );
    } else {
      mostrarToast(
        'No se pudieron obtener coordenadas en zona desde ese enlace (faltan en la URL o solo hay nombre de sitio). Abre Maps, elige “Compartir” y pega el enlace completo, o uno que muestre @latitud,longitud en la barra de direcciones.',
        'error',
        12000
      );
    }
    return;
  }
  p.coords = { lat: coords.lat, lng: coords.lng };
  p.mapUrl = `https://www.google.com/maps?q=${coords.lat},${coords.lng}`;
  guardarPedidos();
  renderPedidos();
  setTimeout(() => actualizarMarcadores(), 200);
  mostrarToast(`Ubicación aplicada al pedido #${p.id}`, 'success');
}

function renderPedidos() {
  // Si en memoria quedaron duplicados (por cache o recargas), normalizar antes de pintar.
  pedidos = deduplicarPedidosPorId(pedidos);
  const lista = document.getElementById("listaPedidos");
  const pendientes = [];
  const enCurso = [];
  const entregados = [];
  const cancelados = [];
  pedidos.forEach((pedido, index) => {
    if (pedido.cancelado) cancelados.push({ pedido, index });
    else if (pedido.entregado) entregados.push({ pedido, index });
    else if (pedido.enCurso) enCurso.push({ pedido, index });
    else pendientes.push({ pedido, index });
  });

  if (!vistaPedidosSeleccionadaManual && !['entregados', 'cancelados'].includes(vistaPedidosActual)) {
    vistaPedidosActual = enCurso.length > 0 ? 'enCurso' : 'pendientes';
  }

  if (vistaPedidosActual === 'enCurso' && enCurso.length === 0) {
    vistaPedidosActual = 'pendientes';
  }
  if (vistaPedidosActual === 'entregados' && entregados.length === 0) {
    vistaPedidosActual = 'pendientes';
  }
  if (vistaPedidosActual === 'cancelados' && cancelados.length === 0) {
    vistaPedidosActual = 'pendientes';
  }

  if (pedidos.length === 0) {
    vistaPedidosActual = 'pendientes';
    vistaPedidosSeleccionadaManual = false;
    const subVacio = esSesionMensajero()
      ? 'Aún no tienes pedidos asignados. Cuando un administrador te asigne entregas, aparecerán aquí y podrás ordenar la ruta en el mapa.'
      : 'Pega un pedido desde WhatsApp en el cuadro de arriba.';
    lista.innerHTML = `<div class="empty-state" id="emptyState"><p>No hay pedidos aún</p><p style="font-size: 14px;">${escapeHtmlAttr(subVacio)}</p></div>`;
    actualizarPestañasListaPedidos([], [], [], []);
    const elResumenVacio = document.getElementById('totalesResumen');
    if (elResumenVacio) elResumenVacio.style.display = 'none';
    renderTotalesAdminPorMensajero();
    if (esSesionAdmin()) renderPanelAsignacionesMensajeros();
    renderPanelLinksMapsPendientes();
    renderListaOrdenEntrega();
    programarActualizacionFabNavegacion();
    actualizarBannerAvisosTelefono();
    return;
  }

  actualizarPestañasListaPedidos(pendientes, enCurso, entregados, cancelados);

  lista.innerHTML = "";

  if (vistaPedidosActual === 'enCurso') {
    lista.appendChild(crearSeccionPedidos('seccion-en-curso', enCurso, 'No hay pedidos en ruta'));
  } else if (vistaPedidosActual === 'entregados') {
    lista.appendChild(crearSeccionPedidos('seccion-entregados', entregados, 'No hay pedidos entregados'));
  } else if (vistaPedidosActual === 'cancelados') {
    lista.appendChild(crearSeccionPedidos('seccion-cancelados', cancelados, 'No hay pedidos cancelados'));
  } else {
    lista.appendChild(crearSeccionPedidos('seccion-pendientes', pendientes, 'No hay pedidos pendientes'));
  }

  renderTotalesAdminPorMensajero();

  const elResumen = document.getElementById('totalesResumen');
  const totales = calcularTotalesEntregaPedidos(pedidos);
  if (elResumen) {
    const elTotalDelDia = document.getElementById('totalDelDia');
    const elRecogidoDia = document.getElementById('totalRecogidoDia');
    const elPagoDomiciliario = document.getElementById('totalPagoDomiciliario');
    const elEntregarTienda = document.getElementById('totalEntregarTienda');
    const elPagadoNequi = document.getElementById('totalPagadoNequi');
    const elPagadoDaviplata = document.getElementById('totalPagadoDaviplata');
    const elPagadoEfectivo = document.getElementById('totalPagadoEfectivo');
    const itemNequi = elPagadoNequi ? elPagadoNequi.closest('.total-item') : null;
    const itemDaviplata = elPagadoDaviplata ? elPagadoDaviplata.closest('.total-item') : null;
    const itemEfectivo = elPagadoEfectivo ? elPagadoEfectivo.closest('.total-item') : null;
    const itemPagoDomiciliario = elPagoDomiciliario ? elPagoDomiciliario.closest('.total-item') : null;
    const itemEntregarTienda = elEntregarTienda ? elEntregarTienda.closest('.total-item') : null;
    const itemTotalDelDia = elTotalDelDia ? elTotalDelDia.closest('.total-item') : null;

    if (elTotalDelDia) elTotalDelDia.textContent = totales.totalDelDia.toLocaleString('es-CO');
    if (elRecogidoDia) elRecogidoDia.textContent = totales.recogidoDelDia.toLocaleString('es-CO');
    if (elPagoDomiciliario) elPagoDomiciliario.textContent = totales.pagoDomiciliario.toLocaleString('es-CO');
    if (elEntregarTienda) elEntregarTienda.textContent = totales.entregarTienda.toLocaleString('es-CO');
    if (elPagadoNequi) {
      elPagadoNequi.textContent =
        totales.totalPagadoNequi < 0
          ? `-${Math.abs(totales.totalPagadoNequi).toLocaleString('es-CO')}`
          : totales.totalPagadoNequi.toLocaleString('es-CO');
      if (itemNequi) {
        const label =
          totales.totalPagadoNequi < 0 ? 'Cambio enviado por Nequi (neto): $' : 'Recogido por Nequi: $';
        const icon = itemNequi.querySelector('.total-icon');
        itemNequi.innerHTML = '';
        if (icon) itemNequi.appendChild(icon);
        itemNequi.appendChild(document.createTextNode(` ${label}`));
        itemNequi.appendChild(elPagadoNequi);
      }
    }
    if (elPagadoDaviplata) {
      elPagadoDaviplata.textContent =
        totales.totalPagadoDaviplata < 0
          ? `-${Math.abs(totales.totalPagadoDaviplata).toLocaleString('es-CO')}`
          : totales.totalPagadoDaviplata.toLocaleString('es-CO');
      if (itemDaviplata) {
        const label =
          totales.totalPagadoDaviplata < 0
            ? 'Cambio enviado por Daviplata (neto): $'
            : 'Recogido por Daviplata: $';
        const icon = itemDaviplata.querySelector('.total-icon');
        itemDaviplata.innerHTML = '';
        if (icon) itemDaviplata.appendChild(icon);
        itemDaviplata.appendChild(document.createTextNode(` ${label}`));
        itemDaviplata.appendChild(elPagadoDaviplata);
      }
    }
    if (elPagadoEfectivo) elPagadoEfectivo.textContent = totales.totalPagadoEfectivo.toLocaleString('es-CO');
    if (itemNequi)
      itemNequi.style.display = totales.totalPagadoNequi !== 0 ? 'inline-flex' : 'none';
    if (itemDaviplata)
      itemDaviplata.style.display = totales.totalPagadoDaviplata !== 0 ? 'inline-flex' : 'none';
    if (itemEfectivo) itemEfectivo.style.display = totales.totalPagadoEfectivo !== 0 ? 'inline-flex' : 'none';
    if (itemPagoDomiciliario)
      itemPagoDomiciliario.style.display = totales.pagoDomiciliario > 0 ? 'inline-flex' : 'none';
    if (itemEntregarTienda)
      itemEntregarTienda.style.display =
        totales.recogidoDelDia > 0 || totales.pagoDomiciliario > 0 ? 'inline-flex' : 'none';
    if (itemTotalDelDia)
      itemTotalDelDia.style.display = totales.totalDelDia > 0 ? 'inline-flex' : 'none';
    elResumen.style.display = totales.hayDatos ? 'flex' : 'none';
  }

  renderPanelLinksMapsPendientes();
  renderListaOrdenEntrega();
  ajustarMapaConReintentos();
  programarActualizacionFabNavegacion();
  actualizarBannerAvisosTelefono();
}

function cambiarVistaPedidos(vista) {
  if (!['pendientes', 'enCurso', 'entregados', 'cancelados'].includes(vista)) return;
  let n = 0;
  if (vista === 'pendientes') {
    n = pedidos.filter((p) => !p.cancelado && !p.entregado && !p.enCurso).length;
  } else if (vista === 'enCurso') {
    n = pedidos.filter((p) => !p.cancelado && !p.entregado && p.enCurso).length;
  } else if (vista === 'entregados') {
    n = pedidos.filter((p) => p.entregado).length;
  } else if (vista === 'cancelados') {
    n = pedidos.filter((p) => p.cancelado).length;
  }
  if (vista !== 'pendientes' && n === 0) return;
  vistaPedidosSeleccionadaManual = true;
  vistaPedidosActual = vista;
  renderPedidos();
}

function htmlOpcionesMensajerosSelect(pedido) {
  const actual = String(pedido.assignedTo || '');
  let html = `<option value=""${actual === '' ? ' selected' : ''}>Sin asignar</option>`;
  for (const m of listaMensajerosCache) {
    const sel = actual === String(m.id) ? ' selected' : '';
    html += `<option value="${m.id}"${sel}>${escapeHtmlTexto(m.username)}</option>`;
  }
  return html;
}

async function cargarMensajerosParaAsignacion() {
  if (!esSesionAdmin()) return;
  try {
    const data = await apiJson('/api/users', { method: 'GET' });
    listaMensajerosCache = (data.users || []).filter((u) => u.role === 'mensajero');
    const bulk = document.getElementById('bulkAssignSelect');
    if (bulk) {
      bulk.innerHTML =
        '<option value="">Elegir mensajero…</option>' +
        listaMensajerosCache
          .map((m) => `<option value="${m.id}">${escapeHtmlTexto(m.username)}</option>`)
          .join('');
    }
  } catch (e) {
    console.error(e);
    listaMensajerosCache = [];
  }
}

async function asignarPedidoDesdeSelect(selectEl) {
  const pedidoId = Number(selectEl.getAttribute('data-asign-pedido-id'));
  if (!Number.isFinite(pedidoId)) return;
  const raw = String(selectEl.value || '').trim();
  const prev = selectEl.getAttribute('data-prev-value') || '';
  const userId = raw === '' ? null : Number(raw);
  if (raw !== '' && !Number.isFinite(userId)) return;
  const nombreMensajero = nombreMensajeroPorId(userId);
  const mensajeCarga =
    userId == null
      ? 'Quitando la asignación del pedido…'
      : nombreMensajero
        ? `Asignando el pedido al mensajero ${nombreMensajero}…`
        : 'Asignando el pedido al mensajero…';
  selectEl.disabled = true;
  await mostrarLoadingYEsperarPintado(mensajeCarga);
  try {
    await apiJson(`/api/orders/${pedidoId}/assign`, {
      method: 'PATCH',
      body: JSON.stringify({ userId }),
    });
    selectEl.setAttribute('data-prev-value', raw);
    await refrescarPedidosDesdeApi();
    renderPedidos();
    actualizarMarcadores();
    mostrarToast('Asignación guardada', 'success');
  } catch (e) {
    mostrarToast(String(e.message || e), 'error');
    selectEl.value = prev || '';
  } finally {
    setAppLoadingVisible(false);
    try {
      selectEl.disabled = false;
    } catch (_e) {}
  }
}

async function asignarActivosBulkDesdeBarra() {
  const sel = document.getElementById('bulkAssignSelect');
  if (!sel) return;
  const uid = Number(sel.value);
  if (!Number.isFinite(uid)) {
    mostrarToast('Elige un mensajero en la lista.', 'warning');
    return;
  }
  const orderIds = pedidos.filter((p) => !p.entregado && !p.cancelado).map((p) => p.id);
  if (orderIds.length === 0) {
    mostrarToast('No hay pedidos activos para asignar.', 'info');
    return;
  }
  const nombreMensajero = nombreMensajeroPorId(uid);
  const mensajeCarga = nombreMensajero
    ? `Asignando ${orderIds.length} pedido(s) al mensajero ${nombreMensajero}…`
    : `Asignando ${orderIds.length} pedido(s) al mensajero…`;
  const bulkBtn = document.getElementById('bulkAssignBtn');
  sel.disabled = true;
  if (bulkBtn) bulkBtn.disabled = true;
  await mostrarLoadingYEsperarPintado(mensajeCarga);
  try {
    await apiJson('/api/orders/assign-bulk', {
      method: 'POST',
      body: JSON.stringify({ userId: uid, orderIds }),
    });
    await refrescarPedidosDesdeApi();
    renderPedidos();
    actualizarMarcadores();
    mostrarToast(`${orderIds.length} pedido(s) asignado(s).`, 'success');
  } catch (e) {
    mostrarToast(String(e.message || e), 'error');
  } finally {
    setAppLoadingVisible(false);
    sel.disabled = false;
    if (bulkBtn) bulkBtn.disabled = false;
  }
}

function aplicarVisibilidadPorRol() {
  const pegar = document.getElementById('sectionPegarPedido');
  if (pegar) {
    if (esSesionAdmin()) {
      pegar.style.display = '';
      pegar.removeAttribute('aria-hidden');
    } else {
      pegar.style.display = 'none';
      pegar.setAttribute('aria-hidden', 'true');
    }
  }
  const btnDel = document.getElementById('btnEliminarTodos');
  if (btnDel) btnDel.style.display = esSesionAdmin() ? '' : 'none';
  const bulk = document.getElementById('bulkAssignBar');
  if (bulk) bulk.style.display = esSesionAdmin() ? 'flex' : 'none';
  const btnMenuUsuarios = document.getElementById('btnMenuUsuarios');
  if (btnMenuUsuarios) btnMenuUsuarios.style.display = esSesionAdmin() ? '' : 'none';
  const btnMenuHistorial = document.getElementById('btnMenuHistorialEntregas');
  if (btnMenuHistorial) btnMenuHistorial.style.display = esSesionAdmin() ? '' : 'none';
  const btnMediosPagoMenu = document.getElementById('btnMediosPagoMenu');
  if (btnMediosPagoMenu) btnMediosPagoMenu.style.display = esSesionMensajero() ? '' : 'none';
}

function crearSeccionPedidos(claseExtra, items, textoVacio) {
  const seccion = document.createElement('div');
  seccion.className = `pedidos-seccion ${claseExtra}`;

  const contenido = document.createElement('div');
  contenido.className = 'pedidos-seccion-lista';

  if (items.length === 0) {
    contenido.innerHTML = `<div class="empty-state" style="padding:20px;"><p style="font-size:15px;">${textoVacio}</p></div>`;
  } else {
    items.forEach(({ pedido, index }) => contenido.appendChild(crearTarjetaPedido(pedido, index)));
  }

  seccion.appendChild(contenido);
  return seccion;
}

function crearTarjetaPedido(pedido, index) {
  const div = document.createElement("div");
  div.className = "pedido"
    + (pedido.entregado ? " entregado" : "")
    + (pedido.enCurso && !pedido.entregado ? " en-curso" : "")
    + (pedido.cancelado ? " cancelado" : "");
  const adminUi = esSesionAdmin();
  div.draggable = !pedido.entregado && !pedido.cancelado;
  div.dataset.index = index;
  div.dataset.id = pedido.id;

  const telefonoHtml = htmlTelefonosPedidoParaTarjeta(pedido) || (pedido.telefono ? String(pedido.telefono) : '');
  const valorFormato = obtenerValorAReclamarPedido(pedido).toLocaleString('es-CO');
  const btnNoEntregadoHtml = pedido.entregado
    ? `<div class="pedido-no-entregado-wrap"><button class="btn-warning" onclick="marcarNoEntregado(${index})" style="width: 100%;"><i class="fa-solid fa-rotate-left"></i> No entregado</button></div>`
    : '';
  const btnNotificarClientePorteriaHtml = pedidoPendienteNotificarClientePorteria(pedido)
    ? `<div class="pedido-no-entregado-wrap"><button class="btn-notify" onclick="notificarClienteEntregaPorteria(${index}, ${pedido.id})" style="width: 100%;"><i class="fa-brands fa-whatsapp"></i> Notificar al cliente (portería)</button></div>`
    : '';
  const btnNotificarClienteNoEntregadoHtml = pedidoPendienteNotificarClienteNoEntregado(pedido)
    ? `<div class="pedido-no-entregado-wrap"><button class="btn-notify" onclick="notificarClienteNoEntregado(${index}, ${pedido.id})" style="width: 100%;"><i class="fa-brands fa-whatsapp"></i> Notificar al cliente (no entregado)</button></div>`
    : '';
  const etapaActual = obtenerEtapaPedidoUI(pedido);
  let btnRegresarEtapaHtml = '';
  if (etapaActual === 'enRuta') {
    btnRegresarEtapaHtml = `<button type="button" class="btn-info" onclick="marcarPendiente(${index})"><i class="fa-solid fa-rotate-left"></i> Regresar a pendientes</button>`;
  } else if (etapaActual === 'enDestino') {
    btnRegresarEtapaHtml = `<button type="button" class="btn-info" onclick="marcarRegresarAEnRuta(${index})"><i class="fa-solid fa-rotate-left"></i> Regresar a en ruta</button>`;
  } else if (etapaActual === 'finalizado') {
    btnRegresarEtapaHtml = `<button type="button" class="btn-info" onclick="marcarRegresarAEnRuta(${index})" style="width:100%;"><i class="fa-solid fa-rotate-left"></i> Regresar a en ruta</button>`;
  }
  const btnReactivarCanceladoHtml =
    adminUi && pedido.cancelado
      ? `<button class="btn-success" onclick="reactivarPedidoCancelado(${index})"><i class="fa-solid fa-rotate-left"></i> Reactivar pedido</button>`
      : '';
  const textoBotonNotificar = pedido.notificadoEnCamino
    ? 'Volver a notificar'
    : tieneNotificacionEnCaminoParcial(pedido)
      ? 'Notificar al otro número'
      : 'Notificar en camino';
  const btnNotificarHtml =
    etapaActual === 'notificar'
      ? `<button class="btn-notify" onclick="notificarEnCamino(${index}, ${pedido.id}, { abrirEnrutarDespues: true })"><i class="fa-solid fa-bullhorn"></i> ${textoBotonNotificar}</button>`
      : '';
  const btnNotificarNuevamenteHtml =
    !pedido.entregado &&
    !pedido.cancelado &&
    pedido.notificadoEnCamino &&
    etapaActual !== 'enRuta' &&
    etapaActual !== 'enDestino'
      ? `<button class="btn-notify" onclick="notificarEnCamino(${index}, ${pedido.id}, { forzarReenvio: true })"><i class="fa-solid fa-bullhorn"></i> Notificar nuevamente al cliente</button>`
      : '';
  const btnEnrutarHtml = etapaActual === 'enrutar'
    ? `<button class="btn-route" onclick="enrutarConApps(${index}, ${pedido.id})"><i class="fa-solid fa-route"></i> Enrutar</button>`
    : '';
  const btnEnrutarNuevamenteHtml =
    etapaActual === 'enRuta' || (etapaActual === 'notificar' && !!pedido.haSidoEnrutado)
      ? `<button class="btn-route" onclick="enrutarConApps(${index}, ${pedido.id})"><i class="fa-solid fa-route"></i> Enrutar nuevamente</button>`
      : '';
  const btnLlegueDestinoHtml = etapaActual === 'enRuta'
    ? `<button class="btn-primary" onclick="marcarLlegueDestino(${index}, ${pedido.id})"><i class="fa-solid fa-flag-checkered"></i> Llegué al destino</button>`
    : '';
  const bloqueAccionesDestinoHtml = etapaActual === 'enDestino'
    ? `
      <div class="pedido-actions-row">
        <button class="btn-success" onclick="mostrarOpcionesFinalizarEntrega(${index}, ${pedido.id})"><i class="fa-solid fa-circle-check"></i> Finalizar entrega</button>
      </div>
    `
    : '';

  const estadoTexto = pedido.entregado
    ? (pedido.noEntregado ? ' - No entregado' : ' - Entregado')
    : (pedido.cancelado ? ' - Cancelado' : (pedido.enCurso ? (pedido.llegoDestino ? ' - En destino' : ' - En ruta') : ''));

  div.innerHTML = `
    <div class="pedido-header">
      <div class="pedido-numero">Pedido #${pedido.id}${estadoTexto}</div>
      <div class="pedido-header-btns">
        ${adminUi && !pedido.cancelado ? `<button class="btn-edit" onclick="editarPedido(${index})" style="padding: 5px 10px; font-size: 12px;"><i class="fa-solid fa-pen-to-square"></i> Editar</button>` : ''}
        ${adminUi ? `<button class="btn-danger btn-icon-only" onclick="eliminarPedido(${index})" title="Eliminar pedido" aria-label="Eliminar pedido"><i class="fa-solid fa-trash"></i></button>` : ''}
      </div>
    </div>
    <div class="pedido-cliente">${pedido.nombre || 'Cliente no especificado'}</div>
    <div class="pedido-info">
      <strong>Teléfono:</strong> ${telefonoHtml || 'No especificado'}<br>
      <strong>Dirección:</strong> ${pedido.direccion || 'No especificada'}
      <button class="btn-copy-inline" onclick="copiarDireccionPedido(${index})" title="Copiar dirección">
        <i class="fa-regular fa-copy"></i> Copiar
      </button><br>
      <strong class="pedido-etiqueta-productos">Productos:</strong><div class="pedido-productos-lista">${htmlProductosPedidoMultilinea(pedido)}</div><div class="pedido-fila-valor"><strong>Valor:</strong> $${valorFormato}${pedido.valorModificado ? ' <span class="pedido-valor-modificado">(modificado)</span>' : ''}</div>
    </div>
    ${
      adminUi
        ? `<div class="pedido-asignacion"><label class="pedido-asignacion-label" for="asignSel_${pedido.id}"><i class="fa-solid fa-motorcycle"></i> Asignar a mensajero</label><select id="asignSel_${pedido.id}" class="pedido-asignacion-select" data-asign-pedido-id="${pedido.id}" data-prev-value="${escapeHtmlAttr(String(pedido.assignedTo || ''))}" onchange="asignarPedidoDesdeSelect(this)">${htmlOpcionesMensajerosSelect(pedido)}</select></div>`
        : ''
    }
    ${etapaActual === 'enDestino' ? `
    <div class="pedido-tools">
      <details class="pedido-dropdown">
        <summary class="btn-info"><i class="fa-solid fa-address-book"></i> Contacto</summary>
        <div class="pedido-dropdown-content">
          <button class="btn-success" onclick="contactarPedido(${index}, 'wa_call')"><i class="fa-brands fa-whatsapp"></i> Llamar por WhatsApp</button>
          <button class="btn-success" onclick="contactarPedido(${index}, 'wa_msg')"><i class="fa-brands fa-whatsapp"></i> Mensaje por WhatsApp</button>
          <button class="btn-info" onclick="contactarPedido(${index}, 'call')"><i class="fa-solid fa-phone"></i> Llamada normal</button>
        </div>
      </details>
      <details class="pedido-dropdown">
        <summary class="btn-support"><i class="fa-solid fa-headset"></i> Soporte</summary>
        <div class="pedido-dropdown-content">
          <button class="btn-support" onclick="soporteLlamarWhatsApp()"><i class="fa-brands fa-whatsapp"></i> Llamar por WhatsApp</button>
          <button class="btn-support" onclick="mostrarOpcionesMensajeSoporte(${index})"><i class="fa-solid fa-comment-dots"></i> Mensaje por WhatsApp</button>
          <button class="btn-info" onclick="soporteLlamadaNormal()"><i class="fa-solid fa-phone"></i> Llamada normal</button>
        </div>
      </details>
    </div>` : ''}
    <div class="pedido-actions">
      ${btnRegresarEtapaHtml ? `<div class="pedido-actions-row">${btnRegresarEtapaHtml}</div>` : ''}
      ${btnNotificarHtml ? `<div class="pedido-actions-row">${btnNotificarHtml}</div>` : ''}
      ${btnNotificarNuevamenteHtml ? `<div class="pedido-actions-row">${btnNotificarNuevamenteHtml}</div>` : ''}
      ${btnEnrutarHtml ? `<div class="pedido-actions-row">${btnEnrutarHtml}</div>` : ''}
      ${btnEnrutarNuevamenteHtml ? `<div class="pedido-actions-row">${btnEnrutarNuevamenteHtml}</div>` : ''}
      ${btnLlegueDestinoHtml ? `<div class="pedido-actions-row">${btnLlegueDestinoHtml}</div>` : ''}
      ${bloqueAccionesDestinoHtml}
      ${btnReactivarCanceladoHtml ? `<div class="pedido-actions-row">${btnReactivarCanceladoHtml}</div>` : ''}
    </div>
    ${btnNotificarClientePorteriaHtml}
    ${btnNotificarClienteNoEntregadoHtml}
    ${btnNoEntregadoHtml}
  `;

  div.addEventListener('dragstart', handleDragStart);
  div.addEventListener('dragover', handleDragOver);
  div.addEventListener('drop', handleDrop);
  div.addEventListener('dragend', handleDragEnd);
  return div;
}

function renderListaOrdenEntrega() {
  const listaOrden = document.getElementById('listaOrdenEntrega');
  if (!listaOrden) return;

  const pedidosActivos = pedidos.filter(p => !p.entregado && !p.cancelado);
  if (pedidosActivos.length === 0) {
    listaOrden.innerHTML = '<div class="orden-vacio">No hay pedidos activos</div>';
    return;
  }

  listaOrden.innerHTML = '';
  pedidosActivos.forEach((pedido) => {
    const item = document.createElement('div');
    item.className = 'orden-item';
    item.dataset.id = String(pedido.id);
    item.draggable = false;

    const texto = document.createElement('span');
    texto.className = 'orden-item-text';
    texto.textContent = `Pedido #${pedido.id}`;

    const acciones = document.createElement('span');
    acciones.className = 'orden-item-acciones';
    const mkBtn = (delta, sym, titulo) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.draggable = false;
      b.className = 'orden-flecha';
      b.textContent = sym;
      b.title = titulo;
      b.setAttribute('aria-label', titulo);
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
        moverPedidoUnPasoEnOrdenActiva(pedido.id, delta);
      });
      return b;
    };
    acciones.appendChild(mkBtn(-1, '▲', 'Subir en la ruta'));
    acciones.appendChild(mkBtn(1, '▼', 'Bajar en la ruta'));

    if (pedido.enCurso && !pedido.entregado && !pedido.cancelado) {
      const idxGlobal = pedidos.findIndex((p) => Number(p.id) === Number(pedido.id));
      if (idxGlobal >= 0) {
        const bPend = document.createElement('button');
        bPend.type = 'button';
        bPend.className = 'orden-btn-a-pendiente';
        if (pedido.llegoDestino) {
          bPend.title = 'Regresar pedido a en ruta';
          bPend.setAttribute('aria-label', 'Regresar pedido a en ruta');
          bPend.addEventListener('click', (ev) => {
            ev.stopPropagation();
            ev.preventDefault();
            marcarRegresarAEnRuta(idxGlobal);
          });
        } else {
          bPend.title = 'Regresar pedido a pendientes';
          bPend.setAttribute('aria-label', 'Regresar pedido a pendientes');
          bPend.addEventListener('click', (ev) => {
            ev.stopPropagation();
            ev.preventDefault();
            marcarPendiente(idxGlobal);
          });
        }
        bPend.innerHTML = '<i class="fa-solid fa-rotate-left" aria-hidden="true"></i>';
        acciones.appendChild(bPend);
      }
    }

    item.appendChild(texto);
    item.appendChild(acciones);

    listaOrden.appendChild(item);
  });
}

/** Mueve un pedido activo una posición arriba/abajo en la lista de ruta (mismo criterio que el panel lateral). */
function moverPedidoUnPasoEnOrdenActiva(pedidoId, delta) {
  const activos = pedidos.filter((p) => !p.entregado && !p.cancelado);
  const i = activos.findIndex((p) => p.id === pedidoId);
  if (i < 0) return;
  const j = i + delta;
  if (j < 0 || j >= activos.length) return;
  const targetId = activos[j].id;
  void (async () => {
    if (!(await advertirSiAdminReordenaAsignados([pedidoId, targetId]))) return;
    if (moverPedidoPorId(pedidoId, targetId)) {
      guardarPedidos();
      renderPedidos();
      // Al cambiar el orden solo recalculamos la ruta; no recreamos marcadores ni reencuadramos el mapa.
      redibujarRutaDebounced(120);
      if (esSesionAdmin()) {
        void notificarMensajerosOrdenActualizado();
      }
    }
  })();
}

function idsRutaActivaMensajeroDesdeOrdenActual(uid) {
  const key = String(uid || '').trim();
  if (!key) return [];
  return pedidos
    .filter((p) => !p.cancelado && !p.entregado && String(p.assignedTo || '').trim() === key)
    .map((p) => Number(p.id))
    .filter(Number.isFinite);
}

async function notificarMensajerosOrdenActualizado() {
  if (!esSesionAdmin()) return;
  const activosAsignados = pedidos.filter((p) => !p.cancelado && !p.entregado && String(p.assignedTo || '').trim());
  const uids = [...new Set(activosAsignados.map((p) => String(p.assignedTo || '').trim()).filter(Boolean))];
  if (uids.length === 0) return;
  for (const uid of uids) {
    const routeIds = idsRutaActivaMensajeroDesdeOrdenActual(uid);
    if (!routeIds.length) continue;
    const m = (listaMensajerosCache || []).find((x) => String(x.id) === String(uid));
    const nombre = m ? String(m.username || uid) : String(uid);
    try {
      await apiJson(`/api/routes/${encodeURIComponent(String(uid))}`, {
        method: 'PATCH',
        body: JSON.stringify({
          routeIds,
          message: `Un administrador modificó el orden de tus pedidos asignados.`,
        }),
      });
      mostrarToast(`Se actualizó el orden para ${nombre}.`, 'success', 4500);
    } catch (e) {
      console.error(e);
      const status = e && e.status ? ` (HTTP ${e.status})` : '';
      const msg = e && e.message ? ` ${String(e.message)}` : '';
      mostrarToast(`No se pudo modificar el orden de ${nombre}.${status}${msg}`, 'warning', 9000);
    }
  }
}

function moverPedidoPorId(draggedId, targetId) {
  const draggedIndex = pedidos.findIndex((p) => Number(p.id) === Number(draggedId));
  const targetIndex = pedidos.findIndex((p) => Number(p.id) === Number(targetId));
  if (draggedIndex < 0 || targetIndex < 0 || draggedIndex === targetIndex) return false;

  const [removed] = pedidos.splice(draggedIndex, 1);
  pedidos.splice(targetIndex, 0, removed);
  return true;
}

async function confirmarEnModalApp({ titulo, texto, confirmar = 'Modificar orden', cancelar = 'Cancelar' }) {
  return await new Promise((resolve) => {
    mostrarModalDecision({
      titulo,
      texto,
      textoConfirmar: confirmar,
      textoCancelar: cancelar,
      claseConfirmar: 'btn-warning',
      mostrarSecundario: false,
      onConfirmar: () => resolve(true),
      onCancelar: () => resolve(false),
    });
  });
}

async function advertirSiAdminReordenaAsignados(idsPedidos) {
  if (!esSesionAdmin()) return true;
  const uids = new Set();
  for (const pid of idsPedidos) {
    const p = pedidos.find((x) => Number(x.id) === Number(pid));
    const a = String(p?.assignedTo || '').trim();
    if (a) uids.add(a);
  }
  if (uids.size === 0) return true;
  const nombres = [...uids]
    .map((uid) => {
      const m = (listaMensajerosCache || []).find((x) => String(x.id) === String(uid));
      return m ? String(m.username || uid) : String(uid);
    })
    .join(', ');
  return await confirmarEnModalApp({
    titulo: 'Pedidos ya asignados',
    texto: `Estos pedidos ya fueron asignados a ${nombres}.\n\nSi modificas el orden aquí, también cambiará el orden que verá el mensajero.\n\n¿Deseas modificar el orden?`,
    confirmar: 'Sí, modificar',
    cancelar: 'No',
  });
}

/** Inserta el pedido inmediatamente antes de `beforeId` (tras quitar el arrastrado del array). */
function moverPedidoAntesDeId(draggedId, beforeId) {
  if (Number(draggedId) === Number(beforeId)) return false;
  const draggedIndex = pedidos.findIndex((p) => Number(p.id) === Number(draggedId));
  if (draggedIndex < 0) return false;
  const [removed] = pedidos.splice(draggedIndex, 1);
  const insertAt = pedidos.findIndex((p) => Number(p.id) === Number(beforeId));
  if (insertAt < 0) {
    pedidos.splice(draggedIndex, 0, removed);
    return false;
  }
  pedidos.splice(insertAt, 0, removed);
  return true;
}

/** Inserta el pedido inmediatamente después de `afterId` (tras quitar el arrastrado del array). */
function moverPedidoDespuesDeId(draggedId, afterId) {
  if (Number(draggedId) === Number(afterId)) return false;
  const draggedIndex = pedidos.findIndex((p) => Number(p.id) === Number(draggedId));
  if (draggedIndex < 0) return false;
  const [removed] = pedidos.splice(draggedIndex, 1);
  let insertAt = pedidos.findIndex((p) => Number(p.id) === Number(afterId));
  if (insertAt < 0) {
    pedidos.splice(draggedIndex, 0, removed);
    return false;
  }
  insertAt += 1;
  pedidos.splice(insertAt, 0, removed);
  return true;
}

function ordenItemInsertBeforeDesdeClienteY(listaOrden, clientY) {
  const els = [...listaOrden.querySelectorAll('.orden-item:not(.dragging)')];
  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (clientY < r.top + r.height / 2) return el;
  }
  return null;
}

let ordenEntregaArrastre = null;
let ordenEntregaGhostEl = null;
let ordenEntregaPlaceholderEl = null;

function asegurarGhostOrdenEntrega() {
  if (ordenEntregaGhostEl && document.body.contains(ordenEntregaGhostEl)) return ordenEntregaGhostEl;
  const el = document.createElement('div');
  el.className = 'orden-drag-ghost';
  el.setAttribute('aria-hidden', 'true');
  document.body.appendChild(el);
  ordenEntregaGhostEl = el;
  return el;
}

function actualizarGhostOrdenEntrega(clientX, clientY, pedidoId) {
  const el = asegurarGhostOrdenEntrega();
  // Solo indicador visual (sin “nota” explicativa).
  el.textContent = `Pedido #${pedidoId}`;
  const dx = 14;
  const dy = 14;
  el.style.transform = `translate(${Math.round(clientX + dx)}px, ${Math.round(clientY + dy)}px)`;
}

function ocultarGhostOrdenEntrega() {
  if (!ordenEntregaGhostEl) return;
  ordenEntregaGhostEl.style.transform = 'translate(-9999px, -9999px)';
}

function asegurarPlaceholderOrdenEntrega() {
  if (ordenEntregaPlaceholderEl && ordenEntregaPlaceholderEl.parentNode) return ordenEntregaPlaceholderEl;
  const el = document.createElement('div');
  el.className = 'orden-drop-placeholder';
  el.setAttribute('aria-hidden', 'true');
  ordenEntregaPlaceholderEl = el;
  return el;
}

function limpiarHintsOrdenEntrega(lista) {
  if (!lista) return;
  lista.querySelectorAll('.orden-item.orden-drop-hint').forEach((el) => el.classList.remove('orden-drop-hint'));
}

async function aplicarReordenListaOrdenSegunY(listaOrden, clientY, draggedId) {
  const beforeEl = ordenItemInsertBeforeDesdeClienteY(listaOrden, clientY);
  let ok = false;
  if (beforeEl) {
    const beforeId = parseInt(beforeEl.dataset.id, 10);
    if (Number.isFinite(beforeId) && (await advertirSiAdminReordenaAsignados([draggedId, beforeId]))) {
      ok = moverPedidoAntesDeId(draggedId, beforeId);
    }
  } else {
    const items = [...listaOrden.querySelectorAll('.orden-item:not(.dragging)')];
    const last = items[items.length - 1];
    if (last) {
      const afterId = parseInt(last.dataset.id, 10);
      if (Number.isFinite(afterId) && (await advertirSiAdminReordenaAsignados([draggedId, afterId]))) {
        ok = moverPedidoDespuesDeId(draggedId, afterId);
      }
    }
  }
  if (ok) {
    guardarPedidos();
    renderPedidos();
    redibujarRutaDebounced(120);
    if (esSesionAdmin()) {
      void notificarMensajerosOrdenActualizado();
    }
  }
  return ok;
}

function restaurarItemTrasArrastreOrden(itemEl, lista) {
  if (ordenEntregaPlaceholderEl && ordenEntregaPlaceholderEl.parentNode) {
    ordenEntregaPlaceholderEl.remove();
  }
  if (itemEl) {
    itemEl.classList.remove('dragging');
    itemEl.style.display = '';
  }
  ocultarGhostOrdenEntrega();
  if (lista) limpiarHintsOrdenEntrega(lista);
  const panel = lista && lista.closest('.orden-entrega-panel');
  if (panel) panel.classList.remove('dragging-activo');
}

function activarArrastreOrdenSiCorresponde(e, snap) {
  if (snap.activo) return true;
  const dx = e.clientX - snap.startX;
  const dy = e.clientY - snap.startY;
  if (dx * dx + dy * dy < 36) return false;

  snap.activo = true;
  const { itemEl, lista, pedidoId } = snap;
  itemEl.classList.add('dragging');
  actualizarGhostOrdenEntrega(e.clientX, e.clientY, pedidoId);
  const panel = lista.closest('.orden-entrega-panel');
  if (panel) panel.classList.add('dragging-activo');

  // Placeholder en la posición original; ocultamos el item para que se vea el hueco.
  const ph = asegurarPlaceholderOrdenEntrega();
  if (itemEl.parentNode === lista) lista.insertBefore(ph, itemEl);
  itemEl.style.display = 'none';
  return true;
}

function ordenItemPointerMove(e) {
  if (!ordenEntregaArrastre || e.pointerId !== ordenEntregaArrastre.pointerId) return;
  e.preventDefault();
  const snap = ordenEntregaArrastre;
  if (!activarArrastreOrdenSiCorresponde(e, snap)) return;

  actualizarGhostOrdenEntrega(e.clientX, e.clientY, snap.pedidoId);

  // Mostrar hueco donde quedaría al soltar.
  const { lista } = snap;
  const panel = lista.closest('.orden-entrega-panel');
  const bounds = (panel || lista).getBoundingClientRect();
  if (e.clientX < bounds.left || e.clientX > bounds.right || e.clientY < bounds.top || e.clientY > bounds.bottom) {
    limpiarHintsOrdenEntrega(lista);
    return;
  }
  const beforeEl = ordenItemInsertBeforeDesdeClienteY(lista, e.clientY);
  const ph = asegurarPlaceholderOrdenEntrega();
  if (beforeEl) {
    beforeEl.classList.add('orden-drop-hint');
    if (ph !== beforeEl.previousSibling) lista.insertBefore(ph, beforeEl);
  } else {
    limpiarHintsOrdenEntrega(lista);
    if (ph.parentNode !== lista || ph !== lista.lastChild) lista.appendChild(ph);
  }
}

async function ordenItemPointerEnd(e) {
  if (!ordenEntregaArrastre || e.pointerId !== ordenEntregaArrastre.pointerId) return;
  const snap = ordenEntregaArrastre;
  ordenEntregaArrastre = null;

  const { itemEl, lista, pedidoId, pointerId, activo } = snap;
  itemEl.removeEventListener('pointermove', ordenItemPointerMove);
  itemEl.removeEventListener('pointerup', ordenItemPointerEnd);
  itemEl.removeEventListener('pointercancel', ordenItemPointerEnd);
  try {
    itemEl.releasePointerCapture(pointerId);
  } catch (_err) {}

  // Clic sin arrastre: no ocultamos el ítem (solo se oculta al superar el umbral).
  if (!activo) {
    restaurarItemTrasArrastreOrden(itemEl, lista);
    return;
  }

  const panel = lista.closest('.orden-entrega-panel');
  const bounds = (panel || lista).getBoundingClientRect();
  if (e.clientX < bounds.left || e.clientX > bounds.right || e.clientY < bounds.top || e.clientY > bounds.bottom) {
    restaurarItemTrasArrastreOrden(itemEl, lista);
    return;
  }

  // Usar placeholder como referencia final de inserción (más fiel que usar solo Y).
  const ph = ordenEntregaPlaceholderEl;
  let ok = false;
  if (ph && ph.parentNode === lista) {
    const after = ph.nextElementSibling;
    if (after && after.classList && after.classList.contains('orden-item')) {
      const beforeId = parseInt(after.dataset.id, 10);
      if (Number.isFinite(beforeId) && (await advertirSiAdminReordenaAsignados([pedidoId, beforeId]))) {
        ok = moverPedidoAntesDeId(pedidoId, beforeId);
      }
    } else {
      const items = [...lista.querySelectorAll('.orden-item:not(.dragging)')];
      const last = items[items.length - 1];
      if (last) {
        const afterId = parseInt(last.dataset.id, 10);
        if (Number.isFinite(afterId) && (await advertirSiAdminReordenaAsignados([pedidoId, afterId]))) {
          ok = moverPedidoDespuesDeId(pedidoId, afterId);
        }
      }
    }
  } else {
    ok = await aplicarReordenListaOrdenSegunY(lista, e.clientY, pedidoId);
  }
  restaurarItemTrasArrastreOrden(itemEl, lista);
  if (ok) {
    guardarPedidos();
    renderPedidos();
    redibujarRutaDebounced(120);
    if (esSesionAdmin()) {
      void notificarMensajerosOrdenActualizado();
    }
  }
}

function ordenListaPointerDown(e) {
  const lista = document.getElementById('listaOrdenEntrega');
  if (!lista || e.currentTarget !== lista) return;
  const item = e.target.closest && e.target.closest('.orden-item');
  if (!item || !lista.contains(item)) return;
  // No iniciar arrastre desde botones de la fila (flechas / regresar etapa).
  if (e.target.closest && e.target.closest('.orden-item-acciones')) return;
  if (e.button !== 0) return;

  const pedidoId = parseInt(item.dataset.id, 10);
  if (!Number.isFinite(pedidoId)) return;

  e.preventDefault();
  ordenEntregaArrastre = {
    itemEl: item,
    lista,
    pedidoId,
    pointerId: e.pointerId,
    startX: e.clientX,
    startY: e.clientY,
    activo: false
  };
  try {
    item.setPointerCapture(e.pointerId);
  } catch (_err) {}

  item.addEventListener('pointermove', ordenItemPointerMove);
  item.addEventListener('pointerup', ordenItemPointerEnd);
  item.addEventListener('pointercancel', ordenItemPointerEnd);
}

function configurarArrastrePointerOrdenEntrega() {
  const lista = document.getElementById('listaOrdenEntrega');
  if (!lista || lista.dataset.pointerOrden === '1') return;
  lista.dataset.pointerOrden = '1';
  lista.addEventListener('pointerdown', ordenListaPointerDown);
}

// --- Drag and Drop ---
let draggedElement = null;

function handleDragStart(e) {
  if (this.classList && this.classList.contains('orden-item')) {
    e.preventDefault();
    return;
  }
  if (e.target && e.target.closest && e.target.closest('.orden-flecha')) {
    e.preventDefault();
    return;
  }
  draggedElement = this;
  this.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/html', this.innerHTML);
  try {
    e.dataTransfer.setData('text/plain', String(this.dataset.id || ''));
  } catch (_e) {}
}

function handleDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  return false;
}

async function handleDrop(e) {
  e.stopPropagation();
  if (!draggedElement || draggedElement === this) return false;
  const draggedId = parseInt(draggedElement.dataset.id, 10);
  const targetId = parseInt(this.dataset.id, 10);
  if (
    Number.isFinite(draggedId) &&
    Number.isFinite(targetId) &&
    (await advertirSiAdminReordenaAsignados([draggedId, targetId])) &&
    moverPedidoPorId(draggedId, targetId)
  ) {
    guardarPedidos();
    renderPedidos();
    actualizarMarcadores();
    if (esSesionAdmin()) {
      void notificarMensajerosOrdenActualizado();
    }
  }
  return false;
}

function handleDragEnd() {
  this.classList.remove('dragging');
  draggedElement = null;
}

// --- Gestión de pedidos ---

function eliminarPedido(index) {
  if (sesionUsuario && !esSesionAdmin()) {
    mostrarToast('Solo un administrador puede eliminar pedidos.', 'warning');
    return;
  }
  const pedido = pedidos[index];
  if (!pedido) return;
  const idRef = Number(pedido.id);
  mostrarModalDecision({
    titulo: 'Eliminar pedido',
    texto: `¿Estás seguro de eliminar el pedido #${idRef}?`,
    textoConfirmar: 'Eliminar',
    textoCancelar: 'Cancelar',
    claseConfirmar: 'btn-danger',
    mostrarSecundario: false,
    onConfirmar: () => {
      const ix = pedidos.findIndex((p) => Number(p.id) === idRef);
      if (ix < 0) return;
      pedidos.splice(ix, 1);
      guardarPedidos();
      renderPedidos();
      actualizarMarcadores();
      void forzarSyncPedidosAhora().catch((e) => console.error(e));
      mostrarToast(`Pedido #${idRef} eliminado.`, 'success');
    },
    onCancelar: () => {}
  });
}

function marcarEntregado(index) {
  const pedido = pedidos[index];
  if (!pedido) return Promise.resolve();
  pedido.entregado = true;
  pedido.enCurso = false;
  pedido.llegoDestino = false;
  pedido.posicionPendiente = null;
  sellarFechaOperacionPedido(pedido);
  guardarPedidos();
  renderPedidos();
  actualizarMarcadores();
  return persistirHistorialTrasCierrePedido(pedido);
}

function marcarEnCurso(index) {
  const pedido = pedidos[index];
  if (!pedido || pedido.entregado || pedido.cancelado) return;
  const estabaEnCurso = !!pedido.enCurso;
  if (pedido.posicionPendiente == null) pedido.posicionPendiente = index;
  pedido.enCurso = true;
  pedido.haSidoEnrutado = true;
  if (!pedido.hasOwnProperty('llegoDestino')) pedido.llegoDestino = false;
  if (!estabaEnCurso) {
    vistaPedidosSeleccionadaManual = true;
    vistaPedidosActual = 'enCurso';
  }
  guardarPedidos();
  renderPedidos();
  actualizarMarcadores();
}

function marcarPendiente(index) {
  const pedido = pedidos[index];
  if (!pedido || pedido.entregado || pedido.cancelado) return;
  if (!pedido.enCurso || pedido.llegoDestino) return;

  const posicionOriginal = Number.isInteger(pedido.posicionPendiente)
    ? pedido.posicionPendiente
    : null;
  pedido.enCurso = false;
  pedido.llegoDestino = false;
  pedido.posicionPendiente = null;
  // Al regresar a pendientes, permitimos volver a notificar al cliente.
  limpiarNotificacionEnCaminoPedido(pedido);

  if (posicionOriginal !== null) {
    const [movido] = pedidos.splice(index, 1);
    const destino = Math.max(0, Math.min(posicionOriginal, pedidos.length));
    pedidos.splice(destino, 0, movido);
  }

  vistaPedidosSeleccionadaManual = true;
  vistaPedidosActual = 'pendientes';
  guardarPedidos();
  renderPedidos();
  actualizarMarcadores();
  mostrarToast(`Pedido #${pedido.id} regresó a pendientes.`, 'info');
}

function marcarRegresarAEnRuta(index) {
  const pedido = pedidos[index];
  if (!pedido || pedido.cancelado) return;

  // Desde finalizado → en ruta
  if (pedido.entregado) {
    pedido.entregado = false;
    pedido.noEntregado = false;
    pedido.envioRecogido = false;
    pedido.enCurso = true;
    pedido.llegoDestino = false;
    pedido.haSidoEnrutado = true;
    pedido.metodoPagoEntrega = '';
    pedido.montoNequi = 0;
    pedido.montoDaviplata = 0;
    pedido.montoEfectivo = 0;
    pedido.dioCambio = false;
    pedido.cambioMetodo = '';
    pedido.montoCambio = 0;
    pedido.ajusteVueltasDigitales = false;
    const fechaPrev = pedido.fechaOperacion;
    pedido.fechaOperacion = null;
    limpiarEntregaPorteriaEnPedido(pedido);
    vistaPedidosSeleccionadaManual = true;
    vistaPedidosActual = 'enCurso';
    guardarPedidos();
    renderPedidos();
    actualizarMarcadores();
    if (fechaPrev) void sincronizarHistorialPorFecha(fechaPrev);
    mostrarToast(`Pedido #${pedido.id} regresó a en ruta.`, 'info');
    return;
  }

  // Desde en destino → en ruta
  if (!pedido.enCurso || !pedido.llegoDestino) return;
  pedido.llegoDestino = false;
  guardarPedidos();
  renderPedidos();
  actualizarMarcadores();
  mostrarToast(`Pedido #${pedido.id} regresó a en ruta.`, 'info');
}

function marcarNoEntregado(index) {
  const pedido = pedidos[index];
  if (!pedido) return;
  pedido.entregado = false;
  pedido.enCurso = false;
  pedido.llegoDestino = false;
  pedido.posicionPendiente = null;
  pedido.noEntregado = false;
  pedido.envioRecogido = false;
  pedido.cancelado = false;
  limpiarEntregaPorteriaEnPedido(pedido);
  limpiarNotificacionNoEntregadoEnPedido(pedido);
  guardarPedidos();
  renderPedidos();
  actualizarMarcadores();
}

function marcarCancelado(index) {
  if (sesionUsuario && !esSesionAdmin()) {
    mostrarToast('Solo un administrador puede cancelar pedidos.', 'warning');
    return Promise.resolve();
  }
  const pedido = pedidos[index];
  if (!pedido || pedido.entregado || pedido.cancelado) return Promise.resolve();
  pedido.cancelado = true;
  pedido.enCurso = false;
  pedido.llegoDestino = false;
  pedido.posicionPendiente = null;
  sellarFechaOperacionPedido(pedido);
  guardarPedidos();
  renderPedidos();
  actualizarMarcadores();
  return persistirHistorialTrasCierrePedido(pedido);
}

function reactivarPedidoCancelado(index) {
  if (sesionUsuario && !esSesionAdmin()) {
    mostrarToast('Solo un administrador puede reactivar pedidos.', 'warning');
    return;
  }
  const pedido = pedidos[index];
  if (!pedido || !pedido.cancelado) return;
  pedido.cancelado = false;
  pedido.entregado = false;
  pedido.enCurso = false;
  pedido.llegoDestino = false;
  pedido.posicionPendiente = null;
  guardarPedidos();
  renderPedidos();
  actualizarMarcadores();
}

function eliminarTodos() {
  if (sesionUsuario && !esSesionAdmin()) {
    mostrarToast('Solo un administrador puede vaciar la lista.', 'warning');
    return;
  }
  mostrarModalDecision({
    titulo: 'Eliminar todos los pedidos',
    texto: '¿Estás seguro de eliminar TODOS los pedidos? Esta acción no se puede deshacer.',
    textoConfirmar: 'Eliminar todo',
    textoCancelar: 'Cancelar',
    claseConfirmar: 'btn-danger',
    mostrarSecundario: false,
    onConfirmar: () => {
      pedidos = [];
      nextPedidoId = 1;
      vistaPedidosActual = 'pendientes';
      vistaPedidosSeleccionadaManual = false;
      guardarPedidos();
      renderPedidos();
      actualizarMarcadores();
      try {
        if (mapa) {
          mapaAjustado = false;
          mapa.invalidateSize();
          ajustarMapaConReintentos();
        }
      } catch (_e) {}
      void forzarSyncPedidosAhora().catch((e) => console.error(e));
      mostrarToast('Todos los pedidos fueron eliminados.', 'success');
    },
    onCancelar: () => {}
  });
}

// --- Editar pedido ---

let edicionPedidoPendiente = { index: null };

function asegurarModalEditarPedido() {
  let modal = document.getElementById('modalEditarPedido');
  if (modal && document.getElementById('editarPedidoDireccion')) return modal;
  if (modal) {
    modal.remove();
    modal = null;
  }

  modal = document.createElement('div');
  modal.id = 'modalEditarPedido';
  modal.className = 'modal-no-entregado-backdrop';
  modal.innerHTML = `
    <div class="modal-no-entregado-card modal-editar-pedido-card">
      <h3>Editar pedido</h3>
      <p class="modal-editar-pedido-ayuda">Puedes cambiar el nombre, teléfono, dirección, lista de productos (una línea por producto), valor y enlace del mapa.</p>
      <div class="modal-editar-pedido-body">
        <label class="modal-editar-pedido-label" for="editarPedidoNombre">Nombre</label>
        <input id="editarPedidoNombre" type="text" autocomplete="name" class="modal-editar-pedido-input">
        <label class="modal-editar-pedido-label" for="editarPedidoTelefono">Teléfono</label>
        <input id="editarPedidoTelefono" type="text" inputmode="tel" autocomplete="tel" class="modal-editar-pedido-input">
        <label class="modal-editar-pedido-label" for="editarPedidoDireccion">Dirección</label>
        <textarea id="editarPedidoDireccion" class="modal-editar-pedido-textarea" rows="3" spellcheck="true" placeholder="Dirección completa del pedido"></textarea>
        <label class="modal-editar-pedido-label" for="editarPedidoProductos">Productos (uno por línea)</label>
        <textarea id="editarPedidoProductos" class="modal-editar-pedido-textarea" rows="6" spellcheck="false"></textarea>
        <label class="modal-editar-pedido-label" for="editarPedidoValor">Valor</label>
        <input id="editarPedidoValor" type="text" inputmode="numeric" placeholder="Solo números" class="modal-editar-pedido-input">
        <label class="modal-editar-pedido-label" for="editarPedidoMapUrl">URL del mapa</label>
        <input id="editarPedidoMapUrl" type="text" placeholder="https://…" class="modal-editar-pedido-input">
      </div>
      <div class="modal-no-entregado-actions modal-editar-pedido-acciones">
        <button type="button" class="btn-primary" onclick="guardarEdicionPedido()">Guardar cambios</button>
      </div>
      <button type="button" class="modal-no-entregado-close" onclick="cerrarModalEditarPedido()">Cerrar</button>
    </div>
  `;
  document.body.appendChild(modal);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) cerrarModalEditarPedido();
  });
  const v = document.getElementById('editarPedidoValor');
  if (v) vincularFormateoMilesInput(v);
  return modal;
}

function cerrarModalEditarPedido() {
  const modal = document.getElementById('modalEditarPedido');
  if (!modal) return;
  modal.style.display = 'none';
  edicionPedidoPendiente = { index: null };
}

function guardarEdicionPedido() {
  const { index } = edicionPedidoPendiente;
  const pedido = pedidos[index];
  if (!pedido) {
    cerrarModalEditarPedido();
    return;
  }

  const inputNombre = document.getElementById('editarPedidoNombre');
  const inputTel = document.getElementById('editarPedidoTelefono');
  const inputDir = document.getElementById('editarPedidoDireccion');
  const taProd = document.getElementById('editarPedidoProductos');
  const inputValor = document.getElementById('editarPedidoValor');
  const inputMapUrl = document.getElementById('editarPedidoMapUrl');

  pedido.nombre = inputNombre ? String(inputNombre.value || '').trim() : '';
  const telTexto = inputTel ? String(inputTel.value || '').trim() : '';
  const tels = normalizarTelefonosDesdeTexto(telTexto);
  pedido.telefonos = tels;
  pedido.telefono = tels[0] || telTexto;
  pedido.direccion = inputDir ? String(inputDir.value || '').trim() : '';
  if (taProd) {
    pedido.productos = productosPedidoDesdeTextoPlano(taProd.value);
  }

  const valorIngresado = inputValor ? String(inputValor.value || '') : '';
  const valorLimpio = valorIngresado.replace(/[^\d]/g, '');
  if (valorLimpio !== '') {
    pedido.valor = valorLimpio;
  }
  const nuevaUrl = inputMapUrl ? String(inputMapUrl.value || '').trim() : '';
  if (nuevaUrl !== '') {
    pedido.mapUrl = nuevaUrl;
    const ext = extraerCoordenadas(nuevaUrl);
    if (ext) {
      pedido.coords = { lat: ext.lat, lng: ext.lng };
    } else {
      pedido.coords = null;
    }
  }

  normalizarPedidoEnMemoria(pedido);
  sincronizarAvisoTelefonoPedido(pedido);
  guardarPedidos();
  renderPedidos();
  actualizarMarcadores();
  cerrarModalEditarPedido();
}

function editarPedido(index) {
  if (sesionUsuario && !esSesionAdmin()) {
    mostrarToast('Solo un administrador puede editar estos datos.', 'warning');
    return;
  }
  const pedido = pedidos[index];
  if (!pedido) return;
  edicionPedidoPendiente = { index };
  const modal = asegurarModalEditarPedido();
  const inputNombre = document.getElementById('editarPedidoNombre');
  const inputTel = document.getElementById('editarPedidoTelefono');
  const inputDir = document.getElementById('editarPedidoDireccion');
  const taProd = document.getElementById('editarPedidoProductos');
  const inputValor = document.getElementById('editarPedidoValor');
  const inputMapUrl = document.getElementById('editarPedidoMapUrl');
  if (inputNombre) inputNombre.value = String(pedido.nombre || '');
  if (inputTel) inputTel.value = textoTelefonosPedidoParaInput(pedido) || String(pedido.telefono || '');
  if (inputDir) inputDir.value = String(pedido.direccion || '');
  if (taProd) taProd.value = lineasProductosPedidoNormalizadas(pedido).join('\n');
  if (inputValor) inputValor.value = formatearDigitosMilesEsCo(String(pedido.valor || ''));
  if (inputMapUrl) inputMapUrl.value = String(pedido.mapUrl || '');
  modal.style.display = 'flex';
}

// --- Comunicación ---

function llamar(numero) {
  if (!numero) { mostrarAvisoEnApp('No hay número de teléfono disponible', 'Contacto'); return; }
  const n = numero.toString().replace(/\D/g, '');
  if (!n) {
    mostrarToast('Número de teléfono inválido', 'warning');
    return;
  }
  window.location.href = `tel:${n}`;
}

function contactarPedido(index, accion) {
  const pedido = pedidos[index];
  if (!pedido) return;
  const tels = obtenerTelefonosPedido(pedido);
  const titulo = 'Contacto';
  seleccionarTelefonoConModal(tels, titulo, (tel) => {
    if (accion === 'call') llamar(tel);
    else if (accion === 'wa_call') whatsappLlamar(tel);
    else if (accion === 'wa_msg') whatsappMensaje(tel);
  });
}

function copiarDireccionPedido(index) {
  const pedido = pedidos[index];
  const direccion = pedido && pedido.direccion ? String(pedido.direccion).trim() : '';
  if (!direccion) {
    mostrarToast('No hay dirección para copiar', 'warning');
    return;
  }

  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(direccion)
      .then(() => mostrarToast('Dirección copiada', 'success'))
      .catch(() => mostrarToast('No se pudo copiar la dirección', 'error'));
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = direccion;
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  try {
    const ok = document.execCommand('copy');
    mostrarToast(ok ? 'Dirección copiada' : 'No se pudo copiar la dirección', ok ? 'success' : 'error');
  } catch (e) {
    mostrarToast('No se pudo copiar la dirección', 'error');
  } finally {
    document.body.removeChild(textarea);
  }
}

function whatsappLlamar(numero) {
  if (!numero) { mostrarAvisoEnApp('No hay número de teléfono disponible', 'Contacto'); return; }
  const n = numero.toString().replace(/\D/g, '');
  if (!n) {
    mostrarToast('Número de teléfono inválido', 'warning');
    return;
  }
  const wa = n.startsWith('57') ? n : `57${n}`;
  window.open(`https://wa.me/${wa}`, "_blank");
}

function whatsappMensaje(numero) {
  if (!numero) { mostrarAvisoEnApp('No hay número de teléfono disponible', 'Contacto'); return; }
  const n = numero.toString().replace(/\D/g, '');
  if (!n) {
    mostrarToast('Número de teléfono inválido', 'warning');
    return;
  }
  const wa = n.startsWith('57') ? n : `57${n}`;
  window.open(`https://wa.me/${wa}?text=Hola`, "_blank");
}

function obtenerSoporteWhatsApp() {
  const limpio = TELEFONO_SOPORTE.replace(/\D/g, '');
  return limpio.startsWith('57') ? limpio : `57${limpio}`;
}

function soporteLlamarWhatsApp() {
  window.open(`https://wa.me/${obtenerSoporteWhatsApp()}`, '_blank');
}

function soporteLlamadaNormal() {
  const limpio = TELEFONO_SOPORTE.replace(/\D/g, '');
  window.location.href = `tel:+57${limpio}`;
}

let soportePendiente = { index: null };
let decisionPendiente = { onConfirmar: null, onSecundario: null, onCancelar: null };

function mostrarAvisoEnApp(texto, titulo = 'Aviso') {
  mostrarModalDecision({
    titulo,
    texto,
    mostrarConfirmar: false,
    mostrarSecundario: false,
    textoCancelar: 'Cerrar',
    onConfirmar: () => {},
    onCancelar: () => {}
  });
}

function asegurarModalMensajeSoporte() {
  let modal = document.getElementById('modalMensajeSoporte');
  if (modal) return modal;

  modal = document.createElement('div');
  modal.id = 'modalMensajeSoporte';
  modal.className = 'modal-no-entregado-backdrop';
  modal.innerHTML = `
    <div class="modal-no-entregado-card modal-soporte-card">
      <h3 id="tituloModalMensajeSoporte">Mensajes de soporte</h3>
      <div id="panelSoporteOpciones">
        <p>Selecciona el problema a reportar por WhatsApp:</p>
        <div class="modal-no-entregado-actions">
          <button type="button" class="btn-support" onclick="enviarMensajeSoporte('no_enviado')">Pedido no enviado</button>
          <button type="button" class="btn-support" onclick="enviarMensajeSoporte('pago_reportado')">Cliente reporta pago</button>
          <button type="button" class="btn-support" onclick="enviarMensajeSoporte('producto_incorrecto')">Producto incorrecto</button>
          <button type="button" class="btn-support" onclick="mostrarPanelSoporteFaltanProductos()">Faltan productos</button>
          <button type="button" class="btn-support" onclick="enviarMensajeSoporte('cliente_no_responde')">Cliente no responde</button>
          <button type="button" class="btn-info" onclick="mostrarPanelSoportePersonalizado()">Mensaje personalizado</button>
        </div>
        <button type="button" class="modal-no-entregado-close" onclick="cerrarModalMensajeSoporte()">Cerrar</button>
      </div>
      <div id="panelSoportePersonalizado" class="panel-soporte-personalizado" style="display:none;">
        <p class="soporte-personalizado-ayuda">Escribe solo el texto del medio. Debajo se añadirá &ldquo;Productos a entregar:&rdquo; y cada producto en un renglón aparte. Al copiar, pega el mensaje tú en el chat de WhatsApp.</p>
        <label for="textoSoportePersonalizado" class="qr-pedidos-label">Tu mensaje</label>
        <textarea id="textoSoportePersonalizado" class="qr-pedidos-textarea" rows="5" spellcheck="true" placeholder="Ej: Pedido #12, el cliente pide cambiar la dirección…"></textarea>
        <div class="modal-no-entregado-actions">
          <button type="button" class="btn-primary" onclick="confirmarMensajeSoportePersonalizado()">Copiar mensaje</button>
        </div>
        <button type="button" class="modal-no-entregado-close" onclick="volverPanelSoporteOpciones()">Cerrar</button>
      </div>
      <div id="panelSoporteFaltanProductos" class="panel-soporte-faltan-productos" style="display:none;">
        <p class="soporte-personalizado-ayuda">Indica qué falta: marca productos del pedido o elige &ldquo;Otro producto&rdquo; si no está en la lista.</p>
        <div class="soporte-modos-falta" role="radiogroup" aria-label="Cómo indicar el faltante">
          <label class="soporte-falta-radio-label">
            <input type="radio" name="faltaModoSoporte" value="lista" checked onchange="sincronizarModoFaltaSoporte()"> Del pedido (marca uno o varios)
          </label>
          <label class="soporte-falta-radio-label">
            <input type="radio" name="faltaModoSoporte" value="otro" onchange="sincronizarModoFaltaSoporte()"> Otro producto (escribir)
          </label>
        </div>
        <div id="wrapFaltaListaSoporte">
          <p class="qr-pedidos-label soporte-falta-subtitulo">Productos del pedido</p>
          <div id="contenedorChecksFaltanProductos" class="contenedor-checks-faltan"></div>
        </div>
        <div id="wrapFaltaOtroSoporte" class="wrap-falta-otro-soporte" style="display:none;">
          <label for="textoFaltanOtroProducto" class="qr-pedidos-label">Cuál falta</label>
          <textarea id="textoFaltanOtroProducto" class="qr-pedidos-textarea soporte-textarea-falta-otro" rows="3" spellcheck="true" placeholder="Ej: aderezo que no venía en el pedido…"></textarea>
        </div>
        <div class="modal-no-entregado-actions soporte-falta-acciones">
          <button type="button" class="btn-primary" onclick="confirmarMensajeSoporteFaltanProductos()">Enviar por WhatsApp</button>
        </div>
        <button type="button" class="modal-no-entregado-close" onclick="volverPanelSoporteOpciones()">Cerrar</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  return modal;
}

function mostrarOpcionesMensajeSoporte(index) {
  const pedido = pedidos[index];
  if (!pedido) return;
  soportePendiente = { index };
  resetVistaModalMensajeSoporte();
  const modal = asegurarModalMensajeSoporte();
  modal.style.display = 'flex';
}

function resetVistaModalMensajeSoporte() {
  const panelOp = document.getElementById('panelSoporteOpciones');
  const panelPer = document.getElementById('panelSoportePersonalizado');
  const panelFalta = document.getElementById('panelSoporteFaltanProductos');
  const ta = document.getElementById('textoSoportePersonalizado');
  const taOtro = document.getElementById('textoFaltanOtroProducto');
  const contChecks = document.getElementById('contenedorChecksFaltanProductos');
  const titulo = document.getElementById('tituloModalMensajeSoporte');
  if (panelOp) panelOp.style.display = 'block';
  if (panelPer) panelPer.style.display = 'none';
  if (panelFalta) panelFalta.style.display = 'none';
  if (ta) ta.value = '';
  if (taOtro) taOtro.value = '';
  if (contChecks) contChecks.innerHTML = '';
  const rLista = document.querySelector('input[name="faltaModoSoporte"][value="lista"]');
  const rOtro = document.querySelector('input[name="faltaModoSoporte"][value="otro"]');
  if (rLista) rLista.checked = true;
  if (rOtro) rOtro.checked = false;
  if (titulo) titulo.textContent = 'Mensajes de soporte';
  sincronizarModoFaltaSoporte();
}

function mostrarPanelSoportePersonalizado() {
  const panelOp = document.getElementById('panelSoporteOpciones');
  const panelPer = document.getElementById('panelSoportePersonalizado');
  const panelFalta = document.getElementById('panelSoporteFaltanProductos');
  const ta = document.getElementById('textoSoportePersonalizado');
  const titulo = document.getElementById('tituloModalMensajeSoporte');
  if (!panelOp || !panelPer || !ta) return;
  panelOp.style.display = 'none';
  if (panelFalta) panelFalta.style.display = 'none';
  panelPer.style.display = 'block';
  if (titulo) titulo.textContent = 'Mensaje personalizado';
  ta.value = '';
  requestAnimationFrame(() => {
    try {
      ta.focus();
    } catch (_e) {}
  });
}

function volverPanelSoporteOpciones() {
  resetVistaModalMensajeSoporte();
}

function sincronizarModoFaltaSoporte() {
  const rLista = document.querySelector('input[name="faltaModoSoporte"][value="lista"]');
  const wrapLista = document.getElementById('wrapFaltaListaSoporte');
  const wrapOtro = document.getElementById('wrapFaltaOtroSoporte');
  const ta = document.getElementById('textoFaltanOtroProducto');
  const modoLista = !!(rLista && rLista.checked);
  if (wrapLista) wrapLista.style.display = modoLista ? 'block' : 'none';
  if (wrapOtro) wrapOtro.style.display = modoLista ? 'none' : 'block';
  if (modoLista) {
    if (ta) ta.value = '';
  } else {
    document.querySelectorAll('.chk-falta-pedido').forEach((c) => {
      c.checked = false;
    });
    requestAnimationFrame(() => {
      try {
        ta?.focus();
      } catch (_e) {}
    });
  }
}

function mostrarPanelSoporteFaltanProductos() {
  const panelOp = document.getElementById('panelSoporteOpciones');
  const panelPer = document.getElementById('panelSoportePersonalizado');
  const panelFalta = document.getElementById('panelSoporteFaltanProductos');
  const titulo = document.getElementById('tituloModalMensajeSoporte');
  const { index } = soportePendiente;
  const pedido = pedidos[index];
  if (!panelOp || !panelFalta || !pedido) return;
  panelOp.style.display = 'none';
  if (panelPer) panelPer.style.display = 'none';
  panelFalta.style.display = 'block';
  if (titulo) titulo.textContent = 'Faltan productos';

  const cont = document.getElementById('contenedorChecksFaltanProductos');
  const taOtro = document.getElementById('textoFaltanOtroProducto');
  if (taOtro) taOtro.value = '';
  if (cont) {
    cont.innerHTML = '';
    const lineas = lineasProductosPedidoNormalizadas(pedido);
    lineas.forEach((txt) => {
      const row = document.createElement('div');
      row.className = 'soporte-falta-check-row';
      const lab = document.createElement('label');
      lab.className = 'soporte-falta-check-label';
      const inp = document.createElement('input');
      inp.type = 'checkbox';
      inp.className = 'chk-falta-pedido';
      inp.value = txt;
      lab.appendChild(inp);
      lab.appendChild(document.createTextNode(` ${txt}`));
      row.appendChild(lab);
      cont.appendChild(row);
    });
  }

  const rLista = document.querySelector('input[name="faltaModoSoporte"][value="lista"]');
  const rOtro = document.querySelector('input[name="faltaModoSoporte"][value="otro"]');
  const lineasPedido = lineasProductosPedidoNormalizadas(pedido);
  if (rLista && rOtro) {
    if (lineasPedido.length === 0) {
      rOtro.checked = true;
      rLista.checked = false;
    } else {
      rLista.checked = true;
      rOtro.checked = false;
    }
  }
  sincronizarModoFaltaSoporte();
  if (lineasPedido.length === 0) {
    mostrarToast('Este pedido no tiene productos en lista. Indica el faltante por texto.', 'info', 4500);
  }
}

function confirmarMensajeSoporteFaltanProductos() {
  const { index } = soportePendiente;
  const pedido = pedidos[index];
  if (!pedido) {
    cerrarModalMensajeSoporte();
    return;
  }
  const idPedido = pedido.id != null ? pedido.id : 'N/A';
  const productosPedido = textoProductosEntregaParaSoporte(pedido);
  const modoOtro = document.querySelector('input[name="faltaModoSoporte"][value="otro"]')?.checked === true;
  let lineasFaltantes = [];
  if (modoOtro) {
    const t = document.getElementById('textoFaltanOtroProducto');
    const limpio = String(t?.value || '').trim();
    if (!limpio) {
      mostrarToast('Escribe qué producto falta o elige productos del pedido.', 'warning');
      t?.focus();
      return;
    }
    lineasFaltantes = [limpio];
  } else {
    document.querySelectorAll('.chk-falta-pedido:checked').forEach((c) => {
      lineasFaltantes.push(String(c.value || '').trim());
    });
    lineasFaltantes = lineasFaltantes.filter(Boolean);
    if (lineasFaltantes.length === 0) {
      mostrarToast('Marca al menos un producto o elige "Otro producto".', 'warning');
      return;
    }
  }
  const faltantesTxt = lineasFaltantes.join('\n');
  const mensaje = `Pedido #${idPedido}\nEl cliente indica que le hacen falta productos.\nFaltante(s):\n${faltantesTxt}\nProducto(s) del pedido:\n${productosPedido}`;
  const wa = obtenerSoporteWhatsApp();
  abrirWhatsAppPreferirApp(wa, mensaje);
  cerrarModalMensajeSoporte();
}

function confirmarMensajeSoportePersonalizado() {
  const { index } = soportePendiente;
  const pedido = pedidos[index];
  if (!pedido) {
    cerrarModalMensajeSoporte();
    return;
  }
  const ta = document.getElementById('textoSoportePersonalizado');
  if (!ta) return;
  const limpio = String(ta.value || '').trim();
  if (!limpio) {
    mostrarToast('Escribe un mensaje antes de enviar.', 'warning');
    ta.focus();
    return;
  }
  const idPedido = pedido.id != null ? pedido.id : 'N/A';
  const productosTxt = textoProductosEntregaParaSoporte(pedido);
  const mensaje = `El pedido #${idPedido} ${limpio}\nProductos a entregar:\n${productosTxt}`;
  const wa = obtenerSoporteWhatsApp();
  void copiarTextoAlPortapapeles(mensaje, 'Mensaje copiado. Pégalo en el chat de WhatsApp.').then((copiado) => {
    if (copiado) abrirWhatsAppChat(wa);
    cerrarModalMensajeSoporte();
  });
}

function cerrarModalMensajeSoporte() {
  const modal = document.getElementById('modalMensajeSoporte');
  if (!modal) return;
  modal.style.display = 'none';
  resetVistaModalMensajeSoporte();
}

function construirMensajeSoporte(pedido, tipoProblema) {
  const idPedido = pedido.id || 'N/A';
  const productos = textoProductosEntregaParaSoporte(pedido);

  if (tipoProblema === 'no_enviado') {
    return `Pedido #${idPedido}\nNo enviado.\nProducto(s):\n${productos}`;
  }
  if (tipoProblema === 'pago_reportado') {
    return `Pedido #${idPedido}\nCliente me indica que ya realizó el pago. ¿Me confirma?\nProducto(s):\n${productos}`;
  }
  if (tipoProblema === 'producto_incorrecto') {
    return `Pedido #${idPedido}\nEl producto no es el que solicitó el cliente.\nProducto(s) enviado(s):\n${productos}`;
  }
  if (tipoProblema === 'cliente_no_responde') {
    return `El pedido #${idPedido} Cliente no responde\nProductos a entregar:\n${productos}`;
  }

  return null;
}

function enviarMensajeSoporte(tipoProblema) {
  const { index } = soportePendiente;
  const pedido = pedidos[index];
  if (!pedido) {
    cerrarModalMensajeSoporte();
    return;
  }

  const mensaje = construirMensajeSoporte(pedido, tipoProblema);
  if (!mensaje) return;

  const wa = obtenerSoporteWhatsApp();
  abrirWhatsAppPreferirApp(wa, mensaje);
  cerrarModalMensajeSoporte();
}

function asegurarModalDecision() {
  let modal = document.getElementById('modalDecision');
  if (modal) return modal;

  modal = document.createElement('div');
  modal.id = 'modalDecision';
  modal.className = 'modal-no-entregado-backdrop';
  modal.innerHTML = `
    <div class="modal-no-entregado-card">
      <h3 id="modalDecisionTitulo">Confirmación</h3>
      <p id="modalDecisionTexto">¿Deseas continuar?</p>
      <div class="modal-no-entregado-actions">
        <button id="modalDecisionBtnConfirmar" class="btn-primary">Aceptar</button>
        <button id="modalDecisionBtnSecundario" class="btn-info">Opción 2</button>
      </div>
      <button id="modalDecisionBtnCancelar" class="modal-no-entregado-close">Cancelar</button>
    </div>
  `;
  document.body.appendChild(modal);

  const btnConfirmar = document.getElementById('modalDecisionBtnConfirmar');
  const btnSecundario = document.getElementById('modalDecisionBtnSecundario');
  const btnCancelar = document.getElementById('modalDecisionBtnCancelar');
  if (btnConfirmar) {
    btnConfirmar.onclick = () => {
      const accion = decisionPendiente.onConfirmar;
      cerrarModalDecision();
      if (typeof accion === 'function') accion();
    };
  }
  if (btnSecundario) {
    btnSecundario.onclick = () => {
      const accion = decisionPendiente.onSecundario;
      cerrarModalDecision();
      if (typeof accion === 'function') accion();
    };
  }
  if (btnCancelar) {
    btnCancelar.onclick = () => {
      const accion = decisionPendiente.onCancelar;
      cerrarModalDecision();
      if (typeof accion === 'function') accion();
    };
  }

  return modal;
}

function mostrarModalDecision(opciones) {
  const modal = asegurarModalDecision();
  const titulo = document.getElementById('modalDecisionTitulo');
  const texto = document.getElementById('modalDecisionTexto');
  const btnConfirmar = document.getElementById('modalDecisionBtnConfirmar');
  const btnSecundario = document.getElementById('modalDecisionBtnSecundario');
  const btnCancelar = document.getElementById('modalDecisionBtnCancelar');

  if (titulo) titulo.textContent = opciones.titulo || 'Confirmación';
  if (texto) texto.textContent = opciones.texto || '¿Deseas continuar?';
  if (btnConfirmar) {
    btnConfirmar.textContent = opciones.textoConfirmar || 'Aceptar';
    btnConfirmar.className = opciones.claseConfirmar || 'btn-primary';
    btnConfirmar.style.display = opciones.mostrarConfirmar === false ? 'none' : 'inline-block';
  }
  if (btnSecundario) {
    btnSecundario.textContent = opciones.textoSecundario || 'Opción 2';
    btnSecundario.className = opciones.claseSecundario || 'btn-info';
    btnSecundario.style.display = opciones.mostrarSecundario === false ? 'none' : 'inline-block';
  }
  if (btnCancelar) {
    btnCancelar.textContent = opciones.textoCancelar || 'Cancelar';
    btnCancelar.style.display = opciones.mostrarCancelar === false ? 'none' : 'inline-block';
  }

  decisionPendiente = {
    onConfirmar: opciones.onConfirmar || null,
    onSecundario: opciones.onSecundario || null,
    onCancelar: opciones.onCancelar || null
  };

  modal.style.display = 'flex';
}

function cerrarModalDecision() {
  const modal = document.getElementById('modalDecision');
  if (!modal) return;
  modal.style.display = 'none';
  decisionPendiente = { onConfirmar: null, onSecundario: null, onCancelar: null };
}

// --- Fotos / WhatsApp Admin ---

let pagoEntregadoPendiente = {
  index: null,
  pedidoId: null,
  enviarWhatsAppAdmin: true,
  lugarEntrega: null, // 'cliente' | 'porteria'
  recibidoPor: '',
  datosPagoPendientes: null,
  cambioMetodo: '',
};

/** Evita repetir el modal automático de portería al cliente en el mismo regreso. */
const porteriaClienteModalOfrecido = new Set();
/** Evita repetir el modal automático de no entregado al cliente en el mismo regreso. */
const noEntregadoClienteModalOfrecido = new Set();
/**
 * Flujo tras portería / no entregado:
 * 1) notificar a la tienda
 * 2) notificar al cliente
 * 3) ofrecer siguiente pedido (en camino / enrutar)
 */
let flujoPostCierrePedido = null;
/** Solo avanza de fase al volver realmente desde otra app/pestaña. */
let flujoPostCierreEstabaOculto = false;

function parseMontoEntero(valor) {
  const limpio = String(valor || '').replace(/[^\d]/g, '');
  return limpio ? parseInt(limpio, 10) : 0;
}

/** Solo dígitos → texto con separador de miles (es-CO, punto). */
function formatearDigitosMilesEsCo(texto) {
  const d = String(texto || '').replace(/\D/g, '');
  if (d === '') return '';
  const n = parseInt(d, 10);
  if (!Number.isFinite(n)) return '';
  return n.toLocaleString('es-CO');
}

/** Formatea el valor del input mientras se edita y mantiene el cursor cerca de la posición lógica. */
function aplicarFormatoMilesEnInput(input) {
  if (!input) return;
  const cursorPos = input.selectionStart ?? 0;
  const valor = String(input.value || '');
  const digitosIzquierda = valor.slice(0, cursorPos).replace(/\D/g, '').length;
  const todosDigitos = valor.replace(/\D/g, '');
  const formateado = todosDigitos === '' ? '' : parseInt(todosDigitos, 10).toLocaleString('es-CO');
  input.value = formateado;
  let nuevaPos = 0;
  if (digitosIzquierda === 0) {
    nuevaPos = 0;
  } else {
    let contados = 0;
    for (let i = 0; i < formateado.length; i++) {
      if (/\d/.test(formateado[i])) contados++;
      nuevaPos = i + 1;
      if (contados >= digitosIzquierda) break;
    }
  }
  try {
    input.setSelectionRange(nuevaPos, nuevaPos);
  } catch (_e) {}
}

function vincularFormateoMilesInput(input) {
  if (!input || input.dataset.formateoMiles === '1') return;
  input.dataset.formateoMiles = '1';
  input.addEventListener('input', () => aplicarFormatoMilesEnInput(input));
}

function mostrarPasoModalPagoEntregado(paso) {
  const contLugar = document.getElementById('pasoLugarEntrega');
  const contPago = document.getElementById('pasoMetodoPago');
  const contPorteria = document.getElementById('pasoPorteriaNombre');
  const contCambio = document.getElementById('pasoCambioPregunta');
  const contCambioDet = document.getElementById('pasoCambioDetalle');
  if (contLugar) contLugar.style.display = paso === 'lugar' ? 'block' : 'none';
  if (contPago) contPago.style.display = paso === 'pago' ? 'block' : 'none';
  if (contPorteria) contPorteria.style.display = paso === 'porteria' ? 'block' : 'none';
  if (contCambio) contCambio.style.display = paso === 'cambio' ? 'block' : 'none';
  if (contCambioDet) contCambioDet.style.display = paso === 'cambioDetalle' ? 'block' : 'none';
}

function seleccionarLugarEntregaEntregado(lugar) {
  pagoEntregadoPendiente.lugarEntrega = lugar === 'porteria' ? 'porteria' : 'cliente';
  pagoEntregadoPendiente.recibidoPor = '';
  if (pagoEntregadoPendiente.lugarEntrega === 'porteria') {
    const input = document.getElementById('porteriaRecibeNombre');
    if (input) input.value = '';
    mostrarPasoModalPagoEntregado('porteria');
    return;
  }
  mostrarPasoModalPagoEntregado('pago');
}

function confirmarNombrePorteriaEntregado() {
  const input = document.getElementById('porteriaRecibeNombre');
  const nombre = input ? String(input.value || '').trim() : '';
  if (!nombre) {
    mostrarToast('Escribe el nombre de quien recibe en portería.', 'warning');
    return;
  }
  pagoEntregadoPendiente.lugarEntrega = 'porteria';
  pagoEntregadoPendiente.recibidoPor = nombre;
  mostrarPasoModalPagoEntregado('pago');
}

function asegurarModalPagoEntregado() {
  let modal = document.getElementById('modalPagoEntregado');
  if (modal && !document.getElementById('pasoCambioPregunta')) {
    modal.remove();
    modal = null;
  }
  if (modal) return modal;

  const ocultarNequi = esSesionAdmin();
  const btnNequi = ocultarNequi ? '' : `<button class="btn-success" onclick="seleccionarMetodoPagoEntregado('nequi')">Nequi</button>`;
  const btnNequiMixto = ocultarNequi
    ? ''
    : `<button class="btn-success" onclick="seleccionarMetodoPagoEntregado('nequi_efectivo')">Nequi + Efectivo</button>`;
  const btnCambioNequi = ocultarNequi
    ? ''
    : `<button type="button" class="btn-success" onclick="seleccionarMedioCambioEntrega('nequi')">Nequi</button>`;

  modal = document.createElement('div');
  modal.id = 'modalPagoEntregado';
  modal.className = 'modal-no-entregado-backdrop';
  modal.innerHTML = `
    <div class="modal-no-entregado-card modal-no-entregado-card--con-cerrar-x">
      <button type="button" class="modal-no-entregado-close-x" onclick="cerrarModalPagoEntregado()" aria-label="Cerrar">
        <i class="fa-solid fa-xmark" aria-hidden="true"></i>
      </button>
      <h3>Foto evidencia entregado</h3>
      <div id="pasoLugarEntrega" style="display:block;">
        <p>¿La entrega se hizo al cliente o se dejó en portería?</p>
        <div class="modal-no-entregado-actions">
          <button class="btn-success" onclick="seleccionarLugarEntregaEntregado('cliente')">Entrega al cliente</button>
          <button class="btn-info" onclick="seleccionarLugarEntregaEntregado('porteria')">Se dejó en portería</button>
        </div>
      </div>

      <div id="pasoPorteriaNombre" style="display:none;">
        <p>Escribe el nombre de quien recibe en portería:</p>
        <input id="porteriaRecibeNombre" type="text" placeholder="Nombre de quien recibe" style="width:100%; padding:10px; border:1px solid #d1d5db; border-radius:8px; margin-bottom:8px;">
        <div class="modal-no-entregado-actions">
          <button class="btn-primary" onclick="confirmarNombrePorteriaEntregado()">Continuar</button>
          <button class="btn-warning" onclick="mostrarPasoModalPagoEntregado('lugar')">Atrás</button>
        </div>
      </div>

      <div id="pasoMetodoPago" style="display:none;">
        <p>Selecciona el método de pago del pedido:</p>
        <div class="modal-no-entregado-actions">
          ${btnNequi}
          <button class="btn-info" onclick="seleccionarMetodoPagoEntregado('efectivo')">Efectivo</button>
          <button class="btn-route" onclick="seleccionarMetodoPagoEntregado('daviplata')">Daviplata</button>
          ${btnNequiMixto}
          <button class="btn-route" onclick="seleccionarMetodoPagoEntregado('daviplata_efectivo')">Daviplata + Efectivo</button>
          <button class="btn-warning" onclick="seleccionarMetodoPagoEntregado('pagado_tienda')">Ya se pagó a la tienda</button>
          <button class="btn-info" onclick="seleccionarMetodoPagoEntregado('es_cambio')">Es un cambio</button>
        </div>
        <div id="montosMixtosPago" style="display:none; margin-top: 12px;">
          <input id="montoDigitalPago" type="text" inputmode="numeric" placeholder="Monto digital" style="width:100%; padding:10px; border:1px solid #d1d5db; border-radius:8px; margin-bottom:8px;">
          <input id="montoEfectivoPago" type="text" inputmode="numeric" placeholder="Monto en efectivo" style="width:100%; padding:10px; border:1px solid #d1d5db; border-radius:8px;">
          <button class="btn-primary" style="width:100%; margin-top:8px;" onclick="confirmarMontosMixtosPago()">Confirmar montos</button>
        </div>
        <div class="modal-no-entregado-actions" style="margin-top: 8px;">
          <button class="btn-warning" onclick="mostrarPasoModalPagoEntregado('lugar')">Atrás</button>
        </div>
      </div>

      <div id="pasoCambioPregunta" style="display:none;">
        <p>¿Se dio cambio al cliente?</p>
        <div class="modal-no-entregado-actions">
          <button type="button" class="btn-success" onclick="responderDioCambioEntrega(true)">Sí, se dio cambio</button>
          <button type="button" class="btn-info" onclick="responderDioCambioEntrega(false)">No se dio cambio</button>
          <button type="button" class="btn-warning" onclick="volverAMetodoPagoDesdeCambio()">Atrás</button>
        </div>
      </div>

      <div id="pasoCambioDetalle" style="display:none;">
        <p>¿Cómo se entregó el cambio?</p>
        <div class="modal-no-entregado-actions" id="mediosCambioEntregaBtns">
          <button type="button" class="btn-info" onclick="seleccionarMedioCambioEntrega('efectivo')">Efectivo</button>
          ${btnCambioNequi}
          <button type="button" class="btn-route" onclick="seleccionarMedioCambioEntrega('daviplata')">Daviplata</button>
        </div>
        <p id="medioCambioSeleccionadoTxt" class="modal-editar-pedido-ayuda" style="margin-top:10px;"></p>
        <label class="modal-editar-pedido-label" for="montoCambioEntrega">¿De cuánto fue el cambio?</label>
        <input id="montoCambioEntrega" type="text" inputmode="numeric" placeholder="Ej: 5.000" style="width:100%; padding:10px; border:1px solid #d1d5db; border-radius:8px; margin-bottom:8px;">
        <div class="modal-no-entregado-actions">
          <button type="button" class="btn-primary" onclick="confirmarCambioEntrega()">Confirmar cambio</button>
          <button type="button" class="btn-warning" onclick="mostrarPasoModalPagoEntregado('cambio')">Atrás</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  vincularFormateoMilesInput(document.getElementById('montoDigitalPago'));
  vincularFormateoMilesInput(document.getElementById('montoEfectivoPago'));
  vincularFormateoMilesInput(document.getElementById('montoCambioEntrega'));
  return modal;
}

function cerrarModalPagoEntregado() {
  const modal = document.getElementById('modalPagoEntregado');
  if (!modal) return;
  modal.style.display = 'none';
  mostrarPasoModalPagoEntregado('lugar');
  const contenedorMontos = document.getElementById('montosMixtosPago');
  const inputDigital = document.getElementById('montoDigitalPago');
  const inputEfectivo = document.getElementById('montoEfectivoPago');
  const inputCambio = document.getElementById('montoCambioEntrega');
  const txtMedio = document.getElementById('medioCambioSeleccionadoTxt');
  if (contenedorMontos) contenedorMontos.style.display = 'none';
  if (inputDigital) inputDigital.value = '';
  if (inputEfectivo) inputEfectivo.value = '';
  if (inputCambio) inputCambio.value = '';
  if (txtMedio) txtMedio.textContent = '';
  if (pagoEntregadoPendiente) {
    pagoEntregadoPendiente.datosPagoPendientes = null;
    pagoEntregadoPendiente.cambioMetodo = '';
  }
}

function textoMetodoPagoEntregaPedido(pedido) {
  const metodo = pedido?.metodoPagoEntrega || '';
  if (metodo === 'nequi') return 'Nequi';
  if (metodo === 'efectivo') return 'Efectivo';
  if (metodo === 'daviplata') return 'Daviplata';
  if (metodo === 'nequi_efectivo') {
    return `Nequi + Efectivo (Nequi: $${Number(pedido.montoNequi || 0).toLocaleString('es-CO')}, Efectivo: $${Number(pedido.montoEfectivo || 0).toLocaleString('es-CO')})`;
  }
  if (metodo === 'daviplata_efectivo') {
    return `Daviplata + Efectivo (Daviplata: $${Number(pedido.montoDaviplata || 0).toLocaleString('es-CO')}, Efectivo: $${Number(pedido.montoEfectivo || 0).toLocaleString('es-CO')})`;
  }
  if (metodo === 'pagado_tienda') return 'Ya se pagó a la tienda';
  if (metodo === 'es_cambio') return 'Es un cambio';
  return 'No especificado';
}

function construirMensajeEntregaRegistrada(pedido) {
  if (!pedido) return '';
  if (pedido.mensajeEntregaPorteria) return String(pedido.mensajeEntregaPorteria);
  const pedidoId = pedido.id != null ? pedido.id : 'N/A';
  const montoNequi = Number(pedido.montoNequi || 0);
  const montoDav = Number(pedido.montoDaviplata || 0);
  const montoEfectivo = Number(pedido.montoEfectivo || 0);
  const montoRecibido = montoNequi + montoDav + montoEfectivo;
  const productosEntregados = textoProductosEntregaParaSoporte(pedido);
  const metodoPagoTexto = textoMetodoPagoEntregaPedido(pedido);
  const metodo = pedido.metodoPagoEntrega || '';
  const detalleMonto =
    metodo === 'pagado_tienda'
      ? 'No aplica (ya se pagó a la tienda)'
      : metodo === 'es_cambio'
        ? 'No aplica (es un cambio)'
        : `$${montoRecibido.toLocaleString('es-CO')}`;
  const recibidoPor = String(pedido.porteriaRecibidoPor || '').trim();
  const detalleEntrega =
    pedido.lugarEntregaFinal === 'porteria' && recibidoPor
      ? `Entregado en portería. Recibe: ${recibidoPor}`
      : '';
  const lineaValor =
    pedido.valorModificado
      ? `Valor modificado: sí${
          pedido.valorOriginal != null && String(pedido.valorOriginal).trim() !== ''
            ? ` (antes $${Number(String(pedido.valorOriginal).replace(/\D/g, '') || 0).toLocaleString('es-CO')} → ahora $${Number(String(pedido.valor || 0).replace(/\D/g, '') || 0).toLocaleString('es-CO')})`
            : ''
        }`
      : 'Valor modificado: no';
  const lineaCambio = textoLineaCambioEntregaPedido(pedido);
  let lineasDesglose = '';
  if (metodo !== 'pagado_tienda' && metodo !== 'es_cambio') {
    const partes = [];
    if (montoEfectivo) partes.push(`Efectivo ${formatearMontoConSigno(montoEfectivo)}`);
    if (montoNequi) partes.push(`Nequi ${formatearMontoConSigno(montoNequi)}`);
    if (montoDav) partes.push(`Daviplata ${formatearMontoConSigno(montoDav)}`);
    if (partes.length) lineasDesglose = `\nDesglose: ${partes.join(' · ')}`;
  }
  return `Pedido #${pedidoId} entregado${detalleEntrega ? `\n${detalleEntrega}` : ''}
Monto recibido: ${detalleMonto}${lineasDesglose}
${lineaValor}
${lineaCambio}
Producto(s) entregado(s):
${productosEntregados}
Método de pago: ${metodoPagoTexto}`;
}

function textoMedioCambioEntrega(medio) {
  if (medio === 'nequi') return 'Nequi';
  if (medio === 'daviplata') return 'Daviplata';
  if (medio === 'efectivo') return 'Efectivo';
  return 'No especificado';
}

function textoLineaCambioEntregaPedido(pedido) {
  if (!pedido) return 'Cambio entregado: no';
  const metodo = String(pedido.metodoPagoEntrega || '');
  if (metodo === 'pagado_tienda' || metodo === 'es_cambio') {
    return 'Cambio entregado: no aplica';
  }
  if (!pedido.dioCambio) return 'Cambio entregado: no';
  const monto = Number(pedido.montoCambio || 0);
  const medio = textoMedioCambioEntrega(pedido.cambioMetodo);
  return `Cambio entregado: sí (${medio}: $${monto.toLocaleString('es-CO')})`;
}

function pieMensajeClientePorteria() {
  return 'Cualquier duda o inquietud, comunicarse con las personas que le vendieron.';
}

function construirMensajeEntregaPorteriaCliente(pedido) {
  const base = construirMensajeEntregaRegistrada(pedido);
  if (!base) return pieMensajeClientePorteria();
  return `${base}\n\n${pieMensajeClientePorteria()}`;
}

function pedidoPendienteNotificarClientePorteria(pedido) {
  return !!(
    pedido &&
    pedido.entregado &&
    pedido.lugarEntregaFinal === 'porteria' &&
    pedido.pendienteNotificarClientePorteria
  );
}

function guardarEntregaPorteriaEnPedido(pedido, mensaje, recibidoPor) {
  if (!pedido) return;
  pedido.lugarEntregaFinal = 'porteria';
  pedido.porteriaRecibidoPor = String(recibidoPor || '').trim();
  pedido.mensajeEntregaPorteria = String(mensaje || '');
  pedido.pendienteNotificarClientePorteria = true;
  pedido.clienteNotificadoPorteria = false;
}

function limpiarEntregaPorteriaEnPedido(pedido) {
  if (!pedido) return;
  pedido.lugarEntregaFinal = 'cliente';
  pedido.porteriaRecibidoPor = '';
  pedido.mensajeEntregaPorteria = '';
  pedido.pendienteNotificarClientePorteria = false;
  pedido.clienteNotificadoPorteria = false;
}

function limpiarFlujoPostCierrePedido() {
  flujoPostCierrePedido = null;
  flujoPostCierreEstabaOculto = false;
}

function iniciarFlujoPostCierrePedido({ pedidoId, tipo, mensajeTienda, enviarWhatsAppAdmin = true }) {
  flujoPostCierrePedido = {
    pedidoId,
    tipo, // 'porteria' | 'no_entregado'
    mensajeTienda: String(mensajeTienda || ''),
    enviarWhatsAppAdmin: enviarWhatsAppAdmin !== false,
    fase: 'enviar_tienda',
  };
  if (tipo === 'porteria') porteriaClienteModalOfrecido.delete(Number(pedidoId));
  if (tipo === 'no_entregado') noEntregadoClienteModalOfrecido.delete(Number(pedidoId));
  // Primero tienda; al regresar se pregunta por el cliente.
  window.setTimeout(() => {
    enviarMensajeTiendaFlujoPostCierre();
  }, 0);
}

function toastMensajeTiendaFlujo(tipo) {
  if (tipo === 'no_entregado') {
    return 'Mensaje copiado. Pégalo en el chat de la tienda (no entregado).';
  }
  return 'Mensaje copiado. Pégalo en el chat de la tienda y adjunta la foto de entrega.';
}

function enviarMensajeTiendaFlujoPostCierre() {
  const flujo = flujoPostCierrePedido;
  if (!flujo) return;
  if (!flujo.enviarWhatsAppAdmin) {
    flujo.fase = 'preguntar_cliente';
    window.setTimeout(() => ofrecerNotificarClienteTrasCierrePedido(), 0);
    return;
  }
  const numeroAdmin = obtenerSoporteWhatsApp();
  const mensaje = String(flujo.mensajeTienda || '');
  flujo.fase = 'esperando_retorno_tienda';
  flujoPostCierreEstabaOculto = false;
  void copiarTextoAlPortapapeles(mensaje, toastMensajeTiendaFlujo(flujo.tipo));
  // Chat vacío: el mensajero pega el texto (y adjunta la foto).
  abrirWhatsAppChat(numeroAdmin);
}

function continuarConSiguientePedidoTrasCierre() {
  const flujo = flujoPostCierrePedido;
  const excluir = flujo ? flujo.pedidoId : null;
  limpiarFlujoPostCierrePedido();
  if (excluir == null) return;
  notificarSiguientePedido(excluir);
}

function ofrecerNotificarClienteTrasCierrePedido() {
  const flujo = flujoPostCierrePedido;
  if (!flujo || flujo.fase !== 'preguntar_cliente') return false;
  if (hayModalBloqueandoNotificacionCliente()) return false;

  const pedido = pedidos.find((p) => Number(p.id) === Number(flujo.pedidoId));
  if (!pedido) {
    continuarConSiguientePedidoTrasCierre();
    return false;
  }

  if (flujo.tipo === 'porteria') {
    if (!pedidoPendienteNotificarClientePorteria(pedido)) {
      continuarConSiguientePedidoTrasCierre();
      return false;
    }
    const id = Number(pedido.id);
    const indexFinal = pedidos.findIndex((p) => Number(p.id) === id);
    mostrarModalDecision({
      titulo: 'Notificar al cliente',
      texto: `El pedido #${pedido.id} quedó en portería.\n¿Quieres notificarle al cliente?`,
      textoConfirmar: 'Sí, notificar',
      claseConfirmar: 'btn-notify',
      textoSecundario: 'No, notificar',
      claseSecundario: 'btn-info',
      mostrarCancelar: false,
      onConfirmar: () => notificarClienteEntregaPorteria(indexFinal >= 0 ? indexFinal : 0, pedido.id),
      onSecundario: () => declinarNotificarClientePorteria(pedido),
      onCancelar: () => {}
    });
    return true;
  }

  if (flujo.tipo === 'no_entregado') {
    if (!pedidoPendienteNotificarClienteNoEntregado(pedido)) {
      continuarConSiguientePedidoTrasCierre();
      return false;
    }
    const id = Number(pedido.id);
    const indexFinal = pedidos.findIndex((p) => Number(p.id) === id);
    mostrarModalDecision({
      titulo: 'Notificar al cliente',
      texto: `El pedido #${pedido.id} no fue entregado.\n¿Quieres notificarle al cliente?`,
      textoConfirmar: 'Sí, notificar',
      claseConfirmar: 'btn-notify',
      textoSecundario: 'No, notificar',
      claseSecundario: 'btn-info',
      mostrarCancelar: false,
      onConfirmar: () => notificarClienteNoEntregado(indexFinal >= 0 ? indexFinal : 0, pedido.id),
      onSecundario: () => declinarNotificarClienteNoEntregado(pedido),
      onCancelar: () => {}
    });
    return true;
  }

  return false;
}

function continuarConSiguientePedidoTrasCliente() {
  continuarConSiguientePedidoTrasCierre();
}

function declinarNotificarClientePorteria(pedido) {
  if (!pedido) return;
  pedido.pendienteNotificarClientePorteria = false;
  guardarPedidos();
  renderPedidos();
  continuarConSiguientePedidoTrasCierre();
}

function declinarNotificarClienteNoEntregado(pedido) {
  if (!pedido) return;
  pedido.pendienteNotificarClienteNoEntregado = false;
  guardarPedidos();
  renderPedidos();
  continuarConSiguientePedidoTrasCierre();
}

function notificarClienteEntregaPorteria(index, pedidoId) {
  const { pedido, indexActual } = obtenerPedidoPorId(pedidoId);
  const indexFinal = indexActual >= 0 ? indexActual : index;
  const pedidoFinal = pedido || pedidos[indexFinal];
  if (!pedidoFinal || !pedidoPendienteNotificarClientePorteria(pedidoFinal)) {
    mostrarToast('No hay mensaje de portería pendiente para este pedido.', 'warning');
    return;
  }
  const mensaje = construirMensajeEntregaPorteriaCliente(pedidoFinal);
  const tels = obtenerTelefonosPedido(pedidoFinal);
  if (!tels.length) {
    mostrarAvisoEnApp('No hay número de teléfono del cliente disponible', 'Notificación');
    return;
  }
  seleccionarTelefonoConModal(tels, 'Notificar al cliente', (telElegido) => {
    abrirWhatsAppConTexto(telElegido, mensaje);
    pedidoFinal.pendienteNotificarClientePorteria = false;
    pedidoFinal.clienteNotificadoPorteria = true;
    porteriaClienteModalOfrecido.add(Number(pedidoFinal.id));
    if (flujoPostCierrePedido && Number(flujoPostCierrePedido.pedidoId) === Number(pedidoFinal.id)) {
      flujoPostCierrePedido.fase = 'esperando_retorno_cliente';
      flujoPostCierreEstabaOculto = false;
    }
    guardarPedidos();
    renderPedidos();
    mostrarToast('Mensaje enviado al cliente por WhatsApp.', 'success');
  });
}

function ofrecerNotificarClientePorteriaSiPendiente() {
  if (flujoPostCierrePedido && flujoPostCierrePedido.fase === 'preguntar_cliente') {
    return ofrecerNotificarClienteTrasCierrePedido();
  }
  const pendiente = pedidos.find((p) => pedidoPendienteNotificarClientePorteria(p));
  if (!pendiente) return false;
  const id = Number(pendiente.id);
  if (porteriaClienteModalOfrecido.has(id)) return false;
  if (hayModalBloqueandoNotificacionCliente()) return false;

  porteriaClienteModalOfrecido.add(id);
  const indexFinal = pedidos.findIndex((p) => Number(p.id) === id);
  mostrarModalDecision({
    titulo: 'Notificar al cliente',
    texto: `El pedido #${pendiente.id} quedó en portería.\n¿Quieres notificarle al cliente?`,
    textoConfirmar: 'Sí, notificar',
    claseConfirmar: 'btn-notify',
    textoSecundario: 'No, notificar',
    claseSecundario: 'btn-info',
    mostrarCancelar: false,
    onConfirmar: () => notificarClienteEntregaPorteria(indexFinal >= 0 ? indexFinal : 0, pendiente.id),
    onSecundario: () => declinarNotificarClientePorteria(pendiente),
    onCancelar: () => {}
  });
  return true;
}

function despedidaPorHoraDispositivo() {
  const h = new Date().getHours();
  if (h >= 5 && h < 12) return 'que tenga buen día';
  if (h >= 12 && h < 19) return 'que tenga buena tarde';
  return 'que tenga buena noche';
}

function pieMensajeClienteTienda() {
  return `Cualquier duda o inquietud, por favor comunicarse con la tienda, ${despedidaPorHoraDispositivo()}.`;
}

function construirMensajeNoEntregadoTienda(pedido, pedidoId, enUbicacion, motivo) {
  const productos = textoProductosEntregaParaSoporte(pedido);
  const ubicacionTxt = enUbicacion
    ? 'Estuve en el punto de entrega'
    : 'No fui al punto de entrega';
  const motivoTxt = String(motivo || '').trim();
  return `Pedido #${pedidoId} no entregado
Ubicación: ${ubicacionTxt}
Motivo: ${motivoTxt}
Producto(s):
${productos}`;
}

function construirMensajeNoEntregadoCliente(pedido) {
  const base = String(pedido?.mensajeNoEntregadoTienda || '').trim();
  if (!base) return pieMensajeClienteTienda();
  return `${base}\n\n${pieMensajeClienteTienda()}`;
}

function pedidoPendienteNotificarClienteNoEntregado(pedido) {
  return !!(
    pedido &&
    pedido.entregado &&
    pedido.noEntregado &&
    pedido.pendienteNotificarClienteNoEntregado
  );
}

function guardarNoEntregadoNotificacionEnPedido(pedido, mensajeTienda, motivo, enUbicacion) {
  if (!pedido) return;
  pedido.motivoNoEntregado = String(motivo || '').trim();
  pedido.mensajeNoEntregadoTienda = String(mensajeTienda || '');
  pedido.pendienteNotificarClienteNoEntregado = true;
  pedido.clienteNotificadoNoEntregado = false;
  pedido.envioRecogido = !!enUbicacion;
}

function limpiarNotificacionNoEntregadoEnPedido(pedido) {
  if (!pedido) return;
  pedido.motivoNoEntregado = '';
  pedido.mensajeNoEntregadoTienda = '';
  pedido.pendienteNotificarClienteNoEntregado = false;
  pedido.clienteNotificadoNoEntregado = false;
}

function hayModalBloqueandoNotificacionCliente() {
  const ids = ['modalDecision', 'modalPagoEntregado', 'modalNoEntregado'];
  return ids.some((id) => {
    const el = document.getElementById(id);
    return el && el.style.display === 'flex';
  });
}

function notificarClienteNoEntregado(index, pedidoId) {
  const { pedido, indexActual } = obtenerPedidoPorId(pedidoId);
  const indexFinal = indexActual >= 0 ? indexActual : index;
  const pedidoFinal = pedido || pedidos[indexFinal];
  if (!pedidoFinal || !pedidoPendienteNotificarClienteNoEntregado(pedidoFinal)) {
    mostrarToast('No hay mensaje de no entregado pendiente para este pedido.', 'warning');
    return;
  }
  const mensaje = construirMensajeNoEntregadoCliente(pedidoFinal);
  const tels = obtenerTelefonosPedido(pedidoFinal);
  if (!tels.length) {
    mostrarAvisoEnApp('No hay número de teléfono del cliente disponible', 'Notificación');
    return;
  }
  seleccionarTelefonoConModal(tels, 'Notificar al cliente', (telElegido) => {
    abrirWhatsAppConTexto(telElegido, mensaje);
    pedidoFinal.pendienteNotificarClienteNoEntregado = false;
    pedidoFinal.clienteNotificadoNoEntregado = true;
    noEntregadoClienteModalOfrecido.add(Number(pedidoFinal.id));
    if (flujoPostCierrePedido && Number(flujoPostCierrePedido.pedidoId) === Number(pedidoFinal.id)) {
      flujoPostCierrePedido.fase = 'esperando_retorno_cliente';
      flujoPostCierreEstabaOculto = false;
    }
    guardarPedidos();
    renderPedidos();
    mostrarToast('Mensaje enviado al cliente por WhatsApp.', 'success');
  });
}

function ofrecerNotificarClienteNoEntregadoSiPendiente() {
  if (flujoPostCierrePedido && flujoPostCierrePedido.fase === 'preguntar_cliente') {
    return ofrecerNotificarClienteTrasCierrePedido();
  }
  const pendiente = pedidos.find((p) => pedidoPendienteNotificarClienteNoEntregado(p));
  if (!pendiente) return false;
  const id = Number(pendiente.id);
  if (noEntregadoClienteModalOfrecido.has(id)) return false;
  if (hayModalBloqueandoNotificacionCliente()) return false;

  noEntregadoClienteModalOfrecido.add(id);
  const indexFinal = pedidos.findIndex((p) => Number(p.id) === id);
  mostrarModalDecision({
    titulo: 'Notificar al cliente',
    texto: `El pedido #${pendiente.id} no fue entregado.\n¿Quieres notificarle al cliente?`,
    textoConfirmar: 'Sí, notificar',
    claseConfirmar: 'btn-notify',
    textoSecundario: 'No, notificar',
    claseSecundario: 'btn-info',
    mostrarCancelar: false,
    onConfirmar: () => notificarClienteNoEntregado(indexFinal >= 0 ? indexFinal : 0, pendiente.id),
    onSecundario: () => declinarNotificarClienteNoEntregado(pendiente),
    onCancelar: () => {}
  });
  return true;
}

function configurarRetornoNotificarClientePorteria() {
  if (configurarRetornoNotificarClientePorteria._listo) return;
  configurarRetornoNotificarClientePorteria._listo = true;
  const avanzarTrasRetornoReal = () => {
    if (hayModalBloqueandoNotificacionCliente()) return;

    const flujo = flujoPostCierrePedido;
    if (flujo) {
      if (flujo.fase === 'esperando_retorno_tienda') {
        flujo.fase = 'preguntar_cliente';
        ofrecerNotificarClienteTrasCierrePedido();
        return;
      }
      if (flujo.fase === 'preguntar_cliente') {
        ofrecerNotificarClienteTrasCierrePedido();
        return;
      }
      if (flujo.fase === 'esperando_retorno_cliente' || flujo.fase === 'listo_siguiente') {
        continuarConSiguientePedidoTrasCierre();
        return;
      }
      if (flujo.fase === 'enviar_tienda') {
        enviarMensajeTiendaFlujoPostCierre();
        return;
      }
    }

    const ofrecioPorteria = ofrecerNotificarClientePorteriaSiPendiente();
    if (ofrecioPorteria) return;
    ofrecerNotificarClienteNoEntregadoSiPendiente();
  };

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flujoPostCierreEstabaOculto = true;
      return;
    }
    if (document.visibilityState !== 'visible') return;
    if (!flujoPostCierreEstabaOculto && flujoPostCierrePedido && flujoPostCierrePedido.fase !== 'preguntar_cliente') {
      return;
    }
    flujoPostCierreEstabaOculto = false;
    avanzarTrasRetornoReal();
  });
  window.addEventListener('focus', () => {
    if (!flujoPostCierreEstabaOculto && flujoPostCierrePedido && flujoPostCierrePedido.fase !== 'preguntar_cliente') {
      return;
    }
    if (flujoPostCierreEstabaOculto) flujoPostCierreEstabaOculto = false;
    avanzarTrasRetornoReal();
  });
  window.addEventListener('pageshow', () => {
    flujoPostCierreEstabaOculto = false;
    avanzarTrasRetornoReal();
  });
}

function fotoEntregado(index, pedidoId) {
  pagoEntregadoPendiente = {
    index,
    pedidoId,
    enviarWhatsAppAdmin: true,
    lugarEntrega: null,
    recibidoPor: '',
    datosPagoPendientes: null,
    cambioMetodo: '',
  };
  const modal = asegurarModalPagoEntregado();
  mostrarPasoModalPagoEntregado('lugar');
  modal.style.display = 'flex';
}

async function registrarEntregaConPago(index, pedidoId, datosPago) {
  const indexActual = pedidos.findIndex((p) => p.id === pedidoId);
  const indexFinal = indexActual >= 0 ? indexActual : index;
  const pedido = pedidos[indexFinal];
  if (!pedido) return;

  const datosAjustados = aplicarAjusteVueltasDigitalesSobreMontos(datosPago);

  pedido.noEntregado = false;
  pedido.envioRecogido = false;
  pedido.metodoPagoEntrega = datosAjustados.metodo;
  pedido.montoNequi = Number(datosAjustados.montoNequi || 0);
  pedido.montoDaviplata = Number(datosAjustados.montoDaviplata || 0);
  pedido.montoEfectivo = Number(datosAjustados.montoEfectivo || 0);
  pedido.dioCambio = !!datosAjustados.dioCambio;
  pedido.cambioMetodo = datosAjustados.dioCambio ? String(datosAjustados.cambioMetodo || '') : '';
  pedido.montoCambio = datosAjustados.dioCambio ? Number(datosAjustados.montoCambio || 0) : 0;
  pedido.ajusteVueltasDigitales = !!datosAjustados.ajusteVueltasDigitales;

  const esPorteria =
    pagoEntregadoPendiente &&
    pagoEntregadoPendiente.lugarEntrega === 'porteria' &&
    String(pagoEntregadoPendiente.recibidoPor || '').trim() !== '';
  const enviarWhatsAppAdmin = pagoEntregadoPendiente.enviarWhatsAppAdmin !== false;
  const recibidoPorSnap = esPorteria
    ? String(pagoEntregadoPendiente.recibidoPor || '').trim()
    : '';

  // Marcar entregado en local de inmediato (el historial va en segundo plano).
  pedido.entregado = true;
  pedido.enCurso = false;
  pedido.llegoDestino = false;
  pedido.posicionPendiente = null;
  sellarFechaOperacionPedido(pedido);

  if (esPorteria) {
    const mensaje = construirMensajeEntregaRegistrada({
      ...pedido,
      lugarEntregaFinal: 'porteria',
      porteriaRecibidoPor: recibidoPorSnap,
    });
    guardarEntregaPorteriaEnPedido(pedido, mensaje, recibidoPorSnap);
    pagoEntregadoPendiente = {
      index: null,
      pedidoId: null,
      enviarWhatsAppAdmin: true,
      lugarEntrega: null,
      recibidoPor: '',
      datosPagoPendientes: null,
      cambioMetodo: '',
    };
    guardarPedidos();
    renderPedidos();
    actualizarMarcadores();
    void persistirHistorialTrasCierrePedido(pedido);
    iniciarFlujoPostCierrePedido({
      pedidoId,
      tipo: 'porteria',
      mensajeTienda: mensaje,
      enviarWhatsAppAdmin,
    });
    return;
  }

  limpiarEntregaPorteriaEnPedido(pedido);
  const mensaje = construirMensajeEntregaRegistrada(pedido);
  pagoEntregadoPendiente = {
    index: null,
    pedidoId: null,
    enviarWhatsAppAdmin: true,
    lugarEntrega: null,
    recibidoPor: '',
    datosPagoPendientes: null,
    cambioMetodo: '',
  };
  guardarPedidos();
  renderPedidos();
  actualizarMarcadores();

  // Copiar texto y abrir chat vacío (sin mensaje precargado) para pegar y adjuntar foto.
  if (enviarWhatsAppAdmin) {
    const numeroAdmin = obtenerSoporteWhatsApp();
    void copiarTextoAlPortapapeles(
      mensaje,
      'Mensaje copiado. Pégalo en el chat y adjunta la foto de entrega.'
    );
    abrirWhatsAppChat(numeroAdmin);
  }

  void persistirHistorialTrasCierrePedido(pedido);
  // Diferir el modal del siguiente pedido para no cancelar la apertura de WhatsApp en móvil.
  window.setTimeout(() => {
    notificarSiguientePedido(pedidoId);
  }, 700);
}

/** Tras elegir método de pago: preguntar por cambio (salvo casos que no aplican). */
function continuarTrasElegirMetodoPago(indexFinal, pedidoId, datosPago) {
  const metodo = String(datosPago?.metodo || '');
  if (metodo === 'pagado_tienda' || metodo === 'es_cambio') {
    cerrarModalPagoEntregado();
    registrarEntregaConPago(indexFinal, pedidoId, {
      ...datosPago,
      dioCambio: false,
      cambioMetodo: '',
      montoCambio: 0,
    });
    return;
  }
  pagoEntregadoPendiente.datosPagoPendientes = { ...datosPago };
  pagoEntregadoPendiente.cambioMetodo = '';
  const contenedorMontos = document.getElementById('montosMixtosPago');
  if (contenedorMontos) contenedorMontos.style.display = 'none';
  const inputCambio = document.getElementById('montoCambioEntrega');
  const txtMedio = document.getElementById('medioCambioSeleccionadoTxt');
  if (inputCambio) inputCambio.value = '';
  if (txtMedio) txtMedio.textContent = '';
  mostrarPasoModalPagoEntregado('cambio');
}

function volverAMetodoPagoDesdeCambio() {
  pagoEntregadoPendiente.datosPagoPendientes = null;
  pagoEntregadoPendiente.cambioMetodo = '';
  mostrarPasoModalPagoEntregado('pago');
}

function responderDioCambioEntrega(dioCambio) {
  const base = pagoEntregadoPendiente.datosPagoPendientes;
  if (!base) {
    mostrarAvisoEnApp('Selecciona primero el método de pago.', 'Pago');
    mostrarPasoModalPagoEntregado('pago');
    return;
  }
  const { index, pedidoId } = pagoEntregadoPendiente;
  if (!dioCambio) {
    cerrarModalPagoEntregado();
    void registrarEntregaConPago(index, pedidoId, {
      ...base,
      dioCambio: false,
      cambioMetodo: '',
      montoCambio: 0,
    });
    return;
  }
  pagoEntregadoPendiente.cambioMetodo = '';
  const txtMedio = document.getElementById('medioCambioSeleccionadoTxt');
  const inputCambio = document.getElementById('montoCambioEntrega');
  if (txtMedio) txtMedio.textContent = 'Elige cómo se entregó el cambio.';
  if (inputCambio) inputCambio.value = '';
  mostrarPasoModalPagoEntregado('cambioDetalle');
  if (inputCambio) {
    vincularFormateoMilesInput(inputCambio);
    setTimeout(() => inputCambio.focus(), 40);
  }
}

function seleccionarMedioCambioEntrega(medio) {
  const m = String(medio || '');
  if (!['efectivo', 'nequi', 'daviplata'].includes(m)) return;
  pagoEntregadoPendiente.cambioMetodo = m;
  const txtMedio = document.getElementById('medioCambioSeleccionadoTxt');
  if (txtMedio) txtMedio.textContent = `Medio seleccionado: ${textoMedioCambioEntrega(m)}`;
  const inputCambio = document.getElementById('montoCambioEntrega');
  if (inputCambio) setTimeout(() => inputCambio.focus(), 40);
}

function confirmarCambioEntrega() {
  const base = pagoEntregadoPendiente.datosPagoPendientes;
  if (!base) {
    mostrarAvisoEnApp('Selecciona primero el método de pago.', 'Pago');
    mostrarPasoModalPagoEntregado('pago');
    return;
  }
  const medio = String(pagoEntregadoPendiente.cambioMetodo || '');
  if (!['efectivo', 'nequi', 'daviplata'].includes(medio)) {
    mostrarAvisoEnApp('Elige si el cambio fue en efectivo, Nequi o Daviplata.', 'Cambio');
    return;
  }
  const inputCambio = document.getElementById('montoCambioEntrega');
  const monto = parseMontoEntero(inputCambio?.value);
  if (monto <= 0) {
    mostrarAvisoEnApp('Indica de cuánto fue el cambio.', 'Cambio');
    if (inputCambio) inputCambio.focus();
    return;
  }
  const { index, pedidoId } = pagoEntregadoPendiente;
  cerrarModalPagoEntregado();
  void registrarEntregaConPago(index, pedidoId, {
    ...base,
    dioCambio: true,
    cambioMetodo: medio,
    montoCambio: monto,
  });
}

function seleccionarMetodoPagoEntregado(metodo) {
  const { index, pedidoId } = pagoEntregadoPendiente;
  const indexActual = pedidos.findIndex(p => p.id === pedidoId);
  const indexFinal = indexActual >= 0 ? indexActual : index;
  const pedido = pedidos[indexFinal];
  if (!pedido) return;

  const totalPedido = parseMontoEntero(pedido.valor);
  const contenedorMontos = document.getElementById('montosMixtosPago');
  const inputDigital = document.getElementById('montoDigitalPago');
  const inputEfectivo = document.getElementById('montoEfectivoPago');

  if (metodo === 'nequi_efectivo' || metodo === 'daviplata_efectivo') {
    if (!contenedorMontos || !inputDigital || !inputEfectivo) return;
    contenedorMontos.style.display = 'block';
    inputDigital.placeholder = metodo === 'nequi_efectivo' ? 'Monto pagado por Nequi' : 'Monto pagado por Daviplata';
    inputEfectivo.placeholder = 'Monto pagado en efectivo';
    inputDigital.value = '';
    inputEfectivo.value = '';
    inputDigital.dataset.metodoMixto = metodo;
    inputDigital.dataset.totalPedido = String(totalPedido);
    return;
  }

  const datosPago = {
    metodo,
    montoNequi: metodo === 'nequi' ? totalPedido : 0,
    montoDaviplata: metodo === 'daviplata' ? totalPedido : 0,
    montoEfectivo: metodo === 'efectivo' ? totalPedido : 0
  };
  continuarTrasElegirMetodoPago(indexFinal, pedidoId, datosPago);
}

function confirmarMontosMixtosPago() {
  const { index, pedidoId } = pagoEntregadoPendiente;
  const inputDigital = document.getElementById('montoDigitalPago');
  const inputEfectivo = document.getElementById('montoEfectivoPago');
  if (!inputDigital || !inputEfectivo) return;

  const metodo = inputDigital.dataset.metodoMixto || '';
  const totalPedido = parseInt(inputDigital.dataset.totalPedido || '0', 10);
  const montoDigital = parseMontoEntero(inputDigital.value);
  const montoEfectivo = parseMontoEntero(inputEfectivo.value);

  if (!(metodo === 'nequi_efectivo' || metodo === 'daviplata_efectivo')) {
    mostrarToast('Selecciona un método de pago mixto válido.', 'warning');
    return;
  }
  if (montoDigital <= 0 || montoEfectivo <= 0) {
    mostrarToast('Debes ingresar ambos montos para registrar el pago mixto.', 'warning');
    return;
  }
  if (montoDigital + montoEfectivo !== totalPedido) {
    mostrarToast(
      `La suma de montos debe ser igual al valor del pedido ($${totalPedido.toLocaleString('es-CO')}).`,
      'warning',
      7000
    );
    return;
  }

  const datosPago = {
    metodo,
    montoNequi: metodo === 'nequi_efectivo' ? montoDigital : 0,
    montoDaviplata: metodo === 'daviplata_efectivo' ? montoDigital : 0,
    montoEfectivo
  };
  continuarTrasElegirMetodoPago(index, pedidoId, datosPago);
}

let noEntregadoPendiente = { index: null, pedidoId: null, enUbicacion: null };

function mostrarPasoModalNoEntregado(paso) {
  const contUbicacion = document.getElementById('pasoNoEntregadoUbicacion');
  const contMotivo = document.getElementById('pasoNoEntregadoMotivo');
  if (contUbicacion) contUbicacion.style.display = paso === 'ubicacion' ? 'block' : 'none';
  if (contMotivo) contMotivo.style.display = paso === 'motivo' ? 'block' : 'none';
}

function asegurarModalNoEntregado() {
  let modal = document.getElementById('modalNoEntregado');
  if (modal && document.getElementById('pasoNoEntregadoMotivo')) return modal;
  if (modal) modal.remove();

  modal = document.createElement('div');
  modal.id = 'modalNoEntregado';
  modal.className = 'modal-no-entregado-backdrop';
  modal.innerHTML = `
    <div class="modal-no-entregado-card modal-no-entregado-card--con-cerrar-x">
      <button type="button" class="modal-no-entregado-close-x" onclick="cerrarModalNoEntregado()" aria-label="Cerrar">
        <i class="fa-solid fa-xmark" aria-hidden="true"></i>
      </button>
      <h3>No entregado</h3>
      <div id="pasoNoEntregadoUbicacion" style="display:block;">
        <p>Indica si estuviste en el punto de entrega (afecta el pago de $12.000 al delivery):</p>
        <div class="modal-no-entregado-actions">
          <button class="btn-warning" onclick="confirmarNoEntregado(true)">Estoy en el punto de entrega</button>
          <button class="btn-info" onclick="confirmarNoEntregado(false)">No fui al punto de entrega</button>
        </div>
      </div>
      <div id="pasoNoEntregadoMotivo" style="display:none;">
        <p id="noEntregadoUbicacionResumen" class="config-notificacion-ayuda"></p>
        <label for="noEntregadoMotivo" class="qr-pedidos-label">Motivo por el que no se entregó</label>
        <textarea id="noEntregadoMotivo" class="qr-pedidos-textarea" rows="4" spellcheck="true" placeholder="Ej: El cliente no respondió, no había quien recibiera, dirección incorrecta…"></textarea>
        <div class="modal-no-entregado-actions">
          <button class="btn-primary" onclick="confirmarMotivoNoEntregado()">Enviar a la tienda</button>
          <button class="btn-warning" onclick="mostrarPasoModalNoEntregado('ubicacion')">Atrás</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  return modal;
}

function mostrarOpcionesNoEntregado(index, pedidoId) {
  noEntregadoPendiente = { index, pedidoId, enUbicacion: null };
  const modal = asegurarModalNoEntregado();
  mostrarPasoModalNoEntregado('ubicacion');
  const ta = document.getElementById('noEntregadoMotivo');
  if (ta) ta.value = '';
  modal.style.display = 'flex';
}

function cerrarModalNoEntregado() {
  const modal = document.getElementById('modalNoEntregado');
  if (!modal) return;
  modal.style.display = 'none';
  mostrarPasoModalNoEntregado('ubicacion');
  noEntregadoPendiente = { index: null, pedidoId: null, enUbicacion: null };
}

function confirmarNoEntregado(enUbicacion) {
  noEntregadoPendiente.enUbicacion = !!enUbicacion;
  const resumen = document.getElementById('noEntregadoUbicacionResumen');
  if (resumen) {
    resumen.textContent = enUbicacion
      ? 'Indicaste que estuviste en el punto de entrega.'
      : 'Indicaste que no fuiste al punto de entrega.';
  }
  mostrarPasoModalNoEntregado('motivo');
  const ta = document.getElementById('noEntregadoMotivo');
  if (ta) {
    ta.value = '';
    ta.focus();
  }
}

function confirmarMotivoNoEntregado() {
  const { index, pedidoId, enUbicacion } = noEntregadoPendiente;
  const ta = document.getElementById('noEntregadoMotivo');
  const motivo = ta ? String(ta.value || '').trim() : '';
  if (!motivo) {
    mostrarToast('Escribe el motivo por el que no se entregó el pedido.', 'warning');
    if (ta) ta.focus();
    return;
  }
  cerrarModalNoEntregado();
  procesarFotoNoEntregado(index, pedidoId, enUbicacion, motivo);
}

function fotoNoEntregado(index, pedidoId) {
  mostrarOpcionesNoEntregado(index, pedidoId);
}

async function procesarFotoNoEntregado(index, pedidoId, enUbicacion, motivo) {
  const indexActual = pedidos.findIndex(p => p.id === pedidoId);
  const indexFinal = indexActual >= 0 ? indexActual : index;
  const pedido = pedidos[indexFinal];
  if (!pedido) return;

  const mensajeTienda = construirMensajeNoEntregadoTienda(pedido, pedidoId, enUbicacion, motivo);
  guardarNoEntregadoNotificacionEnPedido(pedido, mensajeTienda, motivo, enUbicacion);

  pedido.entregado = true;
  pedido.enCurso = false;
  pedido.llegoDestino = false;
  pedido.posicionPendiente = null;
  pedido.noEntregado = true;
  sellarFechaOperacionPedido(pedido);
  guardarPedidos();
  renderPedidos();
  actualizarMarcadores();
  await persistirHistorialTrasCierrePedido(pedido);

  iniciarFlujoPostCierrePedido({
    pedidoId,
    tipo: 'no_entregado',
    mensajeTienda,
    enviarWhatsAppAdmin: true,
  });
}

// --- Enrutamiento ---

function getUbicacionPedido(index, pedidoId) {
  const pedido = pedidos[index];
  if (!pedido) return null;
  let lat = null, lng = null;
  if (pedido.coords && Number.isFinite(pedido.coords.lat) && Number.isFinite(pedido.coords.lng)) {
    lat = pedido.coords.lat;
    lng = pedido.coords.lng;
  }
  const marcadorPedido = marcadores.find(m => Number(m.pedidoId) === Number(pedidoId));
  if ((lat == null || lng == null) && marcadorPedido && marcadorPedido.latReal != null) {
    lat = marcadorPedido.latReal;
    lng = marcadorPedido.lngReal;
  }
  if ((lat == null || lng == null) && marcadorPedido && marcadorPedido.marker) {
    const pos = marcadorPedido.marker.getLatLng();
    lat = pos.lat;
    lng = pos.lng;
  }
  if ((lat == null || lng == null) && pedido.mapUrl) {
    const match = pedido.mapUrl.match(/@(-?\d+\.?\d*),(-?\d+\.?\d*)/);
    if (match) { lat = parseFloat(match[1]); lng = parseFloat(match[2]); }
  }
  if (lat != null && lng != null && Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
  if (pedido.direccion) return { direccion: pedido.direccion };
  return null;
}

function obtenerPedidoPorId(pedidoId) {
  const indexActual = pedidos.findIndex(p => p.id === pedidoId);
  if (indexActual >= 0) return { pedido: pedidos[indexActual], indexActual };
  return { pedido: null, indexActual: -1 };
}

function obtenerEtapaPedidoUI(pedido) {
  if (pedido.cancelado) return 'cancelado';
  if (pedido.entregado) return 'finalizado';
  if (!pedido.notificadoEnCamino) return 'notificar';
  if (!pedido.enCurso) return 'enrutar';
  if (!pedido.llegoDestino) return 'enRuta';
  return 'enDestino';
}

function abrirNavegacionConSelector(index, pedidoId) {
  const { pedido, indexActual } = obtenerPedidoPorId(pedidoId);
  const indexFinal = indexActual >= 0 ? indexActual : index;
  const pedidoFinal = pedido || pedidos[indexFinal];
  if (!pedidoFinal) return;

  const u = getUbicacionPedido(indexFinal, pedidoId);
  if (!u) {
    mostrarToast('No hay ubicación disponible para este pedido.', 'warning');
    return;
  }
  marcarEnCurso(indexFinal);

  // En móvil: usar "geo:" para que el sistema muestre apps instaladas compatibles (chooser nativo).
  const ua = navigator.userAgent || '';
  const isAndroid = /Android/i.test(ua);
  const isIOS = /iPhone|iPad|iPod/i.test(ua);

  if (isAndroid) {
    if (u.lat != null && u.lng != null) {
      const etiqueta = encodeURIComponent(`Pedido ${pedidoId}`);
      window.location.href = `geo:${u.lat},${u.lng}?q=${u.lat},${u.lng}(${etiqueta})`;
    } else {
      const destino = encodeURIComponent(u.direccion || '');
      window.location.href = `geo:0,0?q=${destino}`;
    }
    return;
  }

  // En iOS no existe un "chooser" universal consistente; usamos enlace web (puede sugerir abrir en app).
  if (isIOS) {
    if (u.lat != null && u.lng != null) {
      window.location.href = `https://www.google.com/maps/dir/?api=1&destination=${u.lat},${u.lng}&travelmode=driving`;
    } else {
      const destino = encodeURIComponent(u.direccion || '');
      window.location.href = `https://www.google.com/maps/dir/?api=1&destination=${destino}&travelmode=driving`;
    }
    return;
  }

  // Desktop fallback.
  if (u.lat != null && u.lng != null) {
    window.open(`https://www.google.com/maps/dir/?api=1&destination=${u.lat},${u.lng}&travelmode=driving`, '_blank');
  } else {
    const destino = encodeURIComponent(u.direccion || '');
    window.open(`https://www.google.com/maps/dir/?api=1&destination=${destino}&travelmode=driving`, '_blank');
  }
}

function enrutarConApps(index, pedidoId) {
  manejarNavegacionConNotificacion(index, pedidoId, 'apps');
}

function abrirNavegacion(tipo, index, pedidoId) {
  const { pedido, indexActual } = obtenerPedidoPorId(pedidoId);
  const indexFinal = indexActual >= 0 ? indexActual : index;
  const pedidoFinal = pedido || pedidos[indexFinal];
  if (!pedidoFinal) return;

  const u = getUbicacionPedido(indexFinal, pedidoId);
  if (!u) {
    mostrarToast('No hay ubicación disponible para este pedido.', 'warning');
    return;
  }

  if (tipo === 'apps') {
    abrirNavegacionConSelector(indexFinal, pedidoId);
    return;
  }

  marcarEnCurso(indexFinal);

  if (tipo === 'waze') {
    if (u.lat != null && u.lng != null) {
      window.open(`https://waze.com/ul?ll=${u.lat},${u.lng}&navigate=yes`, '_blank');
    } else {
      const q = encodeURIComponent(u.direccion);
      window.open(`https://waze.com/ul?q=${q}&navigate=yes`, '_blank');
    }
    return;
  }

  if (u.lat != null && u.lng != null) {
    window.open(`https://www.google.com/maps/dir/?api=1&destination=${u.lat},${u.lng}&travelmode=driving`, '_blank');
  } else {
    const destino = encodeURIComponent(u.direccion);
    window.open(`https://www.google.com/maps/dir/?api=1&destination=${destino}&travelmode=driving`, '_blank');
  }
}

function manejarNavegacionConNotificacion(index, pedidoId, tipoNavegacion) {
  const { pedido, indexActual } = obtenerPedidoPorId(pedidoId);
  const indexFinal = indexActual >= 0 ? indexActual : index;
  if (!pedido) return;

  if (pedido.notificadoEnCamino) {
    abrirNavegacion(tipoNavegacion, indexFinal, pedidoId);
    return;
  }

  mostrarModalDecision({
    titulo: 'Notificar al cliente',
    texto: `El pedido #${pedidoId} no ha sido notificado en camino.\n¿Quieres notificar al cliente antes de navegar?`,
    textoConfirmar: 'Si, notificar y navegar',
    claseConfirmar: 'btn-notify',
    textoSecundario: 'No, solo navegar',
    claseSecundario: 'btn-route',
    textoCancelar: 'Cancelar',
    onConfirmar: () => {
      notificarEnCamino(indexFinal, pedidoId, {
        onSuccess: () => abrirNavegacion(tipoNavegacion, indexFinal, pedidoId)
      });
    },
    onSecundario: () => abrirNavegacion(tipoNavegacion, indexFinal, pedidoId)
  });
}

function enrutarConMaps(index, pedidoId) {
  manejarNavegacionConNotificacion(index, pedidoId, 'maps');
}

function enrutarConWaze(index, pedidoId) {
  manejarNavegacionConNotificacion(index, pedidoId, 'waze');
}

function marcarLlegueDestino(index, pedidoId) {
  const { pedido, indexActual } = obtenerPedidoPorId(pedidoId);
  const indexFinal = indexActual >= 0 ? indexActual : index;
  const pedidoFinal = pedido || pedidos[indexFinal];
  if (!pedidoFinal || pedidoFinal.entregado || pedidoFinal.cancelado || !pedidoFinal.enCurso) return;
  pedidoFinal.llegoDestino = true;
  guardarPedidos();
  renderPedidos();
}

let finalizacionPendiente = { index: null, pedidoId: null };

function asegurarModalFinalizacionEntrega() {
  let modal = document.getElementById('modalFinalizacionEntrega');
  if (modal) return modal;

  modal = document.createElement('div');
  modal.id = 'modalFinalizacionEntrega';
  modal.className = 'modal-no-entregado-backdrop';
  modal.innerHTML = `
    <div class="modal-no-entregado-card">
      <h3>Finalizar entrega</h3>
      <p>Selecciona cómo quieres finalizar este pedido:</p>
      <div class="modal-no-entregado-actions">
        <button class="btn-camera" onclick="finalizarEntregaConResultado('foto_entrega')">Foto de entrega</button>
        <button class="btn-warning" onclick="finalizarEntregaConResultado('foto_no_entregado')">Foto no entregado</button>
        <button class="btn-info" onclick="finalizarEntregaConResultado('sin_foto')">Sin foto</button>
      </div>
      <button class="modal-no-entregado-close" onclick="cerrarModalFinalizacionEntrega()">Cerrar</button>
    </div>
  `;
  document.body.appendChild(modal);
  return modal;
}

function mostrarOpcionesFinalizarEntrega(index, pedidoId, opts = {}) {
  if (mensajeroPuedeModificarValorPedido() && !opts.yaConfirmoValor) {
    mostrarConfirmacionValorPedido(index, pedidoId);
    return;
  }
  finalizacionPendiente = { index, pedidoId };
  const modal = asegurarModalFinalizacionEntrega();
  modal.style.display = 'flex';
}

function mostrarConfirmacionValorPedido(index, pedidoId) {
  const { pedido, indexActual } = obtenerPedidoPorId(pedidoId);
  const indexFinal = indexActual >= 0 ? indexActual : index;
  const pedidoFinal = pedido || pedidos[indexFinal];
  if (!pedidoFinal) return;
  const valorNum = obtenerValorAReclamarPedido(pedidoFinal);
  const valorTxt = Number(valorNum || 0).toLocaleString('es-CO');
  mostrarModalDecision({
    titulo: 'Confirmar valor del pedido',
    texto: `Pedido #${pedidoFinal.id}\nValor a cobrar: $${valorTxt}\n\n¿El valor es correcto?`,
    textoConfirmar: 'Sí, es correcto',
    claseConfirmar: 'btn-success',
    textoSecundario: 'No, modificar',
    claseSecundario: 'btn-warning',
    mostrarSecundario: true,
    textoCancelar: 'Cancelar',
    onConfirmar: () => {
      if (!pedidoFinal.valorModificado) pedidoFinal.valorModificado = false;
      guardarPedidos();
      mostrarOpcionesFinalizarEntrega(indexFinal, pedidoFinal.id, { yaConfirmoValor: true });
    },
    onSecundario: () => {
      mostrarModalEditarValorMensajero(indexFinal, pedidoFinal.id);
    },
  });
}

function asegurarModalEditarValorMensajero() {
  let modal = document.getElementById('modalEditarValorMensajero');
  if (modal) return modal;
  modal = document.createElement('div');
  modal.id = 'modalEditarValorMensajero';
  modal.className = 'modal-no-entregado-backdrop';
  modal.innerHTML = `
    <div class="modal-no-entregado-card modal-editar-valor-mensajero-card">
      <h3>Modificar valor del pedido</h3>
      <p class="modal-editar-pedido-ayuda" id="modalEditarValorMensajeroAyuda">Indica el valor correcto a cobrar.</p>
      <label class="modal-editar-pedido-label" for="inputEditarValorMensajero">Nuevo valor</label>
      <input type="text" id="inputEditarValorMensajero" class="modal-editar-pedido-input" inputmode="numeric" autocomplete="off" placeholder="Ej: 120.000">
      <p id="modalEditarValorMensajeroError" class="auth-form-error" role="alert" style="display:none;"></p>
      <div class="modal-no-entregado-actions">
        <button type="button" class="btn-primary" id="btnGuardarValorMensajero">Guardar y continuar</button>
        <button type="button" class="btn-info" id="btnCancelarValorMensajero">Cancelar</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  const input = modal.querySelector('#inputEditarValorMensajero');
  if (input) {
    input.addEventListener('input', () => aplicarFormatoMilesEnInput(input));
  }
  modal.querySelector('#btnGuardarValorMensajero')?.addEventListener('click', () => {
    void confirmarEdicionValorMensajero();
  });
  modal.querySelector('#btnCancelarValorMensajero')?.addEventListener('click', () => {
    cerrarModalEditarValorMensajero();
  });
  modal.addEventListener('click', (e) => {
    if (e.target === modal) cerrarModalEditarValorMensajero();
  });
  return modal;
}

let edicionValorMensajeroPendiente = { index: null, pedidoId: null };

function cerrarModalEditarValorMensajero() {
  const modal = document.getElementById('modalEditarValorMensajero');
  if (modal) modal.style.display = 'none';
  edicionValorMensajeroPendiente = { index: null, pedidoId: null };
}

function mostrarModalEditarValorMensajero(index, pedidoId) {
  const { pedido, indexActual } = obtenerPedidoPorId(pedidoId);
  const indexFinal = indexActual >= 0 ? indexActual : index;
  const pedidoFinal = pedido || pedidos[indexFinal];
  if (!pedidoFinal) return;
  edicionValorMensajeroPendiente = { index: indexFinal, pedidoId: pedidoFinal.id };
  const modal = asegurarModalEditarValorMensajero();
  const ayuda = document.getElementById('modalEditarValorMensajeroAyuda');
  const input = document.getElementById('inputEditarValorMensajero');
  const err = document.getElementById('modalEditarValorMensajeroError');
  if (ayuda) {
    ayuda.textContent = `Pedido #${pedidoFinal.id}. Valor actual: $${Number(
      obtenerValorAReclamarPedido(pedidoFinal) || 0
    ).toLocaleString('es-CO')}.`;
  }
  if (err) {
    err.style.display = 'none';
    err.textContent = '';
  }
  if (input) {
    const digitos = String(pedidoFinal.valor || '').replace(/\D/g, '');
    input.value = digitos ? parseInt(digitos, 10).toLocaleString('es-CO') : '';
    setTimeout(() => input.focus(), 50);
  }
  modal.style.display = 'flex';
}

function confirmarEdicionValorMensajero() {
  const { index, pedidoId } = edicionValorMensajeroPendiente;
  const { pedido, indexActual } = obtenerPedidoPorId(pedidoId);
  const indexFinal = indexActual >= 0 ? indexActual : index;
  const pedidoFinal = pedido || pedidos[indexFinal];
  if (!pedidoFinal) {
    cerrarModalEditarValorMensajero();
    return;
  }
  const input = document.getElementById('inputEditarValorMensajero');
  const err = document.getElementById('modalEditarValorMensajeroError');
  const digitos = String(input?.value || '').replace(/\D/g, '');
  if (!digitos) {
    if (err) {
      err.textContent = 'Indica el valor correcto (solo números).';
      err.style.display = 'block';
    }
    return;
  }
  const valorAnteriorDigitos = String(pedidoFinal.valor || '').replace(/\D/g, '') || '0';
  if (pedidoFinal.valorOriginal == null || String(pedidoFinal.valorOriginal).trim() === '') {
    pedidoFinal.valorOriginal = valorAnteriorDigitos;
  }
  pedidoFinal.valor = digitos;
  const originalDigitos = String(pedidoFinal.valorOriginal || '').replace(/\D/g, '') || '0';
  pedidoFinal.valorModificado = originalDigitos !== digitos;
  guardarPedidos();
  cerrarModalEditarValorMensajero();
  mostrarToast(
    pedidoFinal.valorModificado
      ? `Valor actualizado a $${parseInt(digitos, 10).toLocaleString('es-CO')}`
      : 'El valor quedó igual al original',
    'success'
  );
  mostrarOpcionesFinalizarEntrega(indexFinal, pedidoFinal.id, { yaConfirmoValor: true });
}

function cerrarModalFinalizacionEntrega() {
  const modal = document.getElementById('modalFinalizacionEntrega');
  if (!modal) return;
  modal.style.display = 'none';
}

function obtenerSiguientePedidoActivo(excluirPedidoId) {
  return pedidos.find(p => !p.cancelado && !p.entregado && p.id !== excluirPedidoId) || null;
}

function notificarSiguientePedido(excluirPedidoId) {
  const siguiente = obtenerSiguientePedidoActivo(excluirPedidoId);
  if (!siguiente) return;
  const indexSiguiente = pedidos.findIndex(p => p.id === siguiente.id);
  if (indexSiguiente < 0) return;

  mostrarModalDecision({
    titulo: 'Siguiente entrega',
    texto: `Tu siguiente pedido a entregar es el ${siguiente.id}.`,
    textoConfirmar: 'Notificar al cliente',
    claseConfirmar: 'btn-notify',
    mostrarSecundario: false,
    textoCancelar: 'Cerrar',
    onConfirmar: () => notificarEnCamino(indexSiguiente, siguiente.id, {
      onSuccess: () => {
        mostrarModalDecision({
          titulo: 'Pedido notificado',
          texto: `El pedido #${siguiente.id} fue notificado.\n¿Quieres enrutar ahora?`,
          textoConfirmar: 'Enrutar',
          claseConfirmar: 'btn-route',
          mostrarSecundario: false,
          textoCancelar: 'Cerrar',
          onConfirmar: () => enrutarConApps(indexSiguiente, siguiente.id),
          onCancelar: () => {}
        });
      }
    }),
    onCancelar: () => {}
  });
}

function finalizarEntregaConResultado(tipoFinalizacion) {
  const { index, pedidoId } = finalizacionPendiente;
  cerrarModalFinalizacionEntrega();
  const { pedido, indexActual } = obtenerPedidoPorId(pedidoId);
  const indexFinal = indexActual >= 0 ? indexActual : index;
  const pedidoFinal = pedido || pedidos[indexFinal];
  if (!pedidoFinal) return;

  if (tipoFinalizacion === 'foto_entrega') {
    fotoEntregado(indexFinal, pedidoId);
    return;
  }

  if (tipoFinalizacion === 'sin_foto') {
    pagoEntregadoPendiente = {
      index: indexFinal,
      pedidoId,
      enviarWhatsAppAdmin: false,
      lugarEntrega: null,
      recibidoPor: '',
      datosPagoPendientes: null,
      cambioMetodo: '',
    };
    const modalPago = asegurarModalPagoEntregado();
    mostrarPasoModalPagoEntregado('lugar');
    modalPago.style.display = 'flex';
    return;
  }

  if (tipoFinalizacion === 'foto_no_entregado') {
    noEntregadoPendiente = { index: indexFinal, pedidoId };
    mostrarOpcionesNoEntregado(indexFinal, pedidoId);
    return;
  }
}

// --- Notificar en camino ---

function abrirWhatsAppNotificarEnCamino(tel, mensaje) {
  const limpio = String(tel || '').replace(/\D/g, '');
  if (!limpio) return;
  const wa = limpio.startsWith('57') ? limpio : `57${limpio}`;
  abrirWhatsAppConTexto(wa, mensaje);
}

function mostrarModalEnrutarTrasNotificacion(indexFinal, pedidoId, opciones) {
  if (!opciones.abrirEnrutarDespues) return;
  mostrarModalDecision({
    titulo: 'Enrutar ahora',
    texto: `Pedido #${pedidoId} notificado.\n¿Quieres enrutar ahora?`,
    textoConfirmar: 'Enrutar',
    claseConfirmar: 'btn-route',
    mostrarSecundario: false,
    textoCancelar: 'Cerrar',
    onConfirmar: () => enrutarConApps(indexFinal, pedidoId),
    onCancelar: () => {}
  });
}

function finalizarFlujoNotificacionEnCamino(indexFinal, pedidoId, pedidoFinal, opciones) {
  completarNotificacionEnCaminoPedido(pedidoFinal);
  guardarPedidos();
  renderPedidos();
  if (typeof opciones.onSuccess === 'function') opciones.onSuccess();
  mostrarModalEnrutarTrasNotificacion(indexFinal, pedidoId, opciones);
}

function ofrecerNotificarSegundoTelefono(indexFinal, pedidoId, pedidoFinal, opciones, mensaje) {
  const pendientes = obtenerTelefonosPendientesNotificacionEnCamino(pedidoFinal);
  if (!pendientes.length) {
    finalizarFlujoNotificacionEnCamino(indexFinal, pedidoId, pedidoFinal, opciones);
    return;
  }
  const otro = pendientes[0];
  mostrarModalDecision({
    titulo: 'Notificar al segundo número',
    texto: `Ya notificaste un número del pedido #${pedidoId}.\n¿Quieres notificar también al ${otro}?`,
    textoConfirmar: 'Sí, notificar',
    claseConfirmar: 'btn-notify',
    textoSecundario: 'No, continuar',
    claseSecundario: 'btn-info',
    mostrarCancelar: false,
    onConfirmar: () => {
      abrirWhatsAppNotificarEnCamino(otro, mensaje);
      registrarTelefonoNotificadoEnCamino(pedidoFinal, otro);
      guardarPedidos();
      renderPedidos();
      finalizarFlujoNotificacionEnCamino(indexFinal, pedidoId, pedidoFinal, opciones);
    },
    onSecundario: () => finalizarFlujoNotificacionEnCamino(indexFinal, pedidoId, pedidoFinal, opciones),
    onCancelar: () => {}
  });
}

function continuarFlujoNotificacionEnCaminoTrasUno(indexFinal, pedidoId, pedidoFinal, opciones, mensaje) {
  const todos = obtenerTelefonosPedido(pedidoFinal);
  if (todos.length > 1 && obtenerTelefonosPendientesNotificacionEnCamino(pedidoFinal).length > 0) {
    ofrecerNotificarSegundoTelefono(indexFinal, pedidoId, pedidoFinal, opciones, mensaje);
    return;
  }
  finalizarFlujoNotificacionEnCamino(indexFinal, pedidoId, pedidoFinal, opciones);
}

function ejecutarNotificacionEnCaminoParcial(indexFinal, pedidoId, pedidoFinal, opciones, mensaje) {
  const pendientes = obtenerTelefonosPendientesNotificacionEnCamino(pedidoFinal);
  if (!pendientes.length) {
    finalizarFlujoNotificacionEnCamino(indexFinal, pedidoId, pedidoFinal, opciones);
    return;
  }
  if (pendientes.length === 1) {
    const otro = pendientes[0];
    mostrarModalDecision({
      titulo: 'Notificar al segundo número',
      texto: `Falta notificar al ${otro} del pedido #${pedidoId}.\n¿Quieres notificar ahora?`,
      textoConfirmar: 'Sí, notificar',
      claseConfirmar: 'btn-notify',
      textoSecundario: 'No, continuar',
      claseSecundario: 'btn-info',
      mostrarCancelar: false,
      onConfirmar: () => {
        abrirWhatsAppNotificarEnCamino(otro, mensaje);
        registrarTelefonoNotificadoEnCamino(pedidoFinal, otro);
        guardarPedidos();
        renderPedidos();
        finalizarFlujoNotificacionEnCamino(indexFinal, pedidoId, pedidoFinal, opciones);
      },
      onSecundario: () => finalizarFlujoNotificacionEnCamino(indexFinal, pedidoId, pedidoFinal, opciones),
      onCancelar: () => {}
    });
    return;
  }
  seleccionarTelefonoConModal(pendientes, 'Notificación', (telElegido) => {
    abrirWhatsAppNotificarEnCamino(telElegido, mensaje);
    registrarTelefonoNotificadoEnCamino(pedidoFinal, telElegido);
    guardarPedidos();
    renderPedidos();
    continuarFlujoNotificacionEnCaminoTrasUno(indexFinal, pedidoId, pedidoFinal, opciones, mensaje);
  });
}

function minutosDelDiaRelojLocal() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

/** Saludo según la hora del dispositivo (zona local). */
function saludoPorHoraDispositivo() {
  const h = new Date().getHours();
  if (h >= 5 && h < 12) return 'Buenos días';
  if (h >= 12 && h < 19) return 'Buenas tardes';
  return 'Buenas noches';
}

/** Desde las 17:55 (hora local): se añade disculpa por demora (tráfico / clima). */
function debeIncluirDisculpaDemoraNotificacionEnCamino() {
  return minutosDelDiaRelojLocal() >= 17 * 60 + 55;
}

function construirMensajeNotificarEnCamino(pedido) {
  const nombre = String(pedido?.nombre || '').trim() || 'cliente';
  const saludo = saludoPorHoraDispositivo();
  const conDisculpa = debeIncluirDisculpaDemoraNotificacionEnCamino();
  const monto = montoACobrarParaNotificacionEnCamino(pedido);
  const esCambio = pedidoEsCambioParaNotificacion(pedido);
  const incluirMediosPago = !esCambio && monto > 0;
  const bloquePago = incluirMediosPago ? construirBloquePagoNotificacion() : '';

  const anuncioCamino = conDisculpa
    ? `Soy el mensajero externo de Valero Storee. Te pido disculpas por la demora: por clima o por tráfico los pedidos se han demorado. Te confirmo que ya *VOY EN CAMINO* hacia tu ubicación de entrega y que *aún no he llegado*.`
    : `Te confirmo que ya *VOY EN CAMINO* hacia tu ubicación de entrega y que *aún no he llegado*.`;

  const consideraciones = [
    'Estate pendiente del celular: te llamaré por WhatsApp para notificarte mi llegada al punto.',
  ];
  if (esCambio) {
    consideraciones.push('Ten el pedido listo para el cambio.');
  } else if (monto > 0) {
    consideraciones.push(
      `Ten el dinero en mano: $${monto.toLocaleString('es-CO')}.`
    );
  }
  consideraciones.push(
    'Mi tiempo de espera es de *10 minutos* desde la primera llamada realizada por WhatsApp.'
  );

  const cierreCamino =
    'Te recuerdo que *VOY EN CAMINO* hacia tu ubicación de entrega y que *aún no he llegado*.';

  const partes = [
    `${saludo}, ${nombre}`,
    '',
    anuncioCamino,
    '',
    'Por favor ten en cuenta:',
    consideraciones.map((l) => `- ${l}`).join('\n'),
  ];
  if (bloquePago) {
    partes.push('', bloquePago);
  }
  partes.push('', cierreCamino, '', `Gracias por tu compra, ${nombre}.`);
  return partes.join('\n');
}

async function notificarEnCamino(index, pedidoId, opciones = {}) {
  const { pedido, indexActual } = obtenerPedidoPorId(pedidoId);
  const indexFinal = indexActual >= 0 ? indexActual : index;
  const pedidoFinal = pedido || pedidos[indexFinal];
  if (!pedidoFinal) return;

  if (opciones.forzarReenvio) {
    limpiarNotificacionEnCaminoPedido(pedidoFinal);
  }

  if (pedidoFinal.notificadoEnCamino && !opciones.forzarReenvio) {
    mostrarModalDecision({
      titulo: 'Pedido ya notificado',
      texto: `El pedido #${pedidoId} ya fue notificado.\n¿Volver a notificar?`,
      textoConfirmar: 'Volver a notificar',
      claseConfirmar: 'btn-notify',
      mostrarSecundario: false,
      textoCancelar: 'Cerrar',
      onConfirmar: () => notificarEnCamino(indexFinal, pedidoId, { ...opciones, forzarReenvio: true }),
      onSecundario: () => {}
    });
    return;
  }

  const tels = obtenerTelefonosPedido(pedidoFinal);
  if (!tels.length) { mostrarAvisoEnApp('No hay número de teléfono del cliente disponible', 'Notificación'); return; }

  await refrescarPaymentConfigDesdeServidor();
  const requiereMediosPago = montoACobrarParaNotificacionEnCamino(pedidoFinal) > 0;
  if (requiereMediosPago && !mediosPagoNotificacionListos(paymentConfigEstado.effective)) {
    abrirConfigNotificacionParaNotificar(indexFinal, pedidoId, opciones);
    return;
  }

  const mensaje = construirMensajeNotificarEnCamino(pedidoFinal);

  if (tieneNotificacionEnCaminoParcial(pedidoFinal)) {
    ejecutarNotificacionEnCaminoParcial(indexFinal, pedidoId, pedidoFinal, opciones, mensaje);
    return;
  }

  seleccionarTelefonoConModal(tels, 'Notificación', (telElegido) => {
    abrirWhatsAppNotificarEnCamino(telElegido, mensaje);
    registrarTelefonoNotificadoEnCamino(pedidoFinal, telElegido);
    guardarPedidos();
    renderPedidos();
    continuarFlujoNotificacionEnCaminoTrasUno(indexFinal, pedidoId, pedidoFinal, opciones, mensaje);
  });
}

// --- Mapa: marcadores y ruta ---

/** Umbral para avisar de pedidos con la misma zona / muy cercanos (metros). */
const UMBRAL_M_AVISO_UBICACION_DUPLICADA = 45;
/** Umbral para separar visualmente dos pines que quedarían encima (metros). */
const UMBRAL_M_SEPARAR_PINES_MAPA = 38;
/** Radio del círculo al separar pines superpuestos (metros). */
const RADIO_SEPARACION_PIN_METROS = 24;

function distanciaMetrosEntreCoords(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const t1 = (lat1 * Math.PI) / 180;
  const t2 = (lat2 * Math.PI) / 180;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(t1) * Math.cos(t2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function htmlPopupPedidoMapa(pedidoId, productos) {
  const lista = htmlProductosArrayMultilinea(productos);
  return (
    '<div style="padding:5px;min-width:200px;">' +
    `<h3 style="margin:0 0 10px 0;color:#4CAF50;font-size:16px;">Pedido #${pedidoId}</h3>` +
    `<p style="margin:5px 0;"><strong>Productos:</strong><br>${lista}</p>` +
    '</div>'
  );
}

function generarMensajeUbicacionesMuyCercanas() {
  const activos = pedidos.filter(
    (p) => !p.cancelado && p.coords && Number.isFinite(p.coords.lat) && Number.isFinite(p.coords.lng)
  );
  const pares = [];
  const visto = new Set();
  for (let i = 0; i < activos.length; i++) {
    for (let j = i + 1; j < activos.length; j++) {
      const a = activos[i];
      const b = activos[j];
      const d = distanciaMetrosEntreCoords(a.coords.lat, a.coords.lng, b.coords.lat, b.coords.lng);
      if (d <= UMBRAL_M_AVISO_UBICACION_DUPLICADA) {
        const key = a.id < b.id ? `${a.id}:${b.id}` : `${b.id}:${a.id}`;
        if (!visto.has(key)) {
          visto.add(key);
          pares.push({ a: a.id, b: b.id, d });
        }
      }
    }
  }
  if (pares.length === 0) return '';
  let msg =
    'Varios pedidos comparten ubicación o están muy cerca (menos de ~' +
    UMBRAL_M_AVISO_UBICACION_DUPLICADA +
    ' m). En el mapa los pines se muestran ligeramente separados para distinguirlos; la ruta sigue usando las coordenadas reales de cada pedido.\n\n';
  msg += pares.map((p) => `• Pedidos #${p.a} y #${p.b} (~${Math.round(p.d)} m)`).join('\n');
  return msg;
}

/**
 * Si dos marcadores quedan casi en el mismo punto, los reparte en círculo (solo posición visual).
 * latReal/lngReal conservan las coordenadas reales del pedido.
 */
function aplicarSeparacionVisualMarcadores() {
  if (!mapa || marcadores.length < 2) return;
  const n = marcadores.length;
  const datos = marcadores.map((item) => {
    const lat = item.latReal != null ? item.latReal : item.marker.getLatLng().lat;
    const lng = item.lngReal != null ? item.lngReal : item.marker.getLatLng().lng;
    return { item, lat, lng };
  });
  const parent = datos.map((_, i) => i);
  function find(i) {
    return parent[i] === i ? i : (parent[i] = find(parent[i]));
  }
  function union(i, j) {
    i = find(i);
    j = find(j);
    if (i !== j) parent[j] = i;
  }
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (
        distanciaMetrosEntreCoords(datos[i].lat, datos[i].lng, datos[j].lat, datos[j].lng) <=
        UMBRAL_M_SEPARAR_PINES_MAPA
      ) {
        union(i, j);
      }
    }
  }
  const grupos = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!grupos.has(r)) grupos.set(r, []);
    grupos.get(r).push(i);
  }
  const radBase = RADIO_SEPARACION_PIN_METROS / 111320;
  grupos.forEach((indices) => {
    if (indices.length < 2) return;
    const centroLat = indices.reduce((s, idx) => s + datos[idx].lat, 0) / indices.length;
    const centroLng = indices.reduce((s, idx) => s + datos[idx].lng, 0) / indices.length;
    const radLat = radBase * (indices.length > 4 ? 1.35 : 1);
    indices.forEach((idx, k) => {
      const ang = (2 * Math.PI * k) / indices.length;
      const dLat = radLat * Math.cos(ang);
      const dLng = (radLat * Math.sin(ang)) / Math.cos((centroLat * Math.PI) / 180);
      const newLat = centroLat + dLat;
      const newLng = centroLng + dLng;
      const { item } = datos[idx];
      const pedidoId = item.pedidoId;
      const p = pedidos.find((x) => Number(x.id) === Number(pedidoId));
      const prods = p?.productos || [];
      mapa.removeLayer(item.marker);
      const estadoVisual = obtenerEstadoVisualPedido(Number(pedidoId));
      const marker = L.marker([newLat, newLng], {
        icon: crearIconoMarcador(Number(pedidoId), estadoVisual),
      }).addTo(mapa);
      marker.bindPopup(htmlPopupPedidoMapa(pedidoId, prods));
      const ix = marcadores.findIndex((m) => Number(m.pedidoId) === Number(pedidoId));
      if (ix >= 0) {
        marcadores[ix] = {
          pedidoId,
          marker,
          latReal: datos[idx].lat,
          lngReal: datos[idx].lng,
        };
      }
    });
  });
}

function actualizarMarcadores() {
  if (!mapa) return;
  mapaAjustado = false;
  marcadores.forEach(item => mapa.removeLayer(item.marker));
  marcadores = [];
  if (rutaLayer) { mapa.removeLayer(rutaLayer); rutaLayer = null; }
  if (pedidos.length === 0) return;

  let completados = 0;
  let huboSincCoordsDesdeUrl = false;
  const conUbicacion = pedidos.filter(p => !p.cancelado && (p.coords || p.mapUrl || p.direccion));
  const total = conUbicacion.length;
  if (total === 0) return;

  conUbicacion.forEach((pedido) => {
    const id = pedido.id;
    const url = pedido.mapUrl;
    const dir = pedido.direccion;
    const prods = pedido.productos;
    const cb = () => {
      completados++;
      if (completados === total) {
        setTimeout(() => {
          if (!mapa) return;
          aplicarSeparacionVisualMarcadores();
          mapa.invalidateSize();
          ajustarVistaMapa();
          dibujarRutaEntreMarcadores();
          const aviso = generarMensajeUbicacionesMuyCercanas();
          if (aviso) {
            if (aviso !== firmaUltimoAvisoUbicacionesCercanas) {
              firmaUltimoAvisoUbicacionesCercanas = aviso;
              setTimeout(() => mostrarToast(aviso, 'warning', 10000), 200);
            }
          } else {
            firmaUltimoAvisoUbicacionesCercanas = '';
          }
          if (huboSincCoordsDesdeUrl) guardarPedidos();
        }, 100);
      }
    };

    // Si la URL trae coordenadas, mandan sobre coords guardadas (evita pin viejo al editar el enlace).
    if (url) {
      const coordsDeUrl = extraerCoordenadas(url);
      if (coordsDeUrl) {
        const prev = pedido.coords;
        if (
          !prev ||
          Math.abs(prev.lat - coordsDeUrl.lat) > 1e-7 ||
          Math.abs(prev.lng - coordsDeUrl.lng) > 1e-7
        ) {
          huboSincCoordsDesdeUrl = true;
        }
        pedido.coords = { lat: coordsDeUrl.lat, lng: coordsDeUrl.lng };
        procesarURLMapaPedido(url, id, prods, cb);
        return;
      }
      procesarURLMapaPedido(url, id, prods, (coords) => {
        if (coords) {
          pedido.coords = { lat: coords.lat, lng: coords.lng };
          pedido.mapUrl = `https://www.google.com/maps?q=${coords.lat},${coords.lng}`;
          huboSincCoordsDesdeUrl = true;
          guardarPedidos();
        }
        cb();
      });
      return;
    }

    if (pedido.coords && Number.isFinite(pedido.coords.lat) && Number.isFinite(pedido.coords.lng)) {
      procesarURLMapaPedido(
        `https://www.google.com/maps?q=${pedido.coords.lat},${pedido.coords.lng}`,
        id,
        prods,
        cb
      );
      return;
    }

    if (dir) {
      geocodificarDireccion(dir, id, prods, (coords) => {
        if (coords) {
          pedido.coords = { lat: coords.lat, lng: coords.lng };
          pedido.mapUrl = `https://www.google.com/maps?q=${coords.lat},${coords.lng}`;
          guardarPedidos();
        }
        cb();
      });
      return;
    }

    cb();
  });
}

function obtenerEstadoVisualPedido(pedidoId) {
  const idNum = Number(pedidoId);
  const pedido = pedidos.find((p) => Number(p.id) === idNum);
  if (!pedido) return 'pendiente';
  if (pedido.entregado) return 'entregado';
  if (pedido.enCurso) return 'enCurso';
  return 'pendiente';
}

function crearIconoMarcador(numPedido, estado = 'pendiente') {
  const colores = {
    pendiente: { fondo: '#2563eb', texto: '#ffffff' },
    enCurso: { fondo: '#16a34a', texto: '#ffffff' },
    entregado: { fondo: '#6b7280', texto: '#ffffff' }
  };
  const estilo = colores[estado] || colores.pendiente;
  const html = `
    <div style="background-color:${estilo.fondo};color:${estilo.texto};width:35px;height:35px;
                border-radius:50%;display:flex;align-items:center;justify-content:center;
                font-weight:bold;font-size:14px;border:3px solid white;box-shadow:0 2px 5px rgba(0,0,0,0.3);">
      #${numPedido}
    </div>`;
  return L.divIcon({ html, className: 'custom-marker', iconSize: [35, 35], iconAnchor: [17, 17] });
}

function geocodificarDireccion(direccion, pedidoId, productos, callback) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(direccion)}&limit=1`;
  fetch(url, { headers: { 'User-Agent': 'DeliveryApp/1.0' } })
    .then(r => r.json())
    .then(data => {
      if (data && data.length > 0) {
        const lat = parseFloat(data[0].lat);
        const lng = parseFloat(data[0].lon);
        const estadoVisual = obtenerEstadoVisualPedido(Number(pedidoId));
        const marker = L.marker([lat, lng], { icon: crearIconoMarcador(Number(pedidoId), estadoVisual) }).addTo(mapa);
        marker.bindPopup(
          '<div style="padding:5px;min-width:200px;">' +
            `<h3 style="margin:0 0 10px 0;color:#4CAF50;font-size:16px;">Pedido #${pedidoId}</h3>` +
            `<p style="margin:5px 0;"><strong>Dirección:</strong> ${direccion}</p>` +
            `<p style="margin:5px 0;"><strong>Productos:</strong><br>${htmlProductosArrayMultilinea(productos)}</p>` +
            '</div>'
        );
        if (pedidoId !== 'TEMP') marcadores.push({ pedidoId, marker, latReal: lat, lngReal: lng });
        if (callback) callback({ lat, lng });
        return;
      }
      if (callback) callback(null);
    })
    .catch(() => { if (callback) callback(null); });
}

function ajustarVistaMapa() {
  if (mapaAjustado || marcadores.length === 0) return;
  const group = new L.featureGroup(marcadores.map(item => item.marker));
  mapa.fitBounds(group.getBounds().pad(0.1));
  if (marcadores.length === 1) mapa.setZoom(15);
  mapaAjustado = true;
}

function dibujarRutaEntreMarcadores() {
  if (!mapa || marcadores.length < 2) return;
  if (rutaLayer) { mapa.removeLayer(rutaLayer); rutaLayer = null; }

  const asegurarEstadoRuta = () => {
    const mapaEl = document.getElementById('mapa');
    if (!mapaEl) return null;
    let el = document.getElementById('estadoRutaMapa');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'estadoRutaMapa';
    el.className = 'estado-ruta-mapa';
    mapaEl.appendChild(el);
    return el;
  };
  const setEstadoRuta = (msg) => {
    const el = asegurarEstadoRuta();
    if (!el) return;
    if (!msg) { el.style.display = 'none'; el.textContent = ''; return; }
    el.textContent = msg;
    el.style.display = 'block';
  };

  const coordenadas = [];
  for (const p of pedidos) {
    if (p.cancelado) continue;
    let lat = null;
    let lng = null;
    if (p.coords && Number.isFinite(p.coords.lat) && Number.isFinite(p.coords.lng)) {
      lat = p.coords.lat;
      lng = p.coords.lng;
    } else {
      const item = marcadores.find(m => Number(m.pedidoId) === Number(p.id));
      if (item && item.latReal != null && item.lngReal != null) {
        lat = item.latReal;
        lng = item.lngReal;
      } else if (item && item.marker) {
        const ll = item.marker.getLatLng();
        lat = ll.lat;
        lng = ll.lng;
      }
    }
    if (lat != null && lng != null) coordenadas.push([lng, lat]);
  }
  if (coordenadas.length < 2) return;
  setEstadoRuta('Calculando ruta por calles…');

  // Cancelar cálculo anterior si el usuario reordena rápido.
  try { if (rutaAbortController) rutaAbortController.abort(); } catch (_e) {}
  rutaAbortController = new AbortController();
  const { signal } = rutaAbortController;

  // Pedir la ruta: primero intentamos una sola llamada con todos los puntos (más rápido).
  // Si falla, caemos a bloques (en paralelo) y unimos geometría.
  const fetchBloqueOsrm = async (coordsBloque) => {
    const coordsStr = coordsBloque.map((c) => `${c[0]},${c[1]}`).join(';');
    const resp = await fetch(
      `https://router.project-osrm.org/route/v1/driving/${coordsStr}?overview=full&geometries=geojson`,
      { signal }
    );
    const data = await resp.json();
    if (data.code !== 'Ok' || !data.routes?.[0]?.geometry?.coordinates) return null;
    return data.routes[0].geometry.coordinates; // [lng,lat][]
  };

  (async () => {
    try {
      const coordsRuta = [];
      const geomAll = await fetchBloqueOsrm(coordenadas);
      if (geomAll && geomAll.length >= 2) {
        coordsRuta.push(...geomAll);
      } else {
        const MAX_PUNTOS_POR_BLOQUE = 10;
        const bloques = [];
        for (let start = 0; start < coordenadas.length; start += (MAX_PUNTOS_POR_BLOQUE - 1)) {
          const bloque = coordenadas.slice(start, Math.min(start + MAX_PUNTOS_POR_BLOQUE, coordenadas.length));
          if (bloque.length >= 2) bloques.push({ start, bloque });
        }
        const resultados = await Promise.all(
          bloques.map(async (b) => ({ start: b.start, geom: await fetchBloqueOsrm(b.bloque) }))
        );
        resultados.sort((a, b) => a.start - b.start);
        for (const r of resultados) {
          if (!r.geom || r.geom.length < 2) {
            setEstadoRuta('No se pudo calcular la ruta por calles (OSRM). Reintenta o revisa conexión.');
            return;
          }
          let tramoGeom = r.geom;
          if (coordsRuta.length > 0 && tramoGeom.length > 0) tramoGeom = tramoGeom.slice(1);
          coordsRuta.push(...tramoGeom);
        }
      }
      if (coordsRuta.length < 2) {
        setEstadoRuta('No se pudo calcular la ruta por calles.');
        return;
      }
      const latlngs = coordsRuta.map((c) => [c[1], c[0]]);
      rutaLayer = L.polyline(latlngs, { color: '#2196F3', weight: 5, opacity: 0.7 }).addTo(mapa);
      setEstadoRuta('');
      rutaAbortController = null;
    } catch (_e) {
      if (_e && (_e.name === 'AbortError' || String(_e).includes('AbortError'))) return;
      setEstadoRuta('No se pudo calcular la ruta por calles. Reintenta.');
    }
  })();
}

function redibujarRutaDebounced(ms = 250) {
  try { if (rutaRedrawTimer) clearTimeout(rutaRedrawTimer); } catch (_e) {}
  rutaRedrawTimer = setTimeout(() => {
    rutaRedrawTimer = null;
    dibujarRutaEntreMarcadores();
  }, ms);
}

/** Fragmento numérico para lat/lng en URLs de Maps (acepta 4, 4.6 y -74.07). */
const _RE_COORD_MAPS = '-?\\d+(?:\\.\\d+)?';

function extraerCoordenadas(url) {
  const limpia = url.replace(/\s+/g, '').replace(/%2C/gi, ',').replace(/%40/gi, '@');
  let decoded;
  try { decoded = decodeURIComponent(limpia); } catch (e) { decoded = limpia; }

  const patronesLatLng = [
    new RegExp(`!3d(${_RE_COORD_MAPS})!4d(${_RE_COORD_MAPS})`),
    new RegExp(`@(${_RE_COORD_MAPS}),(${_RE_COORD_MAPS})`),
    new RegExp(`[?&]q=(${_RE_COORD_MAPS}),(${_RE_COORD_MAPS})`),
    new RegExp(`query=(${_RE_COORD_MAPS}),(${_RE_COORD_MAPS})`),
    new RegExp(`[?&]coordinate=(${_RE_COORD_MAPS}),(${_RE_COORD_MAPS})`),
    new RegExp(`[?&]ll=(${_RE_COORD_MAPS}),(${_RE_COORD_MAPS})`),
    new RegExp(`place/[^@]*@(${_RE_COORD_MAPS}),(${_RE_COORD_MAPS})`),
    new RegExp(`[?&]sll=(${_RE_COORD_MAPS}),(${_RE_COORD_MAPS})`),
    new RegExp(`center=(${_RE_COORD_MAPS}),(${_RE_COORD_MAPS})`),
  ];
  /** En muchas URLs compactas Google usa !2d=lng y !3d=lat (orden inverso al bloque !3d/!4d). */
  const patronLngLat = new RegExp(`!2d(${_RE_COORD_MAPS})!3d(${_RE_COORD_MAPS})`);

  for (const texto of [decoded, limpia, url]) {
    for (const p of patronesLatLng) {
      const m = texto.match(p);
      if (m) {
        const lat = parseFloat(m[1]);
        const lng = parseFloat(m[2]);
        if (!isNaN(lat) && !isNaN(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
          return { lat, lng };
        }
      }
    }
    const mSwap = texto.match(patronLngLat);
    if (mSwap) {
      const lng = parseFloat(mSwap[1]);
      const lat = parseFloat(mSwap[2]);
      if (!isNaN(lat) && !isNaN(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
        return { lat, lng };
      }
    }
  }
  return null;
}

function procesarURLMapaPedido(url, pedidoId, productos, callback) {
  if (!mapa) { if (callback) callback(); return; }

  const coords = extraerCoordenadas(url);
  if (!coords) {
    geocodificarDireccion(url, pedidoId, productos || [], callback);
    return;
  }

  const { lat, lng } = coords;
  if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    mostrarToast(`No se pudieron extraer coordenadas válidas de la URL para el pedido #${pedidoId}.`, 'error', 8000);
    if (callback) callback();
    return;
  }

  try {
    const estadoVisual = obtenerEstadoVisualPedido(Number(pedidoId));
    const marker = L.marker([lat, lng], { icon: crearIconoMarcador(Number(pedidoId), estadoVisual) }).addTo(mapa);
    marker.bindPopup(htmlPopupPedidoMapa(pedidoId, productos));
    marcadores.push({ pedidoId, marker, latReal: lat, lngReal: lng });
    if (callback) callback({ lat, lng });
  } catch (error) {
    mostrarToast(`Error al agregar marcador para el pedido #${pedidoId}: ${error.message}`, 'error', 8000);
    if (callback) callback(null);
  }
}

// --- Inicialización ---

function normalizarPedidoEnMemoria(p) {
  if (!p.hasOwnProperty('assignedTo') || p.assignedTo == null || String(p.assignedTo).trim() === '') {
    p.assignedTo = null;
  } else {
    p.assignedTo = normalizarUuidAsignacion(p.assignedTo);
  }
  if (!p.hasOwnProperty('createdBy')) p.createdBy = null;
  if (!Array.isArray(p.productos)) p.productos = [];
  if (!p.hasOwnProperty('mapUrl')) p.mapUrl = '';
  if (!p.hasOwnProperty('coords') || !p.coords) p.coords = null;
  if (!p.hasOwnProperty('enCurso')) p.enCurso = false;
  if (!p.hasOwnProperty('haSidoEnrutado')) p.haSidoEnrutado = false;
  if (!p.hasOwnProperty('posicionPendiente')) p.posicionPendiente = null;
  if (!p.hasOwnProperty('entregado')) p.entregado = false;
  if (!p.hasOwnProperty('noEntregado')) p.noEntregado = false;
  if (!p.hasOwnProperty('envioRecogido')) p.envioRecogido = false;
  if (!p.hasOwnProperty('notificadoEnCamino')) p.notificadoEnCamino = false;
  if (!p.hasOwnProperty('cancelado')) p.cancelado = false;
  if (!p.hasOwnProperty('llegoDestino')) p.llegoDestino = false;
  if (!p.hasOwnProperty('metodoPagoEntrega')) p.metodoPagoEntrega = '';
  if (!p.hasOwnProperty('montoNequi')) p.montoNequi = 0;
  if (!p.hasOwnProperty('montoDaviplata')) p.montoDaviplata = 0;
  if (!p.hasOwnProperty('montoEfectivo')) p.montoEfectivo = 0;
  if (!p.hasOwnProperty('lugarEntregaFinal')) p.lugarEntregaFinal = 'cliente';
  if (!p.hasOwnProperty('porteriaRecibidoPor')) p.porteriaRecibidoPor = '';
  if (!p.hasOwnProperty('mensajeEntregaPorteria')) p.mensajeEntregaPorteria = '';
  if (!p.hasOwnProperty('pendienteNotificarClientePorteria')) p.pendienteNotificarClientePorteria = false;
  if (!p.hasOwnProperty('clienteNotificadoPorteria')) p.clienteNotificadoPorteria = false;
  if (!p.hasOwnProperty('motivoNoEntregado')) p.motivoNoEntregado = '';
  if (!p.hasOwnProperty('mensajeNoEntregadoTienda')) p.mensajeNoEntregadoTienda = '';
  if (!p.hasOwnProperty('pendienteNotificarClienteNoEntregado')) p.pendienteNotificarClienteNoEntregado = false;
  if (!p.hasOwnProperty('clienteNotificadoNoEntregado')) p.clienteNotificadoNoEntregado = false;
  if (!p.hasOwnProperty('valorOriginal')) p.valorOriginal = null;
  if (!p.hasOwnProperty('valorModificado')) p.valorModificado = false;
  if (!p.hasOwnProperty('dioCambio')) p.dioCambio = false;
  if (!p.hasOwnProperty('cambioMetodo')) p.cambioMetodo = '';
  if (!p.hasOwnProperty('montoCambio')) p.montoCambio = 0;
  if (!p.hasOwnProperty('ajusteVueltasDigitales')) p.ajusteVueltasDigitales = false;
  if (!p.hasOwnProperty('fechaOperacion')) p.fechaOperacion = null;
  if (!p.hasOwnProperty('telefonos')) p.telefonos = [];
  if (!Array.isArray(p.telefonos)) p.telefonos = normalizarTelefonosDesdeTexto(String(p.telefonos || ''));
  if (p.telefonos.length === 0 && p.telefono) {
    const legacy = String(p.telefono || '');
    const tels = normalizarTelefonosDesdeTexto(legacy);
    if (tels.length) p.telefonos = tels;
  }
  if ((!p.telefono || String(p.telefono).trim() === '') && Array.isArray(p.telefonos) && p.telefonos.length) {
    p.telefono = p.telefonos[0];
  }
  if (p.entregado) {
    p.enCurso = false;
    p.llegoDestino = false;
    p.posicionPendiente = null;
  }
  if (p.coords && (!Number.isFinite(Number(p.coords.lat)) || !Number.isFinite(Number(p.coords.lng)))) {
    p.coords = null;
  } else if (p.coords) {
    p.coords = { lat: Number(p.coords.lat), lng: Number(p.coords.lng) };
  }
  return p;
}



const EXPORT_JSON_VERSION = 1;
/** Tope orientativo para QR único (texto compactado). */
const QR_PEDIDOS_MAX_CHARS = 2800;
/** Legado: importación de copias antiguas (solo Base64 del gzip del JSON). */
const QR_PAYLOAD_PREFIX_GZIP = 'G1';
/**
 * Respaldo copiable / QR: prefijo + Base64 URL del binario (gzip del JSON interno si reduce tamaño; si no, UTF-8).
 * No es texto JSON legible ni “archivo”; es un solo código para pegar o escanear.
 */
const QR_BLOB_PREFIX = 'D1';

function bytesEmpaquetadosSonGzip(bytes) {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

async function compactExportABytesBinario(obj) {
  const raw = JSON.stringify(obj);
  const enc = new TextEncoder();
  const utf8 = enc.encode(raw);
  if (typeof CompressionStream === 'undefined') {
    return { bytes: utf8, comprimido: false, jsonChars: raw.length };
  }
  try {
    const stream = new Blob([utf8]).stream().pipeThrough(new CompressionStream('gzip'));
    const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
    if (compressed.length < utf8.length) {
      return { bytes: compressed, comprimido: true, jsonChars: raw.length };
    }
  } catch (err) {
    console.warn('[app-delivery] Sin gzip para blob QR:', err);
  }
  return { bytes: utf8, comprimido: false, jsonChars: raw.length };
}

function codificarBlobQrPrefijoD1(bytes) {
  return QR_BLOB_PREFIX + uint8ToBase64Url(bytes);
}

let qrPartesEstado = { partes: [], idx: 0 };
let qrcodeLoaderPromise = null;

function cargarScriptExterno(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

async function asegurarLibreriaQr() {
  if (typeof QRCode !== 'undefined') return true;
  if (!qrcodeLoaderPromise) {
    qrcodeLoaderPromise = (async () => {
      const fuentes = [
        './node_modules/qrcode/build/qrcode.min.js',
        'https://cdn.jsdelivr.net/npm/qrcode@1.5.3/build/qrcode.min.js',
        'https://unpkg.com/qrcode@1.5.3/build/qrcode.min.js',
      ];
      let ultimoError = null;
      for (const src of fuentes) {
        try {
          await cargarScriptExterno(src);
          if (typeof QRCode !== 'undefined') return true;
        } catch (e) {
          ultimoError = e;
        }
      }
      if (ultimoError) throw ultimoError;
      return typeof QRCode !== 'undefined';
    })().finally(() => {
      // Permite reintento manual si la red estuvo caída.
      qrcodeLoaderPromise = null;
    });
  }
  try {
    return await qrcodeLoaderPromise;
  } catch (_e) {
    return false;
  }
}

function dibujarQrPorImagenFallback(wrap, contenido) {
  if (!wrap) return;
  const img = document.createElement('img');
  img.alt = 'Código QR de respaldo';
  img.style.width = 'min(280px, 100%)';
  img.style.height = 'auto';
  img.style.aspectRatio = '1 / 1';
  img.style.objectFit = 'contain';
  img.style.display = 'block';
  img.style.border = '1px solid #e2e8f0';
  img.style.background = '#fff';
  // Fallback sin librería QR local/global.
  img.src = `https://quickchart.io/qr?size=280&margin=2&text=${encodeURIComponent(contenido)}`;
  img.onerror = () => {
    wrap.innerHTML = '<p style="color:#b91c1c;">No se pudo generar QR (librería y fallback sin respuesta). Usa Copiar texto.</p>';
  };
  wrap.appendChild(img);
}

async function renderQrParteActual(modal) {
  const wrap = modal.querySelector('#qrPedidosCanvasWrap');
  const aviso = modal.querySelector('#qrPedidosAviso');
  if (!wrap) return;
  wrap.innerHTML = '';

  const partes = qrPartesEstado.partes || [];
  const total = partes.length;
  const idx = Math.max(0, Math.min(qrPartesEstado.idx || 0, total - 1));
  qrPartesEstado.idx = idx;
  if (total === 0) {
    wrap.innerHTML = '<p style="color:#b91c1c;">No hay datos para generar QR.</p>';
    return;
  }

  if (!(await asegurarLibreriaQr())) {
    dibujarQrPorImagenFallback(wrap, partes[idx]);
    return;
  }

  const canvas = document.createElement('canvas');
  wrap.appendChild(canvas);
  QRCode.toCanvas(
    canvas,
    partes[idx],
    { width: 280, margin: 2, errorCorrectionLevel: 'L' },
    (err) => {
      if (err) {
        console.error(err);
        wrap.innerHTML = '<p style="color:#b91c1c;">No se pudo generar este QR. Usa Copiar texto.</p>';
        return;
      }
      if (aviso && total > 1) {
        aviso.style.display = 'block';
        aviso.textContent = 'Modo QR único activo.';
      }
    }
  );
}

function serializarPedidosParaExportar() {
  return JSON.stringify(
    {
      version: EXPORT_JSON_VERSION,
      exportedAt: new Date().toISOString(),
      pedidos: deduplicarPedidosPorId(pedidos),
    },
    null,
    2
  );
}

function pedidoAObjetoCompacto(p) {
  if (!p) return { i: 0 };
  const o = { i: p.id };
  if (p.nombre) o.n = p.nombre;
  if (p.telefono) o.t = p.telefono;
  if (Array.isArray(p.telefonos) && p.telefonos.length) o.ts = p.telefonos;
  if (p.direccion) o.d = p.direccion;
  if (p.valor != null && String(p.valor) !== '0') o.v = p.valor;
  if (p.textoOriginal) o.x = p.textoOriginal;
  if (p.mapUrl) o.u = p.mapUrl;
  if (p.coords && Number.isFinite(Number(p.coords.lat)) && Number.isFinite(Number(p.coords.lng))) {
    o.c = [
      Math.round(Number(p.coords.lat) * 1e5) / 1e5,
      Math.round(Number(p.coords.lng) * 1e5) / 1e5,
    ];
  }
  if (Array.isArray(p.productos) && p.productos.length) o.pr = p.productos;
  if (p.assignedTo) o.at = p.assignedTo;
  if (p.createdBy) o.cb = p.createdBy;
  if (p.enCurso) o.ec = 1;
  if (p.posicionPendiente != null && p.posicionPendiente !== '') o.pp = p.posicionPendiente;
  if (p.entregado) o.ee = 1;
  if (p.noEntregado) o.ne = 1;
  if (p.envioRecogido) o.er = 1;
  if (p.notificadoEnCamino) o.nc = 1;
  if (p.llegoDestino) o.ld = 1;
  if (p.cancelado) o.ca = 1;
  if (p.metodoPagoEntrega) o.mp = p.metodoPagoEntrega;
  if (Number(p.montoNequi)) o.mn = Number(p.montoNequi);
  if (Number(p.montoDaviplata)) o.md = Number(p.montoDaviplata);
  if (Number(p.montoEfectivo)) o.me = Number(p.montoEfectivo);
  return o;
}

function pedidoDesdeObjetoCompacto(c) {
  if (!c || typeof c !== 'object') return null;
  const id = Number(c.i);
  if (!Number.isFinite(id)) return null;
  const plain = {
    id,
    nombre: c.n,
    telefono: c.t,
    telefonos: Array.isArray(c.ts) ? c.ts : [],
    direccion: c.d,
    valor: c.v != null ? c.v : '0',
    textoOriginal: c.x,
    mapUrl: c.u,
    productos: Array.isArray(c.pr) ? c.pr : [],
    assignedTo: c.at != null ? c.at : null,
    createdBy: c.cb != null ? c.cb : null,
    enCurso: !!c.ec,
    posicionPendiente: c.pp != null ? c.pp : null,
    entregado: !!c.ee,
    noEntregado: !!c.ne,
    envioRecogido: !!c.er,
    notificadoEnCamino: !!c.nc,
    llegoDestino: !!c.ld,
    cancelado: !!c.ca,
    metodoPagoEntrega: c.mp || '',
    montoNequi: Number(c.mn ?? 0),
    montoDaviplata: Number(c.md ?? 0),
    montoEfectivo: Number(c.me ?? 0),
  };
  if (Array.isArray(c.c) && c.c.length >= 2) {
    plain.coords = { lat: Number(c.c[0]), lng: Number(c.c[1]) };
  }
  return pedidoDesdeObjetoImport(plain);
}

function uint8ToBase64Url(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToUint8Array(b64url) {
  let b64 = String(b64url || '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4;
  if (pad) b64 += '='.repeat(4 - pad);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function descomprimirGzipBytesAJson(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  const out = await new Response(stream).arrayBuffer();
  return new TextDecoder('utf-8').decode(out);
}

/** Legado G1: el Base64 envuelve solo bytes gzip del texto JSON. */
async function descomprimirGzipBase64UrlABase64Payload(b64url) {
  const bytes = base64UrlToUint8Array(b64url);
  return descomprimirGzipBytesAJson(bytes);
}

async function decodificarPrefijoD1AObjeto(s) {
  const b64 = s.slice(QR_BLOB_PREFIX.length);
  if (!b64) throw new Error('Datos incompletos después de D1.');
  const bytes = base64UrlToUint8Array(b64);
  let jsonText;
  if (bytesEmpaquetadosSonGzip(bytes)) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error(
        'Este navegador no puede abrir el código comprimido. Usa Chrome/Firefox reciente o importa un .json desde Exportar.'
      );
    }
    jsonText = await descomprimirGzipBytesAJson(bytes);
  } else {
    jsonText = new TextDecoder('utf-8').decode(bytes);
  }
  return JSON.parse(jsonText);
}

async function prepararCadenaParaQrPedidos() {
  const lista = deduplicarPedidosPorId(pedidos);
  const obj = { v: 2, t: Date.now(), p: lista.map(pedidoAObjetoCompacto) };
  const { bytes, comprimido, jsonChars } = await compactExportABytesBinario(obj);
  const payloadStr = codificarBlobQrPrefijoD1(bytes);
  return { payloadStr, comprimido, sinComprimirChars: jsonChars };
}

async function parsearTextoImportPedidosUniversal(texto) {
  const s = String(texto || '').trim().replace(/^\uFEFF/, '');
  if (!s) throw new Error('Vacío');
  if (s.startsWith(QR_BLOB_PREFIX)) {
    return decodificarPrefijoD1AObjeto(s);
  }
  if (s.startsWith(QR_PAYLOAD_PREFIX_GZIP)) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error(
        'Este navegador no puede abrir respaldos antiguos (G1). Prueba otro navegador o importa un .json exportado.'
      );
    }
    const inner = await descomprimirGzipBase64UrlABase64Payload(s.slice(QR_PAYLOAD_PREFIX_GZIP.length));
    return JSON.parse(inner);
  }
  return JSON.parse(s);
}

function exportarPedidosJson() {
  // Se conserva el nombre de función para no romper el onclick existente del menú.
  abrirModalRespaldoTexto();
}

async function abrirModalRespaldoTexto() {
  cerrarMenuUsuario();
  let modal = document.getElementById('modalTextoRespaldo');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'modalTextoRespaldo';
    modal.className = 'modal-no-entregado-backdrop';
    modal.innerHTML =
      '<div class="modal-no-entregado-card modal-qr-pedidos-card">' +
      '<h3>Respaldo en texto</h3>' +
      '<p class="modal-qr-ayuda">Copia este código completo (<code>D1…</code>). No es JSON legible.</p>' +
      '<label for="textoRespaldoPayload" class="qr-pedidos-label">Código de respaldo</label>' +
      '<textarea id="textoRespaldoPayload" class="qr-pedidos-textarea" readonly rows="6" spellcheck="false"></textarea>' +
      '<div class="qr-pedidos-acciones">' +
      '<button type="button" class="btn-primary" onclick="copiarTextoRespaldo()"><i class="fa-regular fa-copy"></i> Copiar texto</button>' +
      '<button type="button" class="modal-no-entregado-close" onclick="cerrarModalTextoRespaldo()">Cerrar</button>' +
      '</div>' +
      '</div>';
    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => {
      if (e.target === modal) cerrarModalTextoRespaldo();
    });
  }

  const textarea = modal.querySelector('#textoRespaldoPayload');
  if (!textarea) return;
  try {
    const prep = await prepararCadenaParaQrPedidos();
    textarea.value = prep.payloadStr || '';
  } catch (e) {
    console.error(e);
    textarea.value = '';
    mostrarToast('No se pudo preparar el respaldo en texto.', 'error');
  }
  modal.style.display = 'flex';
}

function copiarTextoRespaldo() {
  const ta = document.getElementById('textoRespaldoPayload');
  if (!ta || !ta.value) return;
  ta.focus();
  ta.select();
  ta.setSelectionRange(0, ta.value.length);
  const texto = ta.value;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(texto).then(
      () => mostrarToast('Texto copiado.', 'success'),
      () => copiarPayloadQrPedidosFallback(texto)
    );
  } else {
    copiarPayloadQrPedidosFallback(texto);
  }
}

function cerrarModalTextoRespaldo() {
  const modal = document.getElementById('modalTextoRespaldo');
  if (modal) modal.style.display = 'none';
}

function pedidoDesdeObjetoImport(o) {
  if (!o || typeof o !== 'object') return null;
  const id = Number(o.id);
  if (!Number.isFinite(id)) return null;
  let productos = [];
  if (Array.isArray(o.productos)) productos = o.productos;
  else if (typeof o.productos === 'string') {
    try {
      const p = JSON.parse(o.productos);
      productos = Array.isArray(p) ? p : [];
    } catch (_e) {
      productos = [];
    }
  }
  let coords = null;
  if (o.coords && Number.isFinite(Number(o.coords.lat)) && Number.isFinite(Number(o.coords.lng))) {
    coords = { lat: Number(o.coords.lat), lng: Number(o.coords.lng) };
  } else if (o.coords_lat != null && o.coords_lng != null) {
    const la = Number(o.coords_lat);
    const ln = Number(o.coords_lng);
    if (Number.isFinite(la) && Number.isFinite(ln)) coords = { lat: la, lng: ln };
  }
  const posPend = Number.isInteger(Number(o.posicionPendiente))
    ? Number(o.posicionPendiente)
    : (Number.isInteger(Number(o.posicion_pendiente)) ? Number(o.posicion_pendiente) : null);
  const merged = {
    ...pedidoNuevoBase(),
    id,
    assignedTo: o.assignedTo != null ? normalizarUuidAsignacion(o.assignedTo) : (o.assigned_to ? normalizarUuidAsignacion(o.assigned_to) : null),
    createdBy: o.createdBy ?? o.created_by ?? null,
    nombre: o.nombre || '',
    telefono: o.telefono || '',
    direccion: o.direccion || '',
    valor: String(o.valor != null ? o.valor : '0'),
    textoOriginal: o.textoOriginal || o.texto_original || '',
    mapUrl: o.mapUrl || o.map_url || '',
    coords,
    productos,
    enCurso: !!(o.enCurso ?? o.en_curso),
    posicionPendiente: posPend,
    entregado: !!o.entregado,
    noEntregado: !!(o.noEntregado ?? o.no_entregado),
    envioRecogido: !!(o.envioRecogido ?? o.envio_recogido),
    notificadoEnCamino: !!(o.notificadoEnCamino ?? o.notificado_en_camino),
    llegoDestino: !!(o.llegoDestino ?? o.llego_destino),
    cancelado: !!o.cancelado,
    metodoPagoEntrega: o.metodoPagoEntrega || o.metodo_pago_entrega || '',
    montoNequi: Number(o.montoNequi ?? o.monto_nequi ?? 0),
    montoDaviplata: Number(o.montoDaviplata ?? o.monto_daviplata ?? 0),
    montoEfectivo: Number(o.montoEfectivo ?? o.monto_efectivo ?? 0),
  };
  return normalizarPedidoEnMemoria(merged);
}

function extraerListaPedidosDeImportParsed(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (typeof data === 'object' && data.v === 2 && Array.isArray(data.p)) {
    return data.p.map(pedidoDesdeObjetoCompacto).filter(Boolean);
  }
  if (typeof data === 'object' && Array.isArray(data.pedidos)) return data.pedidos;
  return [];
}

function aplicarPedidosImportados(lista) {
  const mapped = lista.map(pedidoDesdeObjetoImport).filter(Boolean);
  return deduplicarPedidosPorId(mapped);
}

function aplicarImportacionPedidosDesdeLista(lista, reemplazar) {
  const incoming = aplicarPedidosImportados(lista);
  if (reemplazar) {
    pedidos = incoming;
  } else {
    const byId = new Map(pedidos.map((p) => [Number(p.id), p]));
    incoming.forEach((p) => byId.set(Number(p.id), p));
    pedidos = deduplicarPedidosPorId(Array.from(byId.values()));
  }
  if (pedidos.length > 0) {
    nextPedidoId = Math.max(...pedidos.map((p) => p.id), 0) + 1;
  } else {
    nextPedidoId = 1;
  }
  guardarPedidos();
  renderPedidos();
  actualizarMarcadores();
  cerrarModalImportarRespaldo();
  requestAnimationFrame(() => {
    mostrarToast(`Importación lista: ${incoming.length} pedido(s).`, 'success');
  });
}

async function importarPedidosDesdeTextoPlano(texto, origen = 'texto pegado') {
  let data;
  try {
    data = await parsearTextoImportPedidosUniversal(String(texto || ''));
  } catch (e) {
    console.error(e);
    mostrarToast(`No se pudo leer el ${origen}. Verifica el formato (D1… o JSON válido).`, 'error', 8000);
    return false;
  }
  const lista = extraerListaPedidosDeImportParsed(data);
  if (lista.length === 0) {
    mostrarToast(`El ${origen} no contiene una lista de pedidos válida.`, 'error', 8000);
    return false;
  }
  cerrarModalImportarRespaldo();
  return await new Promise((resolve) => {
    mostrarModalDecision({
      titulo: 'Importar pedidos',
      texto:
        '¿Cómo quieres importar?\n\n• Reemplazar todo: borra los pedidos actuales y deja solo los importados.\n• Combinar: mezcla; si un id coincide, gana el importado.',
      textoConfirmar: 'Reemplazar todo',
      textoCancelar: 'Combinar',
      mostrarSecundario: false,
      onConfirmar: () => {
        aplicarImportacionPedidosDesdeLista(lista, true);
        resolve(true);
      },
      onCancelar: () => {
        aplicarImportacionPedidosDesdeLista(lista, false);
        resolve(true);
      }
    });
  });
}

function abrirModalImportarRespaldo() {
  if (sesionUsuario && !esSesionAdmin()) {
    mostrarToast('Solo un administrador puede importar pedidos.', 'warning');
    return;
  }
  cerrarMenuUsuario();
  let modal = document.getElementById('modalImportarRespaldo');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'modalImportarRespaldo';
    modal.className = 'modal-no-entregado-backdrop';
    modal.innerHTML =
      '<div class="modal-no-entregado-card modal-qr-pedidos-card">' +
      '<h3>Importar respaldo</h3>' +
      '<p class="modal-qr-ayuda">Pega aquí el código de respaldo completo (D1…).</p>' +
      '<label for="textoImportarRespaldo" class="qr-pedidos-label">Texto de respaldo</label>' +
      '<textarea id="textoImportarRespaldo" class="qr-pedidos-textarea" rows="6" spellcheck="false" placeholder="Pega aquí el texto D1..."></textarea>' +
      '<div class="qr-pedidos-acciones">' +
      '<button type="button" class="btn-primary" onclick="confirmarImportarRespaldoPegado()">Importar texto pegado</button>' +
      '<button type="button" class="modal-no-entregado-close" onclick="cerrarModalImportarRespaldo()">Cerrar</button>' +
      '</div>' +
      '</div>';
    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => {
      if (e.target === modal) cerrarModalImportarRespaldo();
    });
  }
  const ta = modal.querySelector('#textoImportarRespaldo');
  if (ta) ta.value = '';
  modal.style.display = 'flex';
}

async function confirmarImportarRespaldoPegado() {
  const ta = document.getElementById('textoImportarRespaldo');
  if (!ta) return;
  const texto = String(ta.value || '').trim();
  if (!texto) {
    mostrarToast('Pega el texto de respaldo antes de importar.', 'warning');
    ta.focus();
    return;
  }
  try {
    const ok = await importarPedidosDesdeTextoPlano(texto, 'texto pegado');
    if (ok) cerrarModalImportarRespaldo();
  } catch (e) {
    console.error(e);
    mostrarToast('No se pudo importar el texto pegado. Verifica que esté completo y comience con D1…', 'error', 8000);
  }
}

function cerrarModalImportarRespaldo() {
  const modal = document.getElementById('modalImportarRespaldo');
  if (modal) modal.style.display = 'none';
}

function copiarPayloadQrPedidos() {
  const ta = document.getElementById('qrPedidosPayload');
  if (!ta || !ta.value) return;
  ta.focus();
  ta.select();
  ta.setSelectionRange(0, ta.value.length);
  const texto = ta.value;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(texto).then(
      () =>
        mostrarToast(
          'Copiado. En el otro equipo pega el código para restaurar pedidos (D1…).',
          'success',
          8000
        ),
      () => copiarPayloadQrPedidosFallback(texto)
    );
  } else {
    copiarPayloadQrPedidosFallback(texto);
  }
}

function copiarPayloadQrPedidosFallback(texto) {
  try {
    document.execCommand('copy');
    mostrarToast('Copiado. Si no funcionó, selecciona el texto manualmente.', 'info', 7000);
  } catch (_e) {
    mostrarToast('Selecciona el texto del cuadro y cópialo con Ctrl+C.', 'warning', 8000);
  }
}

async function abrirModalQrPedidos() {
  cerrarMenuUsuario();
  let modal = document.getElementById('modalQrPedidos');
  if (modal && !modal.querySelector('#qrPedidosPayload')) {
    modal.remove();
    modal = null;
  }
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'modalQrPedidos';
    modal.className = 'modal-no-entregado-backdrop';
    modal.innerHTML =
      '<div class="modal-no-entregado-card modal-qr-pedidos-card">' +
      '<h3>Respaldo QR / copiar</h3>' +
      '<p class="modal-qr-ayuda">Este respaldo no es JSON legible: es un código <code>D1…</code> compacto. Esta vista genera solo un QR.</p>' +
      '<div id="qrPedidosCanvasWrap" class="qr-pedidos-canvas-wrap"></div>' +
      '<p id="qrPedidosAviso" class="qr-pedidos-aviso" style="display:none;"></p>' +
      '<div class="qr-pedidos-acciones">' +
      '<button type="button" class="modal-no-entregado-close" onclick="cerrarModalQrPedidos()">Cerrar</button>' +
      '</div>' +
      '</div>';
    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => {
      if (e.target === modal) cerrarModalQrPedidos();
    });
  }
  const aviso = modal.querySelector('#qrPedidosAviso');
  const wrap = modal.querySelector('#qrPedidosCanvasWrap');
  if (!wrap) return;
  wrap.innerHTML = '';
  if (aviso) {
    aviso.style.display = 'none';
    aviso.textContent = '';
  }

  let payloadStr;
  let comprimido = false;
  let sinComprimirChars = 0;
  try {
    const prep = await prepararCadenaParaQrPedidos();
    payloadStr = prep.payloadStr;
    comprimido = prep.comprimido;
    sinComprimirChars = prep.sinComprimirChars;
  } catch (e) {
    console.error(e);
    wrap.innerHTML = '<p style="color:#b91c1c;">No se pudo preparar el respaldo.</p>';
    modal.style.display = 'flex';
    return;
  }

  qrPartesEstado = { partes: [payloadStr], idx: 0 };

  const partesAviso = [];
  if (comprimido) partesAviso.push(`Compresión interna activa (equivalente ~${sinComprimirChars} caracteres sin binario).`);
  if (payloadStr.length > QR_PEDIDOS_MAX_CHARS) {
    partesAviso.push('El respaldo es demasiado grande para un QR único. Reduce pedidos o usa respaldo en texto.');
  }
  if (partesAviso.length && aviso) {
    aviso.style.display = 'block';
    aviso.textContent = partesAviso.join(' ');
  }

  await renderQrParteActual(modal);
  modal.style.display = 'flex';
}

function cerrarModalQrPedidos() {
  const modal = document.getElementById('modalQrPedidos');
  if (modal) modal.style.display = 'none';
}

function cargarPedidosDesdeLocalStorage() {
  migrarCachePedidosDesdeClavesAntiguas();
  cargarPedidosLocalRev();
  const raw = cargarCachePedidos();
  pedidos = deduplicarPedidosPorId((raw || []).map(normalizarPedidoEnMemoria));
  if (pedidos.length > 0) {
    nextPedidoId = Math.max(...pedidos.map((p) => p.id), 0) + 1;
  } else {
    nextPedidoId = 1;
  }
}

let authHayUsuarios = false;

async function iniciarApp() {
  if (!sesionUsuario) return;
  aplicarVisibilidadPorRol();
  exponerDebugAppDelivery();
  actualizarBannerOffline();
  configurarFlushSyncPedidosAlSalir();
  configurarRefrescoPedidosMensajero();

  if (!appEstaOnline()) {
    cargarPedidosDesdeLocalStorage();
    if (pedidos.length > 0) {
      mostrarToast('Sin internet: mostrando pedidos guardados en este dispositivo.', 'info', 7000);
    } else {
      mostrarToast('Sin internet y no hay pedidos guardados aún. Conéctate una vez para cargarlos.', 'warning', 9000);
    }
  } else {
    // Siempre partir del cache local: si hubo cambios sin sync (p. ej. recarga rápida),
    // primero se suben y se conservan; no se pisan con el servidor.
    cargarPedidosDesdeLocalStorage();
    try {
      if (esSesionAdmin() && hayPedidosSyncPendiente()) {
        await forzarSyncPedidosAhora();
      } else {
        await refrescarPedidosDesdeApi();
      }
    } catch (e) {
      console.error(e);
      if (pedidos.length === 0) cargarPedidosDesdeLocalStorage();
      const hayLocal = pedidos.length > 0;
      mostrarToast(
        hayLocal
          ? `No se pudo sincronizar con el servidor. Mostrando ${pedidos.length} pedido(s) guardado(s) aquí.`
          : `No se pudieron cargar los pedidos del servidor: ${String(e.message || e)}`,
        hayLocal ? 'warning' : 'error',
        9000
      );
    }
  }
  if (esSesionAdmin() && appEstaOnline()) {
    try {
      await cargarMensajerosParaAsignacion();
    } catch (e) {
      console.error(e);
    }
  }
  aplicarVisibilidadPorRol();

  configurarArrastrePointerOrdenEntrega();
  configurarFabNavegacionScroll();

  cargarConfigNotificacionEnUI();
  const modalConfig = document.getElementById('modalConfigNotificacion');
  if (modalConfig) {
    modalConfig.addEventListener('click', (e) => {
      if (e.target === modalConfig) cerrarConfigNotificacion();
    });
  }

  document.addEventListener('click', (ev) => {
    const wrap = document.querySelector('.app-header-menu-wrap');
    if (wrap && !wrap.contains(ev.target)) cerrarMenuUsuario();
  });

  const bulkBtn = document.getElementById('bulkAssignBtn');
  if (bulkBtn && !bulkBtn.dataset.bound) {
    bulkBtn.dataset.bound = '1';
    bulkBtn.addEventListener('click', () => {
      void asignarActivosBulkDesdeBarra();
    });
  }

  renderPedidos();
  requestAnimationFrame(() => {
    try {
      if (!mapa) initMap();
      else {
        mapaAjustado = false;
        actualizarMarcadores();
        ajustarMapaConReintentos();
      }
    } catch (e) {
      console.error(e);
    }
  });
  try {
    await restaurarVistaAppSesionTrasInicio();
  } catch (e) {
    console.error(e);
  }
}

async function cerrarSesionApp() {
  cerrarMenuUsuario();
  try {
    if (sesionUsuario && esSesionAdmin() && appEstaOnline()) {
      if (syncRemotoTimer) {
        clearTimeout(syncRemotoTimer);
        syncRemotoTimer = null;
      }
      marcarPedidosSyncPendiente(true);
      await forzarSyncPedidosAhora();
    }
  } catch (e) {
    console.error(e);
  }
  setAuthToken('');
  guardarSesionUsuarioCache(null);
  sesionUsuario = null;
  try {
    sessionStorage.removeItem(AUTH_TAB_SESSION_KEY);
    sessionStorage.removeItem(VISTA_APP_SESSION_KEY);
  } catch (_e) {}
  window.location.reload();
}

async function entrarAppConSesion(user) {
  const usuarioAnteriorId = sesionUsuario?.id;
  const cambioUsuario =
    usuarioAnteriorId != null && String(usuarioAnteriorId) !== String(user.id);

  if (user.role !== 'admin') {
    limpiarVistaAppSesion();
    quitarEstiloPreRestoreUsuariosRoles();
    asegurarVistaPrincipalVisibleTrasPerderPreRestore();
  }

  if (cambioUsuario) {
    pedidos = [];
    nextPedidoId = 1;
  }

  sesionUsuario = user;
  guardarSesionUsuarioCache(user);
  const tokenActual = getAuthToken();
  if (tokenActual) setAuthToken(tokenActual, user.id);

  document.documentElement.classList.remove('auth-layout');
  document.body.classList.remove('auth-layout');
  const pa = document.getElementById('pantallaAuth');
  const main = document.getElementById('mainApp');
  if (pa) pa.style.display = 'none';
  if (main) main.style.display = '';
  const el = document.getElementById('appHeaderUsuario');
  if (el) {
    el.textContent = `${user.username} · ${user.role === 'admin' ? 'Administrador' : 'Mensajero'}`;
  }
  aplicarVisibilidadPorRol();
  if (appEstaOnline()) {
    try {
      await refrescarPaymentConfigDesdeServidor();
    } catch (e) {
      console.error(e);
    }
  }
  await iniciarApp();
}

function configurarMostrarContrasenaLogin() {
  const chk = document.getElementById('loginMostrarPass');
  const input = document.getElementById('loginPass');
  if (!chk || !input) return;
  chk.addEventListener('change', () => {
    input.type = chk.checked ? 'text' : 'password';
  });
}

function switchAuthTab(which) {
  const tabLogin = document.getElementById('authTabLogin');
  const tabReg = document.getElementById('authTabRegistro');
  const formLogin = document.getElementById('formLogin');
  const formReg = document.getElementById('formRegistro');
  const esLogin = which === 'login';
  if (tabLogin) tabLogin.classList.toggle('active', esLogin);
  if (tabReg) tabReg.classList.toggle('active', !esLogin);
  if (formLogin) formLogin.style.display = esLogin ? 'block' : 'none';
  if (formReg) formReg.style.display = esLogin ? 'none' : 'block';
  if (!esLogin) actualizarTextosRegistroAuth();
  if (which === 'login' || which === 'registro') {
    try {
      sessionStorage.setItem(AUTH_TAB_SESSION_KEY, which);
    } catch (_e) {}
  }
}

function correoPareceValido(correo) {
  const e = String(correo || '').trim().toLowerCase();
  if (e.length < 5 || e.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

async function onSubmitLogin(ev) {
  ev.preventDefault();
  const login = String(document.getElementById('loginIdentifier')?.value || '').trim();
  const p = String(document.getElementById('loginPass')?.value || '');
  const err = document.getElementById('authFormError');
  if (err) err.textContent = '';
  if (!correoPareceValido(login)) {
    if (err) err.textContent = 'Escribe el correo con el que te registraste.';
    return;
  }
  limpiarVistaAppSesion();
  quitarEstiloPreRestoreUsuariosRoles();
  try {
    const data = await apiJson('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ login, password: p }),
    });
    setAuthToken(data.token, data.user.id);
    await entrarAppConSesion(data.user);
  } catch (e) {
    if (err) err.textContent = String(e.message || e);
  }
}

async function onSubmitRegistro(ev) {
  ev.preventDefault();
  const u = String(document.getElementById('regUser')?.value || '').trim();
  const email = String(document.getElementById('regEmail')?.value || '').trim();
  const p = String(document.getElementById('regPass')?.value || '');
  const err = document.getElementById('authFormError');
  if (err) err.textContent = '';
  if (!u) {
    if (err) err.textContent = 'Indica un nombre para mostrar en la app.';
    return;
  }
  if (!correoPareceValido(email)) {
    if (err) err.textContent = 'Indica un correo electrónico válido. Cada correo solo puede usarse en una cuenta.';
    return;
  }
  try {
    const data = await apiJson('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username: u, email, password: p }),
    });
    setAuthToken(data.token, data.user.id);
    authHayUsuarios = true;
    await entrarAppConSesion(data.user);
  } catch (e) {
    if (err) err.textContent = String(e.message || e);
    if (e.detail) mostrarToast(String(e.detail), 'warning', 8000);
  }
}

function actualizarTextosRegistroAuth() {
  const btn = document.getElementById('regSubmitBtn');
  const lab = document.getElementById('regUserLabel');
  if (authHayUsuarios) {
    if (btn) btn.textContent = 'Registrarse';
    if (lab) lab.textContent = 'Nombre en la app';
  } else {
    if (btn) btn.textContent = 'Crear administrador (primer usuario)';
    if (lab) lab.textContent = 'Nombre del administrador en la app';
  }
}

/** Token temporal para POST /api/auth/reset-password desde el modal de recuperación. */
let modalRecuperarResetToken = '';
let modalRecuperarEmailComprobado = '';

function resetUiModalRecuperarClave() {
  const err = document.getElementById('modalRecuperarError');
  const noExiste = document.getElementById('modalRecuperarNoExiste');
  const bloqueExiste = document.getElementById('modalRecuperarBloqueExiste');
  const bloquePass = document.getElementById('modalRecuperarBloqueNuevaPass');
  const bloqueCorreo = document.getElementById('modalRecuperarBloqueCorreo');
  const accIni = document.getElementById('modalRecuperarAccionesInicial');
  const btnComprobar = document.getElementById('btnComprobarCorreoRecuperar');
  const btnAct = document.getElementById('btnModalActualizarPass');
  const hint = document.getElementById('modalRecuperarHintExiste');
  const p1 = document.getElementById('modalRecuperarPass1');
  const p2 = document.getElementById('modalRecuperarPass2');
  const errP = document.getElementById('modalRecuperarPassError');
  if (err) err.textContent = '';
  if (noExiste) {
    noExiste.style.display = 'none';
    noExiste.textContent = '';
  }
  if (bloqueExiste) bloqueExiste.style.display = 'none';
  if (bloquePass) bloquePass.style.display = 'none';
  if (bloqueCorreo) bloqueCorreo.style.display = 'block';
  if (accIni) accIni.style.display = 'flex';
  if (btnComprobar) btnComprobar.style.display = '';
  if (btnAct) btnAct.style.display = 'none';
  if (hint) hint.textContent = 'Correo registrado. Continúa para restablecer la contraseña.';
  if (p1) p1.value = '';
  if (p2) p2.value = '';
  if (errP) errP.textContent = '';
  modalRecuperarResetToken = '';
  modalRecuperarEmailComprobado = '';
}

function abrirModalRecuperarClave() {
  const modal = document.getElementById('modalRecuperarClave');
  const inp = document.getElementById('recuperarEmail');
  const ayuda = document.getElementById('modalRecuperarAyuda');
  resetUiModalRecuperarClave();
  if (inp) inp.value = '';
  if (inp) inp.disabled = false;
  if (ayuda) {
    ayuda.textContent =
      'Comprueba si tu correo está registrado. Si existe, podrás elegir una contraseña nueva aquí mismo (no se envía correo).';
  }
  if (modal) {
    modal.style.display = 'flex';
    modal.setAttribute('aria-hidden', 'false');
  }
}

function cerrarModalRecuperarClave() {
  const modal = document.getElementById('modalRecuperarClave');
  resetUiModalRecuperarClave();
  const inp = document.getElementById('recuperarEmail');
  if (inp) {
    inp.value = '';
    inp.disabled = false;
  }
  if (modal) {
    modal.style.display = 'none';
    modal.setAttribute('aria-hidden', 'true');
  }
}

async function comprobarCorreoParaRecuperacion() {
  const inp = document.getElementById('recuperarEmail');
  const err = document.getElementById('modalRecuperarError');
  const noExiste = document.getElementById('modalRecuperarNoExiste');
  const bloqueExiste = document.getElementById('modalRecuperarBloqueExiste');
  const btnAct = document.getElementById('btnModalActualizarPass');
  const btnComprobar = document.getElementById('btnComprobarCorreoRecuperar');
  if (err) err.textContent = '';
  if (noExiste) {
    noExiste.style.display = 'none';
    noExiste.textContent = '';
  }
  const email = String(inp?.value || '').trim();
  if (!correoPareceValido(email)) {
    if (err) err.textContent = 'Escribe un correo válido.';
    return;
  }
  try {
    const data = await apiJson('/api/auth/check-email-for-recovery', {
      method: 'POST',
      body: JSON.stringify({ email }),
    });
    if (!data.exists) {
      if (noExiste) {
        noExiste.style.display = 'block';
        noExiste.textContent = 'No hay ninguna cuenta registrada con ese correo.';
      }
      if (bloqueExiste) bloqueExiste.style.display = 'none';
      if (btnAct) btnAct.style.display = 'none';
      return;
    }
    modalRecuperarEmailComprobado = email;
    if (inp) inp.disabled = true;
    if (btnComprobar) btnComprobar.style.display = 'none';
    if (bloqueExiste) bloqueExiste.style.display = 'block';
    if (btnAct) btnAct.style.display = 'block';
  } catch (e) {
    if (err) err.textContent = String(e.message || e);
    if (e.detail) mostrarToast(String(e.detail), 'warning', 8000);
  }
}

async function solicitarTokenRecuperacionDesdeModal() {
  const err = document.getElementById('modalRecuperarError');
  const hint = document.getElementById('modalRecuperarHintExiste');
  const btnAct = document.getElementById('btnModalActualizarPass');
  const bloquePass = document.getElementById('modalRecuperarBloqueNuevaPass');
  if (err) err.textContent = '';
  const email = modalRecuperarEmailComprobado || String(document.getElementById('recuperarEmail')?.value || '').trim();
  if (!correoPareceValido(email)) {
    if (err) err.textContent = 'Escribe un correo válido.';
    return;
  }
  try {
    const data = await apiJson('/api/auth/forgot-password', {
      method: 'POST',
      body: JSON.stringify({ email }),
    });
    const token = String(data.resetToken || '').trim();
    if (token) {
      modalRecuperarResetToken = token;
      if (bloquePass) bloquePass.style.display = 'block';
      if (btnAct) btnAct.style.display = 'none';
      const bloqueExiste = document.getElementById('modalRecuperarBloqueExiste');
      if (bloqueExiste) bloqueExiste.style.display = 'none';
      mostrarToast(data.message || 'Escribe tu nueva contraseña.', 'success', 6000);
      return;
    }
    if (err) err.textContent = 'No se pudo obtener el enlace de recuperación. Intenta de nuevo.';
  } catch (e) {
    const det = e.detail ? ` ${String(e.detail)}` : '';
    const texto = `${String(e.message || e)}${det}`.trim();
    if (err) err.textContent = texto;
    mostrarToast(texto, 'error', 10000);
  }
}

async function guardarNuevaContrasenaModalRecuperar() {
  const err = document.getElementById('modalRecuperarPassError');
  const token = String(modalRecuperarResetToken || '').trim();
  const p1 = String(document.getElementById('modalRecuperarPass1')?.value || '');
  const p2 = String(document.getElementById('modalRecuperarPass2')?.value || '');
  if (err) err.textContent = '';
  if (!token) {
    if (err) err.textContent = 'Sesión de recuperación no válida. Cierra y vuelve a empezar.';
    return;
  }
  if (p1.length < 6) {
    if (err) err.textContent = 'La contraseña debe tener al menos 6 caracteres.';
    return;
  }
  if (p1 !== p2) {
    if (err) err.textContent = 'Las contraseñas no coinciden.';
    return;
  }
  try {
    const data = await apiJson('/api/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ token, password: p1 }),
    });
    setAuthToken(data.token, data.user.id);
    cerrarModalRecuperarClave();
    resetUiModalRecuperarClave();
    await entrarAppConSesion(data.user);
  } catch (e) {
    if (err) err.textContent = String(e.message || e);
  }
}

function volverModalRecuperarAOtroCorreo() {
  const inp = document.getElementById('recuperarEmail');
  resetUiModalRecuperarClave();
  if (inp) {
    inp.value = '';
    inp.disabled = false;
  }
}

function cancelarFormNuevaPassModalRecuperar() {
  const bloquePass = document.getElementById('modalRecuperarBloqueNuevaPass');
  const bloqueExiste = document.getElementById('modalRecuperarBloqueExiste');
  const btnAct = document.getElementById('btnModalActualizarPass');
  const errP = document.getElementById('modalRecuperarPassError');
  modalRecuperarResetToken = '';
  if (bloquePass) bloquePass.style.display = 'none';
  if (bloqueExiste) bloqueExiste.style.display = 'block';
  if (btnAct) btnAct.style.display = 'block';
  if (errP) errP.textContent = '';
  const p1 = document.getElementById('modalRecuperarPass1');
  const p2 = document.getElementById('modalRecuperarPass2');
  if (p1) p1.value = '';
  if (p2) p2.value = '';
}

function inicializarVistaResetDesdeUrl() {
  const p = new URLSearchParams(window.location.search);
  const t = p.get('reset');
  if (!t) return false;
  window.__passwordResetToken = decodeURIComponent(t);
  const main = document.getElementById('authBloquePrincipal');
  const blk = document.getElementById('authBloqueReset');
  if (main) main.style.display = 'none';
  if (blk) blk.style.display = 'block';
  return true;
}

function cancelarVistaResetPassword() {
  window.__passwordResetToken = '';
  const main = document.getElementById('authBloquePrincipal');
  const blk = document.getElementById('authBloqueReset');
  if (blk) blk.style.display = 'none';
  if (main) main.style.display = 'block';
  const errR = document.getElementById('authResetError');
  if (errR) errR.textContent = '';
  try {
    history.replaceState({}, '', window.location.pathname || '/');
  } catch (_e) {}
}

async function guardarNuevaContrasenaDesdeReset() {
  const token = window.__passwordResetToken;
  const err = document.getElementById('authResetError');
  const p1 = String(document.getElementById('resetPassNueva')?.value || '');
  const p2 = String(document.getElementById('resetPassNueva2')?.value || '');
  if (err) err.textContent = '';
  if (!token) {
    if (err) err.textContent = 'Falta el enlace de recuperación. Solicita uno nuevo.';
    return;
  }
  if (p1.length < 6) {
    if (err) err.textContent = 'La contraseña debe tener al menos 6 caracteres.';
    return;
  }
  if (p1 !== p2) {
    if (err) err.textContent = 'Las contraseñas no coinciden.';
    return;
  }
  try {
    const data = await apiJson('/api/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ token, password: p1 }),
    });
    setAuthToken(data.token, data.user.id);
    cancelarVistaResetPassword();
    await entrarAppConSesion(data.user);
  } catch (e) {
    if (err) err.textContent = String(e.message || e);
  }
}

function etiquetaEstadoPedidoResumida(p) {
  if (!p) return '—';
  if (p.cancelado) return 'Cancelado';
  if (p.entregado) return p.noEntregado ? 'No entregado' : 'Entregado';
  if (p.enCurso) return 'En ruta';
  return 'Pendiente';
}

function pedidosAsignadosAMensajero(userId) {
  const key = String(userId ?? '');
  return pedidos.filter((p) => String(p.assignedTo || '') === key);
}

function htmlPedidosAsignadosLista(asignados) {
  if (!asignados.length) {
    return '<p class="usuarios-roles-sin-pedidos">Ningún pedido asignado en este momento.</p>';
  }
  let lis = '';
  for (const pedido of asignados) {
    const val = formatearDigitosMilesEsCo(String(pedido.valor || '0'));
    const nombre = escapeHtmlTexto(String(pedido.nombre || 'Sin nombre'));
    const estado = escapeHtmlTexto(etiquetaEstadoPedidoResumida(pedido));
    lis += `<li><span class="usuarios-roles-pedido-id">#${escapeHtmlTexto(String(pedido.id))}</span> <span class="usuarios-roles-pedido-nombre">${nombre}</span> <span class="usuarios-roles-pedido-meta">${estado} · $${escapeHtmlTexto(val)}</span></li>`;
  }
  return `<ul class="usuarios-roles-pedidos-lista">${lis}</ul>`;
}

function htmlCardPedidosYPagosMensajero(titulo, asignados) {
  const totales = calcularTotalesEntregaPedidos(asignados);
  return (
    `<article class="usuarios-roles-mensajero-card">` +
    `<h4 class="usuarios-roles-mensajero-nombre">${escapeHtmlTexto(titulo)}</h4>` +
    htmlPedidosAsignadosLista(asignados) +
    `<div class="usuarios-roles-mensajero-pagos">${htmlBloqueTotalesResumen(totales, { ocultarTotalDelDia: true })}</div>` +
    `</article>`
  );
}

function renderPanelAsignacionesMensajeros() {
  const host = document.getElementById('usuariosRolesAsignaciones');
  if (!host) return;
  if (!esSesionAdmin()) {
    host.innerHTML = '';
    return;
  }

  renderTotalesAdminPorMensajero();

  const vacioMensajeros =
    '<p class="usuarios-roles-asignaciones-vacio">No hay mensajeros registrados. Crea usuarios con rol mensajero para ver asignaciones aquí.</p>';

  if (!listaMensajerosCache.length) {
    if (pedidos.length === 0) {
      host.innerHTML = vacioMensajeros;
      return;
    }
    const porAsignado = new Map();
    for (const p of pedidos) {
      const k = uidPedidoAsignado(p);
      if (!porAsignado.has(k)) porAsignado.set(k, []);
      porAsignado.get(k).push(p);
    }
    const partes = [];
    const keysOrden = [...porAsignado.keys()].sort((a, b) => {
      if (a === '') return -1;
      if (b === '') return 1;
      return a.localeCompare(b, undefined, { numeric: true });
    });
    for (const k of keysOrden) {
      const list = porAsignado.get(k);
      const titulo = k === '' ? 'Sin asignar' : `Mensajero (id ${k})`;
      partes.push(htmlCardPedidosYPagosMensajero(titulo, list));
    }
    host.innerHTML = partes.join('');
    return;
  }

  const chunks = [];
  for (const m of listaMensajerosCache) {
    const asignados = pedidosAsignadosAMensajero(m.id);
    const titulo = String(m.username || `Usuario #${m.id}`);
    chunks.push(htmlCardPedidosYPagosMensajero(titulo, asignados));
  }

  const sinAsignar = pedidos.filter((p) => uidPedidoAsignado(p) === '');
  if (sinAsignar.length) {
    chunks.push(htmlCardPedidosYPagosMensajero('Sin asignar', sinAsignar));
  }

  const idsEnLista = new Set(listaMensajerosCache.map((x) => String(x.id)));
  const idsOrfanos = new Set();
  for (const p of pedidos) {
    const a = uidPedidoAsignado(p);
    if (a && !idsEnLista.has(a)) idsOrfanos.add(a);
  }
  for (const orphanId of [...idsOrfanos].sort((x, y) => x.localeCompare(y, undefined, { numeric: true }))) {
    const subset = pedidos.filter((p) => uidPedidoAsignado(p) === orphanId);
    chunks.push(htmlCardPedidosYPagosMensajero(`Mensajero (id ${orphanId})`, subset));
  }

  host.innerHTML = chunks.join('');
}

async function actualizarPanelAsignacionesMensajerosDesdeApi() {
  try {
    await refrescarPedidosDesdeApi();
    renderPedidos();
    actualizarMarcadores();
  } catch (_e) {}
  renderPanelAsignacionesMensajeros();
}

function quitarEstiloPreRestoreUsuariosRoles() {
  const st = document.getElementById(PRE_RESTORE_USUARIOS_ROLES_STYLE_ID);
  if (st) st.remove();
}

/** Si el `<head>` ocultó la vista principal (anti-parpadeo), revierte el DOM con estilos en línea. */
function asegurarVistaPrincipalVisibleTrasPerderPreRestore() {
  const page = document.getElementById('pageUsuariosRoles');
  const principal = document.getElementById('appVistaPrincipal');
  if (page) {
    page.style.display = 'none';
    page.setAttribute('aria-hidden', 'true');
  }
  if (principal) {
    principal.style.display = '';
    principal.removeAttribute('aria-hidden');
  }
}

function guardarVistaAppSesionUsuariosRoles() {
  try {
    sessionStorage.setItem(VISTA_APP_SESSION_KEY, VISTA_APP_USUARIOS_ROLES);
    if (sesionUsuario?.id != null) {
      sessionStorage.setItem(VISTA_APP_USER_SESSION_KEY, String(sesionUsuario.id));
    }
  } catch (_e) {}
}

function limpiarVistaAppSesion() {
  try {
    sessionStorage.removeItem(VISTA_APP_SESSION_KEY);
    sessionStorage.removeItem(VISTA_APP_USER_SESSION_KEY);
  } catch (_e) {}
}

function vistaAppSesionEsUsuariosRoles() {
  try {
    return sessionStorage.getItem(VISTA_APP_SESSION_KEY) === VISTA_APP_USUARIOS_ROLES;
  } catch (_e) {
    return false;
  }
}

async function mostrarUiPaginaUsuariosRoles() {
  try {
    const legacy = document.getElementById('modalUsuariosAdmin');
    if (legacy) legacy.remove();
    const page = document.getElementById('pageUsuariosRoles');
    const principal = document.getElementById('appVistaPrincipal');
    const pageHistorial = document.getElementById('pageHistorialEntregas');
    if (pageHistorial) {
      pageHistorial.style.display = 'none';
      pageHistorial.setAttribute('aria-hidden', 'true');
    }
    if (principal) {
      principal.style.display = 'none';
      principal.setAttribute('aria-hidden', 'true');
    }
    if (page) {
      page.style.display = 'block';
      page.removeAttribute('aria-hidden');
    }
    await refrescarListaUsuariosPagina();
    await refrescarMediosPagoTiendaDesdeServidor();
    cargarMediosPagoTiendaEnUI();
    scrollToTopApp();
  } finally {
    quitarEstiloPreRestoreUsuariosRoles();
  }
}

async function restaurarVistaAppSesionTrasInicio() {
  if (!esSesionAdmin()) {
    limpiarVistaAppSesion();
    quitarEstiloPreRestoreUsuariosRoles();
    asegurarVistaPrincipalVisibleTrasPerderPreRestore();
    return;
  }
  if (vistaAppSesionEsHistorialEntregas()) {
    await mostrarUiPaginaHistorialEntregas();
    return;
  }
  if (!vistaAppSesionEsUsuariosRoles()) {
    quitarEstiloPreRestoreUsuariosRoles();
    return;
  }
  await mostrarUiPaginaUsuariosRoles();
}

function cerrarPaginaUsuariosRoles() {
  limpiarVistaAppSesion();
  const page = document.getElementById('pageUsuariosRoles');
  const principal = document.getElementById('appVistaPrincipal');
  if (page) {
    page.style.display = 'none';
    page.setAttribute('aria-hidden', 'true');
  }
  if (principal) {
    principal.style.display = '';
    principal.removeAttribute('aria-hidden');
  }
  scrollToTopApp();
}

async function refrescarListaUsuariosPagina() {
  const host = document.getElementById('usuariosRolesLista');
  if (!host) return;
  host.innerHTML = '<p class="modal-usuarios-cargando">Cargando…</p>';
  try {
    const data = await apiJson('/api/users', { method: 'GET' });
    const users = data.users || [];
    if (users.length === 0) {
      host.innerHTML = '<p>Sin usuarios.</p>';
    } else {
    host.innerHTML = '';
    const tabla = document.createElement('table');
    tabla.className = 'modal-usuarios-tabla';
    tabla.innerHTML =
      '<thead><tr><th>Nombre</th><th>Correo</th><th>Rol</th><th>Modificar valor</th><th class="modal-usuarios-th-acciones" scope="col"><span class="visually-hidden">Acciones</span></th></tr></thead><tbody></tbody>';
    const tb = tabla.querySelector('tbody');
    for (const u of users) {
      const tr = document.createElement('tr');
      const soy = sesionUsuario && Number(u.id) === Number(sesionUsuario.id);
      const mail = u.email ? escapeHtmlTexto(u.email) : '<span class="modal-usuarios-sin-correo">—</span>';
      const esMensajero = u.role === 'mensajero';
      tr.innerHTML = `
        <td>${escapeHtmlTexto(u.username)}${soy ? ' <span class="modal-usuarios-yo">(tú)</span>' : ''}</td>
        <td class="modal-usuarios-correo-celda">${mail}</td>
        <td>
          <select class="modal-usuarios-rol-select" data-user-id="${u.id}" ${soy ? 'disabled' : ''}>
            <option value="admin"${u.role === 'admin' ? ' selected' : ''}>Administrador</option>
            <option value="mensajero"${u.role === 'mensajero' ? ' selected' : ''}>Mensajero</option>
          </select>
        </td>
        <td class="modal-usuarios-perm-valor-celda">
          ${
            esMensajero
              ? `<label class="modal-usuarios-perm-valor-label"><input type="checkbox" class="modal-usuarios-perm-valor-check" data-user-id="${u.id}" ${u.puedeModificarValor ? 'checked' : ''}> Permitir</label>`
              : '<span class="modal-usuarios-sin-correo">—</span>'
          }
        </td>
        <td class="modal-usuarios-acciones-celda"></td>`;
      if (!soy) {
        const sel = tr.querySelector('select');
        sel.addEventListener('change', () => {
          void cambiarRolUsuario(Number(u.id), sel.value);
        });
        const accTd = tr.querySelector('.modal-usuarios-acciones-celda');
        const btnDel = document.createElement('button');
        btnDel.type = 'button';
        btnDel.className = 'modal-usuarios-btn-eliminar';
        btnDel.title = 'Eliminar usuario';
        btnDel.setAttribute('aria-label', 'Eliminar usuario');
        btnDel.innerHTML = '<i class="fa-solid fa-trash" aria-hidden="true"></i>';
        btnDel.addEventListener('click', () => {
          void eliminarUsuarioAdminDesdeModal(Number(u.id), String(u.username || ''));
        });
        accTd.appendChild(btnDel);
      }
      const chk = tr.querySelector('.modal-usuarios-perm-valor-check');
      if (chk) {
        chk.addEventListener('change', () => {
          void cambiarPuedeModificarValorUsuario(Number(u.id), !!chk.checked, chk);
        });
      }
      tb.appendChild(tr);
    }
    host.appendChild(tabla);
    }
  } catch (e) {
    host.innerHTML = `<p class="modal-usuarios-error">${escapeHtmlTexto(String(e.message || e))}</p>`;
  }
  await cargarMensajerosParaAsignacion();
  renderPanelAsignacionesMensajeros();
  renderTotalesAdminPorMensajero();
}

async function cambiarRolUsuario(userId, role) {
  try {
    await apiJson(`/api/users/${userId}`, {
      method: 'PATCH',
      body: JSON.stringify({ role }),
    });
    await refrescarListaUsuariosPagina();
    renderPedidos();
    actualizarMarcadores();
    mostrarToast('Rol actualizado', 'success');
  } catch (e) {
    mostrarToast(String(e.message || e), 'error');
    await refrescarListaUsuariosPagina();
  }
}

async function cambiarPuedeModificarValorUsuario(userId, puede, checkboxEl) {
  try {
    await apiJson(`/api/users/${userId}`, {
      method: 'PATCH',
      body: JSON.stringify({ puedeModificarValor: !!puede }),
    });
    mostrarToast(
      puede
        ? 'El mensajero podrá confirmar y modificar el valor de los pedidos'
        : 'El mensajero ya no podrá modificar el valor de los pedidos',
      'success'
    );
  } catch (e) {
    mostrarToast(String(e.message || e), 'error');
    if (checkboxEl) checkboxEl.checked = !puede;
  }
}

async function eliminarUsuarioAdminDesdeModal(userId, nombreVisible) {
  const etiqueta = nombreVisible.trim() || `usuario #${userId}`;
  const ok = window.confirm(
    `¿Eliminar la cuenta «${etiqueta}»?\n\nLos pedidos que tuviera asignados ese mensajero quedarán sin asignar. Esta acción no se puede deshacer.`
  );
  if (!ok) return;
  try {
    await apiJson(`/api/users/${userId}`, { method: 'DELETE' });
    mostrarToast('Usuario eliminado', 'success');
    try {
      await refrescarPedidosDesdeApi();
    } catch (_e) {}
    await refrescarListaUsuariosPagina();
    renderPedidos();
    actualizarMarcadores();
  } catch (e) {
    mostrarToast(String(e.message || e), 'error');
    await refrescarListaUsuariosPagina();
  }
}

async function crearUsuarioDesdeModal() {
  const u = String(document.getElementById('nuevoUsuarioNombre')?.value || '').trim();
  const email = String(document.getElementById('nuevoUsuarioEmail')?.value || '').trim();
  const p = String(document.getElementById('nuevoUsuarioPass')?.value || '');
  const role = String(document.getElementById('nuevoUsuarioRol')?.value || 'mensajero');
  if (!u) {
    mostrarToast('Indica un nombre en la app.', 'warning');
    return;
  }
  if (!correoPareceValido(email)) {
    mostrarToast('Indica un correo electrónico válido y que no esté ya registrado.', 'warning');
    return;
  }
  try {
    await apiJson('/api/users', {
      method: 'POST',
      body: JSON.stringify({ username: u, email, password: p, role }),
    });
    document.getElementById('nuevoUsuarioNombre').value = '';
    const em = document.getElementById('nuevoUsuarioEmail');
    if (em) em.value = '';
    document.getElementById('nuevoUsuarioPass').value = '';
    await refrescarListaUsuariosPagina();
    renderPedidos();
    mostrarToast('Usuario creado', 'success');
  } catch (e) {
    mostrarToast(String(e.message || e), 'error');
  }
}

async function abrirPaginaUsuariosRoles() {
  cerrarMenuUsuario();
  if (!esSesionAdmin()) return;
  guardarVistaAppSesionUsuariosRoles();
  await mostrarUiPaginaUsuariosRoles();
}

/** Fecha local YYYY-MM-DD para agrupar el historial del día. */
function fechaOperacionHoyLocal() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function sellarFechaOperacionPedido(pedido) {
  if (!pedido) return;
  if (!pedido.fechaOperacion) pedido.fechaOperacion = fechaOperacionHoyLocal();
}

/** Pedidos que entran al historial del día (ya finalizados). */
function pedidoEstaFinalizadoParaHistorial(pedido) {
  if (!pedido) return false;
  if (pedido.cancelado) return true;
  if (pedido.entregado) return true; // incluye entregado, no entregado y portería
  return false;
}

/**
 * Pedidos finalizados antes del historial no tienen fechaOperacion.
 * Se les asigna la fecha de hoy para que aparezcan al abrir/actualizar el historial.
 * @returns {number} cantidad de pedidos a los que se selló fecha
 */
function asegurarFechasOperacionPedidosFinalizados() {
  const hoy = fechaOperacionHoyLocal();
  let n = 0;
  for (const p of pedidos) {
    if (!pedidoEstaFinalizadoParaHistorial(p)) continue;
    if (p.fechaOperacion) continue;
    p.fechaOperacion = hoy;
    n += 1;
  }
  if (n > 0) guardarPedidos();
  return n;
}

function formatearFechaHistorialEs(fechaIso) {
  const m = String(fechaIso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return String(fechaIso || '—');
  const meses = [
    'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
    'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
  ];
  const mes = meses[Number(m[2]) - 1] || m[2];
  return `${Number(m[3])} de ${mes} de ${m[1]}`;
}

function estadoPedidoParaHistorial(p) {
  if (!p) return 'entregado';
  if (p.cancelado || (p.noEntregado && p.envioRecogido)) return 'devuelto';
  if (p.noEntregado) return 'sin_entregar';
  return 'entregado';
}

function etiquetaEstadoHistorial(estado) {
  if (estado === 'devuelto') return 'Devuelto';
  if (estado === 'sin_entregar') return 'Sin entregar';
  return 'Entregado';
}

function resumenHistorialDesdePedidosPorFecha(fecha) {
  const delDia = pedidos.filter((p) => p && String(p.fechaOperacion || '') === String(fecha));
  const entregadosLista = delDia.filter((p) => p.entregado && !p.noEntregado && !p.cancelado);
  const sinEntregarLista = delDia.filter((p) => p.noEntregado && !p.envioRecogido);
  const devueltosLista = delDia.filter(
    (p) => p.cancelado || (p.noEntregado && p.envioRecogido)
  );
  const pagadosNequi = entregadosLista.filter((p) => Number(p.montoNequi || 0) > 0).length;
  const recogidoTotal = entregadosLista.reduce((s, p) => s + obtenerValorAReclamarPedido(p), 0);
  const recogidoEfectivo = entregadosLista.reduce((s, p) => s + Number(p.montoEfectivo || 0), 0);
  const recogidoNequi = entregadosLista.reduce((s, p) => s + Number(p.montoNequi || 0), 0);
  const recogidoDaviplata = entregadosLista.reduce((s, p) => s + Number(p.montoDaviplata || 0), 0);
  const enviosPagoMensajero =
    entregadosLista.length + delDia.filter((p) => p.noEntregado && p.envioRecogido).length;
  const pagadoMensajero = enviosPagoMensajero * TARIFA_PAGO_MENSAJERO;
  const aEntregarTienda = Math.max(recogidoTotal - pagadoMensajero, 0);

  const porMap = new Map();
  for (const p of delDia) {
    const uid = uidPedidoAsignado(p) || '';
    const key = uid || '__sin__';
    if (!porMap.has(key)) {
      const nombre =
        uid
          ? nombreMensajeroPorId(uid) || `Mensajero ${uid}`
          : 'Sin asignar';
      porMap.set(key, {
        userId: uid || null,
        nombre,
        entregados: 0,
        pedidos: [],
      });
    }
    const bucket = porMap.get(key);
    const estado = estadoPedidoParaHistorial(p);
    if (estado === 'entregado') bucket.entregados += 1;
    bucket.pedidos.push({
      id: Number(p.id),
      nombre: String(p.nombre || '').trim(),
      estado,
      montoNequi: Number(p.montoNequi || 0),
      montoDaviplata: Number(p.montoDaviplata || 0),
      montoEfectivo: Number(p.montoEfectivo || 0),
    });
  }
  const porMensajero = [...porMap.values()].sort((a, b) =>
    String(a.nombre).localeCompare(String(b.nombre), 'es')
  );

  return {
    fecha: String(fecha),
    entregados: entregadosLista.length,
    devueltos: devueltosLista.length,
    sinEntregar: sinEntregarLista.length,
    pagadosNequi,
    recogidoTotal,
    recogidoEfectivo,
    recogidoNequi,
    recogidoDaviplata,
    pagadoMensajero,
    aEntregarTienda,
    porMensajero,
    actualizadoEn: Math.floor(Date.now() / 1000),
  };
}

function cargarHistorialEntregasCacheLocal() {
  try {
    const raw = localStorage.getItem(HISTORIAL_ENTREGAS_CACHE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (_e) {
    return [];
  }
}

function guardarHistorialEntregasCacheLocal(dias) {
  try {
    localStorage.setItem(HISTORIAL_ENTREGAS_CACHE_KEY, JSON.stringify(Array.isArray(dias) ? dias : []));
  } catch (_e) {}
}

function cargarRetencionHistorialLocal() {
  try {
    const n = Number(localStorage.getItem(HISTORIAL_RETENCION_CACHE_KEY));
    if (!Number.isFinite(n)) return HISTORIAL_RETENCION_DEFAULT_DIAS;
    return Math.max(0, Math.min(3650, Math.floor(n)));
  } catch (_e) {
    return HISTORIAL_RETENCION_DEFAULT_DIAS;
  }
}

function guardarRetencionHistorialLocal(dias) {
  try {
    localStorage.setItem(HISTORIAL_RETENCION_CACHE_KEY, String(Math.max(0, Math.floor(Number(dias) || 0))));
  } catch (_e) {}
}

function filtrarDiasHistorialPorRetencion(dias, retencionDias) {
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

function diaHistorialTieneDatos(d) {
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

function fusionarHistorialDias(guardados, desdePedidos) {
  const map = new Map();
  for (const d of guardados || []) {
    if (d && d.fecha) map.set(String(d.fecha), { ...d });
  }
  for (const d of desdePedidos || []) {
    if (!d || !d.fecha) continue;
    const key = String(d.fecha);
    const prev = map.get(key);
    // No reemplazar un día guardado con datos por un resumen vacío.
    if (!diaHistorialTieneDatos(d) && prev && diaHistorialTieneDatos(prev)) continue;
    map.set(key, { ...d });
  }
  return [...map.values()]
    .filter(diaHistorialTieneDatos)
    .sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));
}

function fechasOperacionPresentesEnPedidos() {
  const set = new Set();
  for (const p of pedidos) {
    if (p && p.fechaOperacion) set.add(String(p.fechaOperacion));
  }
  return [...set];
}

function reconstruirHistorialDesdePedidosActuales() {
  return fechasOperacionPresentesEnPedidos().map((f) => resumenHistorialDesdePedidosPorFecha(f));
}

async function sincronizarHistorialPorFecha(fecha) {
  if (!fecha || !appEstaOnline() || !getAuthToken()) {
    const local = filtrarDiasHistorialPorRetencion(
      fusionarHistorialDias(
        cargarHistorialEntregasCacheLocal(),
        reconstruirHistorialDesdePedidosActuales()
      ),
      cargarRetencionHistorialLocal()
    );
    guardarHistorialEntregasCacheLocal(local);
    return;
  }
  const dia = resumenHistorialDesdePedidosPorFecha(fecha);
  try {
    await apiJson('/api/historial-entregas/dia', {
      method: 'POST',
      body: JSON.stringify({ dia }),
    });
    const local = filtrarDiasHistorialPorRetencion(
      fusionarHistorialDias(cargarHistorialEntregasCacheLocal(), [dia]),
      cargarRetencionHistorialLocal()
    );
    guardarHistorialEntregasCacheLocal(local);
  } catch (e) {
    console.error(e);
    const local = filtrarDiasHistorialPorRetencion(
      fusionarHistorialDias(
        cargarHistorialEntregasCacheLocal(),
        reconstruirHistorialDesdePedidosActuales()
      ),
      cargarRetencionHistorialLocal()
    );
    guardarHistorialEntregasCacheLocal(local);
  }
}

async function sincronizarHistorialDiaPedido(pedido) {
  if (!pedido) return;
  sellarFechaOperacionPedido(pedido);
  await sincronizarHistorialPorFecha(pedido.fechaOperacion);
}

/** True si aún hay pedidos por entregar (pendientes o en ruta). */
function quedanPedidosActivosPorEntregar() {
  return pedidos.some((p) => p && !p.entregado && !p.cancelado);
}

/**
 * Guarda el historial del día. Si era el último pedido activo, fuerza sync inmediato
 * de pedidos + reenvío del día (upsert; no reemplaza otros días del historial).
 */
async function persistirHistorialTrasCierrePedido(pedido) {
  if (!pedido) return;
  sellarFechaOperacionPedido(pedido);
  const esUltimo = !quedanPedidosActivosPorEntregar();
  await sincronizarHistorialPorFecha(pedido.fechaOperacion);
  if (!esUltimo) return;

  if (syncRemotoTimer) {
    clearTimeout(syncRemotoTimer);
    syncRemotoTimer = null;
  }
  try {
    if (sesionUsuario) {
      marcarPedidosSyncPendiente(true);
      await syncPedidosAlServidor();
    }
  } catch (e) {
    console.error(e);
  }

  // Reenviar solo el día actual (POST upsert). Nunca PUT de lista completa aquí:
  // un PUT incompleto borraba días anteriores (p. ej. el de ayer).
  await sincronizarHistorialPorFecha(pedido.fechaOperacion);
}

function guardarVistaAppSesionHistorialEntregas() {
  try {
    sessionStorage.setItem(VISTA_APP_SESSION_KEY, VISTA_APP_HISTORIAL_ENTREGAS);
  } catch (_e) {}
}

function vistaAppSesionEsHistorialEntregas() {
  try {
    return sessionStorage.getItem(VISTA_APP_SESSION_KEY) === VISTA_APP_HISTORIAL_ENTREGAS;
  } catch (_e) {
    return false;
  }
}

function htmlBloquePorMensajeroHistorial(dia) {
  const lista = Array.isArray(dia.porMensajero) ? dia.porMensajero : [];
  if (lista.length === 0) {
    return '<p class="historial-mensajeros-vacio">Sin detalle de repartidores para este día.</p>';
  }
  return (
    `<div class="historial-mensajeros">` +
    `<h4 class="historial-mensajeros-titulo">Por repartidor</h4>` +
    lista
      .map((m) => {
        const pedidosHtml = (m.pedidos || [])
          .map((p) => {
            const nom = p.nombre ? ` — ${escapeHtmlTexto(p.nombre)}` : '';
            return (
              `<li><span class="historial-pedido-id">#${escapeHtmlTexto(String(p.id))}</span>` +
              `${nom}` +
              ` <span class="historial-pedido-estado historial-pedido-estado--${escapeHtmlAttr(p.estado)}">${escapeHtmlTexto(etiquetaEstadoHistorial(p.estado))}</span></li>`
            );
          })
          .join('');
        return (
          `<div class="historial-mensajero-card">` +
          `<p class="historial-mensajero-nombre"><i class="fa-solid fa-motorcycle" aria-hidden="true"></i> ${escapeHtmlTexto(m.nombre || 'Sin asignar')}` +
          ` <span class="historial-mensajero-meta">${Number(m.entregados || 0)} entregado(s)</span></p>` +
          `<ul class="historial-mensajero-pedidos">${pedidosHtml || '<li>Sin pedidos</li>'}</ul>` +
          `</div>`
        );
      })
      .join('') +
    `</div>`
  );
}

function htmlTarjetaHistorialDia(dia) {
  const fmt = (n) => Number(n || 0).toLocaleString('es-CO');
  const nequi = Number(dia.recogidoNequi || 0);
  const davi = Number(dia.recogidoDaviplata || 0);
  return (
    `<article class="historial-dia-card">` +
    `<h3 class="historial-dia-fecha">${escapeHtmlTexto(formatearFechaHistorialEs(dia.fecha))}</h3>` +
    `<p class="historial-dia-fecha-iso">${escapeHtmlTexto(dia.fecha)}</p>` +
    `<div class="historial-dia-grid">` +
    `<div class="historial-dia-metric"><span class="historial-dia-metric-label">Entregados</span><strong>${fmt(dia.entregados)}</strong></div>` +
    `<div class="historial-dia-metric"><span class="historial-dia-metric-label">Devueltos</span><strong>${fmt(dia.devueltos)}</strong></div>` +
    `<div class="historial-dia-metric"><span class="historial-dia-metric-label">Sin entregar</span><strong>${fmt(dia.sinEntregar)}</strong></div>` +
    `<div class="historial-dia-metric historial-dia-metric--money"><span class="historial-dia-metric-label">Recogido total</span><strong>$${fmt(dia.recogidoTotal)}</strong></div>` +
    `<div class="historial-dia-metric historial-dia-metric--money"><span class="historial-dia-metric-label">Recogido en efectivo</span><strong>$${fmt(dia.recogidoEfectivo)}</strong></div>` +
    `<div class="historial-dia-metric historial-dia-metric--money"><span class="historial-dia-metric-label">Recogido por Nequi</span><strong>$${fmt(nequi)}</strong></div>` +
    `<div class="historial-dia-metric historial-dia-metric--money"><span class="historial-dia-metric-label">Recogido por Daviplata</span><strong>$${fmt(davi)}</strong></div>` +
    `<div class="historial-dia-metric historial-dia-metric--money"><span class="historial-dia-metric-label">Pagado al mensajero</span><strong>$${fmt(dia.pagadoMensajero)}</strong></div>` +
    `<div class="historial-dia-metric historial-dia-metric--money historial-dia-metric--tienda"><span class="historial-dia-metric-label">A entregar a tienda</span><strong>$${fmt(
      dia.aEntregarTienda != null
        ? dia.aEntregarTienda
        : Math.max(Number(dia.recogidoTotal || 0) - Number(dia.pagadoMensajero || 0), 0)
    )}</strong></div>` +
    `</div>` +
    htmlBloquePorMensajeroHistorial(dia) +
    `</article>`
  );
}

function pintarConfigRetencionHistorialUI(retencionDias) {
  const input = document.getElementById('historialRetencionDias');
  if (input) input.value = String(retencionDias);
  const hint = document.getElementById('historialRetencionHint');
  if (!hint) return;
  const n = Number(retencionDias);
  if (!Number.isFinite(n) || n <= 0) {
    hint.textContent = 'Sin límite: el historial no se borrará automáticamente.';
  } else {
    hint.textContent = `Los días con más de ${n} día(s) de antigüedad se eliminarán solos.`;
  }
}

async function guardarRetencionHistorialDesdeUI() {
  const input = document.getElementById('historialRetencionDias');
  let n = Number(input && input.value);
  if (!Number.isFinite(n) || n < 0) n = HISTORIAL_RETENCION_DEFAULT_DIAS;
  n = Math.max(0, Math.min(3650, Math.floor(n)));
  guardarRetencionHistorialLocal(n);
  pintarConfigRetencionHistorialUI(n);
  try {
    if (appEstaOnline() && getAuthToken() && esSesionAdmin()) {
      const data = await apiJson('/api/historial-entregas/config', {
        method: 'PUT',
        body: JSON.stringify({ retencionDias: n }),
      });
      if (Array.isArray(data.dias)) {
        guardarHistorialEntregasCacheLocal(data.dias);
      }
      if (data.config && data.config.retencionDias != null) {
        guardarRetencionHistorialLocal(data.config.retencionDias);
        pintarConfigRetencionHistorialUI(data.config.retencionDias);
      }
    }
    mostrarToast('Tiempo de conservación del historial guardado', 'success');
    await refrescarHistorialEntregasUI({ omitirCargaConfig: true });
  } catch (e) {
    mostrarToast(String(e.message || e), 'error');
  }
}

async function refrescarHistorialEntregasUI(opts) {
  const host = document.getElementById('historialEntregasLista');
  if (!host) return;
  host.innerHTML = '<p class="historial-entregas-cargando">Cargando historial…</p>';
  if (!listaMensajerosCache.length && esSesionAdmin()) {
    try {
      await cargarMensajerosParaAsignacion();
    } catch (_e) {}
  }
  const sellados = asegurarFechasOperacionPedidosFinalizados();
  let guardados = cargarHistorialEntregasCacheLocal();
  let retencion = cargarRetencionHistorialLocal();
  let cargoDesdeServidor = false;
  try {
    if (appEstaOnline() && getAuthToken()) {
      const data = await apiJson('/api/historial-entregas', { method: 'GET' });
      if (Array.isArray(data.dias)) {
        guardados = data.dias;
        cargoDesdeServidor = true;
      }
      if (data.config && data.config.retencionDias != null) {
        retencion = Number(data.config.retencionDias);
        guardarRetencionHistorialLocal(retencion);
      }
    }
  } catch (e) {
    console.error(e);
  }
  if (!opts || !opts.omitirCargaConfig) {
    pintarConfigRetencionHistorialUI(retencion);
  }
  // Actualizar solo días presentes en pedidos actuales; conservar el resto del servidor/caché.
  const desdePedidos = reconstruirHistorialDesdePedidosActuales();
  let fusion = filtrarDiasHistorialPorRetencion(
    fusionarHistorialDias(guardados, desdePedidos),
    retencion
  );
  guardarHistorialEntregasCacheLocal(fusion);
  // Solo sincronizar al servidor si pudimos leer el historial remoto (merge seguro).
  // Si el GET falló, un PUT incompleto borraría días viejos.
  if (cargoDesdeServidor && appEstaOnline() && getAuthToken() && esSesionAdmin()) {
    try {
      const dataPut = await apiJson('/api/historial-entregas', {
        method: 'PUT',
        body: JSON.stringify({ dias: fusion }),
      });
      if (Array.isArray(dataPut.dias)) {
        fusion = dataPut.dias;
        guardarHistorialEntregasCacheLocal(fusion);
      }
    } catch (e) {
      console.error(e);
    }
  } else if (desdePedidos.length > 0 && appEstaOnline() && getAuthToken()) {
    // Sin GET exitoso: al menos upsert de los días reconstruidos (no borra otros).
    for (const dia of desdePedidos) {
      try {
        await apiJson('/api/historial-entregas/dia', {
          method: 'POST',
          body: JSON.stringify({ dia }),
        });
      } catch (e) {
        console.error(e);
      }
    }
  }
  if (sellados > 0) {
    mostrarToast(
      `${sellados} pedido(s) finalizado(s) sin fecha de historial se asignaron a hoy.`,
      'info',
      6000
    );
  }
  if (fusion.length === 0) {
    host.innerHTML =
      '<p class="historial-entregas-vacio">Aún no hay días registrados. Solo entran pedidos ya entregados, devueltos o sin entregar (no los pendientes ni en ruta). Al finalizar uno, aparecerá aquí.</p>';
    return;
  }
  host.innerHTML = fusion.map((d) => htmlTarjetaHistorialDia(d)).join('');
}

async function mostrarUiPaginaHistorialEntregas() {
  const page = document.getElementById('pageHistorialEntregas');
  const principal = document.getElementById('appVistaPrincipal');
  const pageUsuarios = document.getElementById('pageUsuariosRoles');
  if (pageUsuarios) {
    pageUsuarios.style.display = 'none';
    pageUsuarios.setAttribute('aria-hidden', 'true');
  }
  if (principal) {
    principal.style.display = 'none';
    principal.setAttribute('aria-hidden', 'true');
  }
  if (page) {
    page.style.display = 'block';
    page.removeAttribute('aria-hidden');
  }
  pintarConfigRetencionHistorialUI(cargarRetencionHistorialLocal());
  await refrescarHistorialEntregasUI();
  scrollToTopApp();
}

async function abrirPaginaHistorialEntregas() {
  cerrarMenuUsuario();
  if (!esSesionAdmin()) return;
  guardarVistaAppSesionHistorialEntregas();
  await mostrarUiPaginaHistorialEntregas();
}

function cerrarPaginaHistorialEntregas() {
  limpiarVistaAppSesion();
  const page = document.getElementById('pageHistorialEntregas');
  const principal = document.getElementById('appVistaPrincipal');
  if (page) {
    page.style.display = 'none';
    page.setAttribute('aria-hidden', 'true');
  }
  if (principal) {
    principal.style.display = '';
    principal.removeAttribute('aria-hidden');
  }
  scrollToTopApp();
}

async function iniciarFlujoAuth() {
  const pa = document.getElementById('pantallaAuth');
  const main = document.getElementById('mainApp');
  const errGlobal = document.getElementById('authErrorGlobal');
  if (errGlobal) errGlobal.textContent = '';

  const params = new URLSearchParams(window.location.search);
  const enVistaResetUrl = !!params.get('reset');
  const token = getAuthToken();

  /* Con sesión guardada: validar antes de mostrar login (evita parpadeo al recargar).
     Nunca borrar el token aquí: la sesión solo se cierra con el botón Salir. */
  if (token && !enVistaResetUrl) {
    try {
      const me = await apiJson('/api/me', { method: 'GET' });
      migrarTokenLegacySiHaceFalta(me.user.id);
      setAuthToken(token, me.user.id);
      await entrarAppConSesion(me.user);
      return;
    } catch (_e) {
      const entroLocal = await entrarConSesionLocalSiHayToken(token);
      if (entroLocal) {
        mostrarToast(
          appEstaOnline()
            ? 'No se pudo validar la sesión en el servidor. Usando datos guardados.'
            : 'Sin internet: entrando con la sesión y pedidos guardados en este dispositivo.',
          'warning',
          8000
        );
        return;
      }
      /* Token presente pero ilegible: no limpiar; mostrar login y reintentar luego. */
    }
  }

  document.documentElement.classList.add('auth-layout');
  document.body.classList.add('auth-layout');
  if (main) main.style.display = 'none';
  /* No mostrar #pantallaAuth hasta aplicar la pestaña correcta (evita ver “Iniciar sesión” y luego “Registro”). */

  let status;
  try {
    const r = await apiFetch('/api/auth/status');
    status = await r.json();
  } catch (_e) {
    if (errGlobal) {
      errGlobal.textContent =
        'No se pudo contactar el servidor. Ejecuta en la carpeta del proyecto: npm install y npm start. Luego abre http://localhost:3847 en el navegador.';
    }
    if (pa) pa.style.display = 'flex';
    return;
  }

  authHayUsuarios = !!status.hasUsers;
  actualizarTextosRegistroAuth();

  const enVistaReset = inicializarVistaResetDesdeUrl();
  if (!enVistaReset) {
    if (authHayUsuarios) {
      let tabGuardada = null;
      try {
        tabGuardada = sessionStorage.getItem(AUTH_TAB_SESSION_KEY);
      } catch (_e) {}
      if (tabGuardada === 'registro' || tabGuardada === 'login') {
        switchAuthTab(tabGuardada);
      } else {
        switchAuthTab('login');
      }
    } else {
      switchAuthTab('registro');
    }
  }

  if (pa) pa.style.display = 'flex';

  if (!window.__authFlujoInicializado) {
    window.__authFlujoInicializado = true;
    const tabLogin = document.getElementById('authTabLogin');
    const tabReg = document.getElementById('authTabRegistro');
    if (tabLogin) tabLogin.addEventListener('click', () => switchAuthTab('login'));
    if (tabReg) tabReg.addEventListener('click', () => switchAuthTab('registro'));
    const fl = document.getElementById('formLogin');
    if (fl) fl.addEventListener('submit', onSubmitLogin);
    configurarMostrarContrasenaLogin();
    const fr = document.getElementById('formRegistro');
    if (fr) fr.addEventListener('submit', onSubmitRegistro);
    document.getElementById('btnRecuperarClave')?.addEventListener('click', () => abrirModalRecuperarClave());
    document.getElementById('btnCerrarModalRecuperar')?.addEventListener('click', () => cerrarModalRecuperarClave());
    document.getElementById('btnComprobarCorreoRecuperar')?.addEventListener('click', () => {
      void comprobarCorreoParaRecuperacion();
    });
    document.getElementById('btnModalActualizarPass')?.addEventListener('click', () => {
      void solicitarTokenRecuperacionDesdeModal();
    });
    document.getElementById('btnModalRecuperarOtraCuenta')?.addEventListener('click', () => {
      volverModalRecuperarAOtroCorreo();
    });
    document.getElementById('btnModalGuardarNuevaPass')?.addEventListener('click', () => {
      void guardarNuevaContrasenaModalRecuperar();
    });
    document.getElementById('btnModalCancelarNuevaPass')?.addEventListener('click', () => {
      cancelarFormNuevaPassModalRecuperar();
    });
    document.getElementById('btnGuardarResetPass')?.addEventListener('click', () => {
      void guardarNuevaContrasenaDesdeReset();
    });
    document.getElementById('btnCancelarReset')?.addEventListener('click', () => cancelarVistaResetPassword());
    const modalRec = document.getElementById('modalRecuperarClave');
    if (modalRec) {
      modalRec.addEventListener('click', (e) => {
        if (e.target === modalRec) cerrarModalRecuperarClave();
      });
    }
  }
}

function sincronizarSesionDesdeOtraPestana() {
  if (!sesionUsuario) return;
  const token = getAuthToken();
  if (!token) {
    /* Solo si otra pestaña cerró sesión con el botón Salir (token borrado). */
    cerrarSesionApp();
    return;
  }
  void (async () => {
    try {
      const me = await apiJson('/api/me', { method: 'GET' });
      if (String(me.user.id) === String(sesionUsuario.id)) return;
      setAuthToken(token, me.user.id);
      await entrarAppConSesion(me.user);
      mostrarToast(
        `Sesión actualizada: ahora estás como ${me.user.username} (${me.user.role === 'admin' ? 'Administrador' : 'Mensajero'}).`,
        'info',
        8000
      );
    } catch (_e) {
      /* Fallo de red/API: mantener la sesión actual; no cerrar ni recargar. */
    }
  })();
}

document.addEventListener('DOMContentLoaded', () => {
  configurarSoporteOfflineApp();
  configurarRetornoNotificarClientePorteria();
  window.addEventListener('storage', (ev) => {
    if (
      ev.key === AUTH_ACTIVE_USER_KEY ||
      ev.key === AUTH_USER_ID_KEY ||
      ev.key === AUTH_TOKEN_LEGACY_KEY ||
      (ev.key && String(ev.key).startsWith('deliveryAuthToken_'))
    ) {
      sincronizarSesionDesdeOtraPestana();
    }
  });
  void iniciarFlujoAuth();
});
