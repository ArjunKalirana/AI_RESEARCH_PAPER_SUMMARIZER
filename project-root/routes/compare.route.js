const express = require('express');
const router = express.Router();
const { compareQuestion, getPapers } = require('../controllers/compare.controller');
const requireAuth = require('../middleware/auth.middleware');

router.post('/compare', requireAuth, compareQuestion);
router.get('/papers', requireAuth, getPapers);

module.exports = router;
