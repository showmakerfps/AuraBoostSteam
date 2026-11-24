# AuraBoost Private Cloud v0.2.0

Panel privado de Steam para una sola persona, accesible desde el navegador. Un único servicio Node.js en Railway sirve la interfaz, la API y los eventos en tiempo real. Supabase autentica al propietario y conserva sus configuraciones. El despliegue se hace desde esta carpeta con Railway CLI, sin conectar GitHub.

## Inicio local con datos simulados

1. Instalá Node.js 24 LTS. El proyecto admite Node.js 22.14 o superior.
2. En Windows, ejecutá `Iniciar-local.bat`. El script crea `.env` desde `.env.example` si hace falta, instala las dependencias en la carpeta e inicia el servidor. En Linux o macOS, copiá `.env.example` a `.env` si todavía no existe y ejecutá `npm ci` seguido de `npm start`.
3. Abrí <http://localhost:3000> e ingresá con `demo@auraboost.local` y `AuraBoost-local-2026`. Desde el panel podés vincular una cuenta de prueba para explorar la biblioteca. Si cambiás el puerto, ajustá `PORT` y `APP_ORIGIN` juntos y usá esa misma dirección en el navegador.

Con `DEMO_MODE=true`, podés probar el flujo de Google, la recuperación y la vinculación de distintas cuentas Steam con datos simulados. La recuperación presenta un enlace local. La contraseña de prueba recupera su valor inicial al reiniciar el proceso y los ajustes de la demostración se conservan en `.auraboost-demo/`. La demostración queda limitada a la computadora donde se ejecuta.

## Variables de entorno

Para la demostración alcanza la configuración de `.env.example`. Para probar Supabase desde tu computadora, configurá `.env` con `DEMO_MODE=false`, el origen local y las credenciales reales. Para producción, cargá las variables directamente en **Railway → servicio → Variables**.

| Variable | Valor |
| --- | --- |
| `DEMO_MODE` | `true` para la demostración local. `false` para usar Supabase y en Railway. |
| `NODE_ENV` | `production` en Railway. Dejala sin definir para el arranque local habitual. |
| `PORT` | `3000` en el ejemplo local. En Railway lo asigna la plataforma. |
| `APP_ORIGIN` | `http://localhost:3000` en local o el dominio público exacto con `https://` en Railway, sin ruta. |
| `SUPABASE_URL` | URL HTTPS del proyecto, como `https://<referencia>.supabase.co`. |
| `SUPABASE_PUBLISHABLE_KEY` | Clave publicable `sb_publishable_…` del mismo proyecto. Se usa para autenticar y consultar datos con el permiso del propietario. |
| `SUPABASE_SECRET_KEY` | Clave `sb_secret_…` para la persistencia cifrada de las sesiones. Obligatoria en Railway. Si se omite en modo real local, las sesiones de AuraBoost duran hasta que se reinicia el proceso. |
| `ALLOWED_USER_ID` | UUID exacto del propietario. Debe coincidir con el que se registra en el SQL de Supabase. |
| `SESSION_ENCRYPTION_KEY` | Clave de 32 bytes en Base64 para AES-256-GCM. Obligatoria fuera de la demostración. Guardala de forma segura y conservá el mismo valor al actualizar. Cambiarla obliga a iniciar sesión otra vez. |
| `STEAM_WEB_API_KEY` | Clave personal de Valve, opcional. Habilita perfil, avatar, presencia visible y biblioteca para las cuentas vinculadas, según su privacidad. |
| `STEAM_DATA_COUNTRIES` | País o países donde el proyecto Supabase almacena tus datos de Steam, separados por coma. Obligatoria con `DEMO_MODE=false`. Usá los nombres que correspondan a la residencia real de los datos en Supabase. |

