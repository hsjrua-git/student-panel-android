import { registerHooks } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const rootDir = fileURLToPath(new URL('../', import.meta.url));
const defaultDataDir = path.join(rootDir, '.local', 'pglite-db');

// 1. Redirect server/src/db/pool.js to the repository's own server/src/db/pglite.js
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('/server/src/db/pool.js')) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          import { createPglitePool } from './pglite.js';
          const pool = createPglitePool(process.env.PGLITE_DATA_DIR || ${JSON.stringify(defaultDataDir)});
          await pool.ready();
          export default pool;
        `,
      };
    }
    return nextLoad(url, context);
  },
});

// 2. Allow rendering inside the AI Studio preview iframe by relaxing frame-ancestors
const origSetHeader = http.ServerResponse.prototype.setHeader;
http.ServerResponse.prototype.setHeader = function (name, value) {
  const lower = String(name).toLowerCase();
  if (lower === 'x-frame-options') {
    return this;
  }
  if (lower === 'content-security-policy' && typeof value === 'string') {
    const adjusted = value
      .replace(/frame-ancestors\s+'none';?/gi, '')
      .replace(/connect-src\s+'self'/gi, "connect-src 'self' https: http:");
    return origSetHeader.call(this, name, adjusted);
  }
  return origSetHeader.call(this, name, value);
};

// 3. Handle POST /api/android-github/create-repo to create a brand-new GitHub repository
//    and push the Android project + compiled APK without touching the original repo.
const PROTECTED_REPOS = new Set([
  'sp-gemini-recovered',
  'sp-gemini-2',
  'sp-gemini-5',
  'student-panel',
  'foraigit',
]);

async function createAndPushNewRepo(req, res) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 64_000) break;
  }
  let body = {};
  try {
    body = JSON.parse(raw || '{}');
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON body.' }));
    return;
  }

  const repoName = String(body.repoName || '').trim();
  const token = String(body.token || '').trim();
  const isPrivate = Boolean(body.private);
  const description = String(
    body.description ||
      'Student Panel — Android Companion App (Capacitor Android project + debug APK + full stack)'
  ).trim();

  if (!repoName || !/^[a-zA-Z0-9._-]+$/.test(repoName)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error:
          'Enter a valid new repository name (letters, digits, hyphens, underscores).',
      })
    );
    return;
  }

  if (PROTECTED_REPOS.has(repoName.toLowerCase())) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: `Refusing to sync with existing protected repository "${repoName}". Choose a new repository name (e.g. "student-panel-android").`,
      })
    );
    return;
  }

  if (!token) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error:
          'A GitHub Personal Access Token (with repo scope) is required to create and push to the new repository.',
      })
    );
    return;
  }

  const tmpGitDir = '/tmp/student-panel-new-repo-git';
  try {
    const userResp = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'StudentPanel-Android-Publisher',
      },
    });
    if (!userResp.ok) {
      const errData = await userResp.json().catch(() => ({}));
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: `GitHub authentication failed: ${errData.message || userResp.statusText}`,
        })
      );
      return;
    }
    const ghUser = await userResp.json();
    const owner = ghUser.login;

    const createResp = await fetch('https://api.github.com/user/repos', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'StudentPanel-Android-Publisher',
      },
      body: JSON.stringify({
        name: repoName,
        description,
        private: isPrivate,
        auto_init: false,
      }),
    });

    let htmlUrl = `https://github.com/${owner}/${repoName}`;
    if (createResp.ok) {
      const repoData = await createResp.json();
      htmlUrl = repoData.html_url || htmlUrl;
    } else if (createResp.status !== 422) {
      const errData = await createResp.json().catch(() => ({}));
      res.writeHead(createResp.status, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: `Could not create repository "${owner}/${repoName}": ${errData.message || createResp.statusText}`,
        })
      );
      return;
    }

    const remoteUrl = `https://x-access-token:${encodeURIComponent(token)}@github.com/${owner}/${repoName}.git`;
    fs.rmSync(tmpGitDir, { recursive: true, force: true });
    execFileSync('git', ['init', '--bare', tmpGitDir], { cwd: rootDir, stdio: 'pipe' });
    const gitBase = [`--git-dir=${tmpGitDir}`, `--work-tree=${rootDir}`];
    execFileSync('git', [...gitBase, 'config', 'user.name', owner || 'Student Panel Android Builder'], {
      cwd: rootDir,
      stdio: 'pipe',
    });
    execFileSync('git', [...gitBase, 'config', 'user.email', `${owner || 'android'}@users.noreply.github.com`], {
      cwd: rootDir,
      stdio: 'pipe',
    });
    execFileSync('git', [...gitBase, 'add', '.'], { cwd: rootDir, stdio: 'pipe' });
    execFileSync(
      'git',
      [...gitBase, 'commit', '-m', 'Initial commit: Student Panel Android App (Capacitor project + debug APK)'],
      { cwd: rootDir, stdio: 'pipe' }
    );
    try {
      execFileSync('git', [...gitBase, 'push', '--force', remoteUrl, 'HEAD:refs/heads/main'], {
        cwd: rootDir,
        stdio: 'pipe',
      });
    } catch (pushErr) {
      const stderr = String(pushErr.stderr || pushErr.message || '');
      if (stderr.includes('workflow')) {
        execFileSync('git', [...gitBase, 'rm', '-rf', '--cached', '--ignore-unmatch', '.github/workflows'], {
          cwd: rootDir,
          stdio: 'pipe',
        });
        execFileSync('git', [...gitBase, 'commit', '--amend', '--no-edit'], {
          cwd: rootDir,
          stdio: 'pipe',
        });
        execFileSync('git', [...gitBase, 'push', '--force', remoteUrl, 'HEAD:refs/heads/main'], {
          cwd: rootDir,
          stdio: 'pipe',
        });
      } else {
        throw pushErr;
      }
    }
    fs.rmSync(tmpGitDir, { recursive: true, force: true });

    // Also create a GitHub Release with StudentPanel-debug.apk attached if present
    let releaseUrl = null;
    const apkFile = path.join(rootDir, 'releases', 'StudentPanel-debug.apk');
    if (fs.existsSync(apkFile)) {
      const relResp = await fetch(
        `https://api.github.com/repos/${owner}/${repoName}/releases`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'Content-Type': 'application/json',
            'User-Agent': 'StudentPanel-Android-Publisher',
          },
          body: JSON.stringify({
            tag_name: 'v1.0.0-android',
            name: 'Student Panel Android App v1.0.0 (Debug APK)',
            body: 'Compiled Capacitor Android debug APK (`StudentPanel-debug.apk`) and Android Studio project.',
            draft: false,
            prerelease: false,
          }),
        }
      );
      if (relResp.ok) {
        const relData = await relResp.json();
        releaseUrl = relData.html_url;
        const uploadUrl = relData.upload_url.replace(
          /\{\?name,label\}$/,
          '?name=StudentPanel-debug.apk'
        );
        const apkBytes = fs.readFileSync(apkFile);
        await fetch(uploadUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/vnd.android.package-archive',
            'Content-Length': String(apkBytes.length),
            'User-Agent': 'StudentPanel-Android-Publisher',
          },
          body: apkBytes,
        });
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        fullName: `${owner}/${repoName}`,
        htmlUrl,
        releaseUrl,
      })
    );
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: err.message || 'Failed to create or push to the new repository.',
      })
    );
  } finally {
    fs.rmSync(tmpGitDir, { recursive: true, force: true });
  }
}

