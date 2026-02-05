const express = require('express');
const router = express.Router();
const { getAnalytics, getAgentPerformance, getAdPerformance } = require('../controllers/analytics.controller');
const authMiddleware = require('../middleware/auth.middleware');

// Get analytics (protected route)
router.get('/', authMiddleware, getAnalytics);

// Get agent performance (protected route)
router.get('/agent-performance', authMiddleware, getAgentPerformance);

// Get ad performance (protected route)
router.get('/ad-performance', authMiddleware, getAdPerformance);

module.exports = router;
