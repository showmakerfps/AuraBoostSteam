'use strict';

const $ = id => document.getElementById(id);
const buttons = selector => [...document.querySelectorAll(selector)];
const number = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 1 });
const date = new Intl.DateTimeFormat('es-AR', { dateStyle: 'medium', timeStyle: 'short' });
const year = new Intl.DateTimeFormat('es-AR', { year: 'numeric' });
const fields = ['title', 'description', 'reply', 'persona'];
const emptyConfig = { selected: [], favorites: [], profiles: [], title: '', description: '', reply: '', autoSend: false, persona: 'online' };
const logo = '/icon.png';
const steamSignIn = 'https://community.fastly.steamstatic.com/public/images/signinthroughsteam/sits_01.png';
const accountStatuses = {
  unconfigured: 'Configurá la clave de la API de Steam para obtener el perfil y la biblioteca.',
  unavailable: 'Steam no entregó la biblioteca. Revisá la privacidad de tus detalles de juegos y volvé a sincronizar.'
};
const pageCopy = {
  library: ['Biblioteca', 'Organizá los juegos de tus cuentas de Steam.'],
  profiles: ['Perfiles', 'Alterná entre tus selecciones guardadas.'],
  stats: ['Actividad', 'Consultá las últimas acciones de la cuenta elegida.'],
  settings: ['Ajustes', 'Administrá las cuentas vinculadas y sus textos locales.']
};

let session = {};
let dashboard = {};
let selectedId;
let filter = 'all';
let activePage = 'library';
let stream;
let connectionTimer;
let refreshTimer;
let toastTimer;
let authVersion = 0;
let refreshVersion = 0;
let selectionWrites = Promise.resolve();
let avatarKey;
let guardLogin;
let guardPollTimer;
let guardPolling = false;
let loginAccountId;
let loginMode = 'manual';
const details = new Map();
const detailVersions = new Map();
const failedDetails = new Set();
const drafts = new Map();
const mutations = new Map();
const busy = new Set();
const coverCache = new Map();
const missingCovers = new Set();

function element(tag, className, label) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (label !== undefined) node.textContent = label;
  return node;
}

function setToast(message) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { $('toast').hidden = true; }, 5500);
}

function setAuthMessage(message, isError = false) {
  const output = $('authMessage');
  output.textContent = message;
  output.hidden = !message;
  output.toggleAttribute('data-error', isError);
}

function setConnection(message, connected = false) {
  $('connection').textContent = message;
  $('dot').classList.toggle('on', connected);
}

function labelText(error) {
  return error.status ? error.message : 'No se pudo comunicar con AuraBoost. Volvé a intentar.';
}

async function request(path, { method = 'GET', body, expire = true } = {}) {
  const options = { method, credentials: 'same-origin', cache: 'no-store' };
  if (method !== 'GET') {
    if (!session.csrf) session = await request('/api/session', { expire: false });
    options.headers = { 'content-type': 'application/json', 'x-csrf-token': session.csrf };
    options.body = JSON.stringify(body ?? {});
  }

  const response = await fetch(path, options);
  const data = await response.json().catch(() => null);
  if (!response.ok || data === null) {
    if (response.status === 401 && expire && session.authenticated) void bootstrap('La sesión venció. Volvé a ingresar.');
    const message = typeof data?.error === 'string' && data.error.length <= 240
      ? data.error
      : 'No se pudo completar la operación.';
    throw Object.assign(new Error(message), { status: response.status });
  }
  return data;
}

function showGate(mode, message = '', isError = false) {
  const [heading, intro] = {
    login: ['Iniciar sesión', 'Accedé con tu cuenta autorizada de AuraBoost.'],
    recovery: ['Recuperar contraseña', 'Ingresá el correo de tu cuenta de AuraBoost.'],
    password: ['Elegir una contraseña nueva', 'Escribí al menos 8 caracteres.']
  }[mode];
  $('loading').hidden = true;
  $('gate').hidden = false;
  $('app').hidden = true;
  $('nav').hidden = true;
  $('logout').hidden = true;
  $('authTitle').textContent = heading;
  $('authIntro').textContent = intro;
  $('loginForm').hidden = mode !== 'login';
  $('recoveryForm').hidden = mode !== 'recovery';
  $('passwordForm').hidden = mode !== 'password';
  $('mockCredentials').hidden = !session.mock || mode !== 'login';
  setAuthMessage(message, isError);
}

function showApp() {
  $('loading').hidden = true;
  $('gate').hidden = true;
  $('app').hidden = false;
  $('nav').hidden = false;
  $('logout').hidden = false;
  showPage(activePage);
  render();
}

function takeReturnStatus() {
  const url = new URL(window.location.href);
  const auth = url.searchParams.get('auth');
  const steam = url.searchParams.get('steam');
  if (auth || steam) {
    url.searchParams.delete('auth');
    url.searchParams.delete('steam');
    window.history.replaceState(null, '', url);
  }
  return { auth, steam };
}

function stopEvents() {
  stream?.close();
  stream = undefined;
  window.clearTimeout(refreshTimer);
  window.clearTimeout(connectionTimer);
  connectionTimer = undefined;
}

