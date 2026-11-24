'use strict';

const { createHash } = require('node:crypto');

const OPENID_NS = 'http://specs.openid.net/auth/2.0';
const OPENID_ENDPOINT = 'https://steamcommunity.com/openid/login';
const OPENID_IDENTIFIER = `${OPENID_NS}/identifier_select`;
const CLAIMED_ID = /^https:\/\/steamcommunity\.com\/openid\/id\/([1-9]\d{16})$/;
const EXPECTED_SIGNATURE_FIELDS = [
  'op_endpoint', 'return_to', 'response_nonce', 'assoc_handle', 'claimed_id', 'identity'
];
const PRESENCE = [
  'Sin conexión visible', 'En línea', 'Ocupado', 'Ausente', 'Ausencia prolongada',
  'Buscando intercambiar', 'Buscando jugar'
];
const MOCK_ACCOUNT_ID = '76561198000000000';
const MOCK_LIBRARY = [
  { id: 620, name: 'Portal 2', minutes: 432, recent: 1764612000, bytes: 13958643712, release: 1303084800 },
  { id: 730, name: 'Counter-Strike 2', minutes: 1730, recent: 1765393200, bytes: 42090679500, release: null },
  { id: 413150, name: 'Stardew Valley', minutes: 91, recent: null, bytes: 684510412, release: 1456444800 },
  { id: 1145360, name: 'Hades', minutes: 674, recent: 1762804800, bytes: null, release: 1600300800 }
];

function linkError(code, message) {
  return Object.assign(new Error(message), { code });
}

function invalidLink() {
  return linkError('invalid_steam_link', 'La verificación de Steam es inválida o venció.');
}

function avatarUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return '';
  try {
    const url = new URL(value);
    const knownHost = url.hostname.endsWith('.steamstatic.com') || url.hostname === 'steamcdn-a.akamaihd.net';
    if (url.protocol === 'https:' && knownHost && !url.port && !url.username && !url.password) return url.href;
  } catch {
    return '';
  }
  return '';
}

function emptyProfile(id) {
  return { id, name: `Steam ${id}`, avatar: '', presence: 'Sin verificar', online: null };
}

function parseProfile(body, id) {
  const records = body?.response?.players;
  const player = Array.isArray(records) && records.find(record => record?.steamid === id);
  const profile = emptyProfile(id);
  if (!player) return profile;

  const name = typeof player.personaname === 'string' && player.personaname.trim();
  if (name) profile.name = name.slice(0, 120);
  profile.avatar = avatarUrl(player.avatarmedium) || avatarUrl(player.avatarfull) || avatarUrl(player.avatar);
  const state = player.personastate;
  if (player.communityvisibilitystate === 3 && Number.isInteger(state) && PRESENCE[state]) {
    profile.presence = PRESENCE[state];
    profile.online = state > 0;
  }
  return profile;
}

function parseLibrary(body) {
  const library = body?.response;
  const hasGames = Array.isArray(library?.games);
  if (!hasGames && library?.game_count !== 0) return { games: [], libraryStatus: 'unavailable' };

  const games = [];
  const seen = new Set();
  for (const item of hasGames ? library.games : []) {
    const id = item?.appid;
    if (!Number.isSafeInteger(id) || id < 1 || id > 0xffffffff || seen.has(id)) continue;
    seen.add(id);
    const name = typeof item.name === 'string' && item.name.trim();
    games.push({
      id,
      name: name ? name.slice(0, 250) : `App ${id}`,
      minutes: Number.isSafeInteger(item.playtime_forever) && item.playtime_forever >= 0 ? item.playtime_forever : null,
      recent: Number.isSafeInteger(item.rtime_last_played) && item.rtime_last_played > 0 && item.rtime_last_played <= 0xffffffff
        ? item.rtime_last_played : null,
      bytes: null,
      release: null,
      iconHash: typeof item.img_icon_url === 'string' && /^[a-f\d]{40}$/i.test(item.img_icon_url) ? item.img_icon_url : ''
    });
  }
  return { games, libraryStatus: 'available' };
}

