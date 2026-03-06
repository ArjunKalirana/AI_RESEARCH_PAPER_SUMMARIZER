const express = require('express');
const router = express.Router();
const { getSummary, downloadPaper } = require('../controllers/summary.controller');

router.get('/summary/:paperId', getSummary);
router.get('/download/:paperId', downloadPaper);

module.exports = router;
