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
    } else if (key === 'persona' && ['online','away','busy','snooze','offline'].includes(value)) {
      patch[key] = value;
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
      accounts: accounts.map(account => ({ ...account, sessionConnected: clients.isConnected(account.id), activitySince: clients.activitySince?.(account.id) ?? null, activitySeconds: clients.activitySeconds?.(account.id) ?? 0, connectionStatus: clients.connectionStatus?.(account.id) ?? 'disconnected' })),
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
      account: { ...account, sessionConnected: clients.isConnected(req.params.id), activitySince: clients.activitySince?.(req.params.id) ?? null, activitySeconds: clients.activitySeconds?.(req.params.id) ?? 0, connectionStatus: clients.connectionStatus?.(req.params.id) ?? 'disconnected' },
      config, games, history: await store.listHistory(req.actor, req.params.id)
    });
  });

  app.patch('/api/accounts/:id/settings', async (req, res) => {
    const patch = settingsPatch(req.body);
    if (!patch) return problem(res, 400, 'Los ajustes contienen valores inválidos.');
    const accountId = req.params.id;
    const updated = await store.updateSettings(req.actor, accountId, patch);
    if (!updated) return problem(res, 404, 'No se encontró esa cuenta de Steam.');
    clients.configure?.(accountId, updated.config ?? patch);
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
    await clients.flushTokens?.(accountId);
    await tokens.delete(accountId);
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
    const actor = req.actor;
    const account = await store.getAccount(actor, accountId);
    if (!account) return problem(res, 404, 'No se encontró esa cuenta de Steam.');
    const accountName = typeof req.body?.accountName === 'string' ? req.body.accountName.trim() : '';
    const password = req.body?.password;
    if (!/^[\w.-]{3,64}$/.test(accountName)) return problem(res, 400, 'Ingresá un usuario de Steam válido.');
    if (typeof password !== 'string' || !password || password.length > 128) return problem(res, 400, 'Ingresá la contraseña de Steam.');
    try {
      const result = await clients.login(accountId, actor.id, accountName, password, async () => {
        if (clients.steamIdOf(accountId) !== accountId) throw new Error('Identidad incorrecta.');
        if (!await store.setSessionLinked(actor, accountId, true)) throw new Error('No se pudo guardar la sesión.');
        clients.configure?.(accountId, (await store.getAccount(actor, accountId))?.config);
        publish({accountId});
      });
      publish({accountId});
      res.json(result);
    } catch (error) { return problem(res, error.status ?? 400, error.message); }
  });
  app.get('/api/accounts/:id/session/status', async (req, res) => {
    const accountId = req.params.id;
    if (!await store.getAccount(req.actor, accountId)) return problem(res,404,'No se encontró esa cuenta de Steam.');
    const loginId = query(req).get('loginId') ?? '';
    res.json(clients.loginStatus(accountId, loginId));
  });
  app.post('/api/accounts/:id/session/guard', syncLimit, async (req, res) => {
    const accountId = req.params.id;
    if (!await store.getAccount(req.actor, accountId)) return problem(res,404,'No se encontró esa cuenta de Steam.');
    const loginId = typeof req.body?.loginId === 'string' ? req.body.loginId : '';
    const code = typeof req.body?.code === 'string' ? req.body.code.trim().toUpperCase() : '';
    if (!/^[A-Z0-9]{5,10}$/.test(code)) return problem(res,400,'Ingresá el código de Steam Guard.');
    try { res.json(await clients.guard(accountId,loginId,code)); }
    catch (error) { return problem(res,error.status ?? 400,error.message); }
  });
  app.post('/api/accounts/:id/session/cancel', async (req,res) => {
    const accountId = req.params.id;
    if (!await store.getAccount(req.actor,accountId)) return problem(res,404,'No se encontró esa cuenta de Steam.');
    const state = clients.loginStatus(accountId,req.body?.loginId);
    if (state.status === 'connecting') return problem(res,409,'Steam está terminando de conectar. Esperá el resultado.');
    if (state.status === 'waiting') clients.cancelAuth(accountId);
    publish({accountId}); replyOk(res);
  });

  app.delete('/api/accounts/:id/session', async (req, res) => {
    const accountId = req.params.id;
    if (!await store.getAccount(req.actor, accountId)) return problem(res, 404, 'No se encontró esa cuenta de Steam.');
    clients.disconnect(accountId);
    await clients.flushTokens?.(accountId);
    await tokens.delete(accountId);
    await store.setPlaying(req.actor, accountId, null);
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
    const activitySeconds = clients.stop(accountId) ?? 0;
    await store.setPlaying(req.actor, accountId, null);
    await store.addHistory(req.actor, { id: accountId, text: 'Detuvo el juego. Tiempo de actividad registrado: ' + Math.floor(activitySeconds / 60) + ' min ' + activitySeconds % 60 + ' s.' }).catch(() => {});
    publish({ accountId });
    res.json({ ok: true, activitySeconds });
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