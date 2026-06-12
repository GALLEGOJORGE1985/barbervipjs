/**
 * BARBER VIP — routes/citas.js
 * ─────────────────────────────────────────────────────────────
 * Rutas para el módulo de citas.
 *
 * PÚBLICAS (sin token):
 *   POST /api/citas            → Cliente crea una cita (formulario web)
 *   GET  /api/citas/disponibilidad → Horarios ocupados para una fecha
 *   GET  /api/citas/servicios  → Lista de servicios activos
 *   GET  /api/citas/barberos   → Lista de barberos activos
 *
 * PROTEGIDAS (requieren Bearer JWT):
 *   GET    /api/citas              → Listar todas las citas (admin)
 *   GET    /api/citas/:id          → Detalle de una cita
 *   PUT    /api/citas/:id          → Actualizar cita (estado, etc.)
 *   DELETE /api/citas/:id          → Eliminar cita
 *   PATCH  /api/citas/:id/estado   → Cambiar solo el estado
 *   PATCH  /api/citas/:id/vista    → Marcar como vista por admin
 * ─────────────────────────────────────────────────────────────
 */

const express         = require('express');
const { getDB }       = require('../db/connection');
const { verifyToken } = require('../middleware/auth');

const router = express.Router();

// ── Helpers ─────────────────────────────────────────────────

/** Validar formato de fecha YYYY-MM-DD */
function isValidDate(str) {
  return /^\d{4}-\d{2}-\d{2}$/.test(str) && !isNaN(Date.parse(str));
}

/** Validar formato de hora HH:MM */
function isValidTime(str) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(str);
}

/** Sanitizar texto para evitar inyección en LIKE */
function escapeLike(str) {
  return str.replace(/[%_\\]/g, c => '\\' + c);
}

// ════════════════════════════════════════════════════════════
//  PÚBLICA — GET /api/citas/servicios
//  Devuelve servicios activos para poblar el formulario web
// ════════════════════════════════════════════════════════════
router.get('/servicios', (req, res) => {
  try {
    const db  = getDB();
    const rows = db.prepare(
      'SELECT id, nombre, precio, duracion FROM servicios WHERE activo = 1 ORDER BY nombre'
    ).all();
    return res.json({ ok: true, data: rows });
  } catch (err) {
    console.error('[SERVICIOS] Error:', err);
    return res.status(500).json({ ok: false, message: 'Error al obtener servicios.' });
  }
});

// ════════════════════════════════════════════════════════════
//  PÚBLICA — GET /api/citas/barberos
//  Devuelve barberos activos
// ════════════════════════════════════════════════════════════
router.get('/barberos', (req, res) => {
  try {
    const db   = getDB();
    const rows = db.prepare(
      'SELECT id, nombre FROM barberos WHERE activo = 1 ORDER BY nombre'
    ).all();
    return res.json({ ok: true, data: rows });
  } catch (err) {
    console.error('[BARBEROS] Error:', err);
    return res.status(500).json({ ok: false, message: 'Error al obtener barberos.' });
  }
});

// ════════════════════════════════════════════════════════════
//  PÚBLICA — GET /api/citas/disponibilidad?fecha=YYYY-MM-DD&barbero=nombre
//  Retorna los slots ocupados para esa fecha (y barbero opcional)
//  El frontend usa esto para pintar horarios disponibles/ocupados
// ════════════════════════════════════════════════════════════
router.get('/disponibilidad', (req, res) => {
  const { fecha, barbero } = req.query;

  if (!fecha || !isValidDate(fecha)) {
    return res.status(400).json({ ok: false, message: 'Parámetro "fecha" inválido (usa YYYY-MM-DD).' });
  }

  try {
    const db = getDB();

    // Si viene barbero, filtramos por barbero; si no, devolvemos todos los ocupados
    let rows;
    if (barbero && barbero.trim()) {
      rows = db.prepare(`
        SELECT hora, barbero, estado
        FROM citas
        WHERE fecha = ? AND barbero = ? AND estado NOT IN ('cancelada')
      `).all(fecha, barbero.trim());
    } else {
      rows = db.prepare(`
        SELECT hora, barbero, estado
        FROM citas
        WHERE fecha = ? AND estado NOT IN ('cancelada')
      `).all(fecha);
    }

    // Construir mapa: { "09:00": ["Carlos Rodríguez", "Miguel Torres"], ... }
    const ocupados = {};
    for (const row of rows) {
      if (!ocupados[row.hora]) ocupados[row.hora] = [];
      ocupados[row.hora].push(row.barbero);
    }

    return res.json({ ok: true, fecha, ocupados });
  } catch (err) {
    console.error('[DISPONIBILIDAD] Error:', err);
    return res.status(500).json({ ok: false, message: 'Error al consultar disponibilidad.' });
  }
});

