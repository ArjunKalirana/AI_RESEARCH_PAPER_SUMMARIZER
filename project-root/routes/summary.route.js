const express = require('express');
const router = express.Router();
const { getSummary, downloadPaper, streamCritique, getFlashcards } = require('../controllers/summary.controller');

router.get('/summary/:paperId', getSummary);
router.get('/download/:paperId', downloadPaper);
router.post('/critique/:paperId', streamCritique);
router.get('/flashcards/:paperId', getFlashcards);

module.exports = router;
