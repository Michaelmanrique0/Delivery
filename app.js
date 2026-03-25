let pedidos = [];
let supabaseCliente = null;
let sesionActiva = null;
let perfilUsuario = null;
let usuariosRegistrados = [];
let persistTimeoutId = null;
let canalRealtimePedidos = null;
let recargaPedidosRealtimeTimer = null;
let bootSesionEjecutando = false;
let bootSesionCola = false;
/** Evita doble boot si SIGNED_IN llega mientras iniciarSesion ya llama a bootSesionYDatos. */
let enFlujoLoginManual = false;
let refrescoPerfilEnCurso = false;
let cargaUsuariosAdminEnCurso = false;
let enSalidaDePagina = false;

// Exponer estado mínimo para depuración desde consola (no incluye keys).
function exponerDebugAppDelivery() {
  try {
    window.__appDelivery = {
      get supabaseReady() { return !!supabaseCliente; },
      get session() { return sesionActiva || null; },
      get userId() { return sesionActiva?.user?.id; },
      get profile() { return perfilUsuario || null; },
      get esAdmin() { return esAdmin(); },
      get esAdminVisual() { return esAdminVisual(); },
      recargarPerfil: () => refrescarPerfilUsuario(),
      recargarUsuariosAdmin: () => cargarUsuariosParaAdmin(),
      recargarPedidos: () => cargarPedidosDesdeSupabase().then(() => renderPedidos()),
    };
  } catch (_e) {}
}

// Recuerda la última pantalla *por pestaña* (sessionStorage).
// Requisito: si recargas estando en login, NO debe auto-entrar; si recargas dentro, debe seguir dentro.
const SS_LAST_SCREEN_KEY = 'app_delivery_last_screen';
const SS_ADMIN_USER_ID_KEY = 'app_delivery_admin_user_id';

function ssGet(key) {
  try { return window.sessionStorage ? window.sessionStorage.getItem(key) : null; } catch (_e) { return null; }
}

function ssSet(key, value) {
  try { if (window.sessionStorage) window.sessionStorage.setItem(key, String(value)); } catch (_e) {}
}

function wasLoginScreenBeforeReload() {
  // Por defecto (pestaña nueva) queremos quedarnos en login.
  // Solo auto-entramos si esta pestaña estaba en "main" antes de recargar.
  return ssGet(SS_LAST_SCREEN_KEY) !== 'main';
}

function marcarPantallaLogin() {
  ssSet(SS_LAST_SCREEN_KEY, 'login');
}

function marcarPantallaMain() {
  ssSet(SS_LAST_SCREEN_KEY, 'main');
}

function marcarHintAdminSesion(userId) {
  if (!userId) return;
  ssSet(SS_ADMIN_USER_ID_KEY, userId);
}

function limpiarHintAdminSesion() {
  try { if (window.sessionStorage) window.sessionStorage.removeItem(SS_ADMIN_USER_ID_KEY); } catch (_e) {}
}

function aplicarHintAdminSesion() {
  const uid = sesionActiva?.user?.id;
  if (!uid) return false;
  const hintUid = ssGet(SS_ADMIN_USER_ID_KEY);
  if (hintUid !== uid) return false;
  if (esAdmin()) return true;
  const u = sesionActiva.user;
  perfilUsuario = {
    id: u.id,
    email: u.email || '',
    full_name: (u.user_metadata && u.user_metadata.full_name) || '',
    role: 'admin',
    created_at: null
  };
  return true;
}

function hayHintAdminSesionActual() {
  const uid = sesionActiva?.user?.id;
  if (!uid) return false;
  return ssGet(SS_ADMIN_USER_ID_KEY) === uid;
}

function esAdminVisual() {
  return esAdmin() || hayHintAdminSesionActual();
}
let mapa = null;
let marcadores = [];
let rutaLayer = null;
let mapaAjustado = false;
let nextPedidoId = 1;
let vistaPedidosActual = 'pendientes';
let vistaPedidosSeleccionadaManual = false;
const TELEFONO_SOPORTE = '3213153165';
const CONFIG_NOTIFICACION_KEY = 'configNotificacionPago';
const CACHE_USUARIOS_ADMIN_KEY = 'cacheUsuariosAdmin_v1';
/** @deprecated Caché global; la app usa caché por usuario (ver keyCachePedidosUser). Se limpia al boot por compatibilidad. */
const CACHE_PEDIDOS_LEGACY_KEY = 'cachePedidos_v1';

function keyCachePedidosUser(userId) {
  if (!userId) return null;
  return `cachePedidos_v1_${String(userId)}`;
}

/** UUID en minúsculas para coincidir con auth.uid() y columnas uuid en Postgres. */
function normalizarUuidAsignacion(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  return s.toLowerCase();
}

function limpiarCachePedidosUsuario(userId) {
  try {
    localStorage.removeItem(CACHE_PEDIDOS_LEGACY_KEY);
    const k = keyCachePedidosUser(userId);
    if (k) localStorage.removeItem(k);
  } catch (_e) {}
}
const CONFIG_NOTIFICACION_DEFAULT = {
  tieneNequi: true,
  tieneDaviplata: true,
  numeroDigital: '3143645061',
  tieneLlave: true,
  llavePago: '@NEQUIMIC7057'
};

let configNotificacionPago = cargarConfigNotificacionPago();

function cargarCacheUsuariosAdmin() {
  try {
    const raw = localStorage.getItem(CACHE_USUARIOS_ADMIN_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x) => x && x.id);
  } catch (_e) {
    return [];
  }
}

function guardarCacheUsuariosAdmin() {
  try {
    const compact = (usuariosRegistrados || []).map((u) => ({
      id: u.id,
      email: u.email || '',
      full_name: u.full_name || '',
      role: u.role || '',
      created_at: u.created_at || null
    }));
    localStorage.setItem(CACHE_USUARIOS_ADMIN_KEY, JSON.stringify(compact));
  } catch (_e) {}
}

function cargarConfigNotificacionPago() {
  try {
    const guardado = JSON.parse(localStorage.getItem(CONFIG_NOTIFICACION_KEY) || '{}');
    const numeroLegacy = String(guardado.numeroNequi || guardado.numeroDaviplata || '');
    const boolSeguro = (valor, predeterminado) => {
      if (typeof valor === 'boolean') return valor;
      if (typeof valor === 'string') {
        const normalizado = valor.trim().toLowerCase();
        if (normalizado === 'false') return false;
        if (normalizado === 'true') return true;
      }
      return predeterminado;
    };
    return {
      tieneNequi: boolSeguro(guardado.tieneNequi, true),
      tieneDaviplata: boolSeguro(guardado.tieneDaviplata, true),
      numeroDigital: String(guardado.numeroDigital || numeroLegacy || CONFIG_NOTIFICACION_DEFAULT.numeroDigital),
      tieneLlave: boolSeguro(guardado.tieneLlave, true),
      llavePago: String(guardado.llavePago || CONFIG_NOTIFICACION_DEFAULT.llavePago)
    };
  } catch (e) {
    return { ...CONFIG_NOTIFICACION_DEFAULT };
  }
}

function guardarConfigNotificacionPago() {
  localStorage.setItem(CONFIG_NOTIFICACION_KEY, JSON.stringify(configNotificacionPago));
}

function cargarCachePedidos() {
  try {
    const k = keyCachePedidosUser(sesionActiva?.user?.id);
    if (!k) return [];
    const raw = localStorage.getItem(k);
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
    const k = keyCachePedidosUser(sesionActiva?.user?.id);
    if (!k) return;
    const lista = Array.isArray(pedidos) ? pedidos : [];
    const dedup = deduplicarPedidosPorId(lista);
    localStorage.setItem(k, JSON.stringify(dedup));
  } catch (_e) {}
}

function deduplicarPedidosPorId(lista) {
  const map = new Map();
  (Array.isArray(lista) ? lista : []).forEach((p) => {
    const id = p && p.id != null ? Number(p.id) : null;
    if (!id || !Number.isFinite(id)) return;
    // Último gana: si hay duplicado, conservamos el más reciente en el array.
    map.set(id, p);
  });
  return Array.from(map.values()).sort((a, b) => Number(a.id) - Number(b.id));
}

function actualizarVisibilidadConfigNotificacion() {
  const numeroDigitalWrap = document.getElementById('cfgNumeroDigitalWrap');
  const llaveWrap = document.getElementById('cfgLlaveWrap');
  const tieneNequi = document.getElementById('cfgTieneNequi');
  const tieneDaviplata = document.getElementById('cfgTieneDaviplata');
  const tieneLlave = document.getElementById('cfgTieneLlave');
  const mostrarNumeroDigital = !!(tieneNequi && tieneDaviplata && (tieneNequi.checked || tieneDaviplata.checked));
  if (numeroDigitalWrap) numeroDigitalWrap.style.display = mostrarNumeroDigital ? 'block' : 'none';
  if (llaveWrap && tieneLlave) llaveWrap.style.display = tieneLlave.checked ? 'block' : 'none';
}

function cargarConfigNotificacionEnUI() {
  const tieneNequi = document.getElementById('cfgTieneNequi');
  const tieneDaviplata = document.getElementById('cfgTieneDaviplata');
  const numeroDigital = document.getElementById('cfgNumeroDigital');
  const tieneLlave = document.getElementById('cfgTieneLlave');
  const llavePago = document.getElementById('cfgLlavePago');
  if (!tieneNequi || !numeroDigital || !tieneDaviplata || !tieneLlave || !llavePago) return;

  tieneNequi.checked = !!configNotificacionPago.tieneNequi;
  numeroDigital.value = configNotificacionPago.numeroDigital || '';
  tieneDaviplata.checked = !!configNotificacionPago.tieneDaviplata;
  tieneLlave.checked = !!configNotificacionPago.tieneLlave;
  llavePago.value = configNotificacionPago.llavePago || '';

  [tieneNequi, tieneDaviplata, tieneLlave].forEach((el) => {
    el.onchange = () => {
      actualizarVisibilidadConfigNotificacion();
    };
  });
  if (numeroDigital) numeroDigital.onchange = () => {};
  if (llavePago) llavePago.onchange = () => {};
  actualizarVisibilidadConfigNotificacion();
}

function abrirConfigNotificacion() {
  // Admin no configura medios de pago para notificación del cliente.
  if (esAdminVisual()) return;
  cargarConfigNotificacionEnUI();
  const modal = document.getElementById('modalConfigNotificacion');
  if (!modal) return;
  modal.style.display = 'flex';
}

function cerrarConfigNotificacion() {
  // Descarta cambios no guardados y restaura lo persistido
  cargarConfigNotificacionEnUI();
  const modal = document.getElementById('modalConfigNotificacion');
  if (!modal) return;
  modal.style.display = 'none';
}

function abrirConfigNotificacionDesdeMenu() {
  cerrarMenuUsuario();
  abrirConfigNotificacion();
}

function guardarConfigNotificacionDesdeUI(mostrarMensaje = true) {
  if (esAdminVisual()) return;
  const tieneNequi = document.getElementById('cfgTieneNequi');
  const tieneDaviplata = document.getElementById('cfgTieneDaviplata');
  const numeroDigital = document.getElementById('cfgNumeroDigital');
  const tieneLlave = document.getElementById('cfgTieneLlave');
  const llavePago = document.getElementById('cfgLlavePago');
  if (!tieneNequi || !numeroDigital || !tieneDaviplata || !tieneLlave || !llavePago) return;

  configNotificacionPago = {
    tieneNequi: !!tieneNequi.checked,
    tieneDaviplata: !!tieneDaviplata.checked,
    numeroDigital: String(numeroDigital.value || '').replace(/\D/g, ''),
    tieneLlave: !!tieneLlave.checked,
    llavePago: String(llavePago.value || '').trim()
  };

  guardarConfigNotificacionPago();
  cargarConfigNotificacionEnUI();
  if (mostrarMensaje) cerrarConfigNotificacion();
  if (mostrarMensaje) {
    mostrarModalDecision({
      titulo: 'Configuración guardada',
      texto: 'La configuración de medios de pago fue actualizada.',
      textoConfirmar: 'Aceptar',
      claseConfirmar: 'btn-success',
      mostrarSecundario: false,
      textoCancelar: 'Cerrar',
      onConfirmar: () => {},
      onCancelar: () => {}
    });
  }
}

function construirBloquePagoNotificacion() {
  const lineas = [];
  if (configNotificacionPago.tieneNequi && configNotificacionPago.numeroDigital) {
    lineas.push(`- Nequi: ${configNotificacionPago.numeroDigital}`);
  }
  if (configNotificacionPago.tieneDaviplata && configNotificacionPago.numeroDigital) {
    lineas.push(`- Daviplata: ${configNotificacionPago.numeroDigital}`);
  }
  if (configNotificacionPago.tieneLlave && configNotificacionPago.llavePago) {
    lineas.push(`- Bre-B: ${configNotificacionPago.llavePago}`);
  }

  if (lineas.length === 0) {
    return 'Actualmente no hay medios de pago digitales configurados.';
  }
  return `Si deseas pagar por transferencia, usa:\n${lineas.join('\n')}`;
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

function abrirWhatsAppConTexto(telefono, mensaje) {
  const limpio = String(telefono || '').replace(/\D/g, '');
  if (!limpio) return;
  const wa = limpio.startsWith('57') ? limpio : `57${limpio}`;
  const texto = encodeURIComponent(normalizarTextoParaWhatsApp(mensaje));
  const url = `https://api.whatsapp.com/send?phone=${wa}&text=${texto}&src=delivery&t=${Date.now()}`;
  window.open(url, '_blank');
}

function esAdmin() {
  if (!sesionActiva || !perfilUsuario) return false;
  const r = String(perfilUsuario.role ?? '').toLowerCase().trim();
  return r === 'admin';
}

function syncMainAdminClass() {
  const mainAppEl = document.getElementById('mainApp');
  const secPegar = document.getElementById('sectionPegarPedido');
  const admin = esAdminVisual();
  if (mainAppEl) {
    mainAppEl.classList.toggle('app-es-admin', admin);
  }
  if (secPegar) {
    secPegar.style.setProperty('display', admin ? 'block' : 'none', 'important');
  }
  if (esAdmin() && sesionActiva?.user?.id) {
    marcarHintAdminSesion(sesionActiva.user.id);
  }
}

// Supabase exige un email interno: si el usuario no escribe @, se usa un dominio reservado (.invalid).
const DOMINIO_USUARIO_INTERNO = 'users.app-delivery.invalid';

function emailDesdeCampoUsuario(usuarioRaw) {
  const u = String(usuarioRaw || '').trim();
  if (!u) return '';
  if (u.includes('@')) return u.toLowerCase();
  const slug = u
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) return '';
  return `${slug}@${DOMINIO_USUARIO_INTERNO}`;
}

