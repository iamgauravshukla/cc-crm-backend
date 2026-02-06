const express = require('express');
const router = express.Router();
const sheetsService = require('../services/sheets.service');

// Health check endpoint
router.get('/', async (req, res) => {
  const healthCheck = {
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'development',
    checks: {
      server: 'OK',
      environment: 'OK',
      googleSheets: 'CHECKING'
    }
  };

  try {
    // Check if required environment variables are set
    const requiredEnvVars = ['JWT_SECRET', 'GOOGLE_SHEET_ID', 'PORT'];
    const missingEnvVars = requiredEnvVars.filter(varName => !process.env[varName]);
    
    if (missingEnvVars.length > 0) {
      healthCheck.checks.environment = 'ERROR';
      healthCheck.checks.environmentDetails = `Missing: ${missingEnvVars.join(', ')}`;
      healthCheck.status = 'DEGRADED';
    }

    // Check Google Sheets connection
    try {
      await sheetsService.initialize();
      const sheets = await sheetsService.readSheet('Users', 'A1:A1');
      healthCheck.checks.googleSheets = 'OK';
      healthCheck.checks.googleSheetsDetails = 'Connected and accessible';
    } catch (error) {
      healthCheck.checks.googleSheets = 'ERROR';
      healthCheck.checks.googleSheetsDetails = error.message;
      healthCheck.status = 'DEGRADED';
    }

    // Set appropriate status code
    const statusCode = healthCheck.status === 'OK' ? 200 : 503;
    
    res.status(statusCode).json(healthCheck);
  } catch (error) {
    res.status(503).json({
      status: 'ERROR',
      timestamp: new Date().toISOString(),
      error: error.message,
      checks: {
        server: 'ERROR',
        details: 'Health check failed'
      }
    });
  }
});

// Detailed health check (includes more information)
router.get('/detailed', async (req, res) => {
  const detailedHealth = {
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: {
      used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + ' MB',
      total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024) + ' MB',
      external: Math.round(process.memoryUsage().external / 1024 / 1024) + ' MB'
    },
    environment: {
      nodeVersion: process.version,
      platform: process.platform,
      env: process.env.NODE_ENV || 'development',
      port: process.env.PORT || 5001
    },
    checks: {
      server: 'OK',
      environment: 'OK',
      googleSheets: 'CHECKING',
      database: 'CHECKING'
    }
  };

  try {
    // Check environment variables
    const requiredEnvVars = ['JWT_SECRET', 'GOOGLE_SHEET_ID', 'PORT', 'FRONTEND_URL'];
    const envStatus = {};
    
    requiredEnvVars.forEach(varName => {
      envStatus[varName] = process.env[varName] ? 'SET' : 'MISSING';
    });
    
    detailedHealth.checks.environmentVariables = envStatus;
    
    const missingEnvVars = requiredEnvVars.filter(varName => !process.env[varName]);
    if (missingEnvVars.length > 0) {
      detailedHealth.checks.environment = 'WARNING';
      detailedHealth.status = 'DEGRADED';
    }

    // Check Google Sheets connection and data
    try {
      await sheetsService.initialize();
      
      // Check Users sheet
      const users = await sheetsService.readSheet('Users', 'A1:G2');
      detailedHealth.checks.googleSheets = 'OK';
      detailedHealth.checks.usersSheet = {
        status: 'OK',
        accessible: true,
        headerCheck: users.length > 0
      };

      // Check DB sheet (bookings)
      const bookings = await sheetsService.readSheet('DB', 'A1:A2');
      detailedHealth.checks.bookingsSheet = {
        status: 'OK',
        accessible: true,
        headerCheck: bookings.length > 0
      };
      
      detailedHealth.checks.database = 'OK';
    } catch (error) {
      detailedHealth.checks.googleSheets = 'ERROR';
      detailedHealth.checks.googleSheetsError = error.message;
      detailedHealth.checks.database = 'ERROR';
      detailedHealth.status = 'ERROR';
    }

    // Calculate overall status
    const allChecks = Object.values(detailedHealth.checks);
    if (allChecks.some(check => typeof check === 'string' && check === 'ERROR')) {
      detailedHealth.status = 'ERROR';
    } else if (allChecks.some(check => typeof check === 'string' && check === 'WARNING')) {
      detailedHealth.status = 'DEGRADED';
    }

    const statusCode = detailedHealth.status === 'OK' ? 200 : 
                       detailedHealth.status === 'DEGRADED' ? 503 : 503;
    
    res.status(statusCode).json(detailedHealth);
  } catch (error) {
    res.status(503).json({
      status: 'ERROR',
      timestamp: new Date().toISOString(),
      error: error.message,
      checks: {
        server: 'ERROR',
        details: 'Detailed health check failed'
      }
    });
  }
});

module.exports = router;
