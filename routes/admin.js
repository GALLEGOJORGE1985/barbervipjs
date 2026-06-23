/**
 * BARBER VIP — routes/admin.js
 * Rutas exclusivas del panel de administración (PostgreSQL + Socket.io).
 * Todas protegidas con verifyToken.
 *
 *  GET  /api/admin/stats           → Estadísticas del dashboard
 *  GET  /api/admin/config          → Configuración del negocio
 *  PUT  /api/admin/config          → Actualizar configuración
 *  GET  /api/admin/servicios       → Listar servicios (admin)
 *  POST /api/admin/servicios       → Crear servicio
 *  PUT  /api/admin/servicios/:id   → Editar servicio
 *  DEL  /api/admin/servicios/:id   → Eliminar servicio
 *  GET  /api/admin/barberos        → Listar barberos (admin)
 *  POST /api/admin/barberos        → Crear barbero
 *  PUT  /api/admin/barberos/:id    → Editar barbero
 *  DEL  /api/admin/barberos/:id    → Eliminar barbero
 *
 * Cada cambio en config/servicios/barberos emite un evento
 * Socket.io para que todos los dispositivos conectados se
 * actualicen automáticamente sin recargar.
 */

const express         = require('express');
const { query }       = require('../db/connection');
const { verifyToken } = require('../middleware/auth');

const router = express.Router();

// Aplicar verifyToken a TODAS las rutas de este archivo
router.use(verifyToken);

/** Emite un evento de sincronización a todos los clientes conectados */
function emitChange(req, event, payload) {
  const io = req.app.get('io');
  if (io) io.emit(event, payload);
}

/** Código de error de PostgreSQL para violación de UNIQUE constraint */
const PG_UNIQUE_VIOLATION = '23505';

// ════════════════════════════════════════════════════════════
//  GET /api/admin/stats
// ════════════════════════════════════════════════════════════
router.get('/stats', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const month = today.slice(0, 7); // YYYY-MM

    const citasHoyResult = await query(
      "SELECT COUNT(*) AS n FROM citas WHERE fecha = $1 AND estado <> 'cancelada'",
      [today]
    );

    const pendientesHoyResult = await query(
      "SELECT COUNT(*) AS n FROM citas WHERE fecha = $1 AND estado IN ('pendiente','confirmada')",
      [today]
    );

    const ingresosHoyResult = await query(
      "SELECT COALESCE(SUM(precio),0) AS total FROM citas WHERE fecha = $1 AND estado = 'completada'",
      [today]
    );

    const ingresosMesResult = await query(
      "SELECT COALESCE(SUM(precio),0) AS total FROM citas WHERE SUBSTRING(fecha FROM 1 FOR 7) = $1 AND estado = 'completada'",
      [month]
    );

    const citasMesResult = await query(
      "SELECT COUNT(*) AS n FROM citas WHERE SUBSTRING(fecha FROM 1 FOR 7) = $1 AND estado <> 'cancelada'",
      [month]
    );

    const webNuevasResult = await query(
      "SELECT COUNT(*) AS n FROM citas WHERE origen = 'web' AND vista_admin = 0 AND estado <> 'cancelada'"
    );

    const now = new Date();
    const horaActual = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    const proximaCitaResult = await query(
      `SELECT nombre_cliente, servicio, barbero, hora
       FROM   citas
       WHERE  fecha = $1 AND hora >= $2 AND estado IN ('pendiente','confirmada')
       ORDER  BY hora ASC
       LIMIT  1`,
      [today, horaActual]
    );

    const topServiciosResult = await query(
      `SELECT servicio, COUNT(*) AS total, COALESCE(SUM(precio),0) AS ingresos
       FROM   citas
       WHERE  SUBSTRING(fecha FROM 1 FOR 7) = $1 AND estado <> 'cancelada'
       GROUP  BY servicio
       ORDER  BY total DESC
       LIMIT  5`,
      [month]
    );

    const topBarberosResult = await query(
      `SELECT barbero, COUNT(*) AS citas, COALESCE(SUM(precio),0) AS ingresos
       FROM   citas
       WHERE  SUBSTRING(fecha FROM 1 FOR 7) = $1 AND estado = 'completada'
       GROUP  BY barbero
       ORDER  BY citas DESC`,
      [month]
    );

    // Últimos 7 días (calculados en JS para evitar funciones de fecha SQLite)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);
    const sevenDaysAgoStr = sevenDaysAgo.toISOString().split('T')[0];

    const ultimos7Result = await query(
      `SELECT fecha, COUNT(*) AS total
       FROM   citas
       WHERE  fecha >= $1 AND estado <> 'cancelada'
       GROUP  BY fecha
       ORDER  BY fecha ASC`,
      [sevenDaysAgoStr]
    );

    return res.json({
      ok: true,
      data: {
        hoy: {
          fecha:       today,
          citas:       Number(citasHoyResult.rows[0].n),
          pendientes:  Number(pendientesHoyResult.rows[0].n),
          ingresos:    Number(ingresosHoyResult.rows[0].total),
          proximaCita: proximaCitaResult.rows[0] || null,
        },
        mes: {
          periodo:  month,
          citas:    Number(citasMesResult.rows[0].n),
          ingresos: Number(ingresosMesResult.rows[0].total),
        },
        webNuevas:    Number(webNuevasResult.rows[0].n),
        topServicios: topServiciosResult.rows.map(r => ({ ...r, total: Number(r.total), ingresos: Number(r.ingresos) })),
        topBarberos:  topBarberosResult.rows.map(r => ({ ...r, citas: Number(r.citas), ingresos: Number(r.ingresos) })),
        ultimos7:     ultimos7Result.rows.map(r => ({ ...r, total: Number(r.total) })),
      },
    });
  } catch (err) {
    console.error('[STATS] Error:', err);
    return res.status(500).json({ ok: false, message: 'Error al obtener estadísticas.' });
  }
});