function usuarioLoginVisible(email) {
  const mail = String(email || '');
  const sufijo = `@${DOMINIO_USUARIO_INTERNO}`;
  if (mail.endsWith(sufijo)) return mail.slice(0, -sufijo.length);
  return mail;
}

function etiquetaUsuarioEnCabecera() {
  if (!perfilUsuario) return '';
  const nombre = (perfilUsuario.full_name || '').trim();
  if (nombre) return nombre;
  const mail = String(perfilUsuario.email || '');
  if (mail.endsWith(`@${DOMINIO_USUARIO_INTERNO}`)) return usuarioLoginVisible(mail);
  return 'Usuario';
}

/** Nombre del registro (metadata o perfil); nunca muestra un correo con @. */
function nombreRegistradoDesdeAuthUser() {
  const u = sesionActiva?.user;
  if (!u) return '';
  const meta = u.user_metadata;
  const n = meta && typeof meta.full_name === 'string' ? meta.full_name.trim() : '';
  if (n) return n;
  const mail = String(u.email || '');
  if (mail.endsWith(`@${DOMINIO_USUARIO_INTERNO}`)) return usuarioLoginVisible(mail);
  return 'Usuario';
}

function nombreMetaSesion() {
  const m = sesionActiva?.user?.user_metadata;
  const n = m && typeof m.full_name === 'string' ? m.full_name.trim() : '';
  return n || '';
}

function nombreParaMenuUsuario() {
  const meta = nombreMetaSesion();
  if (perfilUsuario) {
    const n = (perfilUsuario.full_name || '').trim();
    if (n) return n;
    if (meta) return meta;
    const mail = String(perfilUsuario.email || '');
    if (mail.endsWith(`@${DOMINIO_USUARIO_INTERNO}`)) return usuarioLoginVisible(mail);
    return 'Usuario';
  }
  if (meta) return meta;
  return nombreRegistradoDesdeAuthUser();
}

function pedidoNuevoBase() {
  return {
    assignedTo: null,
    createdBy: sesionActiva?.user?.id ?? null,
    enCurso: false,
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

function rowToPedido(r) {
  const coords = (r.coords_lat != null && r.coords_lng != null && Number.isFinite(Number(r.coords_lat)) && Number.isFinite(Number(r.coords_lng)))
    ? { lat: Number(r.coords_lat), lng: Number(r.coords_lng) }
    : null;
  let productos = [];
  if (Array.isArray(r.productos)) productos = r.productos;
  else if (typeof r.productos === 'string') {
    try { productos = JSON.parse(r.productos); } catch (e) { productos = []; }
  }
  return {
    id: Number(r.id),
    assignedTo: r.assigned_to != null && String(r.assigned_to).trim() !== ''
      ? normalizarUuidAsignacion(r.assigned_to)
      : null,
    createdBy: r.created_by || null,
    nombre: r.nombre || '',
    telefono: r.telefono || '',
    direccion: r.direccion || '',
    valor: String(r.valor != null ? r.valor : '0'),
    textoOriginal: r.texto_original || '',
    mapUrl: r.map_url || '',
    coords,
    enCurso: !!r.en_curso,
    posicionPendiente: Number.isInteger(Number(r.posicion_pendiente)) ? Number(r.posicion_pendiente) : null,
    entregado: !!r.entregado,
    noEntregado: !!r.no_entregado,
    envioRecogido: !!r.envio_recogido,
    notificadoEnCamino: !!r.notificado_en_camino,
    llegoDestino: !!r.llego_destino,
    cancelado: !!r.cancelado,
    metodoPagoEntrega: r.metodo_pago_entrega || '',
    montoNequi: Number(r.monto_nequi || 0),
    montoDaviplata: Number(r.monto_daviplata || 0),
    montoEfectivo: Number(r.monto_efectivo || 0)
  };
}

function pedidoToRow(p, sortIndex) {
  return {
    id: p.id,
    assigned_to: normalizarUuidAsignacion(p.assignedTo),
    created_by: p.createdBy || sesionActiva?.user?.id || null,
    nombre: p.nombre || '',
    telefono: p.telefono || '',
    direccion: p.direccion || '',
    valor: String(p.valor || '0'),
    map_url: p.mapUrl || null,
    texto_original: p.textoOriginal || null,
    coords_lat: p.coords && Number.isFinite(Number(p.coords.lat)) ? Number(p.coords.lat) : null,
    coords_lng: p.coords && Number.isFinite(Number(p.coords.lng)) ? Number(p.coords.lng) : null,
    productos: p.productos || [],
    en_curso: !!p.enCurso,
    posicion_pendiente: Number.isInteger(p.posicionPendiente) ? p.posicionPendiente : null,
    entregado: !!p.entregado,
    no_entregado: !!p.noEntregado,
    envio_recogido: !!p.envioRecogido,
    notificado_en_camino: !!p.notificadoEnCamino,
    llego_destino: !!p.llegoDestino,
    cancelado: !!p.cancelado,
    metodo_pago_entrega: p.metodoPagoEntrega || '',
    monto_nequi: Number(p.montoNequi || 0),
    monto_daviplata: Number(p.montoDaviplata || 0),
    monto_efectivo: Number(p.montoEfectivo || 0),
    sort_index: sortIndex,
    updated_at: new Date().toISOString()
  };
}

function esErrorLockAuthSupabase(msg) {
  return /lock:sb-|stole it|released because another request/i.test(String(msg || ''));
}

function pausaMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function withTimeout(promise, ms, etiqueta) {
  const resultado = await Promise.race([
    promise,
    pausaMs(ms).then(() => ({ __timeout: true }))
  ]);
  if (resultado && resultado.__timeout) {
    return { __timeout: true, etiqueta };
  }
  return resultado;
}

/** Evita quedarse en “Comprobando sesión…” si getSession() no termina (pocos segundos bastan). */
async function obtenerSesionInicialConTimeout(ms) {
  try {
    const resultado = await Promise.race([
      supabaseCliente.auth.getSession(),
      pausaMs(ms).then(() => ({ __timeout: true }))
    ]);
    if (resultado && resultado.__timeout) {
      console.warn('getSession superó el tiempo de espera; se muestra el login.');
      return { session: null, error: null };
    }
    const err = resultado?.error ?? null;
    const session = resultado?.data?.session ?? null;
    return { session, error: err };
  } catch (e) {
    console.error(e);
    return { session: null, error: e };
  }
}

async function cargarPedidosDesdeSupabase() {
  if (!supabaseCliente || !sesionActiva) return;
  const maxIntentos = 4;
  for (let intento = 0; intento < maxIntentos; intento++) {
    const res = await withTimeout(
      supabaseCliente
        .from('pedidos')
        .select('*')
        .order('sort_index', { ascending: true })
        .order('id', { ascending: true }),
      8000,
      'pedidos.select'
    );
    if (res && res.__timeout) {
      // Fallback REST directo (evita cuelgues por getSession()).
      try {
        const token = sesionActiva?.access_token;
        const url = `${window.SUPABASE_URL}/rest/v1/pedidos?select=*&order=sort_index.asc,id.asc`;
        const resp = await withTimeout(
          fetch(url, {
            headers: {
              apikey: window.SUPABASE_ANON_KEY,
              Authorization: `Bearer ${token}`
            }
          }),
          8000,
          'pedidos.fetch'
        );
        if (resp && resp.__timeout) {
          continue;
        }
        if (!resp || !resp.ok) {
          const status = resp ? resp.status : 'ERR';
          console.warn('[app-delivery] pedidos REST HTTP', status);
          continue;
        }
        const dataJson = await resp.json();
        const rows = Array.isArray(dataJson) ? dataJson : [];
        if (rows.length === 0) {
          // Si por red/RLS llega vacío, no borres lo que ya tenemos en cache local.
          if (!Array.isArray(pedidos) || pedidos.length === 0) {
            pedidos = deduplicarPedidosPorId(cargarCachePedidos());
          }
        } else {
          pedidos = deduplicarPedidosPorId(rows.map(rowToPedido));
          guardarCachePedidos();
        }
        if (pedidos.length > 0) nextPedidoId = Math.max(...pedidos.map((p) => p.id), 0) + 1;
        else nextPedidoId = 1;
        return;
      } catch (e) {
        console.error(e);
        continue;
      }
    }
    const { data, error } = res || {};
    if (!error) {
      const rows = data || [];
      if (rows.length === 0) {
        // No borrar cache local si supabase devuelve vacío.
        if (!Array.isArray(pedidos) || pedidos.length === 0) {
          pedidos = deduplicarPedidosPorId(cargarCachePedidos());
        }
      } else {
        pedidos = deduplicarPedidosPorId(rows.map(rowToPedido));
        guardarCachePedidos();
      }
      if (pedidos.length > 0) {
        nextPedidoId = Math.max(...pedidos.map((p) => p.id), 0) + 1;
      } else {
        nextPedidoId = 1;
      }
      return;
    }
    console.error(error);
    const msg = String(error.message || '');
    if (esErrorLockAuthSupabase(msg) && intento < maxIntentos - 1) {
      await pausaMs(180 + intento * 280);
      continue;
    }
    alert('No se pudieron cargar los pedidos: ' + msg);
    return;
  }
}

async function persistPedidosToSupabase(opciones = {}) {
  if (!supabaseCliente || !sesionActiva) return;
  const rows = pedidos.map((p, i) => pedidoToRow(p, i));
  if (rows.length === 0) return;
  const silent = !!opciones.silent;

  const intentarUpsertRest = async () => {
    const token = sesionActiva?.access_token;
    const url = `${window.SUPABASE_URL}/rest/v1/pedidos?on_conflict=id`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        apikey: window.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal'
      },
      body: JSON.stringify(rows),
      // keepalive solo ayuda en unload, pero también puede fallar; lo dejamos por defecto.
      keepalive: !!opciones.keepalive
    });
    return resp;
  };

  try {
    const res = await withTimeout(
      supabaseCliente.from('pedidos').upsert(rows, { onConflict: 'id' }),
      8000,
      'pedidos.upsert'
    );
    if (res && res.__timeout) {
      const resp = await intentarUpsertRest();
      if (!resp.ok) {
        console.warn('[app-delivery] pedidos upsert REST HTTP', resp.status);
        if (!silent) alert('Error al guardar pedidos (HTTP ' + resp.status + ').');
      }
      return;
    }
    const { error } = res || {};
    if (!error) return;

    console.error(error);
    // Si el cliente falló por red, intentamos REST.
    try {
      const resp = await intentarUpsertRest();
      if (!resp.ok) {
        console.warn('[app-delivery] pedidos upsert REST HTTP', resp.status);
        if (!silent) alert('Error al guardar pedidos (HTTP ' + resp.status + ').');
      }
      return;
    } catch (e2) {
      console.error(e2);
      if (!silent) alert('Error al guardar pedidos: ' + (error.message || 'Fallo de red'));
      return;
    }
  } catch (e) {
    console.error(e);
    try {
      const resp = await intentarUpsertRest();
      if (!resp.ok) {
        console.warn('[app-delivery] pedidos upsert REST HTTP', resp.status);
        if (!silent) alert('Error al guardar pedidos (HTTP ' + resp.status + ').');
      }
    } catch (e2) {
      console.error(e2);
      if (!silent) alert('Error al guardar pedidos: ' + (e.message || 'Fallo de red'));
    }
  }
}

function programarRecargaPedidosPorRealtime() {
  if (recargaPedidosRealtimeTimer) clearTimeout(recargaPedidosRealtimeTimer);
  recargaPedidosRealtimeTimer = setTimeout(() => {
    recargaPedidosRealtimeTimer = null;
    if (!sesionActiva) return;
    cargarPedidosDesdeSupabase().then(() => {
      renderPedidos();
      actualizarMarcadores();
    });
  }, 500);
}

function suscribirRealtimePedidos() {
  if (!supabaseCliente || !sesionActiva || canalRealtimePedidos) return;
  canalRealtimePedidos = supabaseCliente
    .channel('pedidos-cambios')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'pedidos' }, () => {
      programarRecargaPedidosPorRealtime();
    })
    .subscribe();
}

function desuscribirRealtimePedidos() {
  if (recargaPedidosRealtimeTimer) {
    clearTimeout(recargaPedidosRealtimeTimer);
    recargaPedidosRealtimeTimer = null;
  }
  if (canalRealtimePedidos && supabaseCliente) {
    supabaseCliente.removeChannel(canalRealtimePedidos);
    canalRealtimePedidos = null;
  }
}

function inicializarClienteSupabase() {
  const url = typeof window !== 'undefined' ? window.SUPABASE_URL : '';
  const key = typeof window !== 'undefined' ? window.SUPABASE_ANON_KEY : '';
  if (!url || !key || String(url).includes('TU-PROYECTO') || String(key).includes('TU_CLAVE')) {
    alert('Configura SUPABASE_URL y SUPABASE_ANON_KEY en supabase-config.js (copia desde supabase-config.example.js).');
    return null;
  }
  const { createClient } = window.supabase;
  if (!createClient) {
    alert('No se cargó la librería de Supabase.');
    return null;
  }
  const client = createClient(url, key, {
    auth: {
      // lock: false NO desactiva el LockManager (es falsy y gotrue cae en navigator.locks).
      // Hay que pasar un lock explícito que ejecute el callback sin Web Locks.
      lock: async (_name, _acquireTimeout, fn) => await fn(),
      // Evita choques con otros clientes GoTrue en el mismo navegador (incluye pruebas en consola).
      // Si se comparte storageKey, getSession() puede quedarse colgado por locks/carreras.
      storageKey: 'app-delivery-auth',
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: true
    }
  });
  try { window.supabaseCliente = client; } catch (_e) {}
  return client;
}

