import { Pool } from "pg";

import { loadConfig } from "../../../packages/config/src/index.js";
import { PostgresRepository } from "../../../packages/storage/src/postgres.js";
import { createControlApp } from "./server.js";

const config = loadConfig();
const pool = new Pool({ connectionString: config.databaseUrl, max: 4 });
const app = createControlApp(new PostgresRepository(pool), config.walletPublicKey, config.controlToken);
const server = app.listen(config.controlPort, config.controlHost, () => {
  console.log(`control service listening on ${config.controlHost}:${config.controlPort}`);
});
process.on("SIGTERM", () => server.close(() => void pool.end()));