function clearPrivateState() {
  dashboard = {};
  selectedId = undefined;
  guardLogin = undefined;
  clearTimeout(guardPollTimer);
  loginAccountId = undefined;
  if ($('loginSteamDialog').open) $('loginSteamDialog').close();
  refreshVersion += 1;
  selectionWrites = Promise.resolve();
  details.clear();
  detailVersions.clear();
  drafts.clear();
  mutations.clear();
  failedDetails.clear();
  busy.clear();
  coverCache.clear();
  missingCovers.clear();
  if ($('removeDialog').open) $('removeDialog').close();
  $('removeMessage').textContent = '';
  $('toast').hidden = true;
  $('search').value = '';
  $('profileName').value = '';
  $('steamPassword').value = '';
  $('steamGuard').value = '';
  for (const field of fields) $(field).value = '';
  filter = 'all';
  render();
  showPage('library');
}

async function bootstrap(notice = '', returned = {}) {
  const version = ++authVersion;
  stopEvents();
  const previousSession = session;
  const wasAuthenticated = session.authenticated;
  session = {};
  try {
    const result = await request('/api/session', { expire: false });
    if (version !== authVersion) return;
    session = result;
    if (session.authenticated && !session.recovery) {
      setConnection(session.mock ? 'Datos simulados' : 'Conectando con AuraBoost');
      showApp();
      if (notice) setToast(notice);
      if (returned.auth === 'error') setToast('No se pudo completar el inicio de sesión.');
      if (returned.steam === 'vinculada') setToast('Cuenta de Steam vinculada.');
      if (returned.steam === 'error') setToast('No se pudo vincular la cuenta de Steam.');
      await refresh();
      if (version === authVersion) startEvents();
      return;
    }
    clearPrivateState();
    const authError = returned.auth === 'error' || (returned.auth === 'recuperar' && !session.recovery);
    showGate(session.recovery ? 'password' : 'login', authError ? 'No se pudo usar el enlace. Iniciá sesión o solicitá uno nuevo.' : notice, authError);
  } catch (error) {
    if (version !== authVersion) return;
    if (wasAuthenticated && error.status !== 401) {
      session = previousSession;
      setConnection('Reconectando con AuraBoost');
      setToast('Conexión temporalmente no disponible.');
      window.setTimeout(() => { if (version === authVersion) void bootstrap(); }, 5000);
      return;
    }
    if (wasAuthenticated) clearPrivateState();
    showGate('login', labelText(error), true);
  }
}

function startEvents() {
  stopEvents();
  const version = authVersion;
  const source = new EventSource('/api/events');
  stream = source;
  source.addEventListener('open', () => {
    if (stream !== source) return;
    window.clearTimeout(connectionTimer);
    connectionTimer = undefined;
    setConnection(session.mock ? 'Datos simulados en vivo' : 'Conexión en vivo', true);
    scheduleRefresh();
  });
  source.addEventListener('state', scheduleRefresh);
  source.addEventListener('error', () => {
    if (stream !== source) return;
    setConnection('Reconectando con AuraBoost');
    if (connectionTimer !== undefined) return;
    connectionTimer = window.setTimeout(async () => {
      connectionTimer = undefined;
      try {
        const current = await request('/api/session', { expire: false });
        if (version !== authVersion || stream !== source) return;
        if (!current.authenticated || current.recovery) await bootstrap('Volvé a iniciar sesión para continuar.');
        else if (source.readyState === EventSource.CLOSED) startEvents();
      } catch {
        // EventSource reintenta al restablecerse la conexión.
      }
    }, 2000);
  });
}

function scheduleRefresh() {
  window.clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(() => { void refresh(); }, 140);
}

async function refresh() {
  const auth = authVersion;
  const version = ++refreshVersion;
  try {
    const next = await request('/api/state');
    if (version !== refreshVersion || auth !== authVersion) return;
    dashboard = next;
    const accounts = next.accounts;
    if (!accounts.some(account => account.id === selectedId)) {
      const preferred = accounts.find(account => account.id === next.settings.selectedAccountId);
      selectLocally(preferred?.id ?? accounts[0]?.id);
    }
    render();
    if (selectedId) await loadAccount(selectedId);
  } catch (error) {
    if (version === refreshVersion && auth === authVersion) setToast(labelText(error));
  }
}

function selectLocally(id) {
  if (selectedId === id) return;
  selectedId = id;
  filter = 'all';
  $('search').value = '';
  $('sort').value = 'az';
  $('games').scrollTop = 0;
  $('profileName').value = '';
}

async function loadAccount(id) {
  const auth = authVersion;
  const version = (detailVersions.get(id) ?? 0) + 1;
  detailVersions.set(id, version);
  try {
    const data = await request(accountPath(id));
    if (auth !== authVersion || detailVersions.get(id) !== version) return;
    details.set(id, data);
    failedDetails.delete(id);
  } catch (error) {
    if (auth !== authVersion || detailVersions.get(id) !== version) return;
    failedDetails.add(id);
    if (selectedId === id) setToast(labelText(error));
  }
  if (selectedId === id) render();
}

function accountPath(id) {
  return '/api/accounts/' + encodeURIComponent(id);
}

function currentData() {
  return details.get(selectedId);
}

function currentAccount() {
  const summary = dashboard.accounts?.find(account => account.id === selectedId);
  const detail = currentData()?.account;
  return summary || detail ? {...detail,...summary} : undefined;
}

function configFor(id) {
  const config = details.get(id)?.config ?? emptyConfig;
  return Object.assign({}, config, ...(mutations.get(id)?.patches ?? []));
}