// ════════════════════════════════════════════════════════════
//  CONFIG
// ════════════════════════════════════════════════════════════
router.get('/config', async (req, res) => {
  try {
    const result = await query('SELECT clave, valor FROM config');
    const config = {};
    for (const r of result.rows) config[r.clave] = r.valor;
    return res.json({ ok: true, data: config });
  } catch (err) {
    console.error('[CONFIG GET] Error:', err);
    return res.status(500).json({ ok: false, message: 'Error al obtener configuración.' });
  }
});

router.put('/config', async (req, res) => {
  try {
    const campos = req.body; // { clave: valor, ... }
    if (!campos || typeof campos !== 'object' || Array.isArray(campos)) {
      return res.status(400).json({ ok: false, message: 'Body debe ser un objeto clave-valor.' });
    }

    const entries = Object.entries(campos);
    for (const [clave, valor] of entries) {
      await query(
        `INSERT INTO config (clave, valor, updated_at)
         VALUES ($1, $2, to_char(NOW(),'YYYY-MM-DD HH24:MI:SS'))
         ON CONFLICT (clave) DO UPDATE SET
           valor      = EXCLUDED.valor,
           updated_at = EXCLUDED.updated_at`,
        [clave, String(valor)]
      );
    }

    // Devolver config actualizada completa
    const result = await query('SELECT clave, valor FROM config');
    const config = {};
    for (const r of result.rows) config[r.clave] = r.valor;

    // 🔔 Notificar a todos los dispositivos conectados
    emitChange(req, 'config:changed', { config });

    return res.json({ ok: true, message: 'Configuración guardada.', data: config });
  } catch (err) {
    console.error('[CONFIG PUT] Error:', err);
    return res.status(500).json({ ok: false, message: 'Error al guardar configuración.' });
  }
});

// ════════════════════════════════════════════════════════════
//  SERVICIOS (CRUD admin)
// ════════════════════════════════════════════════════════════
router.get('/servicios', async (req, res) => {
  try {
    const result = await query('SELECT * FROM servicios ORDER BY nombre');
    return res.json({ ok: true, data: result.rows });
  } catch (err) {
    console.error('[SERVICIOS GET] Error:', err);
    return res.status(500).json({ ok: false, message: 'Error al obtener servicios.' });
  }
});

router.post('/servicios', async (req, res) => {
  const { nombre, precio = 0, duracion = 30 } = req.body;
  if (!nombre || nombre.trim().length < 2)
    return res.status(400).json({ ok: false, message: 'Nombre del servicio requerido.' });

  try {
    const result = await query(
      'INSERT INTO servicios (nombre, precio, duracion) VALUES ($1, $2, $3) RETURNING *',
      [nombre.trim(), Number(precio), Number(duracion)]
    );
    const nuevo = result.rows[0];

    emitChange(req, 'servicios:changed', { action: 'created', servicio: nuevo });
    return res.status(201).json({ ok: true, data: nuevo });
  } catch (err) {
    if (err.code === PG_UNIQUE_VIOLATION) {
      return res.status(409).json({ ok: false, message: 'Ya existe un servicio con ese nombre.' });
    }
    console.error('[SERVICIOS POST] Error:', err);
    return res.status(500).json({ ok: false, message: 'Error al crear servicio.' });
  }
});

