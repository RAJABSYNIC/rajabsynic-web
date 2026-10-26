// ══════════════════════════════════════════════════════════════════════════════
// RAJABSYNIC AI Customer Support Chatbot Widget
// Built for RAJABSYNIC (Movies & Games)
// ══════════════════════════════════════════════════════════════════════════════

import api from './api.js';

class AIChatWidget {
    constructor() {
        this.isOpen = false;
        this.sessionId = this.getOrCreateSessionId();
        this.history = [];
        this.supportPhone = '';
        this.whatsappLink = '';
        this.isTyping = false;
        this.attachedImage = null;

        this.init();
    }

    getOrCreateSessionId() {
        let sid = sessionStorage.getItem('rajabsynic_ai_session');
        if (!sid) {
            sid = 'user_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
            sessionStorage.setItem('rajabsynic_ai_session', sid);
        }
        return sid;
    }

    init() {
        // Prevent double injection
        if (document.getElementById('ai-support-widget-container')) return;

        this.createStyles();
        this.createWidgetDOM();
        this.loadSavedHistory();
        this.bindEvents();
    }

    createStyles() {
        const style = document.createElement('style');
        style.id = 'ai-chat-styles';
        style.textContent = `
            /* AI Floating Widget Button */
            .ai-floating-btn {
                position: fixed;
                bottom: 85px; /* Safely above the 60px bottom nav */
                right: 20px;
                width: 58px;
                height: 58px;
                border-radius: 50%;
                background: linear-gradient(135deg, #00ff80 0%, #00cc66 100%);
                color: #000;
                display: flex;
                align-items: center;
                justify-content: center;
                cursor: pointer;
                box-shadow: 0 8px 24px rgba(0, 255, 128, 0.45), 0 0 0 1px rgba(0, 255, 128, 0.6);
                z-index: 295; /* Sits right above page content, below high modals */
                transition: transform 0.25s cubic-bezier(0.175, 0.885, 0.32, 1.275), box-shadow 0.25s ease;
                outline: none;
                border: none;
                user-select: none;
                -webkit-tap-highlight-color: transparent;
            }

            .ai-floating-btn:hover {
                transform: scale(1.08) translateY(-2px);
                box-shadow: 0 12px 30px rgba(0, 255, 128, 0.6), 0 0 0 2px #00ff80;
            }

            .ai-floating-btn:active {
                transform: scale(0.95);
            }

            .ai-floating-btn ion-icon {
                font-size: 1.85rem;
                color: #000;
                transition: transform 0.2s ease;
            }

            /* Online Status Pulse Badge on Button */
            .ai-btn-pulse {
                position: absolute;
                top: 2px;
                right: 2px;
                width: 13px;
                height: 13px;
                background: #00ff80;
                border: 2px solid #000;
                border-radius: 50%;
                box-shadow: 0 0 8px #00ff80;
                animation: aiPulse 2s infinite;
            }

            @keyframes aiPulse {
                0% { box-shadow: 0 0 0 0 rgba(0, 255, 128, 0.7); }
                70% { box-shadow: 0 0 0 8px rgba(0, 255, 128, 0); }
                100% { box-shadow: 0 0 0 0 rgba(0, 255, 128, 0); }
            }

            /* Tooltip Pill */
            .ai-btn-tooltip {
                position: absolute;
                right: 68px;
                background: rgba(15, 23, 17, 0.95);
                color: #fff;
                padding: 7px 12px;
                border-radius: 12px;
                border: 1px solid rgba(0, 255, 128, 0.3);
                font-size: 0.78rem;
                font-weight: 600;
                white-space: nowrap;
                box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
                pointer-events: none;
                animation: fadeInTooltip 0.4s ease;
                display: flex;
                align-items: center;
                gap: 6px;
            }

            .ai-btn-tooltip::after {
                content: '';
                position: absolute;
                right: -6px;
                top: 50%;
                transform: translateY(-50%);
                border-width: 6px 0 6px 6px;
                border-style: solid;
                border-color: transparent transparent transparent rgba(15, 23, 17, 0.95);
            }

            @keyframes fadeInTooltip {
                from { opacity: 0; transform: translateX(8px); }
                to { opacity: 1; transform: translateX(0); }
            }

            /* AI Chat Window Container */
            .ai-chat-window {
                position: fixed;
                bottom: 90px;
                right: 20px;
                width: 380px;
                max-width: calc(100vw - 32px);
                height: 560px;
                max-height: calc(100vh - 120px);
                background: radial-gradient(circle at top right, #111a14 0%, #080a0d 100%);
                border: 1px solid rgba(0, 255, 128, 0.25);
                border-radius: 20px;
                box-shadow: 0 20px 60px rgba(0, 0, 0, 0.85), 0 0 35px rgba(0, 255, 128, 0.08);
                z-index: 296;
                display: flex;
                flex-direction: column;
                overflow: hidden;
                font-family: 'Inter', -apple-system, sans-serif;
                opacity: 0;
                transform: translateY(20px) scale(0.96);
                pointer-events: none;
                transition: opacity 0.28s ease, transform 0.28s cubic-bezier(0.16, 1, 0.3, 1);
            }

            .ai-chat-window.active {
                opacity: 1;
                transform: translateY(0) scale(1);
                pointer-events: all;
            }

            /* Chat Window Header */
            .ai-chat-header {
                padding: 14px 16px;
                background: rgba(14, 20, 16, 0.92);
                border-bottom: 1px solid rgba(0, 255, 128, 0.15);
                display: flex;
                align-items: center;
                justify-content: space-between;
                backdrop-filter: blur(10px);
            }

            .ai-header-info {
                display: flex;
                align-items: center;
                gap: 10px;
            }

            .ai-avatar {
                width: 38px;
                height: 38px;
                border-radius: 50%;
                background: #0d2615;
                border: 1.5px solid #00ff80;
                display: flex;
                align-items: center;
                justify-content: center;
                position: relative;
                box-shadow: 0 0 10px rgba(0, 255, 128, 0.3);
            }

            .ai-avatar ion-icon {
                font-size: 1.3rem;
                color: #00ff80;
            }

            .ai-avatar .ai-status-dot {
                position: absolute;
                bottom: -1px;
                right: -1px;
                width: 10px;
                height: 10px;
                background: #00ff80;
                border: 2px solid #080a0d;
                border-radius: 50%;
            }

            .ai-title-wrap {
                display: flex;
                flex-direction: column;
            }

            .ai-agent-name {
                color: #fff;
                font-size: 0.92rem;
                font-weight: 700;
                letter-spacing: 0.3px;
                display: flex;
                align-items: center;
                gap: 6px;
            }

            .ai-agent-name span {
                color: #00ff80;
            }

            .ai-status-text {
                font-size: 0.72rem;
                color: #9ca3af;
                display: flex;
                align-items: center;
                gap: 4px;
            }

            .ai-status-text .green-txt {
                color: #00ff80;
                font-weight: 600;
            }

            .ai-header-actions {
                display: flex;
                align-items: center;
                gap: 6px;
            }

            .ai-icon-btn {
                background: rgba(255, 255, 255, 0.05);
                border: 1px solid rgba(255, 255, 255, 0.1);
                color: #9ca3af;
                width: 32px;
                height: 32px;
                border-radius: 8px;
                display: flex;
                align-items: center;
                justify-content: center;
                cursor: pointer;
                transition: all 0.2s;
            }

            .ai-icon-btn:hover {
                background: rgba(0, 255, 128, 0.15);
                border-color: #00ff80;
                color: #00ff80;
            }

            /* Suggested Questions Container */
            .ai-quick-questions {
                padding: 10px 14px 6px;
                background: rgba(8, 12, 9, 0.7);
                display: flex;
                gap: 8px;
                overflow-x: auto;
                scrollbar-width: none;
                border-bottom: 1px solid rgba(255, 255, 255, 0.05);
            }

            .ai-quick-questions::-webkit-scrollbar {
                display: none;
            }

            .ai-chip {
                background: rgba(0, 255, 128, 0.08);
                border: 1px solid rgba(0, 255, 128, 0.25);
                color: #d1fae5;
                font-size: 0.73rem;
                font-weight: 600;
                padding: 6px 11px;
                border-radius: 12px;
                white-space: nowrap;
                cursor: pointer;
                transition: all 0.2s ease;
                display: flex;
                align-items: center;
                gap: 5px;
            }

            .ai-chip:hover {
                background: #00ff80;
                color: #000;
                border-color: #00ff80;
                transform: translateY(-1px);
            }

            /* Messages Area */
            .ai-messages-container {
                flex: 1;
                overflow-y: auto;
                padding: 16px 14px;
                display: flex;
                flex-direction: column;
                gap: 12px;
                scroll-behavior: smooth;
            }

            .ai-messages-container::-webkit-scrollbar {
                width: 4px;
            }

            .ai-messages-container::-webkit-scrollbar-thumb {
                background: rgba(0, 255, 128, 0.2);
                border-radius: 4px;
            }

            /* Message Bubbles */
            .ai-msg {
                display: flex;
                gap: 8px;
                max-width: 86%;
                animation: aiMsgIn 0.3s ease-out;
            }

            @keyframes aiMsgIn {
                from { opacity: 0; transform: translateY(8px); }
                to { opacity: 1; transform: translateY(0); }
            }

            .ai-msg.bot {
                align-self: flex-start;
            }

            .ai-msg.user {
                align-self: flex-end;
                flex-direction: row-reverse;
            }

            .ai-msg-bubble {
                padding: 10px 14px;
                border-radius: 14px;
                font-size: 0.86rem;
                line-height: 1.45;
                word-break: break-word;
            }

            .ai-msg.bot .ai-msg-bubble {
                background: #141a17;
                color: #e5e7eb;
                border: 1px solid rgba(0, 255, 128, 0.18);
                border-left: 3px solid #00ff80;
                border-bottom-left-radius: 4px;
            }

            .ai-msg.user .ai-msg-bubble {
                background: linear-gradient(135deg, #02471f 0%, #013816 100%);
                color: #ffffff;
                border: 1px solid rgba(0, 255, 128, 0.4);
                border-bottom-right-radius: 4px;
            }

            .ai-msg-time {
                font-size: 0.65rem;
                color: #6b7280;
                margin-top: 4px;
                text-align: right;
            }

            .ai-msg.bot .ai-msg-time {
                text-align: left;
            }

            .ai-msg a {
                color: #00ff80;
                text-decoration: underline;
                font-weight: 600;
            }

            /* Typing Indicator */
            .ai-typing-indicator {
                display: flex;
                align-items: center;
                gap: 4px;
                padding: 10px 14px;
                background: #141a17;
                border: 1px solid rgba(0, 255, 128, 0.18);
                border-left: 3px solid #00ff80;
                border-radius: 14px;
                border-bottom-left-radius: 4px;
                width: fit-content;
            }

            .ai-typing-dot {
                width: 6px;
                height: 6px;
                background: #00ff80;
                border-radius: 50%;
                animation: aiBlink 1.4s infinite both;
            }

            .ai-typing-dot:nth-child(2) { animation-delay: 0.2s; }
            .ai-typing-dot:nth-child(3) { animation-delay: 0.4s; }

            @keyframes aiBlink {
                0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
                40% { opacity: 1; transform: scale(1.1); }
            }

            /* Attachment Preview */
            .ai-attachment-preview {
                display: none;
                padding: 8px 14px;
                background: #0d120f;
                border-top: 1px solid rgba(0, 255, 128, 0.15);
                align-items: center;
                gap: 10px;
            }

            .ai-attachment-preview.show {
                display: flex;
            }

            .ai-preview-thumb {
                width: 44px;
                height: 44px;
                border-radius: 6px;
                object-fit: cover;
                border: 1px solid #00ff80;
            }

            .ai-preview-info {
                flex: 1;
                font-size: 0.75rem;
                color: #9ca3af;
            }

            .ai-preview-remove {
                background: none;
                border: none;
                color: #ef4444;
                font-size: 1.1rem;
                cursor: pointer;
            }

            /* Input Area */
            .ai-chat-input-area {
                padding: 10px 14px 14px;
                background: rgba(11, 16, 13, 0.95);
                border-top: 1px solid rgba(0, 255, 128, 0.15);
                display: flex;
                align-items: center;
                gap: 8px;
            }

            .ai-input-btn {
                background: transparent;
                border: none;
                color: #9ca3af;
                font-size: 1.35rem;
                display: flex;
                align-items: center;
                justify-content: center;
                cursor: pointer;
                padding: 4px;
                transition: color 0.2s;
            }

            .ai-input-btn:hover {
                color: #00ff80;
            }

            .ai-chat-input {
                flex: 1;
                background: #141c17;
                border: 1px solid rgba(0, 255, 128, 0.2);
                border-radius: 12px;
                padding: 11px 14px;
                color: #fff;
                font-size: 0.88rem;
                outline: none;
                transition: border-color 0.2s, box-shadow 0.2s;
            }

            .ai-chat-input:focus {
                border-color: #00ff80;
                box-shadow: 0 0 10px rgba(0, 255, 128, 0.2);
            }

            .ai-chat-input::placeholder {
                color: #6b7280;
                font-size: 0.82rem;
            }

            .ai-send-btn {
                width: 40px;
                height: 40px;
                border-radius: 12px;
                background: linear-gradient(135deg, #00ff80 0%, #00cc66 100%);
                border: none;
                color: #000;
                display: flex;
                align-items: center;
                justify-content: center;
                cursor: pointer;
                transition: all 0.2s;
                flex-shrink: 0;
            }

            .ai-send-btn:hover {
                transform: scale(1.05);
                box-shadow: 0 4px 14px rgba(0, 255, 128, 0.4);
            }

            .ai-send-btn ion-icon {
                font-size: 1.25rem;
            }

            /* Responsive tweaks */
            @media (max-width: 480px) {
                .ai-chat-window {
                    right: 12px;
                    bottom: 80px;
                    width: calc(100vw - 24px);
                    height: 520px;
                }
                .ai-floating-btn {
                    right: 16px;
                    bottom: 78px;
                    width: 52px;
                    height: 52px;
                }
            }
        `;
        document.head.appendChild(style);
    }