// ════════════════════════════════════════════════════════════
//  PÚBLICA — POST /api/citas
//  El cliente del portal web crea una cita sin estar logueado.
//  Inserta de forma segura con prepared statements.
// ════════════════════════════════════════════════════════════
router.post('/', (req, res) => {
  const {
    nombre_cliente,
    telefono,
    email   = '',
    servicio,
    barbero,
    fecha,
    hora,
    precio  = 0,
    notas   = '',
  } = req.body;

  // ── Validaciones ───────────────────────────────────────────
  const errores = [];
  if (!nombre_cliente || nombre_cliente.trim().length < 2)
    errores.push('El nombre del cliente es requerido (mínimo 2 caracteres).');
  if (!telefono || !/^[\d\s\+\-\(\)]{7,15}$/.test(telefono.trim()))
    errores.push('Teléfono inválido.');
  if (!servicio || servicio.trim().length < 2)
    errores.push('El servicio es requerido.');
  if (!barbero || barbero.trim().length < 2)
    errores.push('El barbero es requerido.');
  if (!fecha || !isValidDate(fecha))
    errores.push('Fecha inválida (usa YYYY-MM-DD).');
  if (!hora || !isValidTime(hora))
    errores.push('Hora inválida (usa HH:MM).');

  // No se puede agendar en el pasado
  if (fecha && isValidDate(fecha) && hora && isValidTime(hora)) {
    const fechaHora = new Date(`${fecha}T${hora}:00`);
    if (fechaHora <= new Date()) errores.push('No puedes agendar en una fecha/hora pasada.');
  }

  if (errores.length > 0) {
    return res.status(400).json({ ok: false, message: errores.join(' | '), errores });
  }

  try {
    const db = getDB();

    // ── Verificar conflicto de horario ────────────────────────
    const conflicto = db.prepare(`
      SELECT id FROM citas
      WHERE fecha = ? AND hora = ? AND barbero = ? AND estado NOT IN ('cancelada')
    `).get(fecha, hora, barbero.trim());

    if (conflicto) {
      return res.status(409).json({
        ok:      false,
        message: `El horario ${hora} del ${fecha} ya está reservado para ${barbero}. Elige otro.`,
      });
    }

    // ── Insertar con prepared statement (previene SQL Injection) ─
    const stmt = db.prepare(`
      INSERT INTO citas
        (nombre_cliente, telefono, email, servicio, barbero, fecha, hora, precio, notas, origen)
      VALUES
        (@nombre_cliente, @telefono, @email, @servicio, @barbero, @fecha, @hora, @precio, @notas, 'web')
    `);

    const result = stmt.run({
      nombre_cliente: nombre_cliente.trim(),
      telefono:       telefono.trim(),
      email:          email.trim(),
      servicio:       servicio.trim(),
      barbero:        barbero.trim(),
      fecha,
      hora,
      precio:         Number(precio) || 0,
      notas:          notas.trim(),
    });

    // Recuperar la cita recién creada
    const nuevaCita = db.prepare('SELECT * FROM citas WHERE id = ?').get(result.lastInsertRowid);

    return res.status(201).json({
      ok:      true,
      message: '¡Cita reservada con éxito! Pronto recibirás confirmación.',
      data:    nuevaCita,
    });

  } catch (err) {
    console.error('[CITAS POST] Error:', err);
    return res.status(500).json({ ok: false, message: 'Error al guardar la cita. Intenta de nuevo.' });
  }
});

