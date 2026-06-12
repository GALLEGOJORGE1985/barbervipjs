/**
 * BARBER VIP — server.js
 * Backend API para Railway / Render / cualquier hosting Node.js
 *
 * Arranque local:   node server.js
 * Desarrollo:       npm run dev
 * Railway:          Detecta automáticamente con npm start
 */

require('dotenv').config();

const express   = require('express');
const cors      = require('cors');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');
const path      = require('path');
const fs        = require('fs');

// ── Inicializar BD antes de arrancar rutas ───────────────
require('./db/setup');

// ── Importar rutas ───────────────────────────────────────
const authRoutes  = require('./routes/auth');
const citasRoutes = require('./routes/citas');
const adminRoutes = require('./routes/admin');

// ════════════════════════════════════════════════════════
const app  = express();
const PORT = process.env.PORT || 4000;

// ── CORS ─────────────────────────────────────────────────
// Permite el frontend de Netlify + desarrollo local
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

app.use(cors({
  origin: function(origin, cb) {
    // Sin origin = Postman, curl, mismo servidor
    if (!origin) return cb(null, true);
    // En desarrollo acepta cualquier localhost
    if (process.env.NODE_ENV !== 'production' && /localhost|127\.0\.0\.1/.test(origin)) return cb(null, true);
    // En producción, verificar lista blanca
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    // Si FRONTEND_URL incluye '*' permite todo (útil para pruebas)
    if (rawOrigins.includes('*')) return cb(null, true);
    cb(new Error('CORS: Origen no permitido → ' + origin));
  },
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

// ════════════════════════════════════════════════════════
//  RUTAS API
// ════════════════════════════════════════════════════════
app.use('/api/auth',  authRoutes);
app.use('/api/citas', citasRoutes);
app.use('/api/admin', adminRoutes);

// ── Health check (Netlify lo llama para verificar) ───────
app.get('/api/health', (_req, res) => {
  res.json({
    ok:      true,
    service: 'BARBER VIP API',
    version: '2.0.0',
    time:    new Date().toISOString(),
    env:     process.env.NODE_ENV || 'development',
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
//  ARRANCAR
// ════════════════════════════════════════════════════════
app.listen(PORT, '0.0.0.0', () => {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║       BARBER VIP — Backend API v2.0          ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log(`\n  🚀 Puerto:      ${PORT}`);
  console.log(`  🌐 Frontend:    ${ALLOWED_ORIGINS.filter(o=>o.includes('netlify')).join(', ') || 'localhost'}`);
  console.log(`  🗄️  Base datos:  ${process.env.DB_PATH || './db/barbervip.db'}`);
  console.log(`  ⚙️  Entorno:     ${process.env.NODE_ENV || 'development'}`);
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
  console.log('\n  Ctrl+C para detener\n');
});

module.exports = app;
