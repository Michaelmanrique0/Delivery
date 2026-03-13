let pedidos = JSON.parse(localStorage.getItem("pedidos")) || [];
let mapa = null;
let marcadores = [];
let rutaLayer = null;
let mapaAjustado = false;
let nextPedidoId = 1;
let vistaPedidosActual = 'pendientes';
let vistaPedidosSeleccionadaManual = false;
const TELEFONO_SOPORTE = '3213153165';
const CONFIG_NOTIFICACION_KEY = 'configNotificacionPago';
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
      guardarConfigNotificacionDesdeUI(false);
    };
  });
  if (numeroDigital) numeroDigital.onchange = () => guardarConfigNotificacionDesdeUI(false);
  if (llavePago) llavePago.onchange = () => guardarConfigNotificacionDesdeUI(false);
  actualizarVisibilidadConfigNotificacion();
}

function abrirConfigNotificacion() {
  cargarConfigNotificacionEnUI();
  const modal = document.getElementById('modalConfigNotificacion');
  if (!modal) return;
  modal.style.display = 'flex';
}

function cerrarConfigNotificacion() {
  const modal = document.getElementById('modalConfigNotificacion');
  if (!modal) return;
  modal.style.display = 'none';
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
  return texto
    .replace(/\u200E|\u200F|\u200B|\u200C|\u200D|\uFEFF/g, '')
    .replace(/\[\d{1,2}:\d{2}[^\]]{0,30}\]\s*[^:\n]+:\s*/g, '');
}

function generarPedidoId(numeroPedido) {
  if (numeroPedido && !pedidos.some(p => p.id === numeroPedido)) {
    return numeroPedido;
  }
  return Math.max(...pedidos.map(p => p.id), 0) + 1;
}

