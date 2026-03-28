const express = require('express');
const cors = require('cors');
const path = require('path');

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

// Serve frontend static files if needed (assuming frontend is in ../frontend)
app.use(express.static(path.join(__dirname, 'frontend')));

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
