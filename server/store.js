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
  return { title: '', description: '', reply: '', selected: [], favorites: [], profiles: [], autoSend: false, persona: 'online' };
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
        request(accountTable, { token, query: { select: 'steam_id,playing_appid,session_linked,config' } })
      ]);
      const activeById = new Map(active.filter(row => row.session_linked).map(row => [row.steam_id, row]));
      const restored = [];
      for (const row of rows) {
        const account = activeById.get(row.steam_id);
        if (!account) continue;
        try { restored.push({ steamId: row.steam_id, userId: row.user_id, token: cipher.decrypt(row.encrypted_token, row.steam_id), appid: account.playing_appid ?? null, config: account.config }); }
        catch { console.warn('No se pudo descifrar un token de Steam; la cuenta necesita reconexión.'); }
      }
      return restored;
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