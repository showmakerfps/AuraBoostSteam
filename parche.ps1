$ErrorActionPreference = 'Stop'
$root = (Get-Location).Path
if (-not (Test-Path 'server\app.js') -or -not (Test-Path 'src\ui.js')) {
  throw 'Ejecutá el script desde la carpeta del proyecto (donde están server y src).'
}

function Write-File($relative, $content) {
  $full = Join-Path $root $relative
  $dir = Split-Path -Parent $full
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  [IO.File]::WriteAllText($full, $content, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "OK  $relative"
}

$content = @'
'use strict';

const { EventEmitter } = require('node:events');
const { randomBytes } = require('node:crypto');
const SteamUser = require('steam-user');

const PENDING_TTL = 5 * 60_000;
const randomId = () => randomBytes(16).toString('base64url');

const MESSAGES = {
  5: 'Usuario o contraseña incorrectos.',
  63: 'Código de Steam Guard incorrecto.',
  65: 'Código de Steam Guard incorrecto.',
  84: 'Steam limitó los intentos. Esperá unos minutos y volvé a intentar.',
  85: 'La cuenta se conectó desde otro lado.',
  88: 'Código de Steam Guard incorrecto.'
};

function describe(error) {
  return Object.assign(new Error(MESSAGES[error?.eresult] ?? 'Steam rechazó la conexión. Revisá los datos.'), { status: 400 });
}

function createSteamSessions({ tokens, onState, onError } = {}) {
  const clients = new Map();
  const playing = new Map();
  const pending = new Map();
  const bus = new EventEmitter();
  const notify = () => onState?.();

  function wire(steamId, client) {
    client.on('loggedOn', () => {
      client.setPersona(SteamUser.EPersonaState.Online);
      const appid = playing.get(steamId);
      if (appid) client.gamesPlayed([appid]);
      notify();
    });
    client.on('refreshToken', refreshToken => {
      void tokens.save(steamId, client.auraUserId, refreshToken).catch(() => {});
    });
    client.on('steamGuard', (domain, callback, lastCodeWrong) => {
      const loginId = randomId();
      pending.set(loginId, { steamId, callback, expiresAt: Date.now() + PENDING_TTL });
      bus.emit('guard', { steamId, loginId, domain: domain || null, lastCodeWrong: Boolean(lastCodeWrong) });
      notify();
    });
    client.on('disconnected', notify);
    client.on('error', error => {
      onError?.({ steamId, message: describe(error).message });
      notify();
    });
  }

  function create(steamId, userId) {
    const client = new SteamUser({ autoRelogin: true, renewRefreshTokens: true });
    client.auraUserId = userId;
    clients.set(steamId, client);
    wire(steamId, client);
    return client;
  }

  function disconnect(steamId) {
    const client = clients.get(steamId);
    clients.delete(steamId);
    client?.logOff();
    for (const [loginId, entry] of pending) if (entry.steamId === steamId) pending.delete(loginId);
    notify();
  }

  function login(steamId, userId, accountName, password) {
    disconnect(steamId);
    const client = create(steamId, userId);
    return new Promise((resolve, reject) => {
      let done = false;
      const settle = (fn, value) => { if (!done) { done = true; clean(); fn(value); } };
      const timer = setTimeout(() => settle(reject, new Error('Steam no respondió. Volvé a intentar.')), 45_000);
      const ok = () => settle(resolve, { status: 'connected' });
      const bad = error => settle(reject, describe(error));
      const guard = payload => { if (payload.steamId === steamId) settle(resolve, { status: 'guard', loginId: payload.loginId }); };
      const clean = () => { clearTimeout(timer); client.off('loggedOn', ok); client.off('error', bad); bus.off('guard', guard); };
      client.on('loggedOn', ok);
      client.on('error', bad);
      bus.on('guard', guard);
      client.logOn({ accountName, password });
    });
  }

  function guard(steamId, loginId, code) {
    const entry = pending.get(loginId);
    if (!entry || entry.steamId !== steamId || entry.expiresAt <= Date.now()) {
      pending.delete(loginId);
      return Promise.reject(new Error('El código venció. Volvé a conectar la cuenta.'));
    }
    const client = clients.get(steamId);
    return new Promise((resolve, reject) => {
      let done = false;
      const settle = (fn, value) => { if (!done) { done = true; clean(); fn(value); } };
      const timer = setTimeout(() => settle(reject, new Error('Steam no respondió.')), 45_000);
      const ok = () => { pending.delete(loginId); settle(resolve, { status: 'connected' }); };
      const bad = error => settle(reject, describe(error));
      const next = payload => { if (payload.steamId === steamId) settle(resolve, { status: 'guard', loginId: payload.loginId }); };
      const clean = () => { clearTimeout(timer); client?.off('loggedOn', ok); client?.off('error', bad); bus.off('guard', next); };
      client?.on('loggedOn', ok);
      client?.on('error', bad);
      bus.on('guard', next);
      entry.callback(code);
    });
  }

  function launch(steamId, appid) {
    const client = clients.get(steamId);
    if (!client?.steamID) {
      throw Object.assign(new Error('Conectá la sesión de Steam de esta cuenta antes de iniciar un juego.'), { status: 409 });
    }
    playing.set(steamId, appid);
    client.gamesPlayed([appid]);
  }

  function stop(steamId) {
    playing.delete(steamId);
    clients.get(steamId)?.gamesPlayed([]);
  }

  const isConnected = steamId => Boolean(clients.get(steamId)?.steamID);
  const steamIdOf = steamId => clients.get(steamId)?.steamID?.getSteamID64() ?? null;
  const playingEntries = () => [...playing]
    .filter(([steamId]) => isConnected(steamId))
    .map(([steamId]) => ({ steamId, userId: clients.get(steamId).auraUserId }));

  async function restore() {
    let rows = [];
    try {
      rows = await tokens.all();
    } catch {
      return;
    }
    for (const row of rows) {
      if (row.appid) playing.set(row.steamId, row.appid);
      create(row.steamId, row.userId).logOn({ refreshToken: row.token });
      await new Promise(done => setTimeout(done, 250));
    }
  }

  function close() {
    for (const client of clients.values()) client.logOff();
    clients.clear();
    playing.clear();
    pending.clear();
  }

  return { login, guard, launch, stop, disconnect, isConnected, steamIdOf, playingEntries, restore, close };
}

module.exports = { createSteamSessions };
'@
Write-File 'server/steam/clients.js' $content

$content = @'
const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createTokenCipher } = require('./crypto');