router.put('/servicios/:id', async (req, res) => {
  const { nombre, precio, duracion, activo } = req.body;
  try {
    const actualResult = await query('SELECT * FROM servicios WHERE id = $1', [req.params.id]);
    if (actualResult.rows.length === 0) return res.status(404).json({ ok: false, message: 'Servicio no encontrado.' });
    const actual = actualResult.rows[0];

    const result = await query(
      `UPDATE servicios SET nombre = $1, precio = $2, duracion = $3, activo = $4
       WHERE id = $5 RETURNING *`,
      [
        (nombre  ?? actual.nombre).trim(),
        precio   !== undefined ? Number(precio)   : actual.precio,
        duracion !== undefined ? Number(duracion) : actual.duracion,
        activo   !== undefined ? Number(!!activo) : actual.activo,
        req.params.id,
      ]
    );

    const actualizado = result.rows[0];
    emitChange(req, 'servicios:changed', { action: 'updated', servicio: actualizado });
    return res.json({ ok: true, data: actualizado });
  } catch (err) {
    if (err.code === PG_UNIQUE_VIOLATION) {
      return res.status(409).json({ ok: false, message: 'Ya existe un servicio con ese nombre.' });
    }
    console.error('[SERVICIOS PUT] Error:', err);
    return res.status(500).json({ ok: false, message: 'Error al actualizar servicio.' });
  }
});

router.delete('/servicios/:id', async (req, res) => {
  try {
    const result = await query('DELETE FROM servicios WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ ok: false, message: 'Servicio no encontrado.' });

    emitChange(req, 'servicios:changed', { action: 'deleted', servicio: { id: Number(req.params.id) } });
    return res.json({ ok: true, message: 'Servicio eliminado.' });
  } catch (err) {
    console.error('[SERVICIOS DELETE] Error:', err);
    return res.status(500).json({ ok: false, message: 'Error al eliminar servicio.' });
  }
});

// ════════════════════════════════════════════════════════════
//  BARBEROS (CRUD admin)
// ════════════════════════════════════════════════════════════
router.get('/barberos', async (req, res) => {
  try {
    const result = await query('SELECT * FROM barberos ORDER BY nombre');
    return res.json({ ok: true, data: result.rows });
  } catch (err) {
    console.error('[BARBEROS GET] Error:', err);
    return res.status(500).json({ ok: false, message: 'Error al obtener barberos.' });
  }
});

router.post('/barberos', async (req, res) => {
  const { nombre, porcentaje = 50 } = req.body;
  if (!nombre || nombre.trim().length < 2)
    return res.status(400).json({ ok: false, message: 'Nombre del barbero requerido.' });

  try {
    const result = await query(
      'INSERT INTO barberos (nombre, porcentaje) VALUES ($1, $2) RETURNING *',
      [nombre.trim(), Number(porcentaje) || 50]
    );
    const nuevo = result.rows[0];
    emitChange(req, 'barberos:changed', { action: 'created', barbero: nuevo });
    return res.status(201).json({ ok: true, data: nuevo });
  } catch (err) {
    if (err.code === PG_UNIQUE_VIOLATION) {
      return res.status(409).json({ ok: false, message: 'Ya existe un barbero con ese nombre.' });
    }
    console.error('[BARBEROS POST] Error:', err);
    return res.status(500).json({ ok: false, message: 'Error al crear barbero.' });
  }
});

router.put('/barberos/:id', async (req, res) => {
  const { nombre, activo, porcentaje } = req.body;
  try {
    const actualResult = await query('SELECT * FROM barberos WHERE id = $1', [req.params.id]);
    if (actualResult.rows.length === 0) return res.status(404).json({ ok: false, message: 'Barbero no encontrado.' });
    const actual = actualResult.rows[0];

    const result = await query(
      `UPDATE barberos SET nombre = $1, activo = $2, porcentaje = $3 WHERE id = $4 RETURNING *`,
      [
        (nombre  ?? actual.nombre).trim(),
        activo   !== undefined ? Number(!!activo)      : actual.activo,
        porcentaje !== undefined ? Number(porcentaje)  : actual.porcentaje,
        req.params.id,
      ]
    );

    const actualizado = result.rows[0];
    emitChange(req, 'barberos:changed', { action: 'updated', barbero: actualizado });
    return res.json({ ok: true, data: actualizado });
  } catch (err) {
    if (err.code === PG_UNIQUE_VIOLATION) {
      return res.status(409).json({ ok: false, message: 'Ya existe un barbero con ese nombre.' });
    }
    console.error('[BARBEROS PUT] Error:', err);
    return res.status(500).json({ ok: false, message: 'Error al actualizar barbero.' });
  }
});

router.delete('/barberos/:id', async (req, res) => {
  try {
    const result = await query('DELETE FROM barberos WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ ok: false, message: 'Barbero no encontrado.' });

    emitChange(req, 'barberos:changed', { action: 'deleted', barbero: { id: Number(req.params.id) } });
    return res.json({ ok: true, message: 'Barbero eliminado.' });
  } catch (err) {
    console.error('[BARBEROS DELETE] Error:', err);
    return res.status(500).json({ ok: false, message: 'Error al eliminar barbero.' });
  }
});

module.exports = router;
