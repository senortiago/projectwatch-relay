const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { randomUUID: uuidv4 } = require('crypto');

const PORT = process.env.PORT || 8765;
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || 'watzon';
const SSL_CERT = process.env.SSL_CERT;
const SSL_KEY = process.env.SSL_KEY;

// --- State ---

// Pairing offers: code -> { androidDeviceId, androidDeviceName, androidWs, timestamp }
const pairOffers = new Map();

// Active sessions: token -> { androidId, windowsId, androidName, windowsName, androidWs, windowsWs, created, lastActive, androidQueue, windowsQueue }
const sessions = new Map();

// Active connections: ws -> { role, deviceId, deviceName, sessionToken, isAlive, ip, isAuthenticated }
const connections = new Map();

// Rate limiting: IP -> { attempts, resetTime }
const rateLimits = new Map();

// authTokens: token -> expiryTime
const authTokens = new Map();

// --- Configuration ---
const SESSION_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const AUTH_TOKEN_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAX_QUEUE_SIZE = 100;
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute

// --- Utilities ---
function log(msg, level = 'INFO') {
    console.log(`[${new Date().toISOString()}] [${level}] ${msg}`);
}

function checkRateLimit(ip) {
    const now = Date.now();
    let limit = rateLimits.get(ip);
    if (!limit || now > limit.resetTime) {
        limit = { attempts: 1, resetTime: now + RATE_LIMIT_WINDOW };
        rateLimits.set(ip, limit);
        return true;
    }
    if (limit.attempts >= RATE_LIMIT_MAX) {
        return false;
    }
    limit.attempts++;
    return true;
}

function cleanupStaleData() {
    const now = Date.now();
    
    // Cleanup pair offers older than 10 minutes
    for (const [code, offer] of pairOffers.entries()) {
        if (now - offer.timestamp > 10 * 60 * 1000) {
            pairOffers.delete(code);
        }
    }
    
    // Cleanup expired sessions
    for (const [token, session] of sessions.entries()) {
        if (now - session.lastActive > SESSION_EXPIRY_MS) {
            sessions.delete(token);
            log(`Session ${token} expired.`);
        }
    }
    
    // Cleanup expired auth tokens
    for (const [token, expiry] of authTokens.entries()) {
        if (now > expiry) {
            authTokens.delete(token);
        }
    }
}
setInterval(cleanupStaleData, 60 * 60 * 1000); // Run hourly

// --- Express App ---
const app = express();

// Serve static files FIRST
app.use(express.static('public', { index: false }));

// Force no-cache for the main HTML file to ensure updates propagate
app.get('/', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Middleware for parsing JSON APIs
app.use(express.json());

// API Routes
app.post('/api/auth', (req, res) => {
    const { password } = req.body;
    if (password === AUTH_PASSWORD) {
        const token = uuidv4();
        authTokens.set(token, Date.now() + AUTH_TOKEN_EXPIRY_MS);
        log('Successful authentication, generated new token.');
        res.json({ success: true, token });
    } else {
        log('Failed authentication attempt.', 'WARN');
        res.status(401).json({ success: false, message: 'Invalid password' });
    }
});

app.post('/api/logout', (req, res) => {
    const { token } = req.body;
    if (token && authTokens.has(token)) {
        authTokens.delete(token);
        log('Token logged out.');
    }
    res.json({ success: true });
});

app.get('/api/status', (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    
    const token = authHeader.split(' ')[1];
    if (!authTokens.has(token) || Date.now() > authTokens.get(token)) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    
    const sessionsList = [];
    for (const [sToken, session] of sessions.entries()) {
        sessionsList.push({
            token: sToken,
            androidName: session.androidName || 'Unknown',
            windowsName: session.windowsName || 'Unknown',
            androidOnline: session.androidWs && session.androidWs.readyState === WebSocket.OPEN ? true : false,
            windowsOnline: session.windowsWs && session.windowsWs.readyState === WebSocket.OPEN ? true : false,
            created: new Date(session.created).toISOString(),
            lastActive: new Date(session.lastActive).toISOString()
        });
    }

    const connectionsList = [];
    for (const [ws, conn] of connections.entries()) {
        connectionsList.push({
            role: conn.role || 'unregistered',
            deviceId: conn.deviceId,
            deviceName: conn.deviceName,
            ip: conn.ip,
            isAlive: conn.isAlive,
            sessionToken: conn.sessionToken
        });
    }

    res.json({ sessions: sessionsList, connections: connectionsList });
});

// --- Server Setup ---
let server;
if (SSL_CERT && SSL_KEY) {
    const options = {
        cert: fs.readFileSync(SSL_CERT),
        key: fs.readFileSync(SSL_KEY)
    };
    server = https.createServer(options, app);
    log('Starting HTTPS (TLS) server');
} else {
    server = http.createServer(app);
    log('Starting HTTP (plaintext) server');
}

const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/ws') {
        wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit('connection', ws, request);
        });
    } else {
        socket.destroy();
    }
});

wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress;
    log(`New connection from ${ip}`);
    
    const url = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('token');
    
    let isAuthenticated = false;
    if (token) {
        if (authTokens.has(token) && Date.now() <= authTokens.get(token)) {
            isAuthenticated = true;
        } else {
            log(`Invalid or expired token from ${ip}`, 'WARN');
            ws.close(1008, 'Invalid token');
            return;
        }
    }
    
    connections.set(ws, { isAlive: true, ip, isAuthenticated });

    ws.on('pong', () => {
        const conn = connections.get(ws);
        if (conn) conn.isAlive = true;
    });

    ws.on('message', (message, isBinary) => {
        const conn = connections.get(ws);
        if (!conn) return;

        // Update session lastActive if associated
        if (conn.sessionToken) {
            const session = sessions.get(conn.sessionToken);
            if (session) session.lastActive = Date.now();
        }

        if (isBinary) {
            // Forward binary messages (screen frames)
            if (!conn.sessionToken) return;
            const session = sessions.get(conn.sessionToken);
            if (!session) return;
            
            const partnerWs = conn.role === 'android' ? session.windowsWs : session.androidWs;
            if (partnerWs && partnerWs.readyState === WebSocket.OPEN) {
                partnerWs.send(message, { binary: true }); // zero-copy pass-through
            }
            return;
        }

        // Handle JSON text messages
        let data;
        try {
            data = JSON.parse(message.toString());
        } catch (e) {
            log(`Invalid JSON received from ${ip}: ${e.message}`, 'WARN');
            return;
        }

        // Protocol messages that must always be processed by the server
        const protocolTypes = ['register', 'reconnect', 'pair_offer', 'pair_request'];
        
        // Routing logic for paired devices (pass-through for custom types like text_input, touch, etc.)
        if (conn.sessionToken && !protocolTypes.includes(data.type)) {
            const session = sessions.get(conn.sessionToken);
            if (!session) return;

            const partnerRole = conn.role === 'android' ? 'windows' : 'android';
            const partnerWs = partnerRole === 'windows' ? session.windowsWs : session.androidWs;
            const partnerQueue = partnerRole === 'windows' ? session.windowsQueue : session.androidQueue;

            if (partnerWs && partnerWs.readyState === WebSocket.OPEN) {
                partnerWs.send(message.toString());
            } else {
                // Partner offline — only queue non-ephemeral messages (skip touch/key/resolution)
                const ephemeralTypes = ['touch', 'key', 'resolution_request', 'keep_awake'];
                if (!ephemeralTypes.includes(data.type) && partnerQueue.length < MAX_QUEUE_SIZE) {
                    partnerQueue.push(message.toString());
                }
            }
            return;
        }

        // Protocol logic
        switch (data.type) {
            case 'register': {
                if (data.role !== 'android' && data.role !== 'windows') return;
                
                if (data.role === 'windows' && !conn.isAuthenticated) {
                    log(`Unauthorized Windows registration attempt from ${ip}`, 'WARN');
                    ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized' }));
                    ws.close(1008, 'Unauthorized');
                    return;
                }
                
                conn.role = data.role;
                conn.deviceId = data.deviceId;
                conn.deviceName = data.deviceName;
                log(`Registered ${conn.role} ${conn.deviceName} (${conn.deviceId})`);
                break;
            }

            case 'pair_offer': {
                if (conn.role !== 'android') return;
                const code = data.pairingCode;
                pairOffers.set(code, {
                    androidDeviceId: conn.deviceId,
                    androidDeviceName: conn.deviceName,
                    androidWs: ws,
                    timestamp: Date.now()
                });
                log(`Pair offer created by ${conn.deviceName}: ${code}`);
                break;
            }

            case 'pair_request': {
                if (conn.role !== 'windows') return;
                if (!checkRateLimit(conn.ip)) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Rate limit exceeded' }));
                    log(`Rate limit exceeded for IP ${conn.ip}`, 'WARN');
                    return;
                }

                const code = data.pairingCode;
                const offer = pairOffers.get(code);

                if (offer) {
                    // Match successful
                    const sessionToken = uuidv4();
                    const now = Date.now();
                    
                    const session = {
                        androidId: offer.androidDeviceId,
                        windowsId: conn.deviceId,
                        androidName: offer.androidDeviceName,
                        windowsName: conn.deviceName,
                        androidWs: offer.androidWs,
                        windowsWs: ws,
                        created: now,
                        lastActive: now,
                        androidQueue: [],
                        windowsQueue: []
                    };
                    
                    sessions.set(sessionToken, session);
                    pairOffers.delete(code);
                    
                    conn.sessionToken = sessionToken;
                    const androidConn = connections.get(offer.androidWs);
                    if (androidConn) androidConn.sessionToken = sessionToken;

                    // Send success to Windows
                    ws.send(JSON.stringify({
                        type: 'pair_success',
                        sessionToken,
                        partnerName: offer.androidDeviceName,
                        partnerDeviceId: offer.androidDeviceId
                    }));

                    // Send success to Android
                    if (offer.androidWs.readyState === WebSocket.OPEN) {
                        offer.androidWs.send(JSON.stringify({
                            type: 'pair_success',
                            sessionToken,
                            partnerName: conn.deviceName,
                            partnerDeviceId: conn.deviceId
                        }));
                    }
                    log(`Pairing successful for session ${sessionToken}`);
                } else {
                    ws.send(JSON.stringify({ type: 'error', message: 'Invalid pairing code' }));
                }
                break;
            }

            case 'reconnect': {
                const { sessionToken, deviceId, role } = data;
                
                if (role === 'windows' && !conn.isAuthenticated) {
                    log(`Unauthorized Windows reconnect attempt from ${ip}`, 'WARN');
                    ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized' }));
                    ws.close(1008, 'Unauthorized');
                    return;
                }
                
                const session = sessions.get(sessionToken);

                if (!session) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Invalid session' }));
                    return;
                }

                conn.role = role;
                conn.deviceId = deviceId;
                conn.sessionToken = sessionToken;
                session.lastActive = Date.now();

                // If deviceName is provided during reconnect, update session state
                if (data.deviceName) {
                    conn.deviceName = data.deviceName;
                    if (role === 'android') session.androidName = data.deviceName;
                    if (role === 'windows') session.windowsName = data.deviceName;
                }

                if (role === 'android') {
                    if (session.androidId !== deviceId) {
                        log(`Warning: Android deviceId changed from ${session.androidId} to ${deviceId}`);
                        session.androidId = deviceId; // Accept new device ID
                    }
                    session.androidWs = ws;
                    log(`Android ${deviceId} reconnected to session ${sessionToken}`);
                    // Flush queue
                    while (session.androidQueue.length > 0 && ws.readyState === WebSocket.OPEN) {
                        ws.send(session.androidQueue.shift());
                    }
                } else if (role === 'windows') {
                    if (session.windowsId !== deviceId) {
                        log(`Warning: Windows deviceId changed from ${session.windowsId} to ${deviceId}`);
                        session.windowsId = deviceId; // Accept new device ID
                    }
                    session.windowsWs = ws;
                    log(`Windows ${deviceId} reconnected to session ${sessionToken}`);
                    // Flush queue
                    while (session.windowsQueue.length > 0 && ws.readyState === WebSocket.OPEN) {
                        ws.send(session.windowsQueue.shift());
                    }
                }

                // Send reconnect_success back to the client
                const partnerRole2 = role === 'android' ? 'windows' : 'android';
                const partnerWs2 = partnerRole2 === 'windows' ? session.windowsWs : session.androidWs;
                ws.send(JSON.stringify({
                    type: 'reconnect_success',
                    sessionToken,
                    partnerName: role === 'android' ? session.windowsName : session.androidName,
                    partnerOnline: partnerWs2 ? partnerWs2.readyState === WebSocket.OPEN : false
                }));
                log(`Reconnect success sent to ${role} for session ${sessionToken}`);
                break;
            }
            
            default:
                log(`Unknown message type: ${data.type}`, 'WARN');
        }
    });

    ws.on('close', () => {
        const conn = connections.get(ws);
        if (conn) {
            log(`Connection closed for ${conn.role || 'unregistered'} (${conn.deviceId || conn.ip})`);
            
            // Unset ws in session to indicate offline
            if (conn.sessionToken) {
                const session = sessions.get(conn.sessionToken);
                if (session) {
                    if (conn.role === 'android' && session.androidWs === ws) session.androidWs = null;
                    if (conn.role === 'windows' && session.windowsWs === ws) session.windowsWs = null;
                }
            }
            
            // Remove from pair offers if it was an active offer
            if (conn.role === 'android') {
                for (const [code, offer] of pairOffers.entries()) {
                    if (offer.androidWs === ws) {
                        pairOffers.delete(code);
                    }
                }
            }
            
            connections.delete(ws);
        }
    });
    
    ws.on('error', (err) => {
        log(`WebSocket error: ${err.message}`, 'ERROR');
    });
});

// Heartbeat
const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
        const conn = connections.get(ws);
        if (!conn) return;
        
        if (conn.isAlive === false) {
            log(`Terminating unresponsive connection from ${conn.ip}`);
            return ws.terminate();
        }

        conn.isAlive = false;
        ws.ping();
    });
}, 30000);

wss.on('close', () => {
    clearInterval(interval);
});

server.listen(PORT, () => {
    log(`WatzON relay server started on port ${PORT}`);
});