const accountTable = 'auraboost_steam_accounts';
const settingsTable = 'auraboost_user_settings';
const historyTable = 'auraboost_history';
const sessionTable = 'auraboost_sessions';
const steamTokenTable = 'auraboost_steam_tokens';
const summaryFields = 'steam_id,name,avatar,presence,online,synced_at,library_status,created_at,playing_appid,playing_since,session_linked';
const accountFields = `${summaryFields},config,games`;
const historyLimit = 100;

class StoreError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function defaultConfig() {
  return { title: '', description: '', reply: '', selected: [], favorites: [], profiles: [], autoSend: false };
}

function toAccount(row) {
  if (!row) return null;
  const account = {
    id: row.steam_id, name: row.name, avatar: row.avatar, presence: row.presence,
    online: row.online, syncedAt: row.synced_at, libraryStatus: row.library_status, createdAt: row.created_at,
    playing: row.playing_appid ? { appid: row.playing_appid, since: row.playing_since } : null,
    sessionLinked: row.session_linked === true
  };
  if (row.config !== undefined) account.config = { ...defaultConfig(), ...row.config };
  if (row.games !== undefined) account.games = row.games;
  return account;
}

function toHistory(row) {
  return { createdAt: row.created_at, text: row.text };
}

function createRequest({ supabaseUrl, supabaseKey, fetchImpl }) {
  return async function request(resource, { method = 'GET', query, body, token, prefer } = {}) {
    const url = new URL(`/rest/v1/${resource}`, supabaseUrl);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
    const headers = { apikey: supabaseKey, Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (prefer) headers.Prefer = prefer;

    let response;
    try {
      response = await fetchImpl(url, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error', signal: AbortSignal.timeout(10_000)
      });
    } catch {
      throw new StoreError(503, 'No se pudo conectar con el almacenamiento.');
    }
    if (!response.ok) {
      const problem = await response.json().catch(() => null);
      if (response.status === 409 && problem?.code === '23505') {
        throw new StoreError(409, 'Ese registro ya existe.');
      }
      if (response.status === 409 && problem?.code === '23503') {
        throw new StoreError(404, 'No se encontró la cuenta de Steam.');
      }
      throw new StoreError(503, 'No se pudo acceder al almacenamiento.');
    }
    if (response.status === 204 || prefer === 'return=minimal') return null;
    try {
      return await response.json();
    } catch {
      throw new StoreError(503, 'El almacenamiento devolvió una respuesta inválida.');
    }
  };
}

function assertOwner(actor, allowedUserId, mock) {
  if (!actor || typeof allowedUserId !== 'string' || !allowedUserId || actor.id !== allowedUserId) {
    throw new StoreError(403, 'Esta cuenta no tiene acceso a AuraBoost.');
  }
  if (!mock && (typeof actor.accessToken !== 'string' || !actor.accessToken)) {
    throw new StoreError(401, 'Tu sesión venció. Volvé a iniciar sesión.');
  }
}

function accountRow(actor, { id, name, avatar = null, presence = null, online = null,
  syncedAt = null, libraryStatus = 'pending', config = {}, games = [] }) {
  return {
    user_id: actor.id, steam_id: id, name, avatar, presence, online, synced_at: syncedAt,
    library_status: libraryStatus, config: { ...defaultConfig(), ...config }, games
  };
}

function snapshotRow({ name, avatar, presence, online, syncedAt, libraryStatus, games }) {
  return {
    name, avatar, presence, online, synced_at: syncedAt, library_status: libraryStatus, games
  };
}

function syncHistoryText(row) {
  const messages = {
    available: `Biblioteca sincronizada. ${row.games.length} juegos recibidos.`,
    unavailable: 'Steam no devolvió una biblioteca visible.',
    unconfigured: 'La consulta a Steam requiere una clave Web API.'
  };
  return messages[row.library_status];
}

