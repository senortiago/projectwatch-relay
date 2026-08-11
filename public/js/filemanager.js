    constructor(app) {
        this.app = app;
        this.modal = document.getElementById('modal-files');
        
        // Remote state
        this.remotePath = '';
        this.remoteFiles = [];
        this.remoteSelected = new Set();
        
        // Transfer state
        this.downloadChunks = {};
        this.uploadQueue = [];
        
        if (this.modal) {
            this.bindEvents();
        }
    }
    
    bindEvents() {
        // Modal toggling
        document.getElementById('btn-files').addEventListener('click', () => this.open());
        document.getElementById('btn-files-close').addEventListener('click', () => this.close());
        
        // Remote Pane Operations
        document.getElementById('fm-remote-up').addEventListener('click', () => this.remoteUp());
        document.getElementById('fm-remote-refresh').addEventListener('click', () => {
            if (this.remotePath) this.requestRemoteList(this.remotePath);
        });
        document.getElementById('fm-remote-mkdir').addEventListener('click', () => this.remoteCreateFolder());
        document.getElementById('fm-remote-delete').addEventListener('click', () => this.remoteDelete());
        
        document.getElementById('fm-remote-select-all').addEventListener('change', (e) => {
            if (e.target.checked) {
                this.remoteFiles.forEach((_, i) => this.remoteSelected.add(i));
            } else {
                this.remoteSelected.clear();
            }
            this.renderRemoteFiles();
        });
        
        // Upload & Download
        document.getElementById('fm-remote-upload').addEventListener('click', () => {
            document.getElementById('fm-remote-upload-input').click();
        });
        
        document.getElementById('fm-remote-upload-input').addEventListener('change', async (e) => {
            if (e.target.files.length > 0) {
                for (let file of e.target.files) {
                    await this.uploadLocalFileFallback(file, this.remotePath);
                }
                e.target.value = '';
            }
        });
        
        document.getElementById('fm-remote-download').addEventListener('click', () => this.transferToLocal());
    }
    
    open() {
        this.modal.classList.remove('hidden');
        this.requestRemoteList('');
    }
    
    close() {
        this.modal.classList.add('hidden');
    }
    
    // --- Remote Pane (Right) ---
    requestRemoteList(path) {
        document.getElementById('fm-remote-body').innerHTML = '<tr><td colspan="4" style="text-align:center; padding:20px;">Loading...</td></tr>';
        this.remoteSelected.clear();
        this.app.sendMessage({
            type: 'file_list_request',
            path: path,
            transferId: this.app.generateUUID()
        });
    }
    
    handleListResponse(data) {
        if (!data.success) {
            this.setStatus('Error: ' + data.error);
            return;
        }
        this.remotePath = data.path;
        document.getElementById('fm-remote-path').innerText = this.remotePath || '/';
        this.setStatus('');
        
        this.remoteFiles = data.files.sort((a, b) => {
            if (a.isDirectory && !b.isDirectory) return -1;
            if (!a.isDirectory && b.isDirectory) return 1;
            return a.name.localeCompare(b.name);
        });
        
        this.renderRemoteFiles();
    }
    
    renderRemoteFiles() {
        const tbody = document.getElementById('fm-remote-body');
        tbody.innerHTML = '';
        
        if (this.remoteFiles.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; padding:20px;">Folder is empty</td></tr>';
            return;
        }
        
        this.remoteFiles.forEach((file, index) => {
            const tr = document.createElement('tr');
            tr.className = 'fm-file-row';
            if (this.remoteSelected.has(index)) tr.classList.add('selected');
            
            const icon = file.isDirectory ? '📁' : '📄';
            const sizeStr = file.isDirectory ? '--' : this.formatSize(file.size);
            
            tr.innerHTML = `
                <td style="padding: 8px; text-align: center;"><input type="checkbox" ${this.remoteSelected.has(index) ? 'checked' : ''}></td>
                <td style="padding: 8px; text-align: center;">${icon}</td>
                <td style="padding: 8px; word-break: break-all;">${file.name}</td>
                <td style="padding: 8px; color: var(--text-muted);">${sizeStr}</td>
            `;
            
            tr.querySelector('input[type="checkbox"]').addEventListener('click', (e) => {
                e.stopPropagation();
                if (e.target.checked) this.remoteSelected.add(index);
                else this.remoteSelected.delete(index);
                tr.classList.toggle('selected', e.target.checked);
            });
            
            tr.addEventListener('click', () => {
                if (file.isDirectory) {
                    this.remoteNavigate(file.path);
                } else {
                    const cb = tr.querySelector('input[type="checkbox"]');
                    cb.click();
                }
            });
            
            tbody.appendChild(tr);
        });
    }
    
    remoteNavigate(path) {
        this.requestRemoteList(path);
    }
    
    remoteUp() {
        if (this.remotePath && this.remotePath !== '/') {
            const parts = this.remotePath.split('/');
            parts.pop();
            const parent = parts.join('/') || '/';
            this.requestRemoteList(parent);
        }
    }
    
    remoteCreateFolder() {
        const name = prompt('Folder name:');
        if (!name) return;
        
        const newPath = this.remotePath === '/' ? `/${name}` : `${this.remotePath}/${name}`;
        this.app.sendMessage({
            type: 'file_mkdir_request',
            path: newPath,
            transferId: this.app.generateUUID()
        });
        this.setStatus(`Creating folder ${name}...`);
    }
    
    remoteDelete() {
        if (this.remoteSelected.size === 0) return;
        if (!confirm(`Delete ${this.remoteSelected.size} selected items?`)) return;
        
        this.remoteSelected.forEach(index => {
            const file = this.remoteFiles[index];
            this.app.sendMessage({
                type: 'file_delete_request',
                path: file.path,
                transferId: this.app.generateUUID()
            });
        });
        this.setStatus(`Deleting ${this.remoteSelected.size} items...`);
    }
    
    // --- Transfers ---
    transferToLocal() {
        if (this.remoteSelected.size === 0) return;
        
        this.remoteSelected.forEach(index => {
            const file = this.remoteFiles[index];
            if (file.isDirectory) {
                this.setStatus(`Cannot download folders yet: ${file.name}`);
                return;
            }
            this.startDownload(file);
        });
        
        this.remoteSelected.clear();
        this.renderRemoteFiles();
    }
    
    // --- Download handling (from phone) ---
    startDownload(file) {
        const transferId = this.app.generateUUID();
        this.downloadChunks[transferId] = {
            name: file.name,
            chunks: [],
            received: 0,
            total: 0
        };
        
        this.setStatus(`Downloading ${file.name}...`);
        
        this.app.sendMessage({
            type: 'file_download_request',
            path: file.path,
            transferId: transferId
        });
    }
    
    async handleChunk(data) {
        const transfer = this.downloadChunks[data.transferId];
        if (!transfer) return;
        
        transfer.total = data.totalChunks;
        
        // Convert base64 to array buffer
        const binaryStr = atob(data.data);
        const len = binaryStr.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            bytes[i] = binaryStr.charCodeAt(i);
        }
        
        transfer.chunks[data.chunkIndex] = bytes;
        transfer.received++;
        
        const percent = Math.round((transfer.received / transfer.total) * 100);
        this.setStatus(`Downloading ${transfer.name}: ${percent}%`);
        
        if (transfer.received === transfer.total) {
            this.finishDownload(data.transferId);
        }
    }
    
    async finishDownload(transferId) {
        const transfer = this.downloadChunks[transferId];
        this.setStatus(`Completed download of ${transfer.name}`);
        
        const blob = new Blob(transfer.chunks);
        this.fallbackDownload(blob, transfer.name);
        
        delete this.downloadChunks[transferId];
    }
    
    fallbackDownload(blob, name) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }
    
    // --- Upload handling (to phone) ---
    async uploadLocalFileFallback(file, remotePath) {
        if (!remotePath) return;
        const transferId = this.app.generateUUID();
        const targetPath = remotePath === '/' ? `/${file.name}` : `${remotePath}/${file.name}`;
        
        this.setStatus(`Preparing upload: ${file.name}`);
        
        this.app.sendMessage({
            type: 'file_upload_start',
            path: targetPath,
            transferId: transferId
        });
        
        const chunkSize = 256 * 1024;
        const totalChunks = Math.ceil(file.size / chunkSize);
        
        this.uploadQueue.push({
            id: transferId,
            file: file,
            chunkSize: chunkSize,
            totalChunks: totalChunks,
            currentIndex: 0
        });
        
        this.sendNextUploadChunk(transferId);
    }
    
    async uploadLocalFile(file, remotePath) {
        return this.uploadLocalFileFallback(file, remotePath);
    }
    
    sendNextUploadChunk(transferId) {
        const upload = this.uploadQueue.find(u => u.id === transferId);
        if (!upload) return;
        
        if (upload.currentIndex >= upload.totalChunks) return;
        
        const start = upload.currentIndex * upload.chunkSize;
        const end = Math.min(start + upload.chunkSize, upload.file.size);
        const slice = upload.file.slice(start, end);
        
        const reader = new FileReader();
        reader.onload = (e) => {
            const buffer = e.target.result;
            const bytes = new Uint8Array(buffer);
            let binary = '';
            for (let i = 0; i < bytes.byteLength; i++) {
                binary += String.fromCharCode(bytes[i]);
            }
            const base64 = btoa(binary);
            
            this.app.sendMessage({
                type: 'file_chunk',
                transferId: transferId,
                chunkIndex: upload.currentIndex,
                totalChunks: upload.totalChunks,
                data: base64
            });
            
            const percent = Math.round((upload.currentIndex / upload.totalChunks) * 100);
            this.setStatus(`Uploading ${upload.file.name}: ${percent}%`);
            
            upload.currentIndex++;
        };
        reader.readAsArrayBuffer(slice);
    }
    
    handleUploadAck(data) {
        const uploadIndex = this.uploadQueue.findIndex(u => u.id === data.transferId);
        if (uploadIndex === -1) return;
        
        const upload = this.uploadQueue[uploadIndex];
        
        if (data.success) {
            this.setStatus(`Upload complete: ${upload.file.name}`);
            this.uploadQueue.splice(uploadIndex, 1);
            this.requestRemoteList(this.remotePath);
        } else {
            this.sendNextUploadChunk(data.transferId);
        }
    }
    
    // --- Utility ---
    formatSize(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }
    
    setStatus(text) {
        document.getElementById('fm-status').innerText = text;
    }
    
    // --- Message Handlers ---
    handleDeleteResponse(data) {
        if (data.success) {
            this.setStatus('Deleted successfully');
            this.requestRemoteList(this.remotePath);
        } else {
            this.setStatus('Delete error: ' + data.error);
        }
    }
    
    handleMkdirResponse(data) {
        if (data.success) {
            this.setStatus('Folder created successfully');
            this.requestRemoteList(this.remotePath);
        } else {
            this.setStatus('Create folder error: ' + data.error);
        }
    }
}
