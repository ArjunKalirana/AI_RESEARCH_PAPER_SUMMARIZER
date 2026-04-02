const express = require('express');
const router = express.Router();
const exportController = require('../controllers/export.controller');
const requireAuth = require('../middleware/auth.middleware');

router.get('/export/:paperId/summary-pdf', requireAuth, exportController.exportSummaryPDF);
router.get('/export/:paperId/citation', requireAuth, exportController.exportCitation);
router.get('/export/:paperId/chat-transcript', requireAuth, exportController.exportChatTranscript);

module.exports = router;
