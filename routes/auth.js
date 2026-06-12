/**
 * BARBER VIP — routes/auth.js
 * Rutas de autenticación del administrador.
 *
 * POST /api/auth/login           → Valida credenciales y devuelve JWT
 * GET  /api/auth/verify          → Verifica si el token activo es válido
 * POST /api/auth/logout          → Cierra sesión
 * POST /api/auth/change-password → Cambia contraseña (requiere token + contraseña actual)
 */

const express    = require('express');
const jwt        = require('jsonwebtoken');
const bcrypt     = require('bcryptjs');
const rateLimit  = require('express-rate-limit');
const { verifyToken } = require('../middleware/auth');
const { getDB }  = require('../db/connection');

const router = express.Router();

const JWT_SECRET     = process.env.JWT_SECRET     || 'barbervip_fallback_secret';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '8h';

const ADMIN_USERNAME       = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD_PLAIN = process.env.ADMIN_PASSWORD || 'barbervip2024';

// ── Obtener hash activo (DB > .env) ─────────────────────────
// La contraseña puede haber sido cambiada y guardada en la BD.
// Si existe en config tabla la usamos, si no usamos la de .env
function getActivePasswordHash() {
  try {
    const db  = getDB();
    const row = db.prepare("SELECT valor FROM config WHERE clave = 'admin_password_hash'").get();
    if (row && row.valor) return row.valor;
  } catch {}
  // Fallback: hash de la contraseña de .env
  return bcrypt.hashSync(ADMIN_PASSWORD_PLAIN, 10);
}

// ── Rate limiter login ───────────────────────────────────────
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { ok: false, message: 'Demasiados intentos. Espera 15 minutos.' },
  standardHeaders: true,
  legacyHeaders:   false,
});

// ════════════════════════════════════════════════════════════
//  POST /api/auth/login
// ════════════════════════════════════════════════════════════
router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ ok: false, message: 'Usuario y contraseña son requeridos.' });
    }

    if (username.trim().toLowerCase() !== ADMIN_USERNAME.toLowerCase()) {
      return res.status(401).json({ ok: false, message: 'Credenciales incorrectas.' });
    }

    const activeHash    = getActivePasswordHash();
    const passwordMatch = await bcrypt.compare(password, activeHash);

    if (!passwordMatch) {
      return res.status(401).json({ ok: false, message: 'Credenciales incorrectas.' });
    }

    const token = jwt.sign(
      { username: ADMIN_USERNAME, role: 'admin' },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    const decoded   = jwt.decode(token);
    const expiresAt = decoded.exp * 1000;

    return res.json({
      ok: true,
      message: 'Login exitoso.',
      token,
      expiresAt,
      user: { username: ADMIN_USERNAME, role: 'admin' },
    });

  } catch (err) {
    console.error('[AUTH] Login error:', err);
    return res.status(500).json({ ok: false, message: 'Error interno del servidor.' });
  }
});

// ════════════════════════════════════════════════════════════
//  GET /api/auth/verify
// ════════════════════════════════════════════════════════════
router.get('/verify', verifyToken, (req, res) => {
  return res.json({ ok: true, user: { username: req.admin.username, role: req.admin.role } });
});

// ════════════════════════════════════════════════════════════
//  POST /api/auth/logout
// ════════════════════════════════════════════════════════════
router.post('/logout', verifyToken, (req, res) => {
  return res.json({ ok: true, message: 'Sesión cerrada.' });
});

// ════════════════════════════════════════════════════════════
//  POST /api/auth/change-password
//  Body: { currentPassword, newPassword, confirmPassword }
//  Header: Authorization: Bearer <token>
//
//  Guarda el nuevo hash en la tabla config (clave: admin_password_hash)
//  para que persista entre reinicios del servidor sin tocar el .env
// ════════════════════════════════════════════════════════════
router.post('/change-password', verifyToken, async (req, res) => {
  try {
    const { currentPassword, newPassword, confirmPassword } = req.body;

    // ── Validaciones ─────────────────────────────────────────
    if (!currentPassword || !newPassword || !confirmPassword) {
      return res.status(400).json({ ok: false, message: 'Todos los campos son requeridos.' });
    }

    if (newPassword !== confirmPassword) {
      return res.status(400).json({ ok: false, message: 'La nueva contraseña y su confirmación no coinciden.' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ ok: false, message: 'La nueva contraseña debe tener al menos 6 caracteres.' });
    }

    if (newPassword === currentPassword) {
      return res.status(400).json({ ok: false, message: 'La nueva contraseña debe ser diferente a la actual.' });
    }

    // ── Verificar contraseña actual ───────────────────────────
    const activeHash    = getActivePasswordHash();
    const currentMatch  = await bcrypt.compare(currentPassword, activeHash);

    if (!currentMatch) {
      return res.status(401).json({ ok: false, message: 'La contraseña actual es incorrecta.' });
    }

    // ── Guardar nuevo hash en la BD ───────────────────────────
    const newHash = await bcrypt.hash(newPassword, 12);
    const db      = getDB();

    db.prepare(`
      INSERT INTO config (clave, valor, updated_at)
      VALUES ('admin_password_hash', ?, datetime('now','localtime'))
      ON CONFLICT(clave) DO UPDATE SET
        valor      = excluded.valor,
        updated_at = excluded.updated_at
    `).run(newHash);

    // También guardar la fecha del último cambio
    db.prepare(`
      INSERT INTO config (clave, valor, updated_at)
      VALUES ('admin_password_changed_at', datetime('now','localtime'), datetime('now','localtime'))
      ON CONFLICT(clave) DO UPDATE SET
        valor      = excluded.valor,
        updated_at = excluded.updated_at
    `).run();

    console.log(`[AUTH] Contraseña del admin cambiada el ${new Date().toLocaleString('es-CO')}`);

    return res.json({
      ok:      true,
      message: 'Contraseña cambiada exitosamente. Usa la nueva contraseña en tu próximo inicio de sesión.',
    });

  } catch (err) {
    console.error('[AUTH] change-password error:', err);
    return res.status(500).json({ ok: false, message: 'Error al cambiar la contraseña.' });
  }
});

module.exports = router;
