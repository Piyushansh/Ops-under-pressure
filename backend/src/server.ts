import { createApp } from './app';
import { config } from './config';
import { pool } from './db';

const server = createApp().listen(config.PORT, () => {
  console.log(`API listening on http://localhost:${config.PORT}`);
});

const shutdown = () => {
  server.close(() => pool.end().finally(() => process.exit(0)));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
