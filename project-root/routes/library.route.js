const express = require('express');
const router = express.Router();
const libraryController = require('../controllers/library.controller');

router.get('/library', libraryController.getLibrary);
router.post('/library/:paperId/reindex', libraryController.reindexPaper);
router.delete('/library/:paperId', libraryController.deletePaper);

module.exports = router;
