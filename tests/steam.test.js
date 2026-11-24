'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createSteamEngine } = require('../server/steam');

const appOrigin = 'https://auraboost.example';
const state = 'this-is-a-simulated-steam-state';
const steamId = '76561198012345678';
const steamOpenId = 'https://steamcommunity.com/openid/login';
const steamApi = 'https://api.steampowered.com';
const openidNamespace = 'http://specs.openid.net/auth/2.0';

function assertion(overrides = {}) {
  const identity = `https://steamcommunity.com/openid/id/${steamId}`;
  return new URLSearchParams({
    state,
    'openid.ns': openidNamespace,
    'openid.mode': 'id_res',
    'openid.op_endpoint': steamOpenId,
    'openid.return_to': `${appOrigin}/api/steam/callback?state=${state}`,
    'openid.response_nonce': `${new Date().toISOString().slice(0, 19)}Z-test`,
    'openid.identity': identity,
    'openid.claimed_id': identity,
    'openid.assoc_handle': 'simulated-handle',
    'openid.signed': 'op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle',
    'openid.sig': 'test-signature',
    ...overrides
  });
}

test('Steam OpenID usa el proveedor fijo y verifica la firma en el servidor', async () => {
  let calls = 0;
  const fetchImpl = async (url, options) => {
    calls += 1;
    assert.equal(url, steamOpenId);
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.equal(options.body.get('openid.mode'), 'check_authentication');
    assert.equal(options.body.get('openid.sig'), 'test-signature');
    assert.equal(options.body.has('state'), false);
    return new Response(`ns:${openidNamespace}\nis_valid:true\n`);
  };
  const engine = createSteamEngine({ appOrigin, fetchImpl });
  const start = new URL(engine.beginLink(state));
  assert.equal(start.origin + start.pathname, steamOpenId);
  assert.equal(start.searchParams.get('openid.mode'), 'checkid_setup');
  assert.equal(start.searchParams.get('openid.return_to'), `${appOrigin}/api/steam/callback?state=${state}`);
  assert.equal(start.searchParams.get('openid.realm'), `${appOrigin}/`);
  assert.equal(start.searchParams.get('openid.identity'), `${openidNamespace}/identifier_select`);
  assert.equal(await engine.verifyLink(assertion(), state), steamId);
  assert.equal(calls, 1);
});

test('Steam OpenID rechaza una afirmación incompleta o ajena a la vinculación antes de consultar a Valve', async () => {
  let calls = 0;
  const engine = createSteamEngine({ appOrigin, fetchImpl: async () => { calls += 1; } });
  const invalidResults = [
    assertion({ state: 'obviously-a-different-state' }),
    assertion({ 'openid.return_to': 'https://other.example/api/steam/callback' }),
    assertion({ 'openid.op_endpoint': 'https://other.example/openid/login' }),
    assertion({ 'openid.identity': 'https://steamcommunity.com/openid/id/76561198000000000' }),
    assertion({ 'openid.claimed_id': `https://steamcommunity.com.other.example/openid/id/${steamId}` }),
    assertion({ 'openid.signed': 'op_endpoint,claimed_id,identity,return_to,response_nonce' }),
    assertion({ 'openid.response_nonce': '2001-01-01T00:00:00Z-stale' })
  ];
  const duplicate = assertion();
  duplicate.append('openid.claimed_id', `https://steamcommunity.com/openid/id/${steamId}`);
  invalidResults.push(duplicate);

  for (const parameters of invalidResults) {
    await assert.rejects(engine.verifyLink(parameters, state), { code: 'invalid_steam_link' });
  }
  await assert.rejects(engine.verifyLink(assertion({ 'openid.mode': 'cancel' }), state), { code: 'steam_link_cancelled' });
  assert.equal(calls, 0);
});

test('Steam OpenID rechaza firma inválida y normaliza los fallos del proveedor', async () => {
  for (const result of ['is_valid:false\n', 'is_valid:true\nis_valid:false\n']) {
    const engine = createSteamEngine({ appOrigin, fetchImpl: async () => new Response(result) });
    await assert.rejects(engine.verifyLink(assertion(), state), { code: 'invalid_steam_link' });
  }
  const offline = createSteamEngine({ appOrigin, fetchImpl: async () => { throw Error('detalle privado'); } });
  await assert.rejects(offline.verifyLink(assertion(), state), error => {
    assert.equal(error.code, 'steam_unavailable');
    assert.doesNotMatch(error.message, /detalle privado/);
    return true;
  });
});

