const express = require('express');
const router = express.Router();
const { compareQuestion, getPapers } = require('../controllers/compare.controller');

router.post('/compare', compareQuestion);
router.get('/papers', getPapers);

module.exports = router;
