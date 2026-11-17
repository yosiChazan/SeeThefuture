import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The system's version, shown at the top of the screen (SPEC decision 156): the number of the
// last pull request merged into this build ("Merge pull request #124 …" or "… (#124)"), its
// commit and the build date. Cloudflare Pages builds from a clone of the repository; when git
// is not there, the commit comes from Cloudflare's own variable.
function version() {
  const git = (cmd: string) => { try { return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return ''; } };
  const subjects = git('git log -50 --format=%s').split('\n');
  const pr = subjects.map((s) => /Merge pull request #(\d+)/.exec(s)?.[1] ?? /\(#(\d+)\)\s*$/.exec(s)?.[1]).find(Boolean) ?? null;
  const sha = (git('git rev-parse --short HEAD') || process.env.CF_PAGES_COMMIT_SHA?.slice(0, 7)) ?? null;
  return { pr, sha: sha || null, built: new Date().toISOString() };
}

export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(version()) },
});
