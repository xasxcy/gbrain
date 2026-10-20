import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../sync-full-source-exclude-paths.test.ts'));
