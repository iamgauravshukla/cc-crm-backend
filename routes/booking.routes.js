const express = require('express');
const router = express.Router();
const bookingController = require('../controllers/booking.controller');
const authMiddleware = require('../middleware/auth.middleware');

// All routes require authentication
router.use(authMiddleware);

// Booking routes
router.post('/', bookingController.createBooking);
router.get('/daily-reports', bookingController.getDailyReports);
router.get('/daily-reports/ots', bookingController.getOTSBookings);
router.get('/daily-reports/overall', bookingController.getOverallBookings);
router.get('/daily-reports/tomorrow', bookingController.getTomorrowBookings);
router.get('/daily-reports/next7days', bookingController.getNext7DaysBookings);
router.get('/daily-reports/cancellations', bookingController.getCancellations);
router.get('/daily-reports/tomorrow-summary', bookingController.getTomorrowSummary);
router.get('/old', bookingController.getOldBookings);
router.get('/:id', bookingController.getBookingById);
router.put('/:id', bookingController.updateBooking);

module.exports = router;
