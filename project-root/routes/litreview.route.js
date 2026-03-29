const express = require('express');
const router = express.Router();
const litreviewController = require('../controllers/litreview.controller');

router.post('/lit-review', litreviewController.generateLitReview);

module.exports = router;
