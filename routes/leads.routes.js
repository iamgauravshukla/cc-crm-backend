const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const authMiddleware = require('../middleware/auth.middleware');
const {
  submitLead,
  getCallLeads,
  getBookingLeads,
  getCenters
} = require('../controllers/leads.controller');

// Rate limiter for public lead submission
const leadsSubmitLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30,
  message: { error: 'Too many submissions. Please try again later.' }
});

// ─── Public endpoints (called from website) ───────────────────────────────────
// POST /api/leads?type=call&center=<CENTER_NAME>
// POST /api/leads?type=booking&center=<CENTER_NAME>
router.post('/', leadsSubmitLimiter, submitLead);

// ─── Protected endpoints (CRM only) ───────────────────────────────────────────
// GET /api/leads/call?center=ALL&search=&sort=latest
router.get('/call', authMiddleware, getCallLeads);

// GET /api/leads/booking?center=ALL&search=&sort=latest
router.get('/booking', authMiddleware, getBookingLeads);

// GET /api/leads/centers
router.get('/centers', authMiddleware, getCenters);

module.exports = router;
