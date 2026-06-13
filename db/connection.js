/**
 * BARBER VIP — db/connection.js
 * ─────────────────────────────────────────────────────────────
 * Pool de conexiones a PostgreSQL usando `pg`.
 * Se importa en cualquier archivo que necesite acceso a la BD.
 *
 * Uso:
 *   const { query } = require('../db/connection');
 *   const result = await query('SELECT * FROM citas WHERE id = $1', [id]);
 *   result.rows  → array de filas
 * ─────────────────────────────────────────────────────────────
 */

require('dotenv').config();
const { Pool } = require('pg');

let pool = null;

function getPool() {
  if (pool) return pool;

  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error(
      '❌ DATABASE_URL no está configurada.\n' +
      '   En Render: crea un servicio PostgreSQL (plan Free) y\n' +
      '   copia la "Internal Database URL" a las variables de entorno.\n' +
      '   En local: agrega DATABASE_URL en tu archivo .env'
    );
  }

  // Render/Heroku-style URLs requieren SSL pero con certificado
  // autofirmado, por eso rejectUnauthorized: false.
  // En localhost no se usa SSL.
  const useSSL = !/localhost|127\.0\.0\.1/.test(connectionString);

  pool = new Pool({
    connectionString,
    ssl: useSSL ? { rejectUnauthorized: false } : false,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });

  pool.on('error', (err) => {
    console.error('[DB POOL] Error inesperado en el pool de conexiones:', err.message);
  });

  return pool;
}

/**
 * query — ejecuta una consulta SQL con parámetros posicionales ($1, $2, ...)
 * @param {string} text  - SQL con placeholders $1, $2...
 * @param {Array}  params - valores para los placeholders
 * @returns {Promise<import('pg').QueryResult>}
 */
async function query(text, params) {
  const p = getPool();
  return p.query(text, params);
}

/**
 * getClient — obtiene un cliente individual del pool para
 * transacciones manuales (BEGIN/COMMIT/ROLLBACK).
 * IMPORTANTE: siempre llamar a client.release() al terminar.
 */
async function getClient() {
  const p = getPool();
  return p.connect();
}

module.exports = { query, getClient, getPool };
