const express = require('express');
const router = express.Router();
const authController = require('../controllers/auth.controller');
const authMiddleware = require('../middleware/auth.middleware');

// Public routes
router.post('/signup', authController.signup);
router.post('/login', authController.login);

// Protected routes
router.get('/me', authMiddleware, authController.me);
router.get('/users', authMiddleware, authController.getAllUsers);
router.put('/users/:userId/role', authMiddleware, authController.updateUserRole);
router.put('/users/:userId/password', authMiddleware, authController.changeUserPassword);
router.delete('/users/:userId', authMiddleware, authController.deleteUser);

module.exports = router;
