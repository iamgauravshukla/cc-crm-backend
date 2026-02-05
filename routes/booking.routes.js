const express = require('express');
const router = express.Router();
const bookingController = require('../controllers/booking.controller');
const authMiddleware = require('../middleware/auth.middleware');

// All routes require authentication
router.use(authMiddleware);

// Booking routes
router.post('/', bookingController.createBooking);
router.get('/old', bookingController.getOldBookings);
router.get('/:id', bookingController.getBookingById);
router.put('/:id', bookingController.updateBooking);

module.exports = router;
