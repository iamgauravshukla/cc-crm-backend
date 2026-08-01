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
  role: Joi.string().valid('Admin', 'Agent').required(),
  // Authorizes creating an Admin via self-signup (internal tool). Optional for Agents.
  masterPassword: Joi.string().allow('').optional()
});

const loginSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().required()
});

class AuthController {
  async signup(req, res) {
    try {
      const { error, value } = signupSchema.validate(req.body);
      if (error) return res.status(400).json({ error: error.details[0].message });

      const { email, password, name, role, masterPassword } = value;

      // Admin accounts are authorized either by the shared master password (internal
      // self-signup) OR by an already-authenticated Admin (e.g. Users Management).
      if (role === 'Admin') {
        const master   = process.env.ADMIN_MASTER_PASSWORD || '';
        const masterOk = master !== '' && (masterPassword || '') === master;

        if (!masterOk) {
          const authHeader = req.headers.authorization;
          if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(403).json({ error: 'Incorrect master password for creating an Admin account' });
          }
          try {
            const decoded = jwt.verify(authHeader.slice(7), process.env.JWT_SECRET, { algorithms: ['HS256'] });
            const { rows: callerRows } = await pool.query(
              'SELECT role FROM users WHERE user_id = $1', [decoded.userId]
            );
            if (!callerRows.length || callerRows[0].role !== 'Admin') {
              return res.status(403).json({ error: 'Admin accounts require the master password or an existing Admin login' });
            }
          } catch {
            return res.status(403).json({ error: 'Incorrect master password for creating an Admin account' });
          }
        }
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

      const token = jwt.sign(
        { userId, email: email.toLowerCase() },
        process.env.JWT_SECRET,
        { expiresIn: '7d' }
      );

      res.status(201).json({
        message: 'User created successfully',
        token,
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
        'SELECT user_id, email, password_hash, name, role, last_login FROM users WHERE email = $1',
        [email.toLowerCase()]
      );

      if (!rows.length) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      const u = rows[0];
      const valid = await bcrypt.compare(password, u.password_hash);
      if (!valid) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      const now = new Date();
      await pool.query(
        'UPDATE users SET last_login = $1 WHERE user_id = $2',
        [now, u.user_id]
      );
      invalidateUserCache(u.user_id.toString());

      const token = jwt.sign(
        { userId: u.user_id, email: u.email },
        process.env.JWT_SECRET,
        { expiresIn: '7d' }
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
        'SELECT user_id, email, name, role, created_at, last_login FROM users ORDER BY created_at'
      );

      res.json({
        success: true,
        users: rows.map(u => ({
          userId: u.user_id,
          email: u.email,
          name: u.name,
          role: u.role,
          createdAt: u.created_at,
          lastLogin: u.last_login
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
