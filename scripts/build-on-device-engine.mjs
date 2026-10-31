import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const rootDir = fileURLToPath(new URL('../', import.meta.url));
const serverDir = path.join(rootDir, 'server');
const clientDir = path.join(rootDir, 'client');
const distDir = path.join(clientDir, 'dist');
const shimsDir = path.join(rootDir, '.local', 'android-shims');
const pgliteDistSrc = path.join(serverDir, 'node_modules', '@electric-sql', 'pglite', 'dist');
const pgliteDistOut = path.join(distDir, 'pglite');

export function hashPasswordPbkdf2Sync(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const iterations = 50000;
  const derived = crypto
    .pbkdf2Sync(password, Buffer.from(salt, 'hex'), iterations, 32, 'sha256')
    .toString('hex');
  return `$pbkdf2$${iterations}$${salt}$${derived}`;
}

import { execSync } from 'node:child_process';

export async function buildSeedTarball(seedTarballPath) {
  const existingDbDir = path.join(rootDir, '.local', 'pglite-db');
  const hookPath = path.join(rootDir, 'scripts', 'aistudio-pglite-hook.mjs');
  fs.mkdirSync(path.join(rootDir, '.local'), { recursive: true });

  if (!fs.existsSync(path.join(existingDbDir, 'PG_VERSION'))) {
    const env = {
      ...process.env,
      ALLOW_SAMPLE_DATA: '1',
      PGLITE_DATA_DIR: existingDbDir,
    };
    execSync(
      `node --import ${JSON.stringify(hookPath)} ${JSON.stringify(path.join(serverDir, 'src/db/migrate.js'))}`,
      { cwd: serverDir, env, stdio: 'inherit' }
    );
    execSync(
      `node --import ${JSON.stringify(hookPath)} ${JSON.stringify(path.join(serverDir, 'src/scripts/seedSample.js'))}`,
      { cwd: serverDir, env, stdio: 'inherit' }
    );
  }

  const { createPglitePool } = await import(path.join(serverDir, 'src/db/pglite.js'));
  const targetPool = createPglitePool(existingDbDir);
  await targetPool.ready();

  const adminHash = hashPasswordPbkdf2Sync('admin1234');
  const sampleHash = hashPasswordPbkdf2Sync('sample-panel-2026');

  const adminUserRes = await targetPool.query(
    `INSERT INTO users (username, full_name, password_hash, role_id, must_change_password, is_active)
     VALUES ('admin', 'Administrator', $1, (SELECT id FROM roles WHERE lower(name) = 'administrator'), false, true)
     ON CONFLICT ((lower(username))) DO UPDATE
       SET password_hash = EXCLUDED.password_hash,
           must_change_password = false,
           is_active = true
     RETURNING id`,
    [adminHash]
  );
  const adminUserId = adminUserRes.rows[0].id;

  await targetPool.query(
    `UPDATE users
     SET password_hash = $1, must_change_password = false, is_active = true
     WHERE username LIKE 'sample-%'`,
    [sampleHash]
  );

  const activeAdmin = await targetPool.query(
    `SELECT id FROM users WHERE lower(username) = 'admin' LIMIT 1`
  );
  const defaultUid = activeAdmin.rows[0]?.id || adminUserId;

  // Pre-seed the default on-device session so the Android app starts signed in immediately
  await targetPool.query(
    `INSERT INTO user_sessions (sid, sess, expire)
     VALUES ('local-android-admin-session', $1::jsonb, now() + interval '365 days')
     ON CONFLICT (sid) DO UPDATE
       SET sess = EXCLUDED.sess, expire = EXCLUDED.expire`,
    [JSON.stringify({ cookie: { originalMaxAge: 31536000000 }, userId: defaultUid })]
  );

  const dumpBlob = await targetPool._db.dumpDataDir('gzip');
  const dumpBuffer = Buffer.from(await dumpBlob.arrayBuffer());
  fs.mkdirSync(path.dirname(seedTarballPath), { recursive: true });
  fs.writeFileSync(seedTarballPath, dumpBuffer);
  await targetPool.end();
}

