'use strict';
require('dotenv').config();
const { Pool } = require('pg');

const isRemote =
  process.env.NODE_ENV === 'production' ||
  (process.env.DATABASE_URL || '').includes('railway') ||
  (process.env.DATABASE_URL || '').includes('postgres.railway');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isRemote ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('Idle pg client error:', err.message);
});

module.exports = pool;
