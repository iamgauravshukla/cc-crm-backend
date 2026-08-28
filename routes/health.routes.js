'use strict';
const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

const APP_VERSION = '1.0.0';

// ── Quick health check ────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const health = {
    status: 'OK',
    version: APP_VERSION,
    timestamp: new Date().toISOString(),
    uptime: Math.round(process.uptime()),
    environment: process.env.NODE_ENV || 'development',
    checks: { server: 'OK', environment: 'OK', database: 'CHECKING' }
  };

  try {
    const required = ['JWT_SECRET', 'DATABASE_URL', 'PORT'];
    const missing  = required.filter(v => !process.env[v]);
    if (missing.length) {
      health.checks.environment = 'ERROR';
      health.checks.environmentDetails = `Missing: ${missing.join(', ')}`;
      health.status = 'DEGRADED';
    }

    try {
      const t0 = Date.now();
      const { rows } = await pool.query('SELECT 1 AS ok');
      const latencyMs = Date.now() - t0;
      health.checks.database = rows[0].ok === 1 ? 'OK' : 'ERROR';
      health.checks.dbLatencyMs = latencyMs;
    } catch (err) {
      health.checks.database = 'ERROR';
      health.checks.databaseDetails = err.message;
      health.status = 'DEGRADED';
    }

    res.status(health.status === 'OK' ? 200 : 503).json(health);
  } catch (err) {
    res.status(503).json({ status: 'ERROR', timestamp: new Date().toISOString(), error: err.message });
  }
});

// ── Detailed health check ─────────────────────────────────────────────────────
router.get('/detailed', async (req, res) => {
  const mem = process.memoryUsage();
  const detail = {
    status: 'OK',
    version: APP_VERSION,
    timestamp: new Date().toISOString(),
    uptime: Math.round(process.uptime()),
    pid: process.pid,
    memory: {
      heapUsedMB:  Math.round(mem.heapUsed  / 1024 / 1024),
      heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
      rssMB:       Math.round(mem.rss       / 1024 / 1024),
      externalMB:  Math.round(mem.external  / 1024 / 1024)
    },
    environment: {
      nodeVersion: process.version,
      platform:    process.platform,
      env:         process.env.NODE_ENV || 'development',
      port:        process.env.PORT     || 5001
    },
    pool: {
      total:   pool.totalCount,
      idle:    pool.idleCount,
      waiting: pool.waitingCount
    },
    checks: { server: 'OK', environment: 'OK', database: 'CHECKING' }
  };

  try {
    const required = ['JWT_SECRET', 'DATABASE_URL', 'PORT', 'FRONTEND_URL'];
    const envStatus = {};
    required.forEach(v => { envStatus[v] = process.env[v] ? 'SET' : 'MISSING'; });
    detail.checks.environmentVariables = envStatus;
    const missing = required.filter(v => !process.env[v]);
    if (missing.length) { detail.checks.environment = 'WARNING'; detail.status = 'DEGRADED'; }

    try {
      const client = await pool.connect();
      try {
        const t0 = Date.now();

        const [
          { rows: ping },
          { rows: bookingsCnt },
          { rows: usersCnt },
          { rows: savedViewsCnt },
          { rows: tableList },
          { rows: followUpCol }
        ] = await Promise.all([
          client.query('SELECT 1 AS ok'),
          client.query('SELECT COUNT(*) AS cnt FROM bookings'),
          client.query('SELECT COUNT(*) AS cnt FROM users'),
          client.query("SELECT COUNT(*) AS cnt FROM saved_views"),
          client.query(`
            SELECT table_name
            FROM information_schema.tables
            WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
            ORDER BY table_name
          `),
          client.query(`
            SELECT column_name FROM information_schema.columns
            WHERE table_name = 'bookings' AND column_name = 'follow_up_date'
          `)
        ]);

        detail.checks.dbLatencyMs = Date.now() - t0;
        detail.checks.database = ping[0].ok === 1 ? 'OK' : 'ERROR';
        detail.checks.tables   = tableList.map(r => r.table_name);
        detail.checks.rowCounts = {
          bookings:   parseInt(bookingsCnt[0].cnt),
          users:      parseInt(usersCnt[0].cnt),
          savedViews: parseInt(savedViewsCnt[0].cnt)
        };
        detail.checks.schema = {
          followUpDateColumn: followUpCol.length > 0 ? 'PRESENT' : 'MISSING'
        };
      } finally {
        client.release();
      }
    } catch (err) {
      detail.checks.database = 'ERROR';
      detail.checks.databaseError = err.message;
      detail.status = 'ERROR';
    }

    const flatChecks = Object.values(detail.checks).filter(c => typeof c === 'string');
    if      (flatChecks.some(c => c === 'ERROR'))   detail.status = 'ERROR';
    else if (flatChecks.some(c => c === 'WARNING')) detail.status = 'DEGRADED';

    res.status(detail.status === 'OK' ? 200 : 503).json(detail);
  } catch (err) {
    res.status(503).json({ status: 'ERROR', timestamp: new Date().toISOString(), error: err.message });
  }
});

module.exports = router;
