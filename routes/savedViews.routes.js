const express = require('express');
const router  = express.Router();
const authMiddleware = require('../middleware/auth.middleware');
const ctrl = require('../controllers/savedViews.controller');

router.use(authMiddleware);
router.get('/',    ctrl.getAll);
router.post('/',   ctrl.create);
router.delete('/:id', ctrl.remove);

module.exports = router;