test('La Web API de Steam consulta perfiles y biblioteca sin exponer la clave ni completar datos ausentes', async () => {
  const calls = [];
  const expectedAvatar = 'https://avatars.steamstatic.com/abc_medium.jpg';
  const fetchImpl = async (url, options) => {
    assert.equal(url.origin, steamApi);
    assert.equal(url.searchParams.has('key'), false);
    assert.equal(options.headers['x-webapi-key'], 'sample-secret');
    assert.equal(options.redirect, 'error');
    calls.push(url.pathname);
    if (url.pathname === '/ISteamUser/GetPlayerSummaries/v2/') {
      assert.equal(url.searchParams.get('steamids'), steamId);
      return Response.json({ response: { players: [{
        steamid: steamId, personaname: 'Aura', communityvisibilitystate: 3, personastate: 1,
        avatarmedium: 'https://steamstatic.com.other.example/foreign.jpg', avatarfull: expectedAvatar
      }] } });
    }
    assert.equal(url.pathname, '/IPlayerService/GetOwnedGames/v1/');
    assert.equal(url.searchParams.get('steamid'), steamId);
    assert.equal(url.searchParams.get('include_played_free_games'), '1');
    return Response.json({ response: { games: [
      { appid: 620, name: 'Portal 2', playtime_forever: 35, img_icon_url: 'a'.repeat(40), rtime_last_played: 1762850000 },
      { appid: 730, name: 'Counter-Strike 2', rtime_last_played: 0, img_icon_url: 'invalid' },
      { appid: '1234' }, { appid: 730, name: 'Duplicado' }, null
    ] } });
  };
  const engine = createSteamEngine({ appOrigin, fetchImpl, apiKey: 'sample-secret' });
  const result = await engine.getAccount(steamId);
  assert.equal(calls.length, 2);
  assert.deepEqual(result.profile, { id: steamId, name: 'Aura', avatar: expectedAvatar, online: true, presence: 'En línea' });
  assert.deepEqual(result.games, [
    { id: 620, name: 'Portal 2', minutes: 35, recent: 1762850000, bytes: null, release: null, iconHash: 'a'.repeat(40) },
    { id: 730, name: 'Counter-Strike 2', minutes: null, recent: null, bytes: null, release: null, iconHash: '' }
  ]);
  assert.equal(result.libraryStatus, 'available');
  assert.doesNotMatch(JSON.stringify(result), /sample-secret/);
});

test('La Web API diferencia bibliotecas vacías y privadas y presencia desconocida', async () => {
  let libraryResponse = {};
  const fetchImpl = async url => url.pathname.startsWith('/IPlayerService')
    ? Response.json({ response: libraryResponse })
    : Response.json({ response: { players: [{ steamid: steamId, communityvisibilitystate: 1, personastate: 0 }] } });
  const engine = createSteamEngine({ appOrigin, fetchImpl, apiKey: 'simulated-key' });
  const hidden = await engine.getAccount(steamId);
  assert.equal(hidden.profile.online, null);
  assert.equal(hidden.libraryStatus, 'unavailable');
  libraryResponse = { game_count: 0 };
  const empty = await engine.getAccount(steamId);
  assert.deepEqual(empty.games, []);
  assert.equal(empty.libraryStatus, 'available');
});

test('Los modos sin configuración y de demostración no llaman a Steam', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; };
  const unconfigured = createSteamEngine({ appOrigin, fetchImpl });
  assert.equal((await unconfigured.getAccount(steamId)).libraryStatus, 'unconfigured');

  const mock = createSteamEngine({ appOrigin, mock: true, fetchImpl, apiKey: 'never-used' });
  const alternateState = 'different-simulated-steam-state';
  const url = new URL(mock.beginLink(state));
  assert.equal(url.origin, appOrigin);
  const first = await mock.verifyLink(url.searchParams, state);
  const second = await mock.verifyLink(new URL(mock.beginLink(alternateState)).searchParams, alternateState);
  assert.notEqual(first, second);
  assert.notEqual(first, mock.mockAccountId);
  assert.equal((await mock.getAccount(first)).games.length > 0, true);
  assert.equal((await mock.getAccount(mock.mockAccountId)).profile.online, true);
  assert.equal(calls, 0);
});
