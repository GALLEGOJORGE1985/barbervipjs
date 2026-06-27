/**
 * BARBER VIP — routes/inventario.js
 * Rutas para inventario de productos y movimientos de stock.
 * Todas protegidas con verifyToken.
 *
 *  GET    /api/inventario              → Listar productos
 *  POST   /api/inventario              → Crear producto
 *  PUT    /api/inventario/:id          → Editar producto
 *  DELETE /api/inventario/:id          → Eliminar producto
 *  GET    /api/inventario/movimientos  → Listar movimientos
 *  POST   /api/inventario/movimientos  → Registrar movimiento (entrada/salida)
 *  GET    /api/inventario/stats        → Resumen de inventario
 */

const express         = require('express');
const { query }       = require('../db/connection');
const { verifyToken } = require('../middleware/auth');

const router = express.Router();
router.use(verifyToken);

const PG_UNIQUE = '23505';

function emit(req, event, payload) {
  const io = req.app.get('io');
  if (io) io.emit(event, payload);
}

// ════════════════════════════════════════════════════════
//  PRODUCTOS
// ════════════════════════════════════════════════════════

router.get('/', async (req, res) => {
  try {
    const result = await query(
      'SELECT * FROM productos ORDER BY nombre ASC'
    );
    return res.json({ ok: true, data: result.rows });
  } catch (err) {
    console.error('[INV GET]', err);
    return res.status(500).json({ ok: false, message: 'Error al obtener inventario.' });
  }
});