function changeConfig(patch) {
  const id = selectedId;
  const data = currentData();
  if (!id || !data) return Promise.resolve(false);
  const auth = authVersion;
  const queue = mutations.get(id) ?? { patches: [], tail: Promise.resolve() };
  mutations.set(id, queue);
  queue.patches.push(patch);
  render();
  const action = queue.tail.then(async () => {
    try {
      if (auth !== authVersion) return false;
      await request(accountPath(id) + '/settings', { method: 'PATCH', body: patch });
      if (auth !== authVersion) return false;
      const current = details.get(id);
      if (current) current.config = { ...current.config, ...patch };
      detailVersions.set(id, (detailVersions.get(id) ?? 0) + 1);
      return true;
    } catch (error) {
      if (auth === authVersion) setToast(labelText(error));
      return false;
    } finally {
      queue.patches.shift();
      if (!queue.patches.length && mutations.get(id) === queue) mutations.delete(id);
      if (auth === authVersion && selectedId === id) {
        render();
        scheduleRefresh();
      }
    }
  });
  queue.tail = action;
  return action;
}

function showPage(page) {
  if (!Object.hasOwn(pageCopy, page)) return;
  activePage = page;
  $('libraryMetrics').hidden = page !== 'library';
  const [heading, subtitle] = pageCopy[page];
  $('pageTitle').textContent = heading;
  $('subtitle').textContent = subtitle;
  for (const button of buttons('[data-page]')) {
    const chosen = button.dataset.page === page;
    $(button.dataset.page).hidden = !chosen;
    if (chosen) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
}

function render() {
  renderAccount();
  renderGames();
  renderProfiles();
  renderHistory();
}

function renderAccount() {
  const accounts = dashboard.accounts ?? [];
  const selector = $('accountSelect');
  const account = currentAccount();
  const config = configFor(selectedId);
  const options = accounts.length ? accounts.map(({ id, name }) => [id, name]) : [['', 'Sin cuentas']];
  const signature = JSON.stringify(options);
  if (selector.dataset.options !== signature) {
    selector.dataset.options = signature;
    selector.replaceChildren(...options.map(([value, name]) => new Option(name, value)));
  }
  selector.value = selectedId ?? '';
  selector.disabled = !accounts.length;
  $('logout').disabled = busy.has('logout');
  $('removeAccount').disabled = !account || busy.has('remove');
  $('profile').textContent = account?.name ?? 'Sin cuenta vinculada';
  $('accountDot').classList.toggle('on', account?.online === true);
  $('accountState').textContent = account?.presence ?? 'Presencia sin datos';
  const observed = asDate(account?.syncedAt);
  $('accountState').title = observed ? 'Última consulta · ' + date.format(observed) : '';
  renderAvatar(account?.avatar);
  $('accountFields').hidden = !currentData();

  const connected = account?.sessionConnected === true;
  const waiting = guardLogin?.accountId === selectedId;
  $('sessionBlock').hidden = !currentData();
  const reconnecting = ['reconnecting','connecting','authorizing'].includes(account?.connectionStatus);
  $('openSession').hidden = !account || connected || waiting || reconnecting;
  $('sessionForm').hidden = loginMode !== 'manual';
  if ((connected || waiting) && $('loginSteamDialog').open) $('loginSteamDialog').close();
  const guardDialog = $('guardDialog');
  if (waiting && !guardDialog.open && session.authenticated) guardDialog.showModal();
  else if (!waiting && guardDialog.open) guardDialog.close();
  const working = busy.has('session:' + selectedId) || busy.has('guard:' + selectedId);
  for (const form of [$('sessionForm'), $('guardForm')]) {
    for (const input of form.querySelectorAll('input, button')) input.disabled = working;
  }
  $('guardCodeFields').hidden = !guardLogin?.codeAllowed || guardLogin?.status === 'connecting';
  $('guardQR').hidden = !guardLogin?.qr || guardLogin?.status !== 'waiting';
  $('officialQR').disabled = working;
  $('cancelGuard').disabled = working || guardLogin?.status === 'connecting';
  $('unlinkSession').hidden = waiting || (!connected && !account?.sessionLinked && !reconnecting);
  $('sessionState').textContent = account?.connectionStatus === 'paused' ? 'Steam informa que la cuenta está en uso en otro cliente.' : connected ? 'Sesión de Steam conectada.' : waiting ? 'Esperando Steam Guard.' : reconnecting ? 'Recuperando sesión automáticamente…' : account?.sessionLinked ? 'Steam requiere una nueva autorización.' : 'Sesión no conectada.';
  $('autoSend').checked = (drafts.get(selectedId)?.autoSend ?? config.autoSend) === true;

  const draft = drafts.get(selectedId);
  for (const field of fields) {
    const next = draft?.[field] ?? config[field] ?? emptyConfig[field] ?? '';
    if ($(field).value !== next) $(field).value = next;
  }
  $('saveAccount').disabled = !draft || busy.has('save:' + selectedId);
  $('libraryStatus').textContent = accountStatuses[account?.libraryStatus] ?? '';
  $('libraryStatus').hidden = !$('libraryStatus').textContent;

  $('linkSteam').disabled = !session.authenticated || busy.has('link');
  $('linkHint').hidden = accounts.length > 0;

}

function avatarUrl(value) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const knownHost = url.hostname.endsWith('.steamstatic.com') || url.hostname === 'steamcdn-a.akamaihd.net';
    if (url.protocol === 'https:' && !url.port && !url.username && !url.password && knownHost) return url;
  } catch {
    // Los datos ausentes o inválidos usan la imagen local.
  }
}

