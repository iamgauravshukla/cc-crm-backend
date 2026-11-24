'use strict';
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Joi = require('joi');
const pool = require('../db/pool');
const { invalidateUserCache } = require('../middleware/auth.middleware');

const signupSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().min(8).required(),
  name: Joi.string().min(2).required(),
  role: Joi.string().valid('Admin', 'Agent').required()
});

// Fire-and-forget auth audit trail (never blocks the response)
function logAuthEvent(event, { email = null, userId = null, req = null } = {}) {
  pool.query(
    `INSERT INTO auth_events (email, user_id, event, ip, user_agent) VALUES ($1, $2, $3, $4, $5)`,
    [email, userId, event, req?.ip || null, (req?.headers?.['user-agent'] || '').slice(0, 300) || null]
  ).catch(e => console.error('auth_events write failed:', e.message));
}

const LOCKOUT_ATTEMPTS = 5;        // failed logins before the account locks
const LOCKOUT_MINUTES  = 15;       // how long it stays locked

const loginSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().required()
});

class AuthController {
  async signup(req, res) {
    try {
      const { error, value } = signupSchema.validate(req.body);
      if (error) return res.status(400).json({ error: error.details[0].message });

      const { email, password, name, role } = value;

      // Account creation is Admin-only: public self-signup is disabled entirely.
      // The route sits behind authMiddleware, so req.user is a verified account.
      if (req.user?.role !== 'Admin') {
        return res.status(403).json({ error: 'Only admins can create accounts' });
      }

      const existing = await pool.query(
        'SELECT user_id FROM users WHERE email = $1',
        [email.toLowerCase()]
      );
      if (existing.rows.length) {
        return res.status(400).json({ error: 'Email already registered' });
      }

      const passwordHash = await bcrypt.hash(password, 10);
      const now = new Date();

      const { rows } = await pool.query(
        `INSERT INTO users (email, password_hash, name, role, created_at, last_login)
         VALUES ($1, $2, $3, $4, $5, $5)
         RETURNING user_id`,
        [email.toLowerCase(), passwordHash, name, role, now]
      );

      const userId = rows[0].user_id;
      logAuthEvent('user_created', { email: email.toLowerCase(), userId, req });

      // No token: an Admin created this account for someone else; that person logs in themselves.
      res.status(201).json({
        message: 'User created successfully',
        user: { userId, email: email.toLowerCase(), name, role }
      });
    } catch (err) {
      console.error('Signup error:', err);
      res.status(500).json({ error: 'Failed to create user' });
    }
  }