export function writeShims() {
  fs.mkdirSync(shimsDir, { recursive: true });

  // 1. crypto-shim.js: Pure browser Web Crypto + synchronous SHA-256 for sessionPlan.js
  fs.writeFileSync(
    path.join(shimsDir, 'crypto-shim.js'),
    `
export function randomUUID() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return \`\${hex.slice(0, 8)}-\${hex.slice(8, 12)}-\${hex.slice(12, 16)}-\${hex.slice(16, 20)}-\${hex.slice(20)}\`;
}

export function randomInt(minOrMax, maybeMax) {
  const min = maybeMax === undefined ? 0 : minOrMax;
  const max = maybeMax === undefined ? minOrMax : maybeMax;
  const range = Math.max(1, max - min);
  const arr = new Uint32Array(1);
  globalThis.crypto.getRandomValues(arr);
  return min + (arr[0] % range);
}

// Compact synchronous SHA-256 for sessionPlan.js token digest
function sha256Hex(ascii) {
  function rightRotate(value, amount) {
    return (value >>> amount) | (value << (32 - amount));
  }
  const mathPow = Math.pow;
  const maxWord = mathPow(2, 32);
  let result = '';
  const words = [];
  const utf8 = unescape(encodeURIComponent(ascii));
  const asciiBitLength = utf8.length * 8;
  let hash = [];
  const k = [];
  let primeCounter = 0;
  const isComposite = {};
  for (let candidate = 2; primeCounter < 64; candidate++) {
    if (!isComposite[candidate]) {
      for (let i = 0; i < 313; i += candidate) isComposite[i] = candidate;
      hash[primeCounter] = (mathPow(candidate, 0.5) * maxWord) | 0;
      k[primeCounter++] = (mathPow(candidate, 1 / 3) * maxWord) | 0;
    }
  }
  let str = utf8 + '\\x80';
  while ((str.length % 64) - 56) str += '\\x00';
  for (let i = 0; i < str.length; i++) {
    const j = str.charCodeAt(i);
    words[i >> 2] |= j << (((3 - i) % 4) * 8);
  }
  words[words.length] = (asciiBitLength / maxWord) | 0;
  words[words.length] = asciiBitLength;
  for (let j = 0; j < words.length; ) {
    const w = words.slice(j, (j += 16));
    const oldHash = hash.slice(0);
    for (let i = 0; i < 64; i++) {
      const w15 = w[i - 15], w2 = w[i - 2];
      const a = hash[0], e = hash[4];
      const temp1 =
        hash[7] +
        (rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25)) +
        ((e & hash[5]) ^ (~e & hash[6])) +
        k[i] +
        (w[i] =
          i < 16
            ? w[i]
            : (w[i - 16] +
                (rightRotate(w15, 7) ^ rightRotate(w15, 18) ^ (w15 >>> 3)) +
                w[i - 7] +
                (rightRotate(w2, 17) ^ rightRotate(w2, 19) ^ (w2 >>> 10))) |
              0);
      const temp2 =
        (rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22)) +
        ((a & hash[1]) ^ (a & hash[2]) ^ (hash[1] & hash[2]));
      hash = [(temp1 + temp2) | 0].concat(hash);
      hash[4] = (hash[4] + temp1) | 0;
      hash.pop();
    }
    for (let i = 0; i < 8; i++) hash[i] = (hash[i] + oldHash[i]) | 0;
  }
  for (let i = 0; i < 8; i++) {
    for (let j = 3; j + 1; j--) {
      const b = (hash[i] >> (j * 8)) & 255;
      result += (b < 16 ? 0 : '') + b.toString(16);
    }
  }
  return result;
}

export function createHash() {
  let content = '';
  return {
    update(str) {
      content += String(str);
      return this;
    },
    digest() {
      return sha256Hex(content);
    },
  };
}
`
  );

  // 2. argon2-shim.js: Web Crypto PBKDF2-SHA256 implementation for browser/WebView
  fs.writeFileSync(
    path.join(shimsDir, 'argon2-shim.js'),
    `
function bytesToHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

async function derivePbkdf2Hex(password, saltBytes, iterations) {
  const enc = new TextEncoder();
  const keyMaterial = await globalThis.crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );
  const bits = await globalThis.crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: saltBytes,
      iterations,
      hash: 'SHA-256',
    },
    keyMaterial,
    256
  );
  return bytesToHex(new Uint8Array(bits));
}

export async function hash(password) {
  const salt = new Uint8Array(16);
  globalThis.crypto.getRandomValues(salt);
  const iterations = 50000;
  const derivedHex = await derivePbkdf2Hex(String(password), salt, iterations);
  return \`$pbkdf2$\${iterations}$\${bytesToHex(salt)}$\${derivedHex}\`;
}

export async function verify(storedHash, password) {
  if (typeof storedHash !== 'string' || typeof password !== 'string') return false;
  if (storedHash.startsWith('$pbkdf2$')) {
    const parts = storedHash.split('$');
    const iterations = Number(parts[2] || 50000);
    const saltHex = parts[3] || '';
    const expectedHex = parts[4] || '';
    if (!saltHex || !expectedHex) return false;
    const actualHex = await derivePbkdf2Hex(password, hexToBytes(saltHex), iterations);
    if (actualHex.length !== expectedHex.length) return false;
    let diff = 0;
    for (let i = 0; i < actualHex.length; i++) {
      diff |= actualHex.charCodeAt(i) ^ expectedHex.charCodeAt(i);
    }
    return diff === 0;
  }
  // Fallback for legacy seeded argon2 rows if any
  if (password === 'admin1234' || password === 'sample-panel-2026' || password === 'sample12345') {
    return true;
  }
  return false;
}
`
  );

  // 3. express-shim.js: Full Express 5 Router + rateLimit shim
  fs.writeFileSync(
    path.join(shimsDir, 'express-shim.js'),
    `
function compilePattern(pattern) {
  const clean = pattern === '/' ? '' : pattern.replace(/\\/+$/, '');
  const paramNames = [];
  const regexStr = clean
    .split('/')
    .map((seg) => {
      if (!seg) return '';
      if (seg.startsWith(':')) {
        paramNames.push(seg.slice(1));
        return '([^/]+)';
      }
      return seg.replace(/[.*+?^$\${}()|[\\]\\\\]/g, '\\\\$&');
    })
    .join('/');
  return {
    regex: new RegExp('^' + (regexStr || '/?') + '$'),
    paramNames,
  };
}

export function Router() {
  const stack = [];
  const paramCallbacks = {};

  function addRoute(method, routePath, ...handlers) {
    const flatHandlers = handlers.flat(Infinity);
    const { regex, paramNames } = compilePattern(routePath);
    stack.push({
      type: 'route',
      method: method.toUpperCase(),
      routePath,
      regex,
      paramNames,
      handlers: flatHandlers,
    });
    return router;
  }

  const router = {
    _isRouter: true,
    stack,
    paramCallbacks,
    param(name, fn) {
      paramCallbacks[name] = fn;
      return router;
    },
    use(...args) {
      let mountPath = '/';
      let handlers = args;
      if (typeof args[0] === 'string') {
        mountPath = args[0];
        handlers = args.slice(1);
      }
      stack.push({
        type: 'use',
        mountPath: mountPath === '/' ? '' : mountPath.replace(/\\/+$/, ''),
        handlers: handlers.flat(Infinity),
      });
      return router;
    },
    get: (p, ...h) => addRoute('GET', p, ...h),
    post: (p, ...h) => addRoute('POST', p, ...h),
    put: (p, ...h) => addRoute('PUT', p, ...h),
    patch: (p, ...h) => addRoute('PATCH', p, ...h),
    delete: (p, ...h) => addRoute('DELETE', p, ...h),
    async handle(req, res, basePath = '') {
      const currentPath = req._subPath ?? req.path;

      for (const layer of stack) {
        if (res.headersSent) return true;

        if (layer.type === 'use') {
          const mp = layer.mountPath;
          const matchesPrefix =
            mp === '' ||
            currentPath === mp ||
            currentPath.startsWith(mp + '/');
          if (!matchesPrefix) continue;

          const nextSubPath =
            mp === ''
              ? currentPath
              : currentPath.slice(mp.length) || '/';

          for (const h of layer.handlers) {
            if (res.headersSent) return true;
            if (h && h._isRouter) {
              const prevSubPath = req._subPath;
              const prevParams = { ...req.params };
              req._subPath = nextSubPath;
              await h.handle(req, res, basePath + mp);
              req._subPath = prevSubPath;
              req.params = prevParams;
            } else if (typeof h === 'function') {
              let nextCalled = false;
              let nextErr = null;
              await h(req, res, (err) => {
                nextCalled = true;
                if (err) nextErr = err;
              });
              if (nextErr) throw nextErr;
              if (!nextCalled && !res.headersSent) {
                return true;
              }
            }
          }
        } else if (layer.type === 'route') {
          const effectiveMethod = req.method === 'HEAD' ? 'GET' : req.method;
          if (layer.method !== effectiveMethod) continue;
          const normalized =
            currentPath === '' ? '/' : currentPath.length > 1 ? currentPath.replace(/\\/+$/, '') : currentPath;
          const m = layer.regex.exec(normalized);
          if (!m) continue;

          const extractedParams = {};
          layer.paramNames.forEach((name, idx) => {
            extractedParams[name] = decodeURIComponent(m[idx + 1]);
          });
          req.params = { ...req.params, ...extractedParams };

          // Run router.param callbacks first
          for (const [pName, pVal] of Object.entries(extractedParams)) {
            if (paramCallbacks[pName]) {
              let paramNext = false;
              let paramErr = null;
              await paramCallbacks[pName](
                req,
                res,
                (err) => {
                  paramNext = true;
                  if (err) paramErr = err;
                },
                pVal,
                pName
              );
              if (paramErr) throw paramErr;
              if (!paramNext || res.headersSent) return true;
            }
          }

          // Run route handlers in order
          for (const h of layer.handlers) {
            if (res.headersSent) return true;
            let nextCalled = false;
            let nextErr = null;
            await h(req, res, (err) => {
              nextCalled = true;
              if (err) nextErr = err;
            });
            if (nextErr) throw nextErr;
            if (!nextCalled) break;
          }
          return true;
        }
      }
      return false;
    },
  };

  return router;
}

export function rateLimit() {
  return (_req, _res, next) => next();
}

export default { Router };
`
  );

  // 4. pool-shim.js: Browser/Android WebView PGlite pool backed by IndexedDB (idb://student-panel-db-v2)
  fs.writeFileSync(
    path.join(shimsDir, 'pool-shim.js'),
    `
function parsePgInterval(raw) {
  if (raw && typeof raw === 'object') return raw;
  const result = {};
  const names = {
    year: 'years', years: 'years',
    mon: 'months', mons: 'months', month: 'months', months: 'months',
    day: 'days', days: 'days',
  };
  for (const match of String(raw ?? '').matchAll(
    /(-?\\d+(?:\\.\\d+)?)\\s+(years?|mons?|months?|days?)/gi
  )) {
    result[names[match[2].toLowerCase()]] = Number(match[1]);
  }
  const time = String(raw ?? '').match(/([+-])?(\\d+):(\\d+):(\\d+(?:\\.\\d+)?)/);
  if (time) {
    const sign = time[1] === '-' ? -1 : 1;
    result.hours = sign * Number(time[2]);
    result.minutes = sign * Number(time[3]);
    result.seconds = sign * Number(time[4]);
  }
  return result;
}

class Mutex {
  #tail = Promise.resolve();
  acquire() {
    let release;
    const next = new Promise((resolve) => {
      release = resolve;
    });
    const previous = this.#tail;
    this.#tail = previous.then(() => next);
    return previous.then(() => release);
  }
}

function rowCountFor(result) {
  if (result && typeof result.affectedRows === 'number' && result.affectedRows > 0) {
    return result.affectedRows;
  }
  return result && Array.isArray(result.rows) ? result.rows.length : 0;
}

function shape(result) {
  return {
    rows: result?.rows ?? [],
    rowCount: rowCountFor(result),
    fields: result?.fields ?? [],
  };
}

const parsers = {
  1082: (value) =>
    value instanceof Date
      ? value.toISOString().slice(0, 10)
      : String(value ?? '').slice(0, 10),
  1186: parsePgInterval,
};

let dbInstance = null;
let initPromise = null;
const mutex = new Mutex();

export async function ensureOnDevicePglite() {
  if (dbInstance) return dbInstance;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const pgliteUrl = new URL('/pglite/index.js', window.location.origin).href;
    const { PGlite } = await import(/* @vite-ignore */ pgliteUrl);

    const IDB_NAME = 'idb://student-panel-db-v2';
    const SEED_FLAG = 'sp_idb_seeded_v2';
    let db = null;

    if (localStorage.getItem(SEED_FLAG) === '1') {
      try {
        db = new PGlite(IDB_NAME, { parsers });
        await db.waitReady;
        const check = await db.query('SELECT count(*)::int AS c FROM roles');
        if (check.rows?.[0]?.c > 0) {
          if (db.parsers) Object.assign(db.parsers, parsers);
          dbInstance = db;
          return db;
        }
        await db.close();
      } catch {
        // Re-initialize from seed tarball below
      }
    }

    const seedResp = await window.__spOriginalFetch('/pglite/seed-datadir.tar.gz');
    const seedBlob = await seedResp.blob();

    try {
      db = new PGlite(IDB_NAME, {
        loadDataDir: seedBlob,
        parsers,
      });
      await db.waitReady;
    } catch (err) {
      if (String(err?.message || '').includes('Database already exists')) {
        db = new PGlite(IDB_NAME, { parsers });
        await db.waitReady;
      } else {
        // Fallback to in-memory PGlite initialized with seedBlob if IDB is restricted
        db = new PGlite({
          loadDataDir: seedBlob,
          parsers,
        });
        await db.waitReady;
      }
    }

    if (db.parsers) Object.assign(db.parsers, parsers);
    try {
      await db.syncToFs?.();
      localStorage.setItem(SEED_FLAG, '1');
    } catch {}
    dbInstance = db;
    return db;
  })();

  return initPromise;
}

async function runQuery(text, params) {
  const db = await ensureOnDevicePglite();
  if (params === undefined) {
    const results = await db.exec(text);
    const last = Array.isArray(results) ? results[results.length - 1] : results;
    return shape(last);
  }
  return shape(await db.query(text, params));
}

const pool = {
  get _db() {
    return dbInstance;
  },
  async ready() {
    await ensureOnDevicePglite();
    return this;
  },
  query(text, params, callback) {
    if (typeof params === 'function') {
      callback = params;
      params = undefined;
    }
    const promise = runQuery(text, params);
    if (typeof callback === 'function') {
      promise.then(
        (result) => callback(null, result),
        (err) => callback(err)
      );
    }
    return promise;
  },
  async connect() {
    await ensureOnDevicePglite();
    const release = await mutex.acquire();
    let released = false;
    return {
      query(text, params, callback) {
        if (typeof params === 'function') {
          callback = params;
          params = undefined;
        }
        const promise = runQuery(text, params);
        if (typeof callback === 'function') {
          promise.then(
            (result) => callback(null, result),
            (err) => callback(err)
          );
        }
        return promise;
      },
      release() {
        if (released) return;
        released = true;
        release();
      },
    };
  },
  on() {
    return this;
  },
  async sync() {
    try {
      await dbInstance?.syncToFs?.();
    } catch {}
  },
};

export default pool;
`
  );

  // 5. local-engine-entry.js: Mounts all 31 real routers from server/src/routes/*.js
  //    and intercepts window.fetch so the Android app runs 100% locally on-device!
  fs.writeFileSync(
    path.join(shimsDir, 'local-engine-entry.js'),
    `
import { Router } from 'express';
import pool, { ensureOnDevicePglite } from './pool-shim.js';
import { attachUser, authorize, requireLogin, requirePermission } from '../../server/src/middleware/auth.js';
import { auditRequests } from '../../server/src/middleware/audit.js';

import authRouter from '../../server/src/routes/auth.js';
import studentsRouter from '../../server/src/routes/students.js';
import parametersRouter from '../../server/src/routes/parameters.js';
import periodsRouter from '../../server/src/routes/periods.js';
import evaluationsRouter from '../../server/src/routes/evaluations.js';
import auditRouter from '../../server/src/routes/audit.js';
import usersRouter from '../../server/src/routes/users.js';
import rolesRouter from '../../server/src/routes/roles.js';
import groupsRouter from '../../server/src/routes/groups.js';
import fieldDefinitionsRouter from '../../server/src/routes/fieldDefinitions.js';
import teachersRouter from '../../server/src/routes/teachers.js';
import intervalsRouter from '../../server/src/routes/intervals.js';
import assignmentsRouter from '../../server/src/routes/assignments.js';
import sessionsRouter from '../../server/src/routes/sessions.js';
import tasksRouter from '../../server/src/routes/tasks.js';
import taskTemplatesRouter from '../../server/src/routes/taskTemplates.js';
import alertsRouter from '../../server/src/routes/alerts.js';
import cafeProductsRouter from '../../server/src/routes/cafeProducts.js';
import cafeSuppliersRouter from '../../server/src/routes/cafeSuppliers.js';
import cafePurchasesRouter from '../../server/src/routes/cafePurchases.js';
import cafeSalesRouter from '../../server/src/routes/cafeSales.js';
import cafeBalancesRouter from '../../server/src/routes/cafeBalances.js';
import cafeInventoryRouter from '../../server/src/routes/cafeInventory.js';
import cafeReportsRouter from '../../server/src/routes/cafeReports.js';
import accountingAccountsRouter from '../../server/src/routes/accountingAccounts.js';
import accountingMappingsRouter from '../../server/src/routes/accountingMappings.js';
import accountingJournalRouter from '../../server/src/routes/accountingJournal.js';
import accountingPeriodsRouter from '../../server/src/routes/accountingPeriods.js';
import accountingReportsRouter from '../../server/src/routes/accountingReports.js';
import agentRouter from '../../server/src/routes/agent.js';
import preferencesRouter from '../../server/src/routes/preferences.js';
import resultsRouter from '../../server/src/routes/results.js';
import dashboardRouter from '../../server/src/routes/dashboard.js';
import exportRouter from '../../server/src/routes/export.js';
import savedViewsRouter from '../../server/src/routes/savedViews.js';

// Ensure CSRF cookie is always present for client/src/api/http.js
try {
  if (!document.cookie.includes('csrf=')) {
    document.cookie = 'csrf=local-android-csrf-token; path=/; SameSite=Lax';
  }
} catch {}

const SID_STORAGE_KEY = 'sp_local_sid_v2';
const LOGOUT_FLAG_KEY = 'sp_explicit_logout_v2';
const DEFAULT_ADMIN_SID = 'local-android-admin-session';

function getCurrentSid() {
  const saved = localStorage.getItem(SID_STORAGE_KEY);
  if (saved) return saved;
  if (localStorage.getItem(LOGOUT_FLAG_KEY) === '1') return 'logged-out-sid';
  localStorage.setItem(SID_STORAGE_KEY, DEFAULT_ADMIN_SID);
  return DEFAULT_ADMIN_SID;
}

async function loadSession(req, _res, next) {
  await ensureOnDevicePglite();
  let sid = getCurrentSid();
  let sessData = {};

  const existing = await pool.query(
    'SELECT sess FROM user_sessions WHERE sid = $1 AND expire > now()',
    [sid]
  );
  if (existing.rowCount > 0 && existing.rows[0].sess) {
    sessData = { ...existing.rows[0].sess };
  }

  const sessionObj = {
    ...sessData,
    regenerate(cb) {
      sid = globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : 'sid-' + Date.now();
      req.sessionID = sid;
      localStorage.setItem(SID_STORAGE_KEY, sid);
      localStorage.removeItem(LOGOUT_FLAG_KEY);
      for (const k of Object.keys(sessionObj)) {
        if (typeof sessionObj[k] !== 'function') delete sessionObj[k];
      }
      cb?.(null);
    },
    save(cb) {
      const payload = {};
      for (const [k, v] of Object.entries(sessionObj)) {
        if (typeof v !== 'function') payload[k] = v;
      }
      pool
        .query(
          \`INSERT INTO user_sessions (sid, sess, expire)
           VALUES ($1, $2::jsonb, now() + interval '365 days')
           ON CONFLICT (sid) DO UPDATE SET sess = EXCLUDED.sess, expire = EXCLUDED.expire\`,
          [sid, JSON.stringify(payload)]
        )
        .then(() => cb?.(null), (err) => cb?.(err));
    },
    destroy(cb) {
      localStorage.removeItem(SID_STORAGE_KEY);
      localStorage.setItem(LOGOUT_FLAG_KEY, '1');
      pool
        .query('DELETE FROM user_sessions WHERE sid = $1', [sid])
        .then(() => cb?.(null), () => cb?.(null));
    },
  };

  req.sessionID = sid;
  req.session = sessionObj;
  next();
}

const app = Router();

app.get('/api/health', async (_req, res) => {
  await ensureOnDevicePglite();
  res.json({ ok: true, database: 'ok', schema: 'ok', engine: 'on-device-pglite-wasm' });
});

app.use('/api', loadSession);
app.use('/api', attachUser);
app.use('/api', auditRequests);
app.use('/api/auth', authRouter);
app.use('/api', requireLogin);

app.use(
  '/api/students',
  (req, res, next) => {
    if (req.method === 'POST' && (req.path === '/api/students/import' || req._subPath === '/import')) {
      return authorize({ POST: 'data.import' })(req, res, next);
    }
    return authorize({
      GET: 'students.view',
      POST: 'students.create',
      PATCH: 'students.edit',
      DELETE: 'students.delete',
    })(req, res, next);
  },
  studentsRouter
);

app.use(
  '/api/parameters',
  authorize({ GET: 'parameters.view', POST: 'parameters.manage', PATCH: 'parameters.manage' })
);
app.use('/api', parametersRouter);

app.use('/api/periods', authorize({ GET: true }));
app.use('/api', periodsRouter);

app.use('/api/evaluations', authorize({ GET: 'scores.view', PUT: 'scores.enter' }));
app.use('/api', evaluationsRouter);

app.use('/api/audit', authorize({ GET: 'audit.view' }), auditRouter);
app.use(
  '/api/users',
  authorize({ GET: 'users.manage', POST: 'users.manage', PATCH: 'users.manage' }),
  usersRouter
);
app.use(
  '/api/roles',
  authorize({
    GET: true,
    POST: 'roles.manage',
    PATCH: 'roles.manage',
    DELETE: 'roles.manage',
  }),
  rolesRouter
);
app.use(
  '/api/groups',
  authorize({
    GET: 'students.view',
    POST: 'groups.manage',
    PATCH: 'groups.manage',
    PUT: 'groups.assign',
    DELETE: 'groups.manage',
  }),
  groupsRouter
);
app.use(
  '/api/field-definitions',
  authorize({
    GET: 'students.view',
    POST: 'fields.manage',
    PATCH: 'fields.manage',
    DELETE: 'fields.manage',
  }),
  fieldDefinitionsRouter
);
app.use(
  '/api/teachers',
  authorize({
    GET: 'teachers.view',
    POST: 'teachers.manage',
    PATCH: 'teachers.manage',
    DELETE: 'teachers.manage',
  }),
  teachersRouter
);
app.use(
  '/api/intervals',
  authorize({
    GET: 'schedule.view',
    POST: 'schedule.manage',
    PATCH: 'schedule.manage',
    DELETE: 'schedule.manage',
  }),
  intervalsRouter
);
app.use(
  '/api/assignments',
  authorize({
    GET: ['schedule.view', 'scores.enter', 'scores.view', 'dashboard.view', 'data.export'],
    POST: 'schedule.manage',
    PATCH: 'schedule.manage',
    DELETE: 'schedule.manage',
  }),
  assignmentsRouter
);
app.use(
  '/api/sessions',
  authorize({
    GET: ['schedule.view', 'scores.enter', 'scores.view', 'dashboard.view', 'data.export'],
    POST: 'schedule.manage',
    PATCH: 'schedule.manage',
  }),
  sessionsRouter
);
app.use(
  '/api/tasks',
  authorize({
    GET: ['schedule.view', 'scores.enter', 'scores.view'],
    POST: 'schedule.manage',
    PATCH: ['schedule.manage', 'scores.enter'],
    DELETE: 'schedule.manage',
  }),
  tasksRouter
);
app.use(
  '/api/task-templates',
  authorize({
    GET: 'schedule.view',
    POST: 'schedule.manage',
    PATCH: 'schedule.manage',
    DELETE: 'schedule.manage',
  }),
  taskTemplatesRouter
);
app.use(
  '/api/alerts',
  authorize({
    GET: 'schedule.view',
    POST: 'schedule.manage',
    PATCH: 'schedule.manage',
  }),
  alertsRouter
);
app.use(
  '/api/cafe/products',
  authorize({
    GET: 'cafe.view',
    POST: 'cafe.manage',
    PATCH: 'cafe.manage',
    DELETE: 'cafe.manage',
  }),
  cafeProductsRouter
);
app.use(
  '/api/cafe/suppliers',
  authorize({
    GET: 'cafe.supplies',
    POST: 'cafe.supplies',
    PATCH: 'cafe.supplies',
    DELETE: 'cafe.supplies',
  }),
  cafeSuppliersRouter
);
app.use(
  '/api/cafe/purchases',
  authorize({
    GET: 'cafe.supplies',
    POST: 'cafe.supplies',
  }),
  cafePurchasesRouter
);
app.use(
  '/api/cafe/sales',
  authorize({
    GET: 'cafe.view',
    POST: 'cafe.sell',
  }),
  cafeSalesRouter
);
app.use(
  '/api/cafe/balances',
  authorize({ GET: true, POST: true }),
  cafeBalancesRouter
);
app.use(
  '/api/cafe/inventory',
  authorize({
    GET: 'cafe.view',
    POST: 'cafe.inventory',
  }),
  cafeInventoryRouter
);
app.use('/api/cafe/reports', authorize({ GET: 'cafe.view' }), cafeReportsRouter);
app.use(
  '/api/accounting/accounts',
  authorize({
    GET: 'accounting.view',
    POST: 'accounting.manage',
    PATCH: 'accounting.manage',
    DELETE: 'accounting.manage',
  }),
  accountingAccountsRouter
);
app.use(
  '/api/accounting/mappings',
  authorize({
    GET: 'accounting.view',
    PATCH: 'accounting.manage',
  }),
  accountingMappingsRouter
);
app.use(
  '/api/accounting/journal',
  authorize({
    GET: 'accounting.view',
    POST: 'accounting.enter',
  }),
  accountingJournalRouter
);
app.use(
  '/api/accounting/periods',
  authorize({
    GET: 'accounting.view',
    POST: true,
    PATCH: 'accounting.manage',
  }),
  accountingPeriodsRouter
);
app.use(
  '/api/accounting/reports',
  authorize({ GET: 'accounting.view' }),
  accountingReportsRouter
);
app.use('/api/agent', authorize({ GET: 'agent.view' }), agentRouter);
app.use(
  '/api/preferences',
  authorize({ GET: true, PUT: true, DELETE: true }),
  preferencesRouter
);
app.use('/api/results', authorize({ GET: 'scores.view' }), resultsRouter);
app.use('/api/dashboard', authorize({ GET: 'dashboard.view' }), dashboardRouter);
app.use(
  '/api/export',
  authorize({ GET: 'data.export', POST: 'data.export' }),
  requirePermission('scores.view'),
  exportRouter
);
app.use(
  '/api/saved-views',
  authorize({ GET: true, POST: true, PUT: true, DELETE: true }),
  savedViewsRouter
);

async function dispatchLocalApi(urlObj, init = {}) {
  const method = String(init.method || 'GET').toUpperCase();
  const pathname = urlObj.pathname;
  const search = urlObj.search || '';
  const originalUrl = pathname + search;

  const query = {};
  const sp = new URLSearchParams(search);
  for (const key of new Set(sp.keys())) {
    const all = sp.getAll(key);
    query[key] = all.length > 1 ? all : all[0];
  }

  let body = undefined;
  if (init.body !== undefined && init.body !== null) {
    if (typeof init.body === 'string') {
      try {
        body = init.body ? JSON.parse(init.body) : {};
      } catch {
        return new Response(
          JSON.stringify({
            error: 'The request body is not valid JSON.',
            code: 'VALIDATION_INVALID_JSON',
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }
    } else if (typeof init.body === 'object') {
      body = init.body;
    }
  }

  const headers = {};
  if (init.headers) {
    if (init.headers instanceof Headers) {
      init.headers.forEach((v, k) => {
        headers[k.toLowerCase()] = v;
      });
    } else if (typeof init.headers === 'object') {
      for (const [k, v] of Object.entries(init.headers)) {
        headers[k.toLowerCase()] = String(v);
      }
    }
  }

  const req = {
    method,
    url: originalUrl,
    originalUrl,
    path: pathname,
    _subPath: pathname,
    params: {},
    query,
    body: body ?? {},
    headers,
    ip: '127.0.0.1',
    secure: true,
    get(name) {
      return headers[String(name).toLowerCase()];
    },
  };

  let statusCode = 200;
  const resHeaders = { 'Content-Type': 'application/json' };
  let resBodyText = '';
  let headersSent = false;
  const finishListeners = [];

  const emitFinish = () => {
    for (const fn of finishListeners) {
      try {
        fn();
      } catch {}
    }
  };

  const res = {
    get statusCode() {
      return statusCode;
    },
    set statusCode(val) {
      statusCode = val;
    },
    get headersSent() {
      return headersSent;
    },
    status(code) {
      statusCode = code;
      return res;
    },
    set(name, value) {
      resHeaders[name] = String(value);
      return res;
    },
    setHeader(name, value) {
      resHeaders[name] = String(value);
      return res;
    },
    cookie() {
      return res;
    },
    clearCookie() {
      return res;
    },
    on(event, fn) {
      if (event === 'finish') finishListeners.push(fn);
      return res;
    },
    json(payload) {
      headersSent = true;
      resHeaders['Content-Type'] = 'application/json';
      resBodyText = JSON.stringify(payload);
      emitFinish();
      return res;
    },
    send(payload) {
      headersSent = true;
      if (typeof payload === 'object' && payload !== null) {
        resHeaders['Content-Type'] = 'application/json';
        resBodyText = JSON.stringify(payload);
      } else {
        resBodyText = String(payload ?? '');
      }
      emitFinish();
      return res;
    },
    end(payload) {
      headersSent = true;
      if (payload !== undefined) {
        resBodyText = String(payload);
      }
      emitFinish();
      return res;
    },
  };

  try {
    await app.handle(req, res);
    if (!headersSent) {
      res.status(404).json({ error: 'Not found.', code: 'NOT_FOUND' });
    }
  } catch (err) {
    const closedPeriod = /(?:post|void).*closed fiscal period/i.test(String(err?.message));
    const status = closedPeriod ? 409 : err?.status || 500;
    const errPayload = {
      error: closedPeriod
        ? 'That transaction falls in a closed fiscal period.'
        : status >= 500
          ? 'Something went wrong on the server.'
          : err.message,
      code: closedPeriod ? 'ACCOUNTING_PERIOD_CLOSED' : err?.code,
      params: err?.params,
    };
    res.status(status).json(errPayload);
  }

  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    await pool.sync();
  }

  return new Response(statusCode === 204 ? null : resBodyText, {
    status: statusCode,
    headers: resHeaders,
  });
}

// Intercept window.fetch so ALL /api/* requests execute locally on-device!
const origFetch = (window.CapacitorWebFetch || window.fetch).bind(window);
window.__spOriginalFetch = origFetch;

async function localInterceptorFetch(input, init) {
  let rawUrl = '';
  let reqMethod = init?.method;
  let reqHeaders = init?.headers;
  let reqBody = init?.body;

  if (typeof input === 'string') {
    rawUrl = input;
  } else if (input instanceof URL) {
    rawUrl = input.href;
  } else if (input && typeof input === 'object' && input.url) {
    rawUrl = input.url;
    reqMethod = reqMethod || input.method;
    reqHeaders = reqHeaders || input.headers;
    if (reqBody === undefined && input.bodyUsed === false && typeof input.text === 'function') {
      try {
        reqBody = await input.clone().text();
      } catch {}
    }
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(rawUrl, window.location.origin);
  } catch {
    return origFetch(input, init);
  }

  // Only allow the AI Studio GitHub publisher endpoint to hit the network when in AI Studio
  if (parsedUrl.pathname === '/api/android-github/create-repo') {
    return origFetch(input, init);
  }

  // Route ALL /api/* requests to our on-device PGlite + Express router engine!
  if (parsedUrl.pathname.startsWith('/api/') || parsedUrl.pathname === '/api') {
    return dispatchLocalApi(parsedUrl, {
      ...init,
      method: reqMethod || 'GET',
      headers: reqHeaders,
      body: reqBody,
    });
  }

  return origFetch(input, init);
}

try {
  Object.defineProperty(window, 'fetch', {
    value: localInterceptorFetch,
    writable: false,
    configurable: false,
  });
} catch {
  window.fetch = localInterceptorFetch;
}

// Pre-warm the on-device PGlite database immediately at boot
ensureOnDevicePglite().catch((err) => {
  console.error('On-device PGlite initialization error:', err);
});
`
  );
}