function createSupabaseStore({ supabaseUrl, supabaseKey, fetchImpl }) {
  const request = createRequest({ supabaseUrl, supabaseKey, fetchImpl });
  const matching = (actor, id) => ({ user_id: `eq.${actor.id}`, steam_id: `eq.${id}` });
  const representation = 'return=representation';

  return {
    async listAccounts(actor) {
      const rows = await request(accountTable, {
        token: actor.accessToken,
        query: { user_id: `eq.${actor.id}`, select: summaryFields, order: 'created_at.asc,steam_id.asc' }
      });
      return rows.map(toAccount);
    },

    async getAccount(actor, id) {
      const [row] = await request(accountTable, {
        token: actor.accessToken, query: { ...matching(actor, id), select: accountFields }
      });
      return toAccount(row);
    },

    async addAccount(actor, account) {
      const [row] = await request(accountTable, {
        method: 'POST', token: actor.accessToken, prefer: representation,
        query: { select: accountFields }, body: accountRow(actor, account)
      });
      return toAccount(row);
    },

    async removeAccount(actor, id) {
      const [row] = await request(accountTable, {
        method: 'DELETE', token: actor.accessToken, prefer: representation,
        query: { ...matching(actor, id), select: 'steam_id' }
      });
      return Boolean(row);
    },

    async updateSettings(actor, id, patch) {
      const [row] = await request('rpc/auraboost_update_account_config', {
        method: 'POST', token: actor.accessToken, query: { select: accountFields },
        body: { account_id: id, config_patch: patch }
      });
      return toAccount(row);
    },

    async saveSnapshot(actor, id, snapshot) {
      const [row] = await request(accountTable, {
        method: 'PATCH', token: actor.accessToken, prefer: representation,
        query: { ...matching(actor, id), select: accountFields }, body: snapshotRow(snapshot)
      });
      return toAccount(row);
    },

    async setPlaying(actor, id, appid) {
      const [row] = await request('rpc/auraboost_set_playing', {
        method: 'POST', token: actor.accessToken, query: { select: summaryFields },
        body: { p_steam_id: id, p_appid: appid }
      });
      return toAccount(row);
    },

    async setSessionLinked(actor, id, linked) {
      const [row] = await request(accountTable, {
        method: 'PATCH', token: actor.accessToken, prefer: representation,
        query: { ...matching(actor, id), select: summaryFields }, body: { session_linked: linked }
      });
      return toAccount(row);
    },

    async getSettings(actor) {
      const [row] = await request(settingsTable, {
        token: actor.accessToken, query: { user_id: `eq.${actor.id}`, select: 'selected_account_id' }
      });
      return { selectedAccountId: row?.selected_account_id ?? null };
    },

    async updateUserSettings(actor, { selectedAccountId }) {
      const [row] = await request(settingsTable, {
        method: 'POST', token: actor.accessToken, prefer: `resolution=merge-duplicates,${representation}`,
        query: { on_conflict: 'user_id', select: 'selected_account_id' },
        body: { user_id: actor.id, selected_account_id: selectedAccountId }
      });
      return { selectedAccountId: row.selected_account_id };
    },

    async listHistory(actor, id) {
      const query = {
        user_id: `eq.${actor.id}`, order: 'created_at.desc,id.desc', select: 'created_at,text', limit: historyLimit
      };
      if (id) query.steam_id = `eq.${id}`;
      const rows = await request(historyTable, { token: actor.accessToken, query });
      return rows.map(toHistory);
    },

    async addHistory(actor, { id, text }) {
      const [row] = await request(historyTable, {
        method: 'POST', token: actor.accessToken, prefer: representation,
        query: { select: 'created_at,text' }, body: { user_id: actor.id, steam_id: id, text }
      });
      return toHistory(row);
    }
  };
}

