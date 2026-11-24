'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer, request: httpRequest } = require('node:http');
const { once } = require('node:events');
const { loadConfig, MOCK_EMAIL, MOCK_PASSWORD } = require('../server/config');
const { createApp } = require('../server/app');
const { createProvider } = require('../server/auth');
const { createSessionStore, createStore } = require('../server/store');

async function setup(t, overrides = {}, options = {}) {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const config = { ...loadConfig({ DEMO_MODE: 'true', APP_ORIGIN: base }), dataDir: undefined, ...overrides };
  const { app, closeEvents } = createApp(config, options);
  server.on('request', app);
  t.after(() => {
    closeEvents();
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  });
  return { base, config };
}

function browser(base, { origin = base, forwardHeaders = {} } = {}) {
  const cookies = new Map();
  let csrf;

  async function request(path, { method = 'GET', data, headers = {}, ...options } = {}) {
    const requestHeaders = { ...forwardHeaders };
    if (cookies.size) requestHeaders.cookie = [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    if (!['GET', 'HEAD'].includes(method)) {
      requestHeaders.origin = origin;
      requestHeaders['content-type'] = 'application/json';
      if (csrf) requestHeaders['x-csrf-token'] = csrf;
    }
    const url = new URL(path, origin);
    assert.equal(url.origin, origin);
    const target = `${base}${url.pathname}${url.search}`;
    const input = {
      method, redirect: 'manual', headers: { ...requestHeaders, ...headers },
      ...(data !== undefined ? { body: JSON.stringify(data) } : {}), ...options
    };
    const response = input.headers.host ? await proxyRequest(target, input) : await fetch(target, input);
    for (const header of response.headers.getSetCookie()) {
      const [name, value] = header.split(';')[0].split('=');
      if (value) cookies.set(name, value);
      else cookies.delete(name);
    }
    if (response.headers.get('content-type')?.startsWith('text/event-stream')) return { response };
    const body = response.headers.get('content-type')?.startsWith('application/json') ? await response.json() : await response.text();
    return { response, body };
  }

  async function session() {
    const result = await request('/api/session');
    csrf = result.body.csrf;
    return result.body;
  }

  async function login() {
    await session();
    const result = await request('/api/auth/login', { method: 'POST', data: { email: MOCK_EMAIL, password: MOCK_PASSWORD } });
    assert.equal(result.response.status, 200);
    assert.equal((await session()).authenticated, true);
    return result;
  }

  const post = (path, data = {}) => request(path, { method: 'POST', data });
  return { request, session, login, post };
}

function proxyRequest(url, { method, headers, body }) {
  return new Promise((resolve, reject) => {
    if (body) headers['content-length'] = Buffer.byteLength(body);
    const request = httpRequest(url, { method, headers }, response => {
      const chunks = [];
      const raw = response.rawHeaders;
      const received = Array.from({ length: raw.length / 2 }, (_, index) => raw.slice(index * 2, index * 2 + 2));
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve(new Response(
        method === 'HEAD' ? null : Buffer.concat(chunks),
        { status: response.statusCode, headers: received }
      )));
      response.on('error', reject);
    });
    request.on('error', reject);
    request.end(body);
  });
}

