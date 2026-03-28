const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const uploadRoutes = require('./routes/upload.route');
const summaryRoutes = require('./routes/summary.route');
const askRoutes = require('./routes/ask.route');
const compareRoutes = require('./routes/compare.route');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Diagnostic: Check if frontend exists in the container
const frontendPath = path.join(__dirname, 'frontend');
if (fs.existsSync(frontendPath)) {
    console.log("✅ Frontend folder found at:", frontendPath);
    console.log("📂 Content:", fs.readdirSync(frontendPath));
} else {
    console.error("❌ Frontend folder NOT found at:", frontendPath);
}

// Serve frontend static files
app.use(express.static(frontendPath));

// Explicit Root Redirect
app.get('/', (req, res) => {
    res.redirect('/upload.html');
});

// Dummy Favicon handler to stop 404 logs
app.get('/favicon.ico', (req, res) => res.status(204).end());

// API Routes
app.use('/api', uploadRoutes);
app.use('/api', summaryRoutes);
app.use('/api', askRoutes);
app.use('/api', compareRoutes);

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!', details: err.message });
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
