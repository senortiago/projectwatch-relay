class ClipboardManager {
    constructor() {
        this.bindEvents();
    }

    bindEvents() {
        const btnPaste = document.getElementById('btn-paste');
        const btnCopy = document.getElementById('btn-copy');

        if (btnPaste) {
            btnPaste.addEventListener('click', () => this.pasteToDevice());
        }
        if (btnCopy) {
            btnCopy.addEventListener('click', () => this.requestCopyFromDevice());
        }
    }

    async pasteToDevice() {
        if (!window.app || !window.app.ws) return;
        
        try {
            const text = await navigator.clipboard.readText();
            window.app.sendMessage({
                type: 'clipboard_sync',
                content: text,
                format: 'text'
            });
            window.app.showToast('Clipboard sent to device');
        } catch(e) {
            window.app.showToast('Clipboard access denied. Check permissions.', 'error');
            console.error('Clipboard read failed', e);
        }
    }

    requestCopyFromDevice() {
        if (!window.app) return;
        window.app.sendCommand('request_clipboard');
    }

    async onRemoteClipboard(content) {
        try {
            await navigator.clipboard.writeText(content);
            if (window.app) {
                window.app.showToast('Copied from device');
            }
        } catch(e) {
            if (window.app) {
                window.app.showToast('Failed to write to clipboard', 'error');
            }
            console.error('Clipboard write failed', e);
        }
    }
}

window.clipboardManager = new ClipboardManager();
