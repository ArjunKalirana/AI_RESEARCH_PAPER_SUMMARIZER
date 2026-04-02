const express = require('express');
const router = express.Router();
const { askQuestion } = require('../controllers/ask.controller');
const shareAuth = require('../middleware/shareAuth.middleware');

router.post('/ask', shareAuth, askQuestion);

module.exports = router;
