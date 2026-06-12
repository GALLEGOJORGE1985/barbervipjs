/**
 * BARBER VIP — routes/admin.js
 * Rutas exclusivas del panel de administración.
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
 */

const express         = require('express');
const { getDB }       = require('../db/connection');
const { verifyToken } = require('../middleware/auth');

const router = express.Router();

// Aplicar verifyToken a TODAS las rutas de este archivo
router.use(verifyToken);

// ════════════════════════════════════════════════════════════
//  GET /api/admin/stats
//  Devuelve métricas para el dashboard administrativo
// ════════════════════════════════════════════════════════════
router.get('/stats', (req, res) => {
  try {
    const db    = getDB();
    const today = new Date().toISOString().split('T')[0];
    const month = today.slice(0, 7); // YYYY-MM

    // Citas de hoy
    const citasHoy = db.prepare(
      "SELECT COUNT(*) as n FROM citas WHERE fecha = ? AND estado != 'cancelada'"
    ).get(today).n;

    // Citas pendientes hoy
    const pendientesHoy = db.prepare(
      "SELECT COUNT(*) as n FROM citas WHERE fecha = ? AND estado IN ('pendiente','confirmada')"
    ).get(today).n;

    // Ingresos de hoy (citas completadas)
    const ingresosHoy = db.prepare(
      "SELECT COALESCE(SUM(precio),0) as total FROM citas WHERE fecha = ? AND estado = 'completada'"
    ).get(today).total;

    // Ingresos del mes
    const ingresosMes = db.prepare(
      "SELECT COALESCE(SUM(precio),0) as total FROM citas WHERE strftime('%Y-%m',fecha) = ? AND estado = 'completada'"
    ).get(month).total;

    // Total citas del mes
    const citasMes = db.prepare(
      "SELECT COUNT(*) as n FROM citas WHERE strftime('%Y-%m',fecha) = ? AND estado != 'cancelada'"
    ).get(month).n;

    // Reservas web nuevas (no vistas)
    const webNuevas = db.prepare(
      "SELECT COUNT(*) as n FROM citas WHERE origen = 'web' AND vista_admin = 0 AND estado != 'cancelada'"
    ).get().n;

    // Próxima cita del día
    const now = new Date();
    const horaActual = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    const proximaCita = db.prepare(`
      SELECT nombre_cliente, servicio, barbero, hora
      FROM   citas
      WHERE  fecha = ? AND hora >= ? AND estado IN ('pendiente','confirmada')
      ORDER  BY hora ASC
      LIMIT  1
    `).get(today, horaActual);

    // Top 5 servicios del mes
    const topServicios = db.prepare(`
      SELECT servicio, COUNT(*) as total, COALESCE(SUM(precio),0) as ingresos
      FROM   citas
      WHERE  strftime('%Y-%m',fecha) = ? AND estado != 'cancelada'
      GROUP  BY servicio
      ORDER  BY total DESC
      LIMIT  5
    `).all(month);

    // Top barberos del mes
    const topBarberos = db.prepare(`
      SELECT barbero, COUNT(*) as citas, COALESCE(SUM(precio),0) as ingresos
      FROM   citas
      WHERE  strftime('%Y-%m',fecha) = ? AND estado = 'completada'
      GROUP  BY barbero
      ORDER  BY citas DESC
    `).all(month);

    // Citas por día (últimos 7 días)
    const ultimos7 = db.prepare(`
      SELECT fecha, COUNT(*) as total
      FROM   citas
      WHERE  fecha >= date('now','-6 days') AND estado != 'cancelada'
      GROUP  BY fecha
      ORDER  BY fecha ASC
    `).all();

    return res.json({
      ok: true,
      data: {
        hoy: {
          fecha:         today,
          citas:         citasHoy,
          pendientes:    pendientesHoy,
          ingresos:      ingresosHoy,
          proximaCita:   proximaCita || null,
        },
        mes: {
          periodo:   month,
          citas:     citasMes,
          ingresos:  ingresosMes,
        },
        webNuevas,
        topServicios,
        topBarberos,
        ultimos7,
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
router.get('/config', (req, res) => {
  try {
    const db   = getDB();
    const rows = db.prepare('SELECT clave, valor FROM config').all();
    // Convertir array a objeto
    const config = {};
    for (const r of rows) config[r.clave] = r.valor;
    return res.json({ ok: true, data: config });
  } catch (err) {
    console.error('[CONFIG GET] Error:', err);
    return res.status(500).json({ ok: false, message: 'Error al obtener configuración.' });
  }
});

router.put('/config', (req, res) => {
  try {
    const db     = getDB();
    const campos = req.body; // { clave: valor, ... }
    if (!campos || typeof campos !== 'object') {
      return res.status(400).json({ ok: false, message: 'Body debe ser un objeto clave-valor.' });
    }
    const upsert = db.prepare(
      'INSERT INTO config (clave, valor) VALUES (@clave, @valor) ON CONFLICT(clave) DO UPDATE SET valor = @valor, updated_at = datetime("now","localtime")'
    );
    const tx = db.transaction((obj) => {
      for (const [clave, valor] of Object.entries(obj)) {
        upsert.run({ clave, valor: String(valor) });
      }
    });
    tx(campos);
    return res.json({ ok: true, message: 'Configuración guardada.' });
  } catch (err) {
    console.error('[CONFIG PUT] Error:', err);
    return res.status(500).json({ ok: false, message: 'Error al guardar configuración.' });
  }
});

// ════════════════════════════════════════════════════════════
//  SERVICIOS (CRUD admin)
// ════════════════════════════════════════════════════════════
router.get('/servicios', (req, res) => {
  try {
    const rows = getDB().prepare('SELECT * FROM servicios ORDER BY nombre').all();
    return res.json({ ok: true, data: rows });
  } catch (err) {
    return res.status(500).json({ ok: false, message: 'Error al obtener servicios.' });
  }
});

router.post('/servicios', (req, res) => {
  const { nombre, precio = 0, duracion = 30 } = req.body;
  if (!nombre || nombre.trim().length < 2)
    return res.status(400).json({ ok: false, message: 'Nombre del servicio requerido.' });
  try {
    const db     = getDB();
    const result = db.prepare(
      'INSERT INTO servicios (nombre, precio, duracion) VALUES (?, ?, ?)'
    ).run(nombre.trim(), Number(precio), Number(duracion));
    const nuevo  = db.prepare('SELECT * FROM servicios WHERE id = ?').get(result.lastInsertRowid);
    return res.status(201).json({ ok: true, data: nuevo });
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(409).json({ ok: false, message: 'Ya existe un servicio con ese nombre.' });
    return res.status(500).json({ ok: false, message: 'Error al crear servicio.' });
  }
});

router.put('/servicios/:id', (req, res) => {
  const { nombre, precio, duracion, activo } = req.body;
  try {
    const db     = getDB();
    const actual = db.prepare('SELECT * FROM servicios WHERE id = ?').get(req.params.id);
    if (!actual) return res.status(404).json({ ok: false, message: 'Servicio no encontrado.' });
    db.prepare('UPDATE servicios SET nombre=?, precio=?, duracion=?, activo=? WHERE id=?')
      .run(
        (nombre   || actual.nombre).trim(),
        precio    !== undefined ? Number(precio)    : actual.precio,
        duracion  !== undefined ? Number(duracion)  : actual.duracion,
        activo    !== undefined ? Number(!!activo)  : actual.activo,
        req.params.id
      );
    return res.json({ ok: true, data: db.prepare('SELECT * FROM servicios WHERE id=?').get(req.params.id) });
  } catch (err) {
    return res.status(500).json({ ok: false, message: 'Error al actualizar servicio.' });
  }
});

router.delete('/servicios/:id', (req, res) => {
  try {
    getDB().prepare('DELETE FROM servicios WHERE id = ?').run(req.params.id);
    return res.json({ ok: true, message: 'Servicio eliminado.' });
  } catch (err) {
    return res.status(500).json({ ok: false, message: 'Error al eliminar servicio.' });
  }
});

// ════════════════════════════════════════════════════════════
//  BARBEROS (CRUD admin)
// ════════════════════════════════════════════════════════════
router.get('/barberos', (req, res) => {
  try {
    const rows = getDB().prepare('SELECT * FROM barberos ORDER BY nombre').all();
    return res.json({ ok: true, data: rows });
  } catch (err) {
    return res.status(500).json({ ok: false, message: 'Error al obtener barberos.' });
  }
});

router.post('/barberos', (req, res) => {
  const { nombre } = req.body;
  if (!nombre || nombre.trim().length < 2)
    return res.status(400).json({ ok: false, message: 'Nombre del barbero requerido.' });
  try {
    const db     = getDB();
    const result = db.prepare('INSERT INTO barberos (nombre) VALUES (?)').run(nombre.trim());
    const nuevo  = db.prepare('SELECT * FROM barberos WHERE id = ?').get(result.lastInsertRowid);
    return res.status(201).json({ ok: true, data: nuevo });
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(409).json({ ok: false, message: 'Ya existe un barbero con ese nombre.' });
    return res.status(500).json({ ok: false, message: 'Error al crear barbero.' });
  }
});

router.put('/barberos/:id', (req, res) => {
  const { nombre, activo } = req.body;
  try {
    const db     = getDB();
    const actual = db.prepare('SELECT * FROM barberos WHERE id = ?').get(req.params.id);
    if (!actual) return res.status(404).json({ ok: false, message: 'Barbero no encontrado.' });
    db.prepare('UPDATE barberos SET nombre=?, activo=? WHERE id=?')
      .run(
        (nombre || actual.nombre).trim(),
        activo !== undefined ? Number(!!activo) : actual.activo,
        req.params.id
      );
    return res.json({ ok: true, data: db.prepare('SELECT * FROM barberos WHERE id=?').get(req.params.id) });
  } catch (err) {
    return res.status(500).json({ ok: false, message: 'Error al actualizar barbero.' });
  }
});

router.delete('/barberos/:id', (req, res) => {
  try {
    getDB().prepare('DELETE FROM barberos WHERE id = ?').run(req.params.id);
    return res.json({ ok: true, message: 'Barbero eliminado.' });
  } catch (err) {
    return res.status(500).json({ ok: false, message: 'Error al eliminar barbero.' });
  }
});

module.exports = router;
