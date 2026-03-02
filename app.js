let pedidos = JSON.parse(localStorage.getItem("pedidos")) || [];
let mapa = null;
let marcadores = [];
let rutaLayer = null;
let mapaAjustado = false;
let nextPedidoId = 1;
let vistaPedidosActual = 'pendientes';

function initMap() {
  mapa = L.map('mapa').setView([4.6097, -74.0817], 12);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors',
    maxZoom: 19
  }).addTo(mapa);
  actualizarMarcadores();

  // En móviles Leaflet puede calcular mal dimensiones iniciales dentro de layouts flex.
  setTimeout(() => { if (mapa) mapa.invalidateSize(); }, 150);
  setTimeout(() => { if (mapa) mapa.invalidateSize(); }, 500);
  window.addEventListener('resize', () => {
    if (!mapa) return;
    setTimeout(() => mapa.invalidateSize(), 120);
  });
  window.addEventListener('orientationchange', () => {
    if (!mapa) return;
    setTimeout(() => mapa.invalidateSize(), 220);
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
    envioRecogido: false
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
      envioRecogido: false
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
  pedidos.forEach((pedido, index) => {
    if (pedido.entregado) entregados.push({ pedido, index });
    else if (pedido.enCurso) enCurso.push({ pedido, index });
    else pendientes.push({ pedido, index });
  });

  tabs.forEach(btn => {
    const onClick = btn.getAttribute('onclick') || '';
    if (onClick.includes("'pendientes'")) {
      btn.innerHTML = `<i class="fa-regular fa-clock"></i> Pendientes (${pendientes.length})`;
    } else if (onClick.includes("'enCurso'")) {
      btn.innerHTML = `<i class="fa-solid fa-truck-fast"></i> En curso (${enCurso.length})`;
    } else if (onClick.includes("'entregados'")) {
      btn.innerHTML = `<i class="fa-solid fa-circle-check"></i> Finalizados (${entregados.length})`;
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
    lista.appendChild(crearSeccionPedidos('seccion-en-curso', enCurso, 'No hay pedidos en curso'));
  } else if (vistaPedidosActual === 'entregados') {
    lista.appendChild(crearSeccionPedidos('seccion-entregados', entregados, 'No hay pedidos entregados'));
  } else {
    lista.appendChild(crearSeccionPedidos('seccion-pendientes', pendientes, 'No hay pedidos pendientes'));
  }

  const recogidoDelDia = pedidos.filter(p => p.entregado && !p.noEntregado).reduce((sum, p) => sum + parseInt(p.valor || 0, 10), 0);
  const enviosEntregados = pedidos.filter(p => p.entregado && !p.noEntregado).length;
  const enviosNoEntregadosEnPunto = pedidos.filter(p => p.noEntregado && p.envioRecogido).length;
  const pagoDomiciliario = (enviosEntregados + enviosNoEntregadosEnPunto) * 12000;
  const entregarTienda = recogidoDelDia - pagoDomiciliario;

  const elResumen = document.getElementById('totalesResumen');
  if (elResumen) {
    document.getElementById('totalRecogidoDia').textContent = recogidoDelDia.toLocaleString('es-CO');
    document.getElementById('totalPagoDomiciliario').textContent = pagoDomiciliario.toLocaleString('es-CO');
    document.getElementById('totalEntregarTienda').textContent = entregarTienda.toLocaleString('es-CO');
    elResumen.style.display = (recogidoDelDia > 0 || pagoDomiciliario > 0) ? 'flex' : 'none';
  }

  renderListaOrdenEntrega();
}

function cambiarVistaPedidos(vista) {
  if (!['pendientes', 'enCurso', 'entregados'].includes(vista)) return;
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
  div.className = "pedido" + (pedido.entregado ? " entregado" : "") + (pedido.enCurso && !pedido.entregado ? " en-curso" : "");
  div.draggable = !pedido.entregado;
  div.dataset.index = index;
  div.dataset.id = pedido.id;

  const telefonoLimpio = pedido.telefono ? pedido.telefono.replace(/\D/g, '') : '';
  const valorFormato = parseInt(pedido.valor || 0, 10).toLocaleString('es-CO');
  const btnNoEntregadoHtml = pedido.entregado
    ? `<div class="pedido-no-entregado-wrap"><button class="btn-warning" onclick="marcarNoEntregado(${index})" style="width: 100%;"><i class="fa-solid fa-rotate-left"></i> No entregado</button></div>`
    : '';
  const btnRegresarPendienteHtml = (!pedido.entregado && pedido.enCurso)
    ? `<button class="btn-info" onclick="marcarPendiente(${index})"><i class="fa-solid fa-rotate-left"></i> Regresar a pendiente</button>`
    : '';

  const estadoTexto = pedido.entregado
    ? (pedido.noEntregado ? ' - No entregado' : ' - Entregado')
    : (pedido.enCurso ? ' - En curso' : '');

  div.innerHTML = `
    <div class="pedido-header">
      <div class="pedido-numero">Pedido #${pedido.id}${estadoTexto}</div>
      <div class="pedido-header-btns">
        <button class="btn-edit" onclick="editarPedido(${index})" style="padding: 5px 10px; font-size: 12px;"><i class="fa-solid fa-pen-to-square"></i> Editar</button>
        <button class="btn-danger" onclick="eliminarPedido(${index})" style="padding: 5px 10px; font-size: 12px;"><i class="fa-solid fa-trash"></i> Eliminar</button>
      </div>
    </div>
    <div class="pedido-cliente">${pedido.nombre || 'Cliente no especificado'}</div>
    <div class="pedido-info">
      <strong>Teléfono:</strong> ${pedido.telefono || 'No especificado'}<br>
      <strong>Dirección:</strong> ${pedido.direccion || 'No especificada'}<br>
      <strong>Productos:</strong> ${pedido.productos && pedido.productos.length > 0 ? pedido.productos.join(', ') : 'No especificado'}<br>
      <strong>Valor:</strong> $${valorFormato}<br>
    </div>
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
        <summary class="btn-route"><i class="fa-solid fa-route"></i> Navegación</summary>
        <div class="pedido-dropdown-content">
          <button class="btn-route" onclick="enrutarConMaps(${index}, ${pedido.id})"><i class="fa-solid fa-map-location-dot"></i> Google Maps</button>
          <button class="btn-route" onclick="enrutarConWaze(${index}, ${pedido.id})"><i class="fa-solid fa-location-arrow"></i> Waze</button>
        </div>
      </details>
      <details class="pedido-dropdown">
        <summary class="btn-camera"><i class="fa-solid fa-camera"></i> Evidencia</summary>
        <div class="pedido-dropdown-content">
          <button class="btn-camera" onclick="fotoEntregado(${index}, ${pedido.id})"><i class="fa-solid fa-camera"></i> Foto entregado</button>
          <button class="btn-camera" onclick="mostrarOpcionesNoEntregado(${index}, ${pedido.id})"><i class="fa-solid fa-camera-rotate"></i> Foto no entregado</button>
        </div>
      </details>
    </div>
    <div class="pedido-actions">
      <div class="pedido-actions-row">
        <button class="btn-notify" onclick="notificarEnCamino(${index}, ${pedido.id})"><i class="fa-solid fa-bullhorn"></i> Notificar en camino</button>
      </div>
      ${btnRegresarPendienteHtml ? `<div class="pedido-actions-row">${btnRegresarPendienteHtml}</div>` : ''}
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

  const pedidosActivos = pedidos.filter(p => !p.entregado);
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
  pedido.posicionPendiente = null;
  pedidos.splice(index, 1);
  pedidos.push(pedido);
  guardarPedidos();
  renderPedidos();
  actualizarMarcadores();
}

function marcarEnCurso(index) {
  const pedido = pedidos[index];
  if (!pedido || pedido.entregado) return;
  if (pedido.posicionPendiente == null) pedido.posicionPendiente = index;
  pedido.enCurso = true;
  guardarPedidos();
  renderPedidos();
}

function marcarPendiente(index) {
  const pedido = pedidos[index];
  if (!pedido || pedido.entregado) return;

  const posicionOriginal = Number.isInteger(pedido.posicionPendiente)
    ? pedido.posicionPendiente
    : null;
  pedido.enCurso = false;
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
  pedido.posicionPendiente = null;
  pedido.noEntregado = false;
  pedido.envioRecogido = false;
  pedidos.splice(index, 1);
  pedidos.unshift(pedido);
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

function editarPedido(index) {
  const pedido = pedidos[index];
  if (!pedido) return;

  const valorActual = parseInt(pedido.valor || 0).toLocaleString('es-CO');
  const nuevoValor = prompt(`Valor actual: $${valorActual}\n\nIngresa el nuevo valor (solo números):`, pedido.valor || '0');

  if (nuevoValor !== null) {
    const valorLimpio = nuevoValor.replace(/[^\d]/g, '');
    if (valorLimpio !== '') {
      pedido.valor = valorLimpio;
    }
  }

  const nuevaUrl = prompt(`URL Maps actual:\n${pedido.mapUrl || '(vacía)'}\n\nIngresa la nueva URL de Google Maps (dejar vacío para no cambiar):`, pedido.mapUrl || '');

  if (nuevaUrl !== null && nuevaUrl.trim() !== pedido.mapUrl) {
    pedido.mapUrl = nuevaUrl.trim();
  }

  guardarPedidos();
  renderPedidos();
  actualizarMarcadores();
}

// --- Comunicación ---

function llamar(numero) {
  if (!numero) { alert("No hay número de teléfono disponible"); return; }
  const n = numero.toString().replace(/\D/g, '');
  if (!n) { alert("Número de teléfono inválido"); return; }
  window.location.href = `tel:${n}`;
}

function whatsappLlamar(numero) {
  if (!numero) { alert("No hay número de teléfono disponible"); return; }
  const n = numero.toString().replace(/\D/g, '');
  if (!n) { alert("Número de teléfono inválido"); return; }
  const wa = n.startsWith('57') ? n : `57${n}`;
  window.open(`https://wa.me/${wa}`, "_blank");
}

function whatsappMensaje(numero) {
  if (!numero) { alert("No hay número de teléfono disponible"); return; }
  const n = numero.toString().replace(/\D/g, '');
  if (!n) { alert("Número de teléfono inválido"); return; }
  const wa = n.startsWith('57') ? n : `57${n}`;
  window.open(`https://wa.me/${wa}?text=Hola`, "_blank");
}

// --- Fotos / WhatsApp Admin ---

function fotoEntregado(index, pedidoId) {
  const numeroAdmin = '573143473582';
  const mensaje = `Pedido #${pedidoId} entregado`;
  window.open(`https://wa.me/${numeroAdmin}?text=${encodeURIComponent(mensaje)}`, '_blank');
  const pedido = pedidos[index];
  if (!pedido) return;
  pedido.noEntregado = false;
  pedido.envioRecogido = false;
  marcarEntregado(index);
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
  window.open(`https://wa.me/${numeroAdmin}?text=${encodeURIComponent(mensaje)}`, '_blank');

  pedido.entregado = true;
  pedido.enCurso = false;
  pedido.posicionPendiente = null;
  pedido.noEntregado = true;
  pedido.envioRecogido = enUbicacion;
  pedidos.splice(indexFinal, 1);
  pedidos.push(pedido);
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

function enrutarConMaps(index, pedidoId) {
  const u = getUbicacionPedido(index, pedidoId);
  if (!u) { alert('No hay ubicación disponible para este pedido.'); return; }
  marcarEnCurso(index);
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

function enrutarConWaze(index, pedidoId) {
  const u = getUbicacionPedido(index, pedidoId);
  if (!u) { alert('No hay ubicación disponible para este pedido.'); return; }
  marcarEnCurso(index);
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
}

// --- Notificar en camino ---

function notificarEnCamino(index, pedidoId) {
  const pedido = pedidos[index];
  if (!pedido) return;
  const telefonoCliente = pedido.telefono ? String(pedido.telefono).replace(/\D/g, '') : '';
  if (!telefonoCliente) { alert('No hay número de teléfono del cliente disponible'); return; }

  const nombre = pedido.nombre || 'cliente';
  const precio = parseInt(pedido.valor || 0, 10).toLocaleString('es-CO');
  const wa = telefonoCliente.startsWith('57') ? telefonoCliente : `57${telefonoCliente}`;

  const mensaje = `Hola ${nombre}

Te informamos que nuestro repartidor de Valero Store se encuentra en camino hacia tu ubicación para entregar el pedido.

Por favor ten en cuenta:
- Estar pendiente con los $${precio} en mano
- El repartidor NO CUENTA CON CAMBIO
- El tiempo de espera desde la llegada al punto de entrega es de 10 minutos

Si deseas pagar por Nequi o Daviplata, el número es: 3143645061
Aparecerá como Mic**** Por*******
O si gustas puedes pagar por Bre-B con la llave: @NEQUIMIC7057

Gracias por tu compra ${nombre}`;

  window.open(`https://wa.me/${wa}?text=${encodeURIComponent(mensaje)}`, '_blank');
}

// --- Mapa: marcadores y ruta ---

function actualizarMarcadores() {
  if (!mapa) return;
  marcadores.forEach(item => mapa.removeLayer(item.marker));
  marcadores = [];
  if (rutaLayer) { mapa.removeLayer(rutaLayer); rutaLayer = null; }
  if (pedidos.length === 0) return;

  let completados = 0;
  const conUbicacion = pedidos.filter(p => p.coords || p.mapUrl || p.direccion);
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

function crearIconoMarcador(numPedido) {
  const html = `
    <div style="background-color:#f44336;color:white;width:35px;height:35px;
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
        const marker = L.marker([lat, lng], { icon: crearIconoMarcador(Number(pedidoId)) }).addTo(mapa);
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
    const marker = L.marker([lat, lng], { icon: crearIconoMarcador(Number(pedidoId)) }).addTo(mapa);
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
    (p.entregado ? 1 : 0) | (p.noEntregado ? 2 : 0) | (p.envioRecogido ? 4 : 0) | (p.enCurso ? 8 : 0),
    (p.productos || []).join('|'),
    (p.coords && Number.isFinite(p.coords.lat) && Number.isFinite(p.coords.lng))
      ? `${p.coords.lat},${p.coords.lng}`
      : '',
    Number.isInteger(p.posicionPendiente) ? p.posicionPendiente : ''
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
    entregado: !!(c[6] & 1), noEntregado: !!(c[6] & 2), envioRecogido: !!(c[6] & 4), enCurso: !!(c[6] & 8),
    productos: c[7] ? c[7].split('|') : [], textoOriginal: '', coords,
    posicionPendiente: Number.isInteger(Number(c[9])) ? Number(c[9]) : null
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
    if (p.entregado) {
      p.enCurso = false;
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

  if (pedidos.length > 0) {
    nextPedidoId = Math.max(...pedidos.map(p => p.id)) + 1;
  }

  renderPedidos();
  initMap();
  verificarDatosEnURL();
};