// ════════════════════════════════════════════════════════════
//  PROTEGIDA — GET /api/citas
//  Lista todas las citas con filtros opcionales (admin)
//  Query params: fecha, estado, barbero, origen, buscar, page, limit
// ════════════════════════════════════════════════════════════
router.get('/', verifyToken, (req, res) => {
  try {
    const db = getDB();

    const {
      fecha,
      estado,
      barbero,
      origen,
      buscar,
      page  = 1,
      limit = 50,
      order = 'desc',
    } = req.query;

    const conditions = [];
    const params     = [];

    if (fecha   && isValidDate(fecha))    { conditions.push('c.fecha = ?');           params.push(fecha); }
    if (estado)                           { conditions.push('c.estado = ?');           params.push(estado); }
    if (barbero)                          { conditions.push('c.barbero = ?');          params.push(barbero); }
    if (origen)                           { conditions.push('c.origen = ?');           params.push(origen); }
    if (buscar) {
      const q = `%${escapeLike(buscar)}%`;
      conditions.push('(c.nombre_cliente LIKE ? OR c.telefono LIKE ? OR c.email LIKE ?)');
      params.push(q, q, q);
    }

    const where   = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const orderBy = order === 'asc' ? 'ASC' : 'DESC';
    const offset  = (Math.max(1, Number(page)) - 1) * Number(limit);

    const total = db.prepare(
      `SELECT COUNT(*) as n FROM citas c ${where}`
    ).get(...params).n;

    const rows = db.prepare(`
      SELECT c.*
      FROM   citas c
      ${where}
      ORDER  BY c.fecha ${orderBy}, c.hora ${orderBy}
      LIMIT  ? OFFSET ?
    `).all(...params, Number(limit), offset);

    // Contar nuevas (web + no vistas) para el badge del admin
    const nuevasWeb = db.prepare(
      "SELECT COUNT(*) as n FROM citas WHERE origen = 'web' AND vista_admin = 0 AND estado != 'cancelada'"
    ).get().n;

    return res.json({
      ok:   true,
      data: rows,
      meta: {
        total,
        page:      Number(page),
        limit:     Number(limit),
        pages:     Math.ceil(total / Number(limit)),
        nuevasWeb,
      },
    });

  } catch (err) {
    console.error('[CITAS GET] Error:', err);
    return res.status(500).json({ ok: false, message: 'Error al obtener citas.' });
  }
});

// ════════════════════════════════════════════════════════════
//  PROTEGIDA — GET /api/citas/:id
// ════════════════════════════════════════════════════════════
router.get('/:id', verifyToken, (req, res) => {
  try {
    const db   = getDB();
    const cita = db.prepare('SELECT * FROM citas WHERE id = ?').get(req.params.id);
    if (!cita) return res.status(404).json({ ok: false, message: 'Cita no encontrada.' });
    return res.json({ ok: true, data: cita });
  } catch (err) {
    console.error('[CITAS GET ID] Error:', err);
    return res.status(500).json({ ok: false, message: 'Error al obtener la cita.' });
  }
});

// ════════════════════════════════════════════════════════════
//  PROTEGIDA — PATCH /api/citas/:id/estado
//  Solo cambia el estado de la cita
// ════════════════════════════════════════════════════════════
router.patch('/:id/estado', verifyToken, (req, res) => {
  const { estado } = req.body;
  const estadosValidos = ['pendiente', 'confirmada', 'completada', 'cancelada'];

  if (!estado || !estadosValidos.includes(estado)) {
    return res.status(400).json({
      ok:      false,
      message: `Estado inválido. Usa: ${estadosValidos.join(', ')}.`,
    });
  }

  try {
    const db     = getDB();
    const existe = db.prepare('SELECT id FROM citas WHERE id = ?').get(req.params.id);
    if (!existe) return res.status(404).json({ ok: false, message: 'Cita no encontrada.' });

    db.prepare('UPDATE citas SET estado = ?, vista_admin = 1 WHERE id = ?')
      .run(estado, req.params.id);

    const cita = db.prepare('SELECT * FROM citas WHERE id = ?').get(req.params.id);
    return res.json({ ok: true, message: `Estado actualizado a "${estado}".`, data: cita });
  } catch (err) {
    console.error('[CITAS ESTADO] Error:', err);
    return res.status(500).json({ ok: false, message: 'Error al actualizar estado.' });
  }
});

// ════════════════════════════════════════════════════════════
//  PROTEGIDA — PATCH /api/citas/:id/vista
//  Marcar cita como vista por el admin (elimina badge)
// ════════════════════════════════════════════════════════════
router.patch('/:id/vista', verifyToken, (req, res) => {
  try {
    const db = getDB();
    db.prepare('UPDATE citas SET vista_admin = 1 WHERE id = ?').run(req.params.id);
    return res.json({ ok: true, message: 'Cita marcada como vista.' });
  } catch (err) {
    console.error('[CITAS VISTA] Error:', err);
    return res.status(500).json({ ok: false, message: 'Error al marcar como vista.' });
  }
});

