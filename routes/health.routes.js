'use strict';
const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

router.get('/', async (req, res) => {
  const health = {
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
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
      const { rows } = await pool.query('SELECT 1 AS ok');
      health.checks.database = rows[0].ok === 1 ? 'OK' : 'ERROR';
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

router.get('/detailed', async (req, res) => {
  const detail = {
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: {
      used:     Math.round(process.memoryUsage().heapUsed  / 1024 / 1024) + ' MB',
      total:    Math.round(process.memoryUsage().heapTotal / 1024 / 1024) + ' MB',
      external: Math.round(process.memoryUsage().external  / 1024 / 1024) + ' MB'
    },
    environment: {
      nodeVersion: process.version,
      platform:    process.platform,
      env:         process.env.NODE_ENV || 'development',
      port:        process.env.PORT     || 5001
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
        const { rows: cnt } = await client.query('SELECT COUNT(*) AS cnt FROM bookings LIMIT 1');
        const { rows: uc }  = await client.query('SELECT COUNT(*) AS cnt FROM users LIMIT 1');
        detail.checks.database = 'OK';
        detail.checks.bookingsTable = { status: 'OK', rowCount: parseInt(cnt[0].cnt) };
        detail.checks.usersTable    = { status: 'OK', rowCount: parseInt(uc[0].cnt)  };
      } finally {
        client.release();
      }
    } catch (err) {
      detail.checks.database = 'ERROR';
      detail.checks.databaseError = err.message;
      detail.status = 'ERROR';
    }

    const allChecks  = Object.values(detail.checks);
    if (allChecks.some(c => typeof c === 'string' && c === 'ERROR'))   detail.status = 'ERROR';
    else if (allChecks.some(c => typeof c === 'string' && c === 'WARNING')) detail.status = 'DEGRADED';

    res.status(detail.status === 'OK' ? 200 : 503).json(detail);
  } catch (err) {
    res.status(503).json({ status: 'ERROR', timestamp: new Date().toISOString(), error: err.message });
  }
});

module.exports = router;
