class FileManagerUI {
    constructor(app) {
        this.app = app;
        this.modal = document.getElementById('modal-files');
        this.currentPath = '';
        this.uploadQueue = [];
        this.downloadChunks = {};
        
        if (this.modal) {
            this.bindEvents();
        }
    }
    
    bindEvents() {
        document.getElementById('btn-files').addEventListener('click', () => {
            this.modal.classList.remove('hidden');
            this.requestList('');
        });
        
        document.getElementById('btn-files-close').addEventListener('click', () => {
            this.modal.classList.add('hidden');
        });
        
        document.getElementById('btn-files-up').addEventListener('click', () => {
            if (this.currentPath && this.currentPath !== '/') {
                const parts = this.currentPath.split('/');
                parts.pop();
                const parent = parts.join('/') || '/';
                this.requestList(parent);
            }
        });
        
        document.getElementById('file-upload-input').addEventListener('change', (e) => {
            if (e.target.files.length > 0) {
                this.uploadFile(e.target.files[0]);
                e.target.value = ''; // Reset
            }
        });
    }
    
    requestList(path) {
        document.getElementById('file-list-body').innerHTML = '<tr><td colspan="4" style="text-align:center; padding:20px;">Loading...</td></tr>';
        this.app.sendMessage({
            type: 'file_list_request',
            path: path,
            transferId: this.app.generateUUID()
        });
    }
    
    handleListResponse(data) {
        if (!data.success) {
            document.getElementById('file-transfer-status').innerText = 'Error: ' + data.error;
            return;
        }
        
        this.currentPath = data.path;
        document.getElementById('files-path').innerText = this.currentPath;
        document.getElementById('file-transfer-status').innerText = '';
        
        const tbody = document.getElementById('file-list-body');
        tbody.innerHTML = '';
        
        if (data.files.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; padding:20px;">Folder is empty</td></tr>';
            return;
        }
        
        data.files.sort((a, b) => {
            if (a.isDirectory && !b.isDirectory) return -1;
            if (!a.isDirectory && b.isDirectory) return 1;
            return a.name.localeCompare(b.name);
        }).forEach(file => {
            const tr = document.createElement('tr');
            tr.style.borderBottom = '1px solid rgba(255,255,255,0.05)';
            
            const icon = file.isDirectory ? '📁' : '📄';
            const sizeStr = file.isDirectory ? '--' : this.formatSize(file.size);
            
            tr.innerHTML = `
                <td style="padding: 10px; text-align: center;">${icon}</td>
                <td style="padding: 10px; cursor: pointer; color: var(--color-primary); word-break: break-all;">${file.name}</td>
                <td style="padding: 10px; color: #888;">${sizeStr}</td>
                <td style="padding: 10px;">
                    ${!file.isDirectory ? `<button class="btn btn-outline btn-sm" data-path="${file.path}">D/L</button>` : ''}
                </td>
            `;
            
            // Name click to enter directory
            const nameCell = tr.querySelector('td:nth-child(2)');
            if (file.isDirectory) {
                nameCell.addEventListener('click', () => this.requestList(file.path));
            }
            
            // Download button
            const dlBtn = tr.querySelector('button');
            if (dlBtn) {
                dlBtn.addEventListener('click', () => this.startDownload(file));
            }
            
            tbody.appendChild(tr);
        });
    }
    
    startDownload(file) {
        const transferId = this.app.generateUUID();
        this.downloadChunks[transferId] = {
            name: file.name,
            chunks: [],
            received: 0,
            total: 0
        };
        
        document.getElementById('file-transfer-status').innerText = `Downloading ${file.name}...`;
        
        this.app.sendMessage({
            type: 'file_download_request',
            path: file.path,
            transferId: transferId
        });
    }
    
    handleChunk(data) {
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
        document.getElementById('file-transfer-status').innerText = `Downloading ${transfer.name}: ${percent}%`;
        
        if (transfer.received === transfer.total) {
            this.finishDownload(data.transferId);
        }
    }
    
    finishDownload(transferId) {
        const transfer = this.downloadChunks[transferId];
        document.getElementById('file-transfer-status').innerText = `Completed download of ${transfer.name}`;
        
        const blob = new Blob(transfer.chunks);
        const url = URL.createObjectURL(blob);
        
        const a = document.createElement('a');
        a.href = url;
        a.download = transfer.name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
        delete this.downloadChunks[transferId];
    }
    
    async uploadFile(file) {
        if (!this.currentPath) return;
        
        const transferId = this.app.generateUUID();
        const path = this.currentPath + '/' + file.name;
        
        document.getElementById('file-transfer-status').innerText = `Preparing upload: ${file.name}`;
        
        this.app.sendMessage({
            type: 'file_upload_start',
            path: path,
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
    
    sendNextUploadChunk(transferId) {
        const upload = this.uploadQueue.find(u => u.id === transferId);
        if (!upload) return;
        
        if (upload.currentIndex >= upload.totalChunks) {
            return;
        }
        
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
            document.getElementById('file-transfer-status').innerText = `Uploading ${upload.file.name}: ${percent}%`;
            
            upload.currentIndex++;
        };
        reader.readAsArrayBuffer(slice);
    }
    
    handleUploadAck(data) {
        const uploadIndex = this.uploadQueue.findIndex(u => u.id === data.transferId);
        if (uploadIndex === -1) return;
        
        const upload = this.uploadQueue[uploadIndex];
        
        if (data.success) {
            document.getElementById('file-transfer-status').innerText = `Upload complete: ${upload.file.name}`;
            this.uploadQueue.splice(uploadIndex, 1);
            this.requestList(this.currentPath); 
        } else {
            this.sendNextUploadChunk(data.transferId);
        }
    }
    
    formatSize(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }
}
