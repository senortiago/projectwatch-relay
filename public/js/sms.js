class SmsUI {
    constructor(app) {
        this.app = app;
        this.modal = document.getElementById('modal-sms');
        this.conversations = [];
        this.currentThread = null;
        this.currentNumber = '';
        this.currentContactName = '';
        
        if (this.modal) {
            this.bindEvents();
        }
    }
    
    bindEvents() {
        document.getElementById('btn-sms').addEventListener('click', () => this.open());
        document.getElementById('btn-sms-close').addEventListener('click', () => this.close());
        document.getElementById('btn-sms-back').addEventListener('click', () => this.showConversationList());
        document.getElementById('btn-sms-refresh').addEventListener('click', () => {
            if (this.currentThread) {
                this.openThread(this.currentThread, this.currentNumber, this.currentContactName);
            } else {
                this.requestConversations();
            }
        });
    }
    
    open() {
        this.modal.classList.remove('hidden');
        this.showConversationList();
        this.requestConversations();
    }
    
    close() {
        this.modal.classList.add('hidden');
    }
    
    requestConversations() {
        document.getElementById('sms-conv-list').innerHTML = '<div class="sms-loading">Loading conversations...</div>';
        this.app.sendMessage({ type: 'sms_conversations_request' });
    }
    
    handleConversationsResponse(data) {
        if (!data.success) {
            document.getElementById('sms-conv-list').innerHTML = `<div class="sms-loading">Error: ${data.error}</div>`;
            return;
        }
        this.conversations = data.conversations || [];
        this.renderConversations();
    }
    
    renderConversations() {
        const container = document.getElementById('sms-conv-list');
        container.innerHTML = '';
        
        if (this.conversations.length === 0) {
            container.innerHTML = '<div class="sms-loading">No messages found</div>';
            return;
        }
        
        this.conversations.forEach(conv => {
            const item = document.createElement('div');
            item.className = 'sms-conv-item';
            if (conv.unreadCount > 0) item.classList.add('unread');
            
            const date = new Date(conv.date);
            const timeStr = this.formatDate(date);
            const snippet = conv.snippet || '';
            
            item.innerHTML = `
                <div class="sms-conv-avatar">${(conv.contactName || conv.number).charAt(0).toUpperCase()}</div>
                <div class="sms-conv-content">
                    <div class="sms-conv-header">
                        <span class="sms-conv-name">${this.escapeHtml(conv.contactName || conv.number)}</span>
                        <span class="sms-conv-time">${timeStr}</span>
                    </div>
                    <div class="sms-conv-snippet">
                        ${conv.unreadCount > 0 ? `<span class="sms-unread-badge">${conv.unreadCount}</span>` : ''}
                        ${this.escapeHtml(snippet)}
                    </div>
                </div>
            `;
            
            item.addEventListener('click', () => {
                this.openThread(conv.threadId, conv.number, conv.contactName);
            });
            
            container.appendChild(item);
        });
    }
    
    openThread(threadId, number, contactName) {
        this.currentThread = threadId;
        this.currentNumber = number;
        this.currentContactName = contactName || number;
        
        document.getElementById('sms-view-conversations').classList.add('hidden');
        document.getElementById('sms-view-thread').classList.remove('hidden');
        document.getElementById('btn-sms-back').classList.remove('hidden');
        document.getElementById('sms-thread-title').innerText = this.currentContactName;
        document.getElementById('sms-thread-number').innerText = number;
        document.getElementById('sms-thread-messages').innerHTML = '<div class="sms-loading">Loading messages...</div>';
        
        this.app.sendMessage({
            type: 'sms_thread_request',
            threadId: threadId,
            limit: 100
        });
    }
    
    handleThreadResponse(data) {
        if (!data.success) {
            document.getElementById('sms-thread-messages').innerHTML = `<div class="sms-loading">Error: ${data.error}</div>`;
            return;
        }
        
        const container = document.getElementById('sms-thread-messages');
        container.innerHTML = '';
        
        // Messages come in DESC order, reverse for chronological display
        const messages = (data.messages || []).reverse();
        
        if (messages.length === 0) {
            container.innerHTML = '<div class="sms-loading">No messages in this thread</div>';
            return;
        }
        
        let lastDate = '';
        messages.forEach(msg => {
            const date = new Date(msg.date);
            const dateStr = date.toLocaleDateString();
            
            // Date separator
            if (dateStr !== lastDate) {
                lastDate = dateStr;
                const sep = document.createElement('div');
                sep.className = 'sms-date-separator';
                sep.innerText = dateStr;
                container.appendChild(sep);
            }
            
            const bubble = document.createElement('div');
            bubble.className = `sms-bubble sms-bubble-${msg.type}`;
            
            const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            
            bubble.innerHTML = `
                <div class="sms-bubble-body">${this.escapeHtml(msg.body)}</div>
                <div class="sms-bubble-time">${timeStr}</div>
            `;
            
            container.appendChild(bubble);
        });
        
        // Scroll to bottom
        container.scrollTop = container.scrollHeight;
    }
    
    showConversationList() {
        this.currentThread = null;
        document.getElementById('sms-view-conversations').classList.remove('hidden');
        document.getElementById('sms-view-thread').classList.add('hidden');
        document.getElementById('btn-sms-back').classList.add('hidden');
    }
    
    handleIncoming(msg) {
        // If the SMS modal is open, refresh
        if (!this.modal.classList.contains('hidden')) {
            if (this.currentThread) {
                // Refresh current thread
                this.openThread(this.currentThread, this.currentNumber, this.currentContactName);
            } else {
                this.requestConversations();
            }
        }
    }
    
    formatDate(date) {
        const now = new Date();
        const diff = now - date;
        const oneDay = 24 * 60 * 60 * 1000;
        
        if (diff < oneDay && date.getDate() === now.getDate()) {
            return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        } else if (diff < 7 * oneDay) {
            return date.toLocaleDateString([], { weekday: 'short' });
        } else {
            return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
        }
    }
    
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}