function renderAvatar(value) {
  const url = session.mock ? undefined : avatarUrl(value);
  const key = url?.href ?? logo;
  if (key === avatarKey) return;
  avatarKey = key;
  const img = $('avatar');
  const hash = url?.pathname.match(/([a-f0-9]{40})(?:_(?:medium|full))?\.jpg$/i)?.[1];
  const choices = [...new Set([key, ...window.auraImages.avatars(hash), logo])];
  img.onerror = () => {
    if (choices.length) img.src = choices.shift();
    else img.onerror = null;
  };
  img.src = choices.shift();
}

function coverElement(game) {
  const cover = element('div', 'cover');
  const fallback = element('span', 'cover-fallback', game.name);
  fallback.setAttribute('aria-hidden', 'true');
  cover.append(fallback);
  if (session.mock || missingCovers.has(game.id)) return cover;
  const urls = [...new Set([coverCache.get(game.id), ...window.auraImages.covers(game)].filter(Boolean))];
  if (!urls.length) return cover;
  const img = element('img');
  img.alt = '';
  img.loading = 'lazy';
  img.decoding = 'async';
  fallback.hidden = true;
  cover.prepend(img);
  img.addEventListener('load', () => coverCache.set(game.id, img.src));
  img.addEventListener('error', () => {
    if (urls.length) img.src = urls.shift();
    else {
      img.remove();
      fallback.hidden = false;
      coverCache.delete(game.id);
      missingCovers.add(game.id);
    }
  });
  img.src = urls.shift();
  return cover;
}

function visibleGames() {
  const data = currentData();
  return window.auraLibrary.visibleGames(data?.games ?? [], configFor(selectedId), filter, $('search').value, $('sort').value);
}

function showEmptyLibrary() {
  let title = 'No hay juegos para mostrar';
  let message = 'Probá con otro filtro o término de búsqueda.';
  if (!selectedId) {
    title = 'Tu biblioteca, en un solo lugar';
    message = 'Vinculá una cuenta de Steam para ver sus juegos.';
  } else if (failedDetails.has(selectedId) && !currentData()) {
    title = 'No se pudo abrir la biblioteca';
    message = 'Volvé a cargar los datos de la cuenta.';
  } else if (!currentData()) {
    title = 'Cargando biblioteca';
    message = 'Consultando los datos guardados de esta cuenta.';
  } else if (!currentData().games.length) {
    title = 'No hay juegos disponibles';
    message = accountStatuses[currentAccount()?.libraryStatus] ?? 'Sincronizá la cuenta para consultar los datos de Steam.';
  }
  const box = element('div', 'empty');
  const symbol = element('div', 'symbol', '◇');
  symbol.setAttribute('aria-hidden', 'true');
  box.append(symbol, element('strong', '', title), element('p', '', message));
  if (!selectedId && session.authenticated) {
    const link = element('button', 'primary', session.mock ? 'Vincular cuenta simulada' : 'Ir a cuentas de Steam');
    link.type = 'button';
    link.disabled = busy.has('link');
    link.addEventListener('click', () => {
      if (session.mock) void linkAccount();
      else $('linkSteam').focus();
    });
    box.append(link);
  } else if (selectedId && failedDetails.has(selectedId)) {
    const retry = element('button', '', 'Cargar de nuevo');
    retry.type = 'button';
    retry.addEventListener('click', () => { void loadAccount(selectedId); });
    box.append(retry);
  }
  return box;
}

function playButton(account, game) {
  const playing = account?.playing?.appid === game.id;
  const ready = account?.sessionConnected === true && account?.connectionStatus !== 'paused';
  const id = account?.id;
  const actionKey = 'play:' + id + ':' + game.id;
  const button = element('button', 'play' + (playing ? ' on' : ''), playing ? 'Detener' : 'Iniciar');
  button.type = 'button';
  button.disabled = !id || (!ready && !playing) || busy.has(actionKey);
  button.title = ready ? '' : 'Conectá la sesión de Steam de esta cuenta';
  button.setAttribute('aria-label', (playing ? 'Detener ' : 'Iniciar ') + game.name);
  button.addEventListener('click', () => {
    if (!id) return;
    void accountAction(actionKey, async () => {
      await request(accountPath(id) + (playing ? '/stop' : '/launch'), {
        method: 'POST', body: playing ? {} : { appid: game.id }
      });
      setToast(playing ? 'Juego detenido.' : 'Actividad solicitada a Steam.');
      await refresh();
    });
  });
  return button;
}

function gameRow(game, selected, favorites) {
  const row = element('div', 'game');
  const check = element('input');
  check.type = 'checkbox';
  check.checked = selected.has(game.id);
  check.dataset.gameId = game.id;
  check.setAttribute('aria-label', 'Seleccionar ' + game.name);
  check.addEventListener('change', () => toggleGame('selected', game.id));

  const name = element('div', 'name', game.name);
  const metadata = ['AppID ' + game.id];
  if (Number.isFinite(game.bytes)) metadata.push(number.format(game.bytes / 1e9) + ' GB');
  if (Number.isFinite(game.release)) metadata.push(year.format(new Date(game.release * 1000)));
  name.append(element('small', '', metadata.join(' · ')));

  const favorite = favorites.has(game.id);
  const star = element('button', 'star', favorite ? '★' : '☆');
  star.type = 'button';
  star.dataset.gameId = game.id;
  star.setAttribute('aria-label', 'Favorito · ' + game.name);
  star.setAttribute('aria-pressed', String(favorite));
  star.addEventListener('click', () => toggleGame('favorites', game.id));
  const hours = Number.isFinite(game.minutes) ? number.format(game.minutes / 60) + ' h' : '—';
  row.append(check, coverElement(game), name, element('span', 'playtime', hours), playButton(currentAccount(), game), star);
  return row;
}

