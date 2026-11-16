const express = require('express');
const router  = express.Router();
const authMiddleware = require('../middleware/auth.middleware');
const ctrl = require('../controllers/packages.controller');

router.use(authMiddleware);

router.get('/stats', ctrl.getStats);
router.get('/',      ctrl.listPackages);
router.post('/',     ctrl.createPackage);
router.get('/:id',   ctrl.getPackage);
router.patch('/:id', ctrl.updatePackage);

router.post('/:id/sessions/:sid/done',     ctrl.markSessionDone);
router.post('/:id/sessions/:sid/schedule', ctrl.scheduleSession);
router.post('/:id/sessions/:sid/no-show',  ctrl.markNoShow);
router.post('/:id/sessions/:sid/remind',   ctrl.remindNow);
router.post('/:id/contact-logs',           ctrl.addContactLog);

module.exports = router;
