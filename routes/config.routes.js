'use strict';
const express = require('express');
const router = express.Router();
const configController = require('../controllers/config.controller');
const authMiddleware = require('../middleware/auth.middleware');

router.use(authMiddleware);

// NOTE: /reorder must be declared before /:id to avoid Express matching it as an id
router.post('/reorder', configController.reorder);

router.get('/',      configController.getAll);
router.post('/',     configController.addOption);
router.put('/:id',   configController.updateOption);
router.delete('/:id', configController.deleteOption);

module.exports = router;
