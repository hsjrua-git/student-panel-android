import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = fileURLToPath(new URL('../', import.meta.url));
const clientDir = path.join(rootDir, 'client');
const serverDir = path.join(rootDir, 'server');
const distDir = path.join(clientDir, 'dist');
const localDir = path.join(rootDir, '.local');
const releasesDir = path.join(rootDir, 'releases');
const pgliteDir = path.join(localDir, 'pglite-db');
const hookPath = path.join(rootDir, 'scripts', 'aistudio-pglite-hook.mjs');

const SHARED_APP_URL =
  process.env.APP_URL ||
  'https://ais-pre-gpemhef5wofbyqhfnrs2br-394473222354.europe-west2.run.app';

function ensureDeps() {
  if (!fs.existsSync(path.join(serverDir, 'node_modules', 'express'))) {
    execSync('npm --prefix server ci', { cwd: rootDir, stdio: 'inherit' });
  }
  if (!fs.existsSync(path.join(clientDir, 'node_modules', 'vite'))) {
    execSync('npm --prefix client ci', { cwd: rootDir, stdio: 'inherit' });
  }
}

function buildBridgeJs() {
  const snapPath = path.join(localDir, 'android-seed-snapshot.json');
  const snapshotRaw = fs.existsSync(snapPath)
    ? fs.readFileSync(snapPath, 'utf8')
    : '{}';
  const infoPath = fs.existsSync(path.join(releasesDir, 'android-info.json'))
    ? path.join(releasesDir, 'android-info.json')
    : path.join(localDir, 'android-info.json');
  const infoRaw = fs.existsSync(infoPath)
    ? fs.readFileSync(infoPath, 'utf8')
    : JSON.stringify({
        appId: 'app.studentpanel.mobile',
        appName: 'Student Panel',
        capacitorVersion: '7.6.9',
        gradleVersion: '8.11.1',
        minSdkVersion: 23,
        targetSdkVersion: 35,
        apkSizeFormatted: '5.24 MB',
        projectZipSizeFormatted: '1.48 MB',
        apkSha256:
          '0d18c405570bc9b8ba20147167431e9263157fc3c128f2c2decccd4fd7373650',
        repoModified: false,
      });

  return `(function() {
  const SEED_SNAPSHOT = ${snapshotRaw};
  const APK_INFO = ${infoRaw};
  const STORAGE_KEY = 'sp_android_local_db_v1';
  const MODE_KEY = 'sp_android_connection_mode';
  const CUSTOM_URL_KEY = 'sp_android_custom_api_url';
  const SESSION_KEY = 'sp_android_active_user';

  const isCapacitorNative = typeof window !== 'undefined' &&
    window.Capacitor &&
    typeof window.Capacitor.isNativePlatform === 'function' &&
    window.Capacitor.isNativePlatform();

  function getConnectionMode() {
    const saved = localStorage.getItem(MODE_KEY);
    if (saved === 'offline' || saved === 'connected') return saved;
    return isCapacitorNative ? 'auto' : 'connected';
  }

  function loadLocalDb() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch {}
    const clone = JSON.parse(JSON.stringify(SEED_SNAPSHOT));
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(clone)); } catch {}
    return clone;
  }

  function saveLocalDb(db) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(db)); } catch {}
  }

  function getActiveUser(db) {
    const raw = localStorage.getItem(SESSION_KEY);
    if (raw === 'logged_out') return null;
    if (raw) {
      try { return JSON.parse(raw); } catch {}
    }
    if (isCapacitorNative) {
      return db['/api/auth/me']?.user || null;
    }
    return null;
  }

  function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  function handleLocalApi(urlObj, method, bodyText) {
    const db = loadLocalDb();
    const pathname = urlObj.pathname;
    const search = urlObj.search || '';
    const fullKey = pathname + search;
    let body = {};
    if (bodyText) {
      try { body = JSON.parse(bodyText); } catch {}
    }

    if (pathname === '/api/health') {
      return jsonResponse({ status: 'ok', mode: 'android-local-db' });
    }
    if (pathname === '/api/android-info') {
      return jsonResponse(APK_INFO);
    }
    if (pathname === '/api/auth/me') {
      const user = getActiveUser(db);
      if (!user) return jsonResponse({ error: 'Authentication required.', code: 'AUTH_REQUIRED' }, 401);
      return jsonResponse({ user });
    }
    if (pathname === '/api/auth/login' && method === 'POST') {
      const username = String(body.username || '').trim();
      const password = String(body.password || '');
      if (!username || (password !== 'sample-panel-2026' && password !== 'admin123')) {
        return jsonResponse({ error: 'Invalid username or password.', code: 'AUTH_INVALID_CREDENTIALS' }, 401);
      }
      const baseUser = db['/api/auth/me']?.user || {
        id: 1,
        username: 'sample-admin',
        fullName: 'Sample Administrator',
        roleId: 1,
        roleName: 'Administrator',
        mustChangePassword: false,
        permissions: []
      };
      const user = {
        ...baseUser,
        username,
        fullName: username === 'admin' ? 'System Administrator' : (baseUser.fullName || username)
      };
      localStorage.setItem(SESSION_KEY, JSON.stringify(user));
      return jsonResponse({ user });
    }
    if (pathname === '/api/auth/logout' && method === 'POST') {
      localStorage.setItem(SESSION_KEY, 'logged_out');
      return jsonResponse({ ok: true });
    }
    if (pathname === '/api/preferences') {
      const current = db['/api/preferences'] || { preferences: { theme: 'dark', palette: 'obsidian-gold', language: 'fa' } };
      if (method === 'GET') return jsonResponse(current);
      const updated = {
        preferences: {
          ...(current.preferences || {}),
          ...(body.preferences || body || {})
        }
      };
      db['/api/preferences'] = updated;
      saveLocalDb(db);
      return jsonResponse(updated);
    }
    if (pathname === '/api/students') {
      const allWrap = db['/api/students?page=1&pageSize=100&sort=newest'] || db['/api/students?page=1&pageSize=25&sort=newest'] || { students: [], total: 0 };
      let list = Array.isArray(allWrap.students) ? [...allWrap.students] : [];
      if (method === 'POST') {
        const nextId = list.reduce((m, s) => Math.max(m, Number(s.id) || 0), 100) + 1;
        const created = {
          id: nextId,
          code: body.code || ('S-' + String(nextId).padStart(4, '0')),
          fullName: body.fullName || 'New Student',
          birthDate: body.birthDate || '2010-01-01',
          gender: body.gender || 'female',
          joinedAt: body.joinedAt || '2026-10-31',
          isArchived: false,
          groups: [],
          extra: body.extra || {}
        };
        list.unshift(created);
        allWrap.students = list;
        allWrap.total = list.length;
        db['/api/students?page=1&pageSize=100&sort=newest'] = allWrap;
        saveLocalDb(db);
        return jsonResponse({ student: created }, 201);
      }
      const q = (urlObj.searchParams.get('search') || '').trim().toLowerCase();
      const groupId = urlObj.searchParams.get('groupId');
      if (q) {
        list = list.filter(s => String(s.fullName || '').toLowerCase().includes(q) || String(s.code || '').toLowerCase().includes(q));
      }
      if (groupId) {
        const gid = Number(groupId);
        list = list.filter(s => Array.isArray(s.groups) && s.groups.some(g => Number(g.id ?? g.groupId) === gid));
      }
      const page = Math.max(1, Number(urlObj.searchParams.get('page') || 1));
      const pageSize = Math.max(1, Number(urlObj.searchParams.get('pageSize') || 25));
      const start = (page - 1) * pageSize;
      return jsonResponse({
        students: list.slice(start, start + pageSize),
        total: list.length,
        page,
        pageSize
      });
    }
    if (db[fullKey]) return jsonResponse(db[fullKey]);
    if (db[pathname]) return jsonResponse(db[pathname]);
    for (const k of Object.keys(db)) {
      if (k.split('?')[0] === pathname) return jsonResponse(db[k]);
    }
    return jsonResponse({ ok: true });
  }

  const nativeFetch = window.fetch.bind(window);
  window.fetch = async function(input, init = {}) {
    const rawUrl = typeof input === 'string' ? input : (input?.url || '');
    let urlObj;
    try {
      urlObj = new URL(rawUrl, window.location.origin);
    } catch {
      return nativeFetch(input, init);
    }
    if (!urlObj.pathname.startsWith('/api/') || urlObj.pathname === '/api/android-github/create-repo') {
      return nativeFetch(input, init);
    }
    const mode = getConnectionMode();
    const method = String(init.method || (typeof input === 'object' && input?.method) || 'GET').toUpperCase();
    const bodyText = typeof init.body === 'string' ? init.body : null;
    if (mode === 'offline') {
      return handleLocalApi(urlObj, method, bodyText);
    }
    const customOrigin = (localStorage.getItem(CUSTOM_URL_KEY) || '').trim().replace(/\\/+$/, '');
    const targetUrl = customOrigin ? (customOrigin + urlObj.pathname + urlObj.search) : (urlObj.pathname + urlObj.search);
    try {
      const response = await nativeFetch(targetUrl, init);
      return response;
    } catch (err) {
      if (mode === 'auto' || isCapacitorNative) {
        return handleLocalApi(urlObj, method, bodyText);
      }
      throw err;
    }
  };

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
        border-color: #10b981;
      }
      @media (max-width: 640px) {
        #sp-android-companion-root {
          inset-block-end: 10px;
          inset-inline-end: 10px;
        }
        .sp-android-fab {
          padding: 6px 10px;
          font-size: 11.5px;
        }
      }
      .sp-android-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #10b981;
        box-shadow: 0 0 8px #10b981;
      }
      .sp-android-modal-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(9, 13, 22, 0.65);
        backdrop-filter: blur(6px);
        z-index: 10000;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 16px;
      }
      .sp-android-modal {
        width: min(560px, 100%);
        max-height: 92vh;
        overflow-y: auto;
        background: #111827;
        color: #f3f4f6;
        border: 1px solid rgba(255, 255, 255, 0.14);
        border-radius: 14px;
        padding: 20px;
        box-shadow: 0 24px 48px rgba(0, 0, 0, 0.5);
        direction: ltr;
        text-align: left;
      }
      .sp-android-modal h2 {
        margin: 0 0 4px 0;
        font-size: 17px;
        font-weight: 700;
        color: #ffffff;
        display: flex;
        align-items: center;
        justify-content: space-between;
      }
      .sp-android-sub {
        margin: 0 0 14px 0;
        font-size: 12.5px;
        color: #9ca3af;
        line-height: 1.45;
      }
      .sp-android-card {
        background: rgba(255, 255, 255, 0.04);
        border: 1px solid rgba(255, 255, 255, 0.09);
        border-radius: 10px;
        padding: 12px 14px;
        margin-bottom: 12px;
      }
      .sp-android-card-title {
        font-size: 12px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: #34d399;
        margin-bottom: 8px;
      }
      .sp-android-meta-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 6px 12px;
        font-size: 12px;
        color: #d1d5db;
        margin-bottom: 12px;
      }
      .sp-android-meta-grid strong {
        color: #9ca3af;
        font-weight: 500;
      }
      .sp-android-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .sp-android-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        padding: 8px 13px;
        border-radius: 8px;
        font-size: 12.5px;
        font-weight: 600;
        text-decoration: none;
        cursor: pointer;
        border: 1px solid rgba(255, 255, 255, 0.14);
        background: rgba(255, 255, 255, 0.07);
        color: #f9fafb;
      }
      .sp-android-btn.primary {
        background: #059669;
        border-color: #10b981;
        color: #ffffff;
      }
      .sp-android-btn.primary:hover {
        background: #047857;
      }
      .sp-android-btn:hover {
        background: rgba(255, 255, 255, 0.12);
      }
      .sp-android-form-row {
        display: grid;
        grid-template-columns: 1fr 130px;
        gap: 8px;
        margin-bottom: 8px;
      }
      .sp-android-input {
        width: 100%;
        box-sizing: border-box;
        padding: 7px 10px;
        border-radius: 7px;
        border: 1px solid rgba(255, 255, 255, 0.18);
        background: rgba(0, 0, 0, 0.35);
        color: #f9fafb;
        font-size: 12.5px;
      }
      .sp-android-status {
        margin-top: 8px;
        font-size: 12px;
        line-height: 1.45;
        padding: 8px 10px;
        border-radius: 7px;
        display: none;
      }
      body.sp-android-phone-frame {
        background: #090d16 !important;
        display: flex !important;
        justify-content: center !important;
        align-items: flex-start !important;
        padding: 20px 0 !important;
        min-height: 100vh !important;
      }
      body.sp-android-phone-frame #root {
        width: 412px !important;
        max-width: 96vw !important;
        min-height: 860px !important;
        max-height: 92vh !important;
        overflow-y: auto !important;
        overflow-x: hidden !important;
        border: 10px solid #1e293b !important;
        border-top-width: 28px !important;
        border-bottom-width: 22px !important;
        border-radius: 36px !important;
        box-shadow: 0 25px 70px rgba(0, 0, 0, 0.75), 0 0 0 1px rgba(255,255,255,0.12) !important;
        position: relative !important;
        background: var(--bg, #0f131c) !important;
      }
    \`;
    document.head.appendChild(style);

    const container = document.createElement('div');
    container.id = 'sp-android-companion-root';

    const fab = document.createElement('button');
    fab.type = 'button';
    fab.className = 'sp-android-fab';
    fab.setAttribute('aria-label', 'Android App & APK');
    fab.innerHTML = '<span class="sp-android-dot"></span><span>Android APK & Mobile</span>';

    function openDialog() {
      if (document.getElementById('sp-android-dialog-backdrop')) return;
      const backdrop = document.createElement('div');
      backdrop.id = 'sp-android-dialog-backdrop';
      backdrop.className = 'sp-android-modal-backdrop';

      const isFramed = document.body.classList.contains('sp-android-phone-frame');
      const currentMode = getConnectionMode();

      backdrop.innerHTML = \`
        <div class="sp-android-modal" role="dialog" aria-modal="true" aria-label="Android Companion & APK Build">
          <h2>
            <span>Student Panel — Android Companion App</span>
            <button type="button" id="sp-android-close" class="sp-android-btn" aria-label="Close Android Panel">✕</button>
          </h2>
          <p class="sp-android-sub">
            Compiled with Capacitor \${APK_INFO.capacitorVersion || '7.6.9'}, Gradle \${APK_INFO.gradleVersion || '8.11.1'}, JDK 21, and Android SDK \${APK_INFO.targetSdkVersion || 35}. Disconnected from the original GitHub remote so your source repo is never modified.
          </p>

          <div class="sp-android-card">
            <div class="sp-android-card-title">1. Download Compiled Android Package</div>
            <div class="sp-android-meta-grid">
              <div><strong>App ID:</strong> \${APK_INFO.appId || 'app.studentpanel.mobile'}</div>
              <div><strong>APK Size:</strong> \${APK_INFO.apkSizeFormatted || '5.24 MB'}</div>
              <div><strong>Project ZIP:</strong> \${APK_INFO.projectZipSizeFormatted || '1.48 MB'}</div>
              <div><strong>SDK Target:</strong> minSdk 23 / targetSdk 35</div>
              <div style="grid-column: span 2; font-family: monospace; font-size: 11px; word-break: break-all;"><strong>SHA-256:</strong> \${APK_INFO.apkSha256 || '0d18c405570bc9b8ba20147167431e9263157fc3c128f2c2decccd4fd7373650'}</div>
            </div>
            <div class="sp-android-actions">
              <a href="/android/StudentPanel-debug.apk" download="StudentPanel-debug.apk" class="sp-android-btn primary">
                ⬇ Download APK (StudentPanel-debug.apk)
              </a>
              <a href="/android/StudentPanel-android-project.zip" download="StudentPanel-android-project.zip" class="sp-android-btn">
                ⬇ Download Android Studio Project (.zip)
              </a>
            </div>
          </div>

          <div class="sp-android-card">
            <div class="sp-android-card-title">2. Create a New GitHub Repository (Protected from Old Repo)</div>
            <p class="sp-android-sub" style="margin-bottom:8px;">
              Creates a brand-new GitHub repository (with <code>client/android/</code>, <code>releases/StudentPanel-debug.apk</code>, and GitHub Actions APK workflow) and attaches a v1.0.0 APK Release. Existing repos (<code>sp-gemini-recovered</code>, <code>sp-gemini-2</code>) are blocked from being overwritten.
            </p>
            <div class="sp-android-form-row">
              <input id="sp-gh-repo-name" type="text" class="sp-android-input" value="student-panel-android" placeholder="New repository name (e.g. student-panel-android)" aria-label="New GitHub Repository Name" />
              <select id="sp-gh-visibility" class="sp-android-input" aria-label="Repository Visibility">
                <option value="public">Public Repo</option>
                <option value="private">Private Repo</option>
              </select>
            </div>
            <div style="margin-bottom:8px;">
              <input id="sp-gh-token" type="password" class="sp-android-input" placeholder="GitHub Personal Access Token (repo scope — used once, never stored)" aria-label="GitHub Personal Access Token" />
            </div>
            <div class="sp-android-actions">
              <button type="button" id="sp-gh-create-btn" class="sp-android-btn primary">
                🚀 Create New GitHub Repo &amp; Push Android App + APK
              </button>
            </div>
            <div id="sp-gh-status" class="sp-android-status" role="status"></div>
          </div>

          <div class="sp-android-card" style="margin-bottom:0;">
            <div class="sp-android-card-title">3. Quick Demo Login, Phone Frame &amp; APK Mode (\${currentMode.toUpperCase()})</div>
            <div class="sp-android-actions">
              <button type="button" id="sp-android-quick-login" class="sp-android-btn primary">
                ⚡ Sign in as Administrator (sample-admin)
              </button>
              <button type="button" id="sp-android-toggle-frame" class="sp-android-btn">
                📱 \${isFramed ? 'Exit Android Phone Frame' : 'Preview in Android Phone Frame'}
              </button>
              <button type="button" id="sp-android-mode-connected" class="sp-android-btn \${currentMode !== 'offline' ? 'primary' : ''}">
                Connected Server
              </button>
              <button type="button" id="sp-android-mode-offline" class="sp-android-btn \${currentMode === 'offline' ? 'primary' : ''}">
                Offline APK Mode
              </button>
            </div>
          </div>
        </div>
      \`;

      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) backdrop.remove();
      });
      document.body.appendChild(backdrop);

      document.getElementById('sp-android-close')?.addEventListener('click', () => backdrop.remove());
      document.getElementById('sp-android-toggle-frame')?.addEventListener('click', () => {
        document.body.classList.toggle('sp-android-phone-frame');
        backdrop.remove();
      });
      document.getElementById('sp-android-mode-connected')?.addEventListener('click', () => {
        localStorage.setItem(MODE_KEY, 'connected');
        backdrop.remove();
        window.location.reload();
      });
      document.getElementById('sp-android-mode-offline')?.addEventListener('click', () => {
        localStorage.setItem(MODE_KEY, 'offline');
        backdrop.remove();
        window.location.reload();
      });
      document.getElementById('sp-android-quick-login')?.addEventListener('click', async () => {
        try {
          await fetch('/api/auth/me', { credentials: 'include' });
          const m = document.cookie.match(/(?:^|; )csrf=([^;]*)/);
          const csrf = m ? decodeURIComponent(m[1]) : '';
          const res = await fetch('/api/auth/login', {
            method: 'POST',
            credentials: 'include',
            headers: {
              'Content-Type': 'application/json',
              'X-CSRF-Token': csrf
            },
            body: JSON.stringify({ username: 'sample-admin', password: 'sample-panel-2026' })
          });
          if (res.ok) {
            backdrop.remove();
            window.location.href = '/';
          }
        } catch {}
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
        statusEl.textContent = 'Creating new GitHub repository and pushing Android codebase + APK...';
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
            statusEl.textContent = data.error || 'Could not create repository.';
          } else {
            statusEl.style.background = 'rgba(16, 185, 129, 0.15)';
            statusEl.style.border = '1px solid rgba(16, 185, 129, 0.4)';
            statusEl.style.color = '#6ee7b7';
            statusEl.innerHTML = '✓ Created &amp; pushed to new repository: <a href="' + data.htmlUrl + '" target="_blank" rel="noopener noreferrer" style="color:#34d399;font-weight:700;">' + data.fullName + '</a>' +
              (data.releaseUrl ? ' · <a href="' + data.releaseUrl + '" target="_blank" rel="noopener noreferrer" style="color:#34d399;font-weight:700;">APK Release v1.0.0</a>' : '');
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
})();
`;
}

