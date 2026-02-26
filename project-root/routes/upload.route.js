const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const { uploadPaper } = require('../controllers/upload.controller');

// Configure multer for PDF uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, path.join(__dirname, '../data/raw_papers'));
  },
  filename: function (req, file, cb) {
    // Sanitize filename: remove spaces and special characters
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

router.post('/upload', upload.single('paper'), uploadPaper);

module.exports = router;
