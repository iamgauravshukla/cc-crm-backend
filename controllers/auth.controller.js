const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const sheetsService = require('../services/sheets.service');
const Joi = require('joi');

// Validation schemas
const signupSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().min(8).required(),
  name: Joi.string().min(2).required(),
  role: Joi.string().valid('Admin', 'Agent').required()
});

const loginSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().required()
});

class AuthController {
  async signup(req, res) {
    try {
      // Validate input
      const { error, value } = signupSchema.validate(req.body);
      if (error) {
        return res.status(400).json({ error: error.details[0].message });
      }

      const { email, password, name, role } = value;

      // Read Users sheet
      const users = await sheetsService.readSheet('Users');
      
      // Check if email already exists
      const emailExists = users.slice(1).some(user => user[1] === email.toLowerCase());
      if (emailExists) {
        return res.status(400).json({ error: 'Email already registered' });
      }

      // Hash password
      const passwordHash = await bcrypt.hash(password, 10);

      // Generate user ID
      const userId = uuidv4();
      const now = new Date().toISOString();

      // Prepare user data (columns: userId, email, passwordHash, name, role, created_at, last_login)
      const newUser = [
        userId,
        email.toLowerCase(),
        passwordHash,
        name,
        role, // Admin or Agent
        now,  // created_at
        now   // last_login
      ];

      // Append to Users sheet
      await sheetsService.appendRow('Users', newUser);

      // Generate JWT token
      const token = jwt.sign(
        { userId, email: email.toLowerCase() },
        process.env.JWT_SECRET,
        { expiresIn: '7d' }
      );

      res.status(201).json({
        message: 'User created successfully',
        token,
        user: {
          userId,
          email: email.toLowerCase(),
          name,
          role
        }
      });
    } catch (error) {
      console.error('Signup error:', error);
      res.status(500).json({ error: 'Failed to create user' });
    }
  }

  async login(req, res) {
    try {
      // Validate input
      const { error, value } = loginSchema.validate(req.body);
      if (error) {
        return res.status(400).json({ error: error.details[0].message });
      }

      const { email, password } = value;

      // Read Users sheet
      const users = await sheetsService.readSheet('Users');
      
      if (users.length < 2) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      // Find user by email
      const userRow = users.slice(1).find(user => user[1] === email.toLowerCase());
      
      if (!userRow) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      // Verify password
      const [userId, userEmail, passwordHash, name, role] = userRow;
      const isValidPassword = await bcrypt.compare(password, passwordHash);

      if (!isValidPassword) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      // Update last_login
      const rowIndex = users.findIndex(user => user[1] === email.toLowerCase());
      if (rowIndex > 0) {
        userRow[6] = new Date().toISOString(); // Update last_login (column 6)
        await sheetsService.updateRow('Users', rowIndex + 1, userRow);
      }

      // Generate JWT token
      const token = jwt.sign(
        { userId, email: userEmail },
        process.env.JWT_SECRET,
        { expiresIn: '7d' }
      );

      res.json({
        message: 'Login successful',
        token,
        user: {
          userId,
          email: userEmail,
          name,
          role,
          lastLogin: userRow[6]
        }
      });
    } catch (error) {
      console.error('Login error:', error);
      res.status(500).json({ error: 'Failed to login' });
    }
  }

  async me(req, res) {
    try {
      const { userId } = req.user;

      // Read Users sheet
      const users = await sheetsService.readSheet('Users');
      
      // Find user by userId
      const userRow = users.slice(1).find(user => user[0] === userId);
      
      if (!userRow) {
        return res.status(404).json({ error: 'User not found' });
      }

      const [id, email, , name, role, createdAt, lastLogin] = userRow;

      res.json({
        user: {
          userId: id,
          email,
          name,
          role,
          createdAt,
          lastLogin
        }
      });
    } catch (error) {
      console.error('Get user error:', error);
      res.status(500).json({ error: 'Failed to get user' });
    }
  }

  async getAllUsers(req, res) {
    try {
      const { userId } = req.user;

      // Read Users sheet
      const users = await sheetsService.readSheet('Users');
      
      // Find requesting user to check if admin
      const requestingUser = users.slice(1).find(user => user[0] === userId);
      
      if (!requestingUser || requestingUser[4] !== 'Admin') {
        return res.status(403).json({ error: 'Access denied. Admin only.' });
      }

      // Map all users (excluding password hash)
      const allUsers = users.slice(1).map(user => ({
        userId: user[0],
        email: user[1],
        name: user[3],
        role: user[4],
        createdAt: user[5],
        lastLogin: user[6]
      }));

      res.json({
        success: true,
        users: allUsers
      });
    } catch (error) {
      console.error('Get all users error:', error);
      res.status(500).json({ error: 'Failed to fetch users' });
    }
  }

