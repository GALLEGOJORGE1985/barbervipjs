/**
 * BARBER VIP — db/setup.js
 * ─────────────────────────────────────────────────────────────
 * Inicializa el esquema de PostgreSQL: crea tablas, índices,
 * triggers y datos iniciales (servicios/barberos/config demo).
 *
 * Se ejecuta automáticamente al arrancar el servidor (server.js
 * la llama con `await initDatabase()` antes de app.listen()).
 *
 * También puede ejecutarse manualmente:
 *   node db/setup.js
 * ─────────────────────────────────────────────────────────────
 */

require('dotenv').config();
const { query } = require('./connection');

async function initDatabase() {
  console.log('📦 Verificando esquema de PostgreSQL (BARBER VIP)...\n');

  // ═══════════════════════════════════════════════════════════
  //  TABLA: citas
  // ═══════════════════════════════════════════════════════════
  await query(`
    CREATE TABLE IF NOT EXISTS citas (
      id              SERIAL PRIMARY KEY,
      nombre_cliente  TEXT    NOT NULL,
      telefono        TEXT    NOT NULL,
      email           TEXT    DEFAULT '',
      servicio        TEXT    NOT NULL,
      barbero         TEXT    NOT NULL DEFAULT '',
      fecha           TEXT    NOT NULL,
      hora            TEXT    NOT NULL,
      precio          NUMERIC NOT NULL DEFAULT 0,
      estado          TEXT    NOT NULL DEFAULT 'pendiente'
                              CHECK (estado IN ('pendiente','confirmada','completada','cancelada')),
      notas           TEXT    DEFAULT '',
      origen          TEXT    NOT NULL DEFAULT 'web'
                              CHECK (origen IN ('web','admin')),
      vista_admin     INTEGER NOT NULL DEFAULT 0,
      created_at      TEXT    NOT NULL DEFAULT to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS'),
      updated_at      TEXT    NOT NULL DEFAULT to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS')
    );
  `);
  console.log('  ✅ Tabla "citas" lista');

  // ═══════════════════════════════════════════════════════════
  //  TABLA: servicios
  // ═══════════════════════════════════════════════════════════
  await query(`
    CREATE TABLE IF NOT EXISTS servicios (
      id          SERIAL PRIMARY KEY,
      nombre      TEXT    NOT NULL UNIQUE,
      precio      NUMERIC NOT NULL DEFAULT 0,
      duracion    INTEGER NOT NULL DEFAULT 30,
      activo      INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT    NOT NULL DEFAULT to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS')
    );
  `);
  console.log('  ✅ Tabla "servicios" lista');

  // ═══════════════════════════════════════════════════════════
  //  TABLA: barberos
  // ═══════════════════════════════════════════════════════════
  await query(`
    CREATE TABLE IF NOT EXISTS barberos (
      id          SERIAL PRIMARY KEY,
      nombre      TEXT    NOT NULL UNIQUE,
      activo      INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT    NOT NULL DEFAULT to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS')
    );
  `);
  console.log('  ✅ Tabla "barberos" lista');

  // ═══════════════════════════════════════════════════════════
  //  TABLA: config
  // ═══════════════════════════════════════════════════════════
  await query(`
    CREATE TABLE IF NOT EXISTS config (
      clave       TEXT PRIMARY KEY,
      valor       TEXT NOT NULL,
      updated_at  TEXT NOT NULL DEFAULT to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS')
    );
  `);
  console.log('  ✅ Tabla "config" lista');

  // ── ÍNDICES ──────────────────────────────────────────────────
  await query(`CREATE INDEX IF NOT EXISTS idx_citas_fecha    ON citas(fecha);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_citas_estado   ON citas(estado);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_citas_telefono ON citas(telefono);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_citas_barbero  ON citas(barbero);`);
  await query(`CREATE INDEX IF NOT EXISTS idx_citas_origen   ON citas(origen);`);
  console.log('  ✅ Índices listos');

  // ── TRIGGER: actualizar updated_at automáticamente ──────────
  await query(`
    CREATE OR REPLACE FUNCTION set_citas_updated_at()
    RETURNS TRIGGER AS $$
    BEGIN
      NEW.updated_at := to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS');
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);

  await query(`
    DROP TRIGGER IF EXISTS citas_updated_at ON citas;
  `);

  await query(`
    CREATE TRIGGER citas_updated_at
    BEFORE UPDATE ON citas
    FOR EACH ROW
    EXECUTE FUNCTION set_citas_updated_at();
  `);
  console.log('  ✅ Trigger updated_at listo');

  // ═══════════════════════════════════════════════════════════
  //  DATOS INICIALES (solo se insertan si no existen)
  // ═══════════════════════════════════════════════════════════
  const serviciosDemo = [
    ['Corte clásico',        35000, 30],
    ['Corte + barba',        55000, 50],
    ['Afeitado tradicional', 30000, 25],
    ['Diseño de barba',      25000, 20],
    ['Color de cabello',     80000, 60],
    ['Tratamiento capilar',  45000, 40],
    ['Cejas',                15000, 15],
  ];
  for (const [nombre, precio, duracion] of serviciosDemo) {
    await query(
      `INSERT INTO servicios (nombre, precio, duracion)
       VALUES ($1, $2, $3)
       ON CONFLICT (nombre) DO NOTHING`,
      [nombre, precio, duracion]
    );
  }
  console.log('  ✅ Servicios iniciales verificados');

  const barberosDemo = ['Carlos Rodríguez', 'Miguel Torres', 'Sebastián López'];
  for (const nombre of barberosDemo) {
    await query(
      `INSERT INTO barberos (nombre) VALUES ($1) ON CONFLICT (nombre) DO NOTHING`,
      [nombre]
    );
  }
  console.log('  ✅ Barberos iniciales verificados');

  const configInicial = [
    ['nombre_negocio', 'BARBER VIP'],
    ['nit',            '900.123.456-7'],
    ['direccion',      'Calle 72 #45-23, El Poblado, Medellín'],
    ['telefono',       '+57 300 123 4567'],
    ['email',          'info@barbervip.co'],
    ['horario_inicio', '08:00'],
    ['horario_fin',    '20:00'],
    ['intervalo_min',  '30'],
  ];
  for (const [clave, valor] of configInicial) {
    await query(
      `INSERT INTO config (clave, valor) VALUES ($1, $2) ON CONFLICT (clave) DO NOTHING`,
      [clave, valor]
    );
  }
  console.log('  ✅ Configuración inicial verificada');

  console.log('\n🎉 Esquema de PostgreSQL listo (BARBER VIP)\n');
}

// Permite ejecutar manualmente: node db/setup.js
if (require.main === module) {
  initDatabase()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('❌ Error inicializando la base de datos:', err.message);
      process.exit(1);
    });
}

module.exports = { initDatabase };
