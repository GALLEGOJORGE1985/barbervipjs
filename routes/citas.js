/**
 * BARBER VIP — routes/citas.js
 * ─────────────────────────────────────────────────────────────
 * Rutas para el módulo de citas (PostgreSQL + Socket.io).
 *
 * PÚBLICAS (sin token):
 *   POST /api/citas                → Cliente crea una cita (formulario web)
 *   GET  /api/citas/disponibilidad → Horarios ocupados para una fecha
 *   GET  /api/citas/servicios      → Lista de servicios activos
 *   GET  /api/citas/barberos       → Lista de barberos activos
 *
 * PROTEGIDAS (requieren Bearer JWT):
 *   GET    /api/citas              → Listar todas las citas (admin)
 *   GET    /api/citas/:id          → Detalle de una cita
 *   PUT    /api/citas/:id          → Actualizar cita completa
 *   DELETE /api/citas/:id          → Eliminar cita
 *   PATCH  /api/citas/:id/estado   → Cambiar solo el estado
 *   PATCH  /api/citas/:id/vista    → Marcar como vista por admin
 *
 * Cada operación de escritura emite un evento Socket.io
 * ('citas:changed') para que todos los clientes conectados
 * (web/móvil) actualicen su información en tiempo real.
 * ─────────────────────────────────────────────────────────────
 */

const express         = require('express');
const { query }       = require('../db/connection');
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

/** Sanitizar texto para evitar inyección en ILIKE (escapa %, _ y \) */
function escapeLike(str) {
  return str.replace(/[%_\\]/g, c => '\\' + c);
}

/** Emite un evento de sincronización a todos los clientes conectados */
function emitChange(req, event, payload) {
  const io = req.app.get('io');
  if (io) io.emit(event, payload);
}

// ════════════════════════════════════════════════════════════
//  PÚBLICA — GET /api/citas/servicios
// ════════════════════════════════════════════════════════════
router.get('/servicios', async (req, res) => {
  try {
    const result = await query(
      'SELECT id, nombre, precio, duracion, activo FROM servicios WHERE activo = 1 ORDER BY nombre'
    );
    return res.json({ ok: true, data: result.rows });
  } catch (err) {
    console.error('[SERVICIOS] Error:', err);
    return res.status(500).json({ ok: false, message: 'Error al obtener servicios.' });
  }
});

// ════════════════════════════════════════════════════════════
//  PÚBLICA — GET /api/citas/barberos
// ════════════════════════════════════════════════════════════
router.get('/barberos', async (req, res) => {
  try {
    const result = await query(
      'SELECT id, nombre, activo FROM barberos WHERE activo = 1 ORDER BY nombre'
    );
    return res.json({ ok: true, data: result.rows });
  } catch (err) {
    console.error('[BARBEROS] Error:', err);
    return res.status(500).json({ ok: false, message: 'Error al obtener barberos.' });
  }
});

