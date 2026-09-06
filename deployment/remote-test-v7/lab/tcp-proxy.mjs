import net from 'node:net';

function readPort(name) {
  const value = Number.parseInt(process.env[name] || '', 10);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${name} must be a valid TCP port`);
  }
  return value;
}

const listenHost = process.env.LISTEN_HOST || '0.0.0.0';
const listenPort = readPort('LISTEN_PORT');
const targetHost = process.env.TARGET_HOST || 'titra';
const targetPort = readPort('TARGET_PORT');

const server = net.createServer((client) => {
  const upstream = net.createConnection({ host: targetHost, port: targetPort });

  const closeBoth = () => {
    client.destroy();
    upstream.destroy();
  };

  client.on('error', closeBoth);
  upstream.on('error', closeBoth);
  client.pipe(upstream);
  upstream.pipe(client);
});

server.on('error', (error) => {
  console.error(`Ingress proxy failed: ${error.message}`);
  process.exitCode = 1;
});

server.listen(listenPort, listenHost, () => {
  console.log(`Lab ingress listening on ${listenHost}:${listenPort}`);
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
