/**
 * Where everything lives. Inside the deployer image the package is at /opt/kawa; on a developer
 * machine it is the repository root. Every path can be overridden for tests.
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

export const DEPLOYER_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const ROOT = process.env.KAWA_ROOT || path.dirname(DEPLOYER_DIR);
export const EDGE_DIR = process.env.KAWA_EDGE_DIR || path.join(ROOT, 'edge');
export const CONFIG_FILE = process.env.KAWA_CONFIG || path.join(ROOT, 'config', 'kawa-edge.json');
export const STATE_DIR = process.env.KAWA_STATE || path.join(ROOT, 'state');
export const SECRETS_DIR = process.env.KAWA_SECRETS || path.join(ROOT, 'secrets');
/** tmpfs in the container (mode 0700). Temporary secret files live here for seconds, then are shredded. */
export const RUNTIME_DIR = process.env.KAWA_RUNTIME || path.join(os.tmpdir(), 'kawa-runtime');
/** Generated wrangler configs. They never contain a secret value. */
export const BUILD_DIR = process.env.KAWA_BUILD || path.join(os.tmpdir(), 'kawa-build');
// D-10 · run the pinned wrangler's JS entry with THIS node binary; never resolve `node` through PATH.
export const WRANGLER_JS = path.join(EDGE_DIR, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
