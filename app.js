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
const CONFIG_NOTIFICACION_KEY = 'configNotificacionPago';
/** Pedidos en este dispositivo (sin login). */
const CACHE_PEDIDOS_KEY = 'cachePedidos_v1';
/** Misma clave que antes; datos por usuario vivían en `cachePedidos_v1_<uuid>`. */
const CACHE_PEDIDOS_LEGACY_KEY = 'cachePedidos_v1';

function escapeHtmlAttr(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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
  try {
    if (localStorage.getItem(CACHE_PEDIDOS_KEY)) return;
    const legacy = localStorage.getItem(CACHE_PEDIDOS_LEGACY_KEY);
    if (legacy) {
      localStorage.setItem(CACHE_PEDIDOS_KEY, legacy);
      return;
    }
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && /^cachePedidos_v1_/.test(k)) {
        const raw = localStorage.getItem(k);
        if (raw) {
          localStorage.setItem(CACHE_PEDIDOS_KEY, raw);
          return;
        }
      }
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
    localStorage.removeItem(CACHE_PEDIDOS_KEY);
    localStorage.removeItem(CACHE_PEDIDOS_LEGACY_KEY);
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
    const raw = localStorage.getItem(CACHE_PEDIDOS_KEY);
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
    localStorage.setItem(CACHE_PEDIDOS_KEY, JSON.stringify(dedup));
  } catch (err) {
    console.error('[app-delivery] No se pudo guardar en localStorage:', err);
    alert(
      'No se pudieron guardar los pedidos en este navegador. Revisa el modo privado o que no esté bloqueado el almacenamiento local.'
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

function abrirConfigNotificacionDesdeMenu() {
  cerrarMenuUsuario();
  abrirConfigNotificacion();
}

function guardarConfigNotificacionDesdeUI(mostrarMensaje = true) {
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

function pedidoNuevoBase() {
  return {
    assignedTo: null,
    createdBy: null,
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
const _RE_FIN_CAMPO_PEDIDO =
  '(?=🙋|📲|💰|Nombre\\b|Tel[ée]fono|Celular|WhatsApp|M[oó]vil\\b|Producto\\b|Pedido\\b|¿Todo|Para agilizar|Env[ií]o|https?:|$)';

/** Tras "Nombre:" puede venir dirección antes que teléfono; sin 📍/Dirección el capture se come ese bloque. */
const _RE_FIN_TRAS_NOMBRE = _RE_FIN_CAMPO_PEDIDO.replace(
  /\|\$\)/,
  '|📍|(?:(?:Direcci[oó]n|Ubicaci[oó]n|Direccion)\\b)|$)'
);

function extraerProductosLineasTrasEncabezado(b) {
  const lines = String(b || '').split('\n');
  const esCorte = (raw) => {
    const L = raw.trim();
    if (!L) return false;
    if (/^https?:/i.test(L)) return true;
    if (/^¿Todo en orden/i.test(L)) return true;
    if (/^Para agilizar\b/i.test(L)) return true;
    if (/^Env[ií]o\b/i.test(L)) return true;
    if (/^\d+\s*:\s*$/.test(L) || /^\d+\s*:\s*Para\b/i.test(L)) return true;
    if (/^(?:📍|🙋|📲|💰)/u.test(L)) return true;
    if (/^(?:Direcci[oó]n|Ubicaci[oó]n|Nombre|Tel[ée]fono|Celular|WhatsApp|Valor|Total)\b/i.test(L) && /:\s*\S/.test(L)) return true;
    return false;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!/^Producto\b/i.test(line)) continue;
    if (/:\s*\S/.test(line)) continue;
    const out = [];
    for (let j = i + 1; j < lines.length; j++) {
      const raw = lines[j];
      if (esCorte(raw)) break;
      let L = raw.trim();
      if (!L) continue;
      L = L.replace(/^\*+\s*/, '').replace(/\s*\*+$/, '');
      L = L.replace(/^[•\u2022\-\*]\s*/, '').replace(/^\d+[\.)]\s+/, '').trim();
      if (L) out.push(L);
    }
    if (out.length) return out;
  }
  return [];
}

function extraerCamposPedido(bloque) {
  const b = normalizarTextoParaExtraerPedido(bloque);
  const finCampo = _RE_FIN_CAMPO_PEDIDO;

  let direccion = '';
  const dirPatrones = [
    new RegExp(`📍[^:\\n]*:\\s*([\\s\\S]*?)${finCampo}`, 'iu'),
    new RegExp(
      `(?:Direcci[oó]n\\s+completa|Direcci[oó]n|Ubicaci[oó]n|Direccion)[^:\\n]*:\\s*([\\s\\S]*?)${finCampo}`,
      'iu'
    ),
  ];
  for (const re of dirPatrones) {
    const m = b.match(re);
    if (m && m[1]) {
      direccion = m[1].trim().replace(/\n\s*/g, ' ').trim();
      break;
    }
  }

  let nombre = '';
  const finNombre = _RE_FIN_TRAS_NOMBRE;
  const nomPatrones = [
    new RegExp(`🙋[^:\\n]*:\\s*([\\s\\S]*?)${finNombre}`, 'iu'),
    new RegExp(`Nombre[^:\\n]*:\\s*([\\s\\S]*?)${finNombre}`, 'i'),
    /(?:Recibe|A\s+nombre\s+de|Contacto)\s*:\s*([^\n]+)/i,
  ];
  for (const re of nomPatrones) {
    const m = b.match(re);
    if (m && m[1]) {
      nombre = m[1].trim().split('\n')[0].trim();
      break;
    }
  }

  let telefono = '';
  const telPatrones = [
    new RegExp(
      `📲[^:\\n]*:\\s*([\\s\\S]*?)(?=💰|Producto|Pedido|Horario|¿Todo|Para agilizar|Env[ií]o|https?:|$)`,
      'u'
    ),
    /(?:Tel[ée]fono|N[uú]mero\s+de\s+celular|Celular|WhatsApp|M[oó]vil)[^:\n]*:\s*([^\n]+)/i,
  ];
  for (const re of telPatrones) {
    const m = b.match(re);
    if (m && m[1]) {
      const telRaw = m[1].trim().split('\n')[0].trim();
      const primerTel = telRaw.match(/\+?[\d\s().-]{7,}/);
      let digits = primerTel ? primerTel[0].replace(/[^\d+]/g, '') : '';
      if (digits.startsWith('+')) digits = digits.slice(1);
      telefono = digits.replace(/\D/g, '');
      if (telefono.length >= 7) break;
      telefono = '';
    }
  }

  const finValor =
    '(?=Env[ií]o|Horario|Producto|¿Todo|Para agilizar|📍|🙋|📲|💰|https?:|\\n\\s*\\d+:\\s*\\n?\\s*Para|$)';
  let valor = '0';
  const valPatrones = [
    new RegExp(`💰[^:\\n]*:\\s*([\\s\\S]*?)${finValor}`, 'i'),
    new RegExp(
      '(?:Valor\\s+a\\s+pagar|Valor\\s+a\\s+recoger|A\\s+recoger|Valor|Total|Por\\s+cobrar|Pago|Recaudo)[^:\\n]*:\\s*([\\s\\S]*?)' +
        finValor,
      'i'
    ),
  ];
  for (const re of valPatrones) {
    const m = b.match(re);
    if (m && m[1]) {
      const raw = m[1].trim().split('\n')[0].trim();
      const soloDigitos = raw.replace(/[^\d]/g, '');
      if (soloDigitos) {
        valor = soloDigitos;
        break;
      }
    }
  }
  if (!valor || valor === '0') {
    const m2 = b.match(/\$\s*([\d.,]+)/);
    if (m2) valor = m2[1].replace(/[^\d]/g, '') || '0';
  }

  let productos = [];
  const prodFin =
    '(?=¿Todo en orden|Para agilizar|Env[ií]o|Horario|https?:|\\n\\s*\\d+:\\s*\\n?\\s*Para|$)';
  const prodPatrones = [
    new RegExp(`Producto\\s*🎁[^:\\n]*:\\s*([\\s\\S]*?)${prodFin}`, 'i'),
    new RegExp(`Producto\\s*🎯[^:\\n]*:\\s*([\\s\\S]*?)${prodFin}`, 'i'),
    new RegExp(`Producto[^:\\n]*:\\s*([\\s\\S]*?)${prodFin}`, 'i'),
    new RegExp(`Productos?[^:\\n]*:\\s*([\\s\\S]*?)${prodFin}`, 'i'),
    new RegExp(`Pedido[^:\\n]*:\\s*([\\s\\S]*?)${prodFin}`, 'i'),
  ];
  for (const re of prodPatrones) {
    const m = b.match(re);
    if (m && m[1]) {
      productos = m[1]
        .trim()
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !/^https?:/i.test(l));
      if (productos.length) break;
    }
  }
  if (productos.length === 0) {
    productos = extraerProductosLineasTrasEncabezado(b);
  }

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
  // Si solo usamos urlsGlobal por índice, se puede desalinear y repetir ubicaciones.
  const urlsPorNumero = (() => {
    const map = new Map();
    let numActual = null;
    const lineas = String(textoLimpio || '').split('\n');
    for (const raw of lineas) {
      const line = raw.trim();
      const mNum = line.match(/^(\d+):\s*$/);
      if (mNum) {
        numActual = Number(mNum[1]);
        continue;
      }
      const mUrl = line.match(patronUrlMapsRegexUna());
      if (mUrl && numActual != null) {
        const u = mUrl[0].trim();
        if (!map.has(numActual)) map.set(numActual, []);
        map.get(numActual).push(u);
      }
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
  pedidos = deduplicarPedidosPorId(pedidos);
  guardarCachePedidos();
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
    const subVacio = 'Pega un pedido arriba o importa un respaldo (código D1… o archivo).';
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
  const adminUi = true;
  div.draggable = !pedido.entregado && !pedido.cancelado;
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
      <strong>Productos:</strong> ${Array.isArray(pedido.productos) && pedido.productos.length > 0 ? pedido.productos.join(', ') : 'No especificado'}<br>
      <strong>Valor:</strong> $${valorFormato}<br>
    </div>
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
  if (moverPedidoPorId(pedidoId, targetId)) {
    guardarPedidos();
    renderPedidos();
    // Al cambiar el orden solo recalculamos la ruta; no recreamos marcadores ni reencuadramos el mapa.
    redibujarRutaDebounced(120);
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

function aplicarReordenListaOrdenSegunY(listaOrden, clientY, draggedId) {
  const beforeEl = ordenItemInsertBeforeDesdeClienteY(listaOrden, clientY);
  let ok = false;
  if (beforeEl) {
    const beforeId = parseInt(beforeEl.dataset.id, 10);
    if (Number.isFinite(beforeId)) ok = moverPedidoAntesDeId(draggedId, beforeId);
  } else {
    const items = [...listaOrden.querySelectorAll('.orden-item:not(.dragging)')];
    const last = items[items.length - 1];
    if (last) {
      const afterId = parseInt(last.dataset.id, 10);
      if (Number.isFinite(afterId)) ok = moverPedidoDespuesDeId(draggedId, afterId);
    }
  }
  if (ok) {
    guardarPedidos();
    renderPedidos();
    redibujarRutaDebounced(120);
  }
  return ok;
}

function ordenItemPointerMove(e) {
  if (!ordenEntregaArrastre || e.pointerId !== ordenEntregaArrastre.pointerId) return;
  e.preventDefault();
  actualizarGhostOrdenEntrega(e.clientX, e.clientY, ordenEntregaArrastre.pedidoId);

  // Mostrar hueco donde quedaría al soltar.
  const snap = ordenEntregaArrastre;
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

function ordenItemPointerEnd(e) {
  if (!ordenEntregaArrastre || e.pointerId !== ordenEntregaArrastre.pointerId) return;
  const snap = ordenEntregaArrastre;
  ordenEntregaArrastre = null;

  const { itemEl, lista, pedidoId, pointerId, startX, startY } = snap;
  itemEl.removeEventListener('pointermove', ordenItemPointerMove);
  itemEl.removeEventListener('pointerup', ordenItemPointerEnd);
  itemEl.removeEventListener('pointercancel', ordenItemPointerEnd);

  itemEl.classList.remove('dragging');
  ocultarGhostOrdenEntrega();
  limpiarHintsOrdenEntrega(lista);
  const panel = lista.closest('.orden-entrega-panel');
  if (panel) panel.classList.remove('dragging-activo');
  try {
    itemEl.releasePointerCapture(pointerId);
  } catch (_err) {}

  const dx = e.clientX - startX;
  const dy = e.clientY - startY;
  if (dx * dx + dy * dy < 36) return;

  const bounds = (panel || lista).getBoundingClientRect();
  if (e.clientX < bounds.left || e.clientX > bounds.right || e.clientY < bounds.top || e.clientY > bounds.bottom) {
    if (ordenEntregaPlaceholderEl && ordenEntregaPlaceholderEl.parentNode) ordenEntregaPlaceholderEl.remove();
    itemEl.style.display = '';
    return;
  }

  // Usar placeholder como referencia final de inserción (más fiel que usar solo Y).
  const ph = ordenEntregaPlaceholderEl;
  let ok = false;
  if (ph && ph.parentNode === lista) {
    const after = ph.nextElementSibling;
    if (after && after.classList && after.classList.contains('orden-item')) {
      const beforeId = parseInt(after.dataset.id, 10);
      if (Number.isFinite(beforeId)) ok = moverPedidoAntesDeId(pedidoId, beforeId);
    } else {
      const items = [...lista.querySelectorAll('.orden-item:not(.dragging)')];
      const last = items[items.length - 1];
      if (last) {
        const afterId = parseInt(last.dataset.id, 10);
        if (Number.isFinite(afterId)) ok = moverPedidoDespuesDeId(pedidoId, afterId);
      }
    }
  } else {
    ok = aplicarReordenListaOrdenSegunY(lista, e.clientY, pedidoId);
  }
  if (ph && ph.parentNode) ph.remove();
  itemEl.style.display = '';
  if (ok) {
    guardarPedidos();
    renderPedidos();
    redibujarRutaDebounced(120);
  }
}

function ordenListaPointerDown(e) {
  const lista = document.getElementById('listaOrdenEntrega');
  if (!lista || e.currentTarget !== lista) return;
  const item = e.target.closest && e.target.closest('.orden-item');
  if (!item || !lista.contains(item)) return;
  if (e.target.closest && e.target.closest('.orden-flecha')) return;
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
    startY: e.clientY
  };
  item.classList.add('dragging');
  actualizarGhostOrdenEntrega(e.clientX, e.clientY, pedidoId);
  const panel = lista.closest('.orden-entrega-panel');
  if (panel) panel.classList.add('dragging-activo');
  try {
    item.setPointerCapture(e.pointerId);
  } catch (_err) {}

  // Placeholder en la posición original del item; escondemos el item para que se vea el hueco.
  const ph = asegurarPlaceholderOrdenEntrega();
  if (item.parentNode === lista) lista.insertBefore(ph, item);
  item.style.display = 'none';

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

function handleDrop(e) {
  e.stopPropagation();
  if (!draggedElement || draggedElement === this) return false;
  const draggedId = parseInt(draggedElement.dataset.id, 10);
  const targetId = parseInt(this.dataset.id, 10);
  if (Number.isFinite(draggedId) && Number.isFinite(targetId) && moverPedidoPorId(draggedId, targetId)) {
    guardarPedidos();
    renderPedidos();
    actualizarMarcadores();
  }
  return false;
}

function handleDragEnd() {
  this.classList.remove('dragging');
  draggedElement = null;
}

// --- Gestión de pedidos ---

function eliminarPedido(index) {
  const pedido = pedidos[index];
  if (!pedido) return;
  if (!confirm(`¿Estás seguro de eliminar el pedido #${pedido.id}?`)) return;
  pedidos.splice(index, 1);
  guardarPedidos();
  renderPedidos();
  actualizarMarcadores();
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

function eliminarTodos() {
  if (!confirm("¿Estás seguro de eliminar TODOS los pedidos? Esta acción no se puede deshacer.")) return;
  pedidos = [];
  nextPedidoId = 1;
  vistaPedidosActual = 'pendientes';
  vistaPedidosSeleccionadaManual = false;
  guardarPedidos();
  renderPedidos();
  actualizarMarcadores();
  // Mantener el mapa visible y bien dimensionado aunque no haya pedidos.
  try {
    if (mapa) {
      mapaAjustado = false;
      mapa.invalidateSize();
      ajustarMapaConReintentos();
    }
  } catch (_e) {}
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
    const ext = extraerCoordenadas(nuevaUrl);
    if (ext) {
      pedido.coords = { lat: ext.lat, lng: ext.lng };
    } else {
      pedido.coords = null;
    }
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
  const productosRaw = Array.isArray(pedido.productos) && pedido.productos.length > 0
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
  const productosEntregados = Array.isArray(pedido.productos) && pedido.productos.length > 0
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
  const lista =
    Array.isArray(productos) && productos.length > 0 ? productos.join(', ') : 'No especificado';
  return (
    '<div style="padding:5px;min-width:200px;">' +
    `<h3 style="margin:0 0 10px 0;color:#4CAF50;font-size:16px;">Pedido #${pedidoId}</h3>` +
    `<p style="margin:5px 0;"><strong>Productos:</strong> ${lista}</p>` +
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
              setTimeout(() => alert(aviso), 200);
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
            `<p style="margin:5px 0;"><strong>Productos:</strong> ${Array.isArray(productos) && productos.length > 0 ? productos.join(', ') : 'No especificado'}</p>` +
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
    marker.bindPopup(htmlPopupPedidoMapa(pedidoId, productos));
    marcadores.push({ pedidoId, marker, latReal: lat, lngReal: lng });
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
  if (!Array.isArray(p.productos)) p.productos = [];
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
    alert('No se pudo preparar el respaldo en texto.');
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
      () => alert('Texto copiado.'),
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

async function importarPedidosDesdeTextoPlano(texto, origen = 'texto pegado') {
  const data = await parsearTextoImportPedidosUniversal(String(texto || ''));
  const lista = extraerListaPedidosDeImportParsed(data);
  if (lista.length === 0) {
    alert(`El ${origen} no contiene una lista de pedidos válida.`);
    return false;
  }
  const reemplazar = confirm(
    '¿Reemplazar todos los pedidos actuales por los importados?\n\n' +
      'Aceptar = reemplazar todo\n' +
      'Cancelar = combinar (mismo id: gana el importado)'
  );
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
  alert(`Importación lista: ${incoming.length} pedido(s).`);
  return true;
}

function importarPedidosDesdeArchivo(evt) {
  const file = evt.target && evt.target.files && evt.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      await importarPedidosDesdeTextoPlano(String(reader.result || ''), 'archivo');
    } catch (e) {
      console.error(e);
      alert(
        'No se pudo leer el archivo. Usa el código D1… de respaldo o un archivo válido exportado por esta app.'
      );
    } finally {
      evt.target.value = '';
    }
  };
  reader.readAsText(file, 'utf-8');
}

function abrirModalImportarRespaldo() {
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
      '<button type="button" class="btn-info" onclick="dispararSelectorImportarPedidos()">Importar desde archivo</button>' +
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
    alert('Pega el texto de respaldo antes de importar.');
    ta.focus();
    return;
  }
  try {
    const ok = await importarPedidosDesdeTextoPlano(texto, 'texto pegado');
    if (ok) cerrarModalImportarRespaldo();
  } catch (e) {
    console.error(e);
    alert('No se pudo importar el texto pegado. Verifica que esté completo y comience con D1…');
  }
}

function cerrarModalImportarRespaldo() {
  const modal = document.getElementById('modalImportarRespaldo');
  if (modal) modal.style.display = 'none';
}

function dispararSelectorImportarPedidos() {
  const input = document.getElementById('inputImportarPedidos');
  if (input) input.click();
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
        alert(
          'Copiado. En el otro equipo: guarda el texto en un archivo .txt o úsalo desde Importar, según tu flujo.'
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
    alert('Copiado. Si no funcionó, selecciona el texto manualmente.');
  } catch (_e) {
    alert('Selecciona el texto del cuadro y cópialo con Ctrl+C.');
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
  const raw = cargarCachePedidos();
  pedidos = deduplicarPedidosPorId((raw || []).map(normalizarPedidoEnMemoria));
  if (pedidos.length > 0) {
    nextPedidoId = Math.max(...pedidos.map((p) => p.id), 0) + 1;
  } else {
    nextPedidoId = 1;
  }
}

function iniciarApp() {
  exponerDebugAppDelivery();
  cargarPedidosDesdeLocalStorage();
  configurarArrastrePointerOrdenEntrega();

  document.documentElement.classList.remove('auth-layout');
  document.body.classList.remove('auth-layout');

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
}

document.addEventListener('DOMContentLoaded', iniciarApp);
