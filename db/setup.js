/**
 * BARBER VIP — db/setup.js
 * ─────────────────────────────────────────────────────────────
 * Script de inicialización de la base de datos SQLite.
 * Ejecutar UNA VEZ con: node db/setup.js
 * También se ejecuta automáticamente en el arranque del servidor.
 * ─────────────────────────────────────────────────────────────
 */

require('dotenv').config();
const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');

const DB_PATH = process.env.DB_PATH || './db/barbervip.db';

// Asegurar que el directorio exista
const dbDir = path.dirname(path.resolve(DB_PATH));
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(path.resolve(DB_PATH));

// ── Activar WAL mode para mejor rendimiento ──────────────────
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

console.log('📦 Iniciando configuración de la base de datos BARBER VIP...\n');

// ═══════════════════════════════════════════════════════════════
//  TABLA: citas
//  Guarda todas las reservas de clientes (web + admin)
// ═══════════════════════════════════════════════════════════════
db.exec(`
  CREATE TABLE IF NOT EXISTS citas (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre_cliente  TEXT    NOT NULL,
    telefono        TEXT    NOT NULL,
    email           TEXT    DEFAULT '',
    servicio        TEXT    NOT NULL,
    barbero         TEXT    NOT NULL DEFAULT '',
    fecha           TEXT    NOT NULL,          -- formato YYYY-MM-DD
    hora            TEXT    NOT NULL,          -- formato HH:MM
    precio          REAL    DEFAULT 0,
    estado          TEXT    NOT NULL DEFAULT 'pendiente'
                            CHECK(estado IN ('pendiente','confirmada','completada','cancelada')),
    notas           TEXT    DEFAULT '',
    origen          TEXT    NOT NULL DEFAULT 'web'
                            CHECK(origen IN ('web','admin')),
    vista_admin     INTEGER NOT NULL DEFAULT 0, -- 0=no vista, 1=vista
    created_at      TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at      TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
  );
`);
console.log('  ✅ Tabla "citas" lista');

// ═══════════════════════════════════════════════════════════════
//  TABLA: servicios
//  Catálogo de servicios de la barbería
// ═══════════════════════════════════════════════════════════════
db.exec(`
  CREATE TABLE IF NOT EXISTS servicios (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre      TEXT    NOT NULL UNIQUE,
    precio      REAL    NOT NULL DEFAULT 0,
    duracion    INTEGER NOT NULL DEFAULT 30,    -- minutos
    activo      INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
  );
`);
console.log('  ✅ Tabla "servicios" lista');

// ═══════════════════════════════════════════════════════════════
//  TABLA: barberos
// ═══════════════════════════════════════════════════════════════
db.exec(`
  CREATE TABLE IF NOT EXISTS barberos (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre      TEXT    NOT NULL UNIQUE,
    activo      INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
  );
`);
console.log('  ✅ Tabla "barberos" lista');

// ═══════════════════════════════════════════════════════════════
//  TABLA: config
//  Ajustes generales del negocio
// ═══════════════════════════════════════════════════════════════
db.exec(`
  CREATE TABLE IF NOT EXISTS config (
    clave       TEXT PRIMARY KEY,
    valor       TEXT NOT NULL,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );
`);
console.log('  ✅ Tabla "config" lista');

// ── ÍNDICES para búsquedas rápidas ──────────────────────────
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_citas_fecha     ON citas(fecha);
  CREATE INDEX IF NOT EXISTS idx_citas_estado    ON citas(estado);
  CREATE INDEX IF NOT EXISTS idx_citas_telefono  ON citas(telefono);
  CREATE INDEX IF NOT EXISTS idx_citas_barbero   ON citas(barbero);
  CREATE INDEX IF NOT EXISTS idx_citas_origen    ON citas(origen);
`);
console.log('  ✅ Índices creados');

// ── TRIGGER: actualizar updated_at automáticamente ──────────
db.exec(`
  CREATE TRIGGER IF NOT EXISTS citas_updated_at
  AFTER UPDATE ON citas
  BEGIN
    UPDATE citas SET updated_at = datetime('now','localtime')
    WHERE id = NEW.id;
  END;
`);
console.log('  ✅ Trigger updated_at listo');

// ═══════════════════════════════════════════════════════════════
//  DATOS INICIALES
// ═══════════════════════════════════════════════════════════════
const insertServicio = db.prepare(`
  INSERT OR IGNORE INTO servicios (nombre, precio, duracion)
  VALUES (@nombre, @precio, @duracion)
`);

const serviciosDemo = [
  { nombre: 'Corte clásico',         precio: 35000, duracion: 30 },
  { nombre: 'Corte + barba',         precio: 55000, duracion: 50 },
  { nombre: 'Afeitado tradicional',  precio: 30000, duracion: 25 },
  { nombre: 'Diseño de barba',       precio: 25000, duracion: 20 },
  { nombre: 'Color de cabello',      precio: 80000, duracion: 60 },
  { nombre: 'Tratamiento capilar',   precio: 45000, duracion: 40 },
  { nombre: 'Cejas',                 precio: 15000, duracion: 15 },
];

const insertManyServicios = db.transaction((items) => {
  for (const s of items) insertServicio.run(s);
});
insertManyServicios(serviciosDemo);
console.log('  ✅ Servicios iniciales cargados');

const insertBarbero = db.prepare(`
  INSERT OR IGNORE INTO barberos (nombre) VALUES (@nombre)
`);
const barberosDemo = [
  { nombre: 'Carlos Rodríguez' },
  { nombre: 'Miguel Torres'    },
  { nombre: 'Sebastián López'  },
];
const insertManyBarberos = db.transaction((items) => {
  for (const b of items) insertBarbero.run(b);
});
insertManyBarberos(barberosDemo);
console.log('  ✅ Barberos iniciales cargados');

// Config del negocio
const upsertConfig = db.prepare(`
  INSERT OR IGNORE INTO config (clave, valor) VALUES (@clave, @valor)
`);
const configInicial = [
  { clave: 'nombre_negocio', valor: 'BARBER VIP' },
  { clave: 'nit',            valor: '900.123.456-7' },
  { clave: 'direccion',      valor: 'Calle 72 #45-23, El Poblado, Medellín' },
  { clave: 'telefono',       valor: '+57 300 123 4567' },
  { clave: 'email',          valor: 'info@barbervip.co' },
  { clave: 'horario_inicio', valor: '08:00' },
  { clave: 'horario_fin',    valor: '20:00' },
  { clave: 'intervalo_min',  valor: '30' },
];
const seedConfig = db.transaction((items) => {
  for (const c of items) upsertConfig.run(c);
});
seedConfig(configInicial);
console.log('  ✅ Configuración inicial cargada');

db.close();

console.log('\n🎉 Base de datos BARBER VIP configurada correctamente.');
console.log(`   Archivo: ${path.resolve(DB_PATH)}\n`);

module.exports = { DB_PATH };