router.post('/', async (req, res) => {
  const { nombre, referencia = '', categoria = '', proveedor = '',
          precioCompra = 0, precioVenta = 0, cantidad = 0, stockMinimo = 5, imagen = '' } = req.body;
  if (!nombre || nombre.trim().length < 2)
    return res.status(400).json({ ok: false, message: 'Nombre del producto requerido.' });
  try {
    const r = await query(
      `INSERT INTO productos
         (nombre, referencia, categoria, proveedor, precio_compra, precio_venta, cantidad, stock_minimo, imagen)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [nombre.trim(), referencia.trim(), categoria.trim(), proveedor.trim(),
       Number(precioCompra), Number(precioVenta), Number(cantidad), Number(stockMinimo), imagen]
    );
    const prod = r.rows[0];
    emit(req, 'inventario:changed', { action: 'created', producto: prod });
    return res.status(201).json({ ok: true, data: prod });
  } catch (err) {
    if (err.code === PG_UNIQUE) return res.status(409).json({ ok: false, message: 'Ya existe un producto con ese nombre.' });
    console.error('[INV POST]', err);
    return res.status(500).json({ ok: false, message: 'Error al crear producto.' });
  }
});

router.put('/:id', async (req, res) => {
  const { nombre, referencia, categoria, proveedor,
          precioCompra, precioVenta, cantidad, stockMinimo, imagen } = req.body;
  try {
    const actual = await query('SELECT * FROM productos WHERE id = $1', [req.params.id]);
    if (actual.rows.length === 0) return res.status(404).json({ ok: false, message: 'Producto no encontrado.' });
    const a = actual.rows[0];

    const r = await query(
      `UPDATE productos SET
         nombre        = $1, referencia    = $2, categoria    = $3, proveedor     = $4,
         precio_compra = $5, precio_venta  = $6, cantidad     = $7, stock_minimo  = $8,
         imagen        = $9,
         updated_at    = to_char(NOW(),'YYYY-MM-DD HH24:MI:SS')
       WHERE id = $10 RETURNING *`,
      [
        (nombre        ?? a.nombre).trim(),
        (referencia    ?? a.referencia ?? '').trim(),
        (categoria     ?? a.categoria  ?? '').trim(),
        (proveedor     ?? a.proveedor  ?? '').trim(),
        precioCompra  !== undefined ? Number(precioCompra)  : a.precio_compra,
        precioVenta   !== undefined ? Number(precioVenta)   : a.precio_venta,
        cantidad      !== undefined ? Number(cantidad)      : a.cantidad,
        stockMinimo   !== undefined ? Number(stockMinimo)   : a.stock_minimo,
        imagen        !== undefined ? imagen                : (a.imagen || ''),
        req.params.id,
      ]
    );
    const prod = r.rows[0];
    emit(req, 'inventario:changed', { action: 'updated', producto: prod });
    return res.json({ ok: true, data: prod });
  } catch (err) {
    console.error('[INV PUT]', err);
    return res.status(500).json({ ok: false, message: 'Error al actualizar producto.' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const r = await query('DELETE FROM productos WHERE id = $1 RETURNING id', [req.params.id]);
    if (r.rows.length === 0) return res.status(404).json({ ok: false, message: 'Producto no encontrado.' });
    emit(req, 'inventario:changed', { action: 'deleted', producto: { id: Number(req.params.id) } });
    return res.json({ ok: true, message: 'Producto eliminado.' });
  } catch (err) {
    console.error('[INV DELETE]', err);
    return res.status(500).json({ ok: false, message: 'Error al eliminar producto.' });
  }
});

// ════════════════════════════════════════════════════════
//  MOVIMIENTOS
// ════════════════════════════════════════════════════════

router.get('/movimientos', async (req, res) => {
  try {
    const { limit = 200 } = req.query;
    const r = await query(
      'SELECT * FROM movimientos_stock ORDER BY created_at DESC LIMIT $1',
      [Number(limit)]
    );
    return res.json({ ok: true, data: r.rows });
  } catch (err) {
    console.error('[MOV GET]', err);
    return res.status(500).json({ ok: false, message: 'Error al obtener movimientos.' });
  }
});

router.post('/movimientos', async (req, res) => {
  const { productoId, tipo, cantidad, notas = '', usuario = 'admin' } = req.body;
  if (!productoId || !tipo || !cantidad)
    return res.status(400).json({ ok: false, message: 'productoId, tipo y cantidad son requeridos.' });
  if (!['entrada', 'salida', 'ajuste'].includes(tipo))
    return res.status(400).json({ ok: false, message: 'tipo debe ser: entrada, salida o ajuste.' });
  if (Number(cantidad) <= 0)
    return res.status(400).json({ ok: false, message: 'La cantidad debe ser mayor a 0.' });

  try {
    // Obtener producto actual
    const prodResult = await query('SELECT * FROM productos WHERE id = $1', [productoId]);
    if (prodResult.rows.length === 0)
      return res.status(404).json({ ok: false, message: 'Producto no encontrado.' });
    const prod = prodResult.rows[0];

    // Calcular nueva cantidad
    let nuevaCantidad = Number(prod.cantidad);
    if (tipo === 'entrada')  nuevaCantidad += Number(cantidad);
    if (tipo === 'salida')   nuevaCantidad -= Number(cantidad);
    if (tipo === 'ajuste')   nuevaCantidad  = Number(cantidad);

    if (nuevaCantidad < 0)
      return res.status(400).json({ ok: false, message: `Stock insuficiente. Disponible: ${prod.cantidad}` });

    // Registrar movimiento
    const movResult = await query(
      `INSERT INTO movimientos_stock
         (producto_id, nombre_producto, tipo, cantidad, cantidad_anterior, cantidad_nueva, notas, usuario)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [productoId, prod.nombre, tipo, Number(cantidad),
       Number(prod.cantidad), nuevaCantidad, notas.trim(), usuario]
    );

    // Actualizar stock del producto
    const updResult = await query(
      `UPDATE productos SET cantidad = $1, updated_at = to_char(NOW(),'YYYY-MM-DD HH24:MI:SS')
       WHERE id = $2 RETURNING *`,
      [nuevaCantidad, productoId]
    );

    const mov  = movResult.rows[0];
    const prodActualizado = updResult.rows[0];

    // Emitir a todos los clientes conectados
    emit(req, 'inventario:changed', { action: 'movimiento', movimiento: mov, producto: prodActualizado });

    return res.status(201).json({ ok: true, data: { movimiento: mov, producto: prodActualizado } });
  } catch (err) {
    console.error('[MOV POST]', err);
    return res.status(500).json({ ok: false, message: 'Error al registrar movimiento.' });
  }
});

// ════════════════════════════════════════════════════════
//  STATS
// ════════════════════════════════════════════════════════
router.get('/stats', async (req, res) => {
  try {
    const total  = await query('SELECT COUNT(*) AS n, COALESCE(SUM(cantidad * precio_venta),0) AS valor FROM productos');
    const bajos  = await query('SELECT COUNT(*) AS n FROM productos WHERE cantidad <= stock_minimo');
    const ultimo = await query('SELECT * FROM movimientos_stock ORDER BY created_at DESC LIMIT 5');
    return res.json({
      ok: true,
      data: {
        totalProductos:  Number(total.rows[0].n),
        valorInventario: Number(total.rows[0].valor),
        stockBajo:       Number(bajos.rows[0].n),
        ultimosMovimientos: ultimo.rows,
      },
    });
  } catch (err) {
    return res.status(500).json({ ok: false, message: 'Error al obtener estadísticas.' });
  }
});

module.exports = router;