function filaPerfilDesdeRpc(data) {
  if (data == null) return null;
  if (Array.isArray(data)) return data[0] ?? null;
  return data;
}

/** PostgREST / RPC pueden devolver filas con matices de forma; unificamos a lo que usa la app. */
function perfilNormalizadoDesdeFila(row) {
  if (!row || typeof row !== 'object') return null;
  const id = row.id;
  if (!id) return null;
  const roleRaw = row.role ?? row.Role;
  const email = row.email ?? row.Email ?? '';
  const full_name = row.full_name ?? row.fullName ?? '';
  const created_at = row.created_at ?? row.createdAt ?? null;
  return {
    id,
    email: String(email || ''),
    full_name: String(full_name || ''),
    role: String(roleRaw != null ? roleRaw : 'repartidor')
      .toLowerCase()
      .trim() || 'repartidor',
    created_at
  };
}

function rpcDevuelveVerdadero(data) {
  if (data === true || data === 'true' || data === 't' || data === 1 || data === '1') return true;
  if (Array.isArray(data)) {
    if (data.length === 0) return false;
    return rpcDevuelveVerdadero(data[0]);
  }
  if (data && typeof data === 'object') {
    if (Object.prototype.hasOwnProperty.call(data, 'is_admin')) {
      return rpcDevuelveVerdadero(data.is_admin);
    }
    if (Object.prototype.hasOwnProperty.call(data, 'value')) {
      return rpcDevuelveVerdadero(data.value);
    }
    const vals = Object.values(data);
    if (vals.length === 1) return rpcDevuelveVerdadero(vals[0]);
  }
  return false;
}

/** Si la BD dice que eres admin (función is_admin), fuerza role admin en memoria (repara RLS, caché o columnas raras). */
async function aplicarPerfilAdminSiIsAdminRpc() {
  if (!supabaseCliente || !sesionActiva?.user?.id) return false;
  if (esAdmin()) return true;
  const { data, error } = await supabaseCliente.rpc('is_admin');
  if (error) {
    console.warn('[app-delivery] RPC is_admin:', error.message);
    return false;
  }
  if (!rpcDevuelveVerdadero(data)) return false;
  const u = sesionActiva.user;
  if (perfilUsuario && perfilUsuario.id === u.id) {
    perfilUsuario = { ...perfilUsuario, role: 'admin' };
  } else {
    perfilUsuario = {
      id: u.id,
      email: u.email || '',
      full_name: (u.user_metadata && u.user_metadata.full_name) || '',
      role: 'admin',
      created_at: perfilUsuario && perfilUsuario.created_at ? perfilUsuario.created_at : null
    };
  }
  marcarHintAdminSesion(u.id);
  return true;
}

async function asegurarUIAdminDesdeRpc() {
  if (!sesionActiva?.user?.id) return;
  // Si ya es admin, igual puede faltar cargar la lista de usuarios tras recargar.
  if (!esAdmin()) {
    const ok = await aplicarPerfilAdminSiIsAdminRpc();
    if (!ok) return;
  }
  syncMainAdminClass();
  const taPegar = document.getElementById('textoPedido');
  if (taPegar) taPegar.readOnly = false;
  const btnProc = document.getElementById('btnProcesarPedido');
  if (btnProc) btnProc.disabled = false;
  const panelAdmin = document.getElementById('panelAdmin');
  if (panelAdmin) panelAdmin.style.display = 'block';
  const btnElim = document.getElementById('btnEliminarTodos');
  if (btnElim) btnElim.style.display = 'inline-flex';
  // Cargar/recargar usuarios admin (por recargas puede quedar vacío).
  void cargarUsuariosParaAdmin();
}

async function refrescarPerfilUsuario() {
  try {
    if (!supabaseCliente || !sesionActiva?.user?.id) {
      perfilUsuario = null;
      return;
    }
    // En recarga, no esconder secciones admin mientras llega la verificación remota.
    aplicarHintAdminSesion();
    const { data: rpcData, error: rpcError } = await supabaseCliente.rpc('get_my_profile');
    if (!rpcError) {
      const row = perfilNormalizadoDesdeFila(filaPerfilDesdeRpc(rpcData));
      if (row) {
        perfilUsuario = row;
        return;
      }
    } else if (!String(rpcError.message || '').includes('get_my_profile')) {
      console.error(rpcError);
    }

    const maxIntentos = 3;
    for (let intento = 0; intento < maxIntentos; intento++) {
      const { data, error } = await supabaseCliente
        .from('profiles')
        .select('id,email,full_name,role,created_at')
        .eq('id', sesionActiva.user.id)
        .maybeSingle();
      if (!error) {
        if (data === null && intento < maxIntentos - 1) {
          await pausaMs(350 + intento * 200);
          continue;
        }
        perfilUsuario = data ? perfilNormalizadoDesdeFila(data) : null;
        if (perfilUsuario === null) {
          console.warn(
            '[app-delivery] No hay fila en public.profiles para tu usuario (id = auth.uid). La app usa esa tabla para el rol admin, no el panel de Authentication.'
          );
        }
        return;
      }
      console.error(error);
      const msg = String(error.message || '');
      if (esErrorLockAuthSupabase(msg) && intento < maxIntentos - 1) {
        await pausaMs(120 + intento * 180);
        continue;
      }
      perfilUsuario = null;
      return;
    }
  } finally {
    try {
      if (sesionActiva?.user?.id) {
        await aplicarPerfilAdminSiIsAdminRpc();
      }
    } catch (e) {
      console.warn(e);
    }
    syncMainAdminClass();
  }
}

async function cargarUsuariosParaAdmin() {
  if (!supabaseCliente || !sesionActiva?.user?.id) return;
  if (cargaUsuariosAdminEnCurso) return;
  // En recargas puede estar admin “visual” (hint) pero aún no aplicado en perfilUsuario.
  // Intentamos elevar por RPC antes de abandonar.
  if (!esAdmin()) {
    try { await aplicarPerfilAdminSiIsAdminRpc(); } catch (_e) {}
  }
  if (!esAdmin()) return;
  cargaUsuariosAdminEnCurso = true;
  const cont = document.getElementById('listaUsuariosAdmin');
  if (cont && (!usuariosRegistrados || usuariosRegistrados.length === 0)) {
    const cache = cargarCacheUsuariosAdmin();
    if (cache.length > 0) {
      usuariosRegistrados = cache;
      renderPanelAdminUsuarios();
    } else {
      cont.innerHTML = `<div class="admin-usuarios-ayuda">Cargando usuarios…</div>`;
    }
  }

  try {
    const maxIntentos = 3;
    for (let intento = 0; intento < maxIntentos; intento++) {
      console.debug('[app-delivery] cargarUsuariosParaAdmin intento', intento + 1);
      const res = await withTimeout(
        supabaseCliente
          .from('profiles')
          .select('id,email,full_name,role,created_at')
          .order('created_at', { ascending: true }),
        8000,
        'profiles.select'
      );
      if (res && res.__timeout) {
        // Fallback: si la librería se cuelga esperando getSession(), usa REST directo con access_token.
        try {
          const url = `${window.SUPABASE_URL}/rest/v1/profiles?select=id,email,full_name,role,created_at&order=created_at.asc`;
          const token = sesionActiva?.access_token;
          const resp = await withTimeout(
            fetch(url, {
              headers: {
                apikey: window.SUPABASE_ANON_KEY,
                Authorization: `Bearer ${token}`
              }
            }),
            8000,
            'profiles.fetch'
          );
          if (resp && resp.__timeout) {
            if (cont) {
              cont.innerHTML = `<div class="admin-usuarios-ayuda">Tiempo de espera cargando usuarios. Revisa tu conexión y recarga.</div>`;
            }
            return;
          }
          if (!resp || !resp.ok) {
            const status = resp ? resp.status : 'ERR';
            if (cont) {
              cont.innerHTML = `<div class="admin-usuarios-ayuda">No se pudieron cargar usuarios (HTTP ${escapeHtmlAttr(String(status))}).</div>`;
            }
            return;
          }
          const dataJson = await resp.json();
          usuariosRegistrados = (Array.isArray(dataJson) ? dataJson : []).map((u) => ({
            ...u,
            role: String(u.role || '').toLowerCase().trim()
          }));
          renderPanelAdminUsuarios();
          guardarCacheUsuariosAdmin();
          return;
        } catch (e) {
          console.error(e);
          if (cont) {
            cont.innerHTML = `<div class="admin-usuarios-ayuda">No se pudieron cargar usuarios. Revisa tu conexión y recarga.</div>`;
          }
          return;
        }
      }
      const { data, error } = res || {};
      if (!error) {
        usuariosRegistrados = (data || []).map((u) => ({
          ...u,
          role: String(u.role || '').toLowerCase().trim()
        }));
        renderPanelAdminUsuarios();
        guardarCacheUsuariosAdmin();
        return;
      }
      console.error(error);
      const msg = String(error.message || '');
      if (esErrorLockAuthSupabase(msg) && intento < maxIntentos - 1) {
        await pausaMs(180 + intento * 260);
        continue;
      }
      if (cont) {
        cont.innerHTML = `<div class="admin-usuarios-ayuda">No se pudieron cargar usuarios: ${escapeHtmlAttr(msg)}</div>`;
      }
      return;
    }
  } finally {
    cargaUsuariosAdminEnCurso = false;
  }
}

function renderPanelAdminUsuarios() {
  const cont = document.getElementById('listaUsuariosAdmin');
  if (!cont || !esAdmin()) return;
  if (usuariosRegistrados.length === 0) {
    cont.innerHTML = '<p class="admin-sin-usuarios">No hay usuarios.</p>';
    return;
  }
  cont.innerHTML = usuariosRegistrados.map((u) => {
    const esYo = u.id === sesionActiva?.user?.id;
    const disabled = esYo ? 'disabled' : '';
    return `
      <div class="admin-usuario-fila" data-user-id="${u.id}">
        <div class="admin-usuario-datos">
          <strong>${(u.full_name || '').trim() || '(Sin nombre)'}</strong>
          <span class="admin-usuario-email">Usuario: ${escapeHtmlAttr(usuarioLoginVisible(u.email))}</span>
          <span class="admin-usuario-rol">Rol actual: <b>${u.role}</b></span>
        </div>
        <div class="admin-usuario-acciones">
          <select class="admin-rol-select" data-user-id="${u.id}" ${disabled}>
            <option value="repartidor" ${u.role === 'repartidor' ? 'selected' : ''}>Repartidor</option>
            <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Administrador</option>
          </select>
          <button type="button" class="btn-primary btn-sm" onclick="aplicarCambioRolDesdeFila('${u.id}')" ${disabled}>Guardar rol</button>
        </div>
      </div>
    `;
  }).join('');
}

async function aplicarCambioRolDesdeFila(userId) {
  if (!esAdmin() || userId === sesionActiva?.user?.id) return;
  const sel = document.querySelector(`.admin-rol-select[data-user-id="${userId}"]`);
  if (!sel) return;
  const nuevoRol = sel.value;
  const { error } = await supabaseCliente.from('profiles').update({ role: nuevoRol }).eq('id', userId);
  if (error) {
    alert('No se pudo actualizar el rol: ' + error.message);
    return;
  }
  await cargarUsuariosParaAdmin();
  alert('Rol actualizado.');
}

async function asignarPedidoRepartidor(pedidoId, repartidorIdRaw) {
  if (!esAdmin() || !supabaseCliente) return;
  const repartidorId = normalizarUuidAsignacion(repartidorIdRaw);
  const { data, error } = await supabaseCliente
    .from('pedidos')
    .update({ assigned_to: repartidorId, updated_at: new Date().toISOString() })
    .eq('id', pedidoId)
    .select('id');
  if (error) {
    alert('No se pudo asignar: ' + error.message);
    return;
  }
  if (!data || data.length === 0) {
    alert('No se actualizó el pedido (revisa que seas admin en Supabase y que exista el pedido).');
    return;
  }
  const p = pedidos.find(x => x.id === pedidoId);
  if (p) p.assignedTo = repartidorId;
  renderPedidos();
  actualizarMarcadores();
}

function asignarPedidoDesdeTarjeta(pedidoId) {
  const sel = document.getElementById(`asignar-select-${pedidoId}`);
  asignarPedidoRepartidor(pedidoId, sel ? sel.value : '');
}

async function asignarSeccionPedidos(claseExtra) {
  if (!esAdmin() || !supabaseCliente) return;
  const sel = document.getElementById(`asignar-seccion-${claseExtra}`);
  if (!sel) return;
  const repartidorId = normalizarUuidAsignacion(sel.value);
  const ids = pedidos
    .filter((p) => {
      if (p.cancelado || p.entregado) return false;
      if (claseExtra === 'seccion-en-curso') return !!p.enCurso;
      if (claseExtra === 'seccion-pendientes') return !p.enCurso;
      return false;
    })
    .map((p) => p.id);
  if (ids.length === 0) return;
  const CHUNK = 80;
  let totalActualizados = 0;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const { data, error } = await supabaseCliente
      .from('pedidos')
      .update({ assigned_to: repartidorId, updated_at: new Date().toISOString() })
      .in('id', chunk)
      .select('id');
    if (error) {
      alert('No se pudo asignar la sección: ' + error.message);
      return;
    }
    totalActualizados += (data && data.length) ? data.length : 0;
  }
  if (totalActualizados !== ids.length) {
    alert(
      `Solo se actualizaron ${totalActualizados} de ${ids.length} pedidos. ` +
        'El repartidor no verá los que falten hasta que corrijas permisos (RLS) o el rol admin en Supabase. Recarga la página como admin.'
    );
  }
  pedidos.forEach((p) => {
    if (ids.includes(p.id)) p.assignedTo = repartidorId;
  });
  renderPedidos();
  actualizarMarcadores();
}