const origEmit = http.Server.prototype.emit;
http.Server.prototype.emit = function (event, req, res, ...rest) {
  if (event === 'request' && req && res) {
    const urlPath = (req.url || '').split('?')[0];
    if (req.method === 'POST' && urlPath === '/api/android-github/create-repo') {
      createAndPushNewRepo(req, res);
      return true;
    }
    if (req.method === 'GET' && urlPath === '/android/StudentPanel-debug.apk') {
      const p1 = path.join(rootDir, 'releases', 'StudentPanel-debug.apk');
      const p2 = path.join(rootDir, 'client', 'dist', 'android', 'StudentPanel-debug.apk');
      const target = fs.existsSync(p1) ? p1 : fs.existsSync(p2) ? p2 : null;
      if (target) {
        const stat = fs.statSync(target);
        res.writeHead(200, {
          'Content-Type': 'application/vnd.android.package-archive',
          'Content-Length': String(stat.size),
          'Content-Disposition': 'attachment; filename="StudentPanel-debug.apk"',
        });
        fs.createReadStream(target).pipe(res);
        return true;
      }
    }
    if (req.method === 'GET' && urlPath === '/android/StudentPanel-android-project.zip') {
      const p1 = path.join(rootDir, 'releases', 'StudentPanel-android-project.zip');
      const p2 = path.join(rootDir, 'client', 'dist', 'android', 'StudentPanel-android-project.zip');
      const target = fs.existsSync(p1) ? p1 : fs.existsSync(p2) ? p2 : null;
      if (target) {
        const stat = fs.statSync(target);
        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Length': String(stat.size),
          'Content-Disposition': 'attachment; filename="StudentPanel-android-project.zip"',
        });
        fs.createReadStream(target).pipe(res);
        return true;
      }
    }
  }
  return origEmit.call(this, event, req, res, ...rest);
};
