const express = require('express');
const router = express.Router();
const { getSummary, downloadPaper, streamCritique, getFlashcards, regenerateSummary } = require('../controllers/summary.controller');
const requireAuth = require('../middleware/auth.middleware');
const shareAuth = require('../middleware/shareAuth.middleware');

router.get('/summary/:paperId', shareAuth, getSummary);
router.get('/regenerate/:paperId', requireAuth, regenerateSummary);
router.get('/download/:paperId', requireAuth, downloadPaper);
router.post('/critique/:paperId', requireAuth, streamCritique);
router.get('/flashcards/:paperId', requireAuth, getFlashcards);

module.exports = router;
