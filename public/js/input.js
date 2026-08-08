class InputManager {
    constructor() {
        this.canvas = null;
        this.app = null;
        this.isActive = false;
        
        this.isMouseDown = false;
        this.lastMoveTime = 0;
        this.moveThrottle = 1000 / 60; // Max 60 msg/sec

        this.keyHandler = this.onKeyDown.bind(this);
        this.keyPressHandler = this.onKeyPress.bind(this);
    }

    attach(canvas, app) {
        this.canvas = canvas;
        this.app = app;
        this.isActive = true;

        // Mouse events
        this.canvas.addEventListener('mousedown', this.onMouse.bind(this));
        this.canvas.addEventListener('mousemove', this.onMouse.bind(this));
        this.canvas.addEventListener('mouseup', this.onMouse.bind(this));
        this.canvas.addEventListener('mouseleave', this.onMouse.bind(this));
        this.canvas.addEventListener('wheel', this.onWheel.bind(this), { passive: false });

        // Touch events
        this.canvas.addEventListener('touchstart', this.onTouch.bind(this), { passive: false });
        this.canvas.addEventListener('touchmove', this.onTouch.bind(this), { passive: false });
        this.canvas.addEventListener('touchend', this.onTouch.bind(this), { passive: false });
        this.canvas.addEventListener('touchcancel', this.onTouch.bind(this), { passive: false });

        // Keyboard events
        window.addEventListener('keydown', this.keyHandler);
        window.addEventListener('keypress', this.keyPressHandler);
    }

    detach() {
        this.isActive = false;
        window.removeEventListener('keydown', this.keyHandler);
        window.removeEventListener('keypress', this.keyPressHandler);
    }

    getNormalizedPos(clientX, clientY) {
        const rect = this.canvas.getBoundingClientRect();
        
        // Calculate the actual drawn image area within the canvas
        // (handling object-fit: contain simulation if needed)
        // Since canvas size matches image size and css sets max-width/height,
        // we can map directly to the rect size.
        
        let x = (clientX - rect.left) / rect.width;
        let y = (clientY - rect.top) / rect.height;

        // Clamp
        x = Math.max(0, Math.min(1, x));
        y = Math.max(0, Math.min(1, y));

        return { x, y };
    }

    onMouse(e) {
        if (!this.isActive) return;
        
        const { x, y } = this.getNormalizedPos(e.clientX, e.clientY);

        if (e.type === 'mousedown') {
            this.isMouseDown = true;
            this.sendTouch('down', x, y);
        } else if (e.type === 'mouseup' || e.type === 'mouseleave') {
            if (this.isMouseDown) {
                this.isMouseDown = false;
                this.sendTouch('up', x, y);
            }
        } else if (e.type === 'mousemove') {
            if (this.isMouseDown) {
                const now = Date.now();
                if (now - this.lastMoveTime > this.moveThrottle) {
                    this.sendTouch('move', x, y);
                    this.lastMoveTime = now;
                }
            }
        }
    }

    onTouch(e) {
        if (!this.isActive) return;
        e.preventDefault(); // Prevent scrolling

        const touch = e.changedTouches[0];
        const { x, y } = this.getNormalizedPos(touch.clientX, touch.clientY);

        if (e.type === 'touchstart') {
            this.sendTouch('down', x, y);
        } else if (e.type === 'touchend' || e.type === 'touchcancel') {
            this.sendTouch('up', x, y);
        } else if (e.type === 'touchmove') {
            const now = Date.now();
            if (now - this.lastMoveTime > this.moveThrottle) {
                this.sendTouch('move', x, y);
                this.lastMoveTime = now;
            }
        }
    }

    onWheel(e) {
        if (!this.isActive) return;
        e.preventDefault();
        
        // Android scroll gesture can be simulated by touch moves,
        // or if there is a specific scroll command.
        // For simplicity, we send a command if protocol supports it.
        // If not, we could simulate a swipe.
        this.app.sendMessage({
            type: 'scroll',
            deltaX: e.deltaX,
            deltaY: e.deltaY
        });
    }

    sendTouch(action, x, y) {
        this.app.sendMessage({
            type: 'touch',
            action: action,
            x: x,
            y: y,
            pointerId: 0
        });
    }

    onKeyDown(e) {
        if (!this.isActive) return;

        // Map control keys
        const keyMap = {
            'Enter': 66,
            'Backspace': 67,
            'Tab': 61,
            'Space': 62,
            'ArrowUp': 19,
            'ArrowDown': 20,
            'ArrowLeft': 21,
            'ArrowRight': 22,
            'Escape': 'back_cmd' // special case
        };

        if (keyMap[e.code] || keyMap[e.key]) {
            e.preventDefault();
            const val = keyMap[e.code] || keyMap[e.key];
            
            if (val === 'back_cmd') {
                this.app.sendCommand('back');
            } else {
                this.app.sendMessage({
                    type: 'key',
                    keyCode: val
                });
            }
        }
    }

    onKeyPress(e) {
        if (!this.isActive) return;
        
        // Printable characters
        if (e.key.length === 1) {
            e.preventDefault();
            this.app.sendMessage({
                type: 'text_input',
                text: e.key
            });
        }
    }
}

window.inputManager = new InputManager();
