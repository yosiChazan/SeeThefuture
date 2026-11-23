import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The system's version, shown at the top of the screen (SPEC decisions 156, 185): the highest
// pull request number merged into this build ("Merge pull request #124 …" or "… (#124)"); when
// older pull requests were merged after it, ".n" counts them (157, then 157.1, 157.2 …). With the
// commit and the build date. Cloudflare Pages builds from a clone of the repository; when git
// is not there, the commit comes from Cloudflare's own variable.
function version() {
  const git = (cmd: string) => { try { return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return ''; } };
  // Newest first: the pull request each merge brought in.
  const prs = git('git log -500 --format=%s').split('\n')
    .map((s) => Number(/Merge pull request #(\d+)/.exec(s)?.[1] ?? /\(#(\d+)\)\s*$/.exec(s)?.[1] ?? NaN))
    .filter((n) => Number.isFinite(n));
  let pr: string | null = null;
  if (prs.length) {
    const top = Math.max(...prs);
    const after = prs.indexOf(top);   // merges newer than the highest one
    pr = after ? `${top}.${after}` : String(top);
  }
  const sha = (git('git rev-parse --short HEAD') || process.env.CF_PAGES_COMMIT_SHA?.slice(0, 7)) ?? null;
  return { pr, sha: sha || null, built: new Date().toISOString() };
}

export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(version()) },
});