function extraerCamposPedido(bloque) {
  const dirMatch = bloque.match(/📍[^\n]*:\s*([\s\S]*?)(?=🙋|$)/);
  const direccion = dirMatch ? dirMatch[1].trim().replace(/\n\s*/g, ' ').trim() : '';

  const nomMatch = bloque.match(/🙋[^\n]*Nombre[^\n]*:\s*([\s\S]*?)(?=📲|$)/);
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

  const numeroMatch = textoLimpio.match(/(\d+):\s*\n?\s*Para agilizar/) || textoLimpio.match(/^(\d+):/m);
  const numeroPedido = numeroMatch ? parseInt(numeroMatch[1]) : null;

  const campos = extraerCamposPedido(textoLimpio);

  const urlEnTexto = texto.match(/https?:\/\/(?:(?:www\.)?google\.com\/maps|maps\.google\.com|maps\.app\.goo\.gl|maps\.apple\.com|maps\.apple)[^\s\n]*/i);
  const mapUrl = urlEnTexto ? urlEnTexto[0] : '';

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
  const bloques = textoLimpio.split(/¿Todo en orden\?\s*😊?\s*/);
  const urlRegex = /https?:\/\/(?:(?:www\.)?google\.com\/maps|maps\.google\.com|maps\.app\.goo\.gl|maps\.apple\.com|maps\.apple)[^\s\n]*/i;

  let agregados = 0;
  let errores = [];

  const btnProcesar = document.querySelector('.btn-primary');
  const textoOriginalBtn = btnProcesar ? btnProcesar.textContent : '';

  for (const bloque of bloques) {
    if (!bloque.includes('📍')) continue;

    const urlMatch = bloque.match(urlRegex);
    const mapUrl = urlMatch ? urlMatch[0].trim() : '';
    const numMatch = bloque.match(/(\d+):\s*\n/);
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
  localStorage.setItem("pedidos", JSON.stringify(pedidos));
}

function renderPedidos() {
  const lista = document.getElementById("listaPedidos");
  const tabs = document.querySelectorAll('#pedidosTabs .pedidos-tab');
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

  tabs.forEach(btn => {
    const onClick = btn.getAttribute('onclick') || '';
    if (onClick.includes("'pendientes'")) {
      btn.innerHTML = `<i class="fa-regular fa-clock"></i> Pendientes (${pendientes.length})`;
      btn.style.display = 'inline-flex';
    } else if (onClick.includes("'enCurso'")) {
      btn.innerHTML = `<i class="fa-solid fa-truck-fast"></i> En ruta (${enCurso.length})`;
      btn.style.display = enCurso.length > 0 ? 'inline-flex' : 'none';
    } else if (onClick.includes("'entregados'")) {
      btn.innerHTML = `<i class="fa-solid fa-circle-check"></i> Finalizados (${entregados.length})`;
      btn.style.display = entregados.length > 0 ? 'inline-flex' : 'none';
    } else if (onClick.includes("'cancelados'")) {
      btn.innerHTML = `<i class="fa-solid fa-ban"></i> Cancelados (${cancelados.length})`;
      btn.style.display = cancelados.length > 0 ? 'inline-flex' : 'none';
    }
  });

  if (pedidos.length === 0) {
    lista.innerHTML = '<div class="empty-state" id="emptyState"><p>No hay pedidos aún</p><p style="font-size: 14px;">Pega un formato de pedido arriba para comenzar</p></div>';
    tabs.forEach(btn => {
      const activa = btn.getAttribute('onclick')?.includes(`'${vistaPedidosActual}'`);
      btn.classList.toggle('active', !!activa);
    });
    renderListaOrdenEntrega();
    return;
  }

  lista.innerHTML = "";

  tabs.forEach(btn => {
    const activa = btn.getAttribute('onclick')?.includes(`'${vistaPedidosActual}'`);
    btn.classList.toggle('active', !!activa);
  });

  if (vistaPedidosActual === 'enCurso') {
    lista.appendChild(crearSeccionPedidos('seccion-en-curso', enCurso, 'No hay pedidos en ruta'));
  } else if (vistaPedidosActual === 'entregados') {
    lista.appendChild(crearSeccionPedidos('seccion-entregados', entregados, 'No hay pedidos entregados'));
  } else if (vistaPedidosActual === 'cancelados') {
    lista.appendChild(crearSeccionPedidos('seccion-cancelados', cancelados, 'No hay pedidos cancelados'));
  } else {
    lista.appendChild(crearSeccionPedidos('seccion-pendientes', pendientes, 'No hay pedidos pendientes'));
  }

  const recogidoDelDia = pedidos.filter(p => p.entregado && !p.noEntregado).reduce((sum, p) => sum + parseInt(p.valor || 0, 10), 0);
  const enviosEntregados = pedidos.filter(p => p.entregado && !p.noEntregado).length;
  const enviosNoEntregadosEnPunto = pedidos.filter(p => p.noEntregado && p.envioRecogido).length;
  const pagoDomiciliario = (enviosEntregados + enviosNoEntregadosEnPunto) * 12000;
  const entregarTienda = recogidoDelDia - pagoDomiciliario;
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
        <button class="btn-danger btn-icon-only" onclick="eliminarPedido(${index})" title="Eliminar pedido" aria-label="Eliminar pedido"><i class="fa-solid fa-trash"></i></button>
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
    item.draggable = true;
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

function eliminarPedido(index) {
  if (confirm(`¿Estás seguro de eliminar el pedido #${pedidos[index].id}?`)) {
    pedidos.splice(index, 1);
    guardarPedidos();
    renderPedidos();
    actualizarMarcadores();
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

function eliminarTodos() {
  if (confirm("¿Estás seguro de eliminar TODOS los pedidos? Esta acción no se puede deshacer.")) {
    pedidos = [];
    guardarPedidos();
    renderPedidos();
    actualizarMarcadores();
  }
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

  const mensaje = `Pedido #${pedidoId} entregado
Monto recibido: $${montoRecibido.toLocaleString('es-CO')}
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
      <p>Selecciona una opción:</p>
      <div class="modal-no-entregado-actions">
        <button class="btn-warning" onclick="confirmarNoEntregado(true)">Sí fui al punto</button>
        <button class="btn-info" onclick="confirmarNoEntregado(false)">No fui al punto</button>
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

  const numeroAdmin = '573143473582';
  if (tipoFinalizacion === 'foto_no_entregado') {
    const mensajeNoEntrega = `Pedido #${pedidoId} no entregado`;
    window.open(`https://wa.me/${numeroAdmin}?text=${encodeURIComponent(mensajeNoEntrega)}`, '_blank');
    pedidoFinal.noEntregado = true;
    pedidoFinal.envioRecogido = true;
  } else {
    pedidoFinal.noEntregado = false;
    pedidoFinal.envioRecogido = false;
  }

  pedidoFinal.entregado = true;
  pedidoFinal.enCurso = false;
  pedidoFinal.llegoDestino = false;
  pedidoFinal.posicionPendiente = null;

  guardarPedidos();
  renderPedidos();
  actualizarMarcadores();
  notificarSiguientePedido(pedidoId);
}

// --- Notificar en camino ---

function notificarEnCamino(index, pedidoId, opciones = {}) {
  // Si el panel de configuración está visible, sincroniza antes de armar el mensaje.
  guardarConfigNotificacionDesdeUI(false);
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

// --- Sincronización ---

function compactarPedidos() {
  return pedidos.map(p => [
    p.id,
    p.nombre || '',
    p.telefono || '',
    p.direccion || '',
    p.valor || '0',
    p.mapUrl || '',
    (p.entregado ? 1 : 0) | (p.noEntregado ? 2 : 0) | (p.envioRecogido ? 4 : 0) | (p.enCurso ? 8 : 0) | (p.notificadoEnCamino ? 16 : 0) | (p.cancelado ? 32 : 0) | (p.llegoDestino ? 64 : 0),
    (p.productos || []).join('|'),
    (p.coords && Number.isFinite(p.coords.lat) && Number.isFinite(p.coords.lng))
      ? `${p.coords.lat},${p.coords.lng}`
      : '',
    Number.isInteger(p.posicionPendiente) ? p.posicionPendiente : '',
    p.metodoPagoEntrega || '',
    Number(p.montoNequi || 0),
    Number(p.montoDaviplata || 0),
    Number(p.montoEfectivo || 0)
  ]);
}

function descompactarPedidos(arr) {
  return arr.map(c => {
    const coordsTexto = c[8] || '';
    let coords = null;
    if (coordsTexto && typeof coordsTexto === 'string' && coordsTexto.includes(',')) {
      const [latTxt, lngTxt] = coordsTexto.split(',');
      const lat = Number(latTxt);
      const lng = Number(lngTxt);
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        coords = { lat, lng };
      }
    }
    return ({
    id: c[0], nombre: c[1], telefono: c[2], direccion: c[3],
    valor: c[4], mapUrl: c[5],
    entregado: !!(c[6] & 1), noEntregado: !!(c[6] & 2), envioRecogido: !!(c[6] & 4), enCurso: !!(c[6] & 8), notificadoEnCamino: !!(c[6] & 16), cancelado: !!(c[6] & 32), llegoDestino: !!(c[6] & 64),
    productos: c[7] ? c[7].split('|') : [], textoOriginal: '', coords,
    posicionPendiente: Number.isInteger(Number(c[9])) ? Number(c[9]) : null,
    metodoPagoEntrega: c[10] || '',
    montoNequi: Number(c[11] || 0),
    montoDaviplata: Number(c[12] || 0),
    montoEfectivo: Number(c[13] || 0)
  });
  });
}

function uint8ToBase64(arr) {
  let bin = '';
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin);
}

async function comprimirParaQR() {
  const json = JSON.stringify(compactarPedidos());
  if (typeof CompressionStream !== 'undefined') {
    try {
      const blob = new Blob([json]);
      const stream = blob.stream().pipeThrough(new CompressionStream('deflate'));
      const buf = await new Response(stream).arrayBuffer();
      return 'CZ:' + uint8ToBase64(new Uint8Array(buf));
    } catch (e) {}
  }
  return 'CC:' + btoa(unescape(encodeURIComponent(json)));
}

async function descomprimirDatos(str) {
  if (str.startsWith('CZ:')) {
    const bytes = Uint8Array.from(atob(str.slice(3)), c => c.charCodeAt(0));
    const blob = new Blob([bytes]);
    const stream = blob.stream().pipeThrough(new DecompressionStream('deflate'));
    return await new Response(stream).text();
  }
  if (str.startsWith('CC:')) {
    return decodeURIComponent(escape(atob(str.slice(3))));
  }
  return null;
}

async function exportarDatos() {
  if (pedidos.length === 0) { alert('No hay pedidos para exportar'); return; }

  const comprimido = await comprimirParaQR();
  const syncArea = document.getElementById('syncCodeArea');
  const syncData = document.getElementById('syncData');
  syncArea.style.display = 'block';
  syncData.value = comprimido;
  syncData.select();

  await mostrarQR();

  const infoDiv = document.querySelector('.sync-info');
  if (infoDiv) {
    infoDiv.innerHTML = `
      <strong>Opciones de sincronización:</strong><br>
      1. Escanea el código QR con tu celular<br>
      2. Copia el código de texto y pégalo en el otro dispositivo<br><br>
      <strong>Total de pedidos:</strong> ${pedidos.length}`;
  }

  if (navigator.clipboard) {
    navigator.clipboard.writeText(comprimido).catch(() => {});
  }
}

function importarDatos() {
  document.getElementById('syncCodeArea').style.display = 'block';
  document.getElementById('syncData').focus();
}

async function aplicarImportacion() {
  const input = document.getElementById('syncData').value.trim();
  if (!input) { alert('Por favor, pega el código de sincronización'); return; }

  try {
    let listaPedidos;

    if (input.startsWith('CZ:') || input.startsWith('CC:')) {
      const json = await descomprimirDatos(input);
      listaPedidos = descompactarPedidos(JSON.parse(json));
    } else {
      const datos = JSON.parse(decodeURIComponent(escape(atob(input))));
      if (!datos.pedidos || !Array.isArray(datos.pedidos)) throw new Error('Formato inválido');
      listaPedidos = datos.pedidos;
    }

    if (!listaPedidos || listaPedidos.length === 0) throw new Error('No se encontraron pedidos');
    if (!confirm(`¿Importar ${listaPedidos.length} pedido(s)?\n\nEsto reemplazará todos los pedidos actuales.`)) return;

    pedidos = listaPedidos.map(p => {
      if (!p.hasOwnProperty('mapUrl')) p.mapUrl = '';
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
      if (p.entregado) p.posicionPendiente = null;
      return p;
    });

    guardarPedidos();
    renderPedidos();
    setTimeout(() => actualizarMarcadores(), 500);

    document.getElementById('syncCodeArea').style.display = 'none';
    document.getElementById('qrContainer').style.display = 'none';
    document.getElementById('syncData').value = '';
    alert(`${pedidos.length} pedido(s) importado(s) exitosamente.`);
  } catch (error) {
    alert('Error al importar datos. Verifica que el código sea correcto.\n\nError: ' + error.message);
  }
}

async function mostrarQR() {
  const qrContainer = document.getElementById('qrContainer');
  const qrEl = document.getElementById('qrCode');

  if (pedidos.length === 0) { alert('No hay pedidos para generar QR'); return; }

  qrContainer.style.display = 'block';
  qrEl.innerHTML = '<p style="padding:20px;text-align:center;">Comprimiendo datos...</p>';

  const textoQR = await comprimirParaQR();

  if (textoQR.length > 2900) {
    qrEl.innerHTML = `
      <p style="color:#E65100;padding:15px;background:#FFF3E0;border-radius:8px;font-size:14px;">
        ⚠️ Datos muy grandes para QR aún comprimidos (${textoQR.length} chars).<br><br>
        <strong>Alternativa:</strong> Copia el código de texto de arriba y pégalo en el otro dispositivo.
      </p>`;
    return;
  }

  qrEl.innerHTML = '';
  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  const qrSize = isMobile ? 250 : 300;

  try {
    new QRCode(qrEl, {
      text: textoQR,
      width: qrSize,
      height: qrSize,
      colorDark: '#000000',
      colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.L
    });
  } catch (error) {
    qrEl.innerHTML = `
      <p style="color:#E65100;padding:15px;background:#FFF3E0;border-radius:8px;font-size:14px;">
        ⚠️ No se pudo generar el QR.<br><br>
        <strong>Alternativa:</strong> Copia el código de texto de arriba y pégalo en el otro dispositivo.
      </p>`;
  }
}

function verificarDatosEnURL() {
  const datosURL = new URLSearchParams(window.location.search).get('data');
  if (datosURL) {
    if (confirm('¿Importar datos desde el enlace compartido?')) {
      document.getElementById('syncData').value = datosURL;
      aplicarImportacion();
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }
}

// --- Inicialización ---

window.onload = function () {
  pedidos = pedidos.map(p => {
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
  });
  guardarPedidos();
  cargarConfigNotificacionEnUI();
  const btnConfig = document.getElementById('btnConfigNotificacion');
  if (btnConfig) {
    btnConfig.addEventListener('click', (e) => {
      e.preventDefault();
      abrirConfigNotificacion();
    });
  }
  const modalConfig = document.getElementById('modalConfigNotificacion');
  if (modalConfig) {
    modalConfig.addEventListener('click', (e) => {
      if (e.target === modalConfig) cerrarConfigNotificacion();
    });
  }

  if (pedidos.length > 0) {
    nextPedidoId = Math.max(...pedidos.map(p => p.id)) + 1;
  }

  renderPedidos();
  initMap();
  verificarDatosEnURL();
};