function escapeHtmlAttr(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;');
}

function mostrarTabAuth(tab) {
  const loginForm = document.getElementById('authFormLogin');
  const regForm = document.getElementById('authFormRegistro');
  const tabLogin = document.getElementById('authTabLogin');
  const tabReg = document.getElementById('authTabRegistro');
  const errL = document.getElementById('authErrorLogin');
  const errR = document.getElementById('authErrorRegistro');
  if (errL) errL.style.display = 'none';
  if (errR) errR.style.display = 'none';
  if (tab === 'registro') {
    if (loginForm) loginForm.style.display = 'none';
    if (regForm) regForm.style.display = 'block';
    if (tabLogin) tabLogin.classList.remove('active');
    if (tabReg) tabReg.classList.add('active');
  } else {
    if (loginForm) loginForm.style.display = 'block';
    if (regForm) regForm.style.display = 'none';
    if (tabLogin) tabLogin.classList.add('active');
    if (tabReg) tabReg.classList.remove('active');
  }
}

function opcionesSelectRepartidores(pedido) {
  const opts = ['<option value="">Sin asignar</option>'];
  const normalizarRol = (r) => String(r || '').toLowerCase().trim();
  usuariosRegistrados.filter(u => normalizarRol(u.role) === 'repartidor').forEach((u) => {
    const uid = normalizarUuidAsignacion(u.id);
    const sel = uid && pedido.assignedTo && pedido.assignedTo === uid ? ' selected' : '';
    const login = usuarioLoginVisible(u.email);
    const label = `${(u.full_name || '').trim() || login || u.id}${login ? ' · ' + login : ''}`;
    opts.push(`<option value="${uid || ''}"${sel}>${escapeHtmlAttr(label)}</option>`);
  });
  return opts.join('');
}

function aplicarLayoutAuthFijo() {
  document.documentElement.classList.add('auth-layout');
  document.body.classList.add('auth-layout');
}

function quitarLayoutAuthFijo() {
  document.documentElement.classList.remove('auth-layout');
  document.body.classList.remove('auth-layout');
}

function mostrarAuthComprobandoSesion() {
  aplicarLayoutAuthFijo();
  const auth = document.getElementById('authScreen');
  const main = document.getElementById('mainApp');
  const msg = document.getElementById('authBootMessage');
  const card = document.getElementById('authCard');
  if (auth) auth.style.display = 'flex';
  if (main) main.style.display = 'none';
  if (msg) msg.style.display = 'block';
  if (card) card.style.display = 'none';
}

function mostrarPantallaAuth() {
  marcarPantallaLogin();
  aplicarLayoutAuthFijo();
  const main = document.getElementById('mainApp');
  if (main) main.classList.remove('app-es-admin');
  const auth = document.getElementById('authScreen');
  const msg = document.getElementById('authBootMessage');
  const card = document.getElementById('authCard');
  if (auth) auth.style.display = 'flex';
  if (main) main.style.display = 'none';
  if (msg) msg.style.display = 'none';
  if (card) card.style.display = 'block';
  desuscribirRealtimePedidos();
  if (mapa) {
    try { mapa.remove(); } catch (e) {}
    mapa = null;
    marcadores = [];
    mapaAjustado = false;
  }
}

