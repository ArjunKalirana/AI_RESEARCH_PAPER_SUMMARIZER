const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { uploadPaper } = require('../controllers/upload.controller');

const RAW_PAPERS_DIR = path.join(__dirname, '../data/raw_papers');
if (!fs.existsSync(RAW_PAPERS_DIR)) {
  fs.mkdirSync(RAW_PAPERS_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, RAW_PAPERS_DIR);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const safeName = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '');
    cb(null, uniqueSuffix + '-' + safeName);
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed!'), false);
    }
  }
});

// Dedicated error handler for multer errors
function multerErrorHandler(err, req, res, next) {
  if (req.file && req.file.path) {
    fs.unlink(req.file.path, () => {});
  }

  let message;
  if (err.code === 'LIMIT_FILE_SIZE') {
    message = 'File too large. Maximum size is 50 MB.';
  } else if (err.code === 'LIMIT_UNEXPECTED_FILE') {
    message = 'Unexpected file field in request.';
  } else if (err.message === 'Only PDF files are allowed!') {
    message = err.message;
  } else {
    message = err.message || 'Upload failed before processing could begin.';
  }

  return res.status(400).json({ error: true, stage: 'upload', message });
}

router.post('/upload', upload.single('paper'), uploadPaper, multerErrorHandler);
router.post('/upload-stream', upload.single('paper'), uploadPaper, multerErrorHandler);

module.exports = router;