    createWidgetDOM() {
        const container = document.createElement('div');
        container.id = 'ai-support-widget-container';
        container.innerHTML = `
            <!-- Floating Action Button -->
            <button id="ai-floating-toggle" class="ai-floating-btn" aria-label="Customer Support AI">
                <ion-icon id="ai-btn-icon" name="chatbubbles"></ion-icon>
                <div class="ai-btn-pulse"></div>
                <div id="ai-btn-tooltip" class="ai-btn-tooltip">
                    <span>Msaada wa AI</span>
                </div>
            </button>

            <!-- Chat Window Dialog -->
            <div id="ai-chat-window" class="ai-chat-window">
                <!-- Header -->
                <div class="ai-chat-header">
                    <div class="ai-header-info">
                        <div class="ai-avatar">
                            <ion-icon name="sparkles"></ion-icon>
                            <div class="ai-status-dot"></div>
                        </div>
                        <div class="ai-title-wrap">
                            <div class="ai-agent-name">RAJAB<span>SYNIC</span> AI</div>
                            <div class="ai-status-text">
                                <span class="green-txt">● Online</span> • Huduma kwa Wateja
                            </div>
                        </div>
                    </div>
                    <div class="ai-header-actions">
                        <button id="ai-btn-clear" class="ai-icon-btn" title="Anza Mazungumzo Mapya">
                            <ion-icon name="refresh-outline"></ion-icon>
                        </button>
                        <button id="ai-btn-close" class="ai-icon-btn" title="Funga">
                            <ion-icon name="close-outline"></ion-icon>
                        </button>
                    </div>
                </div>

                <!-- Suggested Quick Question Chips -->
                <div class="ai-quick-questions">
                    <div class="ai-chip" data-q="Ni michezo gani inayovuma na bei zake?">Michezo na Bei</div>
                    <div class="ai-chip" data-q="Nieleze kuhusu Maleo Bus Mods na Skins">Maleo Bus Mods</div>
                    <div class="ai-chip" data-q="Jinsi ya kufanya malipo kwa simu (M-Pesa/Tigo Pesa)?">Jinsi ya Kulipia</div>
                    <div class="ai-chip" data-q="Nimelipa lakini sijapata access ya mchezo">Sijapata Access</div>
                    <div class="ai-chip" data-q="Nimefanya malipo, ninawezaje kupakua (Download)?">Msaada wa Kupakua</div>
                    <div class="ai-chip" data-q="Ninawezaje kupata msaada zaidi?">Msaada wa Tovuti</div>
                </div>

                <!-- Messages Stream -->
                <div id="ai-messages" class="ai-messages-container"></div>

                <!-- Attachment Preview (Optional) -->
                <div id="ai-attachment-preview" class="ai-attachment-preview">
                    <img id="ai-preview-img" class="ai-preview-thumb" src="" alt="preview">
                    <div class="ai-preview-info">Picha imeambatishwa</div>
                    <button id="ai-preview-remove" class="ai-preview-remove">✕</button>
                </div>

                <!-- Input Footer -->
                <div class="ai-chat-input-area">
                    <label for="ai-file-input" class="ai-input-btn" title="Ambatisha picha ya skrini">
                        <ion-icon name="attach-outline"></ion-icon>
                    </label>
                    <input type="file" id="ai-file-input" accept="image/*" style="display:none;">
                    
                    <input type="text" id="ai-input-text" class="ai-chat-input" placeholder="Andika swali lako hapa..." autocomplete="off">
                    
                    <button id="ai-send-btn" class="ai-send-btn" title="Tuma">
                        <ion-icon name="paper-plane-outline"></ion-icon>
                    </button>
                </div>
            </div>
        `;
        document.body.appendChild(container);
    }