function mostrarAppPrincipal() {
  marcarPantallaMain();
  quitarLayoutAuthFijo();
  const auth = document.getElementById('authScreen');
  const main = document.getElementById('mainApp');
  if (auth) auth.style.display = 'none';
  if (main) main.style.display = 'block';
  const elNombre = document.getElementById('headerUserNombre');
  const elRol = document.getElementById('headerUserRol');
  if (elNombre) {
    elNombre.textContent = nombreParaMenuUsuario();
  }
  if (elRol) {
    if (perfilUsuario) {
      elRol.textContent = perfilUsuario.role === 'admin' ? 'Administrador' : 'Repartidor';
    } else if (sesionActiva?.user) {
      elRol.textContent = '';
    } else {
      elRol.textContent = '';
    }
  }
  syncMainAdminClass();
  const adminUi = esAdminVisual();
  const taPegar = document.getElementById('textoPedido');
  if (taPegar) taPegar.readOnly = !adminUi;
  const btnProc = document.getElementById('btnProcesarPedido');
  if (btnProc) btnProc.disabled = !adminUi;
  const panelAdmin = document.getElementById('panelAdmin');
  if (panelAdmin) panelAdmin.style.display = adminUi ? 'block' : 'none';
  const btnElim = document.getElementById('btnEliminarTodos');
  if (btnElim) btnElim.style.display = adminUi ? 'inline-flex' : 'none';
  const btnMediosPagoMenu = document.getElementById('btnMediosPagoMenu');
  if (btnMediosPagoMenu) btnMediosPagoMenu.style.display = adminUi ? 'none' : 'flex';
  if (adminUi) {
    // En recargas, el perfil puede estar listo pero la lista de usuarios no se disparó.
    void cargarUsuariosParaAdmin();
  }
  // Importante: si los pedidos vienen del cache local o llegan antes del boot,
  // renderizar siempre las tarjetas al entrar/recargar.
  try { renderPedidos(); } catch (_e) {}
  // Refuerzo: en recargas, si profiles tarda/falla pero is_admin() ya dice true, reactivar UI admin.
  void asegurarUIAdminDesdeRpc();
  // Segundo refuerzo: cuando el arranque dispara varias consultas en paralelo,
  // Supabase puede devolver “lock” momentáneo; reintentamos 2 veces.
  setTimeout(() => { void asegurarUIAdminDesdeRpc(); }, 1800);
  // Si por cualquier razón el boot no pobló perfilUsuario, recargar perfil y repintar UI.
  if (!perfilUsuario && sesionActiva?.user?.id) {
    setTimeout(() => {
      if (refrescoPerfilEnCurso || !sesionActiva?.user?.id) return;
      refrescoPerfilEnCurso = true;
      Promise.resolve()
        .then(() => refrescarPerfilUsuario())
        .then(() => {
          if (!sesionActiva) return;
          // Re-render para reflejar rol/header y secciones admin.
          const elNombre2 = document.getElementById('headerUserNombre');
          const elRol2 = document.getElementById('headerUserRol');
          if (elNombre2) elNombre2.textContent = nombreParaMenuUsuario();
          if (elRol2) {
            if (perfilUsuario) elRol2.textContent = perfilUsuario.role === 'admin' ? 'Administrador' : 'Repartidor';
            else elRol2.textContent = '';
          }
          syncMainAdminClass();
          void asegurarUIAdminDesdeRpc();
        })
        .finally(() => { refrescoPerfilEnCurso = false; });
    }, 450);
  }
  // En algunos recargos el layout termina después del primer paint; forzamos repintado del mapa.
  requestAnimationFrame(() => {
    if (!sesionActiva) return;
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
  const abierto = panel.style.display === 'block';
  panel.style.display = abierto ? 'none' : 'block';
  btn.setAttribute('aria-expanded', abierto ? 'false' : 'true');
}

async function iniciarSesion() {
  const usuario = document.getElementById('loginUsuario')?.value?.trim();
  const password = document.getElementById('loginPassword')?.value || '';
  const errEl = document.getElementById('authErrorLogin');
  const btn = document.getElementById('btnLoginEntrar');
  if (errEl) errEl.style.display = 'none';
  if (!usuario || !password) {
    if (errEl) { errEl.textContent = 'Completa correo o usuario y contraseña.'; errEl.style.display = 'block'; }
    return;
  }
  const email = emailDesdeCampoUsuario(usuario);
  if (!email) {
    if (errEl) { errEl.textContent = 'Correo o usuario no válido.'; errEl.style.display = 'block'; }
    return;
  }
  const labelOriginal = btn ? btn.textContent : '';
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Entrando…';
  }
  enFlujoLoginManual = true;
  try {
    const { data, error } = await supabaseCliente.auth.signInWithPassword({ email, password });
    if (error) {
      enFlujoLoginManual = false;
      if (errEl) { errEl.textContent = error.message; errEl.style.display = 'block'; }
      return;
    }
    if (data?.session) {
      sesionActiva = data.session;
      // Asegura rol/metadata antes de pintar UI (evita quedar como "Repartidor" tras salir/entrar).
      try { await refrescarPerfilUsuario(); } catch (_e) {}
      try { await aplicarPerfilAdminSiIsAdminRpc(); } catch (_e) {}
      mostrarAppPrincipal();
      void bootSesionYDatos()
        .catch((bootErr) => {
          console.error(bootErr);
          if (sesionActiva) mostrarAppPrincipal();
        })
        .finally(() => {
          enFlujoLoginManual = false;
        });
    } else {
      enFlujoLoginManual = false;
    }
  } catch (e) {
    enFlujoLoginManual = false;
    console.error(e);
    if (errEl) {
      errEl.textContent = 'No se pudo conectar. Revisa la red o la configuración de Supabase.';
      errEl.style.display = 'block';
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = labelOriginal || 'Entrar';
    }
  }
}

function correoElectronicoValido(correo) {
  const s = String(correo || '').trim().toLowerCase();
  if (!s || !s.includes('@')) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

async function registrarUsuario() {
  const nombre = document.getElementById('regNombre')?.value?.trim() || '';
  const correoRaw = document.getElementById('regEmail')?.value?.trim() || '';
  const usuario = document.getElementById('regUsuario')?.value?.trim();
  const password = document.getElementById('regPassword')?.value || '';
  const errEl = document.getElementById('authErrorRegistro');
  if (!correoRaw || !usuario || !password) {
    if (errEl) { errEl.textContent = 'Completa correo, usuario y contraseña.'; errEl.style.display = 'block'; }
    return;
  }
  if (!correoElectronicoValido(correoRaw)) {
    if (errEl) { errEl.textContent = 'Ingresa un correo electrónico válido.'; errEl.style.display = 'block'; }
    return;
  }
  if (password.length < 6) {
    if (errEl) { errEl.textContent = 'La contraseña debe tener al menos 6 caracteres.'; errEl.style.display = 'block'; }
    return;
  }
  const emailRegistro = correoRaw.toLowerCase().trim();
  const emailUsuarioInterno = emailDesdeCampoUsuario(usuario);
  if (!emailUsuarioInterno) {
    if (errEl) { errEl.textContent = 'Elige otro usuario (solo letras, números, puntos y guiones).'; errEl.style.display = 'block'; }
    return;
  }
  const { error } = await supabaseCliente.auth.signUp({
    email: emailRegistro,
    password,
    options: { data: { full_name: nombre, app_username: usuario } }
  });
  if (error) {
    if (errEl) { errEl.textContent = error.message; errEl.style.display = 'block'; }
    return;
  }
  if (errEl) {
    errEl.textContent = 'Cuenta creada. Ya puedes entrar con tu correo y contraseña.';
    errEl.style.display = 'block';
    errEl.style.color = '#15803d';
  }
  mostrarTabAuth('login');
}

async function cerrarSesion() {
  cerrarMenuUsuario();
  const client = supabaseCliente;
  const uid = sesionActiva?.user?.id;
  limpiarCachePedidosUsuario(uid);
  pedidos = [];
  perfilUsuario = null;
  sesionActiva = null;
  limpiarHintAdminSesion();
  try { localStorage.removeItem(CACHE_USUARIOS_ADMIN_KEY); } catch (_e) {}
  mostrarPantallaAuth();
  syncMainAdminClass();
  if (client) {
    void client.auth.signOut({ scope: 'local' }).catch((e) => console.error(e));
  }
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
  return /https?:\/\/(?:(?:www\.)?google\.com\/maps|maps\.google\.com|maps\.app\.goo\.gl|maps\.apple\.com|maps\.apple)[^\s\n]*/gi;
}

function patronUrlMapsRegexUna() {
  return /https?:\/\/(?:(?:www\.)?google\.com\/maps|maps\.google\.com|maps\.app\.goo\.gl|maps\.apple\.com|maps\.apple)[^\s\n]*/i;
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

function extraerCamposPedido(bloque) {
  const dirMatch = bloque.match(/📍[^\n]*:\s*([\s\S]*?)(?=🙋|Nombre[^\n]*:|$)/u);
  const direccion = dirMatch ? dirMatch[1].trim().replace(/\n\s*/g, ' ').trim() : '';

  let nomMatch = bloque.match(/🙋[^\n]*Nombre[^\n]*:\s*([\s\S]*?)(?=📲|$)/u);
  if (!nomMatch) {
    nomMatch = bloque.match(/Nombre(?:\s+de\s+quien\s+recibir[aá][^\n]*)?\s*:\s*([\s\S]*?)(?=📲|$)/i);
  }
  const nombre = nomMatch ? nomMatch[1].trim().split('\n')[0].trim() : '';

  const telMatch = bloque.match(/📲[^\n]*:\s*([\s\S]*?)(?=💰|$)/);
  const telRaw = telMatch ? telMatch[1].trim().split('\n')[0].trim() : '';
  const primerTel = telRaw.match(/[\d\s]+/);
  const telefono = primerTel ? primerTel[0].replace(/\s/g, '') : '';

  const valMatch = bloque.match(/💰[^\n]*:\s*([\s\S]*?)(?=Envío|$)/);
  let valor = valMatch ? valMatch[1].trim().split('\n')[0].trim() : '0';
  valor = valor.replace(/[^\d]/g, '');
  if (!valor) valor = '0';

  const prodMatch = bloque.match(/Producto\s*🎁[^\n]*:\s*([\s\S]*?)(?=¿Todo en orden|$)/);
  const productos = prodMatch
    ? prodMatch[1].trim().split('\n').map(l => l.trim()).filter(l => l)
    : [];

  return { direccion, nombre, telefono, valor, productos };
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
      const llMatch = html.match(/"latitude"\s*:\s*(-?\d+\.\d+).*?"longitude"\s*:\s*(-?\d+\.\d+)/s);
      if (llMatch) {
        const lat = parseFloat(llMatch[1]), lng = parseFloat(llMatch[2]);
        if (!isNaN(lat) && !isNaN(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) return { lat, lng };
      }
      const centerMatch = html.match(/center=(-?\d+\.\d+),(-?\d+\.\d+)/);
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
  if (!esAdmin()) {
    alert('Solo el administrador puede crear pedidos.');
    return;
  }
  const texto = document.getElementById("textoPedido").value.trim();
  if (!texto) {
    alert("Por favor, pega el formato del pedido");
    return;
  }

  if ((texto.match(/Para agilizar tu pedido/g) || []).length > 1) {
    await procesarMultiplesPedidos(texto);
    return;
  }

  const textoLimpio = limpiarTimestampsChat(texto);

  const numeroMatch = textoLimpio.match(/(\d+):\s*\n?\s*Para\s+agilizar/i) || textoLimpio.match(/^(\d+):/m);
  const numeroPedido = numeroMatch ? parseInt(numeroMatch[1]) : null;

  const campos = extraerCamposPedido(textoLimpio);

  const urlsEnPegado = extraerTodasLasUrlsMapsEnTexto(textoLimpio);
  const mapUrl = urlsEnPegado.length > 0
    ? elegirUrlMapsParaBloque(textoLimpio, textoLimpio, 0, urlsEnPegado)
    : '';

  if (!mapUrl) {
    alert("No se encontró URL de Google Maps en el texto pegado.\n\nAsegúrate de incluir el enlace de Maps junto con el formato del pedido.");
    return;
  }

  const btnProcesar = document.querySelector('.btn-primary');
  const textoOriginalBtn = btnProcesar ? btnProcesar.textContent : '';
  if (btnProcesar) { btnProcesar.textContent = 'Procesando...'; btnProcesar.disabled = true; }

  const coords = await obtenerCoordenadas(mapUrl, campos.direccion);

  if (btnProcesar) { btnProcesar.textContent = textoOriginalBtn; btnProcesar.disabled = false; }

  if (!coords) {
    alert("No se pudieron extraer coordenadas de la URL ni de la dirección.\n\nVerifica que el enlace de Maps o la dirección sean válidos.");
    return;
  }

  const pedidoId = generarPedidoId(numeroPedido);
  const mapUrlFinal = coords.lat && coords.lng
    ? `https://www.google.com/maps?q=${coords.lat},${coords.lng}`
    : mapUrl;

  pedidos.push({
    id: pedidoId,
    nombre: campos.nombre,
    telefono: campos.telefono,
    direccion: campos.direccion,
    productos: campos.productos,
    valor: campos.valor,
    textoOriginal: texto,
    mapUrl: mapUrlFinal,
    coords: { lat: coords.lat, lng: coords.lng },
    ...pedidoNuevoBase()
  });

  guardarPedidos();
  renderPedidos();

  setTimeout(() => {
    if (!mapa) return;
    procesarURLMapaPedido(mapUrlFinal, pedidoId, campos.productos, () => {
      ajustarVistaMapa();
      dibujarRutaEntreMarcadores();
    });
  }, 500);

  document.getElementById("textoPedido").value = "";
  alert(`Pedido #${pedidoId} agregado exitosamente`);
}

async function procesarMultiplesPedidos(texto) {
  if (!esAdmin()) {
    alert('Solo el administrador puede crear pedidos.');
    return;
  }
  const textoLimpio = limpiarTimestampsChat(texto);
  const bloques = textoLimpio.split(/¿Todo en orden\?\s*😊?\s*/);
  const urlsGlobal = extraerTodasLasUrlsMapsEnTexto(textoLimpio);

  let agregados = 0;
  let errores = [];

  const btnProcesar = document.querySelector('.btn-primary');
  const textoOriginalBtn = btnProcesar ? btnProcesar.textContent : '';

  let indicePedidoEnLote = 0;
  for (const bloque of bloques) {
    if (!bloque.includes('📍')) continue;

    const mapUrl = elegirUrlMapsParaBloque(textoLimpio, bloque, indicePedidoEnLote, urlsGlobal);
    indicePedidoEnLote += 1;
    const numMatch = bloque.match(/(\d+):\s*\n?\s*Para\s+agilizar/i) || bloque.match(/(\d+):\s*\n/);
    const numLabel = numMatch ? '#' + numMatch[1] : '?';

    if (!mapUrl) {
      errores.push(`Pedido ${numLabel}: No se encontró URL de Maps`);
      continue;
    }

    const numeroPedido = numMatch ? parseInt(numMatch[1]) : null;
    const campos = extraerCamposPedido(bloque);

    if (btnProcesar) { btnProcesar.textContent = `Procesando pedido ${numLabel}...`; btnProcesar.disabled = true; }

    const coords = await obtenerCoordenadas(mapUrl, campos.direccion);
    if (!coords) {
      errores.push(`Pedido ${numLabel}: No se pudieron extraer coordenadas`);
      continue;
    }

    const pedidoId = generarPedidoId(numeroPedido);
    const mapUrlFinal = coords.lat && coords.lng
      ? `https://www.google.com/maps?q=${coords.lat},${coords.lng}`
      : mapUrl;

    pedidos.push({
      id: pedidoId,
      nombre: campos.nombre,
      telefono: campos.telefono,
      direccion: campos.direccion,
      productos: campos.productos,
      valor: campos.valor,
      textoOriginal: bloque.trim(),
      mapUrl: mapUrlFinal,
      coords: { lat: coords.lat, lng: coords.lng },
      ...pedidoNuevoBase()
    });

    agregados++;
  }

  if (btnProcesar) { btnProcesar.textContent = textoOriginalBtn; btnProcesar.disabled = false; }

  if (agregados > 0) {
    guardarPedidos();
    renderPedidos();
    setTimeout(() => actualizarMarcadores(), 500);
    document.getElementById("textoPedido").value = "";
  }

  let msg = `Se agregaron ${agregados} pedido(s)`;
  if (errores.length > 0) {
    msg += `\n\n⚠️ ${errores.length} pedido(s) no agregado(s):\n${errores.join('\n')}`;
  }
  alert(msg);
}

function guardarPedidos() {
  if (!supabaseCliente || !sesionActiva) return;
  // Evita duplicados por carreras de cache/red.
  pedidos = deduplicarPedidosPorId(pedidos);
  // Persistencia inmediata local para que no desaparezca al recargar.
  guardarCachePedidos();
  if (persistTimeoutId) clearTimeout(persistTimeoutId);
  persistTimeoutId = setTimeout(() => {
    persistTimeoutId = null;
    void persistPedidosToSupabase();
  }, 450);
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
    const subVacio = esAdmin()
      ? 'Pega un formato de pedido arriba para comenzar'
      : 'Los pedidos aparecerán aquí cuando el administrador los cree y te asigne.';
    lista.innerHTML = `<div class="empty-state" id="emptyState"><p>No hay pedidos aún</p><p style="font-size: 14px;">${escapeHtmlAttr(subVacio)}</p></div>`;
    actualizarPestañasListaPedidos([], [], [], []);
    renderListaOrdenEntrega();
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

  const recogidoDelDia = pedidos
    .filter(
      p => p.entregado
        && !p.noEntregado
        && p.metodoPagoEntrega !== 'pagado_tienda'
        && p.metodoPagoEntrega !== 'es_cambio'
    )
    .reduce((sum, p) => sum + parseInt(p.valor || 0, 10), 0);
  const enviosEntregados = pedidos.filter(p => p.entregado && !p.noEntregado).length;
  const enviosNoEntregadosEnPunto = pedidos.filter(p => p.noEntregado && p.envioRecogido).length;
  const pagoDomiciliario = (enviosEntregados + enviosNoEntregadosEnPunto) * 12000;
  const entregarTienda = Math.max(recogidoDelDia - pagoDomiciliario, 0);
  const totalPagadoNequi = pedidos
    .filter(p => p.entregado && !p.noEntregado)
    .reduce((sum, p) => sum + Number(p.montoNequi || 0), 0);
  const totalPagadoDaviplata = pedidos
    .filter(p => p.entregado && !p.noEntregado)
    .reduce((sum, p) => sum + Number(p.montoDaviplata || 0), 0);

  const elResumen = document.getElementById('totalesResumen');
  if (elResumen) {
    const elRecogidoDia = document.getElementById('totalRecogidoDia');
    const elPagoDomiciliario = document.getElementById('totalPagoDomiciliario');
    const elEntregarTienda = document.getElementById('totalEntregarTienda');
    const elPagadoNequi = document.getElementById('totalPagadoNequi');
    const elPagadoDaviplata = document.getElementById('totalPagadoDaviplata');
    const itemNequi = elPagadoNequi ? elPagadoNequi.closest('.total-item') : null;
    const itemDaviplata = elPagadoDaviplata ? elPagadoDaviplata.closest('.total-item') : null;

    if (elRecogidoDia) elRecogidoDia.textContent = recogidoDelDia.toLocaleString('es-CO');
    if (elPagoDomiciliario) elPagoDomiciliario.textContent = pagoDomiciliario.toLocaleString('es-CO');
    if (elEntregarTienda) elEntregarTienda.textContent = entregarTienda.toLocaleString('es-CO');
    if (elPagadoNequi) elPagadoNequi.textContent = totalPagadoNequi.toLocaleString('es-CO');
    if (elPagadoDaviplata) elPagadoDaviplata.textContent = totalPagadoDaviplata.toLocaleString('es-CO');
    if (itemNequi) itemNequi.style.display = totalPagadoNequi > 0 ? 'inline-flex' : 'none';
    if (itemDaviplata) itemDaviplata.style.display = totalPagadoDaviplata > 0 ? 'inline-flex' : 'none';
    elResumen.style.display = (recogidoDelDia > 0 || pagoDomiciliario > 0 || totalPagadoNequi > 0 || totalPagadoDaviplata > 0) ? 'flex' : 'none';
  }

  renderListaOrdenEntrega();
  ajustarMapaConReintentos();
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

function crearSeccionPedidos(claseExtra, items, textoVacio) {
  const seccion = document.createElement('div');
  seccion.className = `pedidos-seccion ${claseExtra}`;

  const adminUi = esAdminVisual();
  const permitirAsignacionMasiva = adminUi && items.length > 0 && (claseExtra === 'seccion-pendientes' || claseExtra === 'seccion-en-curso');
  if (permitirAsignacionMasiva) {
    const header = document.createElement('div');
    header.className = 'admin-asignar-seccion';
    const etiqueta = claseExtra === 'seccion-en-curso' ? 'En ruta' : 'Pendientes';
    header.innerHTML = `
      <div class="admin-asignar-seccion-title"><strong>Asignar sección (${etiqueta})</strong></div>
      <div class="admin-asignar-seccion-row">
        <select class="admin-asignar-select" id="asignar-seccion-${claseExtra}">
          ${opcionesSelectRepartidores({ assignedTo: null })}
        </select>
        <button type="button" class="btn-route btn-sm" onclick="asignarSeccionPedidos('${claseExtra}')">Asignar todos</button>
      </div>
    `;
    seccion.appendChild(header);
  }

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
  const adminUi = esAdminVisual();
  div.draggable = adminUi && !pedido.entregado && !pedido.cancelado;
  div.dataset.index = index;
  div.dataset.id = pedido.id;

  const telefonoLimpio = pedido.telefono ? pedido.telefono.replace(/\D/g, '') : '';
  const valorFormato = parseInt(pedido.valor || 0, 10).toLocaleString('es-CO');
  const btnNoEntregadoHtml = pedido.entregado
    ? `<div class="pedido-no-entregado-wrap"><button class="btn-warning" onclick="marcarNoEntregado(${index})" style="width: 100%;"><i class="fa-solid fa-rotate-left"></i> No entregado</button></div>`
    : '';
  const etapaActual = obtenerEtapaPedidoUI(pedido);
  const btnRegresarPendienteHtml = etapaActual === 'enRuta'
    ? `<button class="btn-info" onclick="marcarPendiente(${index})"><i class="fa-solid fa-rotate-left"></i> Regresar a pendientes</button>`
    : '';
  const btnCancelarHtml = (!pedido.entregado && !pedido.cancelado && etapaActual !== 'enRuta' && etapaActual !== 'enDestino')
    ? `<button class="btn-warning" onclick="marcarCancelado(${index})"><i class="fa-solid fa-ban"></i> Cancelar pedido</button>`
    : '';
  const btnReactivarCanceladoHtml = pedido.cancelado
    ? `<button class="btn-success" onclick="reactivarPedidoCancelado(${index})"><i class="fa-solid fa-rotate-left"></i> Reactivar pedido</button>`
    : '';
  const textoBotonNotificar = pedido.notificadoEnCamino ? 'Volver a notificar' : 'Notificar en camino';
  const btnNotificarHtml = etapaActual === 'notificar'
    ? `<button class="btn-notify" onclick="notificarEnCamino(${index}, ${pedido.id})"><i class="fa-solid fa-bullhorn"></i> ${textoBotonNotificar}</button>`
    : '';
  const btnNotificarNuevamenteHtml = (!pedido.entregado && !pedido.cancelado && pedido.notificadoEnCamino && etapaActual !== 'enRuta' && etapaActual !== 'enDestino')
    ? `<button class="btn-notify" onclick="notificarEnCamino(${index}, ${pedido.id}, { forzarReenvio: true })"><i class="fa-solid fa-bullhorn"></i> Notificar nuevamente al cliente</button>`
    : '';
  const btnEnrutarHtml = etapaActual === 'enrutar'
    ? `<button class="btn-route" onclick="enrutarConApps(${index}, ${pedido.id})"><i class="fa-solid fa-route"></i> Enrutar</button>`
    : '';
  const btnEnrutarNuevamenteHtml = etapaActual === 'enRuta'
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

  const asignarHtml = adminUi && !pedido.entregado && !pedido.cancelado
    ? `<div class="admin-asignar-pedido">
        <strong>Asignar repartidor</strong>
        <div class="admin-asignar-row">
          <select class="admin-asignar-select" id="asignar-select-${pedido.id}">${opcionesSelectRepartidores(pedido)}</select>
          <button type="button" class="btn-route btn-sm" onclick="asignarPedidoDesdeTarjeta(${pedido.id})">Asignar</button>
        </div>
      </div>`
    : '';

  div.innerHTML = `
    <div class="pedido-header">
      <div class="pedido-numero">Pedido #${pedido.id}${estadoTexto}</div>
      <div class="pedido-header-btns">
        ${!pedido.cancelado ? `<button class="btn-edit" onclick="editarPedido(${index})" style="padding: 5px 10px; font-size: 12px;"><i class="fa-solid fa-pen-to-square"></i> Editar</button>` : ''}
        ${adminUi ? `<button class="btn-danger btn-icon-only" onclick="eliminarPedido(${index})" title="Eliminar pedido" aria-label="Eliminar pedido"><i class="fa-solid fa-trash"></i></button>` : ''}
      </div>
    </div>
    <div class="pedido-cliente">${pedido.nombre || 'Cliente no especificado'}</div>
    <div class="pedido-info">
      <strong>Teléfono:</strong> ${pedido.telefono || 'No especificado'}<br>
      <strong>Dirección:</strong> ${pedido.direccion || 'No especificada'}
      <button class="btn-copy-inline" onclick="copiarDireccionPedido(${index})" title="Copiar dirección">
        <i class="fa-regular fa-copy"></i> Copiar
      </button><br>
      <strong>Productos:</strong> ${pedido.productos && pedido.productos.length > 0 ? pedido.productos.join(', ') : 'No especificado'}<br>
      <strong>Valor:</strong> $${valorFormato}<br>
    </div>
    ${asignarHtml}
    ${etapaActual === 'enDestino' ? `
    <div class="pedido-tools">
      <details class="pedido-dropdown">
        <summary class="btn-info"><i class="fa-solid fa-address-book"></i> Contacto</summary>
        <div class="pedido-dropdown-content">
          <button class="btn-success" onclick="whatsappLlamar('${telefonoLimpio}')"><i class="fa-brands fa-whatsapp"></i> Llamar por WhatsApp</button>
          <button class="btn-success" onclick="whatsappMensaje('${telefonoLimpio}')"><i class="fa-brands fa-whatsapp"></i> Mensaje por WhatsApp</button>
          <button class="btn-info" onclick="llamar('${telefonoLimpio}')"><i class="fa-solid fa-phone"></i> Llamada normal</button>
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
      ${btnNotificarHtml ? `<div class="pedido-actions-row">${btnNotificarHtml}</div>` : ''}
      ${btnNotificarNuevamenteHtml ? `<div class="pedido-actions-row">${btnNotificarNuevamenteHtml}</div>` : ''}
      ${btnEnrutarHtml ? `<div class="pedido-actions-row">${btnEnrutarHtml}</div>` : ''}
      ${btnEnrutarNuevamenteHtml ? `<div class="pedido-actions-row">${btnEnrutarNuevamenteHtml}</div>` : ''}
      ${btnLlegueDestinoHtml ? `<div class="pedido-actions-row">${btnLlegueDestinoHtml}</div>` : ''}
      ${bloqueAccionesDestinoHtml}
      ${btnRegresarPendienteHtml ? `<div class="pedido-actions-row">${btnRegresarPendienteHtml}</div>` : ''}
      ${btnCancelarHtml ? `<div class="pedido-actions-row">${btnCancelarHtml}</div>` : ''}
      ${btnReactivarCanceladoHtml ? `<div class="pedido-actions-row">${btnReactivarCanceladoHtml}</div>` : ''}
    </div>
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
    item.draggable = esAdmin();
    item.dataset.id = pedido.id;
    item.textContent = `Pedido #${pedido.id}`;

    item.addEventListener('dragstart', handleOrdenDragStart);
    item.addEventListener('dragover', handleOrdenDragOver);
    item.addEventListener('drop', handleOrdenDrop);
    item.addEventListener('dragend', handleOrdenDragEnd);

    listaOrden.appendChild(item);
  });
}

function moverPedidoPorId(draggedId, targetId) {
  const draggedIndex = pedidos.findIndex(p => p.id === draggedId);
  const targetIndex = pedidos.findIndex(p => p.id === targetId);
  if (draggedIndex < 0 || targetIndex < 0 || draggedIndex === targetIndex) return false;

  const [removed] = pedidos.splice(draggedIndex, 1);
  pedidos.splice(targetIndex, 0, removed);
  return true;
}

// --- Drag and Drop ---
let draggedElement = null;
let draggedOrdenElement = null;

function handleDragStart(e) {
  draggedElement = this;
  this.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/html', this.innerHTML);
}

function handleDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  return false;
}

function handleDrop(e) {
  e.stopPropagation();
  if (draggedElement !== this) {
    const draggedId = parseInt(draggedElement.dataset.id, 10);
    const targetId = parseInt(this.dataset.id, 10);
    if (moverPedidoPorId(draggedId, targetId)) {
      guardarPedidos();
      renderPedidos();
      actualizarMarcadores();
    }
  }
  return false;
}

function handleDragEnd() {
  this.classList.remove('dragging');
}

function handleOrdenDragStart(e) {
  draggedOrdenElement = this;
  this.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', this.dataset.id || '');
}

function handleOrdenDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  return false;
}

function handleOrdenDrop(e) {
  e.stopPropagation();
  if (draggedOrdenElement !== this) {
    const draggedId = parseInt(draggedOrdenElement.dataset.id, 10);
    const targetId = parseInt(this.dataset.id, 10);
    if (moverPedidoPorId(draggedId, targetId)) {
      guardarPedidos();
      renderPedidos();
      actualizarMarcadores();
    }
  }
  return false;
}

function handleOrdenDragEnd() {
  this.classList.remove('dragging');
}

// --- Gestión de pedidos ---

async function eliminarPedido(index) {
  if (!esAdmin()) {
    alert('Solo el administrador puede eliminar pedidos.');
    return;
  }
  const pedido = pedidos[index];
  if (!pedido) return;
  if (!confirm(`¿Estás seguro de eliminar el pedido #${pedido.id}?`)) return;
  const id = pedido.id;
  pedidos.splice(index, 1);
  renderPedidos();
  actualizarMarcadores();
  if (supabaseCliente) {
    const { error } = await supabaseCliente.from('pedidos').delete().eq('id', id);
    if (error) {
      alert('Error al eliminar en el servidor: ' + error.message);
      await cargarPedidosDesdeSupabase();
      renderPedidos();
      actualizarMarcadores();
    }
  }
}

function marcarEntregado(index) {
  const pedido = pedidos[index];
  if (!pedido) return;
  pedido.entregado = true;
  pedido.enCurso = false;
  pedido.llegoDestino = false;
  pedido.posicionPendiente = null;
  guardarPedidos();
  renderPedidos();
  actualizarMarcadores();
}

function marcarEnCurso(index) {
  const pedido = pedidos[index];
  if (!pedido || pedido.entregado || pedido.cancelado) return;
  const estabaEnCurso = !!pedido.enCurso;
  if (pedido.posicionPendiente == null) pedido.posicionPendiente = index;
  pedido.enCurso = true;
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

  const posicionOriginal = Number.isInteger(pedido.posicionPendiente)
    ? pedido.posicionPendiente
    : null;
  pedido.enCurso = false;
  pedido.llegoDestino = false;
  pedido.posicionPendiente = null;

  if (posicionOriginal !== null) {
    const [movido] = pedidos.splice(index, 1);
    const destino = Math.max(0, Math.min(posicionOriginal, pedidos.length));
    pedidos.splice(destino, 0, movido);
  }

  guardarPedidos();
  renderPedidos();
  actualizarMarcadores();
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
  guardarPedidos();
  renderPedidos();
  actualizarMarcadores();
}

function marcarCancelado(index) {
  const pedido = pedidos[index];
  if (!pedido || pedido.entregado || pedido.cancelado) return;
  pedido.cancelado = true;
  pedido.enCurso = false;
  pedido.llegoDestino = false;
  pedido.posicionPendiente = null;
  guardarPedidos();
  renderPedidos();
  actualizarMarcadores();
}

function reactivarPedidoCancelado(index) {
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

async function eliminarTodos() {
  if (!esAdmin()) {
    alert('Solo el administrador puede eliminar todos los pedidos.');
    return;
  }
  if (!confirm("¿Estás seguro de eliminar TODOS los pedidos? Esta acción no se puede deshacer.")) return;
  const prevPedidos = Array.isArray(pedidos) ? [...pedidos] : [];
  const ids = prevPedidos.map((p) => p && p.id).filter((id) => id != null);

  // Si no hay cliente o no hay nada que borrar, igual limpiamos cache/estado local.
  if (!supabaseCliente || ids.length === 0) {
    pedidos = [];
    limpiarCachePedidosUsuario(sesionActiva?.user?.id);
    guardarCachePedidos();
    renderPedidos();
    actualizarMarcadores();
    return;
  }

  const { error } = await supabaseCliente.from('pedidos').delete().in('id', ids);
  if (error) {
    alert('Error al eliminar en el servidor: ' + error.message);
    // Revertir UI/local en caso de fallo.
    pedidos = prevPedidos;
    guardarCachePedidos();
    renderPedidos();
    actualizarMarcadores();
    return;
  }

  // Borrado exitoso: limpiar estado y cache local para que no reaparezcan al recargar.
  pedidos = [];
  limpiarCachePedidosUsuario(sesionActiva?.user?.id);
  guardarCachePedidos();
  renderPedidos();
  actualizarMarcadores();
}

// --- Editar pedido ---

let edicionPedidoPendiente = { index: null };

function asegurarModalEditarPedido() {
  let modal = document.getElementById('modalEditarPedido');
  if (modal) return modal;

  modal = document.createElement('div');
  modal.id = 'modalEditarPedido';
  modal.className = 'modal-no-entregado-backdrop';
  modal.innerHTML = `
    <div class="modal-no-entregado-card">
      <h3>Editar pedido</h3>
      <p>Actualiza el valor o la URL del mapa:</p>
      <div style="display:flex; flex-direction:column; gap:10px;">
        <input id="editarPedidoValor" type="text" inputmode="numeric" placeholder="Valor del pedido (solo números)" style="width:100%; padding:10px; border:1px solid #d1d5db; border-radius:8px;">
        <input id="editarPedidoMapUrl" type="text" placeholder="URL del mapa" style="width:100%; padding:10px; border:1px solid #d1d5db; border-radius:8px;">
      </div>
      <div class="modal-no-entregado-actions" style="margin-top: 12px;">
        <button class="btn-primary" onclick="guardarEdicionPedido()">Guardar cambios</button>
      </div>
      <button class="modal-no-entregado-close" onclick="cerrarModalEditarPedido()">Cerrar</button>
    </div>
  `;
  document.body.appendChild(modal);
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

  const inputValor = document.getElementById('editarPedidoValor');
  const inputMapUrl = document.getElementById('editarPedidoMapUrl');
  const valorIngresado = inputValor ? String(inputValor.value || '') : '';
  const valorLimpio = valorIngresado.replace(/[^\d]/g, '');
  const nuevaUrl = inputMapUrl ? String(inputMapUrl.value || '').trim() : '';

  if (valorLimpio !== '') {
    pedido.valor = valorLimpio;
  }
  if (nuevaUrl !== '') {
    pedido.mapUrl = nuevaUrl;
  }

  guardarPedidos();
  renderPedidos();
  actualizarMarcadores();
  cerrarModalEditarPedido();
}

function editarPedido(index) {
  const pedido = pedidos[index];
  if (!pedido) return;
  edicionPedidoPendiente = { index };
  const modal = asegurarModalEditarPedido();
  const inputValor = document.getElementById('editarPedidoValor');
  const inputMapUrl = document.getElementById('editarPedidoMapUrl');
  if (inputValor) inputValor.value = String(pedido.valor || '');
  if (inputMapUrl) inputMapUrl.value = String(pedido.mapUrl || '');
  modal.style.display = 'flex';
}

// --- Comunicación ---

function llamar(numero) {
  if (!numero) { mostrarAvisoEnApp('No hay número de teléfono disponible', 'Contacto'); return; }
  const n = numero.toString().replace(/\D/g, '');
  if (!n) { alert("Número de teléfono inválido"); return; }
  window.location.href = `tel:${n}`;
}

function copiarDireccionPedido(index) {
  const pedido = pedidos[index];
  const direccion = pedido && pedido.direccion ? String(pedido.direccion).trim() : '';
  if (!direccion) {
    alert("No hay dirección para copiar");
    return;
  }

  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(direccion)
      .then(() => alert("Dirección copiada"))
      .catch(() => alert("No se pudo copiar la dirección"));
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
    alert(ok ? "Dirección copiada" : "No se pudo copiar la dirección");
  } catch (e) {
    alert("No se pudo copiar la dirección");
  } finally {
    document.body.removeChild(textarea);
  }
}

function whatsappLlamar(numero) {
  if (!numero) { mostrarAvisoEnApp('No hay número de teléfono disponible', 'Contacto'); return; }
  const n = numero.toString().replace(/\D/g, '');
  if (!n) { alert("Número de teléfono inválido"); return; }
  const wa = n.startsWith('57') ? n : `57${n}`;
  window.open(`https://wa.me/${wa}`, "_blank");
}

function whatsappMensaje(numero) {
  if (!numero) { mostrarAvisoEnApp('No hay número de teléfono disponible', 'Contacto'); return; }
  const n = numero.toString().replace(/\D/g, '');
  if (!n) { alert("Número de teléfono inválido"); return; }
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
    <div class="modal-no-entregado-card">
      <h3>Mensajes de soporte</h3>
      <p>Selecciona el problema a reportar por WhatsApp:</p>
      <div class="modal-no-entregado-actions">
        <button class="btn-support" onclick="enviarMensajeSoporte('no_enviado')">Pedido no enviado</button>
        <button class="btn-support" onclick="enviarMensajeSoporte('pago_reportado')">Cliente reporta pago</button>
        <button class="btn-support" onclick="enviarMensajeSoporte('producto_incorrecto')">Producto incorrecto</button>
        <button class="btn-support" onclick="enviarMensajeSoporte('faltan_productos')">Faltan productos</button>
        <button class="btn-info" onclick="enviarMensajeSoporte('personalizado')">Mensaje personalizado</button>
      </div>
      <button class="modal-no-entregado-close" onclick="cerrarModalMensajeSoporte()">Cerrar</button>
    </div>
  `;
  document.body.appendChild(modal);
  return modal;
}

function mostrarOpcionesMensajeSoporte(index) {
  const pedido = pedidos[index];
  if (!pedido) return;
  soportePendiente = { index };
  const modal = asegurarModalMensajeSoporte();
  modal.style.display = 'flex';
}

function cerrarModalMensajeSoporte() {
  const modal = document.getElementById('modalMensajeSoporte');
  if (!modal) return;
  modal.style.display = 'none';
}

function construirMensajeSoporte(pedido, tipoProblema) {
  const idPedido = pedido.id || 'N/A';
  const productosRaw = pedido.productos && pedido.productos.length > 0
    ? pedido.productos.join(', ')
    : 'No especificado';
  const productos = productosRaw
    .replace(/(?:^|,\s*)cambio\.?(?=,|$)/gi, '')
    .replace(/,\s*,/g, ', ')
    .replace(/^,\s*|\s*,\s*$/g, '')
    .trim() || 'No especificado';

  if (tipoProblema === 'no_enviado') {
    return `Pedido ${idPedido} no enviado. Producto(s): ${productos}.`;
  }
  if (tipoProblema === 'pago_reportado') {
    return `Cliente del pedido ${idPedido} me indica que ya realizó el pago. ¿Me confirma? Producto(s): ${productos}.`;
  }
  if (tipoProblema === 'producto_incorrecto') {
    return `Producto del pedido ${idPedido} no es el que solicitó el cliente. Producto(s) enviado(s): ${productos}.`;
  }
  if (tipoProblema === 'faltan_productos') {
    return `El cliente indica que le hacen falta productos en el pedido ${idPedido}. Producto(s) del pedido: ${productos}.`;
  }

  const detalle = prompt(
    `Describe el problema del pedido ${idPedido}:`,
    `Pedido ${idPedido}: `
  );
  if (!detalle || !detalle.trim()) return null;
  return `${detalle.trim()} Producto(s): ${productos}.`;
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
  window.open(`https://wa.me/${wa}?text=${encodeURIComponent(mensaje)}`, '_blank');
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
  if (btnCancelar) btnCancelar.textContent = opciones.textoCancelar || 'Cancelar';

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

let pagoEntregadoPendiente = { index: null, pedidoId: null, enviarWhatsAppAdmin: true };

function parseMontoEntero(valor) {
  const limpio = String(valor || '').replace(/[^\d]/g, '');
  return limpio ? parseInt(limpio, 10) : 0;
}

function asegurarModalPagoEntregado() {
  let modal = document.getElementById('modalPagoEntregado');
  if (modal) return modal;

  modal = document.createElement('div');
  modal.id = 'modalPagoEntregado';
  modal.className = 'modal-no-entregado-backdrop';
  modal.innerHTML = `
    <div class="modal-no-entregado-card">
      <h3>Foto evidencia entregado</h3>
      <p>Selecciona el método de pago del pedido:</p>
      <div class="modal-no-entregado-actions">
        <button class="btn-success" onclick="seleccionarMetodoPagoEntregado('nequi')">Nequi</button>
        <button class="btn-info" onclick="seleccionarMetodoPagoEntregado('efectivo')">Efectivo</button>
        <button class="btn-route" onclick="seleccionarMetodoPagoEntregado('daviplata')">Daviplata</button>
        <button class="btn-success" onclick="seleccionarMetodoPagoEntregado('nequi_efectivo')">Nequi + Efectivo</button>
        <button class="btn-route" onclick="seleccionarMetodoPagoEntregado('daviplata_efectivo')">Daviplata + Efectivo</button>
        <button class="btn-warning" onclick="seleccionarMetodoPagoEntregado('pagado_tienda')">Ya se pagó a la tienda</button>
        <button class="btn-info" onclick="seleccionarMetodoPagoEntregado('es_cambio')">Es un cambio</button>
      </div>
      <div id="montosMixtosPago" style="display:none; margin-top: 12px;">
        <input id="montoDigitalPago" type="text" inputmode="numeric" placeholder="Monto digital" style="width:100%; padding:10px; border:1px solid #d1d5db; border-radius:8px; margin-bottom:8px;">
        <input id="montoEfectivoPago" type="text" inputmode="numeric" placeholder="Monto en efectivo" style="width:100%; padding:10px; border:1px solid #d1d5db; border-radius:8px;">
        <button class="btn-primary" style="width:100%; margin-top:8px;" onclick="confirmarMontosMixtosPago()">Confirmar montos</button>
      </div>
      <button class="modal-no-entregado-close" onclick="cerrarModalPagoEntregado()">Cerrar</button>
    </div>
  `;
  document.body.appendChild(modal);
  return modal;
}

function cerrarModalPagoEntregado() {
  const modal = document.getElementById('modalPagoEntregado');
  if (!modal) return;
  modal.style.display = 'none';
  const contenedorMontos = document.getElementById('montosMixtosPago');
  const inputDigital = document.getElementById('montoDigitalPago');
  const inputEfectivo = document.getElementById('montoEfectivoPago');
  if (contenedorMontos) contenedorMontos.style.display = 'none';
  if (inputDigital) inputDigital.value = '';
  if (inputEfectivo) inputEfectivo.value = '';
}

function fotoEntregado(index, pedidoId) {
  pagoEntregadoPendiente = { index, pedidoId, enviarWhatsAppAdmin: true };
  const modal = asegurarModalPagoEntregado();
  modal.style.display = 'flex';
}

function registrarEntregaConPago(index, pedidoId, datosPago) {
  const indexActual = pedidos.findIndex(p => p.id === pedidoId);
  const indexFinal = indexActual >= 0 ? indexActual : index;
  const pedido = pedidos[indexFinal];
  if (!pedido) return;

  pedido.noEntregado = false;
  pedido.envioRecogido = false;
  pedido.metodoPagoEntrega = datosPago.metodo;
  pedido.montoNequi = Number(datosPago.montoNequi || 0);
  pedido.montoDaviplata = Number(datosPago.montoDaviplata || 0);
  pedido.montoEfectivo = Number(datosPago.montoEfectivo || 0);

  const numeroAdmin = '573143473582';
  const montoRecibido = Number(pedido.montoNequi || 0) + Number(pedido.montoDaviplata || 0) + Number(pedido.montoEfectivo || 0);
  const productosEntregados = pedido.productos && pedido.productos.length > 0
    ? pedido.productos.join(', ')
    : 'No especificado';

  let metodoPagoTexto = 'No especificado';
  if (pedido.metodoPagoEntrega === 'nequi') metodoPagoTexto = 'Nequi';
  else if (pedido.metodoPagoEntrega === 'efectivo') metodoPagoTexto = 'Efectivo';
  else if (pedido.metodoPagoEntrega === 'daviplata') metodoPagoTexto = 'Daviplata';
  else if (pedido.metodoPagoEntrega === 'nequi_efectivo') metodoPagoTexto = `Nequi + Efectivo (Nequi: $${pedido.montoNequi.toLocaleString('es-CO')}, Efectivo: $${pedido.montoEfectivo.toLocaleString('es-CO')})`;
  else if (pedido.metodoPagoEntrega === 'daviplata_efectivo') metodoPagoTexto = `Daviplata + Efectivo (Daviplata: $${pedido.montoDaviplata.toLocaleString('es-CO')}, Efectivo: $${pedido.montoEfectivo.toLocaleString('es-CO')})`;
  else if (pedido.metodoPagoEntrega === 'pagado_tienda') metodoPagoTexto = 'Ya se pagó a la tienda';
  else if (pedido.metodoPagoEntrega === 'es_cambio') metodoPagoTexto = 'Es un cambio';

  const detalleMonto = (pedido.metodoPagoEntrega === 'pagado_tienda' || pedido.metodoPagoEntrega === 'es_cambio')
    ? (pedido.metodoPagoEntrega === 'pagado_tienda' ? 'No aplica (ya se pagó a la tienda)' : 'No aplica (es un cambio)')
    : `$${montoRecibido.toLocaleString('es-CO')}`;
  const mensaje = `Pedido #${pedidoId} entregado
Monto recibido: ${detalleMonto}
Producto(s) entregado(s): ${productosEntregados}
Método de pago: ${metodoPagoTexto}`;
  if (pagoEntregadoPendiente.enviarWhatsAppAdmin !== false) {
    abrirWhatsAppConTexto(numeroAdmin, mensaje);
  }
  pagoEntregadoPendiente = { index: null, pedidoId: null, enviarWhatsAppAdmin: true };
  marcarEntregado(indexFinal);
  notificarSiguientePedido(pedidoId);
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
  cerrarModalPagoEntregado();
  registrarEntregaConPago(indexFinal, pedidoId, datosPago);
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
    alert('Selecciona un método de pago mixto válido.');
    return;
  }
  if (montoDigital <= 0 || montoEfectivo <= 0) {
    alert('Debes ingresar ambos montos para registrar el pago mixto.');
    return;
  }
  if (montoDigital + montoEfectivo !== totalPedido) {
    alert(`La suma de montos debe ser igual al valor del pedido ($${totalPedido.toLocaleString('es-CO')}).`);
    return;
  }

  const datosPago = {
    metodo,
    montoNequi: metodo === 'nequi_efectivo' ? montoDigital : 0,
    montoDaviplata: metodo === 'daviplata_efectivo' ? montoDigital : 0,
    montoEfectivo
  };
  cerrarModalPagoEntregado();
  registrarEntregaConPago(index, pedidoId, datosPago);
}

let noEntregadoPendiente = { index: null, pedidoId: null };

function asegurarModalNoEntregado() {
  let modal = document.getElementById('modalNoEntregado');
  if (modal) return modal;

  modal = document.createElement('div');
  modal.id = 'modalNoEntregado';
  modal.className = 'modal-no-entregado-backdrop';
  modal.innerHTML = `
    <div class="modal-no-entregado-card">
      <h3>No entregado</h3>
      <p>Indica si estuviste en el punto de entrega (afecta el pago de $12.000 al delivery):</p>
      <div class="modal-no-entregado-actions">
        <button class="btn-warning" onclick="confirmarNoEntregado(true)">Estoy en el punto de entrega</button>
        <button class="btn-info" onclick="confirmarNoEntregado(false)">No fui al punto de entrega</button>
      </div>
      <button class="modal-no-entregado-close" onclick="cerrarModalNoEntregado()">Cerrar</button>
    </div>
  `;
  document.body.appendChild(modal);
  return modal;
}

function mostrarOpcionesNoEntregado(index, pedidoId) {
  noEntregadoPendiente = { index, pedidoId };
  const modal = asegurarModalNoEntregado();
  modal.style.display = 'flex';
}

function cerrarModalNoEntregado() {
  const modal = document.getElementById('modalNoEntregado');
  if (!modal) return;
  modal.style.display = 'none';
}

function confirmarNoEntregado(enUbicacion) {
  const { index, pedidoId } = noEntregadoPendiente;
  cerrarModalNoEntregado();
  procesarFotoNoEntregado(index, pedidoId, enUbicacion);
}

function fotoNoEntregado(index, pedidoId) {
  mostrarOpcionesNoEntregado(index, pedidoId);
}

function procesarFotoNoEntregado(index, pedidoId, enUbicacion) {
  const indexActual = pedidos.findIndex(p => p.id === pedidoId);
  const indexFinal = indexActual >= 0 ? indexActual : index;
  const pedido = pedidos[indexFinal];
  if (!pedido) return;

  const numeroAdmin = '573143473582';
  const mensaje = `Pedido #${pedidoId} no entregado`;
  abrirWhatsAppConTexto(numeroAdmin, mensaje);

  pedido.entregado = true;
  pedido.enCurso = false;
  pedido.llegoDestino = false;
  pedido.posicionPendiente = null;
  pedido.noEntregado = true;
  pedido.envioRecogido = enUbicacion;
  guardarPedidos();
  renderPedidos();
  actualizarMarcadores();
}

// --- Enrutamiento ---

function getUbicacionPedido(index, pedidoId) {
  const pedido = pedidos[index];
  if (!pedido) return null;
  let lat = null, lng = null;
  const marcadorPedido = marcadores.find(m => m.pedidoId === pedidoId);
  if (marcadorPedido && marcadorPedido.marker) {
    const pos = marcadorPedido.marker.getLatLng();
    lat = pos.lat;
    lng = pos.lng;
  }
  if ((!lat || !lng) && pedido.mapUrl) {
    const match = pedido.mapUrl.match(/@(-?\d+\.?\d*),(-?\d+\.?\d*)/);
    if (match) { lat = parseFloat(match[1]); lng = parseFloat(match[2]); }
  }
  if (lat != null && lng != null) return { lat, lng };
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
  if (!u) { alert('No hay ubicación disponible para este pedido.'); return; }
  marcarEnCurso(indexFinal);

  const isAndroid = /Android/i.test(navigator.userAgent);
  const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);

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

  if (isIOS) {
    if (u.lat != null && u.lng != null) {
      window.location.href = `maps://?daddr=${u.lat},${u.lng}&dirflg=d`;
    } else {
      const destino = encodeURIComponent(u.direccion || '');
      window.location.href = `maps://?daddr=${destino}&dirflg=d`;
    }
    return;
  }

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
  if (!u) { alert('No hay ubicación disponible para este pedido.'); return; }

  if (tipo === 'apps') {
    abrirNavegacionConSelector(indexFinal, pedidoId);
    return;
  }

  marcarEnCurso(indexFinal);

  if (tipo === 'waze') {
    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    if (u.lat != null && u.lng != null) {
      if (isMobile) {
        window.location.href = `waze://?ll=${u.lat},${u.lng}&navigate=yes`;
      } else {
        window.open(`https://waze.com/ul?ll=${u.lat},${u.lng}&navigate=yes`, '_blank');
      }
    } else {
      const q = encodeURIComponent(u.direccion);
      if (isMobile) {
        window.location.href = `waze://?q=${q}&navigate=yes`;
      } else {
        window.open(`https://waze.com/ul?q=${q}&navigate=yes`, '_blank');
      }
    }
    return;
  }

  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const isAndroid = /Android/.test(navigator.userAgent);
  if (u.lat != null && u.lng != null) {
    if (isIOS) {
      window.location.href = `comgooglemaps://?daddr=${u.lat},${u.lng}&directionsmode=driving`;
    } else if (isAndroid) {
      window.location.href = `google.navigation:q=${u.lat},${u.lng}`;
    } else {
      window.open(`https://www.google.com/maps/dir/?api=1&destination=${u.lat},${u.lng}&travelmode=driving`, '_blank');
    }
  } else {
    const destino = encodeURIComponent(u.direccion);
    if (isIOS) {
      window.location.href = `comgooglemaps://?daddr=${destino}&directionsmode=driving`;
    } else if (isAndroid) {
      window.location.href = `google.navigation:q=${destino}`;
    } else {
      window.open(`https://www.google.com/maps/dir/?api=1&destination=${destino}&travelmode=driving`, '_blank');
    }
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

function mostrarOpcionesFinalizarEntrega(index, pedidoId) {
  finalizacionPendiente = { index, pedidoId };
  const modal = asegurarModalFinalizacionEntrega();
  modal.style.display = 'flex';
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
    pagoEntregadoPendiente = { index: indexFinal, pedidoId, enviarWhatsAppAdmin: false };
    const modalPago = asegurarModalPagoEntregado();
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

function notificarEnCamino(index, pedidoId, opciones = {}) {
  const { pedido, indexActual } = obtenerPedidoPorId(pedidoId);
  const indexFinal = indexActual >= 0 ? indexActual : index;
  const pedidoFinal = pedido || pedidos[indexFinal];
  if (!pedidoFinal) return;
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
  const telefonoCliente = pedidoFinal.telefono ? String(pedidoFinal.telefono).replace(/\D/g, '') : '';
  if (!telefonoCliente) { mostrarAvisoEnApp('No hay número de teléfono del cliente disponible', 'Notificación'); return; }

  const nombre = pedidoFinal.nombre || 'cliente';
  const precio = parseInt(pedidoFinal.valor || 0, 10).toLocaleString('es-CO');
  const wa = telefonoCliente.startsWith('57') ? telefonoCliente : `57${telefonoCliente}`;
  const bloquePago = construirBloquePagoNotificacion();

  const mensaje = `Hola ${nombre}

Te informamos que nuestro repartidor de Valero Store se encuentra en camino hacia tu ubicación para entregar el pedido.

Por favor ten en cuenta:
- Estar pendiente con los $${precio} en mano
- El repartidor NO CUENTA CON CAMBIO
- El tiempo de espera desde la llegada al punto de entrega es de 10 minutos

${bloquePago}

Gracias por tu compra ${nombre}`;

  abrirWhatsAppConTexto(wa, mensaje);
  pedidoFinal.notificadoEnCamino = true;
  guardarPedidos();
  renderPedidos();
  if (typeof opciones.onSuccess === 'function') opciones.onSuccess();
}

// --- Mapa: marcadores y ruta ---

function actualizarMarcadores() {
  if (!mapa) return;
  marcadores.forEach(item => mapa.removeLayer(item.marker));
  marcadores = [];
  if (rutaLayer) { mapa.removeLayer(rutaLayer); rutaLayer = null; }
  if (pedidos.length === 0) return;

  let completados = 0;
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
          mapa.invalidateSize();
          ajustarVistaMapa();
          dibujarRutaEntreMarcadores();
        }, 100);
      }
    };

    // Prioriza coordenadas ya conocidas para evitar peticiones de red.
    if (pedido.coords && Number.isFinite(pedido.coords.lat) && Number.isFinite(pedido.coords.lng)) {
      procesarURLMapaPedido(`https://www.google.com/maps?q=${pedido.coords.lat},${pedido.coords.lng}`, id, prods, cb);
      return;
    }

    if (url) {
      const coordsDirectas = extraerCoordenadas(url);
      if (coordsDirectas) {
        pedido.coords = { lat: coordsDirectas.lat, lng: coordsDirectas.lng };
        procesarURLMapaPedido(url, id, prods, cb);
        return;
      }
      procesarURLMapaPedido(url, id, prods, (coords) => {
        if (coords) {
          pedido.coords = { lat: coords.lat, lng: coords.lng };
          pedido.mapUrl = `https://www.google.com/maps?q=${coords.lat},${coords.lng}`;
          guardarPedidos();
        }
        cb();
      });
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
        marker.bindPopup(`
          <div style="padding:5px;min-width:200px;">
            <h3 style="margin:0 0 10px 0;color:#4CAF50;font-size:16px;">Pedido #${pedidoId}</h3>
            <p style="margin:5px 0;"><strong>Dirección:</strong> ${direccion}</p>
            <p style="margin:5px 0;"><strong>Productos:</strong> ${productos && productos.length > 0 ? productos.join(', ') : 'No especificado'}</p>
          </div>`);
        if (pedidoId !== 'TEMP') marcadores.push({ pedidoId, marker });
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

  const coordenadas = [];
  for (const p of pedidos) {
    const item = marcadores.find(m => m.pedidoId === p.id);
    if (item && item.marker) {
      const ll = item.marker.getLatLng();
      coordenadas.push([ll.lng, ll.lat]);
    }
  }
  if (coordenadas.length < 2) return;

  const coordsStr = coordenadas.map(c => c.join(',')).join(';');
  fetch(`https://router.project-osrm.org/route/v1/driving/${coordsStr}?overview=full&geometries=geojson`)
    .then(r => r.json())
    .then(data => {
      if (data.code !== 'Ok' || !data.routes?.[0]?.geometry?.coordinates) return;
      const latlngs = data.routes[0].geometry.coordinates.map(c => [c[1], c[0]]);
      rutaLayer = L.polyline(latlngs, { color: '#2196F3', weight: 5, opacity: 0.7 }).addTo(mapa);
    })
    .catch(() => {
      const latlngs = coordenadas.map(c => [c[1], c[0]]);
      rutaLayer = L.polyline(latlngs, { color: '#2196F3', weight: 4, opacity: 0.6, dashArray: '10, 10' }).addTo(mapa);
    });
}

