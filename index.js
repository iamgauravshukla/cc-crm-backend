require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

// Import routes
const authRoutes = require('./routes/auth.routes');
const bookingRoutes = require('./routes/booking.routes');
const analyticsRoutes = require('./routes/analytics.routes');
const dashboardRoutes = require('./routes/dashboard.routes');
const healthRoutes = require('./routes/health.routes');
const leadsRoutes      = require('./routes/leads.routes');
const configRoutes     = require('./routes/config.routes');
const savedViewsRoutes = require('./routes/savedViews.routes');

const app = express();
const PORT = process.env.PORT || 5001;

// Railway (and most cloud hosts) sit behind a reverse proxy that sets X-Forwarded-For.
// Without this, express-rate-limit throws ERR_ERL_UNEXPECTED_X_FORWARDED_FOR.
app.set('trust proxy', 1);

// Security middleware — disable crossOriginResourcePolicy for public endpoints
// so external websites can read the response (CORP 'same-origin' would block it)
app.use(helmet({
  crossOriginResourcePolicy: false,
}));

const rawAllowed = process.env.FRONTEND_URLS || process.env.FRONTEND_URL || 'http://localhost:3000';
const allowedOrigins = rawAllowed.split(',').map(o => o.trim().replace(/\/+$/, '')).filter(Boolean);

// CORS — explicit manual headers so preflight and credentialed requests both work reliably.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const isLeads = req.path === '/api/leads';

  if (isLeads) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  } else if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Vary', 'Origin');
  }

  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});
app.use('/api/', limiter);

// Body parser
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/bookings', bookingRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/leads',  leadsRoutes);
app.use('/api/config', configRoutes);
app.use('/api/saved-views', savedViewsRoutes);

// Health check routes
app.use('/health', healthRoutes);
app.use('/api/health', healthRoutes);

// Serve client build in production (or when build files exist)
const clientBuildPath = path.join(__dirname, '..', 'client', 'build');
app.use(express.static(clientBuildPath));

// SPA fallback: return index.html for non-API routes so client-side routing works on refresh
app.get('*', (req, res, next) => {
  const url = req.originalUrl || req.url;
  if (url.startsWith('/api') || url.startsWith('/health')) return next();
  res.sendFile(path.join(clientBuildPath, 'index.html'), err => {
    if (err) next(err);
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal Server Error'
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🌐 Allowed origins: ${allowedOrigins.join(', ')}`);
});