  async updateUserRole(req, res) {
    try {
      const { userId } = req.user;
      const { userId: targetUserId } = req.params;
      const { role } = req.body;

      // Validate role
      if (!['Admin', 'Agent'].includes(role)) {
        return res.status(400).json({ error: 'Invalid role. Must be Admin or Agent.' });
      }

      // Read Users sheet
      const users = await sheetsService.readSheet('Users');
      
      // Find requesting user to check if admin
      const requestingUser = users.slice(1).find(user => user[0] === userId);
      
      if (!requestingUser || requestingUser[4] !== 'Admin') {
        return res.status(403).json({ error: 'Access denied. Admin only.' });
      }

      // Find target user
      const targetRowIndex = users.findIndex(user => user[0] === targetUserId);
      
      if (targetRowIndex < 1) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Prevent admin from changing their own role
      if (userId === targetUserId) {
        return res.status(400).json({ error: 'Cannot change your own role' });
      }

      // Update role
      users[targetRowIndex][4] = role;
      await sheetsService.updateRow('Users', targetRowIndex + 1, users[targetRowIndex]);

      res.json({
        success: true,
        message: 'User role updated successfully',
        user: {
          userId: users[targetRowIndex][0],
          email: users[targetRowIndex][1],
          name: users[targetRowIndex][3],
          role: users[targetRowIndex][4]
        }
      });
    } catch (error) {
      console.error('Update user role error:', error);
      res.status(500).json({ error: 'Failed to update user role' });
    }
  }

  async changeUserPassword(req, res) {
    try {
      const { userId } = req.user;
      const { userId: targetUserId } = req.params;
      const { newPassword } = req.body;

      // Validate password
      if (!newPassword || newPassword.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters long' });
      }

      // Read Users sheet
      const users = await sheetsService.readSheet('Users');
      
      // Find requesting user to check if admin
      const requestingUser = users.slice(1).find(user => user[0] === userId);
      
      if (!requestingUser || requestingUser[4] !== 'Admin') {
        return res.status(403).json({ error: 'Access denied. Admin only.' });
      }

      // Find target user
      const targetRowIndex = users.findIndex(user => user[0] === targetUserId);
      
      if (targetRowIndex < 1) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Hash new password
      const passwordHash = await bcrypt.hash(newPassword, 10);

      // Update password
      users[targetRowIndex][2] = passwordHash;
      await sheetsService.updateRow('Users', targetRowIndex + 1, users[targetRowIndex]);

      res.json({
        success: true,
        message: 'Password changed successfully'
      });
    } catch (error) {
      console.error('Change password error:', error);
      res.status(500).json({ error: 'Failed to change password' });
    }
  }

  async deleteUser(req, res) {
    try {
      const { userId } = req.user;
      const { userId: targetUserId } = req.params;

      // Read Users sheet
      const users = await sheetsService.readSheet('Users');
      
      // Find requesting user to check if admin
      const requestingUser = users.slice(1).find(user => user[0] === userId);
      
      if (!requestingUser || requestingUser[4] !== 'Admin') {
        return res.status(403).json({ error: 'Access denied. Admin only.' });
      }

      // Find target user
      const targetRowIndex = users.findIndex(user => user[0] === targetUserId);
      
      if (targetRowIndex < 1) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Prevent admin from deleting themselves
      if (userId === targetUserId) {
        return res.status(400).json({ error: 'Cannot delete your own account' });
      }

      // Count remaining admins
      const adminCount = users.slice(1).filter(user => user[4] === 'Admin').length;
      if (users[targetRowIndex][4] === 'Admin' && adminCount <= 1) {
        return res.status(400).json({ error: 'Cannot delete the last admin user' });
      }

      // Delete user
      await sheetsService.deleteRow('Users', targetRowIndex + 1);

      res.json({
        success: true,
        message: 'User deleted successfully'
      });
    } catch (error) {
      console.error('Delete user error:', error);
      res.status(500).json({ error: 'Failed to delete user' });
    }
  }
}

module.exports = new AuthController();
