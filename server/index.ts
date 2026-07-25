import express from 'express';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { loadConfig, projectRoot } from './config.ts';
import { router } from './routes.ts';

const cfg = loadConfig();
const app = express();

app.use(express.json({ limit: '1mb' }));
app.use('/api', router);

// In production the built client is served from the same origin.
const clientDir = path.join(projectRoot, 'dist', 'web');
if (process.argv.includes('--prod') && existsSync(clientDir)) {
  app.use(express.static(clientDir));
  app.get(/^(?!\/api).*/, (_req, res) => {
    res.sendFile(path.join(clientDir, 'index.html'));
  });
}

// 127.0.0.1 only: this app can move branches, so it must never be reachable
// from another machine on the network.
const server = app.listen(cfg.port, '127.0.0.1', () => {
  console.log(`git-cherry-picker api on http://127.0.0.1:${cfg.port}`);
  console.log(`scanning for repos under ${cfg.scanRoot}`);
  if (process.argv.includes('--prod')) {
    console.log(`open http://127.0.0.1:${cfg.port}`);
  }
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
