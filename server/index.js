const app = require('./app');

const PORT = Number(process.env.PORT || 3847);

function mailDeliveryConfigured() {
  const from = String(process.env.MAIL_FROM || '').trim();
  if (!from) return false;
  const resend = String(process.env.RESEND_API_KEY || '').trim();
  const smtp = String(process.env.SMTP_HOST || '').trim();
  return !!(resend || smtp);
}

const server = app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Delivery app: http://localhost:${PORT}`);
  if (!mailDeliveryConfigured()) {
    // eslint-disable-next-line no-console
    console.warn(
      '[delivery] Correo no configurado: define MAIL_FROM y (RESEND_API_KEY o SMTP_HOST) en .env. ' +
        'Sin eso, recuperar contraseña y confirmar correo no enviarán mensajes.'
    );
  }
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
