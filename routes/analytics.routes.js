const express = require('express');
const router = express.Router();
const { getAnalytics, getAgentPerformance, getAdPerformance, getSalesReport } = require('../controllers/analytics.controller');
const authMiddleware = require('../middleware/auth.middleware');

// Get analytics (protected route)
router.get('/', authMiddleware, getAnalytics);

// Get agent performance (protected route)
router.get('/agent-performance', authMiddleware, getAgentPerformance);

// Get ad performance (protected route)
router.get('/ad-performance', authMiddleware, getAdPerformance);

// Get sales report (protected route)
router.get('/sales-report', authMiddleware, getSalesReport);

module.exports = router;
