// Spawns (or reuses) a real `uvicorn main:app` process so JS regression tests
// can drive app.js against genuine, correctly-shaped /api/catalog and
// /api/simulate responses instead of hand-authored fixtures that risk
// drifting from engine.py's real output shape.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.join(__dirname, '..', '..');

async function waitForHealthy(baseUrl, { timeoutMs = 20000, intervalMs = 150 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${baseUrl}/healthz`);
      if (r.ok) return;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`server at ${baseUrl} did not become healthy within ${timeoutMs}ms: ${lastErr}`);
}

async function startLiveServer({ port, pythonBin }) {
  const proc = spawn(
    pythonBin,
    ['-m', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', String(port), '--log-level', 'warning'],
    { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d.toString(); });
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForHealthy(baseUrl);
  } catch (e) {
    proc.kill();
    throw new Error(`${e.message}\n--- uvicorn stderr ---\n${stderr}`);
  }
  return {
    baseUrl,
    stop: () => new Promise((resolve) => {
      proc.once('exit', resolve);
      proc.kill();
    }),
  };
}

/**
 * If BASE_URL is set in the environment (the pytest wrapper already started
 * a shared server), reuse it. Otherwise spawn a dedicated uvicorn process on
 * `port` so this test file also works standalone via `node --test`.
 */
export async function ensureLiveServer({ port, pythonBin = process.env.PYTHON_BIN || 'python3' } = {}) {
  if (process.env.BASE_URL) {
    return { baseUrl: process.env.BASE_URL, stop: async () => {} };
  }
  return startLiveServer({ port, pythonBin });
}
