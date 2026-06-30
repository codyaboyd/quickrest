import { copyFile, access } from 'node:fs/promises';
import net from 'node:net';

const defaultDatabaseHost = '127.0.0.1';
const defaultRedisHost = '127.0.0.1';
const defaultDatabasePort = 5432;
const defaultRedisPort = 6379;

async function fileExists(path) {
  return access(path).then(() => true, () => false);
}

async function run(command, args, options = {}) {
  console.log(`$ ${[command, ...args].join(' ')}`);
  let proc;
  try {
    proc = Bun.spawn([command, ...args], {
      stdout: 'inherit',
      stderr: 'inherit',
      stdin: options.stdin ?? 'inherit',
      env: process.env
    });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`${command} was not found in PATH. Install ${command} and try again.`);
    }
    throw error;
  }
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with code ${exitCode}`);
  }
}

function waitForPort(host, port, label, timeoutMs = 60_000) {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.createConnection({ host, port });

      socket.once('connect', () => {
        socket.end();
        console.log(`${label} is reachable at ${host}:${port}`);
        resolve();
      });

      socket.once('error', () => {
        socket.destroy();
        if (Date.now() - startedAt > timeoutMs) {
          reject(new Error(`${label} did not become reachable at ${host}:${port} within ${timeoutMs / 1000}s`));
          return;
        }
        setTimeout(attempt, 1_000);
      });
    };

    attempt();
  });
}

async function ensureLocalEnv() {
  if (await fileExists('.env')) return;
  if (!(await fileExists('.env.example'))) return;

  await copyFile('.env.example', '.env');
  console.log('Created .env from .env.example. Review secrets before using this outside local development.');
}

async function main() {
  await ensureLocalEnv();
  await run('docker', ['compose', 'up', '-d', 'postgres', 'redis']);
  await Promise.all([
    waitForPort(defaultDatabaseHost, defaultDatabasePort, 'PostgreSQL'),
    waitForPort(defaultRedisHost, defaultRedisPort, 'Redis')
  ]);
  await run('bun', ['run', 'db:migrate']);

  console.log('Starting QuickRest. Press Ctrl+C to stop the Bun process.');
  await run('bun', ['src/server.js']);
}

main().catch((error) => {
  console.error(`Startup failed: ${error.message}`);
  process.exit(1);
});