function extraerCoordenadas(url) {
  const limpia = url.replace(/\s+/g, '').replace(/%2C/gi, ',').replace(/%40/gi, '@');
  let decoded;
  try { decoded = decodeURIComponent(limpia); } catch (e) { decoded = limpia; }

  const patrones = [
    /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/,
    /@(-?\d+\.\d+),(-?\d+\.\d+)/,
    /[?&]q=(-?\d+\.\d+),(-?\d+\.\d+)/,
    /query=(-?\d+\.\d+),(-?\d+\.\d+)/,
    /[?&]coordinate=(-?\d+\.\d+),(-?\d+\.\d+)/,
    /[?&]ll=(-?\d+\.\d+),(-?\d+\.\d+)/,
    /place\/[^@]*@(-?\d+\.\d+),(-?\d+\.\d+)/,
    /[?&]sll=(-?\d+\.\d+),(-?\d+\.\d+)/,
    /center=(-?\d+\.\d+),(-?\d+\.\d+)/,
  ];

  for (const texto of [decoded, limpia, url]) {
    for (const p of patrones) {
      const m = texto.match(p);
      if (m) {
        const lat = parseFloat(m[1]);
        const lng = parseFloat(m[2]);
        if (!isNaN(lat) && !isNaN(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
          return { lat, lng };
        }
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
    alert(`No se pudieron extraer coordenadas válidas de la URL para el pedido #${pedidoId}.`);
    if (callback) callback();
    return;
  }

  try {
    const estadoVisual = obtenerEstadoVisualPedido(Number(pedidoId));
    const marker = L.marker([lat, lng], { icon: crearIconoMarcador(Number(pedidoId), estadoVisual) }).addTo(mapa);
    marker.bindPopup(`
      <div style="padding:5px;min-width:200px;">
        <h3 style="margin:0 0 10px 0;color:#4CAF50;font-size:16px;">Pedido #${pedidoId}</h3>
        <p style="margin:5px 0;"><strong>Productos:</strong> ${productos && productos.length > 0 ? productos.join(', ') : 'No especificado'}</p>
      </div>`);
    marcadores.push({ pedidoId, marker });
    if (callback) callback({ lat, lng });
  } catch (error) {
    alert(`Error al agregar marcador para el pedido #${pedidoId}: ${error.message}`);
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
  if (!p.hasOwnProperty('mapUrl')) p.mapUrl = '';
  if (!p.hasOwnProperty('coords') || !p.coords) p.coords = null;
  if (!p.hasOwnProperty('enCurso')) p.enCurso = false;
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

async function bootSesionYDatos() {
  if (bootSesionEjecutando) {
    bootSesionCola = true;
    return;
  }
  bootSesionEjecutando = true;
  try {
    if (sesionActiva) {
      mostrarAppPrincipal();
    }
    try {
      if (sesionActiva?.user?.id) {
        try { localStorage.removeItem(CACHE_PEDIDOS_LEGACY_KEY); } catch (_e) {}
        const cachePrevio = cargarCachePedidos();
        if (Array.isArray(cachePrevio) && cachePrevio.length > 0) {
          pedidos = deduplicarPedidosPorId(cachePrevio.map(normalizarPedidoEnMemoria));
          nextPedidoId = Math.max(...pedidos.map((p) => p.id), 0) + 1;
        }
      }
      await Promise.all([refrescarPerfilUsuario(), cargarPedidosDesdeSupabase()]);
      if (sesionActiva) mostrarAppPrincipal();

      if (esAdminVisual()) void cargarUsuariosParaAdmin();
      pedidos = pedidos.map(normalizarPedidoEnMemoria);
      if (pedidos.length > 0) {
        nextPedidoId = Math.max(...pedidos.map(p => p.id), 0) + 1;
      } else {
        nextPedidoId = 1;
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
          suscribirRealtimePedidos();
        } catch (mapErr) {
          console.error(mapErr);
        }
      });
    } catch (err) {
      console.error('bootSesionYDatos', err);
      if (sesionActiva) mostrarAppPrincipal();
    }
  } finally {
    bootSesionEjecutando = false;
    if (bootSesionCola) {
      bootSesionCola = false;
      await bootSesionYDatos();
    }
  }
}

async function iniciarAppSupabase() {
  supabaseCliente = inicializarClienteSupabase();
  exponerDebugAppDelivery();
  if (!supabaseCliente) {
    mostrarPantallaAuth();
    return;
  }

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

  mostrarAuthComprobandoSesion();

  supabaseCliente.auth.onAuthStateChange(async (event, session) => {
    if (event === 'INITIAL_SESSION') {
      sesionActiva = session || null;
      // En recarga, esta es la ruta correcta para arrancar. No dependas de getSession(),
      // porque en algunos entornos puede quedarse colgado por locks/concurrencia.
      if (!sesionActiva) {
        perfilUsuario = null;
        pedidos = [];
        mostrarPantallaAuth();
        return;
      }
      // Asegura que el cliente tenga la sesión cargada en memoria para adjuntar JWT en REST/RPC.
      try { await supabaseCliente.auth.setSession(sesionActiva); } catch (_e) {}
      if (wasLoginScreenBeforeReload()) {
        mostrarPantallaAuth();
        return;
      }
      try {
        await bootSesionYDatos();
        // Refuerzo: a veces la lista de usuarios admin no entra en el primer tick tras recargar.
        setTimeout(() => { if (esAdminVisual()) void cargarUsuariosParaAdmin(); }, 1200);
      } catch (e) {
        console.error(e);
        if (sesionActiva) mostrarAppPrincipal();
      }
      return;
    }
    if (event === 'SIGNED_IN' && enFlujoLoginManual) {
      sesionActiva = session;
      return;
    }
    const uidAnterior = sesionActiva?.user?.id;
    sesionActiva = session;
    if (!session) {
      limpiarCachePedidosUsuario(uidAnterior);
      perfilUsuario = null;
      pedidos = [];
      mostrarPantallaAuth();
      return;
    }
    // Si el usuario estaba en login y recargó, NO auto-entrar aunque exista sesión persistida.
    if (wasLoginScreenBeforeReload()) {
      // Importante: no dejar el UI en “Comprobando sesión…”
      mostrarPantallaAuth();
      return;
    }
    if (event === 'TOKEN_REFRESHED') return;
    if (event === 'USER_UPDATED') {
      await refrescarPerfilUsuario();
      mostrarAppPrincipal();
      return;
    }
    try {
      await bootSesionYDatos();
    } catch (e) {
      console.error(e);
      if (sesionActiva) mostrarAppPrincipal();
    }
  });

  try {
    const { session: sesionDesdeGet, error } = await obtenerSesionInicialConTimeout(6000);
    if (error) {
      console.error(error);
    }
    // Si getSession() tarda más que el timeout, INITIAL_SESSION / SIGNED_IN ya pueden haber
    // rellenado sesionActiva; no sobrescribir con null (evita “entré y a los segundos me sacó”).
    const sesionFinal = sesionDesdeGet ?? sesionActiva;
    sesionActiva = sesionFinal || null;
    if (sesionFinal) {
      if (wasLoginScreenBeforeReload()) {
        // Mantener login si el usuario estaba en login antes de recargar (sin quedarse en “Comprobando sesión…”).
        mostrarPantallaAuth();
        return;
      }
      try {
        await bootSesionYDatos();
      } catch (e) {
        console.error(e);
        mostrarAppPrincipal();
      }
    } else {
      mostrarPantallaAuth();
    }
  } catch (e) {
    console.error(e);
    mostrarPantallaAuth();
  }
}

window.onload = function () {
  void iniciarAppSupabase();
};

// Flush de pedidos al salir/recargar pestaña.
window.addEventListener('pagehide', () => {
  enSalidaDePagina = true;
  try { void persistPedidosToSupabase({ silent: true, keepalive: true }); } catch (_e) {}
});
