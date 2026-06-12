/**
 * BARBER VIP — middleware/auth.js
 * Middleware de autenticación JWT.
 * Protege todas las rutas del panel de administrador.
 */

const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'barbervip_fallback_secret';

/**
 * verifyToken
 * Valida el Bearer token enviado en el header Authorization.
 * Si es válido, adjunta el payload a req.admin y llama next().
 * Si no, responde 401.
 */
function verifyToken(req, res, next) {
  const authHeader = req.headers['authorization'];

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      ok:      false,
      message: 'Acceso denegado. Token no proporcionado.',
    });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.admin = decoded; // { username, role, iat, exp }
    next();
  } catch (err) {
    const msg = err.name === 'TokenExpiredError'
      ? 'Sesión expirada. Inicia sesión nuevamente.'
      : 'Token inválido.';
    return res.status(401).json({ ok: false, message: msg });
  }
}

module.exports = { verifyToken };
