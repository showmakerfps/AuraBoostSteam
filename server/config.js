'use strict';

const { randomBytes } = require('node:crypto');
const { resolve } = require('node:path');

const MOCK_USER_ID = '00000000-0000-4000-8000-000000000001';
const MOCK_EMAIL = 'demo@auraboost.local';
const MOCK_PASSWORD = 'AuraBoost-local-2026';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function origin(value, name) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Configurá ${name} con una URL válida.`);
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`Configurá ${name} como un origen, sin ruta ni parámetros.`);
  }
  return url.origin;
}

function loadConfig(env = process.env) {
  const railway = Boolean(env.RAILWAY_ENVIRONMENT_ID || env.RAILWAY_PROJECT_ID);
  const production = env.NODE_ENV === 'production' || railway;
  const mock = env.DEMO_MODE === 'true';
  if (production && mock) throw new Error('DEMO_MODE solo se admite en local.');

  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Configurá un PORT válido.');
  const appOrigin = origin(env.APP_ORIGIN || (!production && `http://localhost:${port}`), 'APP_ORIGIN');
  const secure = appOrigin.startsWith('https://');
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(appOrigin).hostname);
  if (production && (!secure || loopback)) throw new Error('APP_ORIGIN requiere un dominio HTTPS en producción.');
  if (!production && !loopback) throw new Error('En local, APP_ORIGIN debe usar una dirección de loopback.');

  const allowedUserId = mock ? MOCK_USER_ID : env.ALLOWED_USER_ID?.toLowerCase();
  if (!UUID.test(allowedUserId || '')) throw new Error('Configurá ALLOWED_USER_ID con el UUID de Supabase.');
  const supabaseUrl = mock ? '' : origin(env.SUPABASE_URL, 'SUPABASE_URL');
  if (supabaseUrl && !supabaseUrl.startsWith('https://')) throw new Error('SUPABASE_URL requiere HTTPS.');
  const supabaseKey = mock ? '' : (env.SUPABASE_PUBLISHABLE_KEY || '');
  if (!mock && !supabaseKey) throw new Error('Configurá SUPABASE_PUBLISHABLE_KEY.');
  const supabaseSecretKey = mock ? '' : (env.SUPABASE_SECRET_KEY || '');
  if (production && !supabaseSecretKey) throw new Error('Configurá SUPABASE_SECRET_KEY para las sesiones de AuraBoost.');
  const encryptionKey = env.SESSION_ENCRYPTION_KEY || (mock ? randomBytes(32).toString('base64') : '');
  if (!/^[A-Za-z0-9+/]{43}=$/.test(encryptionKey) || Buffer.from(encryptionKey, 'base64').length !== 32) {
    throw new Error('Configurá SESSION_ENCRYPTION_KEY con 32 bytes en Base64.');
  }
  const steamDataCountries = mock ? '' : env.STEAM_DATA_COUNTRIES?.trim();
  if (!mock && (!steamDataCountries || !/^[\p{L}\p{M} ,.'’()-]{2,160}$/u.test(steamDataCountries))) {
    throw new Error('Configurá STEAM_DATA_COUNTRIES con los países donde se guardarán los datos de Steam.');
  }

  return {
    production, railway, mock, port, appOrigin, secure, allowedUserId, supabaseUrl, supabaseKey, supabaseSecretKey,
    encryptionKey, steamDataCountries,
    host: production ? '0.0.0.0' : new URL(appOrigin).hostname === '[::1]' ? '::1' : '127.0.0.1',
    dataDir: resolve(__dirname, '../.auraboost-demo'),
    steamApiKey: mock ? '' : (env.STEAM_WEB_API_KEY || '')
  };
}

module.exports = { loadConfig, MOCK_EMAIL, MOCK_PASSWORD };
