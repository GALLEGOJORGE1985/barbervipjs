/**
 * BARBER VIP — routes/facturas.js
 * Rutas para el módulo de facturación.
 * Todas protegidas con verifyToken.
 *
 *  GET    /api/facturas         → Listar facturas (con paginación)
 *  GET    /api/facturas/:id     → Detalle de una factura
 *  POST   /api/facturas         → Crear factura
 *  GET    /api/facturas/stats   → Resumen de ingresos
 */

const express         = require('express');
const { query }       = require('../db/connection');
const { verifyToken } = require('../middleware/auth');

const router = express.Router();
router.use(verifyToken);

function emit(req, event, payload) {
  const io = req.app.get('io');
  if (io) io.emit(event, payload);
}

// GET /api/facturas
router.get('/', async (req, res) => {
  try {
    const { buscar, page = 1, limit = 50 } = req.query;
    const safePage  = Math.max(1, Number(page));
    const safeLimit = Math.max(1, Math.min(200, Number(limit)));
    const offset    = (safePage - 1) * safeLimit;

    let where  = '';
    let params = [];
    if (buscar) {
      where    = 'WHERE nombre_cliente ILIKE $1 OR numero ILIKE $1';
      params   = [`%${buscar}%`];
    }

    const total  = await query(`SELECT COUNT(*) AS n FROM facturas ${where}`, params);
    const result = await query(
      `SELECT * FROM facturas ${where}
       ORDER BY created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, safeLimit, offset]
    );

    return res.json({
      ok:   true,
      data: result.rows,
      meta: {
        total: Number(total.rows[0].n),
        page:  safePage,
        limit: safeLimit,
        pages: Math.ceil(Number(total.rows[0].n) / safeLimit),
      },
    });
  } catch (err) {
    console.error('[FAC GET]', err);
    return res.status(500).json({ ok: false, message: 'Error al obtener facturas.' });
  }
});

// GET /api/facturas/stats
router.get('/stats', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const month = today.slice(0, 7);

    const hoy = await query(
      'SELECT COALESCE(SUM(total),0) AS total, COUNT(*) AS n FROM facturas WHERE fecha = $1',
      [today]
    );
    const mes = await query(
      "SELECT COALESCE(SUM(total),0) AS total, COUNT(*) AS n FROM facturas WHERE SUBSTRING(fecha FROM 1 FOR 7) = $1",
      [month]
    );

    return res.json({
      ok: true,
      data: {
        hoy:  { total: Number(hoy.rows[0].total),  cantidad: Number(hoy.rows[0].n) },
        mes:  { total: Number(mes.rows[0].total),  cantidad: Number(mes.rows[0].n) },
      },
    });
  } catch (err) {
    return res.status(500).json({ ok: false, message: 'Error en stats de facturas.' });
  }
});

// GET /api/facturas/:id
router.get('/:id', async (req, res) => {
  try {
    const result = await query('SELECT * FROM facturas WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ ok: false, message: 'Factura no encontrada.' });
    return res.json({ ok: true, data: result.rows[0] });
  } catch (err) {
    return res.status(500).json({ ok: false, message: 'Error al obtener factura.' });
  }
});

// POST /api/facturas
router.post('/', async (req, res) => {
  const { numero, fecha, nombreCliente, telefonoCliente = '',
          items, subtotal, descuento = 0, descuentoAmt = 0,
          ivaPct = 0, ivaAmt = 0, total, metodoPago = 'efectivo' } = req.body;

  if (!numero || !fecha || !nombreCliente || !items || !total)
    return res.status(400).json({ ok: false, message: 'Faltan campos obligatorios.' });

  try {
    const r = await query(
      `INSERT INTO facturas
         (numero, fecha, nombre_cliente, telefono_cliente, items,
          subtotal, descuento_pct, descuento_amt, iva_pct, iva_amt, total, metodo_pago)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [
        numero, fecha, nombreCliente.trim(), (telefonoCliente || '').trim(),
        JSON.stringify(items),
        Number(subtotal), Number(descuento), Number(descuentoAmt),
        Number(ivaPct), Number(ivaAmt), Number(total), metodoPago,
      ]
    );
    const factura = r.rows[0];

    // Descontar stock de los productos de inventario incluidos en la factura
    for (const item of (items || [])) {
      if (item.type === 'product' && item.description) {
        try {
          const prod = await query(
            'SELECT id, cantidad FROM productos WHERE nombre = $1',
            [item.description]
          );
          if (prod.rows.length > 0) {
            const nuevaCant = Math.max(0, Number(prod.rows[0].cantidad) - Number(item.qty || 1));
            await query(
              `UPDATE productos SET cantidad = $1, updated_at = to_char(NOW(),'YYYY-MM-DD HH24:MI:SS')
               WHERE id = $2`,
              [nuevaCant, prod.rows[0].id]
            );
            // Registrar movimiento de salida
            await query(
              `INSERT INTO movimientos_stock
                 (producto_id, nombre_producto, tipo, cantidad, cantidad_anterior, cantidad_nueva, notas, usuario)
               VALUES ($1,$2,'salida',$3,$4,$5,$6,'facturación')`,
              [prod.rows[0].id, item.description, Number(item.qty || 1),
               Number(prod.rows[0].cantidad), nuevaCant,
               `Factura ${numero}`]
            );
          }
        } catch (e) {
          console.warn('[FAC] No se pudo descontar stock de', item.description, ':', e.message);
        }
      }
    }

    // Notificar a todos los clientes conectados
    emit(req, 'facturas:changed',    { action: 'created', factura });
    emit(req, 'inventario:changed',  { action: 'updated_by_factura' });

    return res.status(201).json({ ok: true, data: factura });
  } catch (err) {
    console.error('[FAC POST]', err);
    return res.status(500).json({ ok: false, message: 'Error al crear factura.' });
  }
});

module.exports = router;
