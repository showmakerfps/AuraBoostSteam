'use strict';

function privacyPage(config) {
  const countries = (config.steamDataCountries || '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
  const storage = config.mock
    ? 'La demostración guarda perfiles y bibliotecas simulados en esta computadora.'
    : `AuraBoost guarda en Supabase el identificador y nombre de Steam, la URL del avatar, la última presencia consultada, la biblioteca y las horas o fechas informadas por Valve. Países de almacenamiento de esos datos: <strong>${countries}</strong>.`;
  return `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Privacidad · AuraBoost Private Cloud</title>
    <link rel="icon" type="image/svg+xml" href="/icon.svg">
    <link rel="stylesheet" href="/style.css">
  </head>
  <body>
    <div class="shell">
      <main class="gate">
        <article class="panel gate-card">
          <a href="/">Volver a AuraBoost</a>
          <h1>Privacidad</h1>
          <p>AuraBoost Private Cloud es un proyecto independiente de Valve y Steam. AuraBoost consulta los datos de Steam que solicitás cuando vinculás o sincronizás una cuenta.</p>
          <p>${storage}</p>
          <p>La aplicación también guarda tus preferencias e historial. Podés quitar una cuenta vinculada para borrar su perfil, biblioteca, preferencias e historial de AuraBoost. Las portadas y los avatares se cargan desde servidores de Steam.</p>
          <p>Steam recibe tus credenciales y verificaciones en su propia página. Supabase autentica el acceso a AuraBoost. Sus tokens se cifran en el servidor y el navegador recibe una cookie de sesión.</p>
          <p>Los datos de Steam se ofrecen tal como están y según disponibilidad. Valve y sus proveedores no garantizan su precisión, disponibilidad o idoneidad y excluyen su responsabilidad en la medida permitida por la ley.</p>
          <p><a href="https://steamcommunity.com/dev/apiterms" rel="noopener noreferrer">Condiciones de Steam Web API</a></p>
        </article>
      </main>
      <footer class="signature">by <span>jav1zscript</span></footer>
    </div>
  </body>
</html>`;
}

module.exports = { privacyPage };
