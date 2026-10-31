import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleOnDeviceEngine } from './build-on-device-engine.mjs';

const rootDir = fileURLToPath(new URL('../', import.meta.url));
const clientDir = path.join(rootDir, 'client');
const serverDir = path.join(rootDir, 'server');
const distDir = path.join(clientDir, 'dist');
const localDir = path.join(rootDir, '.local');
const releasesDir = path.join(rootDir, 'releases');
const pgliteDir = path.join(localDir, 'pglite-db');
const hookPath = path.join(rootDir, 'scripts', 'aistudio-pglite-hook.mjs');

function ensureDeps() {
  if (!fs.existsSync(path.join(serverDir, 'node_modules', 'express'))) {
    execSync('npm --prefix server ci', { cwd: rootDir, stdio: 'inherit' });
  }
  if (!fs.existsSync(path.join(clientDir, 'node_modules', 'vite'))) {
    execSync('npm --prefix client ci', { cwd: rootDir, stdio: 'inherit' });
  }
}

function buildBridgeJs() {
  const infoPath = path.join(releasesDir, 'android-info.json');
  const infoRaw = fs.existsSync(infoPath)
    ? fs.readFileSync(infoPath, 'utf8')
    : JSON.stringify({
        appId: 'app.studentpanel.mobile',
        appName: 'Student Panel',
        capacitorVersion: '7.6.9',
        gradleVersion: '8.11.1',
        minSdkVersion: 23,
        targetSdkVersion: 35,
        apkSizeFormatted: '14.2 MB (Standalone On-Device PostgreSQL)',
        projectZipSizeFormatted: '14.5 MB',
        engine: 'Embedded PGlite PostgreSQL 16 (WASM + IndexedDB) + 31 Local Express Routers',
        repoModified: false,
      });

  return `(function() {
  const APK_INFO = ${infoRaw};

  function mountAndroidCompanionUI() {
    if (document.getElementById('sp-android-companion-root')) return;

    const style = document.createElement('style');
    style.textContent = \`
      #sp-android-companion-root {
        position: fixed;
        inset-block-end: 14px;
        inset-inline-end: 14px;
        z-index: 9999;
        font-family: var(--font-sans, system-ui, -apple-system, sans-serif);
      }
      .sp-android-fab {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 8px 14px;
        border-radius: 10px;
        border: 1px solid rgba(16, 185, 129, 0.45);
        background: rgba(15, 23, 42, 0.92);
        color: #ecfdf5;
        font-size: 12.5px;
        font-weight: 600;
        cursor: pointer;
        box-shadow: 0 10px 25px rgba(0, 0, 0, 0.35);
        backdrop-filter: blur(10px);
        transition: transform 0.15s ease, border-color 0.15s ease;
      }
      .sp-android-fab:hover {
        transform: translateY(-1px);
        border-color: rgba(16, 185, 129, 0.85);
      }
      .sp-android-dot {
        width: 8px;
        height: 8px;
        border-radius: 999px;
        background: #10b981;
        box-shadow: 0 0 8px #10b981;
      }
      .sp-android-backdrop {
        position: fixed;
        inset: 0;
        z-index: 10000;
        background: rgba(2, 6, 23, 0.72);
        backdrop-filter: blur(4px);
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 16px;
      }
      .sp-android-modal {
        width: 100%;
        max-width: 580px;
        max-height: 90vh;
        overflow-y: auto;
        border-radius: 14px;
        background: #0f172a;
        color: #f8fafc;
        border: 1px solid rgba(148, 163, 184, 0.22);
        box-shadow: 0 24px 48px rgba(0, 0, 0, 0.5);
        padding: 20px;
        direction: ltr;
        text-align: left;
      }
      .sp-android-modal h3 {
        margin: 0 0 6px 0;
        font-size: 17px;
        font-weight: 700;
        color: #f8fafc;
        display: flex;
        align-items: center;
        justify-content: space-between;
      }
      .sp-android-sub {
        margin: 0 0 16px 0;
        font-size: 13px;
        color: #94a3b8;
        line-height: 1.45;
      }
      .sp-android-card {
        background: rgba(30, 41, 59, 0.65);
        border: 1px solid rgba(148, 163, 184, 0.16);
        border-radius: 10px;
        padding: 14px;
        margin-bottom: 12px;
      }
      .sp-android-card-title {
        font-size: 12px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: #34d399;
        margin-bottom: 8px;
      }
      .sp-android-dl-row {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin-top: 10px;
      }
      .sp-android-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        padding: 9px 14px;
        border-radius: 8px;
        font-size: 13px;
        font-weight: 600;
        text-decoration: none;
        cursor: pointer;
        border: 1px solid transparent;
      }
      .sp-android-btn-primary {
        background: #10b981;
        color: #022c22;
      }
      .sp-android-btn-secondary {
        background: rgba(51, 65, 85, 0.85);
        color: #f1f5f9;
        border-color: rgba(148, 163, 184, 0.25);
      }
      .sp-android-meta {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 11.5px;
        color: #cbd5e1;
        display: grid;
        grid-template-columns: 120px 1fr;
        row-gap: 4px;
      }
      .sp-android-input {
        width: 100%;
        padding: 8px 10px;
        border-radius: 7px;
        border: 1px solid rgba(148, 163, 184, 0.3);
        background: #020617;
        color: #f8fafc;
        font-size: 12.5px;
        box-sizing: border-box;
      }
    \`;
    document.head.appendChild(style);

    const container = document.createElement('div');
    container.id = 'sp-android-companion-root';

    const fab = document.createElement('button');
    fab.type = 'button';
    fab.className = 'sp-android-fab';
    fab.innerHTML = '<span class="sp-android-dot"></span><span>Standalone Android APK (On-Device DB)</span>';

    function openDialog() {
      const existing = document.getElementById('sp-android-modal-backdrop');
      if (existing) existing.remove();

      const backdrop = document.createElement('div');
      backdrop.id = 'sp-android-modal-backdrop';
      backdrop.className = 'sp-android-backdrop';

      backdrop.innerHTML = \`
        <div class="sp-android-modal" role="dialog" aria-modal="true">
          <h3>
            <span>Student Panel — Self-Contained Android App</span>
            <button type="button" id="sp-android-close" class="sp-android-btn sp-android-btn-secondary" style="padding:4px 10px;">✕</button>
          </h3>
          <p class="sp-android-sub">
            Runs <strong>100% locally on the Android device itself</strong> with zero external server required. Bundles real PostgreSQL 16 (PGlite WebAssembly + persistent IndexedDB <code>idb://student-panel-db-v2</code>), all 37 SQL migrations, and all 31 backend Express routers inside the APK.
          </p>

          <div class="sp-android-card">
            <div class="sp-android-card-title">1. Download Standalone Android APK &amp; Project</div>
            <div class="sp-android-meta">
              <span>Application ID:</span><span>\${APK_INFO.appId || 'app.studentpanel.mobile'}</span>
              <span>On-Device Engine:</span><span>PGlite WASM + IndexedDB (37 Migrations + 31 Routers)</span>
              <span>Network Needed:</span><span>None (100% Offline / Self-Contained on Phone)</span>
              <span>Default Login:</span><span>Auto-signed in as <code>admin</code> (Password: <code>admin1234</code>)</span>
            </div>
            <div class="sp-android-dl-row">
              <a class="sp-android-btn sp-android-btn-primary" href="/android/StudentPanel-debug.apk" download="StudentPanel-debug.apk">
                ⬇ Download Standalone APK (\${APK_INFO.apkSizeFormatted || '14 MB'})
              </a>
              <a class="sp-android-btn sp-android-btn-secondary" href="/android/StudentPanel-android-project.zip" download="StudentPanel-android-project.zip">
                ⬇ Android Studio Project (.zip)
              </a>
            </div>
          </div>

          <div class="sp-android-card">
            <div class="sp-android-card-title">2. On-Device Database Controls</div>
            <div class="sp-android-dl-row" style="margin-top:4px;">
              <button type="button" id="sp-android-quick-login" class="sp-android-btn sp-android-btn-primary">
                Sign In as Administrator (admin)
              </button>
              <button type="button" id="sp-android-reset-db" class="sp-android-btn sp-android-btn-secondary">
                Reset On-Device Database to Sample Seed
              </button>
            </div>
          </div>

          <div class="sp-android-card" style="border-color: rgba(59, 130, 246, 0.35);">
            <div class="sp-android-card-title" style="color:#60a5fa;">3. Publish Standalone APK to GitHub Repository</div>
            <div style="font-size:12px;color:#94a3b8;margin-bottom:8px;">
              Push the self-contained Android codebase and attach the standalone <code>StudentPanel-debug.apk</code> release to your new GitHub repository.
            </div>
            <div style="display:grid;grid-template-columns:1fr 130px;gap:8px;margin-bottom:8px;">
              <input id="sp-gh-repo-name" class="sp-android-input" type="text" placeholder="New repo name (e.g. student-panel-android)" value="student-panel-android" />
              <select id="sp-gh-visibility" class="sp-android-input">
                <option value="public">Public Repo</option>
                <option value="private">Private Repo</option>
              </select>
            </div>
            <div style="display:flex;gap:8px;">
              <input id="sp-gh-token" class="sp-android-input" type="password" placeholder="GitHub Personal Access Token (ghp_...)" />
              <button type="button" id="sp-gh-create-btn" class="sp-android-btn sp-android-btn-primary" style="background:#3b82f6;color:#fff;white-space:nowrap;">
                Push to GitHub
              </button>
            </div>
            <div id="sp-gh-status" style="margin-top:8px;font-size:12px;line-height:1.4;display:none;padding:8px 10px;border-radius:6px;"></div>
          </div>
        </div>
      \`;

      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) backdrop.remove();
      });
      document.body.appendChild(backdrop);

      document.getElementById('sp-android-close')?.addEventListener('click', () => backdrop.remove());
      document.getElementById('sp-android-quick-login')?.addEventListener('click', () => {
        localStorage.removeItem('sp_explicit_logout_v2');
        localStorage.setItem('sp_local_sid_v2', 'local-android-admin-session');
        backdrop.remove();
        window.location.href = '/';
      });
      document.getElementById('sp-android-reset-db')?.addEventListener('click', async () => {
        localStorage.removeItem('sp_idb_seeded_v2');
        localStorage.removeItem('sp_explicit_logout_v2');
        localStorage.setItem('sp_local_sid_v2', 'local-android-admin-session');
        try {
          await new Promise((resolve) => {
            const req = indexedDB.deleteDatabase('/student-panel-db-v2');
            req.onsuccess = resolve;
            req.onerror = resolve;
            req.onblocked = resolve;
          });
        } catch {}
        backdrop.remove();
        window.location.href = '/';
      });
      document.getElementById('sp-gh-create-btn')?.addEventListener('click', async () => {
        const repoName = document.getElementById('sp-gh-repo-name')?.value?.trim() || '';
        const vis = document.getElementById('sp-gh-visibility')?.value || 'public';
        const token = document.getElementById('sp-gh-token')?.value?.trim() || '';
        const statusEl = document.getElementById('sp-gh-status');
        const btn = document.getElementById('sp-gh-create-btn');
        if (!statusEl || !btn) return;
        statusEl.style.display = 'block';
        statusEl.style.background = 'rgba(59, 130, 246, 0.15)';
        statusEl.style.border = '1px solid rgba(59, 130, 246, 0.4)';
        statusEl.style.color = '#93c5fd';
        statusEl.textContent = 'Pushing standalone Android codebase + APK to GitHub...';
        btn.disabled = true;
        try {
          const resp = await fetch('/api/android-github/create-repo', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              repoName,
              private: vis === 'private',
              token
            })
          });
          const data = await resp.json();
          if (!resp.ok || !data.ok) {
            statusEl.style.background = 'rgba(239, 68, 68, 0.15)';
            statusEl.style.border = '1px solid rgba(239, 68, 68, 0.4)';
            statusEl.style.color = '#fca5a5';
            statusEl.textContent = data.error || 'Could not push to repository.';
          } else {
            statusEl.style.background = 'rgba(16, 185, 129, 0.15)';
            statusEl.style.border = '1px solid rgba(16, 185, 129, 0.4)';
            statusEl.style.color = '#6ee7b7';
            statusEl.innerHTML = '✓ Pushed to repository: <a href="' + data.htmlUrl + '" target="_blank" rel="noopener noreferrer" style="color:#34d399;font-weight:700;">' + data.fullName + '</a>' +
              (data.releaseUrl ? ' · <a href="' + data.releaseUrl + '" target="_blank" rel="noopener noreferrer" style="color:#34d399;font-weight:700;">Standalone APK Release</a>' : '');
          }
        } catch (err) {
          statusEl.style.background = 'rgba(239, 68, 68, 0.15)';
          statusEl.style.border = '1px solid rgba(239, 68, 68, 0.4)';
          statusEl.style.color = '#fca5a5';
          statusEl.textContent = err.message || 'Network error while creating repository.';
        } finally {
          btn.disabled = false;
        }
      });
    }

    fab.addEventListener('click', openDialog);
    container.appendChild(fab);
    document.body.appendChild(container);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountAndroidCompanionUI);
  } else {
    mountAndroidCompanionUI();
  }
})();`;
}

