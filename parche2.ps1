$ErrorActionPreference = 'Stop'
$root = (Get-Location).Path
if (-not (Test-Path 'src\ui.js')) {
  throw 'Ejecutá el script desde la carpeta del proyecto (donde está src).'
}
if (-not (Test-Path 'server\steam\clients.js')) {
  Write-Warning 'Falta server/steam/clients.js: la primera parte no se aplicó. El cliente igual se escribe, pero revisá eso.'
}

function Write-File($relative, $content) {
  $full = Join-Path $root $relative
  [IO.File]::WriteAllText($full, $content, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "OK  $relative"
}

$content = @'
<!DOCTYPE html><html lang="es"><head><meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
    
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="theme-color" content="#0e0e15">
    <meta name="referrer" content="no-referrer">
    <title>AuraBoost Private Cloud</title>
    <link rel="icon" type="image/svg+xml" href="/icon.svg">
    <link rel="stylesheet" href="/style.css">
    <script defer="" src="/library.js"></script>
    <script defer="" src="/images.js"></script>
    <script defer="" src="/ui.js"></script>
  </head>
  <body>
    <a class="skip" href="#main">Ir al contenido</a>
    <div class="shell">
      <header class="titlebar">
        <div class="brandline">
          <img src="/icon.png" width="42" height="42" alt="">
          <div>
            <strong>Aura<span>Boost</span></strong>
            <small>Private Cloud · v0.2.0</small>
          </div>
        </div>
        <nav id="nav" aria-label="Secciones">
          <button type="button" data-page="library" aria-current="page">Biblioteca</button>
          <button type="button" data-page="profiles">Perfiles</button>
          <button type="button" data-page="stats">Actividad</button>
          <button type="button" data-page="settings">Ajustes</button>
        </nav>
        <button id="logout" class="logout" type="button">Cerrar sesión</button>
      </header>

      <main id="main" tabindex="-1">
        <section id="loading" class="gate" aria-live="polite">
          <div class="panel gate-card"><p>Comprobando la sesión…</p></div>
        </section>

        <section id="gate" class="gate" aria-labelledby="authTitle">
          <div class="panel gate-card">
            <div class="gate-heading">
              <img src="/icon.png" width="52" height="52" alt="">
              <h1 id="authTitle">Iniciar sesión</h1>
              <p id="authIntro">Accedé con tu cuenta autorizada de AuraBoost.</p>
            </div>
            <form id="loginForm">
              <label for="loginEmail">Correo electrónico</label>
              <input id="loginEmail" type="email" maxlength="254" autocomplete="username" required="">
              <label for="loginPassword">Contraseña de AuraBoost</label>
              <input id="loginPassword" type="password" maxlength="1024" autocomplete="current-password" required="">
              <button type="submit" class="primary full">Entrar</button>
              <button id="google" type="button" class="full">Continuar con Google</button>
              <button id="showRecovery" type="button" class="text-button full">Olvidé mi contraseña</button>
            </form>
            <form id="recoveryForm">
              <label for="recoveryEmail">Correo electrónico</label>
              <input id="recoveryEmail" type="email" maxlength="254" autocomplete="email" required="">
              <button type="submit" class="primary full">Enviar enlace de recuperación</button>
              <button type="button" class="text-button full" data-login="">Volver al inicio de sesión</button>
            </form>
            <form id="passwordForm">
              <label for="newPassword">Nueva contraseña de AuraBoost</label>
              <input id="newPassword" type="password" minlength="8" maxlength="1024" autocomplete="new-password" required="">
              <button type="submit" class="primary full">Guardar contraseña</button>
              <button id="cancelRecovery" type="button" class="text-button full">Cancelar recuperación</button>
            </form>
            <p id="authMessage" class="form-message" role="status"></p>
            <p id="mockCredentials" class="notice">Modo local con datos simulados. Correo <code>demo@auraboost.local</code> · Contraseña <code>AuraBoost-local-2026</code>.</p>
            <p class="gate-privacy"><a href="/privacidad">Privacidad</a></p>
          </div>
        </section>

        <section id="app" class="app" aria-labelledby="pageTitle">
          <div class="page-header">
            <div>
              <h1 id="pageTitle">Biblioteca</h1>
              <p id="subtitle">Organizá los juegos de tus cuentas de Steam.</p>
            </div>
            <div class="connection" aria-live="polite">
              <span id="dot" class="dot" aria-hidden="true"></span><span id="connection">Conectando con AuraBoost</span>
            </div>
          </div>

          <div class="workspace">
            <div class="center">
              <div class="metrics" aria-label="Resumen de la biblioteca">
                <article><i aria-hidden="true">◇</i><div><small>Juegos</small><strong id="count">0</strong></div></article>
                <article><i aria-hidden="true">◷</i><div><small>Horas registradas</small><strong id="hours">—</strong></div></article>
                <article><i aria-hidden="true">▣</i><div><small>Selección</small><strong id="selectedMetric">0</strong></div></article>
                <article><i aria-hidden="true">☆</i><div><small>Favoritos</small><strong id="favoriteMetric">0</strong></div></article>
              </div>

              <section class="panel content" id="library" aria-label="Biblioteca de juegos">
                <div class="toolbar library-toolbar">
                  <div class="tabs" role="group" aria-label="Filtrar biblioteca">
                    <button type="button" data-filter="all" aria-pressed="true">Todos (0)</button>
                    <button type="button" data-filter="selected" aria-pressed="false">Seleccionados (0)</button>
                    <button type="button" data-filter="favorites" aria-pressed="false">Favoritos (0)</button>
                  </div>
                  <div class="search-tools">
                    <div class="inputclear">
                      <input id="search" type="search" placeholder="Buscar juegos…" aria-label="Buscar juegos" maxlength="120">
                      <button id="clearSearch" type="button" title="Borrar búsqueda" aria-label="Borrar búsqueda">
                        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15"></path></svg>
                      </button>
                    </div>
                    <button id="scan" class="square-button" type="button" title="Sincronizar biblioteca" aria-label="Sincronizar biblioteca" disabled="" aria-busy="false">↻</button>
                    <select id="sort" aria-label="Ordenar biblioteca">
                      <option value="az">Nombre A–Z</option>
                      <option value="za">Nombre Z–A</option>
                      <option value="recent" data-game-field="recent" disabled="">Jugados recientemente</option>
                      <option value="most" data-game-field="minutes" disabled="">Más jugados</option>
                      <option value="least" data-game-field="minutes" disabled="">Menos jugados</option>
                      <option value="big" data-game-field="bytes" disabled="">Mayor tamaño</option>
                      <option value="small" data-game-field="bytes" disabled="">Menor tamaño</option>
                      <option value="new" data-game-field="release" disabled="">Lanzamientos nuevos</option>
                      <option value="old" data-game-field="release" disabled="">Lanzamientos antiguos</option>
                    </select>
                  </div>
                </div>
                <div id="games" class="game-list" role="region" aria-label="Lista de juegos" tabindex="0"><div class="empty"><div class="symbol" aria-hidden="true">◇</div><strong>Tu biblioteca, en un solo lugar</strong><p>Vinculá una cuenta de Steam para ver sus juegos.</p></div></div>
                <div class="foot">
                  <span id="selectedCount" aria-live="polite">0 seleccionados</span>
                  <button id="selectAll" type="button" disabled="">Seleccionar visibles</button>
                  <button id="clear" type="button" disabled="">Limpiar selección</button>
                </div>
              </section>

              <section class="panel content alternate" id="profiles" aria-labelledby="profilesTitle">
                <h2 id="profilesTitle">Selecciones guardadas</h2>
                <p>Guardá combinaciones de juegos de la cuenta elegida.</p>
                <form id="profileForm" class="toolbar">
                  <input id="profileName" placeholder="Nombre de la selección" aria-label="Nombre de la selección" maxlength="60" required="" disabled="">
                  <button class="primary" type="submit" disabled="">Guardar selección</button>
                </form>
                <div id="profileList"><p class="muted">Todavía no hay selecciones guardadas para esta cuenta.</p></div>
              </section>

              <section class="panel content alternate" id="stats" aria-labelledby="activityTitle">
                <h2 id="activityTitle">Historial de actividad</h2>
                <p id="sync">Sin sincronizar</p>
                <ol id="logs" class="logs"><li class="muted">Todavía no hay actividad registrada.</li></ol>
              </section>

              <section class="panel content alternate" id="settings" aria-labelledby="settingsTitle">
                <h2 id="settingsTitle">Ajustes y seguridad</h2>
                <p>El título, la descripción y el borrador se guardan por cuenta de Steam.</p>
                <p class="notice">La presencia mostrada proviene de Steam. Las horas, la presencia y los mensajes se gestionan en Steam.</p>
                <p class="steam-links">
                  <a href="/privacidad">Privacidad</a>
                  <a href="https://store.steampowered.com/subscriber_agreement/" target="_blank" rel="noopener noreferrer">Acuerdo de suscriptor de Steam</a>
                  <a href="https://steamcommunity.com/dev/apiterms" target="_blank" rel="noopener noreferrer">Condiciones de la API de Steam</a>
                </p>
                <p>Los datos de Steam se muestran tal como están disponibles. AuraBoost es independiente de Valve.</p>
              </section>
            </div>

            <aside id="accountPanel" class="panel right" aria-labelledby="accountTitle">
              <h2 id="accountTitle">Cuentas de Steam</h2>
              <div class="accounts">
                <select id="accountSelect" aria-label="Cambiar cuenta de Steam" disabled="" data-options="[[&quot;&quot;,&quot;Sin cuentas&quot;]]"><option value="">Sin cuentas</option></select>
                <button id="removeAccount" class="square-button" type="button" title="Desvincular cuenta" aria-label="Desvincular cuenta" disabled="">−</button>
              </div>
              <div class="account">
                <img id="avatar" src="/icon.png" width="48" height="48" alt="">
                <div>
                  <div class="account-name">
                    <strong id="profile">Sin cuenta vinculada</strong>
                    <span id="accountDot" class="dot" aria-hidden="true"></span>
                  </div>
                  <small id="accountState" title="">Presencia sin datos</small>
                </div>
              </div>
              <button id="linkSteam" class="steam-button" type="button" aria-label="Vincular cuenta con Steam" disabled="">
                <img id="steamButtonImage" alt="">
                <span id="steamButtonText">Vincular cuenta con Steam</span>
              </button>
              <p id="linkHint" class="muted steam-hint">Verificá tu identidad en Steam. Si Steam ofrece QR o te solicita Steam Guard, completá ese paso allí.</p>
              <div id="accountFields">
                <div id="sessionBlock" class="session" hidden>
                  <form id="sessionForm" class="toolbar">
                    <input id="steamUser" placeholder="Usuario de Steam" autocomplete="username" maxlength="64" required="">
                    <input id="steamPassword" type="password" placeholder="Contraseña" autocomplete="current-password" maxlength="128" required="">
                    <button class="primary" type="submit">Conectar sesión</button>
                  </form>
                  <form id="guardForm" class="toolbar" hidden>
                    <input id="steamGuard" placeholder="Código de Steam Guard" maxlength="10" required="">
                    <button class="primary" type="submit">Verificar</button>
                  </form>
                  <p id="sessionState" class="muted"></p>
                  <button id="unlinkSession" class="text-button" type="button" hidden>Desconectar sesión</button>
                </div>
                <hr>
                <form id="accountForm">
                  <label for="title">Título personalizado</label>
                  <div class="inputclear">
                    <input id="title" placeholder="Ej.: Mis juegos de estrategia" maxlength="64">
                    <button type="button" data-clear-field="title" title="Borrar título" aria-label="Borrar título">
                      <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 5h12M8 5V3h4v2M6 5l1 12h6l1-12M9 8v6M11 8v6"></path></svg>
                    </button>
                  </div>
                  <label for="description">Descripción local</label>
                  <div class="inputclear">
                    <input id="description" placeholder="Ej.: Juegos para el fin de semana" maxlength="500">
                    <button type="button" data-clear-field="description" title="Borrar descripción" aria-label="Borrar descripción">
                      <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 5h12M8 5V3h4v2M6 5l1 12h6l1-12M9 8v6M11 8v6"></path></svg>
                    </button>
                  </div>
                  <div class="reply-head">
                    <label for="reply">Borrador de respuesta</label>
                    <button class="icon-btn" type="button" data-clear-field="reply" title="Borrar borrador" aria-label="Borrar borrador">
                      <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 5h12M8 5V3h4v2M6 5l1 12h6l1-12M9 8v6M11 8v6"></path></svg>
                    </button>
                  </div>
                  <textarea id="reply" rows="3" maxlength="500"></textarea>
                  <label class="switch"><input id="autoSend" type="checkbox"> Envío automático</label>
                  <small class="muted">Guardado en AuraBoost.</small>
                  <button id="saveAccount" type="submit" class="primary full" disabled="">Guardar cambios</button>
                </form>
              </div>
              <p id="libraryStatus" class="notice"></p>
            </aside>
          </div>
        </section>
      </main>

      <footer class="signature">by <span>jav1zscript</span></footer>
    </div>

    <dialog id="removeDialog" class="panel" aria-labelledby="removeTitle">
      <form method="dialog">
        <h2 id="removeTitle">Desvincular cuenta</h2>
        <p id="removeMessage"></p>
        <div class="dialog-actions">
          <button value="cancel" autofocus="">Cancelar</button>
          <button value="remove" class="primary">Desvincular</button>
        </div>
      </form>
    </dialog>
    <p id="toast" role="status"></p>
    <noscript><p class="notice noscript">Activá JavaScript para usar AuraBoost Private Cloud.</p></noscript>
  

</body></html>
'@
Write-File 'src/index.html' $content

$content = @'
'use strict';

const $ = id => document.getElementById(id);
const buttons = selector => [...document.querySelectorAll(selector)];
const number = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 1 });
const date = new Intl.DateTimeFormat('es-AR', { dateStyle: 'medium', timeStyle: 'short' });
const year = new Intl.DateTimeFormat('es-AR', { year: 'numeric' });
const fields = ['title', 'description', 'reply'];
const emptyConfig = { selected: [], favorites: [], profiles: [], title: '', description: '', reply: '', autoSend: false };
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
let stream;
let connectionTimer;
let refreshTimer;
let toastTimer;
let authVersion = 0;
let refreshVersion = 0;
let selectionWrites = Promise.resolve();
let avatarKey;
let guardLogin;
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
  return currentData()?.account ?? dashboard.accounts?.find(account => account.id === selectedId);
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
  $('sessionForm').hidden = connected || waiting;
  $('guardForm').hidden = !waiting;
  $('unlinkSession').hidden = !connected;
  $('sessionState').textContent = connected
    ? 'Sesión de Steam conectada.'
    : waiting ? 'Steam pidió un código de Steam Guard.' : 'Conectá la sesión para iniciar juegos y contar horas.';
  $('autoSend').checked = config.autoSend === true;

  const draft = drafts.get(selectedId);
  for (const field of fields) {
    const next = draft?.[field] ?? config[field] ?? '';
    if ($(field).value !== next) $(field).value = next;
  }
  $('saveAccount').disabled = !draft || busy.has('save:' + selectedId);
  $('libraryStatus').textContent = accountStatuses[account?.libraryStatus] ?? '';
  $('libraryStatus').hidden = !$('libraryStatus').textContent;

  const signedIn = Boolean(session.authenticated);
  const visibleSteamImage = signedIn && !session.mock && !imageFailed;
  $('steamButtonImage').hidden = !visibleSteamImage;
  if (visibleSteamImage && !$('steamButtonImage').getAttribute('src')) $('steamButtonImage').src = steamSignIn;
  $('steamButtonText').hidden = visibleSteamImage;
  $('steamButtonText').textContent = session.mock ? 'Vincular cuenta simulada' : 'Vincular cuenta con Steam';
  $('linkSteam').setAttribute('aria-label', $('steamButtonText').textContent);
  $('linkSteam').disabled = !signedIn || busy.has('link');
  $('linkHint').textContent = session.mock
    ? 'Vinculación de ejemplo.'
    : 'Verificá tu identidad en Steam. Si Steam ofrece QR o te solicita Steam Guard, completá ese paso allí.';
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
  const ready = account?.sessionConnected === true;
  const button = element('button', 'play' + (playing ? ' on' : ''), playing ? 'Detener' : 'Iniciar');
  button.type = 'button';
  button.disabled = !ready || busy.has('play:' + game.id);
  button.title = ready ? '' : 'Conectá la sesión de Steam de esta cuenta';
  button.setAttribute('aria-label', (playing ? 'Detener ' : 'Iniciar ') + game.name);
  button.addEventListener('click', () => {
    const id = selectedId;
    if (!id) return;
    void accountAction('play:' + game.id, async () => {
      await request(accountPath(id) + (playing ? '/stop' : '/launch'), {
        method: 'POST', body: playing ? {} : { appid: game.id }
      });
      setToast(playing ? 'Juego detenido.' : 'Cuenta en juego. Steam está contando las horas.');
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

function renderHistory() {
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
  const changes = Object.fromEntries(fields.map(field => [field, $(field).value]));
  const config = configFor(selectedId);
  if (fields.some(field => changes[field] !== config[field])) drafts.set(selectedId, changes);
  else drafts.delete(selectedId);
  $('saveAccount').disabled = !drafts.has(selectedId) || busy.has('save:' + selectedId);
}

let imageFailed = false;
$('steamButtonImage').addEventListener('error', () => {
  imageFailed = true;
  renderAccount();
});

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

$('sessionForm').addEventListener('submit', event => {
  event.preventDefault();
  const id = selectedId;
  if (!id) return;
  void accountAction('session:' + id, async () => {
    const result = await request(accountPath(id) + '/session', {
      method: 'POST', body: { accountName: $('steamUser').value.trim(), password: $('steamPassword').value }
    });
    $('steamPassword').value = '';
    guardLogin = result.status === 'guard' ? { accountId: id, loginId: result.loginId } : undefined;
    setToast(result.status === 'guard' ? 'Ingresá el código de Steam Guard.' : 'Sesión de Steam conectada.');
    await refresh();
    if (result.status === 'guard') $('steamGuard').focus();
  });
});

$('guardForm').addEventListener('submit', event => {
  event.preventDefault();
  const id = selectedId;
  if (!id || !guardLogin) return;
  void accountAction('guard:' + id, async () => {
    const result = await request(accountPath(id) + '/session/guard', {
      method: 'POST', body: { loginId: guardLogin.loginId, code: $('steamGuard').value.trim() }
    });
    $('steamGuard').value = '';
    guardLogin = result.status === 'guard' ? { accountId: id, loginId: result.loginId } : undefined;
    if (result.status === 'connected') setToast('Sesión de Steam conectada.');
    await refresh();
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

$('autoSend').addEventListener('change', () => {
  void changeConfig({ autoSend: $('autoSend').checked });
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
'@
Write-File 'src/ui.js' $content

$content = @'
:root {
  color-scheme: dark;
  --base: #0e0e15;
  --surface: #171720;
  --input: #1a1b27;
  --edge: #2c293a;
  --muted: #a09caf;
  --accent: #b078fa;
  --light: #f2f0f8;
}

* { box-sizing: border-box; }
[hidden] { display: none !important; }

body {
  margin: 0;
  background: var(--base);
  color: var(--light);
  font: 14px 'Segoe UI', system-ui, sans-serif;
}

h1, h2, p { margin: 0; }
p { color: var(--muted); line-height: 1.6; }
a { color: #daaaff; }
small { display: block; font-size: 12px; color: var(--muted); }
button, input, select, textarea { font: inherit; color: inherit; }

button, input, select, textarea {
  border: 1px solid var(--edge);
  border-radius: 9px;
  background: var(--input);
}

button {
  min-height: 38px;
  padding: 8px 12px;
  cursor: pointer;
  transition: background .15s ease, border-color .15s ease, box-shadow .15s ease, color .15s ease;
}

button:not(:disabled):hover { background: #27243a; border-color: #7653a5; }
button:disabled { opacity: .48; cursor: not-allowed; }
button:focus-visible, a:focus-visible, input:focus-visible, select:focus-visible,
textarea:focus-visible, .game-list:focus-visible { outline: 2px solid #c493ff; outline-offset: 2px; }
input, select, textarea { min-width: 0; width: 100%; padding: 9px 10px; }
input::placeholder, textarea::placeholder { color: #a49db2; }
input[type="search"]::-webkit-search-cancel-button { appearance: none; }
input[type="checkbox"] { width: 18px; height: 18px; padding: 0; margin: 0 auto; accent-color: #a16af1; cursor: pointer; }
textarea { resize: vertical; min-height: 75px; line-height: 1.5; }
[aria-busy="true"] { cursor: progress; }

.primary {
  background: linear-gradient(110deg, #6c33b4, #8543cc);
  border-color: #a468e9;
  font-weight: 600;
  box-shadow: 0 0 12px #a259f02b;
}

button.primary:not(:disabled):hover { background: #7941c3; box-shadow: 0 0 18px #a259f050; }
.full { display: block; width: 100%; }
.muted { color: var(--muted); }

.skip {
  position: fixed;
  z-index: 4;
  inset: .5rem auto auto .5rem;
  background: var(--surface);
  padding: .7rem;
  transform: translateY(-150%);
}

.skip:focus { transform: translateY(0); }

.shell {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 100dvh;
  max-width: 1700px;
  margin-inline: auto;
  padding: 0 clamp(14px, 2.3vw, 32px) 10px;
}

.titlebar {
  display: flex;
  align-items: center;
  gap: 18px;
  min-height: 65px;
  flex: none;
  border-bottom: 1px solid #292735;
}

.brandline { display: flex; flex: none; align-items: center; gap: 8px; white-space: nowrap; }
.brandline img { filter: drop-shadow(0 0 9px #8b43d455); }
.brandline strong { display: block; font-size: 24px; letter-spacing: -.75px; line-height: 1.08; }
.brandline strong span { color: var(--accent); }
.brandline small { margin-top: 4px; font-size: 10px; letter-spacing: .45px; }
.titlebar nav { display: flex; gap: 4px; margin-inline-start: auto; }
.titlebar nav button { padding-inline: 14px; background: transparent; border-color: transparent; color: #c4c1d1; }

button[aria-current="page"],
button[aria-pressed="true"]:not(.star),
.titlebar nav button[aria-current="page"] {
  color: white;
  background: linear-gradient(105deg, #6231a4, #382251);
  border-color: #9563cf;
  box-shadow: 0 0 12px #a05cff19;
}

.logout { flex: none; white-space: nowrap; }
.titlebar .logout:only-of-type { margin-inline-start: auto; }
.titlebar nav:not([hidden]) + .logout { margin-inline-start: 0; }
main { display: flex; flex: 1 1 auto; flex-direction: column; min-width: 0; min-height: 0; }

.gate { flex: 1; display: grid; place-items: center; padding-block: 16px 24px; }
.gate-card { width: min(100%, 410px); padding: clamp(20px, 5vw, 34px); }
.gate-heading { text-align: center; margin-bottom: 20px; }
.gate-heading img { filter: drop-shadow(0 0 12px #8b43d477); }
.gate-heading h1 { font-size: clamp(23px, 5vw, 28px); margin: 8px 0 5px; letter-spacing: -.5px; }
.gate-card form { display: grid; gap: 8px; }
.gate-card form label:not(:first-child) { margin-top: 4px; }
.gate-card form button[type="submit"] { margin-top: 8px; }
.text-button { background: transparent; border-color: transparent; color: #d2aaff; }
.form-message { margin-top: 12px; color: #e4cafa; }
.form-message[data-error] { color: #ffc2d0; }
.gate-privacy { margin-top: 12px; text-align: center; font-size: 12px; }
.notice code { overflow-wrap: anywhere; }

.app, .center, .content { min-height: 0; }
.app { display: flex; flex: 1; flex-direction: column; gap: 14px; }
.page-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
.page-header h1 { font-size: 28px; margin-bottom: 3px; letter-spacing: -.8px; }
.connection { display: flex; flex: none; align-items: center; gap: 8px; padding: 10px 0; color: var(--muted); font-size: 12px; }
.dot { width: 9px; height: 9px; background: #646579; border-radius: 50%; flex: none; }
.dot.on { background: #43ef85; animation: online-pulse 1.8s ease-in-out infinite; }

@keyframes online-pulse {
  0%, 100% { opacity: .8; box-shadow: 0 0 5px #43ef85; }
  50% { opacity: 1; box-shadow: 0 0 12px #43ef85; }
}

.workspace { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 16px; flex: 1; min-height: 0; }
.center { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
.panel { min-width: 0; border: 1px solid var(--edge); border-radius: 13px; background: var(--surface); box-shadow: 0 6px 24px #0003; }
.metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 9px; }

.metrics article {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
  padding: 13px 11px;
  background: linear-gradient(140deg, #1f1b2a, #171720);
  border: 1px solid #352d45;
  border-radius: 12px;
  box-shadow: inset 0 1px 0 #b078fa12;
}

.metrics i { color: #ba85ff; font-size: 24px; font-style: normal; }
.metrics small { margin-bottom: 4px; font-size: 11px; }
.metrics strong { display: block; font-size: 22px; font-variant-numeric: tabular-nums; letter-spacing: -.65px; }
.content { flex: 1; padding: 15px; overflow: auto; }
.content h2, .right h2 { font-size: 17px; margin-bottom: 9px; }
.content.alternate > p { margin-bottom: 12px; }
.toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 12px; }
.toolbar input { flex: 1; min-width: 100px; }
.tabs { display: flex; gap: 5px; }
.tabs button, .foot button { font-size: 12px; }
.search-tools { display: flex; flex: 1; align-items: center; gap: 7px; min-width: 285px; }
.search-tools .inputclear { flex: 1; }
#sort { width: auto; max-width: 48%; min-height: 38px; font-size: 12px; }
.square-button { min-width: 38px; padding: 0 6px; font-size: 20px; }
#scan[aria-busy="true"] { animation: breathing .85s ease-in-out infinite alternate; }
@keyframes breathing { to { opacity: .6; } }
#library { display: flex; flex-direction: column; overflow: hidden; }
#library .toolbar, #library .foot { flex: none; }

.game-list {
  display: flex;
  flex: 1 1 0;
  flex-direction: column;
  min-height: 0;
  overflow: hidden auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  scrollbar-color: #50405f transparent;
}

.game-list:focus-visible { outline-offset: -2px; }

.game {
  display: grid;
  grid-template-columns: 25px minmax(80px, 148px) minmax(90px, 1fr) minmax(48px, max-content) auto 35px;
  align-items: center;
  flex: none;
  gap: 10px;
  min-width: 0;
  border-top: 1px solid #252633;
  padding: 10px 0;
}

.game:has(input:checked) { background: #21192c; border-top-color: #3d2a51; }
.game .name { font-weight: 600; min-width: 0; overflow-wrap: anywhere; }
.game .name small { margin-top: 4px; font-size: 11px; line-height: 1.4; }
.cover { display: grid; place-items: center; min-width: 0; aspect-ratio: 2.75; overflow: hidden; border-radius: 6px; background: #262336; }
.cover img { width: 100%; height: 100%; object-fit: cover; }

.cover-fallback {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  padding-inline: 4px;
  overflow: hidden;
  color: #cebfdd;
  text-align: center;
  font-size: 10px;
  line-height: 1.25;
}

.playtime { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; font-weight: 600; }
.play { padding: 0 10px; min-height: 30px; font-size: 12px; border-radius: 999px; white-space: nowrap; }
.play.on { border-color: #e05a5a; color: #ffb3b3; background: #2b1a22; }
button.play.on:not(:disabled):hover { background: #3a2029; border-color: #f07a7a; }
.star { padding-inline: 0; border-color: transparent; background: transparent; color: #ab9bb9; font-size: 23px; }
.star[aria-pressed="true"] { color: #c593ff; }
.empty { margin: auto 0; padding: 20px 12px; text-align: center; }
.empty strong { display: block; margin: 6px 0; font-size: 18px; }
.empty .symbol { font-size: 39px; color: #9d68e1; }
.empty button { margin-top: 12px; }

.foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 7px;
  border-top: 1px solid var(--edge);
  margin-top: 8px;
  padding-top: 8px;
  color: var(--muted);
  font-size: 12px;
}

.foot span { margin-inline-end: auto; }
.foot button { min-height: 34px; padding: 5px 7px; }
.logs { list-style: none; margin: 0; padding: 0; }
.log, .saved { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; border-bottom: 1px solid var(--edge); padding: 10px 0; }
.saved span { flex: 1 1 135px; overflow-wrap: anywhere; }
.log time { color: var(--muted); font-size: 12px; }
.log span { overflow-wrap: anywhere; }
.steam-links { display: flex; flex-wrap: wrap; gap: 8px 17px; }

.right { overflow: auto; padding: 13px 15px; scrollbar-width: thin; scrollbar-color: #50405f transparent; }
.accounts { display: grid; grid-template-columns: minmax(0, 1fr) 38px; gap: 6px; margin-bottom: 12px; }
.accounts select { font-size: 12px; }
.account { display: flex; align-items: center; gap: 11px; margin-bottom: 10px; }
.account img { border-radius: 10px; object-fit: cover; filter: drop-shadow(0 0 7px #aa65ef35); }
.account-name { display: flex; align-items: center; gap: 8px; }
.account strong { display: block; min-width: 0; overflow-wrap: anywhere; font-size: 15px; }
.account small { margin-top: 3px; }
.steam-button { display: flex; justify-content: center; align-items: center; gap: 8px; width: 100%; min-height: 43px; font-size: 12px; }
.steam-button img { display: block; width: 114px; max-width: 100%; height: auto; }
.steam-hint { margin: 5px 0 8px; font-size: 12px; }
.right hr { margin: 12px 0; border: 0; border-top: 1px solid var(--edge); }
.right label { display: block; margin-block: 10px 5px; font-size: 12px; font-weight: 500; }
.right textarea { display: block; }
.right small { margin-top: 5px; }
.right .full { margin-top: 11px; }
.session { display: grid; gap: 8px; margin-bottom: 4px; }
.session .toolbar { margin-bottom: 0; }
.session input { font-size: 12px; }
.session .primary { width: 100%; }
.session p { font-size: 12px; }
.switch { display: flex; align-items: center; gap: 8px; }
.switch input { flex: none; }
.inputclear { position: relative; display: flex; align-items: center; min-width: 0; }
.inputclear input { padding-inline-end: 38px; }
.inputclear button { position: absolute; inset-inline-end: 3px; }
.icon-btn, .inputclear button { display: grid; place-items: center; min-width: 31px; min-height: 31px; padding: 0; border: 0; background: transparent; color: #aaa1ba; }
.icon-btn:hover, .inputclear button:hover { color: #d9b5ff; }
.icon-btn svg, .inputclear svg { width: 16px; height: 16px; stroke: currentColor; fill: none; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
.reply-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-top: 8px; }
.reply-head label { margin: 0; }

.notice {
  margin-top: 10px;
  padding: 9px;
  border: 1px solid #352d48;
  border-radius: 9px;
  background: #1d192a;
  color: #c1b5d1;
  font-size: 12px;
}

.signature { flex: none; text-align: center; color: #aaa3ba; font-size: 12px; letter-spacing: .35px; line-height: 17px; }
.signature span { color: #ba89f7; font-weight: 600; }

dialog.panel { width: min(420px, calc(100% - 28px)); padding: 20px; border-color: #614286; color: var(--light); }
dialog::backdrop { background: #06060bbd; }
dialog h2 { font-size: 21px; margin-bottom: 10px; }
.dialog-actions { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 8px; margin-top: 16px; }

#toast {
  position: fixed;
  z-index: 3;
  inset: auto max(14px, env(safe-area-inset-right)) max(16px, env(safe-area-inset-bottom)) auto;
  max-width: min(410px, calc(100% - 28px));
  padding: 12px 15px;
  border: 1px solid var(--accent);
  border-radius: 10px;
  background: #302344;
  color: var(--light);
  box-shadow: 0 8px 35px #0008;
}

.noscript { margin: 12px; }

@media (min-width: 821px) {
  .shell { height: 100dvh; min-height: 610px; }
}

@media (max-width: 1100px) {
  .workspace { grid-template-columns: minmax(0, 1fr) 265px; }
  .metrics article { padding: 10px 8px; }
  .metrics i { display: none; }
  .game { grid-template-columns: 22px 88px minmax(70px, 1fr) minmax(43px, max-content) auto 31px; gap: 7px; }
}

@media (max-width: 820px) {
  .workspace { grid-template-columns: minmax(0, 1fr); }
  #library { height: clamp(385px, 61dvh, 680px); flex: none; }
  .content.alternate { min-height: 215px; }
  .right { overflow: visible; }
  .game { grid-template-columns: 22px minmax(68px, 110px) minmax(65px, 1fr) minmax(43px, max-content) auto 31px; }
}

@media (max-width: 550px) {
  .titlebar { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px 5px; padding-block: 9px; }
  .titlebar nav { grid-column: 1 / -1; grid-row: 2; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); margin: 0; }
  .titlebar nav button { padding-inline: 3px; font-size: 12px; }
  .titlebar .logout { grid-column: 2; grid-row: 1; font-size: 12px; }
  .page-header { flex-wrap: wrap; gap: 4px 10px; }
  .page-header h1 { font-size: 23px; }
  .connection { padding: 4px 0 2px; }
  .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; }
  .metrics i { display: block; }
  .metrics strong { font-size: 19px; }
  .content { padding: 10px; }
  .tabs { width: 100%; }
  .tabs button { flex: 1; }
  .search-tools { min-width: 0; }
  .search-tools input { min-width: 0; }
  #sort { max-width: 45%; padding-inline: 4px; }
  .game { grid-template-columns: 18px 61px minmax(55px, 1fr) minmax(35px, max-content) auto 29px; gap: 4px; }
  .game .name { font-size: 13px; }
  .game .name small { font-size: 10px; }
  .cover-fallback { font-size: 8px; }
  .playtime { font-size: 11px; }
  .play { padding-inline: 7px; font-size: 11px; }
  .foot button { font-size: 11px; padding-inline: 6px; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; animation: none !important; transition: none !important; }
  .dot.on { box-shadow: 0 0 7px #43ef85; }
}
'@
Write-File 'src/style.css' $content

Write-Host ''
Write-Host 'Listo. Ahora corré:  npm run check'
Read-Host 'Enter para cerrar'