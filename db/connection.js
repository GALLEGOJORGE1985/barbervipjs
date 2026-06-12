/**
 * BARBER VIP — db/connection.js
 * Singleton de conexión a SQLite usando better-sqlite3.
 * Se importa en cualquier archivo que necesite acceso a la BD.
 */

require('dotenv').config();
const Database = require('better-sqlite3');
const path     = require('path');

const DB_PATH = process.env.DB_PATH || './db/barbervip.db';

let instance = null;

function getDB() {
  if (!instance) {
    instance = new Database(path.resolve(DB_PATH));
    instance.pragma('journal_mode = WAL');
    instance.pragma('foreign_keys = ON');
  }
  return instance;
}

module.exports = { getDB };
