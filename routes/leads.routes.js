const express = require('express');
const router = express.Router();
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const authMiddleware = require('../middleware/auth.middleware');
const {
  submitLead,
  getCallLeads,
  getBookingLeads,
  getCenters,
  updateLead
} = require('../controllers/leads.controller');

// Rate limiter for public lead submission
const leadsSubmitLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30,
  message: { error: 'Too many submissions. Please try again later.' }
});

// Open CORS — allow any website origin for the public submission endpoint
const openCors = cors({ origin: '*' });

// ─── Public endpoints (called from website) ───────────────────────────────────
// OPTIONS preflight for POST /api/leads
router.options('/', openCors);
// POST /api/leads?type=call&center=<CENTER_NAME>
// POST /api/leads?type=booking&center=<CENTER_NAME>
router.post('/', openCors, leadsSubmitLimiter, submitLead);

// ─── Protected endpoints (CRM only) ───────────────────────────────────────────
// GET /api/leads/call?center=ALL&search=&sort=latest
router.get('/call', authMiddleware, getCallLeads);

// GET /api/leads/booking?center=ALL&search=&sort=latest
router.get('/booking', authMiddleware, getBookingLeads);

// GET /api/leads/centers
router.get('/centers', authMiddleware, getCenters);

// PATCH /api/leads/:type/:rowIndex — update status & feedback
router.patch('/:type/:rowIndex', authMiddleware, updateLead);

module.exports = router;
