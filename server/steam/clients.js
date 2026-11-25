'use strict';

const { randomBytes } = require('node:crypto');
const SteamUser = require('steam-user');
const { LoginSession, EAuthTokenPlatformType, EAuthSessionGuardType } = require('steam-session');

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

function createSteamSessions({ tokens, onState, onError, Client = SteamUser, AuthSession = LoginSession } = {}) {
  const clients = new Map();
  const playing = new Map();
  const pending = new Map();
  const manuallyDisconnected = new Set();
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
    client.on('steamGuard', () => {
      if (clients.get(steamId) !== client) return;
      connection.set(steamId, 'needs-auth');
      suspended.add(steamId); cancelRetry(steamId);
      onError?.({steamId, message:'Steam requiere una autorización nueva del cliente.'});
      notify();
    });
    client.on('disconnected', (eresult) => {
      if (clients.get(steamId) !== client) return;
      connectedIds.delete(steamId); pauseActivity(steamId);
      connection.set(steamId, suspended.has(steamId) ? 'needs-auth' : durable.has(steamId) ? 'reconnecting' : 'needs-auth');
      if (durable.has(steamId) && !suspended.has(steamId)) scheduleRetry(steamId, client);
      onError?.({ steamId, message: 'Steam desconectado (resultado ' + String(eresult ?? 'desconocido') + ').' });
      notify();
    });
    client.on('playingState', blocked => {
      if (clients.get(steamId) !== client) return;
      if (blocked) {
        onError?.({steamId, message:'Steam informa que esta cuenta está jugando en otra sesión.'});
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
      const fatal = [5, 63, 65, 85, 86, 88].includes(error?.eresult) || error?.eresult === SteamUser.EResult.LogonSessionReplaced || error?.eresult === SteamUser.EResult.LoggedInElsewhere;
      if (fatal) { suspended.add(steamId); cancelRetry(steamId); connection.set(steamId, 'needs-auth'); }
      else if (durable.has(steamId)) scheduleRetry(steamId, client);
      else connection.set(steamId, 'needs-auth');
      onError?.({ steamId, message: describe(error).message + ' (resultado ' + String(error?.eresult ?? 'desconocido') + ')' });
      notify();
    });
  }

  function create(steamId, userId) {
    const client = new Client({ autoRelogin: false, renewRefreshTokens: true, dataDirectory: null });
    connection.set(steamId, 'connecting');
    client.auraUserId = userId;
    clients.set(steamId, client);
    wire(steamId, client);
    return client;
  }

  function disconnect(steamId) {
    cancelAuth(steamId);
    manuallyDisconnected.add(steamId);
    const client = clients.get(steamId);
    clients.delete(steamId);
    cancelRetry(steamId); attempts.delete(steamId); durable.delete(steamId); suspended.delete(steamId); connectedIds.delete(steamId); connection.delete(steamId); elapsed.delete(steamId);
    playing.delete(steamId);
    activity.delete(steamId);
    configurations.delete(steamId);
    client?.logOff();
    notify();
  }

  function authView(entry) {
    return { loginId: entry.loginId, status: entry.status, mobile: entry.mobile === true, codeAllowed: entry.codeAllowed === true, message: entry.message ?? '' };
  }
  function cancelAuth(steamId) {
    const entry = pending.get(steamId);
    if (!entry) return;
    pending.delete(steamId);
    clearTimeout(entry.timer);
    try { entry.session.cancelLoginAttempt(); } catch {}
  }
  function failAuth(steamId, entry, message) {
    if (pending.get(steamId) !== entry) return;
    entry.status = 'error';
    entry.message = message;
    clearTimeout(entry.timer);
    try { entry.session.cancelLoginAttempt(); } catch {}
    if (!isConnected(steamId)) connection.set(steamId, 'needs-auth');
    notify();
  }
  function loginStatus(steamId, loginId) {
    const entry = pending.get(steamId);
    if (!entry || entry.loginId !== loginId) return {status:'error', message:'La solicitud ya no está disponible. Volvé a conectar.'};
    return authView(entry);
  }
  async function login(steamId, userId, accountName, password, onConnected) {
    if (isConnected(steamId)) return {status:'connected'};
    const existing = pending.get(steamId);
    if (existing && ['waiting','connecting'].includes(existing.status)) return authView(existing);
    cancelAuth(steamId);
    const auth = new AuthSession(EAuthTokenPlatformType.SteamClient);
    auth.loginTimeout = PENDING_TTL;
    const entry = {loginId:randomId(), session:auth, status:'waiting', mobile:false, codeAllowed:false};
    pending.set(steamId, entry);
    manuallyDisconnected.delete(steamId);
    connection.set(steamId, 'authorizing');
    entry.timer = setTimeout(() => failAuth(steamId, entry, 'La autorización venció. Volvé a iniciar sesión.'), PENDING_TTL + 45000);
    entry.timer.unref?.();
    auth.on('timeout', () => failAuth(steamId, entry, 'La autorización de Steam venció.'));
    auth.on('error', error => failAuth(steamId, entry, describe(error).message));
    auth.on('authenticated', () => {
      void (async () => {
        if (pending.get(steamId) !== entry || entry.status !== 'waiting') return;
        if (auth.steamID?.getSteamID64() !== steamId || !auth.refreshToken) {
          failAuth(steamId, entry, 'La cuenta autorizada no coincide con la cuenta de Steam seleccionada.');
          return;
        }
        entry.status = 'connecting'; notify();
        const previous = clients.get(steamId);
        clients.delete(steamId); connectedIds.delete(steamId); cancelRetry(steamId); suspended.delete(steamId);
        if (previous) { try { previous.logOff(); } catch {} }
        const client = create(steamId, userId);
        const token = auth.refreshToken;
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => finish(new Error('Steam no abrió la sesión del cliente.')), 45000);
          function finish(error) {
            clearTimeout(timeout); client.off('loggedOn', ok); client.off('error', bad);
            error ? reject(error) : resolve();
          }
          function ok() {
            if (clients.get(steamId) !== client || client.steamID?.getSteamID64() !== steamId) return finish(new Error('La identidad de Steam no coincide.'));
            finish();
          }
          function bad(error) { finish(describe(error)); }
          client.once('loggedOn', ok); client.once('error', bad);
          try { client.logOn({refreshToken:token, machineName:'AuraBoost'}); } catch (error) { finish(error); }
        });
        if (pending.get(steamId) !== entry || entry.status !== 'connecting' || !isConnected(steamId)) return;
        // Store only the verified token for this account, never its password.
        if (!durable.has(steamId) || durable.get(steamId).token !== token) {
          await tokens.save(steamId, userId, durable.get(steamId)?.token ?? token);
        } else { await flushTokens(steamId); await tokens.save(steamId,userId,durable.get(steamId)?.token ?? token); }
        if (!durable.has(steamId)) durable.set(steamId,{userId,token});
        if (pending.get(steamId) !== entry || !isConnected(steamId)) return;
        await onConnected?.();
        if (pending.get(steamId) !== entry) return;
        entry.status = 'connected'; clearTimeout(entry.timer); notify();
      })().catch(() => {
        if (pending.get(steamId) === entry) {
          failAuth(steamId, entry, 'No se pudo completar o guardar la sesión de Steam. Volvé a intentar.');
        }
      });
    });
    try {
      const result = await auth.startWithCredentials({accountName,password});
      if (pending.get(steamId) !== entry) return {status:'error', message:'Solicitud cancelada.'};
      if (auth.steamID?.getSteamID64() !== steamId) {
        failAuth(steamId, entry, 'El usuario ingresado no corresponde a la cuenta seleccionada.');
        return authView(entry);
      }
      const types = (result.validActions ?? []).map(action => action.type);
      entry.mobile = types.includes(EAuthSessionGuardType.DeviceConfirmation) || types.includes(EAuthSessionGuardType.EmailConfirmation);
      entry.codeAllowed = types.includes(EAuthSessionGuardType.DeviceCode) || types.includes(EAuthSessionGuardType.EmailCode);
      notify(); return authView(entry);
    } catch (error) { failAuth(steamId, entry, describe(error).message); return authView(entry); }
  }
  async function guard(steamId, loginId, code) {
    const entry = pending.get(steamId);
    if (!entry || entry.loginId !== loginId || entry.status !== 'waiting') return loginStatus(steamId,loginId);
    if (!entry.codeAllowed) throw Object.assign(new Error('Steam no solicitó un código para esta autorización.'),{status:409});
    try { await entry.session.submitSteamGuardCode(code); }
    catch (error) { throw describe(error); }
    return authView(entry);
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
        if (clients.has(row.steamId) || suspended.has(row.steamId) || manuallyDisconnected.has(row.steamId) || ['waiting','connecting'].includes(pending.get(row.steamId)?.status)) continue;
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
    for (const id of pending.keys()) cancelAuth(id);
    pending.clear(); manuallyDisconnected.clear();
    activity.clear(); elapsed.clear(); connectedIds.clear(); durable.clear(); connection.clear(); suspended.clear();
    configurations.clear();
    replies.clear();
  }

  return { login, guard, loginStatus, cancelAuth, launch, stop, disconnect, isConnected, steamIdOf, playingEntries, restore, close, configure, flushTokens, activitySince: id => activity.get(id) ?? null, activitySeconds, connectionStatus: id => connection.get(id) ?? 'disconnected' };
}

module.exports = { createSteamSessions };