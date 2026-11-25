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
  const activity = new Map();
  const elapsed = new Map();
  const connectedIds = new Set();
  const connection = new Map();
  const retry = new Map();
  const attempts = new Map();
  const durable = new Map();
  const suspended = new Set();
  let closing = false;
  let restoring = false;
  let restoreTimer;
  function pauseActivity(id) {
    const since = activity.get(id);
    if (since) elapsed.set(id, (elapsed.get(id) ?? 0) + Math.max(0, Math.floor((Date.now() - Date.parse(since))/1000)));
    activity.delete(id);
  }
  function activitySeconds(id) { return elapsed.get(id) ?? 0; }
  function cancelRetry(id) { clearTimeout(retry.get(id)); retry.delete(id); }
  function scheduleRetry(id, client) {
    if (closing || suspended.has(id) || !durable.has(id) || clients.get(id) !== client || retry.has(id)) return;
    connection.set(id, 'reconnecting');
    const n = (attempts.get(id) ?? 0) + 1; attempts.set(id, n);
    const delay = Math.min(300000, 5000 * 2 ** Math.min(n-1, 6));
    const timer = setTimeout(() => {
      retry.delete(id);
      if (closing || suspended.has(id) || clients.get(id) !== client || connectedIds.has(id)) return;
      const row = durable.get(id); if (!row) return;
      clients.delete(id); try { client.logOff(); } catch {}
      try { create(id, row.userId).logOn({ refreshToken: row.token }); }
      catch { const next = clients.get(id); if (next) scheduleRetry(id, next); }
    }, delay); timer.unref?.(); retry.set(id, timer);
  }
  const configurations = new Map();
  const tokenWrites = new Map();
  const replies = new Map();
  const persona = { online: 1, busy: 2, away: 3, snooze: 4, offline: 0 };
  function configure(id, config) {
    if (!config) return;
    const next = { ...configurations.get(id), ...config };
    configurations.set(id, next);
    const client = clients.get(id);
    if (client?.steamID?.getSteamID64() === id) client.setPersona(persona[next.persona] ?? 1);
  }
  function flushTokens(id) { return tokenWrites.get(id) ?? Promise.resolve(); }
  function saveToken(id, client, token) {
    durable.set(id, {userId: client.auraUserId, token});
    const task = flushTokens(id).then(async () => {
      if (clients.get(id) !== client || client.steamID?.getSteamID64() !== id) return;
      await tokens.save(id, client.auraUserId, token);
    }).catch(() => onError?.({ steamId: id, message: 'No se pudo guardar el token de Steam.' }));
    tokenWrites.set(id, task);
    void task.finally(() => { if (tokenWrites.get(id) === task) tokenWrites.delete(id); });
  }
  const bus = new EventEmitter();
  const notify = () => onState?.();

  function wire(steamId, client) {
    client.on('loggedOn', () => {
      if (clients.get(steamId) !== client || client.steamID?.getSteamID64() !== steamId) return;
      connectedIds.add(steamId); connection.set(steamId, 'connected'); cancelRetry(steamId); attempts.delete(steamId);
      configure(steamId, configurations.get(steamId) ?? {});
      if (client.auraPendingToken) { saveToken(steamId, client, client.auraPendingToken); delete client.auraPendingToken; }
      const appid = playing.get(steamId);
      if (appid) { client.gamesPlayed([appid]); activity.set(steamId, new Date().toISOString()); }
      notify();
    });
    client.on('refreshToken', refreshToken => {
      if (clients.get(steamId) !== client) return;
      if (client.steamID?.getSteamID64() === steamId) saveToken(steamId, client, refreshToken);
      else client.auraPendingToken = refreshToken;
    });
    client.on('steamGuard', (domain, callback, lastCodeWrong) => {
      const loginId = randomId();
      pending.set(loginId, { steamId, callback, expiresAt: Date.now() + PENDING_TTL });
      bus.emit('guard', { steamId, loginId, domain: domain || null, lastCodeWrong: Boolean(lastCodeWrong) });
      notify();
    });
    client.on('disconnected', (eresult) => {
      if (clients.get(steamId) !== client) return;
      connectedIds.delete(steamId); pauseActivity(steamId);
      connection.set(steamId, durable.has(steamId) ? 'reconnecting' : 'needs-auth');
      if (durable.has(steamId)) scheduleRetry(steamId, client);
      onError?.({ steamId, message: 'Steam desconectado (resultado ' + String(eresult ?? 'desconocido') + ').' });
      notify();
    });
    client.on('playingState', blocked => {
      if (clients.get(steamId) !== client) return;
      if (blocked) {
        pauseActivity(steamId);
        suspended.add(steamId);
        connection.set(steamId, 'paused');
      } else if (suspended.delete(steamId)) {
        connection.set(steamId, 'connected');
        // Never force Steam to reclaim a session from the official client.
      }
      notify();
    });
    client.on('friendMessage', (sender, message) => {
      const cfg = configurations.get(steamId);
      if (clients.get(steamId) !== client || client.steamID?.getSteamID64() !== steamId || !cfg?.autoSend || !cfg.reply?.trim() || !message) return;
      const key = steamId + ':' + sender.getSteamID64();
      const now = Date.now();
      if (sender.getSteamID64() === steamId || now - (replies.get(key) ?? 0) < 3600000) return;
      if (replies.size >= 5000) { for (const [k, stamp] of replies) if (now - stamp >= 3600000) replies.delete(k); }
      if (replies.size >= 5000) return;
      replies.set(key, now);
      try { client.chat.sendFriendMessage(sender, cfg.reply.trim()).catch(() => onError?.({steamId, message:'No se pudo enviar la respuesta automática.'})); } catch { onError?.({steamId, message:'No se pudo enviar la respuesta automática.'}); }
    });
    client.on('error', error => {
      if (clients.get(steamId) !== client) return;
      connectedIds.delete(steamId); pauseActivity(steamId);
      const fatal = [5, 63, 65, 85, 86, 88].includes(error?.eresult);
      if (fatal) { suspended.add(steamId); cancelRetry(steamId); connection.set(steamId, 'needs-auth'); }
      else if (durable.has(steamId)) scheduleRetry(steamId, client);
      else connection.set(steamId, 'needs-auth');
      onError?.({ steamId, message: describe(error).message + ' (resultado ' + String(error?.eresult ?? 'desconocido') + ')' });
      notify();
    });
  }

  function create(steamId, userId) {
    const client = new SteamUser({ autoRelogin: false, renewRefreshTokens: true });
    connection.set(steamId, 'connecting');
    client.auraUserId = userId;
    clients.set(steamId, client);
    wire(steamId, client);
    return client;
  }

  function disconnect(steamId) {
    const client = clients.get(steamId);
    clients.delete(steamId);
    cancelRetry(steamId); attempts.delete(steamId); durable.delete(steamId); suspended.delete(steamId); connectedIds.delete(steamId); connection.delete(steamId); elapsed.delete(steamId);
    playing.delete(steamId);
    activity.delete(steamId);
    configurations.delete(steamId);
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
      const ok = () => {
        if (client.steamID?.getSteamID64() !== steamId) { disconnect(steamId); settle(reject, new Error('La cuenta no coincide con la vinculada.')); }
        else settle(resolve, { status: 'connected' });
      };
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
    pending.delete(loginId);
    if (!client) return Promise.reject(new Error('La conexión ya no existe.'));
    return new Promise((resolve, reject) => {
      let done = false;
      const settle = (fn, value) => { if (!done) { done = true; clean(); fn(value); } };
      const timer = setTimeout(() => settle(reject, new Error('Steam no respondió.')), 45_000);
      const ok = () => {
        pending.delete(loginId);
        if (client?.steamID?.getSteamID64() !== steamId) { disconnect(steamId); settle(reject, new Error('La cuenta no coincide con la vinculada.')); }
        else settle(resolve, { status: 'connected' });
      };
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
    if (client?.steamID?.getSteamID64() !== steamId) {
      throw Object.assign(new Error('Conectá la sesión de Steam de esta cuenta antes de iniciar un juego.'), { status: 409 });
    }
    if (!isConnected(steamId) || suspended.has(steamId)) throw Object.assign(new Error('La sesión está desconectada o en uso por otro cliente.'), {status:409});
    client.gamesPlayed([appid]);
    elapsed.set(steamId, 0);
    playing.set(steamId, appid);
    activity.set(steamId, new Date().toISOString());
  }

  function stop(steamId) {
    pauseActivity(steamId);
    const seconds = activitySeconds(steamId);
    playing.delete(steamId); elapsed.delete(steamId);
    if (isConnected(steamId) && !suspended.has(steamId)) clients.get(steamId)?.gamesPlayed([]);
    return seconds;
  }

  const isConnected = steamId => connectedIds.has(steamId) && clients.get(steamId)?.steamID?.getSteamID64() === steamId;
  const steamIdOf = steamId => clients.get(steamId)?.steamID?.getSteamID64() ?? null;
  const playingEntries = () => [...playing]
    .filter(([steamId]) => isConnected(steamId))
    .map(([steamId]) => ({ steamId, userId: clients.get(steamId).auraUserId }));

  async function restore() {
    if (closing || restoring) return;
    restoring = true;
    try {
      const rows = await tokens.all();
      for (const row of rows) {
        if (closing) break;
        if (clients.has(row.steamId) || suspended.has(row.steamId)) continue;
        durable.set(row.steamId, {userId: row.userId, token: row.token});
        if (row.config) configurations.set(row.steamId, row.config);
        if (row.appid) playing.set(row.steamId, row.appid);
        try { create(row.steamId, row.userId).logOn({ refreshToken: row.token }); }
        catch { const client = clients.get(row.steamId); if (client) scheduleRetry(row.steamId, client); }
        await new Promise(done => setTimeout(done, 250));
      }
    } catch { onError?.({ steamId: 'restore', message: 'No se pudieron recuperar las sesiones almacenadas; se reintentará.' }); }
    finally { restoring = false; if (!closing) { clearTimeout(restoreTimer); restoreTimer = setTimeout(() => void restore(), 60000); restoreTimer.unref?.(); } }
  }

  function close() {
    closing = true; clearTimeout(restoreTimer);
    for (const id of retry.keys()) cancelRetry(id);
    const old = [...clients.values()]; clients.clear();
    for (const client of old) client.logOff();
    clients.clear();
    playing.clear();
    pending.clear();
    activity.clear(); elapsed.clear(); connectedIds.clear(); durable.clear(); connection.clear(); suspended.clear();
    configurations.clear();
    replies.clear();
  }

  return { login, guard, launch, stop, disconnect, isConnected, steamIdOf, playingEntries, restore, close, configure, flushTokens, activitySince: id => activity.get(id) ?? null, activitySeconds, connectionStatus: id => connection.get(id) ?? 'disconnected' };
}

module.exports = { createSteamSessions };