  async login(req, res) {
    try {
      const { error, value } = loginSchema.validate(req.body);
      if (error) return res.status(400).json({ error: error.details[0].message });

      const { email, password } = value;

      const { rows } = await pool.query(
        'SELECT user_id, email, password_hash, name, role, last_login, is_active, failed_attempts, locked_until FROM users WHERE email = $1',
        [email.toLowerCase()]
      );

      if (!rows.length) {
        logAuthEvent('login_failed', { email: email.toLowerCase(), req });
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      const u = rows[0];

      // Disabled accounts cannot sign in at all
      if (u.is_active === false) {
        logAuthEvent('login_blocked', { email: u.email, userId: u.user_id, req });
        return res.status(403).json({ error: 'This account has been disabled. Contact an administrator.' });
      }

      // Temporary lockout after repeated failures (brute-force protection)
      if (u.locked_until && new Date(u.locked_until) > new Date()) {
        const mins = Math.ceil((new Date(u.locked_until) - Date.now()) / 60000);
        logAuthEvent('login_blocked', { email: u.email, userId: u.user_id, req });
        return res.status(423).json({ error: `Too many failed attempts. Account locked — try again in ${mins} minute${mins !== 1 ? 's' : ''}.` });
      }

      const valid = await bcrypt.compare(password, u.password_hash);
      if (!valid) {
        const attempts = (u.failed_attempts || 0) + 1;
        if (attempts >= LOCKOUT_ATTEMPTS) {
          await pool.query(
            `UPDATE users SET failed_attempts = 0, locked_until = NOW() + ($1 || ' minutes')::interval WHERE user_id = $2`,
            [LOCKOUT_MINUTES, u.user_id]
          );
          logAuthEvent('account_locked', { email: u.email, userId: u.user_id, req });
        } else {
          await pool.query('UPDATE users SET failed_attempts = $1 WHERE user_id = $2', [attempts, u.user_id]);
          logAuthEvent('login_failed', { email: u.email, userId: u.user_id, req });
        }
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      const now = new Date();
      await pool.query(
        'UPDATE users SET last_login = $1, failed_attempts = 0, locked_until = NULL WHERE user_id = $2',
        [now, u.user_id]
      );
      invalidateUserCache(u.user_id.toString());
      logAuthEvent('login_success', { email: u.email, userId: u.user_id, req });

      const token = jwt.sign(
        { userId: u.user_id, email: u.email },
        process.env.JWT_SECRET,
        { expiresIn: '12h' } // one working day; was 7d
      );

      res.json({
        message: 'Login successful',
        token,
        user: {
          userId: u.user_id,
          email: u.email,
          name: u.name,
          role: u.role,
          lastLogin: now.toISOString()
        }
      });
    } catch (err) {
      console.error('Login error:', err);
      res.status(500).json({ error: 'Failed to login' });
    }
  }

  async me(req, res) {
    try {
      const { userId } = req.user;

      const { rows } = await pool.query(
        'SELECT user_id, email, name, role, created_at, last_login FROM users WHERE user_id = $1',
        [userId]
      );

      if (!rows.length) return res.status(404).json({ error: 'User not found' });

      const u = rows[0];
      res.json({
        user: {
          userId: u.user_id,
          email: u.email,
          name: u.name,
          role: u.role,
          createdAt: u.created_at,
          lastLogin: u.last_login
        }
      });
    } catch (err) {
      console.error('Get user error:', err);
      res.status(500).json({ error: 'Failed to get user' });
    }
  }

  async getAllUsers(req, res) {
    try {
      if (req.user?.role !== 'Admin') {
        return res.status(403).json({ error: 'Access denied. Admin only.' });
      }

      const { rows } = await pool.query(
        'SELECT user_id, email, name, role, created_at, last_login, is_active, locked_until FROM users ORDER BY created_at'
      );

      res.json({
        success: true,
        users: rows.map(u => ({
          userId: u.user_id,
          email: u.email,
          name: u.name,
          role: u.role,
          createdAt: u.created_at,
          lastLogin: u.last_login,
          isActive: u.is_active !== false,
          lockedUntil: u.locked_until
        }))
      });
    } catch (err) {
      console.error('Get all users error:', err);
      res.status(500).json({ error: 'Failed to fetch users' });
    }
  }

  async updateUserRole(req, res) {
    try {
      if (req.user?.role !== 'Admin') {
        return res.status(403).json({ error: 'Access denied. Admin only.' });
      }

      const { userId: targetUserId } = req.params;
      const { role } = req.body;

      if (!['Admin', 'Agent'].includes(role)) {
        return res.status(400).json({ error: 'Invalid role. Must be Admin or Agent.' });
      }

      if (String(req.user.userId) === String(targetUserId)) {
        return res.status(400).json({ error: 'Cannot change your own role' });
      }

      const { rows } = await pool.query(
        `UPDATE users SET role = $1 WHERE user_id = $2
         RETURNING user_id, email, name, role`,
        [role, targetUserId]
      );

      if (!rows.length) return res.status(404).json({ error: 'User not found' });

      invalidateUserCache(targetUserId.toString());

      const u = rows[0];
      res.json({
        success: true,
        message: 'User role updated successfully',
        user: { userId: u.user_id, email: u.email, name: u.name, role: u.role }
      });
    } catch (err) {
      console.error('Update user role error:', err);
      res.status(500).json({ error: 'Failed to update user role' });
    }
  }

  async changeUserPassword(req, res) {
    try {
      if (req.user?.role !== 'Admin') {
        return res.status(403).json({ error: 'Access denied. Admin only.' });
      }

      const { userId: targetUserId } = req.params;
      const { newPassword } = req.body;

      if (!newPassword || newPassword.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters long' });
      }

      const passwordHash = await bcrypt.hash(newPassword, 10);

      const { rowCount } = await pool.query(
        'UPDATE users SET password_hash = $1 WHERE user_id = $2',
        [passwordHash, targetUserId]
      );

      if (!rowCount) return res.status(404).json({ error: 'User not found' });

      invalidateUserCache(targetUserId.toString());

      res.json({ success: true, message: 'Password changed successfully' });
    } catch (err) {
      console.error('Change password error:', err);
      res.status(500).json({ error: 'Failed to change password' });
    }
  }

  // PATCH /auth/users/:userId/active  { isActive: true|false }  (Admin only)
  // Disabling takes effect immediately: the auth cache is flushed for that user,
  // so even an unexpired token stops working on the next request.
  async setUserActive(req, res) {
    try {
      if (req.user?.role !== 'Admin') {
        return res.status(403).json({ error: 'Access denied. Admin only.' });
      }
      const { userId: targetUserId } = req.params;
      const isActive = req.body?.isActive === true;

      if (String(req.user.userId) === String(targetUserId)) {
        return res.status(400).json({ error: 'Cannot disable your own account' });
      }

      const { rows } = await pool.query(
        'UPDATE users SET is_active = $1, failed_attempts = 0, locked_until = NULL WHERE user_id = $2 RETURNING email, name',
        [isActive, targetUserId]
      );
      if (!rows.length) return res.status(404).json({ error: 'User not found' });

      invalidateUserCache(targetUserId.toString());
      logAuthEvent(isActive ? 'user_enabled' : 'user_disabled', { email: rows[0].email, userId: targetUserId, req });

      res.json({ success: true, message: `${rows[0].name} ${isActive ? 'enabled' : 'disabled'}` });
    } catch (err) {
      console.error('setUserActive error:', err);
      res.status(500).json({ error: 'Failed to update account status' });
    }
  }

  async deleteUser(req, res) {
    try {
      if (req.user?.role !== 'Admin') {
        return res.status(403).json({ error: 'Access denied. Admin only.' });
      }

      const { userId: targetUserId } = req.params;

      if (String(req.user.userId) === String(targetUserId)) {
        return res.status(400).json({ error: 'Cannot delete your own account' });
      }

      // Guard: don't delete the last admin
      const { rows: adminRows } = await pool.query(
        "SELECT COUNT(*) AS cnt FROM users WHERE role = 'Admin'"
      );
      const { rows: targetRows } = await pool.query(
        'SELECT role FROM users WHERE user_id = $1',
        [targetUserId]
      );

      if (!targetRows.length) return res.status(404).json({ error: 'User not found' });

      if (targetRows[0].role === 'Admin' && parseInt(adminRows[0].cnt) <= 1) {
        return res.status(400).json({ error: 'Cannot delete the last admin user' });
      }

      await pool.query('DELETE FROM users WHERE user_id = $1', [targetUserId]);
      invalidateUserCache(targetUserId.toString());

      res.json({ success: true, message: 'User deleted successfully' });
    } catch (err) {
      console.error('Delete user error:', err);
      res.status(500).json({ error: 'Failed to delete user' });
    }
  }
}

module.exports = new AuthController();
