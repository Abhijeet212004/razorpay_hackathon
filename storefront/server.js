const path = require('path');
const express = require('express');
const cloudinary = require('cloudinary');
const app = require('./backend/app');
const connectDatabase = require('./backend/config/database');
const PORT = process.env.PORT || 4000;

// UncaughtException Error
process.on('uncaughtException', (err) => {
    console.log(`Error: ${err.message}`);
    process.exit(1);
});

connectDatabase();

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

// deployment
__dirname = path.resolve();
if (process.env.NODE_ENV === 'production') {
    // Ahead of everything, including the static handler, so we see exactly what a client
    // asked for rather than what survived the middleware in front of it.
    app.use((req, _res, next) => {
        if (!/\.(js|css|png|jpg|jpeg|svg|ico|woff2?|map)$/i.test(req.originalUrl)) {
            console.log(`[req] ${req.method} ${JSON.stringify(req.originalUrl)}`);
        }
        next();
    });

    app.use(express.static(path.join(__dirname, '/frontend/build')))

    // A link that arrives percent-encoded as one path segment. Different browsers
    // normalise this differently — some send "/%2Fagent%2F...", some "//agent%2F..." —
    // so rather than matching one shape, decode anything that still carries an encoded
    // slash or question mark and send it to the real path.
    app.get('*', (req, res, next) => {
        const raw = req.originalUrl;
        if (!/%2f|%3f/i.test(raw)) return next();

        let decoded;
        try {
            decoded = decodeURIComponent(raw);
        } catch {
            return next();
        }

        // Leading slashes are collapsed rather than rejected: "/%2Fagent" decodes to
        // "//agent", which is the case this exists for, while "//host/path" would be
        // protocol-relative and could leave the origin. Collapsing makes both local.
        decoded = decoded.replace(/^\/+/, '/');
        if (!decoded.startsWith('/') || decoded === raw) return next();

        return res.redirect(302, decoded);
    });

    app.get('*', (req, res) => {
        res.sendFile(path.resolve(__dirname, 'frontend', 'build', 'index.html'))
    });
} else {
    app.get('/', (req, res) => {
        res.send('Server is Running! 🚀');
    });
}

const server = app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`)
});

// Unhandled Promise Rejection
process.on('unhandledRejection', (err) => {
    console.log(`Error: ${err.message}`);
    server.close(() => {
        process.exit(1);
    });
});