function createSteamEngine({ appOrigin, apiKey, mock = false, fetchImpl = globalThis.fetch, callbackPath = '/api/steam/callback' }) {
  function returnUrl(state) {
    if (typeof state !== 'string' || !/^[a-z\d_-]{16,128}$/i.test(state)) throw invalidLink();
    const target = new URL(callbackPath, appOrigin);
    target.searchParams.set('state', state);
    return target;
  }

  function beginLink(state) {
    const target = returnUrl(state);
    if (mock) {
      target.searchParams.set('mock', '1');
      return target.href;
    }

    const authorize = new URL(OPENID_ENDPOINT);
    authorize.search = new URLSearchParams({
      'openid.ns': OPENID_NS,
      'openid.mode': 'checkid_setup',
      'openid.return_to': target.href,
      'openid.realm': `${target.origin}/`,
      'openid.identity': OPENID_IDENTIFIER,
      'openid.claimed_id': OPENID_IDENTIFIER
    }).toString();
    return authorize.href;
  }

  // The caller must consume the browser session's pending state before invoking this.
  async function verifyLink(searchParams, expectedState) {
    const expectedReturnUrl = returnUrl(expectedState);
    const parameters = new URLSearchParams(searchParams);
    const keys = [...parameters.keys()];
    if (parameters.toString().length > 8192 || new Set(keys).size !== keys.length || parameters.get('state') !== expectedState) {
      throw invalidLink();
    }

    if (mock) {
      if (parameters.get('mock') !== '1') throw invalidLink();
      const value = createHash('sha256').update(expectedState).digest().readUInt32BE();
      const id = String(76561197960265728n + BigInt(value));
      return id === MOCK_ACCOUNT_ID ? '76561198000000001' : id;
    }

    if (parameters.get('openid.mode') === 'cancel') {
      throw linkError('steam_link_cancelled', 'Cancelaste la vinculación de Steam.');
    }
    const identity = parameters.get('openid.identity');
    const claimed = parameters.get('openid.claimed_id');
    const steamId = CLAIMED_ID.exec(claimed)?.[1];
    const signed = new Set(parameters.get('openid.signed')?.split(','));
    const nonce = parameters.get('openid.response_nonce') ?? '';
    const nonceMatch = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ)[\x21-\x7e]{0,235}$/.exec(nonce);
    const nonceTime = Date.parse(nonceMatch?.[1]);
    if (parameters.get('openid.mode') !== 'id_res' || parameters.get('openid.ns') !== OPENID_NS ||
        parameters.get('openid.op_endpoint') !== OPENID_ENDPOINT || parameters.get('openid.return_to') !== expectedReturnUrl.href ||
        !steamId || identity !== claimed || !parameters.get('openid.assoc_handle') || !parameters.get('openid.sig') ||
        EXPECTED_SIGNATURE_FIELDS.some(name => !signed.has(name)) ||
        !Number.isFinite(nonceTime) || Math.abs(Date.now() - nonceTime) > 5 * 60_000) {
      throw invalidLink();
    }

    const body = new URLSearchParams();
    for (const [key, value] of parameters) {
      if (key.startsWith('openid.')) body.set(key, value);
    }
    body.set('openid.mode', 'check_authentication');

    let result;
    try {
      const response = await fetchImpl(OPENID_ENDPOINT, {
        method: 'POST', body, redirect: 'error', signal: AbortSignal.timeout(8_000)
      });
      if (!response.ok) throw Error('Steam OpenID');
      result = await response.text();
    } catch {
      throw linkError('steam_unavailable', 'Steam no respondió a la verificación. Volvé a intentar.');
    }
    const validity = result.split(/\r?\n/).filter(line => line.startsWith('is_valid:'));
    if (validity.length !== 1 || validity[0] !== 'is_valid:true') throw invalidLink();
    return steamId;
  }

  async function webApi(path, params) {
    const url = new URL(path, 'https://api.steampowered.com');
    url.search = new URLSearchParams(params).toString();
    const response = await fetchImpl(url, {
      headers: { accept: 'application/json', 'x-webapi-key': apiKey },
      redirect: 'error', signal: AbortSignal.timeout(8_000)
    });
    if (!response.ok) throw Error('Steam Web API');
    return response.json();
  }

  async function getAccount(steamId) {
    if (typeof steamId !== 'string' || !/^[1-9]\d{16}$/.test(steamId)) throw Error('SteamID inválido.');
    if (mock) {
      const primary = steamId === MOCK_ACCOUNT_ID;
      return {
        profile: {
          id: steamId, name: primary ? 'Cuenta de demostración' : `Cuenta de prueba ${steamId.slice(-5)}`,
          avatar: '', presence: primary ? 'En línea (simulado)' : 'Ausente (simulado)', online: true
        },
        games: (primary ? MOCK_LIBRARY : MOCK_LIBRARY.slice(1)).map(game => ({ ...game, iconHash: '' })),
        libraryStatus: 'available'
      };
    }
    if (!apiKey) return { profile: emptyProfile(steamId), games: [], libraryStatus: 'unconfigured' };

    const [summary, library] = await Promise.allSettled([
      webApi('/ISteamUser/GetPlayerSummaries/v2/', { steamids: steamId }),
      webApi('/IPlayerService/GetOwnedGames/v1/', { steamid: steamId, include_appinfo: '1', include_played_free_games: '1' })
    ]);
    const profile = parseProfile(summary.value, steamId);
    return { profile, ...parseLibrary(library.value) };
  }

  return { beginLink, verifyLink, getAccount, mockAccountId: MOCK_ACCOUNT_ID };
}

module.exports = { createSteamEngine };
