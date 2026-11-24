'use strict';

const { EventEmitter } = require('node:events');
const { randomBytes } = require('node:crypto');
const SteamUser = require('steam-user');

const PENDING_TTL = 5 * 60_000;
const randomId = () => randomBytes(16).toString('base64url');

const MESSAGES = {
  5: 'Usuario o contraseÃ±a incorrectos.',
  63: 'CÃ³digo de Steam Guard incorrecto.',
  65: 'CÃ³digo de Steam Guard incorrecto.',
  84: 'Steam limitÃ³ los intentos. EsperÃ¡ unos minutos y volvÃ© a intentar.',
  85: 'La cuenta se conectÃ³ desde otro lado.',
  88: 'CÃ³digo de Steam Guard incorrecto.'
};

function describe(error) {
  return Object.assign(new Error(MESSAGES[error?.eresult] ?? 'Steam rechazÃ³ la conexiÃ³n. RevisÃ¡ los datos.'), { status: 400 });
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
      const timer = setTimeout(() => settle(reject, new Error('Steam no respondiÃ³. VolvÃ© a intentar.')), 45_000);
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
      return Promise.reject(new Error('El cÃ³digo venciÃ³. VolvÃ© a conectar la cuenta.'));
    }
    const client = clients.get(steamId);
    return new Promise((resolve, reject) => {
      let done = false;
      const settle = (fn, value) => { if (!done) { done = true; clean(); fn(value); } };
      const timer = setTimeout(() => settle(reject, new Error('Steam no respondiÃ³.')), 45_000);
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
      throw Object.assign(new Error('ConectÃ¡ la sesiÃ³n de Steam de esta cuenta antes de iniciar un juego.'), { status: 409 });
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