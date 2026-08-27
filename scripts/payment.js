// ============================================================
// Payment Service — PressoPay (Exclusive Gateway)
// Docs: https://PressoPay.net/api/docs
// ============================================================
class PaymentService {
    constructor() {
        this.baseUrl = window.location.origin;
        this.pollingInterval = null;
    }

    /**
     * Initiate a payment via PressoPay USSD push
     * @param {Object} paymentData - { phone, amount, description, userId, contentId, contentTitle, username }
     * @returns {Promise<Object>} - Payment initiation response with order_id
     */
    async initiatePayment(paymentData) {
        try {
            console.log('📤 Initiating payment request...', paymentData);
            
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout

            const response = await fetch(`${this.baseUrl}/api/payment/initiate`, {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                body: JSON.stringify(paymentData),
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                const errorText = await response.text();
                console.error('❌ Server response error:', response.status, errorText);
                throw new Error(`Server error: ${response.status} - ${errorText}`);
            }

            const data = await response.json();
            console.log('✅ Payment response received:', data);

            if (!data.success) {
                throw new Error(data.error || 'Ombi la malipo halikufanikiwa');
            }

            return data;
        } catch (error) {
            console.error('❌ PressoPay initiation error:', error);
            
            // Provide user-friendly error messages
            if (error.name === 'AbortError') {
                throw new Error('Muda umeisha. Tafadhali hakikisha una intaneti nzuri na jaribu tena.');
            } else if (error.message.includes('Failed to fetch')) {
                throw new Error('Tatizo la mtandao. Tafadhali hakikisha:\n1. Una connection ya internet\n2. Server inaendesha (check http://localhost:3000)\n3. Jaribu tena');
            }
            
            throw error;
        }
    }

    /**
     * Check payment status via PressoPay
     * @param {string} orderId - PressoPay order ID (ORD-...)
     * @returns {Promise<Object>} - Payment status response
     */
    async checkPaymentStatus(orderId) {
        try {
            const response = await fetch(`${this.baseUrl}/api/payment/status/${orderId}?t=${Date.now()}`, { cache: 'no-store' });
            const data = await response.json();

            if (!data.success) {
                throw new Error(data.error || 'Ukaguzi wa hali ya malipo umeshindwa');
            }

            return data;
        } catch (error) {
            console.error('PressoPay status check error:', error);
            throw error;
        }
    }

    /**
     * Poll for payment completion with improved error handling
     * @param {string} orderId - PressoPay order ID
     * @param {Function} onStatusChange - Callback for status updates
     * @param {number} maxAttempts - Maximum polling attempts (default: 240 = 20 minutes)
     * @returns {Promise<Object>} - Final payment status
     */
    async pollPaymentStatus(orderId, onStatusChange, maxAttempts = 240) {
        return new Promise((resolve, reject) => {
            console.log(`🔄 Starting real-time payment listener for order: ${orderId}`);
            
            // Timeout after 20 minutes (maxAttempts * 5000ms = 1200000ms)
            const timeoutDuration = maxAttempts * 5000;
            const timeoutTimer = setTimeout(() => {
                if (this.unsubPayment) {
                    this.unsubPayment();
                    this.unsubPayment = null;
                }
                this.stopPolling();
                const e = new Error('Muda wa kusubiri umekwisha.');
                e.reason = 'timeout';
                reject(e);
            }, timeoutDuration);

            // Active Polling Loop (Dual Verification)
            this.pollingInterval = setInterval(async () => {
                try {
                    const data = await this.checkPaymentStatus(orderId);
                    if (data && data.success && data.payment) {
                        const payment = data.payment;
                        
                        if (onStatusChange) {
                            onStatusChange(payment.status, payment);
                        }

                        if (payment.status === 'completed' || payment.status === 'success') {
                            console.log('✅ Payment completed successfully (via Active Polling)!');
                            clearTimeout(timeoutTimer);
                            this.stopPolling();
                            if (this.unsubPayment) {
                                this.unsubPayment();
                                this.unsubPayment = null;
                            }
                            resolve(payment);
                        } else if (payment.status === 'failed' || payment.status === 'cancelled') {
                            console.log('❌ Payment failed or cancelled (via Active Polling)');
                            clearTimeout(timeoutTimer);
                            this.stopPolling();
                            if (this.unsubPayment) {
                                this.unsubPayment();
                                this.unsubPayment = null;
                            }
                            const e = new Error('Malipo yameshindwa au yameghairiwa');
                            e.reason = 'failed';
                            reject(e);
                        }
                    }
                } catch (error) {
                    console.error('Polling check error (retrying...):', error.message);
                }
            }, 5000);

            // Firebase Listener (Backup/Real-time)
            try {
                if (window.api && typeof window.api.listenToPaymentStatus === 'function') {
                    this.unsubPayment = window.api.listenToPaymentStatus(orderId, (statusData) => {
                        if (!statusData.success) {
                            console.log('⚠️ Payment not found yet, waiting...');
                            return;
                        }

                        const payment = statusData.payment;
                        console.log(`📊 Payment status update (via Firebase): ${payment.status}`);

                        if (onStatusChange) {
                            onStatusChange(payment.status, payment);
                        }

                        if (payment.status === 'completed' || payment.status === 'success') {
                            console.log('✅ Payment completed successfully (via Firebase)!');
                            clearTimeout(timeoutTimer);
                            this.stopPolling();
                            if (this.unsubPayment) {
                                this.unsubPayment();
                                this.unsubPayment = null;
                            }
                            resolve(payment);
                        } else if (payment.status === 'failed' || payment.status === 'cancelled') {
                            console.log('❌ Payment failed or cancelled (via Firebase)');
                            clearTimeout(timeoutTimer);
                            this.stopPolling();
                            if (this.unsubPayment) {
                                this.unsubPayment();
                                this.unsubPayment = null;
                            }
                            const e = new Error('Malipo yameshindwa au yameghairiwa');
                            e.reason = 'failed';
                            reject(e);
                        }
                    });
                }
            } catch (err) {
                console.warn('Firebase listener failed to attach. Relying on active polling.', err.message);
            }
        });
    }

    /**
     * Stop polling for payment status
     */
    stopPolling() {
        if (this.pollingInterval) {
            clearInterval(this.pollingInterval);
            this.pollingInterval = null;
        }
    }

    /**
     * Validate Tanzanian phone number
     * @param {string} phone - Phone number to validate
     * @returns {string} - Cleaned phone number (0XXXXXXXXX format)
     */
    validatePhone(phone) {
        let cleaned = phone.replace(/[\s\-+]/g, '');

        // Convert 255XXXXXXXXX to 0XXXXXXXXX
        if (cleaned.startsWith('255')) {
            cleaned = '0' + cleaned.substring(3);
        }

        // Validate format: 0XXXXXXXXX (10 digits starting with 0)
        if (!/^0[67]\d{8}$/.test(cleaned)) {
            throw new Error('Namba ya simu si sahihi. Tumia muundo: 0712345678');
        }

        return cleaned;
    }

    /**
     * Format amount for display
     * @param {number} amount - Amount in Tanzanian Shillings
     * @returns {string} - Formatted amount (e.g., "Tsh 10,000")
     */
    formatAmount(amount) {
        return `Tsh ${amount.toLocaleString()}`;
    }
}

// Export as singleton
const paymentService = new PaymentService();
export default paymentService;