// ════════════════════════════════════════════════════════════
//  PROTEGIDA — PUT /api/citas/:id
//  Actualizar cita completa (solo admin)
// ════════════════════════════════════════════════════════════
router.put('/:id', verifyToken, (req, res) => {
  const {
    nombre_cliente,
    telefono,
    email,
    servicio,
    barbero,
    fecha,
    hora,
    precio,
    notas,
    estado,
  } = req.body;

  const errores = [];
  if (nombre_cliente && nombre_cliente.trim().length < 2) errores.push('Nombre muy corto.');
  if (fecha && !isValidDate(fecha)) errores.push('Fecha inválida.');
  if (hora  && !isValidTime(hora))  errores.push('Hora inválida.');
  const estadosValidos = ['pendiente', 'confirmada', 'completada', 'cancelada'];
  if (estado && !estadosValidos.includes(estado)) errores.push('Estado inválido.');
  if (errores.length) return res.status(400).json({ ok: false, message: errores.join(' | ') });

  try {
    const db     = getDB();
    const actual = db.prepare('SELECT * FROM citas WHERE id = ?').get(req.params.id);
    if (!actual) return res.status(404).json({ ok: false, message: 'Cita no encontrada.' });

    // Verificar conflicto solo si cambia fecha/hora/barbero
    const nuevaFecha   = fecha   || actual.fecha;
    const nuevaHora    = hora    || actual.hora;
    const nuevoBarbero = barbero || actual.barbero;

    if (nuevaFecha !== actual.fecha || nuevaHora !== actual.hora || nuevoBarbero !== actual.barbero) {
      const conflicto = db.prepare(`
        SELECT id FROM citas
        WHERE fecha = ? AND hora = ? AND barbero = ? AND id != ? AND estado NOT IN ('cancelada')
      `).get(nuevaFecha, nuevaHora, nuevoBarbero, req.params.id);

      if (conflicto) {
        return res.status(409).json({
          ok:      false,
          message: `Conflicto de horario: ${nuevoBarbero} ya tiene cita a las ${nuevaHora} el ${nuevaFecha}.`,
        });
      }
    }

    db.prepare(`
      UPDATE citas SET
        nombre_cliente = @nombre_cliente,
        telefono       = @telefono,
        email          = @email,
        servicio       = @servicio,
        barbero        = @barbero,
        fecha          = @fecha,
        hora           = @hora,
        precio         = @precio,
        notas          = @notas,
        estado         = @estado,
        vista_admin    = 1
      WHERE id = @id
    `).run({
      nombre_cliente: (nombre_cliente || actual.nombre_cliente).trim(),
      telefono:       (telefono       || actual.telefono).trim(),
      email:          (email          ?? actual.email).trim(),
      servicio:       (servicio       || actual.servicio).trim(),
      barbero:        (barbero        || actual.barbero).trim(),
      fecha:          nuevaFecha,
      hora:           nuevaHora,
      precio:         precio !== undefined ? Number(precio) : actual.precio,
      notas:          (notas ?? actual.notas).trim(),
      estado:         estado || actual.estado,
      id:             req.params.id,
    });

    const cita = db.prepare('SELECT * FROM citas WHERE id = ?').get(req.params.id);
    return res.json({ ok: true, message: 'Cita actualizada.', data: cita });
  } catch (err) {
    console.error('[CITAS PUT] Error:', err);
    return res.status(500).json({ ok: false, message: 'Error al actualizar la cita.' });
  }
});

// ════════════════════════════════════════════════════════════
//  PROTEGIDA — DELETE /api/citas/:id
// ════════════════════════════════════════════════════════════
router.delete('/:id', verifyToken, (req, res) => {
  try {
    const db     = getDB();
    const existe = db.prepare('SELECT id FROM citas WHERE id = ?').get(req.params.id);
    if (!existe) return res.status(404).json({ ok: false, message: 'Cita no encontrada.' });

    db.prepare('DELETE FROM citas WHERE id = ?').run(req.params.id);
    return res.json({ ok: true, message: 'Cita eliminada.' });
  } catch (err) {
    console.error('[CITAS DELETE] Error:', err);
    return res.status(500).json({ ok: false, message: 'Error al eliminar la cita.' });
  }
});

module.exports = router;
