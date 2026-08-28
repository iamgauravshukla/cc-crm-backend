const express = require('express');
const router = express.Router();
const { getAnalytics, getAgentPerformance, getAdPerformance, getSalesReport, getAgentBookings } = require('../controllers/analytics.controller');
const authMiddleware = require('../middleware/auth.middleware');

// Get analytics (protected route)
router.get('/', authMiddleware, getAnalytics);

// Get agent performance (protected route)
router.get('/agent-performance', authMiddleware, getAgentPerformance);

// Bookings behind one agent's breakdown bar (protected route)
router.get('/agent-bookings', authMiddleware, getAgentBookings);

// Get ad performance (protected route)
router.get('/ad-performance', authMiddleware, getAdPerformance);

// Get sales report (protected route)
router.get('/sales-report', authMiddleware, getSalesReport);

module.exports = router;