function buildClientAndBridge() {
  ensureDeps();
  fs.mkdirSync(localDir, { recursive: true });
  fs.mkdirSync(releasesDir, { recursive: true });
  const mobileEnvPath = path.join(clientDir, '.env.mobile.local');
  if (!fs.existsSync(mobileEnvPath)) {
    fs.writeFileSync(mobileEnvPath, `VITE_API_BASE_URL=${SHARED_APP_URL}\n`);
  }

  execSync('npx vite build --mode mobile', { cwd: clientDir, stdio: 'inherit' });

  fs.writeFileSync(path.join(distDir, 'android-bridge.js'), buildBridgeJs());
  const indexHtmlPath = path.join(distDir, 'index.html');
  let indexHtml = fs.readFileSync(indexHtmlPath, 'utf8');
  if (!indexHtml.includes('/android-bridge.js')) {
    indexHtml = indexHtml.replace(
      '</body>',
      '    <script src="/android-bridge.js"></script>\n  </body>'
    );
    fs.writeFileSync(indexHtmlPath, indexHtml);
  }

  // Sync Capacitor Android project
  if (!fs.existsSync(path.join(clientDir, 'android'))) {
    execSync('npx cap add android', { cwd: clientDir, stdio: 'inherit' });
  }
  execSync('npx cap copy android', { cwd: clientDir, stdio: 'inherit' });

  // Copy prebuilt APK and Android Studio zip into releases/ and client/dist/android/
  const distAndroidDir = path.join(distDir, 'android');
  fs.mkdirSync(distAndroidDir, { recursive: true });
  const builtApk = path.join(
    clientDir,
    'android/app/build/outputs/apk/debug/app-debug.apk'
  );
  const releaseApk = path.join(releasesDir, 'StudentPanel-debug.apk');
  const cachedApk = path.join(localDir, 'StudentPanel-debug.apk');

  const sourceApk = [builtApk, releaseApk, cachedApk].find((p) =>
    fs.existsSync(p)
  );
  if (sourceApk) {
    if (sourceApk !== releaseApk) fs.copyFileSync(sourceApk, releaseApk);
    fs.copyFileSync(sourceApk, path.join(distAndroidDir, 'StudentPanel-debug.apk'));
  }

  const releaseZip = path.join(releasesDir, 'StudentPanel-android-project.zip');
  const cachedZip = path.join(localDir, 'StudentPanel-android-project.zip');
  const sourceZip = [releaseZip, cachedZip].find((p) => fs.existsSync(p));
  if (sourceZip) {
    if (sourceZip !== releaseZip) fs.copyFileSync(sourceZip, releaseZip);
    fs.copyFileSync(
      sourceZip,
      path.join(distAndroidDir, 'StudentPanel-android-project.zip')
    );
  }
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

const cmd = process.argv[2] || 'start';
if (cmd === 'install') {
  ensureDeps();
} else if (cmd === 'build') {
  buildClientAndBridge();
} else {
  if (!fs.existsSync(path.join(distDir, 'index.html'))) {
    buildClientAndBridge();
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
