class WatzonApp {
    constructor() {
        this.session = this.loadSession();
        this.ws = null;
        this.wsUrl = this.getWsUrl();
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 6;
        this.isReconnecting = false;
        
        // Render state
        this.canvas = document.getElementById('screen-canvas');
        this.ctx = this.canvas.getContext('2d', { alpha: false });
        this.lastFrameTime = 0;
        this.frameCount = 0;
        this.fpsInterval = setInterval(() => this.updateFps(), 1000);
        this.resizeTimeout = null;
    }

    getWsUrl() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const host = window.location.host || 'localhost:8765';
        return `${protocol}//${host}/ws`;
    }

    loadSession() {
        return {
            authToken: localStorage.getItem('pw_auth_token'),
            deviceId: localStorage.getItem('pw_device_id') || this.generateUUID(),
        };
    }
    
    loadPairedDevices() {
        try {
            const stored = localStorage.getItem('pw_paired_devices');
            return stored ? JSON.parse(stored) : [];
        } catch (e) {
            return [];
        }
    }

    saveSession() {
        if (this.session.authToken) localStorage.setItem('pw_auth_token', this.session.authToken);
        localStorage.setItem('pw_device_id', this.session.deviceId);
        this.savePairedDevices();
    }
    
    savePairedDevices() {
        localStorage.setItem('pw_paired_devices', JSON.stringify(this.pairedDevices));
    }

    clearSession() {
        localStorage.removeItem('pw_auth_token');
        this.session.authToken = null;
    }
    
    unpairDevice(token) {
        this.pairedDevices = this.pairedDevices.filter(d => d.sessionToken !== token);
        this.savePairedDevices();
        this.showDashboard();
    }

    generateUUID() {
        const uuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
            const r = Math.random() * 16 | 0;
            return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
        localStorage.setItem('pw_device_id', uuid);
        return uuid;
    }

    init() {
        this.pairedDevices = this.loadPairedDevices();
        this.activeSessionToken = null;
        this.activePartnerName = null;
        this.saveSession(); // ensure device id is saved
        this.bindEvents();
        this.fileManager = new FileManagerUI(this);
        this.smsUI = new SmsUI(this);
        
        if (this.session.authToken) {
            this.showDashboard();
        } else {
            this.showScreen('login');
        }
    }

    bindEvents() {
        // Login
        document.getElementById('login-form').addEventListener('submit', (e) => {
            e.preventDefault();
            this.login(document.getElementById('password').value);
        });

        const pwInput = document.getElementById('password');
        const btnShowPw = document.getElementById('btn-show-password');
        if (pwInput && btnShowPw) {
            btnShowPw.addEventListener('click', () => {
                if (pwInput.type === 'password') {
                    pwInput.type = 'text';
                    btnShowPw.innerText = '🔒';
                    btnShowPw.title = 'Hide Password';
                } else {
                    pwInput.type = 'password';
                    btnShowPw.innerText = '👁️';
                    btnShowPw.title = 'Show Password';
                }
            });
        }

        // Dashboard
        document.getElementById('btn-logout').addEventListener('click', () => this.logout());
        
        // Pairing input auto-advance
        const inputs = document.querySelectorAll('.digit-input');
        inputs.forEach((input, index) => {
            input.addEventListener('input', (e) => {
                if (e.target.value.length === 1) {
                    if (index < inputs.length - 1) inputs[index + 1].focus();
                }
                this.checkPairingCode();
            });
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Backspace' && !e.target.value && index > 0) {
                    inputs[index - 1].focus();
                }
            });
        });

        document.getElementById('btn-pair').addEventListener('click', () => {
            const code = Array.from(inputs).map(i => i.value).join('');
            this.pair(code);
        });

        // Controller Toolbar
        document.querySelectorAll('.tool-btn[data-action]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                this.sendCommand(e.currentTarget.dataset.action);
            });
        });

        document.getElementById('btn-back-dash').addEventListener('click', () => {
            if (this.ws) this.ws.close();
            this.showDashboard();
        });

        document.getElementById('btn-fullscreen').addEventListener('click', () => {
            if (!document.fullscreenElement) {
                document.documentElement.requestFullscreen().catch(err => {
                    window.app.showToast(`Error attempting to enable full-screen mode: ${err.message}`, 'error');
                });
            } else {
                if (document.exitFullscreen) {
                    document.exitFullscreen();
                }
            }
        });

        // Notification Modal
        const modalNotify = document.getElementById('modal-notify');
        const notifyText = document.getElementById('notify-text');
        
        document.getElementById('btn-notify').addEventListener('click', () => {
            modalNotify.classList.remove('hidden');
            notifyText.focus();
        });

        document.getElementById('btn-notify-cancel').addEventListener('click', () => {
            modalNotify.classList.add('hidden');
            notifyText.value = '';
        });

        document.getElementById('btn-notify-send').addEventListener('click', () => {
            const text = notifyText.value.trim();
            if (text) {
                this.sendMessage({ type: 'show_notification', text: text });
                this.showToast('Notification sent to device', 'success');
                modalNotify.classList.add('hidden');
                notifyText.value = '';
            } else {
                this.showToast('Please enter a message', 'warning');
            }
        });

        window.addEventListener('resize', () => {
            if (this.resizeTimeout) clearTimeout(this.resizeTimeout);
            this.resizeTimeout = setTimeout(() => {
                this.requestResolution();
            }, 500);
        });
    }

    showScreen(screenName) {
        document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
        document.getElementById(`screen-${screenName}`).classList.add('active');
        
        if (this.stayAwakeInterval) {
            clearInterval(this.stayAwakeInterval);
            this.stayAwakeInterval = null;
            this.sendCommand('allow_sleep');
        }

        if (screenName === 'controller') {
            window.inputManager.attach(this.canvas, this);
            this.requestResolution();
            
            // Start stay awake heartbeat
            this.sendCommand('keep_awake');
            this.stayAwakeInterval = setInterval(() => {
                this.sendCommand('keep_awake');
            }, 30000); // every 30 seconds
        } else {
            window.inputManager.detach();
        }
    }

    async login(password) {
        try {
            const res = await fetch('/api/auth', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password })
            });
            const data = await res.json();
            if (data.success) {
                this.session.authToken = data.token;
                this.saveSession();
                this.showDashboard();
            } else {
                document.getElementById('login-error').innerText = data.message || 'Invalid password';
            }
        } catch (e) {
            document.getElementById('login-error').innerText = 'Connection error. Is the server running?';
        }
    }

    async logout() {
        try {
            await fetch('/api/logout', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token: this.session.authToken })
            });
        } catch (e) { /* ignore */ }
        localStorage.removeItem('pw_auth_token');
        this.session.authToken = null;
        this.clearSession();
        if (this.ws) this.ws.close();
        this.showScreen('login');
    }

    async showDashboard() {
        this.showScreen('dashboard');
        
        document.getElementById('server-url-display').innerText = this.wsUrl;
        
        let serverSessions = [];
        try {
            const res = await fetch('/api/status', {
                headers: { 'Authorization': `Bearer ${this.session.authToken}` }
            });
            const data = await res.json();
            serverSessions = data.sessions || [];
        } catch (e) {
            console.warn('Could not fetch server status (offline mode)');
        }
        
        // Render devices list
        const grid = document.getElementById('paired-devices-grid');
        grid.innerHTML = '';
        
        if (this.pairedDevices.length > 0) {
            this.pairedDevices.forEach(device => {
                const srvSession = serverSessions.find(s => s.token === device.sessionToken);
                const isOnline = srvSession ? srvSession.androidOnline : false;
                
                const card = document.createElement('div');
                card.className = 'device-card';
                card.innerHTML = `
                    <div class="device-header">
                        <div class="device-icon">📱</div>
                        <div class="device-info">
                            <h3>${this.escapeHtml(device.partnerName || 'Android Device')}</h3>
                            <p class="status-text">
                                <span class="status-dot ${isOnline ? 'online' : 'offline'}"></span> 
                                <span>${isOnline ? 'Online' : 'Offline'}</span>
                            </p>
                        </div>
                    </div>
                    <div class="device-actions">
                        <button class="btn-connect-device btn ${isOnline ? 'btn-primary' : 'btn-outline'} btn-block btn-lg" data-token="${device.sessionToken}">
                            ${isOnline ? 'Start Session' : 'Connect Anyway'}
                        </button>
                        <button class="btn-unpair-device btn btn-text btn-sm mt-3" data-token="${device.sessionToken}">Unpair Device</button>
                    </div>
                `;
                grid.appendChild(card);
            });
            
            // Attach event listeners
            grid.querySelectorAll('.btn-connect-device').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    const token = e.currentTarget.dataset.token;
                    const device = this.pairedDevices.find(d => d.sessionToken === token);
                    if (device) {
                        this.activeSessionToken = device.sessionToken;
                        this.activePartnerName = device.partnerName;
                        this.reconnectAttempts = 0;
                        this.isReconnecting = false;
                        this.connectWebSocket(null, token);
                        this.showScreen('controller');
                    }
                });
            });
            
            grid.querySelectorAll('.btn-unpair-device').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    const token = e.currentTarget.dataset.token;
                    if (confirm('Are you sure you want to unpair this device?')) {
                        this.unpairDevice(token);
                    }
                });
            });
        }
    }

    escapeHtml(unsafe) {
        if (!unsafe) return '';
        return unsafe
             .replace(/&/g, "&amp;")
             .replace(/</g, "&lt;")
             .replace(/>/g, "&gt;")
             .replace(/"/g, "&quot;")
             .replace(/'/g, "&#039;");
    }

    checkPairingCode() {
        const inputs = Array.from(document.querySelectorAll('.digit-input'));
        const code = inputs.map(i => i.value).join('');
        document.getElementById('btn-pair').disabled = code.length !== 6;
    }

    pair(code) {
        document.getElementById('btn-pair').disabled = true;
        document.getElementById('btn-pair').innerText = 'Connecting...';
        this.connectWebSocket(code, null);
    }

    connectWebSocket(pairingCode = null, sessionToken = null) {
        if (this.ws) {
            this.ws.onclose = null;
            this.ws.onerror = null;
            this.ws.onmessage = null;
            this.ws.close();
            this.ws = null;
        }

        if (!this.session.authToken) {
            this.showToast('Not authenticated. Please log in.', 'error');
            this.showScreen('login');
            return;
        }
        
        const url = `${this.wsUrl}?token=${this.session.authToken}`;
        this.ws = new WebSocket(url);
        this.ws.binaryType = 'blob';

        this.updateStatus('connecting');

        this.ws.onopen = () => {
            this.reconnectAttempts = 0;
            const browserInfo = navigator.userAgent.substring(0, 50);
            
            this.sendMessage({
                type: 'register',
                role: 'windows',
                deviceId: this.session.deviceId,
                deviceName: `Web Controller (${browserInfo})`
            });

            if (pairingCode) {
                this.sendMessage({
                    type: 'pair_request',
                    pairingCode: pairingCode
                });
            } else if (sessionToken) {
                this.sendMessage({
                    type: 'reconnect',
                    sessionToken: sessionToken,
                    deviceId: this.session.deviceId,
                    role: 'windows'
                });
            }
        };

        this.ws.onmessage = (e) => {
            if (typeof e.data === 'string') {
                try {
                    const msg = JSON.parse(e.data);
                    this.handleMessage(msg);
                } catch (err) {
                    console.error('Error parsing message', err);
                }
            } else if (e.data instanceof Blob) {
                this.renderFrame(e.data);
            }
        };

        this.ws.onclose = (e) => {
            this.updateStatus('offline');
            
            // Reset pair button if we were trying to pair
            const btnPair = document.getElementById('btn-pair');
            if (btnPair && btnPair.innerText === 'Connecting...') {
                btnPair.disabled = false;
                btnPair.innerText = 'Connect';
                document.getElementById('pair-error').innerText = 'Connection to server failed.';
            }
            
            if (e.code === 1008) {
                this.showToast('Session expired. Please log in again.', 'error');
                this.clearSession();
                this.showScreen('login');
                return;
            }
            if (document.getElementById('screen-controller').classList.contains('active') && this.activeSessionToken) {
                this.scheduleReconnect();
            }
        };

        this.ws.onerror = (err) => {
            console.error('WebSocket error:', err);
        };
    }

    scheduleReconnect() {
        if (this.isReconnecting) return;
        this.isReconnecting = true;
        
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            this.showToast('Connection lost. Please try reconnecting from dashboard.', 'error');
            this.isReconnecting = false;
            this.reconnectAttempts = 0;
            this.showDashboard();
            return;
        }
        
        const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 60000);
        this.reconnectAttempts++;
        
        this.showToast(`Reconnecting in ${delay/1000}s... (${this.reconnectAttempts}/${this.maxReconnectAttempts})`, 'warning');
        
        setTimeout(() => {
            this.isReconnecting = false;
            if (document.getElementById('screen-controller').classList.contains('active')) {
                this.connectWebSocket();
            }
        }, delay);
    }

    handleMessage(msg) {
        switch (msg.type) {
            case 'pair_success':
                document.getElementById('btn-pair').disabled = false;
                document.getElementById('btn-pair').innerText = 'Connect';
                document.querySelectorAll('.digit-input').forEach(i => i.value = '');
                
                // Add to paired devices array if not exists
                if (!this.pairedDevices.find(d => d.sessionToken === msg.sessionToken)) {
                    this.pairedDevices.push({
                        sessionToken: msg.sessionToken,
                        partnerName: msg.partnerName
                    });
                    this.savePairedDevices();
                }
                
                this.activeSessionToken = msg.sessionToken;
                this.activePartnerName = msg.partnerName;
                
                this.showToast('Paired successfully!', 'success');
                document.getElementById('viewer-overlay').classList.add('hidden');
                this.showScreen('controller');
                this.requestResolution();
                break;
                
            case 'screen_config':
                // Initial screen config from Android
                this.canvas.width = msg.width;
                this.canvas.height = msg.height;
                document.getElementById('res-indicator').innerText = `${msg.width}x${msg.height}`;
                document.getElementById('ctrl-device-name').innerText = this.activePartnerName || 'Device';
                break;
                
            case 'status':
                // Status messages from Android (e.g., "ready", "capturing")
                if (msg.state === 'ready') {
                    this.updateStatus('online');
                    document.getElementById('viewer-overlay').classList.add('hidden');
                    document.getElementById('ctrl-device-name').innerText = this.activePartnerName || 'Device';
                    this.requestResolution();
                } else if (msg.state === 'error') {
                    this.showToast(`Device error: ${msg.message}`, 'error');
                }
                break;
            case 'clipboard_sync':
                if (window.clipboardManager) {
                    window.clipboardManager.onRemoteClipboard(msg.content);
                }
                break;
            case 'file_list_response':
                this.fileManager.handleListResponse(msg);
                break;
            case 'file_chunk':
                this.fileManager.handleChunk(msg);
                break;
            case 'file_upload_ack':
                this.fileManager.handleUploadAck(msg);
                break;
            case 'file_delete_response':
                this.fileManager.handleDeleteResponse(msg);
                break;
            case 'file_mkdir_response':
                this.fileManager.handleMkdirResponse(msg);
                break;
            case 'sms_conversations_response':
                this.smsUI.handleConversationsResponse(msg);
                break;
            case 'sms_thread_response':
                this.smsUI.handleThreadResponse(msg);
                break;
            case 'sms_incoming':
                this.smsUI.handleIncoming(msg);
                break;
                
            case 'reconnect_success':
                this.updateStatus('online');
                document.getElementById('viewer-overlay').classList.add('hidden');
                document.getElementById('ctrl-device-name').innerText = msg.partnerName || this.activePartnerName || 'Device';
                this.requestResolution();
                if (!msg.partnerOnline) {
                    this.showToast('Connected to server. Waiting for device...', 'warning');
                }
                break;

            case 'error':
                // Error from relay server
                if (msg.message === 'Invalid session') {
                    this.showToast('Session expired. Please unpair and pair again.', 'error');
                    this.clearSession();
                    if (this.ws) { this.ws.close(); this.ws = null; }
                    this.showDashboard();
                } else if (msg.message === 'Invalid pairing code') {
                    document.getElementById('btn-pair').disabled = false;
                    document.getElementById('btn-pair').innerText = 'Connect';
                    document.getElementById('pair-error').innerText = 'Invalid pairing code. Please try again.';
                    if (this.ws) { this.ws.close(); this.ws = null; }
                } else {
                    this.showToast(msg.message || 'Server error', 'error');
                }
                break;
        }
    }

    sendMessage(obj) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(obj));
        }
    }

    sendCommand(action) {
        this.sendMessage({ type: 'command', action });
    }

    requestResolution() {
        const container = document.getElementById('viewer-container');
        if (container.clientWidth > 0 && container.clientHeight > 0) {
            this.sendMessage({
                type: 'resolution_request',
                width: container.clientWidth,
                height: container.clientHeight
            });
        }
    }

    async renderFrame(blob) {
        document.getElementById('viewer-overlay').classList.add('hidden');
        this.updateStatus('online');
        
        try {
            let img;
            if (window.createImageBitmap) {
                img = await createImageBitmap(blob);
            } else {
                const url = URL.createObjectURL(blob);
                img = new Image();
                await new Promise((res, rej) => {
                    img.onload = res;
                    img.onerror = rej;
                    img.src = url;
                });
                URL.revokeObjectURL(url);
            }
            
            if (this.canvas.width !== img.width || this.canvas.height !== img.height) {
                this.canvas.width = img.width;
                this.canvas.height = img.height;
                document.getElementById('res-indicator').innerText = `${img.width}x${img.height}`;
                
                let qText = 'SD';
                if (img.height >= 1920) qText = '1080p';
                else if (img.height >= 1280) qText = '720p';
                else if (img.height >= 720) qText = '480p';
                
                const qBadge = document.getElementById('quality-badge');
                if (qBadge) qBadge.innerText = qText;
            }
            
            this.ctx.drawImage(img, 0, 0);
            this.frameCount++;
            
            if (img.close) img.close(); // free memory if ImageBitmap
        } catch (err) {
            console.error('Frame render error', err);
        }
    }

    updateFps() {
        const counter = document.getElementById('fps-counter');
        if (counter) {
            counter.innerText = `${this.frameCount} FPS`;
        }
        this.frameCount = 0;
    }

    updateStatus(status) {
        const dotDash = document.getElementById('dash-status-dot');
        const textDash = document.getElementById('dash-status-text');
        const dotCtrl = document.getElementById('ctrl-status-dot');
        const overlay = document.getElementById('viewer-overlay');
        
        dotDash.className = `status-dot ${status}`;
        dotCtrl.className = `status-dot ${status}`;
        
        if (status === 'online') {
            textDash.innerText = 'Connected';
        } else if (status === 'offline') {
            textDash.innerText = 'Offline';
        } else {
            textDash.innerText = status.charAt(0).toUpperCase() + status.slice(1);
        }
        
        if (status === 'connecting') {
            overlay.classList.remove('hidden');
        } else if (status === 'offline') {
            overlay.classList.remove('hidden');
            document.getElementById('overlay-text').innerText = 'Connection lost...';
        }
    }

    showToast(message, type = 'success') {
        const container = document.getElementById('toast-container');
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.innerText = message;
        
        container.appendChild(toast);
        
        setTimeout(() => {
            toast.classList.add('fade-out');
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }
}

// Bootstrap
window.addEventListener('DOMContentLoaded', () => {
    window.app = new WatzonApp();
    window.app.init();
});
