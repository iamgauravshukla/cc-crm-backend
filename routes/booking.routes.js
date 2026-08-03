const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const bookingController = require('../controllers/booking.controller');
const authMiddleware    = require('../middleware/auth.middleware');

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 50 * 1024 * 1024 }, // 50 MB max
  fileFilter: (_req, file, cb) => {
    if (file.originalname.match(/\.(xlsx|xls)$/i)) cb(null, true);
    else cb(new Error('Only .xlsx / .xls files are accepted'));
  },
});

// All routes require authentication
router.use(authMiddleware);

// Booking routes — static paths must come before /:id
router.post('/', bookingController.createBooking);
router.post('/bulk-status', bookingController.bulkUpdateStatus);
router.post('/bulk-delete', bookingController.bulkDelete);
router.get('/export',  bookingController.exportBookings);
router.get('/customer', bookingController.getCustomerHistory);
router.get('/daily-reports', bookingController.getDailyReports);
router.get('/daily-reports/ots', bookingController.getOTSBookings);
router.get('/daily-reports/overall', bookingController.getOverallBookings);
router.get('/daily-reports/tomorrow', bookingController.getTomorrowBookings);
router.get('/daily-reports/next7days', bookingController.getNext7DaysBookings);
router.get('/daily-reports/cancellations', bookingController.getCancellations);
router.get('/daily-reports/arrivals-today', bookingController.getArrivalsToday);
router.get('/daily-reports/tomorrow-summary', bookingController.getTomorrowSummary);
router.get('/filter-options', bookingController.getFilterOptions);
router.get('/cc-report', bookingController.getCCReport);
router.get('/cc-report/drilldown', bookingController.getCCReportDrilldown);
router.get('/kanban', bookingController.getKanbanBookings);
router.get('/old', bookingController.getOldBookings);
router.post('/import', upload.single('file'), bookingController.importBookings);
router.get('/:id/activity', bookingController.getActivityLog);
router.get('/:id', bookingController.getBookingById);
router.put('/:id', bookingController.updateBooking);
router.patch('/:rowNumber/validation', bookingController.updateValidation);
router.patch('/:id/flags', bookingController.updateFlags);
router.delete('/:rowNumber', bookingController.deleteBooking);

module.exports = router;
