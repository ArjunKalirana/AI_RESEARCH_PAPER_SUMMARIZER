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

// Request Logger diagnostic
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
});

// Diagnostic: Check if frontend exists in the container
const frontendPath = path.resolve(__dirname, 'frontend');
if (fs.existsSync(frontendPath)) {
    console.log("✅ Frontend folder found at (resolved):", frontendPath);
    console.log("📂 Content:", fs.readdirSync(frontendPath));
} else {
    console.error("❌ Frontend folder NOT found at (resolved):", frontendPath);
}

// Serve frontend static files
app.use(express.static(frontendPath));

// Explicit Root Handler
app.get('/', (req, res) => {
    const indexPath = path.join(frontendPath, 'upload.html');
    if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
    } else {
        res.status(404).send("upload.html NOT FOUND in " + frontendPath);
    }
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

const { rebuildIndicesFromDisk } = require('./services/faissService');

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    
    // Initial rebuild of FAISS indices on startup to handle ephemeral filesystem loss
    setTimeout(() => {
      rebuildIndicesFromDisk().catch(err => console.error("❌ FAISS Startup Rebuild Failed:", err.message));
    }, 5000);
});
