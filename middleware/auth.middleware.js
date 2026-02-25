const jwt = require('jsonwebtoken');
const sheetsService = require('../services/sheets.service');

const authMiddleware = async (req, res, next) => {
  try {
    // Get token from header
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token = authHeader.substring(7); // Remove 'Bearer ' prefix

    // Verify token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Fetch user data from Users sheet to get name and role
    const users = await sheetsService.readSheet('Users');
    const userRow = users.find(row => row[0] === decoded.userId && row[1] === decoded.email);
    
    if (!userRow) {
      return res.status(401).json({ error: 'User not found' });
    }

    // Attach user info to request
    // Column structure: userId, email, name, password_hash, role, created_at, last_login
    req.user = {
      userId: userRow[0],
      email: userRow[1],
      name: userRow[2],
      role: userRow[4]
    };

    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired' });
    }
    
    return res.status(401).json({ error: 'Invalid token' });
  }
};

module.exports = authMiddleware;
