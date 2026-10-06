import 'dotenv/config';
import { getStore } from '@/server/store';

/** Creates the snapshots table when running against Postgres. */
async function main() {
  const store = getStore();
  await store.init();
  console.log('database schema ready');
  await store.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
