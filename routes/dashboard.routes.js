const express = require('express');
const router = express.Router();
const { getDashboardOverview, getBookingTrend } = require('../controllers/dashboard.controller');
const authMiddleware = require('../middleware/auth.middleware');

// Get dashboard overview (protected route)
router.get('/overview', authMiddleware, getDashboardOverview);

// Get booking trend for last N days (protected route)
router.get('/trend', authMiddleware, getBookingTrend);

module.exports = router;
