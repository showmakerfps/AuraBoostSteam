'use strict';

const { loadConfig } = require('./config');
const { createApp } = require('./app');

try {
  const config = loadConfig();
  const { app, closeEvents, restoreSessions } = createApp(config);
  const server = app.listen(config.port, config.host, () => {
    console.log(`AuraBoost Private Cloud v0.2.0 Â· ${config.appOrigin}${config.mock ? ' Â· demostraciÃ³n local' : ''}`);
    void restoreSessions();
  });
  server.on('error', () => {
    console.error('No se pudo iniciar el servidor. RevisÃ¡ que el puerto estÃ© disponible.');
    process.exitCode = 1;
  });
  const shutdown = () => {
    closeEvents();
    server.close();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}