function renderGames() {
  const games = currentData()?.games ?? [];
  const config = configFor(selectedId);
  const selected = new Set(config.selected);
  const favorites = new Set(config.favorites);
  const counts = { all: games.length, selected: selected.size, favorites: favorites.size };
  for (const button of buttons('[data-filter]')) {
    const key = button.dataset.filter;
    button.setAttribute('aria-pressed', String(key === filter));
    button.textContent = ({ all: 'Todos', selected: 'Seleccionados', favorites: 'Favoritos' })[key] + ' (' + counts[key] + ')';
  }

  for (const option of buttons('#sort [data-game-field]')) {
    option.disabled = !games.some(game => Number.isFinite(game[option.dataset.gameField]));
  }
  const sort = $('sort');
  if (sort.selectedOptions[0]?.disabled) sort.value = 'az';
  const visible = visibleGames();
  const list = $('games');
  const focused = list.contains(document.activeElement) ? document.activeElement : null;
  const scroll = list.scrollTop;
  const fragment = document.createDocumentFragment();
  if (!visible.length) fragment.append(showEmptyLibrary());
  for (const game of visible) fragment.append(gameRow(game, selected, favorites));
  list.replaceChildren(fragment);
  list.scrollTop = scroll;
  if (focused && focused !== list) {
    const replacement = [...list.querySelectorAll('[data-game-id]')].find(node => node.tagName === focused.tagName && node.dataset.gameId === focused.dataset.gameId);
    (replacement ?? list).focus({ preventScroll: true });
  }

  const sum = games.reduce((total, game) => total + (Number.isFinite(game.minutes) ? game.minutes : 0), 0);
  $('count').textContent = number.format(games.length);
  $('hours').textContent = games.some(game => Number.isFinite(game.minutes)) ? number.format(sum / 60) + ' h' : '—';
  $('selectedMetric').textContent = number.format(selected.size);
  $('favoriteMetric').textContent = number.format(favorites.size);
  $('selectedCount').textContent = number.format(selected.size) + (selected.size === 1 ? ' seleccionado' : ' seleccionados');
  $('clearSearch').hidden = !$('search').value;
  $('clear').disabled = !selected.size;
  $('selectAll').disabled = !visible.some(game => !selected.has(game.id));
  $('scan').disabled = !selectedId || !dashboard.steamConfigured || busy.has('sync:' + selectedId);
  $('scan').setAttribute('aria-busy', String(busy.has('sync:' + selectedId)));
}

function toggleGame(field, id) {
  const ids = new Set(configFor(selectedId)[field]);
  if (ids.has(id)) ids.delete(id);
  else ids.add(id);
  void changeConfig({ [field]: [...ids] });
}

function renderProfiles() {
  const target = $('profileList');
  const { profiles, selected } = configFor(selectedId);
  $('profileName').disabled = !selectedId;
  $('profileForm').querySelector('button').disabled = !selected.length;
  if (!profiles.length) {
    target.replaceChildren(element('p', 'muted', 'Todavía no hay selecciones guardadas para esta cuenta.'));
    return;
  }
  target.replaceChildren(...profiles.map(({ name, ids }, index) => {
    const row = element('div', 'saved');
    const load = element('button', '', 'Cargar');
    const remove = element('button', '', 'Eliminar');
    load.type = remove.type = 'button';
    load.setAttribute('aria-label', 'Cargar ' + name);
    remove.setAttribute('aria-label', 'Eliminar ' + name);
    load.addEventListener('click', () => {
      const available = new Set(currentData().games.map(game => game.id));
      void changeConfig({ selected: ids.filter(id => available.has(id)) });
      showPage('library');
    });
    remove.addEventListener('click', () => {
      void changeConfig({ profiles: configFor(selectedId).profiles.filter((_, position) => position !== index) });
    });
    row.append(element('span', '', name + ' · ' + number.format(ids.length) + ' juegos'), load, remove);
    return row;
  }));
}