// ════════════════════════════════════════════════════════════
//  PÚBLICA — GET /api/citas/disponibilidad?fecha=YYYY-MM-DD&barbero=nombre
// ════════════════════════════════════════════════════════════
router.get('/disponibilidad', async (req, res) => {
  const { fecha, barbero } = req.query;

  if (!fecha || !isValidDate(fecha)) {
    return res.status(400).json({ ok: false, message: 'Parámetro "fecha" inválido (usa YYYY-MM-DD).' });
  }

  try {
    let result;
    if (barbero && barbero.trim()) {
      result = await query(
        `SELECT hora, barbero, estado
         FROM citas
         WHERE fecha = $1 AND barbero = $2 AND estado <> 'cancelada'`,
        [fecha, barbero.trim()]
      );
    } else {
      result = await query(
        `SELECT hora, barbero, estado
         FROM citas
         WHERE fecha = $1 AND estado <> 'cancelada'`,
        [fecha]
      );
    }

    const ocupados = {};
    for (const row of result.rows) {
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
// ════════════════════════════════════════════════════════════
router.post('/', async (req, res) => {
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
    origen,
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

  // No se puede agendar en el pasado (solo aplica a reservas web)
  if (origen !== 'admin' && fecha && isValidDate(fecha) && hora && isValidTime(hora)) {
    const fechaHora = new Date(`${fecha}T${hora}:00`);
    if (fechaHora <= new Date()) errores.push('No puedes agendar en una fecha/hora pasada.');
  }

  if (errores.length > 0) {
    return res.status(400).json({ ok: false, message: errores.join(' | '), errores });
  }

  try {
    // ── Verificar conflicto de horario ────────────────────────
    const conflicto = await query(
      `SELECT id FROM citas
       WHERE fecha = $1 AND hora = $2 AND barbero = $3 AND estado <> 'cancelada'`,
      [fecha, hora, barbero.trim()]
    );

    if (conflicto.rows.length > 0) {
      return res.status(409).json({
        ok:      false,
        message: `El horario ${hora} del ${fecha} ya está reservado para ${barbero}. Elige otro.`,
      });
    }

    // ── Insertar con parámetros (previene SQL Injection) ──────
    const insertResult = await query(
      `INSERT INTO citas
         (nombre_cliente, telefono, email, servicio, barbero, fecha, hora, precio, notas, origen)
       VALUES
         ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        nombre_cliente.trim(),
        telefono.trim(),
        (email || '').trim(),
        servicio.trim(),
        barbero.trim(),
        fecha,
        hora,
        Number(precio) || 0,
        (notas || '').trim(),
        origen === 'admin' ? 'admin' : 'web',
      ]
    );

    const nuevaCita = insertResult.rows[0];

    // ── 🔔 Notificar a todos los clientes conectados ──────────
    emitChange(req, 'citas:changed', { action: 'created', cita: nuevaCita });

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
//  Query params: fecha, estado, barbero, origen, buscar, page, limit, order
// ════════════════════════════════════════════════════════════
router.get('/', verifyToken, async (req, res) => {
  try {
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
    let   p = 0;

    if (fecha   && isValidDate(fecha)) { p++; conditions.push(`fecha = $${p}`);   params.push(fecha); }
    if (estado)                        { p++; conditions.push(`estado = $${p}`);  params.push(estado); }
    if (barbero)                       { p++; conditions.push(`barbero = $${p}`); params.push(barbero); }
    if (origen)                        { p++; conditions.push(`origen = $${p}`);  params.push(origen); }
    if (buscar) {
      const q = `%${escapeLike(buscar)}%`;
      p++; conditions.push(`(nombre_cliente ILIKE $${p} OR telefono ILIKE $${p} OR email ILIKE $${p})`);
      params.push(q);
    }

    const where   = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const orderBy = order === 'asc' ? 'ASC' : 'DESC';

    const safeLimit = Math.max(1, Number(limit) || 50);
    const safePage  = Math.max(1, Number(page)  || 1);
    const offset    = (safePage - 1) * safeLimit;

    const totalResult = await query(`SELECT COUNT(*) AS n FROM citas ${where}`, params);
    const total = Number(totalResult.rows[0].n);

    const dataParams = [...params, safeLimit, offset];
    const limitIdx   = params.length + 1;
    const offsetIdx  = params.length + 2;

    const rowsResult = await query(
      `SELECT *
       FROM   citas
       ${where}
       ORDER  BY fecha ${orderBy}, hora ${orderBy}
       LIMIT  $${limitIdx} OFFSET $${offsetIdx}`,
      dataParams
    );

    const nuevasWebResult = await query(
      "SELECT COUNT(*) AS n FROM citas WHERE origen = 'web' AND vista_admin = 0 AND estado <> 'cancelada'"
    );

    return res.json({
      ok:   true,
      data: rowsResult.rows,
      meta: {
        total,
        page:      safePage,
        limit:     safeLimit,
        pages:     Math.ceil(total / safeLimit),
        nuevasWeb: Number(nuevasWebResult.rows[0].n),
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
router.get('/:id', verifyToken, async (req, res) => {
  try {
    const result = await query('SELECT * FROM citas WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ ok: false, message: 'Cita no encontrada.' });
    return res.json({ ok: true, data: result.rows[0] });
  } catch (err) {
    console.error('[CITAS GET ID] Error:', err);
    return res.status(500).json({ ok: false, message: 'Error al obtener la cita.' });
  }
});

// ════════════════════════════════════════════════════════════
//  PROTEGIDA — PATCH /api/citas/:id/estado
// ════════════════════════════════════════════════════════════
router.patch('/:id/estado', verifyToken, async (req, res) => {
  const { estado } = req.body;
  const estadosValidos = ['pendiente', 'confirmada', 'completada', 'cancelada'];

  if (!estado || !estadosValidos.includes(estado)) {
    return res.status(400).json({
      ok:      false,
      message: `Estado inválido. Usa: ${estadosValidos.join(', ')}.`,
    });
  }

  try {
    const result = await query(
      `UPDATE citas SET estado = $1, vista_admin = 1 WHERE id = $2 RETURNING *`,
      [estado, req.params.id]
    );

    if (result.rows.length === 0) return res.status(404).json({ ok: false, message: 'Cita no encontrada.' });

    const cita = result.rows[0];
    emitChange(req, 'citas:changed', { action: 'updated', cita });

    return res.json({ ok: true, message: `Estado actualizado a "${estado}".`, data: cita });
  } catch (err) {
    console.error('[CITAS ESTADO] Error:', err);
    return res.status(500).json({ ok: false, message: 'Error al actualizar estado.' });
  }
});

// ════════════════════════════════════════════════════════════
//  PROTEGIDA — PATCH /api/citas/:id/vista
// ════════════════════════════════════════════════════════════
router.patch('/:id/vista', verifyToken, async (req, res) => {
  try {
    const result = await query(
      'UPDATE citas SET vista_admin = 1 WHERE id = $1 RETURNING *',
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ ok: false, message: 'Cita no encontrada.' });

    emitChange(req, 'citas:changed', { action: 'updated', cita: result.rows[0] });
    return res.json({ ok: true, message: 'Cita marcada como vista.' });
  } catch (err) {
    console.error('[CITAS VISTA] Error:', err);
    return res.status(500).json({ ok: false, message: 'Error al marcar como vista.' });
  }
});

// ════════════════════════════════════════════════════════════
//  PROTEGIDA — PUT /api/citas/:id
// ════════════════════════════════════════════════════════════
router.put('/:id', verifyToken, async (req, res) => {
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
    const actualResult = await query('SELECT * FROM citas WHERE id = $1', [req.params.id]);
    if (actualResult.rows.length === 0) return res.status(404).json({ ok: false, message: 'Cita no encontrada.' });
    const actual = actualResult.rows[0];

    const nuevaFecha   = fecha   || actual.fecha;
    const nuevaHora    = hora    || actual.hora;
    const nuevoBarbero = barbero || actual.barbero;

    if (nuevaFecha !== actual.fecha || nuevaHora !== actual.hora || nuevoBarbero !== actual.barbero) {
      const conflicto = await query(
        `SELECT id FROM citas
         WHERE fecha = $1 AND hora = $2 AND barbero = $3 AND id <> $4 AND estado <> 'cancelada'`,
        [nuevaFecha, nuevaHora, nuevoBarbero, req.params.id]
      );

      if (conflicto.rows.length > 0) {
        return res.status(409).json({
          ok:      false,
          message: `Conflicto de horario: ${nuevoBarbero} ya tiene cita a las ${nuevaHora} el ${nuevaFecha}.`,
        });
      }
    }

    const updateResult = await query(
      `UPDATE citas SET
         nombre_cliente = $1,
         telefono       = $2,
         email          = $3,
         servicio       = $4,
         barbero        = $5,
         fecha          = $6,
         hora           = $7,
         precio         = $8,
         notas          = $9,
         estado         = $10,
         vista_admin    = 1
       WHERE id = $11
       RETURNING *`,
      [
        (nombre_cliente ?? actual.nombre_cliente).trim(),
        (telefono       ?? actual.telefono).trim(),
        (email          ?? actual.email ?? '').trim(),
        (servicio       ?? actual.servicio).trim(),
        (barbero        ?? actual.barbero).trim(),
        nuevaFecha,
        nuevaHora,
        precio !== undefined ? Number(precio) : actual.precio,
        (notas ?? actual.notas ?? '').trim(),
        estado || actual.estado,
        req.params.id,
      ]
    );

    const cita = updateResult.rows[0];
    emitChange(req, 'citas:changed', { action: 'updated', cita });

    return res.json({ ok: true, message: 'Cita actualizada.', data: cita });
  } catch (err) {
    console.error('[CITAS PUT] Error:', err);
    return res.status(500).json({ ok: false, message: 'Error al actualizar la cita.' });
  }
});

// ════════════════════════════════════════════════════════════
//  PROTEGIDA — DELETE /api/citas/:id
// ════════════════════════════════════════════════════════════
router.delete('/:id', verifyToken, async (req, res) => {
  try {
    const result = await query('DELETE FROM citas WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ ok: false, message: 'Cita no encontrada.' });

    emitChange(req, 'citas:changed', { action: 'deleted', cita: { id: Number(req.params.id) } });
    return res.json({ ok: true, message: 'Cita eliminada.' });
  } catch (err) {
    console.error('[CITAS DELETE] Error:', err);
    return res.status(500).json({ ok: false, message: 'Error al eliminar la cita.' });
  }
});

module.exports = router;