async function ensureDatabaseReady() {
  fs.mkdirSync(localDir, { recursive: true });
  const env = {
    ...process.env,
    ALLOW_SAMPLE_DATA: '1',
    PGLITE_DATA_DIR: pgliteDir,
  };
  if (!fs.existsSync(path.join(pgliteDir, 'PG_VERSION'))) {
    execSync(
      `node --import ${JSON.stringify(hookPath)} ${JSON.stringify(path.join(serverDir, 'src/db/migrate.js'))}`,
      { cwd: serverDir, env, stdio: 'inherit' }
    );
    execSync(
      `node --import ${JSON.stringify(hookPath)} ${JSON.stringify(path.join(serverDir, 'src/scripts/seedSample.js'))}`,
      { cwd: serverDir, env, stdio: 'inherit' }
    );
  }
}

async function buildClientAndBridge() {
  ensureDeps();
  fs.mkdirSync(localDir, { recursive: true });
  fs.mkdirSync(releasesDir, { recursive: true });

  // Remove any .env.mobile.local so VITE_API_BASE_URL is ALWAYS empty ("")
  // and the Android app NEVER connects to any external server!
  const mobileEnvPath = path.join(clientDir, '.env.mobile.local');
  if (fs.existsSync(mobileEnvPath)) {
    fs.unlinkSync(mobileEnvPath);
  }

  await ensureDatabaseReady();

  // Build React client with relative /api URLs (no remote server URL)
  execSync('npx vite build', { cwd: clientDir, stdio: 'inherit' });

  // Bundle the on-device PGlite WASM + 37-migration PostgreSQL database + all 31 Express routers
  await bundleOnDeviceEngine();

  fs.writeFileSync(path.join(distDir, 'android-bridge.js'), buildBridgeJs());

  const indexHtmlPath = path.join(distDir, 'index.html');
  let indexHtml = fs.readFileSync(indexHtmlPath, 'utf8');
  if (!indexHtml.includes('/android-local-engine.js')) {
    indexHtml = indexHtml.replace(
      '<head>',
      '<head>\n    <script type="module" src="/android-local-engine.js"></script>'
    );
  }
  if (!indexHtml.includes('/android-bridge.js')) {
    indexHtml = indexHtml.replace(
      '</body>',
      '    <script src="/android-bridge.js"></script>\n  </body>'
    );
  }
  fs.writeFileSync(indexHtmlPath, indexHtml);

  // Sync Capacitor Android project if present
  if (fs.existsSync(path.join(clientDir, 'android'))) {
    execSync('npx cap copy android', { cwd: clientDir, stdio: 'inherit' });
    // Ensure CapacitorHttp and CapacitorCookies are disabled in Android assets
    // so Capacitor never hijacks window.fetch away from the on-device PGlite engine
    const capCfgPath = path.join(
      clientDir,
      'android/app/src/main/assets/capacitor.config.json'
    );
    if (fs.existsSync(capCfgPath)) {
      const capCfg = JSON.parse(fs.readFileSync(capCfgPath, 'utf8'));
      capCfg.plugins = {
        CapacitorCookies: { enabled: false },
        CapacitorHttp: { enabled: false },
      };
      fs.writeFileSync(capCfgPath, JSON.stringify(capCfg, null, '\t'));
    }
  }

  const distAndroidDir = path.join(distDir, 'android');
  fs.mkdirSync(distAndroidDir, { recursive: true });
  const releaseApk = path.join(releasesDir, 'StudentPanel-debug.apk');
  if (fs.existsSync(releaseApk)) {
    fs.copyFileSync(releaseApk, path.join(distAndroidDir, 'StudentPanel-debug.apk'));
  }
  const releaseZip = path.join(releasesDir, 'StudentPanel-android-project.zip');
  if (fs.existsSync(releaseZip)) {
    fs.copyFileSync(releaseZip, path.join(distAndroidDir, 'StudentPanel-android-project.zip'));
  }
}

const cmd = process.argv[2] || 'start';

if (cmd === 'install') {
  ensureDeps();
} else if (cmd === 'build') {
  await buildClientAndBridge();
} else {
  if (!fs.existsSync(path.join(distDir, 'android-local-engine.js'))) {
    await buildClientAndBridge();
  }
  await ensureDatabaseReady();
  const env = {
    ...process.env,
    PORT: process.env.PORT || '3000',
    HOST: process.env.HOST || '0.0.0.0',
    SESSION_SECRET:
      process.env.SESSION_SECRET ||
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    SESSION_COOKIE_SECURE: 'false',
    CSRF_CHECK_ORIGIN: 'false',
    ALLOW_SAMPLE_DATA: '1',
    PGLITE_DATA_DIR: pgliteDir,
  };
  const child = spawn(
    process.execPath,
    ['--import', hookPath, path.join(serverDir, 'src/index.js')],
    { cwd: serverDir, env, stdio: 'inherit' }
  );
  process.on('SIGINT', () => child.kill('SIGINT'));
  process.on('SIGTERM', () => child.kill('SIGTERM'));
  child.on('exit', (code) => process.exit(code ?? 0));
}
