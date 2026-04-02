const express = require('express');
const router = express.Router();
const libraryController = require('../controllers/library.controller');
const requireAuth = require('../middleware/auth.middleware');

router.get('/library', requireAuth, libraryController.getLibrary);
router.post('/library/:paperId/reindex', requireAuth, libraryController.reindexPaper);
router.delete('/library/:paperId', requireAuth, libraryController.deletePaper);

// Library Meta Routes
router.patch('/library/:paperId/star', requireAuth, libraryController.toggleStar);
router.patch('/library/:paperId/notes', requireAuth, libraryController.updateNotes);
router.get('/library/search', requireAuth, libraryController.searchLibrary);
router.get('/collections', requireAuth, libraryController.listCollections);
router.post('/collections', requireAuth, libraryController.createCollectionEntry);
router.patch('/library/:paperId/collection', requireAuth, libraryController.updateCollection);

// Share Routes
router.post('/library/:paperId/share', requireAuth, libraryController.createShare);
router.delete('/library/:paperId/share', requireAuth, libraryController.revokeShare);
router.get('/share/:token', libraryController.getPublicShareData);

module.exports = router;
