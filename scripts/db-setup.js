'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');

const SQL_PATH = path.join(__dirname, '../migrations/001_init.sql');

async function setup() {
  if (!process.env.DATABASE_URL) {
    console.error('❌ DATABASE_URL is not set in .env');
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  console.log('🔌 Connecting to database…');

  let client;
  try {
    client = await pool.connect();
    console.log('✅ Connected');

    const sql = fs.readFileSync(SQL_PATH, 'utf8');
    console.log('📦 Running migrations/001_init.sql…');
    await client.query(sql);
    console.log('✅ Schema created successfully');

    // Verify tables were created
    const { rows } = await client.query(`
      SELECT table_name
      FROM   information_schema.tables
      WHERE  table_schema = 'public'
      ORDER  BY table_name
    `);
    console.log('\nTables in database:');
    rows.forEach(r => console.log(`  ✔ ${r.table_name}`));

  } catch (err) {
    console.error('❌ Setup failed:', err.message);
    process.exit(1);
  } finally {
    if (client) client.release();
    await pool.end();
  }
}

setup();
