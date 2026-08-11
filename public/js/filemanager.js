class FileManagerUI {
    constructor(app) {
        this.app = app;
        this.modal = document.getElementById('modal-files');
        
        // Remote state
        this.remotePath = '';
        this.remoteFiles = [];
        this.remoteSelected = new Set();
        
        // Local state
        this.localDirHandle = null;
        this.localPath = '';
        this.localDirStack = [];
        this.localFiles = [];
        this.localSelected = new Set();
        
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
        
        // Remote Pane
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
        
        // Remote Upload (pick file from PC and send to phone)
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
        
        // Local Pane
        document.getElementById('fm-local-up').addEventListener('click', () => this.localUp());
        document.getElementById('fm-local-browse').addEventListener('click', () => this.pickLocalFolder());
        document.getElementById('fm-local-mkdir').addEventListener('click', () => this.localCreateFolder());
        document.getElementById('fm-local-delete').addEventListener('click', () => this.localDelete());
        
        document.getElementById('fm-local-select-all').addEventListener('change', (e) => {
            if (e.target.checked) {
                this.localFiles.forEach((_, i) => this.localSelected.add(i));
            } else {
                this.localSelected.clear();
            }
            this.renderLocalFiles();
        });
        
        // Transfers
        document.getElementById('fm-transfer-to-remote').addEventListener('click', () => this.transferToRemote());
        document.getElementById('fm-transfer-to-local').addEventListener('click', () => this.transferToLocal());
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
    
    // --- Local Pane (Left) ---
    async pickLocalFolder() {
        if (!window.showDirectoryPicker) {
            this.setStatus('Folder browsing requires HTTPS. Use the Upload button on the Remote pane to send files.');
            document.getElementById('fm-local-body').innerHTML = '<tr><td colspan="4" style="text-align:center; padding:20px;">Folder browsing requires HTTPS.<br>Use the <b>Upload File</b> button on the Remote pane to send files to your phone.</td></tr>';
            return;
        }
        try {
            this.localDirHandle = await window.showDirectoryPicker();
            this.localDirStack = [this.localDirHandle];
            this.localPath = this.localDirHandle.name;
            await this.refreshLocalFiles();
        } catch (err) {
            if (err.name !== 'AbortError') {
                console.error(err);
                this.setStatus('Error: ' + err.message);
            }
        }
    }
    
    async refreshLocalFiles() {
        if (!this.localDirHandle) return;
        
        document.getElementById('fm-local-path').innerText = this.localPath;
        document.getElementById('fm-local-body').innerHTML = '<tr><td colspan="4" style="text-align:center; padding:20px;">Loading...</td></tr>';
        
        this.localFiles = [];
        this.localSelected.clear();
        
        try {
            for await (const entry of this.localDirHandle.values()) {
                let size = 0;
                if (entry.kind === 'file') {
                    const file = await entry.getFile();
                    size = file.size;
                }
                this.localFiles.push({
                    name: entry.name,
                    isDirectory: entry.kind === 'directory',
                    handle: entry,
                    size: size
                });
            }
            
            this.localFiles.sort((a, b) => {
                if (a.isDirectory && !b.isDirectory) return -1;
                if (!a.isDirectory && b.isDirectory) return 1;
                return a.name.localeCompare(b.name);
            });
            
            this.renderLocalFiles();
        } catch (err) {
            this.setStatus('Error reading local folder: ' + err.message);
        }
    }
    
    renderLocalFiles() {
        const tbody = document.getElementById('fm-local-body');
        tbody.innerHTML = '';
        
        if (this.localFiles.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; padding:20px;">Folder is empty</td></tr>';
            return;
        }
        
        this.localFiles.forEach((file, index) => {
            const tr = document.createElement('tr');
            tr.className = 'fm-file-row';
            if (this.localSelected.has(index)) tr.classList.add('selected');
            
            const icon = file.isDirectory ? '📁' : '📄';
            const sizeStr = file.isDirectory ? '--' : this.formatSize(file.size);
            
            tr.innerHTML = `
                <td style="padding: 8px; text-align: center;"><input type="checkbox" ${this.localSelected.has(index) ? 'checked' : ''}></td>
                <td style="padding: 8px; text-align: center;">${icon}</td>
                <td style="padding: 8px; word-break: break-all;">${file.name}</td>
                <td style="padding: 8px; color: var(--text-muted);">${sizeStr}</td>
            `;
            
            tr.querySelector('input[type="checkbox"]').addEventListener('click', (e) => {
                e.stopPropagation();
                if (e.target.checked) this.localSelected.add(index);
                else this.localSelected.delete(index);
                tr.classList.toggle('selected', e.target.checked);
            });
            
            tr.addEventListener('click', () => {
                if (file.isDirectory) {
                    this.localNavigate(file.name, file.handle);
                } else {
                    const cb = tr.querySelector('input[type="checkbox"]');
                    cb.click();
                }
            });
            
            tbody.appendChild(tr);
        });
    }
    
    async localNavigate(name, handle) {
        this.localDirHandle = handle;
        this.localDirStack.push(handle);
        this.localPath += '/' + name;
        await this.refreshLocalFiles();
    }
    
    async localUp() {
        if (this.localDirStack.length > 1) {
            this.localDirStack.pop();
            this.localDirHandle = this.localDirStack[this.localDirStack.length - 1];
            
            const parts = this.localPath.split('/');
            parts.pop();
            this.localPath = parts.join('/') || this.localDirHandle.name;
            
            await this.refreshLocalFiles();
        }
    }
    
    async localCreateFolder() {
        if (!this.localDirHandle) return;
        const name = prompt('Folder name:');
        if (!name) return;
        
        try {
            await this.localDirHandle.getDirectoryHandle(name, { create: true });
            await this.refreshLocalFiles();
        } catch (err) {
            this.setStatus('Error creating folder: ' + err.message);
        }
    }
    
    async localDelete() {
        if (!this.localDirHandle || this.localSelected.size === 0) return;
        if (!confirm(`Delete ${this.localSelected.size} selected items locally?`)) return;
        
        try {
            for (let index of this.localSelected) {
                const file = this.localFiles[index];
                await this.localDirHandle.removeEntry(file.name, { recursive: file.isDirectory });
            }
            await this.refreshLocalFiles();
        } catch (err) {
            this.setStatus('Error deleting local files: ' + err.message);
        }
    }
    
    // --- Transfers ---
    async transferToRemote() {
        if (this.localSelected.size === 0) return;
        if (!this.remotePath) {
            this.setStatus('Please select a remote folder first.');
            return;
        }
        
        this.setStatus(`Starting upload to ${this.remotePath}...`);
        
        for (let index of this.localSelected) {
            const fileData = this.localFiles[index];
            if (fileData.isDirectory) {
                this.setStatus(`Cannot upload folders yet: ${fileData.name}`);
                continue;
            }
            try {
                const file = await fileData.handle.getFile();
                await this.uploadLocalFile(file, this.remotePath);
            } catch (err) {
                this.setStatus(`Upload error for ${fileData.name}: ${err.message}`);
            }
        }
        this.localSelected.clear();
        this.renderLocalFiles();
    }
    
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
        
        // If we have a local dir handle, try to write it directly, else fallback to anchor download
        if (this.localDirHandle && window.showDirectoryPicker) {
            try {
                const fileHandle = await this.localDirHandle.getFileHandle(transfer.name, { create: true });
                const writable = await fileHandle.createWritable();
                await writable.write(blob);
                await writable.close();
                await this.refreshLocalFiles();
            } catch (err) {
                this.fallbackDownload(blob, transfer.name);
            }
        } else {
            this.fallbackDownload(blob, transfer.name);
        }
        
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