    bindEvents() {
        const toggleBtn = document.getElementById('ai-floating-toggle');
        const closeBtn = document.getElementById('ai-btn-close');
        const clearBtn = document.getElementById('ai-btn-clear');
        const sendBtn = document.getElementById('ai-send-btn');
        const inputField = document.getElementById('ai-input-text');
        const fileInput = document.getElementById('ai-file-input');
        const removeAttachBtn = document.getElementById('ai-preview-remove');
        const tooltip = document.getElementById('ai-btn-tooltip');

        // Toggle Open/Close
        toggleBtn.addEventListener('click', () => {
            if (tooltip) tooltip.style.display = 'none';
            this.toggleChat();
        });

        closeBtn.addEventListener('click', () => this.closeChat());

        // Clear Chat
        clearBtn.addEventListener('click', () => {
            if (confirm('Je, unataka kuanza mazungumzo mapya na kufuta kumbukumbu ya sasa?')) {
                this.history = [];
                sessionStorage.removeItem('rajabsynic_ai_history');
                const msgBox = document.getElementById('ai-messages');
                msgBox.innerHTML = '';
                this.sendWelcomeMessage();
            }
        });

        // Send on Button Click
        sendBtn.addEventListener('click', () => this.handleSendMessage());

        // Send on Enter Key
        inputField.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.handleSendMessage();
            }
        });

        // Quick Question Chips
        document.querySelectorAll('.ai-chip').forEach(chip => {
            chip.addEventListener('click', () => {
                const question = chip.getAttribute('data-q');
                if (question) {
                    inputField.value = question;
                    this.handleSendMessage();
                }
            });
        });

        // Attachment handler with client-side canvas compression
        fileInput.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (file) {
                try {
                    const compressed = await this.compressImage(file);
                    if (compressed) {
                        this.attachedImage = compressed;
                        document.getElementById('ai-preview-img').src = this.attachedImage;
                        document.getElementById('ai-attachment-preview').classList.add('show');
                    }
                } catch (err) {
                    console.error('Image compression error:', err);
                }
            }
        });

        removeAttachBtn.addEventListener('click', () => {
            this.attachedImage = null;
            document.getElementById('ai-file-input').value = '';
            document.getElementById('ai-attachment-preview').classList.remove('show');
        });

        // Hide tooltip after 8s
        setTimeout(() => {
            if (tooltip) tooltip.style.display = 'none';
        }, 8000);
    }

    toggleChat() {
        if (this.isOpen) {
            this.closeChat();
        } else {
            this.openChat();
        }
    }

    openChat() {
        const chatWin = document.getElementById('ai-chat-window');
        const icon = document.getElementById('ai-btn-icon');
        chatWin.classList.add('active');
        icon.setAttribute('name', 'close');
        this.isOpen = true;

        if (this.history.length === 0) {
            this.sendWelcomeMessage();
        }

        setTimeout(() => {
            const inputField = document.getElementById('ai-input-text');
            if (inputField) inputField.focus();
            this.scrollToBottom();
        }, 200);
    }

    closeChat() {
        const chatWin = document.getElementById('ai-chat-window');
        const icon = document.getElementById('ai-btn-icon');
        chatWin.classList.remove('active');
        icon.setAttribute('name', 'chatbubbles');
        this.isOpen = false;
    }

    sendWelcomeMessage() {
        const welcomeText = `Habari! Karibu **RAJABSYNIC**.\n\nMimi ni **rajabsynic ai agent**, msaidizi wako rasmi wa huduma kwa wateja.`;
        this.appendMessage('bot', welcomeText, false);
    }

    loadSavedHistory() {
        try {
            const saved = sessionStorage.getItem('rajabsynic_ai_history');
            if (saved) {
                this.history = JSON.parse(saved);
                if (this.history.length > 0 && this.history[0].role === 'bot' && this.history[0].text.includes('Unaweza kuniuliza kuhusu:')) {
                    this.history[0].text = `Habari! Karibu **RAJABSYNIC**.\n\nMimi ni **rajabsynic ai agent**, msaidizi wako rasmi wa huduma kwa wateja.`;
                    sessionStorage.setItem('rajabsynic_ai_history', JSON.stringify(this.history));
                }
                this.history.forEach(item => {
                    this.renderMessageBubble(item.role, item.text, item.time, false, item.image || null);
                });
            }
        } catch (_) {}
    }

    saveHistory() {
        try {
            sessionStorage.setItem('rajabsynic_ai_history', JSON.stringify(this.history.slice(-20)));
        } catch (_) {}
    }

    formatTime(date = new Date()) {
        const hours = date.getHours().toString().padStart(2, '0');
        const minutes = date.getMinutes().toString().padStart(2, '0');
        return `${hours}:${minutes}`;
    }

    formatMarkdown(text) {
        if (!text) return '';
        // Escape basic HTML
        let escaped = text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');

        // 1. Markdown Images: ![alt](url)
        escaped = escaped.replace(/!\[(.*?)\]\((https?:\/\/[^\s\)]+)\)/g, (match, alt, url) => {
            const cleanAlt = alt || 'Picha ya Msaada';
            return `__IMG_TOKEN_START__${url}__IMG_TOKEN_MID__${cleanAlt}__IMG_TOKEN_END__`;
        });

        // 2. Bold: **text**
        escaped = escaped.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');

        // 3. Regular Links: [text](url)
        escaped = escaped.replace(/\[(.*?)\]\((https?:\/\/[^\s\)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

        // 4. Naked URLs (ignoring image tokens)
        escaped = escaped.replace(/(?<!href=")(https?:\/\/[^\s<]+)/g, (match, url) => {
            if (url.includes('__IMG_TOKEN_')) return url;
            if (/\.(png|jpe?g|webp|gif)(\?.*)?$/i.test(url) || url.includes('i.ibb.co/')) {
                return `__IMG_TOKEN_START__${url}__IMG_TOKEN_MID__Picha ya Msaada__IMG_TOKEN_END__`;
            }
            return `<a href="${url}" target="_blank" rel="noopener">${url}</a>`;
        });

        // 5. Replace image tokens with styled image cards
        escaped = escaped.replace(/__IMG_TOKEN_START__(.*?)__IMG_TOKEN_MID__(.*?)__IMG_TOKEN_END__/g, (m, url, alt) => {
            return `<div class="ai-msg-image-wrap" style="margin: 10px 0;">
                <img src="${url}" alt="${alt}" loading="lazy" style="max-width: 100%; max-height: 260px; border-radius: 10px; border: 1px solid rgba(0,255,128,0.25); display: block; cursor: pointer; background: #0b0f19; box-shadow: 0 4px 14px rgba(0,0,0,0.4);" onclick="window.open(this.src, '_blank')">
                <span style="display:block; font-size:0.75rem; color:#9ca3af; margin-top:5px; font-style:italic;">${alt} (Bofya kutazama kubwa)</span>
            </div>`;
        });

        // 6. Newlines
        escaped = escaped.replace(/\n/g, '<br>');

        return escaped;
    }

    compressImage(file) {
        return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = (event) => {
                const img = new Image();
                img.onload = () => {
                    const canvas = document.createElement('canvas');
                    let width = img.width;
                    let height = img.height;
                    const maxDim = 1200;
                    if (width > maxDim || height > maxDim) {
                        if (width > height) {
                            height = Math.round((height * maxDim) / width);
                            width = maxDim;
                        } else {
                            width = Math.round((width * maxDim) / height);
                            height = maxDim;
                        }
                    }
                    canvas.width = width;
                    canvas.height = height;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0, width, height);
                    const compressed = canvas.toDataURL('image/jpeg', 0.82);
                    resolve(compressed);
                };
                img.onerror = () => resolve(event.target.result);
                img.src = event.target.result;
            };
            reader.onerror = () => resolve(null);
            reader.readAsDataURL(file);
        });
    }

    renderMessageBubble(role, text, time = null, animate = true, image = null) {
        const container = document.getElementById('ai-messages');
        if (!container) return;

        const timeStr = time || this.formatTime();
        const msgDiv = document.createElement('div');
        msgDiv.className = `ai-msg ${role}`;
        if (!animate) msgDiv.style.animation = 'none';

        const imageHtml = image ? `
            <div class="ai-msg-image-wrap" style="margin-bottom: 8px;">
                <img src="${image}" alt="Picha iliyoambatanishwa" style="max-width: 100%; max-height: 220px; border-radius: 10px; display: block; border: 1px solid rgba(255,255,255,0.15); cursor: pointer;" onclick="window.open(this.src, '_blank')">
            </div>
        ` : '';

        const textContent = text ? `<div class="ai-msg-content">${this.formatMarkdown(text)}</div>` : '';

        msgDiv.innerHTML = `
            <div class="ai-msg-bubble">
                ${imageHtml}
                ${textContent}
                <div class="ai-msg-time">${timeStr}</div>
            </div>
        `;
        container.appendChild(msgDiv);
        this.scrollToBottom();
    }

    appendMessage(role, text, shouldSave = true, image = null) {
        const time = this.formatTime();
        this.renderMessageBubble(role, text, time, true, image);
        if (shouldSave) {
            this.history.push({ role, text, time, hasImage: !!image, image: image || null });
            this.saveHistory();
        }
    }

    showTypingIndicator() {
        const container = document.getElementById('ai-messages');
        if (!container || document.getElementById('ai-typing-indicator')) return;

        const typingDiv = document.createElement('div');
        typingDiv.id = 'ai-typing-indicator';
        typingDiv.className = 'ai-typing-indicator';
        typingDiv.innerHTML = `
            <div class="ai-typing-dot"></div>
            <div class="ai-typing-dot"></div>
            <div class="ai-typing-dot"></div>
        `;
        container.appendChild(typingDiv);
        this.scrollToBottom();
    }

    hideTypingIndicator() {
        const el = document.getElementById('ai-typing-indicator');
        if (el) el.remove();
    }

    scrollToBottom() {
        const container = document.getElementById('ai-messages');
        if (container) {
            container.scrollTop = container.scrollHeight;
        }
    }

    async handleSendMessage() {
        const inputField = document.getElementById('ai-input-text');
        const text = inputField.value.trim();
        const imageToSend = this.attachedImage;
        if (!text && !imageToSend) return;

        // Display user message with thumbnail
        this.appendMessage('user', text, true, imageToSend);

        // Reset input & preview
        inputField.value = '';
        this.attachedImage = null;
        document.getElementById('ai-file-input').value = '';
        document.getElementById('ai-attachment-preview').classList.remove('show');

        // Show bot typing
        this.showTypingIndicator();
        this.isTyping = true;

        try {
            // Call API backend proxy with complete user & payment context and attached image
            let userId = '';
            let userPhone = '';
            try {
                const uStr = localStorage.getItem('user') || localStorage.getItem('rajabsynic_user') || sessionStorage.getItem('rajabsynic_user');
                if (uStr) {
                    const u = JSON.parse(uStr);
                    userId = u.id || u.uid || '';
                    userPhone = u.phone || '';
                }
                if (!userPhone) {
                    const txnPhones = JSON.parse(localStorage.getItem('txn_phones') || '{}');
                    const vals = Object.values(txnPhones);
                    if (vals.length > 0) userPhone = vals[vals.length - 1];
                }
            } catch (_) {}
            const res = await api.sendSupportChat(text, this.history, this.sessionId, userId, userPhone, imageToSend);
            this.hideTypingIndicator();
            this.isTyping = false;

            if (res && res.reply) {
                // If AI verified payment and granted access, instantly update local storage with valid expiry
                if (res.accessGranted && res.contentId) {
                    try {
                        const paid = JSON.parse(localStorage.getItem('paid_items') || '[]');
                        if (!paid.includes(res.contentId)) {
                            paid.push(res.contentId);
                            localStorage.setItem('paid_items', JSON.stringify(paid));
                        }
                        if (res.contentId.startsWith('movies-package-') || res.contentId === 'movies-access') {
                            if (!paid.includes('movies-access')) {
                                paid.push('movies-access');
                                localStorage.setItem('paid_items', JSON.stringify(paid));
                            }
                        }

                        // Save subscription expiry info into localStorage
                        if (res.expiresAt) {
                            const subscriptions = JSON.parse(localStorage.getItem('subscriptions') || '{}');
                            subscriptions[res.contentId] = {
                                expiresAt: res.expiresAt,
                                grantedAt: new Date().toISOString()
                            };
                            if (res.contentId.startsWith('movies-package-') || res.contentId === 'movies-access') {
                                subscriptions['movies-access'] = {
                                    expiresAt: res.expiresAt,
                                    packageId: res.contentId,
                                    grantedAt: new Date().toISOString()
                                };
                            }
                            localStorage.setItem('subscriptions', JSON.stringify(subscriptions));
                        }
                        console.log('✅ AI verified active access synced to local storage:', res.contentId);
                    } catch (_) {}
                } else if (res.expired && res.contentId) {
                    // Revoke local storage access if item is expired!
                    try {
                        let paid = JSON.parse(localStorage.getItem('paid_items') || '[]');
                        paid = paid.filter(id => id !== res.contentId);
                        if (res.contentId.startsWith('movies-package-') || res.contentId === 'movies-access') {
                            paid = paid.filter(id => id !== 'movies-access' && !id.startsWith('movies-package-'));
                        }
                        localStorage.setItem('paid_items', JSON.stringify(paid));

                        let subs = JSON.parse(localStorage.getItem('subscriptions') || '{}');
                        delete subs[res.contentId];
                        if (res.contentId.startsWith('movies-package-') || res.contentId === 'movies-access') {
                            delete subs['movies-access'];
                        }
                        localStorage.setItem('subscriptions', JSON.stringify(subs));
                        console.log('⚠️ Revoked expired item from local storage:', res.contentId);
                    } catch (_) {}
                }
                const botImage = (res.image && !res.reply.includes(res.image)) ? res.image : null;
                this.appendMessage('bot', res.reply, true, botImage);
            } else {
                this.appendMessage(
                    'bot',
                    `Samahani, sina taarifa hizo kwa sasa kwenye mfumo wetu wa RAJABSYNIC. Tafadhali tembelea sehemu ya "Msaada" (Help) iliyopo kwenye menyu ya chini ya tovuti yetu au wasiliana na Admin kwa msaada zaidi.`,
                    true
                );
            }
        } catch (err) {
            console.error('AI chat error:', err);
            this.hideTypingIndicator();
            this.isTyping = false;
            this.appendMessage(
                'bot',
                `Samahani, kumetokea hitilafu ya muda. Tafadhali tembelea sehemu ya "Msaada" (Help) iliyopo kwenye menyu ya chini ya tovuti yetu kwa maelekezo zaidi.`,
                true
            );
        }
    }
}

// Auto-initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        window.aiChatWidget = new AIChatWidget();
    });
} else {
    window.aiChatWidget = new AIChatWidget();
}

export default AIChatWidget;