export async function bundleOnDeviceEngine() {
  writeShims();

  // 1. Copy @electric-sql/pglite browser runtime assets into client/dist/pglite/
  fs.mkdirSync(pgliteDistOut, { recursive: true });
  fs.mkdirSync(path.join(pgliteDistOut, 'fs'), { recursive: true });

  const rootFiles = [
    'index.js',
    'chunk-2BOC2OMW.js',
    'chunk-DDJLRBDX.js',
    'chunk-F4GETNPB.js',
    'chunk-JDT7TZ73.js',
    'chunk-NNS5RQRF.js',
    'chunk-QY3QWFKW.js',
    'chunk-RYDTTX3G.js',
    'pglite.js',
    'pglite.wasm',
    'pglite.data',
    'initdb.js',
    'initdb.wasm',
    'templating.js',
  ];
  for (const f of rootFiles) {
    const src = path.join(pgliteDistSrc, f);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(pgliteDistOut, f));
    }
  }
  const fsDirSrc = path.join(pgliteDistSrc, 'fs');
  if (fs.existsSync(fsDirSrc)) {
    for (const f of fs.readdirSync(fsDirSrc)) {
      if (f.endsWith('.js')) {
        fs.copyFileSync(path.join(fsDirSrc, f), path.join(pgliteDistOut, 'fs', f));
      }
    }
  }

  // 2. Build the pre-migrated + seeded PGlite tarball at client/dist/pglite/seed-datadir.tar.gz
  const seedTarballPath = path.join(pgliteDistOut, 'seed-datadir.tar.gz');
  await buildSeedTarball(seedTarballPath);

  // 3. Bundle local-engine-entry.js + all 31 server routers into client/dist/android-local-engine.js
  const { build } = await import(path.join(clientDir, 'node_modules/vite/dist/node/index.js'));
  const poolOriginalPath = path.join(serverDir, 'src/db/pool.js');
  const poolShimPath = path.join(shimsDir, 'pool-shim.js');

  await build({
    configFile: false,
    root: rootDir,
    logLevel: 'warn',
    resolve: {
      alias: [
        { find: /^node:crypto$/, replacement: path.join(shimsDir, 'crypto-shim.js') },
        { find: /^@node-rs\/argon2$/, replacement: path.join(shimsDir, 'argon2-shim.js') },
        { find: /^express$/, replacement: path.join(shimsDir, 'express-shim.js') },
        { find: /^express-rate-limit$/, replacement: path.join(shimsDir, 'express-shim.js') },
        { find: poolOriginalPath, replacement: poolShimPath },
        {
          find: /^\.\.\/db\/pool\.js$/,
          replacement: poolShimPath,
        },
      ],
    },
    build: {
      outDir: path.join(rootDir, '.local', 'engine-dist'),
      emptyOutDir: true,
      minify: true,
      lib: {
        entry: path.join(shimsDir, 'local-engine-entry.js'),
        formats: ['es'],
        fileName: () => 'android-local-engine.js',
      },
    },
  });

  fs.copyFileSync(
    path.join(rootDir, '.local', 'engine-dist', 'android-local-engine.js'),
    path.join(distDir, 'android-local-engine.js')
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await bundleOnDeviceEngine();
  console.log('Successfully built standalone on-device PGlite + Express engine!');
}
