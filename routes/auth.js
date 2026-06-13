/**
 * BARBER VIP — routes/auth.js
 * Rutas de autenticación del administrador (PostgreSQL).
 *
 * POST /api/auth/login           → Valida credenciales y devuelve JWT
 * GET  /api/auth/verify          → Verifica si el token activo es válido
 * POST /api/auth/logout          → Cierra sesión
 * POST /api/auth/change-password → Cambia contraseña (requiere token + contraseña actual)
 */

const express   = require('express');
const jwt       = require('jsonwebtoken');
const bcrypt    = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { verifyToken } = require('../middleware/auth');
const { query }       = require('../db/connection');

const router = express.Router();

const JWT_SECRET     = process.env.JWT_SECRET     || 'barbervip_fallback_secret';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '8h';

const ADMIN_USERNAME       = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD_PLAIN = process.env.ADMIN_PASSWORD || 'barbervip2024';

// ── Obtener hash activo (BD > .env) ─────────────────────────
// La contraseña puede haber sido cambiada y guardada en la BD
// (tabla config, clave 'admin_password_hash'). Si no existe,
// usamos un hash generado a partir de ADMIN_PASSWORD del .env.
async function getActivePasswordHash() {
  try {
    const result = await query(
      "SELECT valor FROM config WHERE clave = 'admin_password_hash'"
    );
    if (result.rows[0] && result.rows[0].valor) return result.rows[0].valor;
  } catch (err) {
    console.warn('[AUTH] No se pudo leer admin_password_hash de la BD:', err.message);
  }
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

    const activeHash    = await getActivePasswordHash();
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
//  Guarda el nuevo hash en la tabla config (PostgreSQL),
//  por lo que persiste entre reinicios/redeploys del servidor.
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
    const activeHash   = await getActivePasswordHash();
    const currentMatch = await bcrypt.compare(currentPassword, activeHash);
    if (!currentMatch) {
      return res.status(401).json({ ok: false, message: 'La contraseña actual es incorrecta.' });
    }

    // ── Guardar nuevo hash en PostgreSQL ──────────────────────
    const newHash = await bcrypt.hash(newPassword, 12);

    await query(
      `INSERT INTO config (clave, valor, updated_at)
       VALUES ('admin_password_hash', $1, to_char(NOW(),'YYYY-MM-DD HH24:MI:SS'))
       ON CONFLICT (clave) DO UPDATE SET
         valor      = EXCLUDED.valor,
         updated_at = EXCLUDED.updated_at`,
      [newHash]
    );

    await query(
      `INSERT INTO config (clave, valor, updated_at)
       VALUES ('admin_password_changed_at', to_char(NOW(),'YYYY-MM-DD HH24:MI:SS'), to_char(NOW(),'YYYY-MM-DD HH24:MI:SS'))
       ON CONFLICT (clave) DO UPDATE SET
         valor      = EXCLUDED.valor,
         updated_at = EXCLUDED.updated_at`
    );

    console.log(`[AUTH] Contraseña del admin cambiada el ${new Date().toLocaleString('es-CO')}`);

    return res.json({
      ok:      true,
      message: 'Contraseña cambiada exitosamente y guardada en la base de datos.',
    });

  } catch (err) {
    console.error('[AUTH] change-password error:', err);
    return res.status(500).json({ ok: false, message: 'Error al cambiar la contraseña.' });
  }
});

module.exports = router;
