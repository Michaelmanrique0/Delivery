/** Tema claro/oscuro: respeta el sistema y guarda la preferencia. */
(function (global) {
  const KEY = 'deliveryTheme';

  function leerPreferencia() {
    try {
      return localStorage.getItem(KEY);
    } catch (_e) {
      return null;
    }
  }

  function sistemaOscuro() {
    return Boolean(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  }

  function esOscuro() {
    const t = leerPreferencia();
    if (t === 'dark') return true;
    if (t === 'light') return false;
    return sistemaOscuro();
  }

  function aplicarTema() {
    const dark = esOscuro();
    document.documentElement.classList.toggle('dark', dark);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#09090b' : '#f8fafc');
    const btn = document.getElementById('btnTemaOscuro');
    if (!btn) return;
    btn.setAttribute('aria-pressed', dark ? 'true' : 'false');
    btn.setAttribute('aria-label', dark ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro');
    if (typeof iconoUi === 'function') {
      btn.innerHTML = iconoUi(dark ? 'sun' : 'moon');
    }
  }

  function alternarTemaApp() {
    try {
      localStorage.setItem(KEY, esOscuro() ? 'light' : 'dark');
    } catch (_e) {}
    aplicarTema();
  }

  global.alternarTemaApp = alternarTemaApp;
  global.aplicarTemaApp = aplicarTema;
  aplicarTema();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', aplicarTema);
  }
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (!leerPreferencia()) aplicarTema();
    });
  }
})(window);
