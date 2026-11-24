'use strict';

const { randomBytes } = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');
const { createTokenCipher } = require('./crypto');
const { MOCK_EMAIL, MOCK_PASSWORD } = require('./config');

const DAY = 24 * 60 * 60 * 1000;
const SESSION_TTL = 7 * DAY;
const RECOVERY_TTL = 15 * 60 * 1000;
const randomId = () => randomBytes(32).toString('base64url');
const validId = value => typeof value === 'string' && /^[\w-]{43}$/.test(value);

function createFlows() {
  const pending = new Map();
  return {
    start(kind, binding, ttl = 10 * 60 * 1000) {
      const now = Date.now();
      for (const [id, flow] of pending) if (flow.expiresAt <= now) pending.delete(id);
      if (pending.size >= 256) throw new Error('Demasiados intentos pendientes.');
      const id = randomId();
      const flow = { id, kind, binding, expiresAt: now + ttl, storage: new Map() };
      pending.set(id, flow);
      return flow;
    },
    discard(id) {
      pending.delete(id);
    },
    take(id, kind, binding) {
      const flow = pending.get(id);
      if (!flow || flow.kind !== kind || flow.binding !== binding || flow.expiresAt <= Date.now()) return null;
      pending.delete(id);
      return flow;
    }
  };
}

function createProvider(config, fetchImpl = globalThis.fetch) {
  if (config.mock) {
    let password = MOCK_PASSWORD;
    const demoSession = () => ({
      user: { id: config.allowedUserId }, access_token: randomId(), refresh_token: randomId(),
      expires_at: Math.floor(Date.now() / 1000) + 3600
    });
    const callback = (flow, redirect) => {
      flow.code = randomId();
      return `${redirect}?code=${flow.code}`;
    };
    return {
      login: async (email, input) => email.toLowerCase() === MOCK_EMAIL && input === password ? demoSession() : null,
      google: async (flow, redirect) => callback(flow, redirect),
      recovery: async (email, flow, redirect) => email.toLowerCase() === MOCK_EMAIL ? callback(flow, redirect) : undefined,
      exchange: async (flow, code) => code === flow.code ? demoSession() : null,
      refresh: async () => demoSession(),
      updatePassword: async (_record, input) => { password = input; return true; },
      logout: async () => {}
    };
  }

  function client(flow) {
    const storage = flow && {
      getItem: key => flow.storage.get(key) ?? null,
      setItem: (key, value) => { flow.storage.set(key, value); },
      removeItem: key => { flow.storage.delete(key); }
    };
    return createClient(config.supabaseUrl, config.supabaseKey, {
      auth: {
        autoRefreshToken: false, detectSessionInUrl: false, persistSession: Boolean(storage),
        flowType: 'pkce', storage
      },
      global: {
        fetch: (input, options = {}) => {
          const signals = [AbortSignal.timeout(10_000)];
          if (options.signal) signals.push(options.signal);
          return fetchImpl(input, { ...options, signal: AbortSignal.any(signals) });
        }
      }
    }).auth;
  }

  function unpack({ data, error }) {
    if (error && (!Number.isInteger(error.status) || error.status >= 500 || error.status === 429)) {
      throw new Error('Supabase Auth no está disponible.');
    }
    return error ? null : data;
  }

  return {
    async login(email, password) {
      return unpack(await client().signInWithPassword({ email, password }))?.session;
    },
    async google(flow, redirectTo) {
      const response = await client(flow).signInWithOAuth({
        provider: 'google', options: { redirectTo, skipBrowserRedirect: true }
      });
      const url = new URL(unpack(response)?.url || config.supabaseUrl);
      if (url.origin !== config.supabaseUrl || url.pathname !== '/auth/v1/authorize') {
        throw new Error('No se pudo iniciar el acceso con Google.');
      }
      return url.href;
    },
    async recovery(email, flow, redirectTo) {
      // Do not expose whether a supplied address is registered or mail was sent.
      await client(flow).resetPasswordForEmail(email, { redirectTo });
    },
    async exchange(flow, code) {
      return unpack(await client(flow).exchangeCodeForSession(code))?.session;
    },
    async refresh(refresh_token) {
      return unpack(await client().refreshSession({ refresh_token }))?.session;
    },
    async updatePassword(record, password) {
      const auth = client();
      const session = unpack(await auth.setSession({
        access_token: record.accessToken, refresh_token: record.refreshToken
      }));
      if (session?.user?.id !== config.allowedUserId) return false;
      return Boolean(unpack(await auth.updateUser({ password })));
    },
    async logout(record) {
      await client().admin.signOut(record.accessToken, 'local');
    }
  };
}

function createAuth(config, store, provider = createProvider(config)) {
  const cipher = createTokenCipher(config.encryptionKey);
  const locks = new Map();

  function lock(id, operation) {
    const promise = (locks.get(id) || Promise.resolve()).then(operation, operation);
    locks.set(id, promise);
    const cleanup = () => { if (locks.get(id) === promise) locks.delete(id); };
    promise.then(cleanup, cleanup);
    return promise;
  }

  function recordFrom(session, recovery) {
    if (session?.user?.id !== config.allowedUserId ||
        !session.access_token || !session.refresh_token || !Number.isFinite(session.expires_at)) return null;
    return {
      id: session.user.id, accessToken: session.access_token, refreshToken: session.refresh_token,
      accessExpiresAt: session.expires_at * 1000, recovery
    };
  }

  async function read(id) {
    const stored = await store.get(id);
    if (!stored || stored.expiresAt <= Date.now()) return null;
    let record;
    try {
      record = JSON.parse(cipher.decrypt(stored.value, id));
    } catch {
      return null;
    }
    return record.id === config.allowedUserId ? { ...record, expiresAt: stored.expiresAt } : null;
  }

  async function refresh(id) {
    const current = await read(id);
    if (!current) return null;
    if (current.accessExpiresAt > Date.now() + 45_000) return current;
    const record = recordFrom(await provider.refresh(current.refreshToken), current.recovery);
    if (!record) {
      await store.delete(id);
      return null;
    }
    if (!await store.save(id, cipher.encrypt(JSON.stringify(record), id), current.expiresAt)) return null;
    return { ...record, expiresAt: current.expiresAt };
  }

  async function revoke(id) {
    if (!validId(id)) return;
    await lock(id, async () => {
      const record = await read(id);
      await store.delete(id);
      if (record) await provider.logout(record).catch(() => {});
    });
  }

  return {
    provider,
    async create(session, recovery = false) {
      const record = recordFrom(session, recovery);
      if (!record) return null;
      const id = randomId();
      const maxAge = recovery ? RECOVERY_TTL : SESSION_TTL;
      await store.create(id, cipher.encrypt(JSON.stringify(record), id), Date.now() + maxAge);
      return { id, maxAge };
    },
    async authenticate(id) {
      if (!validId(id)) return null;
      const record = await read(id);
      if (!record || record.accessExpiresAt > Date.now() + 45_000) return record;
      return lock(id, () => refresh(id));
    },
    async changePassword(id, password) {
      if (!validId(id)) return false;
      return lock(id, async () => {
        const record = await refresh(id);
        if (!record?.recovery || !await provider.updatePassword(record, password)) return false;
        await store.delete(id);
        await provider.logout(record).catch(() => {});
        return true;
      });
    },
    revoke
  };
}

module.exports = { createAuth, createFlows, createProvider, randomId, validId };
