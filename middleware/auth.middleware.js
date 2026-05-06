const jwt = require('jsonwebtoken');
const NodeCache = require('node-cache');
const sheetsService = require('../services/sheets.service');

// Cache users for 5 minutes to avoid reading the sheet on every request
const usersCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

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
    
    // Fetch user data from Users sheet (cached for 5 min)
    let users = usersCache.get('users_list');
    if (!users) {
      users = await sheetsService.readSheet('Users');
      usersCache.set('users_list', users);
    }
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
module.exports.invalidateUsersCache = () => usersCache.del('users_list');
