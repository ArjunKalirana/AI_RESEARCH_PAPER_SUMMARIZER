const express = require('express');
const router = express.Router();
const { getSummary } = require('../controllers/summary.controller');

router.get('/summary/:paperId', getSummary);

module.exports = router;
