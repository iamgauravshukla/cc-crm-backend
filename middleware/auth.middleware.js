'use strict';
const jwt = require('jsonwebtoken');
const NodeCache = require('node-cache');
const pool = require('../db/pool');

// Per-user cache — avoids a DB hit on every authenticated request
const userCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

const authMiddleware = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token = authHeader.slice(7);
    const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });

    const cacheKey = `user:${decoded.userId}`;
    let user = userCache.get(cacheKey);

    if (!user) {
      const { rows } = await pool.query(
        'SELECT user_id, email, name, role FROM users WHERE user_id = $1 AND email = $2',
        [decoded.userId, decoded.email]
      );
      if (!rows.length) {
        return res.status(401).json({ error: 'User not found' });
      }
      user = rows[0];
      userCache.set(cacheKey, user);
    }

    req.user = {
      userId: user.user_id,
      email: user.email,
      name: user.name,
      role: user.role,
    };

    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
};

const invalidateUserCache = (userId) => {
  if (userId) userCache.del(`user:${userId}`);
  else userCache.flushAll();
};

module.exports = authMiddleware;
module.exports.invalidateUserCache = invalidateUserCache;
module.exports.invalidateUsersCache = invalidateUserCache; // backward-compat alias
