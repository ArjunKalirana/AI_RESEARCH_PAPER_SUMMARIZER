const express = require('express');
const router = express.Router();
const { registerUser, loginUser, signToken } = require('../services/authService');
const requireAuth = require('../middleware/auth.middleware');
const rateLimit = require('express-rate-limit');

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many login attempts. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
  // No custom keyGenerator needed — default is IPv6-safe in express-rate-limit v7+
});

router.post('/register', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }
    if (!/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
      return res.status(400).json({ error: 'Password must contain at least one uppercase letter and one number.' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }

    const user = await registerUser(email, password);
    
    // Explicitly check for JWT_SECRET before signing
    if (!process.env.JWT_SECRET) {
      console.error('❌ LOGIN_ERROR: JWT_SECRET environment variable is not defined.');
      return res.status(500).json({ error: 'Server configuration error: missing JWT_SECRET' });
    }

    const token = signToken(user.userId, user.email);

    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'Strict',
      maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
    });

    res.json({ token, user });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const user = await loginUser(email, password);

    // Explicitly check for JWT_SECRET before signing
    if (!process.env.JWT_SECRET) {
      console.error('❌ LOGIN_ERROR: JWT_SECRET environment variable is not defined.');
      return res.status(500).json({ error: 'Server configuration error: missing JWT_SECRET' });
    }

    const token = signToken(user.userId, user.email);

    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'Strict',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });

    res.json({ token, user });
  } catch (err) {
    console.error(`❌ AUTH_LOGIN_ERROR [${new Date().toISOString()}]:`, err.message);
    res.status(400).json({ error: err.message });
  }
});

router.post('/logout', (req, res) => {
  res.cookie('token', '', { expires: new Date(0) });
  res.json({ success: true });
});

router.get('/me', requireAuth, (req, res) => {
  res.json(req.user);
});

module.exports = router;