Generá la clave de cifrado en tu terminal y guardá el resultado en el entorno del servidor. Usá valores diferentes para producción y las pruebas locales. La clave secreta de Supabase, la clave de Steam y la clave de cifrado deben quedar en el servidor. [Tipos de claves de Supabase](https://supabase.com/docs/guides/getting-started/api-keys) · [Claves de usuario de Steam Web API](https://partner.steamgames.com/doc/webapi_overview/auth)

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

## Preparar Supabase

1. Creá un proyecto y copiá su URL y sus claves **Publishable** y **Secret** desde **Project Settings → API Keys**. El modo local simulado puede usarse mientras preparás esta configuración. [Claves del proyecto](https://supabase.com/docs/guides/getting-started/api-keys)
2. En **Authentication → Sign In / Providers**, mantené activo el proveedor **Email**. Apagá **Allow new users to sign up** y **Allow anonymous sign-ins**. En **Authentication → Users**, elegí **Add user → Create new user**. Usá el correo verificado con el que entrarás por Google, elegí una contraseña para AuraBoost y confirmá ese usuario al crearlo. Copiá su UUID. Otro correo, aunque tenga acceso al mismo proyecto Supabase, queda fuera del panel. [Configuración de Auth](https://supabase.com/docs/guides/auth/general-configuration) · [Vinculación de identidades](https://supabase.com/docs/guides/auth/auth-identity-linking)
3. En **SQL Editor**, ejecutá el contenido completo de [`supabase/schema.sql`](supabase/schema.sql). En una consulta separada, sustituí `UUID_REAL` por el UUID anterior y ejecutá la siguiente sentencia una sola vez. Esto registra al único propietario que permiten las políticas de acceso a filas. Cargá el mismo UUID en `ALLOWED_USER_ID`. [Seguridad a nivel de fila en Supabase](https://supabase.com/docs/guides/database/postgres/row-level-security)

   ```sql
   insert into auraboost_private.owner (user_id) values ('UUID_REAL');
   ```

4. En **Authentication → URL Configuration**, poné el `APP_ORIGIN` de producción como **Site URL**. Agregá a **Redirect URLs** las dos direcciones completas para cada origen que uses. Por ejemplo, para `https://auraboost-privado.up.railway.app`, agregá `https://auraboost-privado.up.railway.app/api/auth/callback` y `https://auraboost-privado.up.railway.app/api/auth/recovery/callback`. Para pruebas reales locales, agregá las mismas rutas bajo `http://localhost:3000`. Usá coincidencias exactas. [Redirecciones de Supabase Auth](https://supabase.com/docs/guides/auth/redirect-urls)
5. En Google Cloud, configurá la pantalla de consentimiento OAuth y creá un **OAuth Client ID** de tipo **Web application**. Si la audiencia es externa y está en **Testing**, agregá como usuario de prueba el correo del propietario. En **Authorized JavaScript origins**, agregá el origen de AuraBoost. En **Authorized redirect URIs**, copiá la **Callback URL** que muestra **Supabase → Authentication → Sign In / Providers → Google**, habitualmente `https://<referencia>.supabase.co/auth/v1/callback`. En esa pantalla de Supabase habilitá Google y pegá el Client ID y el Client Secret. Esos dos valores se configuran en Supabase. [Configurar Google para Supabase](https://supabase.com/docs/guides/auth/social-sign-in/auth-google)
6. En **Authentication → Email Templates → Reset Password**, conservá el enlace `{{ .ConfirmationURL }}` de la plantilla estándar. Iniciá la recuperación en AuraBoost y abrí el enlace en el mismo navegador y perfil donde lo solicitaste. La confirmación estándar de Supabase redirige a la aplicación para completar el intercambio PKCE. El correo integrado de Supabase sólo entrega a direcciones del equipo del proyecto y está sujeto a límites de prueba. Si el correo autorizado es otro, configurá un SMTP propio en **Authentication → Emails → SMTP Settings** y deshabilitá el seguimiento de clics del proveedor que reescriba enlaces. [Recuperación de Supabase Auth](https://supabase.com/docs/guides/auth/passwords#resetting-a-password) · [SMTP personalizado](https://supabase.com/docs/guides/auth/auth-smtp)

## Publicar y actualizar en Railway

1. En el proyecto Railway, creá un **Empty Service** en el entorno de producción. En **Settings → Networking → Public Networking**, elegí **Generate Domain**. Usá ese dominio HTTPS en Supabase y Railway. La dirección será accesible desde Internet. El acceso a la biblioteca, los ajustes y el historial requiere iniciar sesión con el UUID autorizado. [Cargar un servicio desde un directorio local](https://docs.railway.com/services#deploying-from-a-local-directory) · [Dominios de Railway](https://docs.railway.com/networking/domains/working-with-domains)
2. En **Settings**, conservá **Railpack** como compilador. En **Deploy** configurá **Start Command** en `npm start`, **Healthcheck Path** en `/health`, **Healthcheck Timeout** en `60` segundos y **Restart Policy** en **On Failure** con `10` reintentos si el panel ofrece ese campo. Mantené **Serverless** desactivado para que el servicio siga disponible con tu PC apagada. En **Scale**, dejá una réplica. La persistencia vive en Supabase, sin volumen Railway. [Healthchecks de Railway](https://docs.railway.com/deployments/healthchecks) · [Réplicas y regiones](https://docs.railway.com/platform/advanced-concepts) · [Serverless](https://docs.railway.com/deployments/serverless)

   `railway.json` queda como referencia de los valores de compilación y despliegue. Configuralos en el panel para un servicio nuevo. Railway retira la configuración heredada `railway.json` y `railway.toml` de los servicios existentes el 1 de diciembre de 2026. [Config as Code de Railway](https://docs.railway.com/config-as-code)

3. En **Variables**, cargá los valores de producción de la tabla y aplicá los cambios pendientes del servicio. Mantené las variables secretas en Railway. `PORT` se asigna automáticamente y el servidor escucha en ese puerto. [Variables de servicio](https://docs.railway.com/variables)
4. Desde la carpeta del proyecto, instalá la CLI con `npm install -g @railway/cli` si todavía no la tenés, ejecutá `railway login` y corré `Publicar-web.bat`. En el asistente de `railway link`, elegí el proyecto, entorno y servicio vacío creados arriba. El script sube esta carpeta mediante `railway up . --path-as-root`. En Linux/macOS, ejecutá `railway link` y `railway up . --path-as-root` desde esta misma carpeta. [Instalar Railway CLI](https://docs.railway.com/cli) · [Vincular](https://docs.railway.com/cli/link) · [Publicar](https://docs.railway.com/cli/up)
5. Para una actualización de código, ejecutá `Actualizar-web.bat` o `railway up . --path-as-root` desde la carpeta ya vinculada. Comprobá que el dominio HTTPS abra desde otro dispositivo y que `/health` responda `200` con `{"status":"ok"}`. Esa ruta verifica que el proceso Node esté respondiendo. Probá el acceso al panel para comprobar la conexión con Supabase. Revisá **Deployments** en Railway si falla el arranque. [Despliegues por CLI](https://docs.railway.com/cli/deploying)

## Funciones de Steam y límites

- **Cuentas** permite vincular, cambiar y desvincular varias cuentas Steam. La vinculación abre el formulario oficial de Valve por OpenID. El QR y Steam Guard se completan en el sitio de Steam cuando aparecen. Para vincular una segunda cuenta, elegí esa cuenta en el sitio de Valve o salí de la primera allí antes de iniciar el flujo otra vez. AuraBoost conserva el SteamID vinculado y puede volver a consultar sus datos tras reiniciar el servidor. [Steam OpenID](https://steamcommunity.com/dev) · [Steam Guard y QR](https://store.steampowered.com/mobile/)
- **Biblioteca** consulta la Web API al vincular una cuenta y cuando presionás **Sincronizar biblioteca**. Podés buscar por nombre o ID, seleccionar varios juegos, guardar selecciones y marcar favoritos. El panel muestra las portadas alternativas y el avatar cuando están disponibles. El punto verde representa el último estado visible de esa cuenta, obtenido al sincronizar. Las horas y la fecha del último juego se usan únicamente cuando Steam devuelve los datos. Los filtros de tamaño y lanzamiento aparecen sólo si el conjunto contiene esos datos. El modo real de esta versión carece de una fuente verificada para ambos campos. [GetOwnedGames](https://partner.steamgames.com/doc/webapi/IPlayerService#GetOwnedGames) · [GetPlayerSummaries](https://partner.steamgames.com/doc/webapi/ISteamUser#GetPlayerSummaries)
- **Actividad** muestra las vinculaciones y sincronizaciones registradas por AuraBoost. Los títulos personalizados, las descripciones y los borradores de respuesta se guardan como ajustes de la cuenta seleccionada y sólo se usan dentro de AuraBoost. Sus iconos de borrado limpian el campo y **Guardar cambios** persiste la edición.
- **Automatizaciones** quedan desactivadas. El motor web sólo consulta información visible de Steam. La simulación de juego u horas, el cambio artificial de presencia, los mensajes automáticos y la reconexión de un cliente Steam quedan fuera del motor web. [Acuerdo de Suscriptor de Steam, sección 4](https://store.steampowered.com/subscriber_agreement/#4)

## Seguridad y privacidad

El navegador recibe un identificador aleatorio de sesión mediante una cookie `HttpOnly` y `SameSite=Lax`, con `Secure` en producción. El servidor conserva los tokens de Supabase cifrados con AES-256-GCM y verifica el propietario en las rutas privadas y en la conexión SSE. Las solicitudes que cambian datos exigen token CSRF y origen válido. Hay límites de solicitudes para autenticación, vinculación y sincronización. Supabase aplica políticas RLS a cuentas, preferencias e historial. La autenticación de Steam ocurre en Valve, que recibe las credenciales y Steam Guard. OpenID devuelve una prueba de identidad y el SteamID.

La base Supabase conserva el UUID de AuraBoost, los SteamID vinculados, las últimas respuestas de perfil y biblioteca, los ajustes por cuenta, el historial y las sesiones cifradas. La interfaz carga imágenes desde los CDN de Valve. **Desvincular cuenta** elimina su biblioteca, sus ajustes y su historial de AuraBoost. La página pública `/privacidad` identifica las categorías de datos y muestra los países configurados en `STEAM_DATA_COUNTRIES`. Verificá ese valor con la residencia del proyecto Supabase antes de desplegar. Los datos de Steam se ofrecen tal como los devuelve Valve. AuraBoost es un proyecto independiente sin afiliación ni respaldo de Valve. [Condiciones de Steam Web API](https://steamcommunity.com/dev/apiterms) · [Regiones de Supabase](https://supabase.com/docs/guides/platform/regions)

## Verificación local y pendiente

Ejecutá `npm run check` y `npm test` desde la carpeta del proyecto. La suite usa datos simulados. Incluye filtros, rutas de portadas, vinculación Steam OpenID simulada, persistencia y controles de acceso. Para comprobar el servidor en ejecución, `/health` debe responder `200` y `/api/state` y `/api/events` deben responder `401` cuando consultás sin iniciar sesión.

Después de que configures tus servicios, queda comprobar extremo a extremo el inicio real por correo y Google con el mismo UUID, el envío y uso del enlace de recuperación, la validación de permisos en tu proyecto Supabase, la vinculación Steam con QR o Steam Guard cuando Valve los ofrezca, los datos visibles para cada cuenta y el arranque de Railway con persistencia tras reiniciar. El proyecto se entregó sin publicar y sin activar sesiones reales.

## Cambios respecto a la aplicación de escritorio

La web reutiliza el logo, las reglas de búsqueda y orden, y las rutas alternativas de imágenes. La API de Express y SSE reemplazan el puente IPC. `legacy-electron/` conserva el proceso principal, el puente y los scripts anteriores como referencia. En la web se vinculan las cuentas de nuevo y se recrean los ajustes que quieras conservar. Los archivos del perfil de Electron y los tamaños de juegos instalados en tu PC quedan en el equipo original.

by jav1zscript
