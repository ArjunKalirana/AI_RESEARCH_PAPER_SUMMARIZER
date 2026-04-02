const express = require('express');
const router = express.Router();
const litreviewController = require('../controllers/litreview.controller');
const requireAuth = require('../middleware/auth.middleware');

router.post('/lit-review', requireAuth, litreviewController.generateLitReview);

module.exports = router;
