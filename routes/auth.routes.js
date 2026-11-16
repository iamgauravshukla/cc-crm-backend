const express = require('express');
const router = express.Router();
const authController = require('../controllers/auth.controller');
const authMiddleware = require('../middleware/auth.middleware');

// Public routes
// Brute-force protection: 10 login attempts per IP per 15 minutes
const rateLimit = require('express-rate-limit');
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many login attempts from this address. Try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Public self-signup is disabled: account creation requires a logged-in Admin
// (the controller enforces the Admin role), done from Users Management.
router.post('/signup', authMiddleware, authController.signup);
router.post('/login', loginLimiter, authController.login);

// Protected routes
router.get('/me', authMiddleware, authController.me);
router.get('/users', authMiddleware, authController.getAllUsers);
router.put('/users/:userId/role', authMiddleware, authController.updateUserRole);
router.put('/users/:userId/password', authMiddleware, authController.changeUserPassword);
router.patch('/users/:userId/active', authMiddleware, authController.setUserActive);
router.delete('/users/:userId', authMiddleware, authController.deleteUser);

module.exports = router;
