const { getMeta, setMeta } = require('./data');

const META_STORE = 'payment_config_store';

function metaUserKey(userId) {
  return `payment_config_user_${String(userId)}`;
}

function boolVal(valor, predeterminado) {
  if (typeof valor === 'boolean') return valor;
  if (typeof valor === 'number') return valor !== 0;
  if (typeof valor === 'string') {
    const n = valor.trim().toLowerCase();
    if (n === 'false' || n === '0') return false;
    if (n === 'true' || n === '1') return true;
  }
  return predeterminado;
}

function emptyPaymentConfig() {
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

function parsePaymentConfig(raw) {
  const g = raw && typeof raw === 'object' ? raw : {};
  const legacyNum = String(g.numeroDigital || '').replace(/\D/g, '');
  let numeroNequi = String(g.numeroNequi || '').replace(/\D/g, '');
  let numeroDaviplata = String(g.numeroDaviplata || '').replace(/\D/g, '');
  if (!numeroNequi && legacyNum) numeroNequi = legacyNum;
  if (!numeroDaviplata && legacyNum) numeroDaviplata = legacyNum;
  const llavePago = String(g.llavePago || '').trim();
  return {
    tieneNequi: boolVal(g.tieneNequi, false) || !!numeroNequi,
    tieneDaviplata: boolVal(g.tieneDaviplata, false) || !!numeroDaviplata,
    numeroNequi,
    numeroDaviplata,
    nombreTitular: String(g.nombreTitular || '').trim(),
    tieneLlave: boolVal(g.tieneLlave, false) || !!llavePago,
    llavePago,
  };
}

function paymentConfigListo(cfg) {
  const c = parsePaymentConfig(cfg);
  if (c.tieneNequi && c.numeroNequi) return true;
  if (c.tieneDaviplata && c.numeroDaviplata) return true;
  if (c.tieneLlave && c.llavePago) return true;
  return false;
}

function validatePaymentConfig(cfg) {
  const c = parsePaymentConfig(cfg);
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
  if (!paymentConfigListo(c)) {
    return 'Completa al menos un medio de pago con sus datos.';
  }
  return '';
}

async function readMetaJson(key, fallback) {
  const raw = await getMeta(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (_e) {
    return fallback;
  }
}

async function getStorePaymentConfig() {
  const raw = await readMetaJson(META_STORE, null);
  return parsePaymentConfig(raw || {});
}

async function setStorePaymentConfig(cfg) {
  await setMeta(META_STORE, JSON.stringify(parsePaymentConfig(cfg)));
}

async function getUserPaymentSettings(userId) {
  const raw = await readMetaJson(metaUserKey(userId), null);
  if (!raw || typeof raw !== 'object') {
    return { personal: emptyPaymentConfig(), usarMediosTienda: false };
  }
  if (raw.personal || raw.usarMediosTienda != null) {
    return {
      personal: parsePaymentConfig(raw.personal || {}),
      usarMediosTienda: !!raw.usarMediosTienda,
    };
  }
  return { personal: parsePaymentConfig(raw), usarMediosTienda: false };
}

async function setUserPaymentSettings(userId, { personal, usarMediosTienda }) {
  await setMeta(
    metaUserKey(userId),
    JSON.stringify({
      personal: parsePaymentConfig(personal),
      usarMediosTienda: !!usarMediosTienda,
    })
  );
}

function resolveEffectivePaymentConfig(userSettings, storeConfig) {
  if (userSettings && userSettings.usarMediosTienda) {
    return parsePaymentConfig(storeConfig);
  }
  return parsePaymentConfig(userSettings ? userSettings.personal : {});
}

module.exports = {
  emptyPaymentConfig,
  parsePaymentConfig,
  paymentConfigListo,
  validatePaymentConfig,
  getStorePaymentConfig,
  setStorePaymentConfig,
  getUserPaymentSettings,
  setUserPaymentSettings,
  resolveEffectivePaymentConfig,
};
