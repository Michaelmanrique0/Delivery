const app = require('./app');

const PORT = Number(process.env.PORT || 3847);

const server = app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Delivery app: http://localhost:${PORT}`);
});

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    // eslint-disable-next-line no-console
    console.error(
      `\nEl puerto ${PORT} ya está en uso (otra terminal con "npm start" o el agente de Cursor con el servidor levantado).\n` +
        'Cierra esa instancia o usa otro puerto:\n' +
        '  CMD:        set PORT=3848&& npm start\n' +
        '  PowerShell: $env:PORT=3848; npm start\n'
    );
    process.exit(1);
  }
  throw err;
});
