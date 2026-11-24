const assert = require('node:assert/strict');
const { createHash, randomBytes } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const { createTokenCipher } = require('../server/crypto');
const { createSessionStore, createStore } = require('../server/store');

const owner = { id: '00000000-0000-4000-8000-000000000001', accessToken: 'mock-user-jwt' };
const outsider = { id: '00000000-0000-4000-8000-000000000002', accessToken: 'other-user-jwt' };
const steamId = '76561198000000001';

test('el cifrado de sesión autentica el contenido y el identificador', () => {
  const makeCipher = () => createTokenCipher(randomBytes(32).toString('base64'));
  const cipher = makeCipher();
  const secrets = JSON.stringify({ accessToken: 'prueba', refreshToken: 'otro valor' });
  const ciphertext = cipher.encrypt(secrets, 'sesión-1');

  assert.notEqual(ciphertext, cipher.encrypt(secrets, 'sesión-1'));
  assert.equal(cipher.decrypt(ciphertext, 'sesión-1'), secrets);
  assert.throws(() => cipher.decrypt(ciphertext, 'sesión-2'), /descifrar/);
  assert.throws(() => makeCipher().decrypt(ciphertext, 'sesión-1'), /descifrar/);
  const parts = ciphertext.split('.');
  parts[2] = (parts[2][0] === 'A' ? 'B' : 'A') + parts[2].slice(1);
  assert.throws(() => cipher.decrypt(parts.join('.'), 'sesión-1'), /descifrar/);
  assert.throws(() => createTokenCipher('too-short'), /32 bytes/);
});

test('la demostración persiste la biblioteca y fusiona modificaciones concurrentes', async t => {
  const dataDir = await fs.mkdtemp(path.join(__dirname, '.auraboost-store-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const open = () => createStore({ mock: true, allowedUserId: owner.id, dataDir });
  const store = open();
  const game = { id: 730, name: 'Juego de prueba' };
  const initialSync = '2026-11-24T12:00:00.000Z';

  await assert.rejects(store.listAccounts(outsider), { status: 403 });
  const creates = await Promise.allSettled([
    store.addAccount(owner, { id: steamId, name: 'Cuenta simulada', syncedAt: initialSync }),
    store.addAccount(owner, { id: steamId, name: 'Cuenta duplicada' })
  ]);
  assert.deepEqual(creates.map(result => result.status), ['fulfilled', 'rejected']);
  assert.equal(creates[1].reason.status, 409);
  assert.deepEqual((await store.listHistory(owner, steamId)).map(row => row.text), ['Cuenta de Steam vinculada.']);
  await Promise.all([
    store.updateSettings(owner, steamId, { favorites: [game.id] }),
    store.updateSettings(owner, steamId, { description: 'Descripción de prueba' }),
    store.saveSnapshot(owner, steamId, { games: [game], libraryStatus: 'available', syncedAt: initialSync })
  ]);
  await store.saveSnapshot(owner, steamId, { libraryStatus: 'unavailable', syncedAt: '2026-11-24T12:01:00.000Z' });
  await store.saveSnapshot(owner, steamId, { libraryStatus: 'unconfigured', syncedAt: '2026-11-24T12:02:00.000Z' });
  await store.saveSnapshot(owner, steamId, { libraryStatus: 'available', syncedAt: '2026-11-24T12:03:00.000Z' });
  await store.updateUserSettings(owner, { selectedAccountId: steamId });

  const reopened = open();
  const account = await reopened.getAccount(owner, steamId);
  assert.deepEqual(account.config.favorites, [game.id]);
  assert.equal(account.config.description, 'Descripción de prueba');
  assert.deepEqual(account.games, [game]);
  assert.deepEqual(await reopened.getSettings(owner), { selectedAccountId: steamId });
  assert.deepEqual((await reopened.listHistory(owner, steamId)).map(row => row.text), [
    'Biblioteca sincronizada. 1 juegos recibidos.',
    'La consulta a Steam requiere una clave Web API.',
    'Steam no devolvió una biblioteca visible.',
    'Cuenta de Steam vinculada.'
  ]);
  assert.equal(await reopened.removeAccount(owner, steamId), true);
  assert.equal(await reopened.saveSnapshot(owner, steamId, { games: [game] }), null);
  await assert.rejects(reopened.addHistory(owner, { id: steamId, text: 'Cuenta ausente' }), { status: 404 });
  assert.deepEqual(await reopened.getSettings(owner), { selectedAccountId: null });
  assert.deepEqual(await reopened.listHistory(owner, steamId), []);
});

test('las consultas de datos de Supabase se autentican con el usuario autorizado', async () => {
  const requests = [];
  const store = createStore({
    allowedUserId: owner.id, supabaseUrl: 'https://supabase.example', supabaseKey: 'sb_publishable_prueba',
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return Response.json([]);
    }
  });

  await assert.rejects(store.listAccounts(outsider), { status: 403 });
  await assert.rejects(store.listAccounts({ id: owner.id }), { status: 401 });
  await store.listAccounts(owner);
  assert.equal(await store.updateSettings(owner, steamId, { title: 'Cambio' }), null);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].options.headers.apikey, 'sb_publishable_prueba');
  assert.equal(requests[0].options.headers.Authorization, `Bearer ${owner.accessToken}`);
  assert.equal(requests[0].url.searchParams.get('user_id'), `eq.${owner.id}`);
  assert.equal(requests[1].url.pathname, '/rest/v1/rpc/auraboost_update_account_config');
  assert.deepEqual(JSON.parse(requests[1].options.body), { account_id: steamId, config_patch: { title: 'Cambio' } });
});

test('la sesión durable almacena el hash del identificador y acepta la respuesta de inserción vacía', async () => {
  const requests = [];
  const id = randomBytes(32).toString('base64url');
  const cipher = createTokenCipher(randomBytes(32).toString('base64'));
  const encrypted = cipher.encrypt('valor simulado', id);
  const store = createSessionStore({
    supabaseUrl: 'https://supabase.example', supabaseSecretKey: 'sb_secret_prueba',
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (options.method === 'POST') return new Response(null, { status: 201 });
      if (options.method === 'PATCH' || options.method === 'GET') return Response.json([]);
      return new Response(null, { status: 204 });
    }
  });
  const expiresAt = Date.now() + 60_000;
  await store.create(id, encrypted, expiresAt);
  assert.equal(await store.get(id), null);
  assert.equal(await store.save(id, encrypted, expiresAt), false);
  assert.equal(requests[0].options.headers.Authorization, undefined);
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    id_hash: createHash('sha256').update(id).digest('hex'), encrypted_value: encrypted,
    expires_at: new Date(expiresAt).toISOString()
  });
  assert.equal(requests[1].options.method, 'DELETE');
  assert.match(requests[1].url.searchParams.get('expires_at'), /^lte\./);
  assert.match(requests[3].url.searchParams.get('expires_at'), /^gt\./);
});

test('cerrar una sesión impide que una renovación tardía la vuelva a crear', async () => {
  const store = createSessionStore();
  const expiresAt = Date.now() + 60_000;
  await store.create('id', 'valor cifrado', expiresAt);
  await store.delete('id');
  assert.equal(await store.save('id', 'renovación', expiresAt), false);
  assert.equal(await store.get('id'), null);
});