function createMockStore(dataDir) {
  const statePath = dataDir && path.join(dataDir, 'state.json');
  let memory = { accounts: [], settings: { selectedAccountId: null }, history: [] };
  let queue = Promise.resolve();

  async function read() {
    if (!statePath) return memory;
    try {
      return JSON.parse(await fs.readFile(statePath, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return memory;
      throw new StoreError(503, 'No se pudo leer el almacenamiento de demostración.');
    }
  }

  async function write(state) {
    if (statePath) {
      const temporary = path.join(dataDir, `state-${randomUUID()}.tmp`);
      try {
        await fs.mkdir(dataDir, { recursive: true });
        await fs.writeFile(temporary, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
        await fs.rename(temporary, statePath);
      } catch {
        await fs.unlink(temporary).catch(() => {});
        throw new StoreError(503, 'No se pudo guardar el almacenamiento de demostración.');
      }
    }
    memory = state;
  }

  function run(action, { changes = false } = {}) {
    const operation = queue.then(async () => {
      const state = structuredClone(await read());
      const result = action(state);
      if (changes) await write(state);
      return result;
    });
    queue = operation.catch(() => {});
    return operation;
  }

  const change = { changes: true };
  const find = (state, id) => state.accounts.find(row => row.steam_id === id);

  function recordHistory(state, id, text) {
    const row = { steam_id: id, text, created_at: new Date().toISOString() };
    state.history.unshift(row);
    return toHistory(row);
  }

  return {
    listAccounts() {
      return run(state => state.accounts.map(({ config, games, ...row }) => toAccount(row)));
    },
    getAccount(actor, id) {
      return run(state => toAccount(find(state, id)));
    },
    addAccount(actor, account) {
      return run(state => {
        if (find(state, account.id)) throw new StoreError(409, 'Esa cuenta de Steam ya está vinculada.');
        const row = { ...accountRow(actor, account), created_at: new Date().toISOString() };
        state.accounts.push(row);
        recordHistory(state, account.id, 'Cuenta de Steam vinculada.');
        return toAccount(row);
      }, change);
    },
    removeAccount(actor, id) {
      return run(state => {
        if (!find(state, id)) return false;
        state.accounts = state.accounts.filter(row => row.steam_id !== id);
        state.history = state.history.filter(row => row.steam_id !== id);
        if (state.settings.selectedAccountId === id) state.settings.selectedAccountId = null;
        return true;
      }, change);
    },
    updateSettings(actor, id, patch) {
      return run(state => {
        const row = find(state, id);
        if (row) row.config = { ...row.config, ...structuredClone(patch) };
        return toAccount(row);
      }, change);
    },
    saveSnapshot(actor, id, snapshot) {
      return run(state => {
        const row = find(state, id);
        if (!row) return null;
        const previousSync = row.synced_at;
        for (const [key, value] of Object.entries(snapshotRow(snapshot))) {
          if (value !== undefined) row[key] = structuredClone(value);
        }
        if (snapshot.syncedAt && Date.parse(snapshot.syncedAt) !== Date.parse(previousSync)) {
          const text = syncHistoryText(row);
          if (text) recordHistory(state, id, text);
        }
        return toAccount(row);
      }, change);
    },
    setPlaying(actor, id, appid) {
      return run(state => {
        const row = find(state, id);
        if (!row) return null;
        row.playing_appid = appid ?? null;
        row.playing_since = appid ? new Date().toISOString() : null;
        return toAccount(row);
      }, change);
    },
    setSessionLinked(actor, id, linked) {
      return run(state => {
        const row = find(state, id);
        if (!row) return null;
        row.session_linked = linked;
        return toAccount(row);
      }, change);
    },
    getSettings() {
      return run(state => state.settings);
    },
    updateUserSettings(actor, { selectedAccountId }) {
      return run(state => {
        if (selectedAccountId !== null && !find(state, selectedAccountId)) {
          throw new StoreError(404, 'No se encontró la cuenta de Steam.');
        }
        state.settings.selectedAccountId = selectedAccountId;
        return state.settings;
      }, change);
    },
    listHistory(actor, id) {
      return run(state => state.history.filter(row => !id || row.steam_id === id).slice(0, historyLimit).map(toHistory));
    },
    addHistory(actor, { id, text }) {
      return run(state => {
        if (!find(state, id)) throw new StoreError(404, 'No se encontró la cuenta de Steam.');
        return recordHistory(state, id, text);
      }, change);
    }
  };
}

function createStore({ supabaseUrl, supabaseKey, allowedUserId, mock = false, dataDir,
  fetchImpl = globalThis.fetch } = {}) {
  const store = mock ? createMockStore(dataDir) : createSupabaseStore({ supabaseUrl, supabaseKey, fetchImpl });
  return Object.fromEntries(Object.entries(store).map(([name, operation]) => [name, async (actor, ...args) => {
    assertOwner(actor, allowedUserId, mock);
    return operation(actor, ...args);
  }]));
}

function createSessionStore({ supabaseUrl, supabaseSecretKey, fetchImpl = globalThis.fetch } = {}) {
  if (!supabaseSecretKey) {
    const sessions = new Map();
    function prune() {
      for (const [id, session] of sessions) {
        if (session.expiresAt <= Date.now()) sessions.delete(id);
      }
    }
    return {
      async get(id) {
        const value = sessions.get(id);
        if (value && value.expiresAt > Date.now()) return { ...value };
        sessions.delete(id);
        return null;
      },
      async create(id, value, expiresAt) {
        prune();
        if (sessions.has(id)) throw new StoreError(409, 'La sesión ya existe.');
        sessions.set(id, { value, expiresAt });
      },
      async save(id, value, expiresAt) {
        const current = sessions.get(id);
        if (!current || current.expiresAt <= Date.now()) return false;
        sessions.set(id, { value, expiresAt });
        return true;
      },
      async delete(id) {
        sessions.delete(id);
      }
    };
  }

  const request = createRequest({ supabaseUrl, supabaseKey: supabaseSecretKey, fetchImpl });
  // Legacy service-role keys are valid JWTs. New secret keys only belong in apikey.
  const token = supabaseSecretKey.startsWith('sb_secret_') ? undefined : supabaseSecretKey;
  const digest = id => createHash('sha256').update(id).digest('hex');
  const current = id => ({ id_hash: `eq.${digest(id)}`, expires_at: `gt.${new Date().toISOString()}` });
  const sessionData = (value, expiresAt) => ({ encrypted_value: value, expires_at: new Date(expiresAt).toISOString() });

  return {
    async get(id) {
      const [row] = await request(sessionTable, {
        token, query: { ...current(id), select: 'encrypted_value,expires_at' }
      });
      if (!row) return null;
      return { value: row.encrypted_value, expiresAt: Date.parse(row.expires_at) };
    },
    async create(id, value, expiresAt) {
      await request(sessionTable, {
        method: 'POST', token, prefer: 'return=minimal', body: { id_hash: digest(id), ...sessionData(value, expiresAt) }
      });
      await request(sessionTable, {
        method: 'DELETE', token, prefer: 'return=minimal', query: { expires_at: `lte.${new Date().toISOString()}` }
      }).catch(() => {});
    },
    async save(id, value, expiresAt) {
      const [row] = await request(sessionTable, {
        method: 'PATCH', token, prefer: 'return=representation', query: { ...current(id), select: 'id_hash' },
        body: sessionData(value, expiresAt)
      });
      return Boolean(row);
    },
    async delete(id) {
      await request(sessionTable, {
        method: 'DELETE', token, prefer: 'return=minimal', query: { id_hash: `eq.${digest(id)}` }
      });
    }
  };
}

function createSteamTokenStore({ supabaseUrl, supabaseSecretKey, encryptionKey, fetchImpl = globalThis.fetch } = {}) {
  const memory = new Map();
  if (!supabaseSecretKey) {
    return {
      async save(steamId, userId, token) { memory.set(steamId, { userId, token }); },
      async delete(steamId) { memory.delete(steamId); },
      async all() { return [...memory].map(([steamId, value]) => ({ steamId, ...value, appid: null })); },
      async syncWithKey() {}
    };
  }

  const request = createRequest({ supabaseUrl, supabaseKey: supabaseSecretKey, fetchImpl });
  const token = supabaseSecretKey.startsWith('sb_secret_') ? undefined : supabaseSecretKey;
  const cipher = createTokenCipher(encryptionKey);

  return {
    async save(steamId, userId, refreshToken) {
      await request(steamTokenTable, {
        method: 'POST', token, prefer: 'resolution=merge-duplicates,return=minimal',
        body: { steam_id: steamId, user_id: userId, encrypted_token: cipher.encrypt(refreshToken, steamId) }
      });
    },
    async delete(steamId) {
      await request(steamTokenTable, {
        method: 'DELETE', token, prefer: 'return=minimal', query: { steam_id: `eq.${steamId}` }
      });
    },
    async all() {
      const [rows, active] = await Promise.all([
        request(steamTokenTable, { token, query: { select: 'steam_id,user_id,encrypted_token' } }),
        request(accountTable, { token, query: { select: 'steam_id,playing_appid', playing_appid: 'not.is.null' } })
      ]);
      const activeById = new Map(active.map(row => [row.steam_id, row.playing_appid]));
      return rows.map(row => ({
        steamId: row.steam_id,
        userId: row.user_id,
        token: cipher.decrypt(row.encrypted_token, row.steam_id),
        appid: activeById.get(row.steam_id) ?? null
      }));
    },
    async syncWithKey(steamId, snapshot) {
      await request(accountTable, {
        method: 'PATCH', token, prefer: 'return=minimal',
        query: { steam_id: `eq.${steamId}` }, body: snapshotRow(snapshot)
      });
    }
  };
}

module.exports = { createStore, createSessionStore, createSteamTokenStore, defaultConfig };
'@
Write-File 'server/store.js' $content

$content = @'
'use strict';

const express = require('express');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { createHmac, timingSafeEqual } = require('node:crypto');
const { isIP } = require('node:net');
const { resolve } = require('node:path');
const { createAuth, createFlows, randomId, validId } = require('./auth');
const { createStore, createSessionStore, createSteamTokenStore } = require('./store');
const { createSteamEngine } = require('./steam');
const { createSteamSessions } = require('./steam/clients');
const { privacyPage } = require('./privacy');

const assets = ['style.css', 'library.js', 'images.js', 'ui.js', 'icon.svg', 'icon.png'];
const src = resolve(__dirname, '../src');
const steamId = value => typeof value === 'string' && /^[1-9]\d{16}$/.test(value);
const emailValid = value => typeof value === 'string' && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const passwordValid = value => typeof value === 'string' && value.length >= 1 && value.length <= 1024;
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (object, key) => Object.hasOwn(object, key);
const idListValid = value => Array.isArray(value) && value.length <= 5000 &&
  value.every(id => Number.isInteger(id) && id >= 1 && id <= 0xffffffff);

function settingsPatch(body) {
  if (!plainObject(body) || !Object.keys(body).length) return null;
  const patch = {};
  for (const [key, value] of Object.entries(body)) {
    if (['title', 'description', 'reply'].includes(key) && typeof value === 'string' && value.length <= (key === 'title' ? 64 : 500)) {
      patch[key] = value;
    } else if (['selected', 'favorites'].includes(key) && idListValid(value)) {
      patch[key] = [...new Set(value)];
    } else if (key === 'autoSend' && typeof value === 'boolean') {
      patch[key] = value;
    } else if (key === 'profiles' && Array.isArray(value) && value.length <= 30 &&
        value.every(profile => plainObject(profile) && Object.keys(profile).length === 2 &&
          typeof profile.name === 'string' && profile.name.trim() && profile.name.length <= 60 && idListValid(profile.ids))) {
      patch[key] = value.map(profile => ({ name: profile.name.trim(), ids: [...new Set(profile.ids)] }));
    } else {
      return null;
    }
  }
  return patch;
}

function problem(res, status, error) {
  return res.status(status).json({ error });
}

function cookieToken(req, name) {
  const values = (req.get('cookie') || '').split(';').map(value => value.trim())
    .filter(value => value.startsWith(`${name}=`));
  const token = values.length === 1 ? values[0].slice(name.length + 1) : null;
  return validId(token) ? token : null;
}

function equal(a, b) {
  if (!validId(a) || !validId(b)) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function limit(windowMs, max, railway) {
  return rateLimit({
    windowMs, limit: max, standardHeaders: 'draft-8', legacyHeaders: false,
    validate: { xForwardedForHeader: false },
    keyGenerator: req => {
      const clientIp = railway ? req.get('x-real-ip') : '';
      return ipKeyGenerator(isIP(clientIp || '') ? clientIp : req.ip);
    },
    handler: (_req, res) => problem(res, 429, 'Demasiadas solicitudes. Esperá unos minutos y volvé a intentar.')
  });
}

function createApp(config, options = {}) {
  const store = options.store ?? createStore(config);
  const sessions = options.sessions ?? createSessionStore(config);
  const auth = createAuth(config, sessions, options.provider);
  const steam = options.steam ?? createSteamEngine({
    appOrigin: config.appOrigin, apiKey: config.steamApiKey, mock: config.mock
  });
  const tokens = options.steamTokens ?? createSteamTokenStore({
    supabaseUrl: config.supabaseUrl, supabaseSecretKey: config.supabaseSecretKey, encryptionKey: config.encryptionKey
  });
  const clients = options.steamSessions ?? createSteamSessions({
    tokens,
    onState: () => publish({}),
    onError: ({ steamId: id, message }) => console.warn(`Steam ${id}: ${message}`)
  });
  const flows = createFlows();
  const syncing = new Map();
  const streams = new Map();
  const app = express();
  app.disable('x-powered-by');
  if (config.production) app.set('trust proxy', 1);

  const prefix = config.secure ? '__Host-' : '';
  const names = { session: prefix + 'aura_session', csrf: prefix + 'aura_csrf', flow: prefix + 'aura_flow' };
  const cookieOptions = { secure: config.secure, httpOnly: true, sameSite: 'lax', path: '/' };
  const authLimit = limit(15 * 60_000, 20, config.railway);
  const syncLimit = limit(60_000, 20, config.railway);
  const csrfFor = (nonce, id) => createHmac('sha256', Buffer.from(config.encryptionKey, 'base64'))
    .update(`auraboost-csrf:${nonce}:${id || ''}`).digest('base64url');

  const sessionId = req => cookieToken(req, names.session);
  const query = req => new URL(req.originalUrl, config.appOrigin).searchParams;
  const replyOk = res => res.json({ ok: true });

  function closeStreams(id) {
    const clientsById = streams.get(id);
    streams.delete(id);
    for (const client of clientsById || []) client.res.end();
  }

  function publish(event) {
    const data = `event: state\ndata: ${JSON.stringify(event)}\n\n`;
    for (const clientsById of streams.values()) {
      for (const client of clientsById) {
        if (client.expiresAt <= Date.now() || !client.res.write(data)) client.res.end();
      }
    }
  }

  function clearSession(res) {
    res.clearCookie(names.session, cookieOptions);
    res.clearCookie(names.csrf, cookieOptions);
    res.clearCookie(names.flow, cookieOptions);
  }

  async function replaceSession(req, res, providerSession, recovery = false) {
    const created = await auth.create(providerSession, recovery);
    if (!created) return false;
    const previous = sessionId(req);
    if (previous) {
      closeStreams(previous);
      try {
        await auth.revoke(previous);
      } catch (error) {
        await auth.revoke(created.id).catch(() => {});
        throw error;
      }
    }
    clearSession(res);
    res.cookie(names.session, created.id, { ...cookieOptions, maxAge: created.maxAge });
    return true;
  }

  function newAuthFlow(req, res, kind) {
    flows.discard(cookieToken(req, names.flow));
    const flow = flows.start(kind, cookieToken(req, names.csrf), kind === 'recovery' ? 20 * 60_000 : undefined);
    res.cookie(names.flow, flow.id, { ...cookieOptions, maxAge: flow.expiresAt - Date.now() });
    return flow;
  }

  function mutating(req, res, next) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const nonce = cookieToken(req, names.csrf);
    const header = req.get('x-csrf-token');
    if (req.get('origin') !== config.appOrigin || !nonce || !equal(header, csrfFor(nonce, sessionId(req)))) {
      return problem(res, 403, 'La verificación de origen falló. Recargá la página.');
    }
    if (!req.is('application/json')) return problem(res, 415, 'Enviá los datos como JSON.');
    next();
  }

  async function snapshot(id) {
    const result = await steam.getAccount(id);
    return { ...result.profile, games: result.games, libraryStatus: result.libraryStatus, syncedAt: new Date().toISOString() };
  }

  async function syncQuiet(accountId) {
    if (config.mock) return;
    try {
      await tokens.syncWithKey(accountId, await snapshot(accountId));
      publish({ accountId });
    } catch {
      // el próximo refresco lo reintenta
    }
  }

  const playingTimer = setInterval(() => {
    for (const { steamId: id } of clients.playingEntries()) void syncQuiet(id);
  }, 5 * 60_000);
  playingTimer.unref?.();

  app.use((_req, res, next) => {
    const imageSources = config.mock ? '' : ' https://*.steamstatic.com https://media.steampowered.com https://steamcdn-a.akamaihd.net';
    res.set({
      'Content-Security-Policy': `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'${imageSources}; connect-src 'self'; base-uri 'none'; object-src 'none'; form-action 'self'; frame-ancestors 'none'`,
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
    });
    if (config.secure) res.set('Strict-Transport-Security', 'max-age=31536000');
    next();
  });

  app.get('/health', (_req, res) => res.set('Cache-Control', 'no-store').json({ status: 'ok' }));
  const expectedHost = new URL(config.appOrigin).host;
  app.use((req, res, next) => {
    const host = (config.railway && req.get('x-forwarded-host')) || req.get('host');
    if (host !== expectedHost) return problem(res, 400, 'Dominio inválido.');
    if (config.production && !req.secure) {
      if (['GET', 'HEAD'].includes(req.method)) return res.redirect(308, config.appOrigin);
      return problem(res, 403, 'La conexión requiere HTTPS.');
    }
    next();
  });

  app.get('/', (_req, res) => res.sendFile(resolve(src, 'index.html'), { cacheControl: false, headers: { 'Cache-Control': 'no-store' } }));
  app.get('/privacidad', (_req, res) => res.set('Cache-Control', 'no-store').type('html').send(privacyPage(config)));
  for (const asset of assets) app.get(`/${asset}`, (_req, res) => res.sendFile(resolve(src, asset)));

  app.use('/api', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  }, limit(60_000, 180, config.railway), mutating);

  app.get('/api/session', async (req, res) => {
    let nonce = cookieToken(req, names.csrf);
    if (!nonce) {
      nonce = randomId();
      res.cookie(names.csrf, nonce, cookieOptions);
    }
    const id = sessionId(req);
    const user = await auth.authenticate(id);
    res.json({ authenticated: Boolean(user), recovery: Boolean(user?.recovery), csrf: csrfFor(nonce, id), mock: config.mock });
  });

  app.use('/api/auth', authLimit, express.json({ limit: '8kb' }));

  app.post('/api/auth/login', async (req, res) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
    if (!emailValid(email) || !passwordValid(req.body?.password)) return problem(res, 400, 'Ingresá un correo y una contraseña válidos.');
    if (!await replaceSession(req, res, await auth.provider.login(email, req.body.password))) {
      return problem(res, 401, 'Credenciales inválidas o cuenta sin acceso.');
    }
    replyOk(res);
  });

  app.post('/api/auth/google', async (req, res) => {
    const flow = newAuthFlow(req, res, 'google');
    const url = await auth.provider.google(flow, `${config.appOrigin}/api/auth/callback`);
    res.json({ url });
  });

  app.post('/api/auth/recovery', async (req, res) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
    if (!emailValid(email)) return problem(res, 400, 'Ingresá un correo válido.');
    const flow = newAuthFlow(req, res, 'recovery');
    const url = await auth.provider.recovery(email, flow, `${config.appOrigin}/api/auth/recovery/callback`);
    res.json({ ok: true, ...(config.mock && url ? { url } : {}) });
  });

  for (const [path, kind] of [['/api/auth/callback', 'google'], ['/api/auth/recovery/callback', 'recovery']]) {
    app.get(path, async (req, res) => {
      if (req.method !== 'GET') return res.sendStatus(405);
      const code = query(req).getAll('code');
      const flow = flows.take(cookieToken(req, names.flow), kind, cookieToken(req, names.csrf));
      res.clearCookie(names.flow, cookieOptions);
      if (!flow || code.length !== 1 || !/^[\w-]{10,256}$/.test(code[0])) return res.redirect(303, '/?auth=error');
      try {
        const session = await auth.provider.exchange(flow, code[0]);
        if (!await replaceSession(req, res, session, kind === 'recovery')) return res.redirect(303, '/?auth=error');
        res.redirect(303, kind === 'recovery' ? '/?auth=recuperar' : '/');
      } catch {
        res.redirect(303, '/?auth=error');
      }
    });
  }

  app.post('/api/auth/password', async (req, res) => {
    const password = req.body?.password;
    const id = sessionId(req);
    if (!(await auth.authenticate(id))?.recovery) return problem(res, 403, 'Abrí un enlace de recuperación válido.');
    if (!passwordValid(password) || password.length < 8) return problem(res, 400, 'Usá al menos 8 caracteres.');
    if (!await auth.changePassword(id, password)) return problem(res, 400, 'No se cambió la contraseña. Revisá los requisitos de Supabase.');
    closeStreams(id);
    clearSession(res);
    replyOk(res);
  });

  app.post('/api/auth/logout', async (req, res) => {
    const id = sessionId(req);
    closeStreams(id);
    await auth.revoke(id);
    closeStreams(id);
    flows.discard(cookieToken(req, names.flow));
    clearSession(res);
    replyOk(res);
  });

  app.get('/api/steam/callback', async (req, res) => {
    if (req.method !== 'GET') return res.sendStatus(405);
    const parameters = query(req);
    const state = parameters.get('state');
    const id = sessionId(req);
    const actor = await auth.authenticate(id);
    const flow = actor && !actor.recovery && flows.take(state, 'steam', id);
    if (!flow) return res.redirect(303, '/?steam=error');
    try {
      const accountId = await steam.verifyLink(parameters, state);
      if (!await store.getAccount(actor, accountId)) {
        const data = await snapshot(accountId);
        if (!(await auth.authenticate(id)) || (await store.listAccounts(actor)).length >= 50) {
          return res.redirect(303, '/?steam=error');
        }
        try {
          await store.addAccount(actor, data);
          publish({ accountId, linked: true });
        } catch (error) {
          if (error.status !== 409) throw error;
        }
      }
      res.redirect(303, '/?steam=vinculada');
    } catch {
      res.redirect(303, '/?steam=error');
    }
  });

  app.use('/api', async (req, res, next) => {
    const actor = await auth.authenticate(sessionId(req));
    if (!actor || actor.recovery) return problem(res, 401, 'Iniciá sesión para acceder a AuraBoost.');
    req.actor = actor;
    next();
  }, express.json({ limit: '2mb' }));

  app.get('/api/state', async (req, res) => {
    const [accounts, settings] = await Promise.all([store.listAccounts(req.actor), store.getSettings(req.actor)]);
    res.json({
      accounts: accounts.map(account => ({ ...account, sessionConnected: clients.isConnected(account.id) })),
      settings, mock: config.mock, steamConfigured: Boolean(config.steamApiKey || config.mock)
    });
  });

  app.patch('/api/settings', async (req, res) => {
    const { body, actor } = req;
    if (!plainObject(body) || Object.keys(body).length !== 1 || !own(body, 'selectedAccountId') ||
        (body.selectedAccountId !== null && !steamId(body.selectedAccountId))) {
      return problem(res, 400, 'Seleccioná una cuenta válida.');
    }
    if (body.selectedAccountId && !await store.getAccount(actor, body.selectedAccountId)) {
      return problem(res, 404, 'No se encontró esa cuenta de Steam.');
    }
    await store.updateUserSettings(actor, body);
    publish({});
    replyOk(res);
  });

  app.param('id', (req, res, next, id) => {
    if (!steamId(id)) return problem(res, 400, 'Identificador de Steam inválido.');
    next();
  });

  app.get('/api/accounts/:id', async (req, res) => {
    const data = await store.getAccount(req.actor, req.params.id);
    if (!data) return problem(res, 404, 'No se encontró esa cuenta de Steam.');
    const { config, games, ...account } = data;
    res.json({
      account: { ...account, sessionConnected: clients.isConnected(req.params.id) },
      config, games, history: await store.listHistory(req.actor, req.params.id)
    });
  });

  app.patch('/api/accounts/:id/settings', async (req, res) => {
    const patch = settingsPatch(req.body);
    if (!patch) return problem(res, 400, 'Los ajustes contienen valores inválidos.');
    const accountId = req.params.id;
    if (!await store.updateSettings(req.actor, accountId, patch)) return problem(res, 404, 'No se encontró esa cuenta de Steam.');
    if (patch.autoSend === true) {
      await store.addHistory(req.actor, { id: accountId, text: 'Envío automático activado.' }).catch(() => {});
    }
    publish({ accountId });
    replyOk(res);
  });

  app.delete('/api/accounts/:id', async (req, res) => {
    const accountId = req.params.id;
    if (!await store.removeAccount(req.actor, accountId)) return problem(res, 404, 'No se encontró esa cuenta de Steam.');
    clients.disconnect(accountId);
    await tokens.delete(accountId).catch(() => {});
    publish({ accountId, deleted: true });
    replyOk(res);
  });

  app.post('/api/steam/link', syncLimit, async (req, res) => {
    if ((await store.listAccounts(req.actor)).length >= 50) return problem(res, 409, 'Alcanzaste el máximo de cuentas vinculadas.');
    const flow = flows.start('steam', sessionId(req));
    res.json({ url: steam.beginLink(flow.id) });
  });

  app.post('/api/accounts/:id/sync', syncLimit, async (req, res) => {
    const accountId = req.params.id;
    if (!syncing.has(accountId)) {
      const operation = (async () => {
        const actor = req.actor;
        if (!await store.getAccount(actor, accountId)) return false;
        const next = await snapshot(accountId);
        if (!await store.saveSnapshot(actor, accountId, next)) return false;
        publish({ accountId });
        return true;
      })();
      syncing.set(accountId, operation);
      const cleanup = () => syncing.delete(accountId);
      operation.then(cleanup, cleanup);
    }
    if (!await syncing.get(accountId)) return problem(res, 404, 'No se encontró esa cuenta de Steam.');
    replyOk(res);
  });

  app.post('/api/accounts/:id/session', syncLimit, async (req, res) => {
    if (config.mock) return problem(res, 409, 'En modo demostración no se conectan sesiones reales.');
    const accountId = req.params.id;
    if (!await store.getAccount(req.actor, accountId)) return problem(res, 404, 'No se encontró esa cuenta de Steam.');
    const accountName = typeof req.body?.accountName === 'string' ? req.body.accountName.trim() : '';
    const password = req.body?.password;
    if (!/^[\w.-]{3,64}$/.test(accountName)) return problem(res, 400, 'Ingresá un usuario de Steam válido.');
    if (typeof password !== 'string' || !password || password.length > 128) return problem(res, 400, 'Ingresá la contraseña de Steam.');
    let result;
    try {
      result = await clients.login(accountId, req.actor.id, accountName, password);
    } catch (error) {
      return problem(res, error.status ?? 400, error.message);
    }
    if (result.status === 'connected' && clients.steamIdOf(accountId) !== accountId) {
      clients.disconnect(accountId);
      return problem(res, 400, 'Esa cuenta de Steam no coincide con la vinculada.');
    }
    if (result.status === 'connected') await store.setSessionLinked(req.actor, accountId, true);
    publish({ accountId });
    res.json(result);
  });

  app.post('/api/accounts/:id/session/guard', syncLimit, async (req, res) => {
    const accountId = req.params.id;
    const loginId = typeof req.body?.loginId === 'string' ? req.body.loginId : '';
    const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
    if (!/^[A-Za-z0-9]{5,10}$/.test(code)) return problem(res, 400, 'Ingresá el código de Steam Guard.');
    try {
      const result = await clients.guard(accountId, loginId, code);
      if (result.status === 'connected') await store.setSessionLinked(req.actor, accountId, true);
      publish({ accountId });
      res.json(result);
    } catch (error) {
      return problem(res, error.status ?? 400, error.message);
    }
  });

  app.delete('/api/accounts/:id/session', async (req, res) => {
    const accountId = req.params.id;
    clients.disconnect(accountId);
    await tokens.delete(accountId).catch(() => {});
    await store.setSessionLinked(req.actor, accountId, false);
    publish({ accountId });
    replyOk(res);
  });

  app.post('/api/accounts/:id/launch', syncLimit, async (req, res) => {
    const accountId = req.params.id;
    const appid = Number(req.body?.appid);
    if (!Number.isInteger(appid) || appid < 1 || appid > 0xffffffff) return problem(res, 400, 'AppID inválido.');
    const account = await store.getAccount(req.actor, accountId);
    if (!account) return problem(res, 404, 'No se encontró esa cuenta de Steam.');
    const game = account.games.find(item => item.id === appid);
    if (!game) return problem(res, 400, 'Ese juego no está en la biblioteca de la cuenta.');
    try {
      clients.launch(accountId, appid);
    } catch (error) {
      return problem(res, error.status ?? 409, error.message);
    }
    await store.setPlaying(req.actor, accountId, appid);
    await store.addHistory(req.actor, { id: accountId, text: `Inició ${game.name}.` }).catch(() => {});
    publish({ accountId });
    replyOk(res);
  });

  app.post('/api/accounts/:id/stop', syncLimit, async (req, res) => {
    const accountId = req.params.id;
    const account = await store.getAccount(req.actor, accountId);
    if (!account) return problem(res, 404, 'No se encontró esa cuenta de Steam.');
    clients.stop(accountId);
    await store.setPlaying(req.actor, accountId, null);
    await store.addHistory(req.actor, { id: accountId, text: 'Detuvo el juego.' }).catch(() => {});
    publish({ accountId });
    replyOk(res);
    setTimeout(() => { void syncQuiet(accountId); }, 3000);
  });

  app.get('/api/events', (req, res) => {
    if (req.method !== 'GET') return res.sendStatus(405);
    const origin = req.get('origin');
    if ((origin && origin !== config.appOrigin) || req.get('sec-fetch-site') === 'cross-site') {
      return problem(res, 403, 'Origen inválido.');
    }
    const id = sessionId(req);
    const clientsById = streams.get(id) || new Set();
    if (clientsById.size >= 5 || streams.size >= 100) return problem(res, 429, 'Demasiadas conexiones en tiempo real.');
    res.set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, no-transform',
      'X-Accel-Buffering': 'no'
    });
    res.flushHeaders();
    res.write('retry: 3000\n: conectada\n\n');
    const client = { res, expiresAt: Math.min(req.actor.expiresAt, req.actor.accessExpiresAt) };
    clientsById.add(client);
    streams.set(id, clientsById);
    let checking = false;
    const timer = setInterval(async () => {
      if (checking) return;
      checking = true;
      try {
        const actor = await auth.authenticate(id);
        if (!actor || actor.recovery) return res.end();
        client.expiresAt = Math.min(actor.expiresAt, actor.accessExpiresAt);
        if (!res.destroyed && !res.write(': latido\n\n')) res.end();
      } catch {
        res.end();
      } finally {
        checking = false;
      }
    }, 20_000);
    res.on('close', () => {
      clearInterval(timer);
      clientsById.delete(client);
      if (!clientsById.size && streams.get(id) === clientsById) streams.delete(id);
    });
  });

  app.use((_req, res) => problem(res, 404, 'No se encontró la ruta.'));
  app.use((error, _req, res, next) => {
    if (res.headersSent) return next(error);
    if (error.type === 'entity.parse.failed') return problem(res, 400, 'El JSON enviado es inválido.');
    if (error.status === 413) return problem(res, 413, 'La solicitud es demasiado grande.');
    if ([400, 401, 403, 404, 409, 503].includes(error.status)) {
      return problem(res, error.status, error.status === 400 ? 'La solicitud es inválida.' : error.message);
    }
    console.error('AuraBoost no pudo completar una solicitud.');
    return problem(res, 503, 'El servicio no pudo completar la solicitud. Volvé a intentar.');
  });

  return {
    app,
    clients,
    restoreSessions: () => (config.mock ? Promise.resolve() : clients.restore()),
    closeEvents: () => {
      clearInterval(playingTimer);
      clients.close();
      for (const id of streams.keys()) closeStreams(id);
    }
  };
}

module.exports = { createApp };
'@
Write-File 'server/app.js' $content

$content = @'
'use strict';

const { loadConfig } = require('./config');
const { createApp } = require('./app');

try {
  const config = loadConfig();
  const { app, closeEvents, restoreSessions } = createApp(config);
  const server = app.listen(config.port, config.host, () => {
    console.log(`AuraBoost Private Cloud v0.2.0 · ${config.appOrigin}${config.mock ? ' · demostración local' : ''}`);
    void restoreSessions();
  });
  server.on('error', () => {
    console.error('No se pudo iniciar el servidor. Revisá que el puerto esté disponible.');
    process.exitCode = 1;
  });
  const shutdown = () => {
    closeEvents();
    server.close();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
'@
Write-File 'server/index.js' $content

Write-Host 'Servidor listo. Falta src/.'