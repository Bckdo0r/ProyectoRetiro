const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3000);
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';
const SESSION_DURATION_MS = 1000 * 60 * 60 * 24;
const BODY_SIZE_LIMIT = 1_000_000;
const IS_PROD = process.env.NODE_ENV === 'production';
const SESSION_CLEANUP_INTERVAL_MS = 1000 * 60 * 10;

if (IS_PROD && !process.env.ADMIN_PASS) {
  throw new Error('ADMIN_PASS es obligatoria en producción');
}
const ROOT_DIR = __dirname;
const DATA_DIR = path.join(ROOT_DIR, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const ARCHIVE_DIR = path.join(DATA_DIR, 'archives');

const sessions = new Map();

function seedState() {
  const rooms = [];
  let nRId = 1;
  for (let i = 1; i <= 34; i += 1) {
    rooms.push({ id: nRId++, nombre: `Habitación ${i}`, sector: 'CG', capacidad: 4, personas: [] });
  }
  for (let i = 1; i <= 4; i += 1) {
    rooms.push({ id: nRId++, nombre: `Chalecito ${i}`, sector: 'CH', capacidad: 4, personas: [] });
  }
  return {
    rooms,
    people: [],
    retiro: { total: 0, menor: 0 },
    nRId,
    nPId: 1,
  };
}

function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
}

function readState() {
  ensureDirs();
  if (!fs.existsSync(STATE_FILE)) {
    const initial = seedState();
    fs.writeFileSync(STATE_FILE, JSON.stringify(initial, null, 2), 'utf-8');
    return initial;
  }
  const raw = fs.readFileSync(STATE_FILE, 'utf-8');
  const data = JSON.parse(raw);
  if (!data || typeof data !== 'object') return seedState();
  return data;
}

function writeState(state) {
  ensureDirs();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

function json(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > BODY_SIZE_LIMIT) {
        req.destroy();
        reject(new Error('Payload demasiado grande'));
      }
    });
    req.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (_err) {
        reject(new Error('JSON inválido'));
      }
    });
    req.on('error', reject);
  });
}

function issueToken(username) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { username, expiresAt: Date.now() + SESSION_DURATION_MS });
  return token;
}

function safeCompare(input, expected) {
  const left = Buffer.from(String(input || ''), 'utf-8');
  const right = Buffer.from(String(expected || ''), 'utf-8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function getAuth(req) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token || !sessions.has(token)) return null;
  const session = sessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return { token, ...session };
}

function cleanupExpiredSessions() {
  const now = Date.now();
  for (const [token, session] of sessions.entries()) {
    if (!session || session.expiresAt < now) {
      sessions.delete(token);
    }
  }
}

function sanitizeState(input) {
  if (!input || typeof input !== 'object') throw new Error('Estado inválido');
  const rooms = Array.isArray(input.rooms) ? input.rooms : [];
  const people = Array.isArray(input.people) ? input.people : [];
  const retiro = input.retiro && typeof input.retiro === 'object' ? input.retiro : { total: 0, menor: 0 };
  return {
    rooms,
    people,
    retiro,
    nRId: Number(input.nRId || 1),
    nPId: Number(input.nPId || 1),
  };
}

function normalizeHouse(house) {
  const safeHouse = String(house || 'Villa Marista')
    .replace(/[^a-zA-Z0-9\s-]/g, '')
    .trim()
    .slice(0, 40);
  return safeHouse || 'Villa Marista';
}

function archiveCurrentState(house) {
  const state = readState();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeHouse = normalizeHouse(house);
  const slug = safeHouse.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
  const archiveName = `${timestamp}-${slug}.json`;
  const archivePath = path.join(ARCHIVE_DIR, archiveName);
  fs.writeFileSync(archivePath, JSON.stringify({ archivedAt: new Date().toISOString(), house: safeHouse, state }, null, 2), 'utf-8');
  return archiveName;
}

function safePath(urlPath) {
  if (urlPath === '/') return path.join(ROOT_DIR, 'index.html');
  const cleanPath = path.normalize(urlPath).replace(/^\/+/, '');
  const abs = path.join(ROOT_DIR, cleanPath);
  if (!abs.startsWith(ROOT_DIR)) return null;
  return abs;
}

function contentType(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.js')) return 'application/javascript; charset=utf-8';
  if (filePath.endsWith('.json')) return 'application/json; charset=utf-8';
  if (filePath.endsWith('.ico')) return 'image/x-icon';
  return 'text/plain; charset=utf-8';
}

const server = http.createServer(async (req, res) => {
  try {
    const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const { pathname } = reqUrl;

    if (pathname === '/api/health' && req.method === 'GET') {
      return json(res, 200, { ok: true });
    }

    if (pathname === '/api/login' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (!safeCompare(body.username, ADMIN_USER) || !safeCompare(body.password, ADMIN_PASS)) {
        return json(res, 401, { message: 'Credenciales inválidas' });
      }
      const token = issueToken(body.username);
      return json(res, 200, { token, user: { username: body.username, role: 'admin' } });
    }

    if (pathname.startsWith('/api/')) {
      const auth = getAuth(req);
      if (!auth) {
        return json(res, 401, { message: 'Sesión inválida o expirada' });
      }

      if (pathname === '/api/session' && req.method === 'GET') {
        return json(res, 200, { ok: true, user: { username: auth.username, role: 'admin' } });
      }

      if (pathname === '/api/state' && req.method === 'GET') {
        return json(res, 200, readState());
      }

      if (pathname === '/api/state' && req.method === 'PUT') {
        const body = await readJsonBody(req);
        const state = sanitizeState(body);
        writeState(state);
        return json(res, 200, { ok: true });
      }

      if (pathname === '/api/archive' && req.method === 'POST') {
        const body = await readJsonBody(req);
        const archiveName = archiveCurrentState(body.house || 'Villa Marista');
        return json(res, 200, { ok: true, archiveName });
      }

      if (pathname === '/api/reset' && req.method === 'POST') {
        const current = readState();
        const next = {
          ...current,
          people: [],
          nPId: 1,
          rooms: Array.isArray(current.rooms)
            ? current.rooms.map((room) => ({ ...room, personas: [] }))
            : [],
        };
        writeState(next);
        return json(res, 200, next);
      }

      return json(res, 404, { message: 'Endpoint no encontrado' });
    }

    const filePath = safePath(pathname);
    if (!filePath || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }

    const data = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': contentType(filePath) });
    res.end(data);
  } catch (error) {
    json(res, 500, { message: error.message || 'Error interno del servidor' });
  }
});

server.listen(PORT, () => {
  console.log(`Servidor iniciado en http://localhost:${PORT}`);
  if (!process.env.ADMIN_PASS) {
    console.warn('⚠️  ADMIN_PASS no está configurada. Se está usando una contraseña por defecto solo para desarrollo.');
  }
});

setInterval(cleanupExpiredSessions, SESSION_CLEANUP_INTERVAL_MS);