test('el servidor protege la API, los eventos, los archivos y los cambios de estado', async t => {
  const { base } = await setup(t);
  const owner = browser(base);
  const anon = browser(base);
  const health = await anon.request('/health');
  assert.deepEqual(health.body, { status: 'ok' });
  assert.match((await anon.request('/')).response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  for (const path of ['/api/state', '/api/events', '/api/accounts/76561198000000000']) {
    assert.equal((await anon.request(path, { headers: { authorization: 'Bearer untrusted' } })).response.status, 401);
  }
  for (const path of ['/.env', '/package-lock.json', '/server/auth.js', '/src/main.js', '/preload.js']) {
    assert.equal((await anon.request(path)).response.status, 404);
  }
  assert.equal((await anon.request('/api/auth/login', { method: 'POST', data: {} })).response.status, 403);
  await anon.session();
  assert.equal((await anon.post('/api/steam/link')).response.status, 401);
  const login = await owner.login();
  assert.match(login.response.headers.getSetCookie().join(' '), /aura_session=[\w-]{43};.*HttpOnly; SameSite=Lax/);
  assert.deepEqual(login.body, { ok: true });
  const originAttack = await owner.request('/api/settings', {
    method: 'PATCH', data: { selectedAccountId: null }, headers: { origin: 'https://evil.example' }
  });
  assert.equal(originAttack.response.status, 403);
  const csrfAttack = await owner.request('/api/settings', {
    method: 'PATCH', data: { selectedAccountId: null }, headers: { 'x-csrf-token': 'x'.repeat(43) }
  });
  assert.equal(csrfAttack.response.status, 403);
  assert.equal((await owner.request('/api/events', { headers: { origin: 'https://evil.example' } })).response.status, 403);
  assert.equal((await owner.post('/api/auth/signup', {})).response.status, 404);
});

test('vinculación de Steam de un solo uso, edición aislada, historial y salida en tiempo real', async t => {
  const { base } = await setup(t);
  const owner = browser(base);
  const otherBrowser = browser(base);
  await owner.login();
  await otherBrowser.login();
  const events = await owner.request('/api/events', { signal: AbortSignal.timeout(5000) });
  const reader = events.response.body.getReader();
  assert.match(Buffer.from((await reader.read()).value).toString(), /conectada/);

  const firstLink = (await owner.post('/api/steam/link')).body.url;
  assert.equal((await otherBrowser.request(firstLink)).response.headers.get('location'), '/?steam=error');
  assert.equal((await owner.request(firstLink, { method: 'HEAD' })).response.status, 405);
  assert.equal((await owner.request(firstLink)).response.headers.get('location'), '/?steam=vinculada');
  assert.equal((await owner.request(firstLink)).response.headers.get('location'), '/?steam=error');
  assert.match(Buffer.from((await reader.read()).value).toString(), /event: state/);
  const { id } = (await owner.request('/api/state')).body.accounts[0];
  const accountUrl = `/api/accounts/${id}`;
  const { body } = await owner.request(accountUrl);
  assert.ok(body.games.length > 0);
  assert.equal(body.history[0].text, 'Cuenta de Steam vinculada.');
  const selected = body.games[0].id;
  const secondLink = (await owner.post('/api/steam/link')).body.url;
  await owner.request(secondLink);
  const second = (await owner.request('/api/state')).body.accounts.find(account => account.id !== id);
  assert.ok(second);

  const patch = (url, data) => owner.request(url, { method: 'PATCH', data });
  assert.equal((await patch(`${accountUrl}/settings`, { autoReply: true })).response.status, 400);
  assert.equal((await patch(`${accountUrl}/settings`, { selected: [selected, selected], profiles: [{ name: 'Mi lista', ids: [selected] }] })).response.status, 200);
  assert.equal((await patch(`${accountUrl}/settings`, { title: 'Mi título', description: 'Nota local', reply: 'Borrador', favorites: [selected] })).response.status, 200);
  assert.equal((await patch('/api/settings', { selectedAccountId: id })).response.status, 200);
  assert.equal((await owner.post(`${accountUrl}/sync`)).response.status, 200);
  const result = (await owner.request(accountUrl)).body;
  assert.deepEqual(result.config.selected, [selected]);
  assert.match(result.history[0].text, /Biblioteca sincronizada/);
  assert.equal((await owner.request(`/api/accounts/${second.id}`)).body.config.title, '');
  assert.equal((await owner.request(accountUrl, { method: 'DELETE', data: {} })).response.status, 200);
  assert.equal((await owner.request(accountUrl)).response.status, 404);
  assert.equal((await owner.request('/api/state')).body.settings.selectedAccountId, null);

  await owner.post('/api/auth/logout');
  while (!(await reader.read()).done) { /* Drain pending notifications. */ }
  assert.equal((await owner.session()).authenticated, false);
  assert.equal((await owner.request('/api/events')).response.status, 401);
  assert.equal((await otherBrowser.request('/api/state')).response.status, 200);
});

test('Google simulado y recuperación temporal sin permisos sobre los datos', async t => {
  const { base } = await setup(t);
  const client = browser(base);
  await client.session();
  const google = (await client.post('/api/auth/google')).body.url;
  const callback = await client.request(google);
  assert.equal(callback.response.headers.get('location'), '/');
  assert.equal((await client.session()).authenticated, true);
  assert.equal((await client.post('/api/auth/password', { password: 'prueba-clave-1' })).response.status, 403);
  const recovery = await client.post('/api/auth/recovery', { email: MOCK_EMAIL });
  assert.equal((await browser(base).request(recovery.body.url)).response.headers.get('location'), '/?auth=error');
  assert.equal((await client.request(recovery.body.url)).response.headers.get('location'), '/?auth=recuperar');
  const recovered = await client.session();
  assert.equal(recovered.authenticated, true);
  assert.equal(recovered.recovery, true);
  assert.equal((await client.request('/api/state')).response.status, 401);
  assert.equal((await client.request('/api/events')).response.status, 401);
  assert.equal((await client.post('/api/auth/password', { password: 'prueba-clave-1' })).response.status, 200);
  assert.equal((await client.session()).authenticated, false);
  assert.equal((await client.post('/api/auth/login', { email: MOCK_EMAIL, password: 'prueba-clave-1' })).response.status, 200);
  assert.equal((await client.session()).recovery, false);
});

test('producción exige HTTPS y emite sesión segura solo para el identificador autorizado', async t => {
  const appOrigin = 'https://auraboost.example';
  const config = loadConfig({
    NODE_ENV: 'production', APP_ORIGIN: appOrigin, SUPABASE_URL: 'https://supabase.example',
    SUPABASE_PUBLISHABLE_KEY: 'fake-local-test-key', SUPABASE_SECRET_KEY: 'fake-local-test-secret',
    STEAM_DATA_COUNTRIES: 'Argentina',
    ALLOWED_USER_ID: '11111111-1111-4111-8111-111111111111',
    SESSION_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64')
  });
  const provider = {
    login: async email => ({
      user: { id: email === MOCK_EMAIL ? config.allowedUserId : '22222222-2222-4222-8222-222222222222' },
      access_token: 'sensitive-access-token', refresh_token: 'sensitive-refresh-token',
      expires_at: Math.ceil(Date.now() / 1000) + 3600
    }),
    logout: async () => {}
  };
  const { base } = await setup(t, config, {
    provider, sessions: createSessionStore(), store: createStore({ ...config, mock: true })
  });
  const host = new URL(appOrigin).host;
  const http = browser(base, { origin: appOrigin, forwardHeaders: { host } });
  assert.equal((await http.request('/api/session')).response.status, 308);
  assert.equal((await http.request('/health', { headers: { host: 'healthcheck.railway.app' } })).response.status, 200);
  const owner = browser(base, { origin: appOrigin, forwardHeaders: { host, 'x-forwarded-proto': 'https' } });
  assert.match((await owner.request('/privacidad')).body, /<strong>Argentina<\/strong>/);
  await owner.session();
  const forbidden = await owner.post('/api/auth/login', { email: 'otra@example.org', password: MOCK_PASSWORD });
  assert.equal(forbidden.response.status, 401);
  assert.equal(forbidden.response.headers.getSetCookie().length, 0);
  const login = await owner.login();
  const headers = login.response.headers.getSetCookie().join(' ');
  assert.match(headers, /__Host-aura_session=[\w-]{43};.*HttpOnly; Secure; SameSite=Lax/);
  assert.doesNotMatch(headers + JSON.stringify(login.body), /sensitive-(access|refresh)-token/);
});

test('el cliente de Supabase usa PKCE para Google y recuperación, con el verificador del servidor', async () => {
  const origin = 'https://supabase.example';
  const redirect = 'https://auraboost.example/api/auth/callback';
  const recoveryRedirect = 'https://auraboost.example/api/auth/recovery/callback';
  const allowedUserId = '11111111-1111-4111-8111-111111111111';
  const calls = [];
  const provider = createProvider({ supabaseUrl: origin, supabaseKey: 'sb_publishable_prueba', allowedUserId },
    async (input, options) => {
      const url = new URL(input);
      assert.equal(url.origin, origin);
      calls.push({ url, body: JSON.parse(options.body) });
      if (url.pathname === '/auth/v1/recover') return Response.json({});
      return Response.json({
        user: { id: allowedUserId }, access_token: 'simulated-access',
        refresh_token: 'simulated-refresh', expires_in: 3600, token_type: 'bearer'
      });
    });
  const google = { storage: new Map() };
  const authorize = new URL(await provider.google(google, redirect));
  assert.equal(authorize.searchParams.get('redirect_to'), redirect);
  assert.equal(authorize.searchParams.get('code_challenge_method'), 's256');
  assert.equal((await provider.exchange(google, 'simulated-google-code')).user.id, allowedUserId);
  assert.equal(calls[0].url.searchParams.get('grant_type'), 'pkce');
  assert.equal(calls[0].body.auth_code, 'simulated-google-code');
  assert.ok(calls[0].body.code_verifier.length >= 43);
  assert.notEqual(calls[0].body.code_verifier, authorize.searchParams.get('code_challenge'));

  const recovery = { storage: new Map() };
  await provider.recovery(MOCK_EMAIL, recovery, recoveryRedirect);
  assert.equal(calls[1].url.searchParams.get('redirect_to'), recoveryRedirect);
  assert.equal(calls[1].body.code_challenge_method, 's256');
  assert.equal((await provider.exchange(recovery, 'simulated-recovery-code')).user.id, allowedUserId);
  assert.ok(calls[2].body.code_verifier.length >= 43);
});