function asDate(value) {
  if (!value) return undefined;
  const parsed = new Date(typeof value === 'number' && value < 1e12 ? value * 1000 : value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function durationText(seconds) {
  const n = Math.max(0, Math.floor(seconds || 0));
  return [Math.floor(n/3600), Math.floor(n/60)%60, n%60].map(x => String(x).padStart(2,'0')).join(':');
}
function renderActiveSessions() {
  const active = (dashboard.accounts ?? []).filter(account => account.playing);
  $('quickActivity').hidden = !active.length;
  for (const target of [$('quickSessions'), $('activeSessions')]) {
    target.replaceChildren(...active.map(account => {
      const row = element('div', 'active-session');
      const game = details.get(account.id)?.games?.find(game => game.id === account.playing.appid);
      const info = element('div', 'active-session-info');
      info.append(element('strong', '', game?.name ?? account.playing.name ?? ('AppID ' + account.playing.appid)), element('small', '', account.name));
      const timer = element('span', 'session-timer', durationText(account.activitySeconds));
      timer.dataset.elapsed = String(account.activitySeconds ?? 0);
      if (account.sessionConnected && account.activitySince) timer.dataset.since = account.activitySince;
      timer.title = 'Tiempo de actividad conectado registrado por AuraBoost; no es tiempo confirmado por Steam';
      const status = element('small', 'active-status', account.activitySince && account.sessionConnected ? 'En ejecución' : 'En pausa / reconectando');
      const stop = element('button', 'stop-session', 'Detener');
      stop.type = 'button';
      stop.disabled = busy.has('stop:' + account.id);
      stop.addEventListener('click', () => void accountAction('stop:' + account.id, async () => {
        const result = await request(accountPath(account.id) + '/stop', { method: 'POST' });
        setToast('Juego detenido. Tiempo registrado: ' + durationText(result.activitySeconds));
        await refresh();
      }));
      row.append(info, status, timer, stop);
      return row;
    }));
    if (!active.length) target.append(element('p', 'muted', 'No hay sesiones de juego registradas.'));
  }
  tickActivity();
}
function renderHistory() {
  renderActiveSessions();
  const refreshed = asDate(currentAccount()?.syncedAt);
  $('sync').textContent = refreshed ? 'Última sincronización · ' + date.format(refreshed) : 'Sin sincronizar';
  const history = currentData()?.history ?? [];
  $('logs').replaceChildren(...history.map(entry => {
    const row = element('li', 'log');
    const stamp = asDate(entry.createdAt);
    if (stamp) {
      const time = element('time', '', date.format(stamp));
      time.dateTime = stamp.toISOString();
      row.append(time);
    }
    row.append(element('span', '', entry.text));
    return row;
  }));
  if (!history.length) $('logs').append(element('li', 'muted', 'Todavía no hay actividad registrada.'));
}

function tickActivity() {
  for (const node of buttons('[data-since]')) {
    const start = Date.parse(node.dataset.since);
    if (!Number.isFinite(start)) continue;
    const n = Number(node.dataset.elapsed || 0) + Math.max(0, Math.floor((Date.now() - start) / 1000));
    node.textContent = durationText(n);
  }
}
window.setInterval(tickActivity, 1000);

function safeNavigation(value, kind) {
  const url = new URL(value, window.location.origin);
  if (session.mock && url.origin === window.location.origin) return url;
  if (!session.mock && url.protocol === 'https:' && !url.username && !url.password
    && (kind === 'google' || (kind === 'steam' && url.origin === 'https://steamcommunity.com'))) return url;
  throw new Error('URL de acceso inesperada');
}

async function authAction(form, action) {
  if (busy.has('auth')) return;
  busy.add('auth');
  const controls = [...form.querySelectorAll('button')];
  for (const control of controls) control.disabled = true;
  setAuthMessage('');
  try {
    await action();
  } catch (error) {
    setAuthMessage(labelText(error), true);
  } finally {
    for (const control of controls) control.disabled = false;
    busy.delete('auth');
  }
}

async function accountAction(key, action) {
  if (busy.has(key)) return;
  busy.add(key);
  render();
  try {
    await action();
  } catch (error) {
    setToast(labelText(error));
  } finally {
    busy.delete(key);
    render();
  }
}

function linkAccount() {
  return accountAction('link', async () => {
    const { url } = await request('/api/steam/link', { method: 'POST' });
    window.location.assign(safeNavigation(url, 'steam'));
  });
}

function removeAccount() {
  const account = currentAccount();
  if (!account) return;
  const dialog = $('removeDialog');
  dialog.returnValue = '';
  $('removeMessage').textContent = 'Se eliminarán la cuenta ' + account.name + ' y sus datos guardados en AuraBoost.';
  dialog.addEventListener('close', () => {
    if (dialog.returnValue !== 'remove') return;
    void accountAction('remove', async () => {
      await mutations.get(account.id)?.tail;
      await request(accountPath(account.id), { method: 'DELETE' });
      details.delete(account.id);
      detailVersions.delete(account.id);
      drafts.delete(account.id);
      setToast('Cuenta desvinculada.');
      await refresh();
    });
  }, { once: true });
  dialog.showModal();
}

function updateDraft() {
  if (!selectedId) return;
  const changes = { ...Object.fromEntries(fields.map(field => [field, $(field).value])), autoSend: $('autoSend').checked };
  const config = configFor(selectedId);
  if ([...fields, 'autoSend'].some(field => changes[field] !== (config[field] ?? emptyConfig[field]))) drafts.set(selectedId, changes);
  else drafts.delete(selectedId);
  $('saveAccount').disabled = !drafts.has(selectedId) || busy.has('save:' + selectedId);
}

let imageFailed = false;


$('loginForm').addEventListener('submit', event => {
  event.preventDefault();
  void authAction(event.currentTarget, async () => {
    const email = $('loginEmail').value.trim();
    const password = $('loginPassword').value;
    $('loginPassword').value = '';
    await request('/api/auth/login', { method: 'POST', body: { email, password }, expire: false });
    $('loginEmail').value = '';
    await bootstrap();
  });
});

$('google').addEventListener('click', () => {
  void authAction($('loginForm'), async () => {
    const { url } = await request('/api/auth/google', { method: 'POST', expire: false });
    window.location.assign(safeNavigation(url, 'google'));
  });
});

$('showRecovery').addEventListener('click', () => {
  $('recoveryEmail').value = $('loginEmail').value;
  $('loginPassword').value = '';
  showGate('recovery');
  $('recoveryEmail').focus();
});

for (const button of buttons('[data-login]')) button.addEventListener('click', () => {
  showGate('login');
  $('loginEmail').focus();
});

$('recoveryForm').addEventListener('submit', event => {
  event.preventDefault();
  void authAction(event.currentTarget, async () => {
    const result = await request('/api/auth/recovery', {
      method: 'POST', body: { email: $('recoveryEmail').value.trim() }, expire: false
    });
    setAuthMessage('Si el correo corresponde a tu cuenta, vas a recibir un enlace de recuperación.');
    if (session.mock && result.url) {
      const link = element('a', '', 'Abrir enlace simulado');
      link.href = safeNavigation(result.url, 'recovery');
      $('authMessage').append(document.createElement('br'), link);
    }
  });
});

$('passwordForm').addEventListener('submit', event => {
  event.preventDefault();
  void authAction(event.currentTarget, async () => {
    const password = $('newPassword').value;
    $('newPassword').value = '';
    await request('/api/auth/password', { method: 'POST', body: { password } });
    await bootstrap('Contraseña actualizada.');
  });
});

async function logout() {
  await request('/api/auth/logout', { method: 'POST' });
  $('newPassword').value = '';
  clearPrivateState();
  await bootstrap();
}

$('cancelRecovery').addEventListener('click', () => { void authAction($('passwordForm'), logout); });
$('logout').addEventListener('click', () => { void accountAction('logout', logout); });
for (const button of buttons('[data-page]')) button.addEventListener('click', () => showPage(button.dataset.page));

for (const button of buttons('[data-filter]')) button.addEventListener('click', () => {
  filter = button.dataset.filter;
  $('games').scrollTop = 0;
  renderGames();
});

$('search').addEventListener('input', () => {
  $('games').scrollTop = 0;
  renderGames();
});
$('clearSearch').addEventListener('click', () => {
  $('search').value = '';
  $('search').focus();
  $('games').scrollTop = 0;
  renderGames();
});
$('sort').addEventListener('change', () => {
  $('games').scrollTop = 0;
  renderGames();
});
$('selectAll').addEventListener('click', () => {
  const ids = new Set(configFor(selectedId).selected);
  for (const game of visibleGames()) ids.add(game.id);
  void changeConfig({ selected: [...ids] });
});
$('clear').addEventListener('click', () => { void changeConfig({ selected: [] }); });

$('accountSelect').addEventListener('change', () => {
  const id = $('accountSelect').value;
  const auth = authVersion;
  selectLocally(id);
  render();
  void loadAccount(id);
  selectionWrites = selectionWrites.then(async () => {
    if (auth === authVersion) await request('/api/settings', { method: 'PATCH', body: { selectedAccountId: id } });
  }).catch(error => {
    if (auth === authVersion) setToast(labelText(error));
  });
});

$('scan').addEventListener('click', () => {
  const id = selectedId;
  if (!id) return;
  void accountAction('sync:' + id, async () => {
    missingCovers.clear();
    await request(accountPath(id) + '/sync', { method: 'POST' });
    await refresh();
    const status = details.get(id)?.account?.libraryStatus;
    setToast(status === 'available' ? 'Biblioteca sincronizada.' : (accountStatuses[status] ?? 'Sincronización solicitada.'));
  });
});

$('linkSteam').addEventListener('click', () => { void linkAccount(); });
$('removeAccount').addEventListener('click', removeAccount);

function setLoginMode(mode) {
  loginMode = mode;
  $('manualMethod').setAttribute('aria-pressed', String(mode === 'manual'));
  $('qrMethod').setAttribute('aria-pressed', String(mode === 'qr'));
  $('sessionForm').hidden = mode !== 'manual';
  $('qrInfo').hidden = mode !== 'qr';
  $('steamPassword').value = '';
}
$('openSession').addEventListener('click', () => {
  loginAccountId = selectedId;
  setLoginMode('qr');
  $('loginSteamDialog').showModal();
});
$('manualMethod').addEventListener('click', () => setLoginMode('manual'));
$('qrMethod').addEventListener('click', () => setLoginMode('qr'));
$('officialQR').addEventListener('click', () => {
  const id = loginAccountId ?? selectedId;
  if (!id) return;
  void accountAction('session:' + id, async () => {
    const result = await request(accountPath(id) + '/session', {method:'POST',body:{method:'qr'}});
    receiveGuardState(id,result);
  });
});
$('cancelLogin').addEventListener('click', () => $('loginSteamDialog').close());
$('loginSteamDialog').addEventListener('close', () => { $('steamPassword').value = ''; });
$('steamGuard').addEventListener('input', event => { event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10); });
function drawSteamQR(rows) {
  if (!Array.isArray(rows) || rows.length < 21 || rows.length > 177 || !rows.every(r => typeof r === 'string' && r.length === rows.length && /^[01]+$/.test(r))) return;
  const canvas = $('qrCanvas'); const ctx = canvas.getContext('2d');
  const scale = Math.max(3, Math.floor(240 / (rows.length + 8)));
  canvas.width = canvas.height = (rows.length + 8) * scale;
  ctx.fillStyle = '#fff'; ctx.fillRect(0,0,canvas.width,canvas.height); ctx.fillStyle = '#111';
  rows.forEach((row,y) => [...row].forEach((bit,x) => { if(bit === '1') ctx.fillRect((x+4)*scale,(y+4)*scale,scale,scale); }));
}
function receiveGuardState(id, result) {
  if (result.status === 'connected') {
    guardLogin = undefined; clearTimeout(guardPollTimer);
    setToast('Sesión de Steam conectada y autorizada.');
    void refresh(); renderAccount(); return;
  }
  if (result.status === 'error') {
    guardLogin = undefined; clearTimeout(guardPollTimer);
    setToast(result.message || 'No se pudo completar la autorización.');
    void refresh(); renderAccount(); return;
  }
  guardLogin = {...result, accountId:id};
  if (result.qr) drawSteamQR(result.qr);
  $('guardMessage').textContent = result.status === 'connecting' ? 'Autorización recibida. Conectando con Steam…' : result.qr ? 'Abrí Steam Guard en el celular, escaneá el código y confirmá el acceso.' : result.mobile ? 'Confirmá el inicio de sesión en la aplicación Steam del celular. Se conectará automáticamente. También podés usar un código si Steam lo permite.' : result.codeAllowed ? 'Ingresá el código de Steam Guard.' : 'Esperando autorización de Steam…';
  renderAccount(); scheduleGuardPoll();
}
function scheduleGuardPoll() {
  clearTimeout(guardPollTimer);
  if (!guardLogin) return;
  guardPollTimer = setTimeout(async () => {
    const attempt = guardLogin;
    if (!attempt || guardPolling) { scheduleGuardPoll(); return; }
    guardPolling = true;
    try {
      const result = await request(accountPath(attempt.accountId) + '/session/status?loginId=' + encodeURIComponent(attempt.loginId));
      if (guardLogin?.loginId === attempt.loginId) receiveGuardState(attempt.accountId,result);
    } catch { if (guardLogin?.loginId === attempt.loginId) scheduleGuardPoll(); }
    finally { guardPolling = false; }
  }, 2500);
}
$('sessionForm').addEventListener('submit', event => {
  event.preventDefault();
  const id = loginAccountId ?? selectedId;
  if (!id) return;
  const password = $('steamPassword').value;
  $('steamPassword').value = '';
  void accountAction('session:' + id, async () => {
    const result = await request(accountPath(id) + '/session', {
      method: 'POST', body: {accountName:$('steamUser').value.trim(),password}
    });
    receiveGuardState(id,result);
    await refresh();
  });
});
$('guardForm').addEventListener('submit', event => {
  event.preventDefault();
  const attempt = guardLogin;
  if (!attempt?.codeAllowed) return;
  void accountAction('guard:' + attempt.accountId, async () => {
    const result = await request(accountPath(attempt.accountId) + '/session/guard', {
      method:'POST', body:{loginId:attempt.loginId,code:$('steamGuard').value.trim().toUpperCase()}
    });
    $('steamGuard').value = '';
    if (guardLogin?.loginId === attempt.loginId) receiveGuardState(attempt.accountId,result);
  });
});

$('unlinkSession').addEventListener('click', () => {
  const id = selectedId;
  if (!id) return;
  void accountAction('session:' + id, async () => {
    await request(accountPath(id) + '/session', { method: 'DELETE' });
    setToast('Sesión desconectada.');
    await refresh();
  });
});

$('autoSend').addEventListener('change', updateDraft);
$('persona').addEventListener('change', updateDraft);
$('guardDialog').addEventListener('cancel', event => event.preventDefault());
$('cancelGuard').addEventListener('click', () => {
  const attempt = guardLogin;
  if (!attempt) return;
  void accountAction('guard:' + attempt.accountId, async () => {
    await request(accountPath(attempt.accountId) + '/session/cancel', {method:'POST',body:{loginId:attempt.loginId}});
    guardLogin = undefined; clearTimeout(guardPollTimer);
    $('steamGuard').value = '';
    await refresh();
  });
});

$('profileForm').addEventListener('submit', async event => {
  event.preventDefault();
  const input = $('profileName');
  const name = input.value.trim();
  if (!name) return;
  const { selected, profiles } = configFor(selectedId);
  if (profiles.some(profile => profile.name.toLocaleLowerCase('es') === name.toLocaleLowerCase('es'))) {
    setToast('Ya existe una selección con ese nombre.');
    return;
  }
  const id = selectedId;
  if (await changeConfig({ profiles: [...profiles, { name, ids: selected }] })) {
    if (id === selectedId && input.value.trim() === name) input.value = '';
    setToast('Selección guardada.');
  }
});

for (const field of fields) $(field).addEventListener('input', updateDraft);
for (const button of buttons('[data-clear-field]')) button.addEventListener('click', () => {
  const field = $(button.dataset.clearField);
  field.value = '';
  field.focus();
  updateDraft();
});
$('accountForm').addEventListener('submit', event => {
  event.preventDefault();
  const id = selectedId;
  const draft = drafts.get(id);
  if (!draft) return;
  void accountAction('save:' + id, async () => {
    if (await changeConfig(draft)) {
      if (drafts.get(id) === draft) drafts.delete(id);
      setToast('Cambios guardados.');
    }
  });
});

void bootstrap('', takeReturnStatus());