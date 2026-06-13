/**
 * BARBER VIP — server.js
 * Backend API para Render (Node 22.x + PostgreSQL + Socket.io)
 *
 * Arranque local:   node server.js
 * Desarrollo:       npm run dev
 * Render:           Build = npm install · Start = node server.js
 *                   (sin cambios respecto al despliegue anterior)
 */

require('dotenv').config();

const express   = require('express');
const http      = require('http');
const cors      = require('cors');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');
const path      = require('path');
const fs        = require('fs');
const { Server } = require('socket.io');

// ── Inicializar esquema de BD (PostgreSQL) ───────────────
const { initDatabase } = require('./db/setup');

// ── Importar rutas ───────────────────────────────────────
const authRoutes  = require('./routes/auth');
const citasRoutes = require('./routes/citas');
const adminRoutes = require('./routes/admin');

// ════════════════════════════════════════════════════════
const app  = express();
const PORT = process.env.PORT || 4000;

// ── CORS ─────────────────────────────────────────────────
const rawOrigins = (process.env.FRONTEND_URL || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const ALLOWED_ORIGINS = [
  ...rawOrigins,
  'http://localhost:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  'http://127.0.0.1:3000',
  'https://barbervip.netlify.app',   // ← tu dominio Netlify
];

const corsOriginFn = function(origin, cb) {
  // Sin origin = Postman, curl, mismo servidor
  if (!origin) return cb(null, true);
  // En desarrollo acepta cualquier localhost
  if (process.env.NODE_ENV !== 'production' && /localhost|127\.0\.0\.1/.test(origin)) return cb(null, true);
  // En producción, verificar lista blanca
  if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
  // Si FRONTEND_URL incluye '*' permite todo (útil para pruebas)
  if (rawOrigins.includes('*')) return cb(null, true);
  cb(new Error('CORS: Origen no permitido → ' + origin));
};

app.use(cors({
  origin: corsOriginFn,
  credentials:    true,
  methods:        ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
}));

// ── Seguridad ────────────────────────────────────────────
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Rate limiter global ──────────────────────────────────
app.use(rateLimit({
  windowMs:       15 * 60 * 1000,
  max:            300,
  standardHeaders: true,
  legacyHeaders:   false,
  message:        { ok: false, message: 'Demasiadas peticiones. Intenta más tarde.' },
}));

// ── Logger básico ────────────────────────────────────────
app.use((req, _res, next) => {
  if (process.env.NODE_ENV !== 'production' || req.path.startsWith('/api/citas')) {
    console.log(`[${new Date().toLocaleTimeString('es-CO')}] ${req.method} ${req.path}`);
  }
  next();
});

// ── No-cache para todas las respuestas de la API ─────────
// Garantiza que los clientes nunca usen datos cacheados
// y siempre reciban la información más reciente.
app.use('/api', (_req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

// ════════════════════════════════════════════════════════
//  RUTAS API
// ════════════════════════════════════════════════════════
app.use('/api/auth',  authRoutes);
app.use('/api/citas', citasRoutes);
app.use('/api/admin', adminRoutes);

// ── Health check ──────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({
    ok:      true,
    service: 'BARBER VIP API',
    version: '3.0.0',
    time:    new Date().toISOString(),
    env:     process.env.NODE_ENV || 'development',
    db:      process.env.DATABASE_URL ? 'postgresql' : 'no configurada',
  });
});

// ── 404 para rutas no encontradas ────────────────────────
app.use('/api/*', (_req, res) => {
  res.status(404).json({ ok: false, message: 'Ruta no encontrada.' });
});

// ── Error handler global ─────────────────────────────────
app.use((err, _req, res, _next) => {
  if (err.message && err.message.startsWith('CORS:')) {
    return res.status(403).json({ ok: false, message: err.message });
  }
  console.error('[ERROR]', err.message);
  res.status(500).json({ ok: false, message: 'Error interno del servidor.' });
});

// ════════════════════════════════════════════════════════
//  HTTP SERVER + SOCKET.IO
//  Se crea un servidor HTTP explícito para poder adjuntar
//  Socket.io sobre el mismo puerto que Express.
// ════════════════════════════════════════════════════════
const httpServer = http.createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: corsOriginFn,
    methods: ['GET', 'POST'],
  },
  // Permite fallback a polling si el cliente no soporta websockets
  transports: ['websocket', 'polling'],
});

// Exponer io a las rutas vía req.app.get('io')
app.set('io', io);

io.on('connection', (socket) => {
  console.log(`[SOCKET] Cliente conectado: ${socket.id} (total: ${io.engine.clientsCount})`);

  socket.on('disconnect', () => {
    console.log(`[SOCKET] Cliente desconectado: ${socket.id} (total: ${io.engine.clientsCount})`);
  });
});

// ════════════════════════════════════════════════════════
//  ARRANCAR (espera a que la BD esté lista)
// ════════════════════════════════════════════════════════
async function start() {
  try {
    await initDatabase();
  } catch (err) {
    console.error('\n❌ No se pudo inicializar la base de datos:');
    console.error('   ' + err.message);
    console.error('\n   Verifica que DATABASE_URL esté configurada correctamente.');
    process.exit(1);
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log('\n╔══════════════════════════════════════════════╗');
    console.log('║       BARBER VIP — Backend API v3.0          ║');
    console.log('║       PostgreSQL + Socket.io (realtime)      ║');
    console.log('╚══════════════════════════════════════════════╝');
    console.log(`\n  🚀 Puerto:      ${PORT}`);
    console.log(`  🌐 Frontend:    ${ALLOWED_ORIGINS.filter(o=>o.includes('netlify')).join(', ') || 'localhost'}`);
    console.log(`  🗄️  Base datos:  PostgreSQL (${process.env.DATABASE_URL ? 'configurada' : 'NO CONFIGURADA'})`);
    console.log(`  🔌 Socket.io:   activo`);
    console.log(`  ⚙️  Entorno:     ${process.env.NODE_ENV || 'development'}`);
    console.log(`  🟢 Node:        ${process.version}`);
    console.log('\n  Rutas públicas (sin token):');
    console.log('    POST  /api/auth/login');
    console.log('    GET   /api/citas/servicios');
    console.log('    GET   /api/citas/barberos');
    console.log('    GET   /api/citas/disponibilidad');
    console.log('    POST  /api/citas');
    console.log('\n  Rutas admin (Bearer token):');
    console.log('    GET   /api/citas');
    console.log('    PATCH /api/citas/:id/estado');
    console.log('    GET   /api/admin/stats');
    console.log('    GET   /api/admin/config');
    console.log('    CRUD  /api/admin/servicios');
    console.log('    CRUD  /api/admin/barberos');
    console.log('\n  Eventos Socket.io emitidos:');
    console.log('    citas:changed     { action, cita }');
    console.log('    config:changed    { config }');
    console.log('    servicios:changed { action, servicio }');
    console.log('    barberos:changed  { action, barbero }');
    console.log('\n  Ctrl+C para detener\n');
  });
}

start();

module.exports = { app, io };
