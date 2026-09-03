import api from './api.js?v=2';
import paymentService from './payment.js?v=2';

class Router {
    constructor() {
        this.routes = {
            'home': () => this.showHome(),
            'category': (id) => this.showCategory(id),
            'details': (id) => this.showDetails(id),
            'live': () => this.showLive(),
            'adult': () => this.checkAdult(),
            'account': () => this.showAccount()
        };
        this.currentRoute = 'home';
        this.cachedContent = [];
        // Stores where to redirect after login completes
        this.pendingRedirect = null; // { route, param }
    }

    navigate(route, param = null) {
        // AUTH GUARD: Restrict access ONLY for specific actions
        const user = localStorage.getItem('user');
        // 'details' is protected so guests must login before seeing any content details
        const protectedRoutes = ['live', 'adult', 'details'];

        if (!user && protectedRoutes.includes(route)) {
            // Silently save where they wanted to go, then show login
            this.pendingRedirect = { route, param };
            this.updateBottomNav('account');
            this.showAccount();
            return;
        }

        console.log(`Navigating to ${route} with param ${param}`);
        this.currentRoute = route;

        if (route === 'home') {
            document.getElementById('modal-container').innerHTML = '';
            document.getElementById('home-view').classList.remove('hidden');
        }

        if (this.routes[route]) {
            this.routes[route](param);
        }

        this.updateBottomNav(route);
    }

    updateBottomNav(route) {
        document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
        if (route === 'home') document.querySelector('.bottom-nav .nav-item:nth-child(1)').classList.add('active');
        if (route === 'live') document.querySelector('.bottom-nav .nav-item:nth-child(2)').classList.add('active');
        if (route === 'account') document.querySelector('.bottom-nav .nav-item:nth-child(3)').classList.add('active');
    }

    toggleSearch() {
        let searchUI = document.getElementById('search-ui');
        if (!searchUI) {
            const overlay = document.createElement('div');
            overlay.id = 'search-ui';
            overlay.className = 'search-overlay';
            overlay.innerHTML = `
                <div class="search-header">
                    <ion-icon name="arrow-back" class="search-close" onclick="app.router.toggleSearch()"></ion-icon>
                    <input type="text" class="search-input" placeholder="Search movies, games..." onkeyup="app.router.performSearch(this.value)" autofocus>
                </div>
                <div class="search-results" id="search-results-container">
                    <div style="text-align:center; color:#666; width:100%; margin-top:50px;">Type to search...</div>
                </div>
            `;
            document.body.appendChild(overlay);
            searchUI = overlay;
        }
        searchUI.classList.toggle('active');
        if (searchUI.classList.contains('active')) {
            setTimeout(() => searchUI.querySelector('input').focus(), 300);
        }
    }

    performSearch(query) {
        const container = document.getElementById('search-results-container');
        if (!query || query.length < 2) {
            container.innerHTML = '<div style="text-align:center; color:#666; width:100%; margin-top:50px;">Type to search...</div>';
            return;
        }
        const lowerQ = query.toLowerCase();
        const results = this.cachedContent.filter(item => {
            const cat = (item.category || '').toLowerCase();
            if (item.isAdult || cat.includes('adult') || cat.includes('18+')) return false; // Hide all adult/live-adult content
            return (item.title || '').toLowerCase().includes(lowerQ) || cat.includes(lowerQ);
        });
        if (results.length === 0) {
            container.innerHTML = '<div style="text-align:center; color:#666; width:100%; margin-top:50px;">No results found.</div>';
            return;
        }
        container.innerHTML = results.map(item => `
            <div class="media-card" onclick='window.app.router.navigate("details", "${item.id}"); window.app.router.toggleSearch();'>
                <img src="${item.image}" class="poster" loading="lazy" decoding="async" alt="${item.title}">
                <div class="media-info">
                    <div class="media-title">${item.title}</div>
                    <div class="media-cat">${item.category === 'free-games' ? 'games' : item.category.replace(/-/g, ' ')}</div>
                </div>
            </div>
        `).join('');
    }

    async ensureContent() {
        if (this.cachedContent.length === 0) {
            this.cachedContent = await api.getContent();
        }
        return this.cachedContent;
    }

    async showHome() {
        await this.ensureContent();
        this.renderSections();
    }

    renderSlider() {
        const sliderContainer = document.getElementById('hero-slider');
        let trendingPool = this.cachedContent.filter(i => i.isTrending);
        if (trendingPool.length === 0) trendingPool = this.cachedContent.slice(0, 3);

        const slides = trendingPool.slice(0, 3).map(i => ({
            title: i.title, desc: "New Release", image: i.image.replace('300x450', '800x600'), action: i.category
        }));

        // Fallback if no content at all
        if (slides.length === 0) {
            slides.push({ title: "Welcome", desc: "Enjoy our content", image: "https://placehold.co/800x600/111/fff", action: "tanzania-games" });
        }

        let slideHTML = '';
        let dotsHTML = '<div class="slider-dots">';

        slides.forEach((slide, index) => {
            const item = trendingPool[index];
            slideHTML += `
                <div class="hero-slide ${index === 0 ? 'active' : ''}" style="background-image: url('${slide.image}');" onclick="window.app.router.navigate('details', '${item.id}')">
                    <div class="slider-overlay">
                        <div class="slide-content">
                            <h2>${slide.title}</h2>
                            <p>${slide.desc}</p>
                        </div>
                    </div>
                </div>
            `;
            dotsHTML += `<div class="dot ${index === 0 ? 'active' : ''}" onclick="window.app.router.goToSlide(${index})"></div>`;
        });
        dotsHTML += '</div>';

        if (sliderContainer) {
            sliderContainer.innerHTML = slideHTML + dotsHTML;
            if (this.slideInterval) clearInterval(this.slideInterval);
            this.currentSlide = 0;
            this.slideInterval = setInterval(() => this.nextSlide(), 4000);
        }
    }

    nextSlide() { this.goToSlide(this.currentSlide + 1); }

    goToSlide(n) {
        const slides = document.querySelectorAll('.hero-slide');
        const dots = document.querySelectorAll('.dot');
        if (slides.length === 0) return;
        this.currentSlide = (n + slides.length) % slides.length;
        slides.forEach(s => s.classList.remove('active'));
        dots.forEach(d => d.classList.remove('active'));
        slides[this.currentSlide].classList.add('active');
        dots[this.currentSlide].classList.add('active');
    }

    renderSections() {
        // Trending Section -> specifically Tanzania Games
        const trendingContainer = document.getElementById('scroller-trending');
        const tanzaniaGames = this.cachedContent.filter(i => i.category === 'tanzania-games');
        tanzaniaGames.sort((a, b) => {
            const aPrice = parseFloat(a.price) || 0;
            const bPrice = parseFloat(b.price) || 0;
            const aUnder = aPrice > 0 && aPrice <= 15000;
            const bUnder = bPrice > 0 && bPrice <= 15000;
            if (aUnder && !bUnder) return -1;
            if (!aUnder && bUnder) return 1;
            return 0;
        });
        if (trendingContainer) trendingContainer.innerHTML = tanzaniaGames.map(item => this.createCard(item)).join('');

        // Games Section -> Paid Games
        const gamesContainer = document.getElementById('scroller-games');
        const gamesItems = this.cachedContent.filter(i => i.category === 'free-games' && (i.isFree !== true && i.price > 0));
        if (gamesContainer) gamesContainer.innerHTML = gamesItems.map(item => this.createCard(item)).join('');

        // Free Games Section -> specifically Free Games category
        const freeContainer = document.getElementById('scroller-free');
        const freeItems = this.cachedContent.filter(i => (i.isFree === true || !i.price || i.price == 0) && i.contentType === 'games' && i.category !== 'program-and-app');
        if (freeContainer) freeContainer.innerHTML = freeItems.map(item => this.createCard(item)).join('');

        // Maleo Bus Mod Section
        const maleoBusModContainer = document.getElementById('scroller-maleo-bus-mod');
        const maleoBusModItems = this.cachedContent.filter(i => i.category === 'maleo-bus-mod');
        if (maleoBusModContainer) maleoBusModContainer.innerHTML = maleoBusModItems.map(item => this.createCard(item)).join('');

        // Maleo Bus Skin Section
        const maleoBusSkinContainer = document.getElementById('scroller-maleo-bus-skin');
        const maleoBusSkinItems = this.cachedContent.filter(i => i.category === 'maleo-bus-skin');
        if (maleoBusSkinContainer) maleoBusSkinContainer.innerHTML = maleoBusSkinItems.map(item => this.createCard(item)).join('');

        // Maleo Map Mod Section
        const maleoMapModContainer = document.getElementById('scroller-maleo-map-mod');
        let maleoMapModItems = this.cachedContent.filter(i => i.category === 'maleo-map-mod');
        const mapKeywords = [
            ["dodoma", "gairo"],
            ["mwanza", "nzega"],
            ["handeni", "lushoto"],
            ["singida", "katesh"],
            ["mikumi"],
            ["songea", "masasi"]
        ];
        maleoMapModItems.sort((a, b) => {
            const titleA = (a.title || "").toLowerCase();
            const titleB = (b.title || "").toLowerCase();
            let idxA = mapKeywords.findIndex(kw => kw.every(k => titleA.includes(k)));
            let idxB = mapKeywords.findIndex(kw => kw.every(k => titleB.includes(k)));
            if (idxA === -1) idxA = 999;
            if (idxB === -1) idxB = 999;
            return idxA - idxB;
        });
        if (maleoMapModContainer) maleoMapModContainer.innerHTML = maleoMapModItems.map(item => this.createCard(item)).join('');

        // Movies Section
        const moviesContainer = document.getElementById('scroller-movies');
        const moviesItems = this.cachedContent.filter(i => i.contentType === 'movies' || i.category === 'movies');
        if (moviesContainer) moviesContainer.innerHTML = moviesItems.map(item => this.createCard(item)).join('');

        // Program and App Section
        const programAndAppContainer = document.getElementById('scroller-program-and-app');
        const programAndAppItems = this.cachedContent.filter(i => i.category === 'program-and-app');
        if (programAndAppContainer) programAndAppContainer.innerHTML = programAndAppItems.map(item => this.createCard(item)).join('');
    }

    createCard(item) {
        const isPaid = !item.isFree && item.price;
        const isFree = item.isFree;
        const priceLabel = isFree ? '' : (isPaid ? `Tsh ${item.price}` : '');
        const badgeHTML = isPaid
            ? `<div class="card-price-badge"><ion-icon name="lock-closed"></ion-icon> ${priceLabel}</div>`
            : (isFree ? `<div class="card-free-badge">FREE</div>` : '');

        return `
            <div class="media-card" onclick='event.preventDefault(); window.app.router.navigate("details", "${item.id}")'>
                <div style="position:relative;">
                    <img src="${item.image}" class="poster" loading="lazy" decoding="async" alt="${item.title}">
                </div>
                <div class="media-info">
                    <div class="media-title">${item.title}</div>
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-top:4px;">
                        <div class="media-cat" style="margin:0;">${item.category === 'free-games' ? 'games' : item.category.replace(/-/g, ' ')}</div>
                        ${badgeHTML}
                    </div>
                </div>
            </div>
        `;
    }

    async showCategory(catId) {
        this.currentCategoryId = catId;
        await this.ensureContent();
        let items = this.cachedContent.filter(i => i.category === catId);
        
        if (catId === 'free-games') {
            items = this.cachedContent.filter(i => i.category === 'free-games' && (i.isFree !== true && i.price > 0));
        }
        if (catId === 'free-games-all') {
            items = this.cachedContent.filter(i => (i.isFree === true || !i.price || i.price == 0) && i.contentType === 'games' && i.category !== 'program-and-app');
        }

        // Ensure "Adult" tab is ONLY visible if user enters correct pin
        if (catId === 'adult' && !this.adultAccessGranted) {
            this.navigate('adult');
            return;
        }
        if (catId === 'movies') {
            items = this.cachedContent.filter(i => i.contentType === 'movies' || i.category === 'movies');
        }

        if (catId === 'tanzania-games') {
            items.sort((a, b) => {
                const aPrice = parseFloat(a.price) || 0;
                const bPrice = parseFloat(b.price) || 0;
                const aUnder = aPrice > 0 && aPrice <= 15000;
                const bUnder = bPrice > 0 && bPrice <= 15000;
                if (aUnder && !bUnder) return -1;
                if (!aUnder && bUnder) return 1;
                return 0;
            });
        }

        if (catId === 'maleo-map-mod') {
            const mapKeywords = [
                ["dodoma", "gairo"],
                ["mwanza", "nzega"],
                ["handeni", "lushoto"],
                ["singida", "katesh"],
                ["mikumi"],
                ["songea", "masasi"]
            ];
            items.sort((a, b) => {
                const titleA = (a.title || "").toLowerCase();
                const titleB = (b.title || "").toLowerCase();
                let idxA = mapKeywords.findIndex(kw => kw.every(k => titleA.includes(k)));
                let idxB = mapKeywords.findIndex(kw => kw.every(k => titleB.includes(k)));
                if (idxA === -1) idxA = 999;
                if (idxB === -1) idxB = 999;
                return idxA - idxB;
            });
        }

        let catName = catId;
        if (catId === 'tanzania-games') catName = 'Tanzania Games';
        if (catId === 'free-games') catName = 'Games';
        if (catId === 'free-games-all') catName = 'Free Games';
        if (catId === 'maleo-bus-mod') catName = 'Maleo Bus Mod';
        if (catId === 'maleo-bus-skin') catName = 'Maleo Bus Skin';
        if (catId === 'maleo-map-mod') catName = 'Maleo Map Mod';
        if (catId === 'movies') catName = 'Movies';
        if (catId === 'program-and-app') catName = 'Program and App';
        if (catId === 'Connection') catName = 'Connection';
        if (catId === 'X-Video') catName = 'X-Video';

        const modal = `
            <div class="full-page-modal fade-in">
                <div class="back-btn" onclick="window.app.router.navigate('home')">
                    <ion-icon name="arrow-back"></ion-icon>
                </div>
                <div style="padding: 80px 20px;">
                    <h2>${catName}</h2>
                    <div class="grid" style="grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 15px; margin-top:20px;">
                        ${items.map(item => this.createCard(item)).join('')}
                    </div>
                </div>
            </div>
        `;
        document.getElementById('modal-container').innerHTML = modal;
    }

    resolveVideoUrl(url, opts = {}) {
        if (!url) return null;
        // YouTube — extract video ID from any YouTube URL format
        let videoId = null;
        if (url.includes('youtube.com/watch?v=')) {
            videoId = url.split('v=')[1]?.split('&')[0];
        } else if (url.includes('youtu.be/')) {
            videoId = url.split('youtu.be/')[1]?.split('?')[0];
        } else if (url.includes('youtube.com/embed/')) {
            videoId = url.split('embed/')[1]?.split('?')[0];
        } else if (url.includes('youtube-nocookie.com/embed/')) {
            videoId = url.split('embed/')[1]?.split('?')[0];
        }

        if (videoId) {
            // Use privacy-enhanced nocookie domain and hide all YouTube UI
            const autoplay = opts.autoplay !== false ? 1 : 0;
            return `https://www.youtube-nocookie.com/embed/${videoId}?autoplay=${autoplay}&mute=${autoplay}&controls=1&rel=0&modestbranding=1&showinfo=0&iv_load_policy=3&disablekb=0&fs=1`;
        }
        return url;
    }

    forceDownload(url, title = 'download') {
        const iframe = document.createElement('iframe');
        iframe.style.display = 'none';
        iframe.src = url;
        document.body.appendChild(iframe);
        setTimeout(() => document.body.removeChild(iframe), 15000);
    }

    async showDetails(itemId) {
        this.currentDetailsId = itemId;
        await this.ensureContent();
        const item = this.cachedContent.find(i => i.id === itemId);
        if (!item) return;

        // Pay-to-Access gate: any item not marked isFree AND has a price requires payment
        const isPaid = (item.isFree !== true && item.price > 0);

        // Check subscription status - CHECK LOCAL FIRST for instant access!
        let hasAccess = !isPaid; // Free items always have access
        if (isPaid) {
            // STEP 1: Check localStorage first (instant)
            const paidItems = JSON.parse(localStorage.getItem('paid_items') || '[]');
            const subscriptions = JSON.parse(localStorage.getItem('subscriptions') || '{}');
            
            if (paidItems.includes(item.id)) {
                console.log('✅ Local access found for', item.id);
                
                // Check if subscription hasn't expired
                if (subscriptions[item.id]) {
                    const expiryDate = new Date(subscriptions[item.id].expiresAt);
                    if (expiryDate > new Date()) {
                        hasAccess = true;
                        console.log(`✅ Subscription valid until ${expiryDate.toLocaleDateString()}`);
                    } else {
                        console.warn('⚠️  Subscription expired');
                        hasAccess = false;
                        // Remove from paid items
                        const idx = paidItems.indexOf(item.id);
                        if (idx !== -1) {
                            paidItems.splice(idx, 1);
                            localStorage.setItem('paid_items', JSON.stringify(paidItems));
                        }
                    }
                } else {
                    // No expiry info, assume valid (backward compatibility)
                    hasAccess = true;
                }
            }
            
            // STEP 2: If no local access, check server (slower)
            if (!hasAccess) {
                try {
                    const user = JSON.parse(localStorage.getItem('user') || '{}');
                    if (user.uid) {
                        console.log('🔍 Checking server for access...');
                        const sub = await api.checkSubscription(user.uid, item.id);
                        hasAccess = sub.hasAccess;
                        
                        // If server says yes but local says no, sync it
                        if (hasAccess && !paidItems.includes(item.id)) {
                            paidItems.push(item.id);
                            localStorage.setItem('paid_items', JSON.stringify(paidItems));
                            console.log('✅ Synced server access to local storage');
                        }
                    }
                } catch (e) {
                    console.error('Server check failed:', e);
                    hasAccess = false;
                }
            }
        }

        // =====================================================
        // PAYMENT-FIRST GATE: Match screenshot layout
        // =====================================================
        if (isPaid && !hasAccess) {
            const cleanDesc = item.description
                ? item.description.replace(/^\((.*)\)$/s, '$1').trim()
                : '';

            const previewGameplayUrl = this.resolveVideoUrl(item.gameplayVideoUrl);
            
            let totalPaid = 0;
            try {
                const user = JSON.parse(localStorage.getItem('user') || '{}');
                if (user.uid) {
                    const sub = await api.checkSubscription(user.uid, item.id);
                    if (!sub.hasAccess && sub.totalPaid !== undefined) {
                        totalPaid = sub.totalPaid;
                    }
                }
            } catch(e) {}

            const paymentModal = `
            <div class="full-page-modal fade-in" style="background: #0d0d0d;">
                <div class="back-btn" onclick="window.app.router.navigate('home')">
                    <ion-icon name="arrow-back" style="color:white;"></ion-icon>
                </div>

                <!-- Item Image Header -->
                <div style="width:100%; max-height:320px; overflow:hidden; position:relative;">
                    <img src="${item.image}" style="width:100%; height:100%; object-fit:cover; display:block;" loading="lazy" decoding="async" onerror="this.style.display='none'">
                    <div style="position:absolute; inset:0; background:linear-gradient(to bottom, transparent 50%, #0d0d0d 100%);"></div>
                </div>

                <div style="padding: 20px;">
                    <!-- Jina la Content -->
                    <h1 style="font-size:1.8rem; font-weight:900; color:#fff; margin-bottom:12px; line-height:1.2; text-transform:uppercase;">${item.title}</h1>
                    
                    <!-- Aina ya Content, Version na Size -->
                    <div style="margin-bottom:20px; display:flex; gap:10px; flex-wrap:wrap;">
                        <span style="background:#1f2937; color:#22c55e; padding:6px 14px; border-radius:6px; font-size:0.85rem; font-weight:700; text-transform:uppercase; letter-spacing:0.5px;">${item.category === 'free-games' ? 'MCHEZO' : (item.category || '').replace(/-/g, ' ').toUpperCase()}</span>
                        ${item.version ? `<span style="background:#1f2937; color:#60a5fa; padding:6px 14px; border-radius:6px; font-size:0.85rem; font-weight:700; text-transform:uppercase; letter-spacing:0.5px;">${item.version.toLowerCase().startsWith('v') ? item.version : 'v' + item.version}</span>` : ''}
                        ${item.size ? `<span style="background:#1f2937; color:#f472b6; padding:6px 14px; border-radius:6px; font-size:0.85rem; font-weight:700; text-transform:uppercase; letter-spacing:0.5px;">${item.size}</span>` : ''}
                    </div>

                    ${totalPaid > 0 ? `
                    <div style="background:#1f2937; border:1px solid #f59e0b; border-radius:10px; padding:12px; margin-bottom:15px; text-align:center;">
                        <div style="color:#f59e0b; font-size:0.85rem; font-weight:700; text-transform:uppercase; margin-bottom:4px;">Maendeleo ya Malipo</div>
                        <div style="color:#fff; font-size:1rem; font-weight:bold;">Umelipia Tsh ${totalPaid.toLocaleString()} kati ya ${(item.price || 0).toLocaleString()}</div>
                        <div style="color:#9ca3af; font-size:0.85rem; margin-top:4px;">Bado Tsh ${((item.price || 0) - totalPaid).toLocaleString()}</div>
                    </div>
                    ` : ''}

                    <!-- Kitufe cha Malipo -->
                    <button onclick="window.app.showPaymentInstructions('${item.id}', '${(item.title || '').replace(/'/g, '')}', ${totalPaid > 0 ? (item.price || 0) - totalPaid : (item.price || 0)}, ${item.price || 0})" 
                            style="width:100%; background:linear-gradient(135deg, #f59e0b, #d97706); border:none; border-radius:14px; padding:18px 20px; color:#000; font-weight:800; font-size:1.1rem; display:flex; align-items:center; justify-content:center; gap:12px; cursor:pointer; text-transform:uppercase; margin-bottom:15px; box-shadow:0 4px 15px rgba(245,158,11,0.3);">
                        <ion-icon name="lock-closed" style="font-size:1.4rem;"></ion-icon>
                        ${totalPaid > 0 ? `MALIZIA TSH ${((item.price || 0) - totalPaid).toLocaleString()}` : `LIPIA SASA — Tsh ${(item.price || 0).toLocaleString()}`}
                    </button>

                    <!-- Video ya Maonyesho (Gameplay Preview) - inaonekana kabla ya malipo -->
                    ${previewGameplayUrl ? `
                    <div style="margin-bottom:20px;">
                        <div style="color:#f59e0b; font-size:0.75rem; font-weight:700; text-transform:uppercase; margin-bottom:8px; letter-spacing:1px;">🎮 Maonyesho ya Content</div>
                        <div style="position:relative; padding-top:56.25%; border-radius:12px; overflow:hidden; background:#000; border:1px solid #374151;">
                            <iframe src="${previewGameplayUrl}" style="position:absolute; top:0; left:0; width:100%; height:100%; border:none;" allowfullscreen allow="autoplay; encrypted-media"></iframe>
                        </div>
                        <p style="color:#6b7280; font-size:0.78rem; text-align:center; margin-top:6px;">📌 Hii ni video ya maonyesho tu — lipia kupata download links</p>
                    </div>` : ''}

                    <!-- Maelezo -->
                    ${cleanDesc ? `
                    <div style="margin-bottom:20px;">
                        <div style="border-left:4px solid #22c55e; padding-left:12px; margin-bottom:12px;">
                            <h3 style="color:#22c55e; font-size:1.1rem; font-weight:800; margin:0;">📋 Maelezo ya Content</h3>
                        </div>
                        <div style="color:#d1d5db; line-height:1.7; font-size:0.95rem;">
                            ${cleanDesc}
                        </div>
                    </div>` : ''}

                    <!-- Kumbusho la lock -->
                    <div style="background:#1f2937; border:1px dashed #374151; border-radius:10px; padding:14px; text-align:center; margin-top:10px;">
                        <ion-icon name="lock-closed" style="font-size:2rem; color:#f59e0b; display:block; margin-bottom:8px;"></ion-icon>
                        <p style="color:#9ca3af; font-size:0.85rem; margin:0; line-height:1.6;">
                            🔒 <strong style="color:#fff;">Download links, mwongozo wa kuweka, na msaada</strong><br>
                            vitaonekana baada ya kulipa malipo.
                        </p>
                    </div>
                </div>
            </div>
            `;
            document.getElementById('modal-container').innerHTML = paymentModal;
            return; // STOP HERE - don't show download links until paid
        }


        // =====================================================
        // FULL CONTENT PAGE (shown after payment or for free items)
        // =====================================================
        let playerHTML = '';

        // 1. Detect if this is a game/downloadable item (not a stream)
        const gameCategories = ['tanzania-games', 'free-games', 'maleo-bus-mod', 'maleo-bus-skin', 'maleo-map-mod', 'program-and-app'];
        const isGameItem = item.contentType === 'games' || (!item.contentType && gameCategories.includes(item.category));

        // For games: movieLink is a download URL, NOT a stream — keep it out of the player
        const primaryStream = item.streamUrl || (!isGameItem ? item.movieLink : '') || '';

        // primaryDownload: for games use movieLink as download; for movies use downloadUrl
        const primaryDownload = item.downloadUrl || (!isGameItem ? item.movieLink : item.movieLink) || '';

        let isDrive = false;
        let driveId = null;
        if (primaryStream.includes('drive.google.com')) {
            const match = primaryStream.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
            if (match && match[1]) {
                isDrive = true;
                driveId = match[1];
            }
        }

        // 2. Build Player Logic
        const gameplayUrl = this.resolveVideoUrl(item.gameplayVideoUrl);
        const howToSetVideoUrl = this.resolveVideoUrl(item.howToSetVideo);
        const isLive = item.contentType === 'live';

        if (isLive) {
            const streamUrl = item.streamUrl || item.movieLink || '';
            const ytUrl = this.resolveVideoUrl(streamUrl);

            if (ytUrl && ytUrl.includes('youtube.com/embed/')) {
                playerHTML = `<iframe src="${ytUrl}" style="width:100%; height:100%; border:none;" allowfullscreen allow="autoplay; encrypted-media"></iframe>`;
            } else {
                playerHTML = `<video id="live-player" controls autoplay style="width:100%; height:100%; background:#000;" playsinline></video>`;
                setTimeout(() => this.initLivePlayer(streamUrl), 100);
            }
        } else if (!isGameItem && gameplayUrl) {
            // Only show gameplay as main player for non-game content (movies/adult)
            playerHTML = `
                <iframe src="${gameplayUrl}" style="width:100%; height:100%; border:none;" allowfullscreen allow="autoplay; encrypted-media"></iframe>
            `;
        } else if (!isGameItem && isDrive && driveId) {
            playerHTML = `
                <div style="position:relative; width:100%; height:100%;">
                    <iframe src="https://drive.google.com/file/d/${driveId}/preview" style="width:100%; height:100%; border:none;" allowfullscreen></iframe>
                    <div style="position:absolute; top:0; left:0; right:0; height:60px; background:#111; z-index:99; display:flex; align-items:center; padding-left:15px; color:#fff; font-weight:bold; font-size:1.1rem; pointer-events:auto;">
                        Video Player
                    </div>
                </div>
            `;
        } else if (!isGameItem && primaryStream) {
            const isDirect = primaryStream.match(/\.(mp4|webm|ogg)$/i);
            if (isDirect) {
                playerHTML = `
                    <video controls autoplay style="width:100%; height:100%; background:#000;">
                        <source src="${primaryStream}" type="video/mp4">
                    </video>
                `;
            } else {
                playerHTML = `<iframe src="${primaryStream}" style="width:100%; height:100%; border:none;" allowfullscreen></iframe>`;
            }
        } else if (!isGameItem) {
            playerHTML = `
                <div style="width:100%; height:100%; display:flex; align-items:center; justify-content:center; flex-direction:column; color:#666;">
                    <ion-icon name="videocam-off" style="font-size:3rem;"></ion-icon>
                    <p>No Video Source</p>
                </div>
            `;
        }
        // For game items: playerHTML stays empty → thumbnail shows at top, videos go in bottom info section


        // 3. Construct Actions HTML
        let actionsHTML = '';



        if (primaryDownload && !isGameItem) {
            // For movies/adult: show primary download button
            let finalDownload = primaryDownload;
            const isDriveDL = finalDownload.includes('drive.google.com');
            if (isDriveDL && !finalDownload.includes('export=download')) {
                const match = finalDownload.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
                if (match && match[1]) finalDownload = `https://drive.google.com/uc?export=download&id=${match[1]}`;
            }
            actionsHTML += `
                <a href="javascript:void(0)" onclick="window.app.forceDownload('${finalDownload}', '${item.title}')" class="btn btn-primary" style="width:100%; text-decoration:none; display:flex; align-items:center; justify-content:center; gap:8px; margin-bottom:10px;">
                    <ion-icon name="cloud-download"></ion-icon> Download Now
                </a>
            `;
        }

        // Build download links list
        const links = item.downloadLinks && item.downloadLinks.length > 0
            ? item.downloadLinks
            : (item.movieLink ? [{ name: 'Download Link', url: item.movieLink }] : []);

        if (links.length > 0) {
            links.forEach((link, index) => {
                const url = typeof link === 'object' ? link.url : link;
                if (!url) return;
                // Skip if same as movie/stream URL (only for non-game content)
                if (!isGameItem && (url === primaryDownload || url === primaryStream)) return;

                const isDriveMirror = url.includes('drive.google.com');
                const defaultName = isDriveMirror ? `Download Mirror ${index + 1}` : (isGameItem ? `Download Link ${index + 1}` : `Mirror Link ${index + 1}`);
                const name = (typeof link === 'object' && link.name) ? link.name : defaultName;

                let finalLink = url;
                if (isDriveMirror && !url.includes('export=download')) {
                    const match = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
                    if (match && match[1]) finalLink = `https://drive.google.com/uc?export=download&id=${match[1]}`;
                }

                actionsHTML += `
                    <a href="${finalLink}" target="_blank" rel="noopener" class="btn btn-primary" style="width:100%; text-decoration:none; display:flex; align-items:center; justify-content:center; gap:8px; margin-bottom:10px; background: linear-gradient(135deg,#16a34a,#15803d);">
                         <ion-icon name="cloud-download-outline"></ion-icon> ${name}
                    </a>
                `;
            });
        }



        const cleanDesc = item.description
            ? item.description.replace(/^\((.*)\)$/s, '$1').trim()
            : '';

        // Thumbnail shown as header when no video
        const headerMedia = (!playerHTML.includes('iframe') && !playerHTML.includes('video') || playerHTML.includes('No Video Source'))
            ? `<div style="width:100%; max-height:320px; overflow:hidden; position:relative;">
                <img src="${item.image}" style="width:100%; height:100%; object-fit:cover; display:block;" loading="lazy" decoding="async" onerror="this.style.display='none'">
                <div style="position:absolute; inset:0; background:linear-gradient(to bottom, transparent 50%, #000 100%);"></div>
              </div>`
            : `<div class="video-container" style="position: sticky; top: 0; z-index: 10; background: #000;">
                    <div style="width:100%; aspect-ratio:16/9; background:#111;">
                        ${playerHTML}
                    </div>
               </div>`;

        const modal = `
            <div class="full-page-modal fade-in" style="background: #0d0d0d;">
                <div class="back-btn" onclick="window.app.router.navigate('home')">
                    <ion-icon name="arrow-back" style="color:white;"></ion-icon>
                </div>

                ${headerMedia}

                <div style="padding:20px 20px 40px;">

                    <!-- Jina la Content -->
                    <h1 style="font-size:1.7rem; font-weight:900; color:#fff; margin:0 0 10px; line-height:1.2; text-transform:uppercase; letter-spacing:-0.5px;">${item.title}</h1>
                    <div style="margin-bottom:20px; display:flex; gap:10px; flex-wrap:wrap;">
                        <span style="background:#1f2937; color:#6b7280; padding:5px 12px; border-radius:5px; font-size:0.78rem; font-weight:700; text-transform:uppercase; letter-spacing:1px;">${item.category === 'free-games' ? 'MCHEZO' : (item.category || '').replace(/-/g, ' ').toUpperCase()}</span>
                        ${item.version ? `<span style="background:#1f2937; color:#60a5fa; padding:5px 12px; border-radius:5px; font-size:0.78rem; font-weight:700; text-transform:uppercase; letter-spacing:1px;">${item.version.toLowerCase().startsWith('v') ? item.version : 'v' + item.version}</span>` : ''}
                        ${item.size ? `<span style="background:#1f2937; color:#f472b6; padding:5px 12px; border-radius:5px; font-size:0.78rem; font-weight:700; text-transform:uppercase; letter-spacing:1px;">${item.size}</span>` : ''}
                    </div>



                    <!-- Vitufe vya Download -->
                    ${isLive ? `
                        <div style="background:#111827; padding:15px; border-radius:10px; border:1px solid #1f2937; margin-bottom:16px;">
                            <p style="color:#6b7280; font-size:0.7rem; font-weight:700; text-transform:uppercase; letter-spacing:1.5px; margin:0 0 6px;">MATANGAZO YA MOJA KWA MOJA</p>
                            <p style="font-size:0.85rem; color:#9ca3af; margin:0;">Hakuna upakuaji — tazama moja kwa moja.</p>
                        </div>
                    ` : `<div style="margin-bottom:16px;">
                        <p style="color:#6b7280; font-size:0.7rem; font-weight:700; text-transform:uppercase; letter-spacing:1.5px; margin:0 0 10px;">VIUNGO VYA KUPAKUA</p>
                        ${actionsHTML}
                    </div>`}

                    <!-- Muda wa Matumizi -->
                    ${(item.duration && item.price && parseFloat(item.price) > 0) ? `
                    <div style="height:1px; background:#1f2937; margin:20px 0;"></div>
                    <div style="display:flex; align-items:center; gap:14px; padding:14px 0;">
                        <div style="width:40px; height:40px; background:#1f2937; border-radius:8px; display:flex; align-items:center; justify-content:center; flex-shrink:0;">
                            <ion-icon name="time-outline" style="font-size:1.3rem; color:#f59e0b;"></ion-icon>
                        </div>
                        <div>
                            <p style="color:#6b7280; font-size:0.7rem; font-weight:700; text-transform:uppercase; letter-spacing:1.5px; margin:0 0 3px;">MUDA WA MATUMIZI</p>
                            <p style="color:#fff; font-weight:700; font-size:1rem; margin:0;">${item.duration}</p>
                        </div>
                    </div>` : ''}

                    <!-- Jinsi ya Kuweka (Maandishi) -->
                    <div style="height:1px; background:#1f2937; margin:20px 0;"></div>
                    <p style="color:#6b7280; font-size:0.7rem; font-weight:700; text-transform:uppercase; letter-spacing:1.5px; margin:0 0 14px;">JINSI YA KUWEKA</p>

                    ${(item.howToSetText || item.howToSet) ? `
                    <div style="background:#111827; border-left:3px solid #22c55e; border-radius:0 8px 8px 0; padding:14px 16px; margin-bottom:14px;">
                        <div style="color:#d1d5db; line-height:1.8; font-size:0.9rem; margin:0; white-space:pre-wrap; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; transition: all 0.3s ease;">${item.howToSetText || item.howToSet}</div>
                        <button onclick="
                            var content = this.previousElementSibling;
                            if (content.style.webkitLineClamp === '2' || content.style.webkitLineClamp === '') {
                                content.style.webkitLineClamp = 'unset';
                                this.innerHTML = 'Ficha maelezo <ion-icon name=\\'chevron-up-outline\\'></ion-icon>';
                            } else {
                                content.style.webkitLineClamp = '2';
                                this.innerHTML = 'Tizama zaidi <ion-icon name=\\'chevron-down-outline\\'></ion-icon>';
                            }
                        " style="background:transparent; border:none; color:#22c55e; font-size:0.85rem; font-weight:600; padding:8px 0 0 0; margin:0; cursor:pointer; display:flex; align-items:center; gap:4px; outline:none; transition: color 0.2s;">Tizama zaidi <ion-icon name="chevron-down-outline"></ion-icon></button>
                    </div>` : ''}



                    <!-- Video ya Mwongozo (How to Set) -->
                    ${(howToSetVideoUrl || item.howToSetVideo) ? `
                    <div style="height:1px; background:#1f2937; margin:20px 0;"></div>
                    <p style="color:#6b7280; font-size:0.7rem; font-weight:700; text-transform:uppercase; letter-spacing:1.5px; margin:0 0 12px;">VIDEO YA MWONGOZO WA KUWEKA</p>
                    <div style="position:relative; padding-top:56.25%; border-radius:10px; overflow:hidden; background:#000; cursor:pointer; border: 1px solid #374151;" 
                         onclick="this.innerHTML='<iframe src=\\'${howToSetVideoUrl || this.resolveVideoUrl(item.howToSetVideo)}\\' style=\\'position:absolute; top:0; left:0; width:100%; height:100%; border:none;\\' allowfullscreen allow=\\'autoplay; encrypted-media; picture-in-picture\\' referrerpolicy=\\'origin\\'></iframe>'">
                        ${item.howToSetThumbnail ? `
                            <img src="${item.howToSetThumbnail}" loading="lazy" decoding="async" style="position:absolute; top:0; left:0; width:100%; height:100%; object-fit:cover;">
                        ` : `
                            <div style="position:absolute; top:0; left:0; width:100%; height:100%; display:flex; align-items:center; justify-content:center; background:#111827;">
                                <ion-icon name="videocam-outline" style="font-size: 3rem; color: #4b5563;"></ion-icon>
                            </div>
                        `}
                        <div style="position:absolute; top:50%; left:50%; transform:translate(-50%, -50%); width:64px; height:64px; background:rgba(220, 38, 38, 0.9); border-radius:50%; display:flex; align-items:center; justify-content:center; box-shadow:0 4px 15px rgba(220,38,38,0.4);">
                            <ion-icon name="play" style="color:white; font-size:2.2rem; margin-left:6px;"></ion-icon>
                        </div>
                    </div>` : ''}

                    <!-- WhatsApp Button -->
                    ${item.whatsapp ? `
                    <div style="height:1px; background:#1f2937; margin:20px 0;"></div>
                    <div style="margin-top:20px;">
                        <p style="color:#9ca3af; font-size:0.8rem; font-weight:700; text-transform:uppercase; letter-spacing:1px; margin-bottom:10px;">MSAADA</p>
                        <a href="https://wa.me/${item.whatsapp.replace(/[^0-9]/g, '')}" target="_blank" class="btn" style="width:100%; background:#25D366; color:white; text-decoration:none; display:flex; align-items:center; justify-content:center; gap:8px; margin-bottom:10px;">
                             <ion-icon name="logo-whatsapp"></ion-icon> WhatsApp
                        </a>
                    </div>` : ''}

                </div>
            </div>
        `;
        document.getElementById('modal-container').innerHTML = modal;

        // Initialize Stable Live Player if applicable
        if (item.contentType === 'live') {
            const streamUrl = item.movieLink || '';
            const isYT = streamUrl.includes('youtube.com') || streamUrl.includes('youtu.be');
            if (!isYT) {
                this.initLivePlayer(streamUrl);
            }
        }
    }

    initLivePlayer(url) {
        const video = document.getElementById('live-player');
        if (!video) return;

        console.log("Initializing Stable Live Player:", url);

        if (window.Hls && Hls.isSupported() && url.includes('.m3u8')) {
            const hls = new Hls({
                enableWorker: true,
                lowLatencyMode: true,
                manifestLoadingMaxRetry: Infinity,
                levelLoadingMaxRetry: 10,
                fragLoadingMaxRetry: 10
            });

            hls.loadSource(url);
            hls.attachMedia(video);

            hls.on(Hls.Events.MANIFEST_PARSED, () => {
                video.play().catch(e => console.log("Autoplay blocked:", e));
            });

            // AUTO RECOVERY LOGIC (Auto-Reload/Retry)
            hls.on(Hls.Events.ERROR, (event, data) => {
                if (data.fatal) {
                    switch (data.type) {
                        case Hls.ErrorTypes.NETWORK_ERROR:
                            console.log("Network error, retrying load...");
                            hls.startLoad();
                            break;
                        case Hls.ErrorTypes.MEDIA_ERROR:
                            console.log("Media error, recovering...");
                            hls.recoverMediaError();
                            break;
                        default:
                            console.log("Unrecoverable error, re-initializing...");
                            hls.destroy();
                            this.initLivePlayer(url);
                            break;
                    }
                }
            });

            this.currentHls = hls;
        } else {
            // Fallback for Safari/iOS or non-HLS streams
            video.src = url;
            video.addEventListener('error', () => {
                console.log("Stream error, retrying in 3s...");
                setTimeout(() => { video.src = url; video.load(); }, 3000);
            }, { once: true });
        }
    }

    checkAdult() {
        const warning = `
            <div class="age-gate fade-in">
                <div class="gate-content">
                    <ion-icon name="warning" style="font-size: 3rem; color: var(--accent-color);"></ion-icon>
                    <h2>Age Restriction</h2>
                    <p style="margin: 10px 0; color: #ccc;">This section contains content restricted to adults (18+).</p>
                    <div class="gate-btns">
                        <button class="btn btn-secondary" onclick="window.app.router.navigate('home')">Exit</button>
                        <button class="btn btn-primary" onclick="window.app.enterAdult()">I am 18+</button>
                    </div>
                </div>
            </div>
        `;
        document.getElementById('modal-container').innerHTML = warning;
    }

    async enterAdult() {
        // Check if user is logged in
        const user = JSON.parse(localStorage.getItem('user') || '{}');
        if (!user.uid) {
            // Silently redirect to login, then come back to adult
            this.pendingRedirect = { route: 'adult', param: null };
            this.showAccount();
            return;
        }

        // === CHECK ADULT SECTION SUBSCRIPTION (instant local check first!) ===
        let hasAdultAccess = false;
        
        // STEP 1: Check localStorage first (instant)
        const paidItems = JSON.parse(localStorage.getItem('paid_items') || '[]');
        const subscriptions = JSON.parse(localStorage.getItem('subscriptions') || '{}');
        
        if (paidItems.includes('adult-section-access')) {
            // Check if subscription hasn't expired
            if (subscriptions['adult-section-access']) {
                const expiryDate = new Date(subscriptions['adult-section-access'].expiresAt);
                if (expiryDate > new Date()) {
                    hasAdultAccess = true;
                    console.log(`✅ Adult access valid until ${expiryDate.toLocaleDateString()}`);
                } else {
                    console.warn('⚠️  Adult subscription expired');
                    // Remove expired access
                    const idx = paidItems.indexOf('adult-section-access');
                    if (idx !== -1) {
                        paidItems.splice(idx, 1);
                        localStorage.setItem('paid_items', JSON.stringify(paidItems));
                    }
                }
            } else {
                // No expiry info, assume valid (backward compatibility)
                hasAdultAccess = true;
            }
        }
        
        let totalPaid = 0;
        // STEP 2: If no local access, check server
        if (!hasAdultAccess) {
            try {
                const sub = await api.checkSubscription(user.uid, 'adult-section-access');
                hasAdultAccess = sub.hasAccess;
                if (!hasAdultAccess && sub.totalPaid !== undefined) {
                    totalPaid = sub.totalPaid;
                }
                
                // Sync server access to local
                if (hasAdultAccess && !paidItems.includes('adult-section-access')) {
                    paidItems.push('adult-section-access');
                    localStorage.setItem('paid_items', JSON.stringify(paidItems));
                    console.log('✅ Synced server access to local storage');
                }
            } catch (e) {
                console.error('Server check failed:', e);
            }
        }

        if (!hasAdultAccess) {
            // === SHOW SUBSCRIPTION PAYMENT GATE ===
            const settings = await api.getSettings();
            const ADULT_PRICE = settings?.adultSubscription?.price || 5000;
            const ADULT_DURATION = settings?.adultSubscription?.durationDays || 5;
            const ADULT_DESCRIPTION = settings?.adultSubscription?.description || '';

            document.getElementById('modal-container').innerHTML = `
                <div class="full-page-modal fade-in" style="background: #0d0d0d;">
                    <div class="back-btn" onclick="window.app.router.navigate('home')">
                        <ion-icon name="arrow-back" style="color:white;"></ion-icon>
                    </div>

                    <!-- Header Banner -->
                    <div style="width:100%; background:linear-gradient(135deg,#7c2d12,#1a0000); padding:50px 20px 30px; text-align:center; position:relative; overflow:hidden;">
                        <div style="position:absolute; inset:0; background:radial-gradient(circle at 50% 50%, rgba(239,68,68,0.15), transparent 70%);"></div>
                        <div style="font-size:3.5rem; margin-bottom:10px;">🔞</div>
                        <h1 style="color:#fff; font-size:1.8rem; font-weight:900; margin:0 0 8px; text-transform:uppercase; letter-spacing:1px;">18+ Premium</h1>
                        <p style="color:#f87171; font-size:0.9rem; margin:0; font-weight:600;">Upatikanaji wa Siku ${ADULT_DURATION} — Video Zote</p>
                    </div>

                    <div style="padding:24px 20px 60px;">

                        <!-- Admin Description (if set) -->
                        ${ADULT_DESCRIPTION ? `
                        <div style="background:#1a0a00; border:1px solid #7c2d12; border-radius:14px; padding:16px 18px; margin-bottom:20px; display:flex; gap:12px; align-items:flex-start;">
                            <ion-icon name="information-circle" style="font-size:1.5rem; color:#f87171; flex-shrink:0; margin-top:2px;"></ion-icon>
                            <p style="color:#fca5a5; font-size:0.92rem; margin:0; line-height:1.6;">${ADULT_DESCRIPTION}</p>
                        </div>` : ''}



                        <!-- Bei & Kitufe cha Malipo -->
                        <div style="text-align:center; margin-bottom:24px;">
                            <p style="color:#6b7280; font-size:0.8rem; margin:0 0 4px;">Bei ya Subscription</p>
                            <p style="color:#fff; font-size:2.5rem; font-weight:900; margin:0 0 20px;">Tsh ${ADULT_PRICE.toLocaleString()} <span style="font-size:1rem; color:#9ca3af; font-weight:400;">/ Siku ${ADULT_DURATION}</span></p>
                            
                            ${totalPaid > 0 ? `
                            <div style="background:#1f2937; border:1px solid #f59e0b; border-radius:10px; padding:12px; margin-bottom:15px; text-align:center;">
                                <div style="color:#f59e0b; font-size:0.85rem; font-weight:700; text-transform:uppercase; margin-bottom:4px;">Maendeleo ya Malipo</div>
                                <div style="color:#fff; font-size:1rem; font-weight:bold;">Umelipia Tsh ${totalPaid.toLocaleString()} kati ya ${ADULT_PRICE.toLocaleString()}</div>
                                <div style="color:#9ca3af; font-size:0.85rem; margin-top:4px;">Bado Tsh ${(ADULT_PRICE - totalPaid).toLocaleString()}</div>
                            </div>
                            ` : ''}

                            <button onclick="window.app.openPaymentModal('adult-section-access', '18+ Premium Access (Siku ${ADULT_DURATION})', ${totalPaid > 0 ? ADULT_PRICE - totalPaid : ADULT_PRICE}, ${ADULT_PRICE})"
                                style="width:100%; background:linear-gradient(135deg,#dc2626,#991b1b); border:none; border-radius:14px; padding:18px 20px; color:#fff; font-weight:800; font-size:1.1rem; display:flex; align-items:center; justify-content:center; gap:12px; cursor:pointer; text-transform:uppercase; box-shadow:0 4px 20px rgba(220,38,38,0.35); margin-bottom:15px;">
                                <ion-icon name="lock-open" style="font-size:1.4rem;"></ion-icon>
                                ${totalPaid > 0 ? `MALIZIA TSH ${(ADULT_PRICE - totalPaid).toLocaleString()}` : 'LIPIA SASA — FUNGUA SEHEMU HII'}
                            </button>
                        </div>


                    </div>
                </div>
            `;
            return;
        }

        // === USER HAS ACCESS — SHOW ALL ADULT CONTENT ===
        await this.ensureContent();
        const items = this.cachedContent.filter(i => i.isAdult);

        const connectionItems = items.filter(i => i.category === 'Connection' || i.category === 'video-connection');
        const xVideoItems = items.filter(i => i.category === 'X-Video' || i.category === 'x-video');
        const otherItems = items.filter(i => !connectionItems.includes(i) && !xVideoItems.includes(i));

        let sectionsHTML = '';

        if (connectionItems.length > 0) {
            sectionsHTML += `
                <h3 style="margin: 20px 0 10px; color: var(--accent-color);">Connection</h3>
                <div class="grid" style="grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 15px; margin-bottom: 30px;">
                    ${connectionItems.map(item => this.createCard(item)).join('')}
                </div>
            `;
        }

        if (xVideoItems.length > 0) {
            sectionsHTML += `
                <h3 style="margin: 20px 0 10px; color: var(--accent-color);">X-Video</h3>
                <div class="grid" style="grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 15px; margin-bottom: 30px;">
                    ${xVideoItems.map(item => this.createCard(item)).join('')}
                </div>
            `;
        }

        if (otherItems.length > 0) {
            sectionsHTML += `
                <h3 style="margin: 20px 0 10px; color: var(--accent-color);">Other</h3>
                <div class="grid" style="grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 15px; margin-bottom: 30px;">
                    ${otherItems.map(item => this.createCard(item)).join('')}
                </div>
            `;
        }

        if (items.length === 0) {
            sectionsHTML = '<p style="text-align:center; color:#666; margin-top:50px;">No content available yet.</p>';
        }

        document.getElementById('modal-container').innerHTML = `
            <div class="full-page-modal fade-in">
                <div class="back-btn" onclick="window.app.router.navigate('home')">
                    <ion-icon name="arrow-back"></ion-icon>
                </div>
                <div style="padding: 80px 20px;">
                    <h2 style="color: var(--accent-color)">18+ Content</h2>
                    <p style="color:#aaa; margin-bottom:20px;">Discretion is advised.</p>
                    ${sectionsHTML}
                </div>
            </div>
        `;
    }

    async showLive() {
        await this.ensureContent();
        const items = this.cachedContent.filter(i => i.contentType === 'live');

        // Check Live TV subscription settings
        const settings = await api.getSettings();
        const liveSub = settings?.liveSubscription;
        const liveSubEnabled = liveSub?.enabled === true;

        // If subscription is enabled, check if user has paid (instant local check first!)
        let userHasLiveAccess = !liveSubEnabled; // free if not enabled
        if (liveSubEnabled) {
            // STEP 1: Check localStorage first (instant)
            const paidItems = JSON.parse(localStorage.getItem('paid_items') || '[]');
            const subscriptions = JSON.parse(localStorage.getItem('subscriptions') || '{}');
            
            if (paidItems.includes('live-tv-access')) {
                // Check if subscription hasn't expired
                if (subscriptions['live-tv-access']) {
                    const expiryDate = new Date(subscriptions['live-tv-access'].expiresAt);
                    if (expiryDate > new Date()) {
                        userHasLiveAccess = true;
                        console.log(`✅ Live TV access valid until ${expiryDate.toLocaleDateString()}`);
                    } else {
                        console.warn('⚠️  Live TV subscription expired');
                        // Remove expired access
                        const idx = paidItems.indexOf('live-tv-access');
                        if (idx !== -1) {
                            paidItems.splice(idx, 1);
                            localStorage.setItem('paid_items', JSON.stringify(paidItems));
                        }
                    }
                } else {
                    // No expiry info, assume valid (backward compatibility)
                    userHasLiveAccess = true;
                }
            }
            
            let totalPaid = 0;
            // STEP 2: If no local access, check server
            if (!userHasLiveAccess) {
                try {
                    const user = JSON.parse(localStorage.getItem('user') || '{}');
                    if (user.uid) {
                        const sub = await api.checkSubscription(user.uid, 'live-tv-access');
                        userHasLiveAccess = sub.hasAccess;
                        if (!userHasLiveAccess && sub.totalPaid !== undefined) {
                            totalPaid = sub.totalPaid;
                        }
                        
                        // Sync server access to local
                        if (userHasLiveAccess && !paidItems.includes('live-tv-access')) {
                            paidItems.push('live-tv-access');
                            localStorage.setItem('paid_items', JSON.stringify(paidItems));
                            console.log('✅ Synced server access to local storage');
                        }
                        
                        // Also check individual channel access (grant-all fallback)
                        if (!userHasLiveAccess && items.length > 0) {
                            const firstCheck = await api.checkSubscription(user.uid, items[0].id);
                            userHasLiveAccess = firstCheck.hasAccess;
                        }
                    }
                } catch (e) {
                    console.error('Server check failed:', e);
                    userHasLiveAccess = false;
                }
            }
        }

        const livePrice = liveSub?.price || 5000;
        const payGateHTML = !userHasLiveAccess && liveSubEnabled ? `
            <div style="text-align:center; padding:40px 20px; background:rgba(99,102,241,0.1); border:1px solid rgba(99,102,241,0.3); border-radius:16px; margin:20px 0;">
                <ion-icon name="tv-outline" style="font-size:3.5rem; color:#6366f1; display:block; margin:0 auto 15px;"></ion-icon>
                <h3 style="color:#fff; margin-bottom:8px;">Live TV Subscription</h3>
                <p style="color:#9ca3af; margin-bottom:15px; font-size:0.9rem;">${liveSub?.description || 'Lipia mpango wa Live TV ili ufurahie channels zote.'}</p>
                <div style="background:rgba(99,102,241,0.2); border-radius:12px; padding:15px; margin-bottom:20px; display:inline-block;">
                    <div style="font-size:1.8rem; font-weight:800; color:#6366f1;">${livePrice.toLocaleString()} Tsh</div>
                    <div style="color:#9ca3af; font-size:0.85rem;">kwa siku ${liveSub?.durationDays || 30}</div>
                </div>
                
                ${totalPaid > 0 ? `
                <div style="background:#1f2937; border:1px solid #f59e0b; border-radius:10px; padding:12px; margin-bottom:15px; text-align:center;">
                    <div style="color:#f59e0b; font-size:0.85rem; font-weight:700; text-transform:uppercase; margin-bottom:4px;">Maendeleo ya Malipo</div>
                    <div style="color:#fff; font-size:1rem; font-weight:bold;">Umelipia Tsh ${totalPaid.toLocaleString()} kati ya ${livePrice.toLocaleString()}</div>
                    <div style="color:#9ca3af; font-size:0.85rem; margin-top:4px;">Bado Tsh ${(livePrice - totalPaid).toLocaleString()}</div>
                </div>
                ` : '<br>'}

                <button onclick="window.app.paymentHandler.openPaymentModal('live-tv-access', 'Live TV Subscription', ${totalPaid > 0 ? livePrice - totalPaid : livePrice}, ${livePrice})"
                    style="width:100%; margin-bottom:15px; background:linear-gradient(135deg,#6366f1,#8b5cf6); color:#fff; border:none; padding:14px 32px; border-radius:14px; font-size:1rem; font-weight:700; cursor:pointer; letter-spacing:0.5px;">
                    <ion-icon name="card-outline" style="vertical-align:middle; margin-right:6px;"></ion-icon>
                    ${totalPaid > 0 ? `MALIZIA TSH ${(livePrice - totalPaid).toLocaleString()}` : 'LIPIA SASA - FUNGUA LIVE TV'}
                </button>
            </div>
        ` : '';

        document.getElementById('modal-container').innerHTML = `
            <div class="full-page-modal fade-in">
                <nav class="top-nav glass flex justify-between items-center" style="position:fixed; top:0; left:0; right:0; z-index:100;">
                    <div class="back-btn" onclick="window.app.router.navigate('home')" style="position:static; padding:0; background:transparent; width:auto; height:auto;">
                        <ion-icon name="arrow-back" style="font-size:1.5rem;"></ion-icon>
                    </div>
                    <div style="font-weight:bold; font-size:1.1rem;">Live TV</div>
                    <div style="width:24px;"></div> <!-- Spacer -->
                </nav>
                <div style="padding: 80px 20px;">
                    ${payGateHTML}
                    ${!userHasLiveAccess && liveSubEnabled ? '' : `
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px;">
                        <span style="background:#ef4444; color:#fff; padding:4px 10px; border-radius:12px; font-size:0.75rem; font-weight:bold; display:flex; align-items:center; gap:5px;">
                            <span class="live-dot"></span> LIVE NOW
                        </span>
                    </div>
                    ${items.length === 0 ? `
                        <div style="text-align:center; padding:50px 0; color:#888;">
                            <ion-icon name="radio-outline" style="font-size:3rem; margin-bottom:10px;"></ion-icon>
                            <p>No live channels available right now.</p>
                        </div>
                    ` : `
                        <div class="grid" style="grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 15px;">
                            ${items.map(item => this.createLiveCard(item)).join('')}
                        </div>
                    `}
                    `}
                </div>
            </div>
        `;
    }

    createLiveCard(item) {
        // Branded fallback logo using site colors (Black bg, Green text)
        const fallbackLogo = `https://placehold.co/320x180/000000/00ff00?text=RAJABSYNIC%20MOB`;
        const thumb = item.image ? item.image : fallbackLogo;
        const category = (item.downloadLinks && item.downloadLinks.length > 0) ? item.downloadLinks[0] : 'TV';

        return `
            <div class="media-card" onclick="window.app.router.navigate('details', '${item.id}')">
                <div class="poster-container" style="position:relative; aspect-ratio:16/9; border-radius:8px; overflow:hidden; background:#111;">
                    <img src="${thumb}" class="poster" loading="lazy" decoding="async" style="width:100%; height:100%; object-fit:cover;">
                    <div style="position:absolute; top:8px; left:8px; background:rgba(239, 68, 68, 0.9); padding:2px 6px; border-radius:4px; font-size:0.6rem; color:#fff; font-weight:bold;">LIVE</div>
                    <div style="position:absolute; bottom:8px; left:8px; background:rgba(0,0,0,0.7); padding:2px 6px; border-radius:4px; font-size:0.65rem; color:#fff;">
                        ${category}
                    </div>
                </div>
                <div class="media-info" style="margin-top:8px;">
                    <div class="media-title" style="font-weight:500; font-size:0.85rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${item.title}</div>
                    <div style="display:flex; align-items:center; gap:5px; font-size:0.75rem; margin-top:4px;">
                        <span style="color:${item.isFree ? '#4ade80' : '#f87171'}">${item.isFree ? 'Free' : (item.price ? `Tsh ${item.price}` : 'Paid')}</span>
                    </div>
                </div>
            </div>
        `;
    }

    showAccount() {
        const user = JSON.parse(localStorage.getItem('user'));

        // If user just logged in and there's a pending redirect, go there
        if (user && this.pendingRedirect) {
            const { route, param } = this.pendingRedirect;
            this.pendingRedirect = null;
            this.navigate(route, param);
            return;
        }

        // Pre-fill phone from saved user if not logged in
        const savedPhone = user?.phone || localStorage.getItem('savedPhone') || '';

        const content = user ? `
            <div style="padding: 80px 20px; text-align:center;">
                <div class="profile-header" style="margin-bottom:30px;">
                     <div style="width:100px; height:100px; border-radius:50%; background:var(--accent-color); margin:0 auto 20px; display:flex; align-items:center; justify-content:center; font-size:3rem; color:black; font-weight:bold;">
                        ${user.username ? user.username[0].toUpperCase() : 'U'}
                     </div>
                     <h2>${user.username || 'User'}</h2>
                     <p style="color:#888;">${user.phone || ''}</p>
                </div>
                <div class="account-menu" style="text-align:left; background:var(--bg-secondary); border-radius:12px; padding:10px;">
                    <div style="padding:15px; border-bottom:1px solid #333; display:flex; justify-content:space-between; cursor:pointer;" onclick="window.app.router.showMyList()">
                        <span>My List</span> <ion-icon name="chevron-forward"></ion-icon>
                    </div>
                    <div style="padding:15px; color:#ff4444; cursor:pointer;" onclick="window.app.router.logout()">
                        Sign Out
                    </div>
                </div>
            </div>
        ` : `
            <div style="padding: 80px 0;">
                 <div class="auth-form" style="padding: 20px;">
                    <div style="text-align:center; margin-bottom: 30px;">
                         <ion-icon name="person-circle" style="font-size: 5rem; color: #333;"></ion-icon>
                         <h2>Ingia / Jisajili</h2>
                         <p style="color:#666; font-size:0.9rem; margin-top:5px;">Weka namba yako ya simu kuendelea. Kama ni mara yako ya kwanza, tutakusajili moja kwa moja.</p>
                    </div>
                    <input type="tel" id="auth-phone" placeholder="Namba ya simu (mf: 07...)" value="${savedPhone}"
                        style="width:100%; padding: 14px; margin-bottom:20px; background:#222; border:1px solid #333; color:#fff; border-radius:8px; font-size:1.1rem; text-align:center;">
                    <button class="btn btn-primary" style="width:100%; padding:14px; font-size:1.1rem; border-radius:8px;" onclick="window.app.router.checkPhone()">Endelea / Continue</button>
                </div>
            </div>
        `;

        document.getElementById('modal-container').innerHTML = `
            <div class="full-page-modal fade-in">
                 <div class="back-btn" onclick="window.app.router.navigate('home')">
                    <ion-icon name="arrow-back"></ion-icon>
                </div>
                ${content}
            </div>
        `;
    }

    async checkPhone() {
        const phoneInput = document.getElementById('auth-phone');
        const phone = phoneInput.value.trim();
        if (!phone) {
            alert('Tafadhali ingiza namba ya simu');
            return;
        }

        // Optional password (used by admin-created accounts). Blank = phone-only login.
        const passwordInput = document.getElementById('auth-password');
        const password = passwordInput ? passwordInput.value.trim() : '';

        const btn = document.querySelector('button[onclick="window.app.router.checkPhone()"]');
        const originalText = btn.innerHTML;
        btn.innerHTML = 'Inatafuta... <ion-icon name="sync" class="spin"></ion-icon>';
        btn.disabled = true;

        const res = await api.loginUser({ phone: phone, password: password });

        btn.innerHTML = originalText;
        btn.disabled = false;

        if (res.success) {
            // Already registered, logged in successfully
            localStorage.setItem('user', JSON.stringify(res.user));
            localStorage.setItem('savedPhone', phone);
            // Redirect to pending destination or show account
            if (this.pendingRedirect) {
                const { route, param } = this.pendingRedirect;
                this.pendingRedirect = null;
                this.navigate(route, param);
            } else {
                this.showAccount();
            }
        } else if (res.isNewUser) {
            // New user, redirect to name entry
            this.showRegister(phone);
        } else {
            alert(res.message || 'Hitilafu imetokea. Jaribu tena.');
        }
    }

    // `login` kept just in case of any internal dependencies, though removed from UI
    async login() {
        console.warn('Old login logic used');
    }

    logout() {
        localStorage.removeItem('user');
        this.showAccount();
    }

    showRegister(phone) {
        document.getElementById('modal-container').innerHTML = `
             <div class="full-page-modal fade-in">
                 <div class="back-btn" onclick="window.app.router.showAccount()">
                    <ion-icon name="arrow-back"></ion-icon>
                </div>
                <div style="padding: 80px 20px;">
                    <h2 style="margin-bottom:5px;">Usajili Mpya</h2>
                    <p style="color:#888; margin-bottom:20px;">Kamilisha usajili kwa kuweka jina lako.</p>
                    
                    <label style="color:#ccc; font-size:0.85rem;">Namba ya Simu</label>
                    <input type="text" id="req-phone" value="${phone}" readonly style="width:100%; padding: 12px; margin-bottom:15px; background:#111; border:1px solid #333; color:#888; border-radius:8px;">
                    
                    <label style="color:#ccc; font-size:0.85rem;">Jina Lako (Username)</label>
                    <input type="text" id="req-user" placeholder="Mfano: Juma" style="width:100%; padding: 12px; margin-bottom:20px; background:#222; border:1px solid #333; color:#fff; border-radius:8px;">
                    
                    <button class="btn btn-primary" style="width:100%; padding:14px; border-radius:8px; font-size:1.1rem;" onclick="window.app.router.register()">Kamilisha Usajili</button>
                </div>
            </div>
        `;
    }

    async register() {
        const phone = document.getElementById('req-phone').value;
        const user = document.getElementById('req-user').value.trim();

        if (!user) {
            alert('Tafadhali ingiza jina lako');
            return;
        }

        const btn = document.querySelector('button[onclick="window.app.router.register()"]');
        const origText = btn.innerHTML;
        btn.innerHTML = 'Inasajili...';
        btn.disabled = true;

        // Read referral code saved from URL (?ref=...) at page load
        const referredBy = localStorage.getItem('pendingReferralCode') || null;

        const res = await api.registerUser({ phone: phone, username: user, referredBy: referredBy });

        btn.innerHTML = origText;
        btn.disabled = false;

        if (res.success) {
            // Auto login after register
            localStorage.setItem('user', JSON.stringify(res.user));
            localStorage.setItem('savedPhone', phone);
            // Clear pending referral code after successful registration
            localStorage.removeItem('pendingReferralCode');
            // Redirect to pending destination or show account
            if (this.pendingRedirect) {
                const { route, param } = this.pendingRedirect;
                this.pendingRedirect = null;
                this.navigate(route, param);
            } else {
                this.showAccount();
            }
        } else {
            alert(res.message);
        }
    }

    async showMyList() {
        const user = JSON.parse(localStorage.getItem('user') || '{}');
        let paymentsHTML = '';
        try {
            const res = await fetch('/api/payments');
            const allPayments = await res.json();
            // Filter payments belonging to this user
            const userPayments = allPayments.filter(p =>
                p.userId === user.uid ||
                p.username === user.username ||
                p.phone === user.phone
            );

            if (userPayments.length === 0) {
                paymentsHTML = `
                    <div style="text-align:center; padding:60px 20px; color:#888;">
                        <ion-icon name="receipt-outline" style="font-size:3.5rem; margin-bottom:15px; color:#333;"></ion-icon>
                        <p style="font-size:1rem;">Hakuna malipo yaliyopatikana.</p>
                    </div>`;
            } else {
                paymentsHTML = userPayments.map(p => {
                    const statusColor = p.status === 'completed' ? '#22c55e' : p.status === 'failed' ? '#ef4444' : '#f59e0b';
                    const date = p.createdAt ? new Date(p.createdAt).toLocaleDateString('sw-TZ', { day: '2-digit', month: 'short', year: 'numeric' }) : '-';
                    return `
                    <div style="background:#1a1a1a; border:1px solid #2a2a2a; border-radius:14px; padding:16px 18px; margin-bottom:12px;">
                        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
                            <span style="font-weight:700; font-size:0.95rem; color:#fff; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${p.contentTitle || 'Malipo'}</span>
                            <span style="background:${statusColor}22; color:${statusColor}; border:1px solid ${statusColor}44; border-radius:20px; padding:2px 10px; font-size:0.72rem; font-weight:700; margin-left:10px; white-space:nowrap;">${p.status === 'completed' ? '✅ Imekamilika' : p.status === 'failed' ? '❌ Imeshindwa' : '⏳ Inasubiri'}</span>
                        </div>
                        <div style="display:flex; justify-content:space-between; align-items:center;">
                            <span style="color:#22c55e; font-size:1.05rem; font-weight:800;">Tsh ${(p.amount || 0).toLocaleString()}</span>
                            <span style="color:#555; font-size:0.78rem;">${date}</span>
                        </div>
                        ${p.phone ? `<div style="color:#666; font-size:0.8rem; margin-top:4px;">📱 ${p.phone}</div>` : ''}
                    </div>`;
                }).join('');
            }
        } catch (e) {
            paymentsHTML = `<p style="text-align:center; color:#888; padding:40px 0;">Imeshindwa kupakia. Jaribu tena.</p>`;
        }

        document.getElementById('modal-container').innerHTML = `
            <div class="full-page-modal fade-in">
                <nav style="position:fixed; top:0; left:0; right:0; z-index:100; display:flex; align-items:center; padding:16px 20px; background:#0d0d0d; border-bottom:1px solid #1f2937;">
                    <div onclick="window.app.router.showAccount()" style="cursor:pointer; margin-right:14px;">
                        <ion-icon name="arrow-back" style="font-size:1.5rem;"></ion-icon>
                    </div>
                    <h2 style="margin:0; font-size:1.1rem;">My List (Malipo Yangu)</h2>
                </nav>
                <div style="padding:80px 20px 40px;">
                    ${paymentsHTML}
                </div>
            </div>`;
    }

    async showReferral() {
        const user = JSON.parse(localStorage.getItem('user') || '{}');
        const referralCode = user.phone ? 'REF-' + user.phone.replace(/[^0-9]/g, '').slice(-6) : 'REF-XXXXXX';
        const referralLink = `https://rajabsynic.com/?ref=${referralCode}`;

        // Store globally so button handlers can access them safely
        window._referralLink = referralLink;
        window._referralCode = referralCode;

        // Show loading state first
        document.getElementById('modal-container').innerHTML = `
            <div class="full-page-modal fade-in">
                <nav style="position:fixed; top:0; left:0; right:0; z-index:100; display:flex; align-items:center; padding:16px 20px; background:#0d0d0d; border-bottom:1px solid #1f2937;">
                    <div onclick="window.app.router.showAccount()" style="cursor:pointer; margin-right:14px;">
                        <ion-icon name="arrow-back" style="font-size:1.5rem;"></ion-icon>
                    </div>
                    <h2 style="margin:0; font-size:1.1rem;">🎁 Referral Program</h2>
                </nav>
                <div style="padding:100px 20px; text-align:center; color:#555;">
                    <ion-icon name="sync" class="spin" style="font-size:2.5rem;"></ion-icon>
                    <p style="margin-top:12px;">Inapakia...</p>
                </div>
            </div>`;

        // Server-authoritative referral summary. The 35% commission is credited
        // server-side the moment a referred user's purchase completes, so this is
        // fast and reliable (no need to scan thousands of users client-side).
        let balance = 0;
        let referredUsers = [];
        let totalEarned = 0;
        try {
            const res = await fetch(`/api/referral/summary?code=${encodeURIComponent(referralCode)}`);
            const summary = await res.json();
            if (summary && summary.success) {
                balance = summary.balance || 0;
                totalEarned = summary.totalEarned || 0;
                referredUsers = (summary.referredBuyers || []).map(b => ({
                    username: b.username,
                    phone: b.phone,
                    earned: b.earned || 0,
                    purchases: b.purchases || 0
                }));
            }
        } catch (e) {
            // silently continue with defaults
        }

        // Build referred users HTML
        const referredUsersHTML = referredUsers.length === 0
            ? `<div style="text-align:center; padding:30px 15px; color:#555;">
                <ion-icon name="people-outline" style="font-size:2.5rem; margin-bottom:10px; display:block;"></ion-icon>
                <p style="font-size:0.9rem; margin:0;">Bado hakuna aliyenunua kupitia link yako.</p>
                <p style="font-size:0.82rem; margin:4px 0 0; color:#444;">Shiriki link yako — utapata 35% kila mtu atakaponunua!</p>
               </div>`
            : referredUsers.map((u, i) => `
                <div style="display:flex; align-items:center; gap:14px; padding:12px 0; border-bottom:1px solid #1a1a1a;">
                    <div style="width:38px; height:38px; border-radius:50%; background:#052e16; border:2px solid #22c55e; display:flex; align-items:center; justify-content:center; font-weight:800; color:#22c55e; font-size:1rem; flex-shrink:0;">
                        ${u.username ? u.username[0].toUpperCase() : '?'}
                    </div>
                    <div style="flex:1;">
                        <div style="color:#fff; font-weight:600; font-size:0.9rem;">${u.username || 'Mtumiaji'}</div>
                        <div style="color:#555; font-size:0.75rem;">${u.phone || ''} · manunuzi ${u.purchases}</div>
                    </div>
                    <div style="color:#22c55e; font-size:0.8rem; font-weight:800;">+Tsh ${(u.earned || 0).toLocaleString()}</div>
                </div>`).join('');

        const withdrawMsg = `Habari, nataka kutoa pesa zangu za referral.\n\nJina: ${user.username || ''}\nNamba: ${user.phone || ''}\nKodi Yangu: ${referralCode}\nSalio: Tsh ${balance.toLocaleString()}\n\nTafadhali nipelekee malipo yangu. Asante!`;
        window._withdrawMsg = withdrawMsg;
        window._referralBalance = balance; // Store for minimum check in withdrawReferral()

        document.getElementById('modal-container').innerHTML = `
            <div class="full-page-modal fade-in">
                <nav style="position:fixed; top:0; left:0; right:0; z-index:100; display:flex; align-items:center; padding:16px 20px; background:#0d0d0d; border-bottom:1px solid #1f2937;">
                    <div onclick="window.app.router.showAccount()" style="cursor:pointer; margin-right:14px;">
                        <ion-icon name="arrow-back" style="font-size:1.5rem;"></ion-icon>
                    </div>
                    <h2 style="margin:0; font-size:1.1rem;">🎁 Referral Program</h2>
                </nav>
                <div style="padding:80px 20px 40px;">

                    <!-- Hero Banner -->
                    <div style="background:linear-gradient(135deg,#052e16,#14532d); border:1px solid #166534; border-radius:20px; padding:30px 20px; text-align:center; margin-bottom:20px;">
                        <div style="font-size:3rem; margin-bottom:10px;">💰</div>
                        <h2 style="color:#4ade80; font-size:1.8rem; font-weight:900; margin:0 0 8px;">Pata 35%</h2>
                        <p style="color:#86efac; font-size:0.95rem; margin:0;">Kwa kila rafiki unayemwingiza kwenye Rajabsynic</p>
                    </div>

                    <!-- Salio + Watu Stats Row -->
                    <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:20px;">
                        <!-- Salio Card -->
                        <div style="background:linear-gradient(135deg,#0a1f0a,#052e16); border:2px solid #22c55e; border-radius:16px; padding:18px 14px; text-align:center;">
                            <ion-icon name="wallet-outline" style="font-size:1.8rem; color:#22c55e; display:block; margin:0 auto 8px;"></ion-icon>
                            <p style="color:#6b7280; font-size:0.68rem; font-weight:700; text-transform:uppercase; letter-spacing:1px; margin:0 0 6px;">SALIO LAKO</p>
                            <div style="color:#4ade80; font-size:1.35rem; font-weight:900;">Tsh ${balance.toLocaleString()}</div>
                        </div>
                        <!-- Watu Card -->
                        <div style="background:#0d0d0d; border:2px solid #1f2937; border-radius:16px; padding:18px 14px; text-align:center;">
                            <ion-icon name="people-outline" style="font-size:1.8rem; color:#60a5fa; display:block; margin:0 auto 8px;"></ion-icon>
                            <p style="color:#6b7280; font-size:0.68rem; font-weight:700; text-transform:uppercase; letter-spacing:1px; margin:0 0 6px;">WALIOJISAJILI</p>
                            <div style="color:#93c5fd; font-size:1.35rem; font-weight:900;">${referredUsers.length}</div>
                        </div>
                    </div>

                    <!-- Referred Users List -->
                    <div style="background:#111; border:1px solid #1f2937; border-radius:16px; padding:18px; margin-bottom:20px;">
                        <p style="color:#9ca3af; font-size:0.72rem; font-weight:700; text-transform:uppercase; letter-spacing:1.5px; margin:0 0 14px;">RAFIKI WALIOJISAJILI</p>
                        ${referredUsersHTML}
                    </div>

                    <!-- How it works -->
                    <div style="background:#111; border:1px solid #1f2937; border-radius:16px; padding:18px; margin-bottom:20px;">
                        <p style="color:#9ca3af; font-size:0.72rem; font-weight:700; text-transform:uppercase; letter-spacing:1.5px; margin:0 0 14px;">JINSI INAVYOFANYA KAZI</p>
                        <div style="display:flex; gap:14px; align-items:flex-start; margin-bottom:14px;">
                            <div style="width:30px; height:30px; background:#22c55e; border-radius:50%; display:flex; align-items:center; justify-content:center; font-weight:800; color:#000; flex-shrink:0; font-size:0.85rem;">1</div>
                            <div><p style="margin:0; color:#fff; font-weight:600; font-size:0.9rem;">Shiriki kiungo chako</p><p style="margin:3px 0 0; color:#6b7280; font-size:0.82rem;">Tuma link yako ya referral kwa marafiki</p></div>
                        </div>
                        <div style="display:flex; gap:14px; align-items:flex-start; margin-bottom:14px;">
                            <div style="width:30px; height:30px; background:#22c55e; border-radius:50%; display:flex; align-items:center; justify-content:center; font-weight:800; color:#000; flex-shrink:0; font-size:0.85rem;">2</div>
                            <div><p style="margin:0; color:#fff; font-weight:600; font-size:0.9rem;">Rafiki anajisajili na kulipa</p><p style="margin:3px 0 0; color:#6b7280; font-size:0.82rem;">Rafiki wako wafanye malipo kwenye app</p></div>
                        </div>
                        <div style="display:flex; gap:14px; align-items:flex-start;">
                            <div style="width:30px; height:30px; background:#22c55e; border-radius:50%; display:flex; align-items:center; justify-content:center; font-weight:800; color:#000; flex-shrink:0; font-size:0.85rem;">3</div>
                            <div><p style="margin:0; color:#fff; font-weight:600; font-size:0.9rem;">Pata 35% ya malipo yao</p><p style="margin:3px 0 0; color:#6b7280; font-size:0.82rem;">Commission yako inatumwa moja kwa moja</p></div>
                        </div>
                    </div>

                    <!-- Referral Code + Buttons -->
                    <div style="background:#0a1f0a; border:2px solid #22c55e; border-radius:16px; padding:20px; margin-bottom:20px; text-align:center;">
                        <p style="color:#6b7280; font-size:0.8rem; margin:0 0 6px; text-transform:uppercase; letter-spacing:1px;">Kodi Yako ya Referral</p>
                        <div style="font-size:1.6rem; font-weight:900; color:#22c55e; letter-spacing:3px; margin-bottom:16px;">${referralCode}</div>
                        <button id="copy-ref-btn" onclick="window.copyReferralLink()"
                            style="width:100%; background:#22c55e; color:#000; border:none; border-radius:12px; padding:13px; font-weight:800; font-size:0.95rem; display:flex; align-items:center; justify-content:center; gap:8px; cursor:pointer; margin-bottom:10px;">
                            <ion-icon name="copy-outline"></ion-icon> Nakili Link
                        </button>
                        <button id="withdraw-btn" onclick="window.withdrawReferral()"
                            style="width:100%; background:${balance >= 10000 ? '#25D366' : '#374151'}; color:${balance >= 10000 ? '#fff' : '#6b7280'}; border:none; border-radius:12px; padding:13px; font-weight:800; font-size:0.95rem; display:flex; align-items:center; justify-content:center; gap:8px; cursor:pointer; margin-bottom:10px;">
                            <ion-icon name="logo-whatsapp"></ion-icon> Toa Pesa ${balance < 10000 ? `(Tsh ${(10000 - balance).toLocaleString()} bado)` : ''}
                        </button>
                        <button id="add-referred-btn" onclick="window.addReferredUser('${referralCode}')"
                            style="width:100%; background:#1e293b; color:#94a3b8; border:1px solid #334155; border-radius:12px; padding:11px; font-weight:700; font-size:0.85rem; display:flex; align-items:center; justify-content:center; gap:8px; cursor:pointer;">
                            <ion-icon name="person-add-outline"></ion-icon> Ongeza Rafiki Mwenyewe
                        </button>
                    </div>

                    <!-- Info note -->
                    <div style="background:#1a1a1a; border:1px solid #2a2a2a; border-radius:14px; padding:14px 16px; display:flex; gap:12px; align-items:center;">
                        <ion-icon name="information-circle" style="font-size:1.5rem; color:#22c55e; flex-shrink:0;"></ion-icon>
                        <p style="color:#9ca3af; font-size:0.85rem; margin:0; line-height:1.6;">Commission ya <strong style="color:#22c55e;">35%</strong> inahesabiwa kwa malipo yaliyokamilika ya marafiki wako. Kiwango cha chini cha kutoa ni <strong style="color:#f59e0b;">Tsh 10,000</strong>. Bonyeza <strong style="color:#25D366;">Toa Pesa</strong> kutuma ombi lako kupitia WhatsApp.</p>
                    </div>

                </div>
            </div>`;
    }
}

// ─── Global Referral Helpers ──────────────────────────────────────────────────
window.copyReferralLink = function () {
    const link = window._referralLink || '';
    const btn = document.getElementById('copy-ref-btn');
    if (!btn) return;

    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(link).then(() => {
            btn.innerHTML = '<ion-icon name="checkmark-circle"></ion-icon> Imenakiliwa!';
            btn.style.background = '#14532d';
            btn.style.color = '#4ade80';
            setTimeout(() => {
                btn.innerHTML = '<ion-icon name="copy-outline"></ion-icon> Nakili Link';
                btn.style.background = '#22c55e';
                btn.style.color = '#000';
            }, 2500);
        }).catch(() => {
            window._fallbackCopy(link, btn);
        });
    } else {
        window._fallbackCopy(link, btn);
    }
};

window._fallbackCopy = function (text, btn) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
        document.execCommand('copy');
        if (btn) {
            btn.innerHTML = '<ion-icon name="checkmark-circle"></ion-icon> Imenakiliwa!';
            btn.style.background = '#14532d';
            btn.style.color = '#4ade80';
            setTimeout(() => {
                btn.innerHTML = '<ion-icon name="copy-outline"></ion-icon> Nakili Link';
                btn.style.background = '#22c55e';
                btn.style.color = '#000';
            }, 2500);
        }
    } catch (e) {
        alert('Nakili link hii: ' + text);
    }
    document.body.removeChild(ta);
};

window.shareReferral = function () {
    const link = window._referralLink || '';
    const msg = 'Jiunge nami kwenye Rajabsynic upate burudani bora! Tumia link yangu: ' + link;
    if (navigator.share) {
        navigator.share({ title: 'Jiunge Rajabsynic', text: msg, url: link }).catch(() => { });
    } else {
        window.open('https://wa.me/?text=' + encodeURIComponent(msg), '_blank');
    }
};

window.withdrawReferral = function () {
    const balance = window._referralBalance || 0;
    const MIN_WITHDRAW = 10000;

    if (balance < MIN_WITHDRAW) {
        const remaining = (MIN_WITHDRAW - balance).toLocaleString();
        // Show styled alert modal
        const alertEl = document.createElement('div');
        alertEl.id = 'withdraw-alert-overlay';
        alertEl.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.85);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;box-sizing:border-box;animation:fadeIn 0.2s ease;';
        alertEl.innerHTML = `
            <div style="background:linear-gradient(135deg,#0d0d0d,#1a1a1a);border:1px solid #374151;border-radius:20px;padding:30px 24px;max-width:360px;width:100%;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,0.8);">
                <div style="font-size:3rem;margin-bottom:12px;">💰</div>
                <h3 style="color:#f59e0b;font-size:1.1rem;font-weight:800;margin:0 0 10px;">Salio Halitatoshi</h3>
                <p style="color:#9ca3af;font-size:0.9rem;line-height:1.6;margin:0 0 20px;">
                    Salio lako ni <strong style="color:#fff;">Tsh ${balance.toLocaleString()}</strong><br>
                    Unahitaji <strong style="color:#f59e0b;">Tsh ${remaining}</strong> zaidi<br>
                    <span style="font-size:0.82rem;">Kiwango cha chini: Tsh 10,000</span>
                </p>
                <button onclick="document.getElementById('withdraw-alert-overlay').remove()"
                    style="width:100%;background:#22c55e;color:#000;border:none;border-radius:12px;padding:14px;font-weight:800;font-size:0.95rem;cursor:pointer;">
                    Sawa, Nitaendelea Kushirikisha 💪
                </button>
            </div>
        `;
        document.body.appendChild(alertEl);
        return;
    }

    // Show withdrawal modal form
    const user = JSON.parse(localStorage.getItem('user') || '{}');
    const existingModal = document.getElementById('withdraw-modal-overlay');
    if (existingModal) existingModal.remove();

    const modal = document.createElement('div');
    modal.id = 'withdraw-modal-overlay';
    modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.9);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;box-sizing:border-box;';
    modal.innerHTML = `
        <div style="background:linear-gradient(135deg,#0d1a12,#0d0d0d);border:1px solid #22c55e33;border-radius:24px;padding:0;max-width:400px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,0.9);overflow:hidden;">
            
            <!-- Header -->
            <div style="background:linear-gradient(135deg,#052e16,#065f46);padding:24px 24px 20px;position:relative;">
                <button onclick="document.getElementById('withdraw-modal-overlay').remove()"
                    style="position:absolute;top:16px;right:16px;background:rgba(0,0,0,0.3);border:none;color:#fff;width:32px;height:32px;border-radius:50%;cursor:pointer;font-size:1.2rem;display:flex;align-items:center;justify-content:center;">✕</button>
                <div style="text-align:center;">
                    <div style="font-size:2.5rem;margin-bottom:8px;">💸</div>
                    <h2 style="color:#fff;font-size:1.3rem;font-weight:900;margin:0 0 4px;">Toa Pesa</h2>
                    <p style="color:#6ee7b7;font-size:0.85rem;margin:0;">Salio lako: <strong style="color:#4ade80;font-size:1rem;">Tsh ${balance.toLocaleString()}</strong></p>
                </div>
            </div>

            <!-- Body -->
            <div style="padding:24px;">
                
                <!-- Greeting message -->
                <div style="background:#0a2018;border:1px solid #166534;border-radius:12px;padding:14px 16px;margin-bottom:20px;display:flex;gap:10px;align-items:flex-start;">
                    <span style="font-size:1.2rem;">👋</span>
                    <p style="color:#86efac;font-size:0.88rem;margin:0;line-height:1.6;">
                        Habari! Nataka kutoa pesa zangu za referral.<br>
                        Tafadhali nipo hapa nasubiri. Ahsante! 🙏
                    </p>
                </div>

                <!-- Namba ya kupokea -->
                <div style="margin-bottom:16px;">
                    <label style="color:#9ca3af;font-size:0.78rem;font-weight:700;text-transform:uppercase;letter-spacing:1px;display:block;margin-bottom:8px;">
                        📱 Namba ya Kupokea Pesa
                    </label>
                    <input id="wd-receiving-number" type="tel" placeholder="Mfano: 0712345678"
                        value="${user.phone || ''}"
                        style="width:100%;background:#111;border:1.5px solid #374151;color:#fff;border-radius:12px;padding:14px 16px;font-size:1rem;outline:none;box-sizing:border-box;transition:border-color 0.2s;"
                        onfocus="this.style.borderColor='#22c55e'" onblur="this.style.borderColor='#374151'">
                </div>

                <!-- Jina -->
                <div style="margin-bottom:20px;">
                    <label style="color:#9ca3af;font-size:0.78rem;font-weight:700;text-transform:uppercase;letter-spacing:1px;display:block;margin-bottom:8px;">
                        👤 Jina Lako Kamili
                    </label>
                    <input id="wd-receiving-name" type="text" placeholder="Mfano: Rajab Ally"
                        value="${user.username || ''}"
                        style="width:100%;background:#111;border:1.5px solid #374151;color:#fff;border-radius:12px;padding:14px 16px;font-size:1rem;outline:none;box-sizing:border-box;transition:border-color 0.2s;"
                        onfocus="this.style.borderColor='#22c55e'" onblur="this.style.borderColor='#374151'">
                </div>

                <!-- Kiasi -->
                <div style="background:#111827;border:1px solid #1f2937;border-radius:12px;padding:14px 16px;margin-bottom:20px;display:flex;justify-content:space-between;align-items:center;">
                    <span style="color:#6b7280;font-size:0.85rem;">Kiasi cha Kutoa</span>
                    <span style="color:#4ade80;font-size:1.2rem;font-weight:900;">Tsh ${balance.toLocaleString()}</span>
                </div>

                <!-- Submit button -->
                <button id="wd-submit-btn" onclick="window.submitWithdrawal()"
                    style="width:100%;background:linear-gradient(135deg,#16a34a,#15803d);color:#fff;border:none;border-radius:14px;padding:16px;font-weight:800;font-size:1rem;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:10px;box-shadow:0 4px 20px rgba(34,197,94,0.3);transition:all 0.2s;">
                    <ion-icon name="send-outline" style="font-size:1.2rem;"></ion-icon>
                    TUMA OMBI LA KUTOA PESA
                </button>

                <p style="color:#4b5563;font-size:0.75rem;text-align:center;margin:12px 0 0;line-height:1.5;">
                    🔒 Ombi lako litapelekwa kwa admin moja kwa moja.<br>
                    Utapata pesa baada ya admin kukubali.
                </p>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
};

window.submitWithdrawal = async function () {
    const receivingNumber = document.getElementById('wd-receiving-number')?.value?.trim();
    const receivingName = document.getElementById('wd-receiving-name')?.value?.trim();
    const balance = window._referralBalance || 0;
    const user = JSON.parse(localStorage.getItem('user') || '{}');
    const btn = document.getElementById('wd-submit-btn');

    if (!receivingNumber) {
        document.getElementById('wd-receiving-number').style.borderColor = '#ef4444';
        document.getElementById('wd-receiving-number').focus();
        return;
    }
    if (!receivingName) {
        document.getElementById('wd-receiving-name').style.borderColor = '#ef4444';
        document.getElementById('wd-receiving-name').focus();
        return;
    }

    // Show loading
    if (btn) {
        btn.innerHTML = '<ion-icon name="sync" style="animation:spin 1s linear infinite;font-size:1.2rem;"></ion-icon> Inatuma...';
        btn.disabled = true;
    }

    try {
        const res = await fetch('/api/withdrawals', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userId: user.uid || user.id || '',
                username: user.username || '',
                phone: user.phone || '',
                referralCode: window._referralCode || '',
                receivingNumber,
                receivingName,
                amount: balance
            })
        });

        const data = await res.json();

        // Remove modal
        document.getElementById('withdraw-modal-overlay')?.remove();

        if (data.success) {
            // Show success message
            const successEl = document.createElement('div');
            successEl.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.9);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;box-sizing:border-box;';
            successEl.innerHTML = `
                <div style="background:linear-gradient(135deg,#052e16,#0d0d0d);border:1px solid #22c55e;border-radius:24px;padding:36px 28px;max-width:360px;width:100%;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,0.9);">
                    <div style="width:70px;height:70px;background:linear-gradient(135deg,#16a34a,#15803d);border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 20px;box-shadow:0 0 30px rgba(34,197,94,0.4);">
                        <ion-icon name="checkmark" style="font-size:2.5rem;color:#fff;"></ion-icon>
                    </div>
                    <h3 style="color:#4ade80;font-size:1.3rem;font-weight:900;margin:0 0 10px;">Ombi Limetumwa! ✅</h3>
                    <p style="color:#9ca3af;font-size:0.9rem;line-height:1.6;margin:0 0 8px;">
                        Ombi lako la kutoa <strong style="color:#fff;">Tsh ${balance.toLocaleString()}</strong> limepokelewa.
                    </p>
                    <p style="color:#6b7280;font-size:0.82rem;margin:0 0 24px;">
                        Tafadhali nipo hapa nasubiri. Ahsante! 🙏<br>
                        Admin atakukabali hivi karibuni.
                    </p>
                    <button onclick="this.closest('div[style]').remove(); window.app.router.showReferral();"
                        style="width:100%;background:#22c55e;color:#000;border:none;border-radius:12px;padding:14px;font-weight:800;font-size:0.95rem;cursor:pointer;">
                        Sawa, Nimesikia 👍
                    </button>
                </div>
            `;
            document.body.appendChild(successEl);
        } else {
            alert('❌ ' + (data.error || 'Imeshindwa. Jaribu tena.'));
            if (btn) {
                btn.innerHTML = '<ion-icon name="send-outline" style="font-size:1.2rem;"></ion-icon> TUMA OMBI LA KUTOA PESA';
                btn.disabled = false;
            }
        }
    } catch (e) {
        console.error('Withdrawal error:', e);
        alert('❌ Tatizo la mtandao. Jaribu tena.');
        if (btn) {
            btn.innerHTML = '<ion-icon name="send-outline" style="font-size:1.2rem;"></ion-icon> TUMA OMBI LA KUTOA PESA';
            btn.disabled = false;
        }
    }
};

window.addReferredUser = async function (referralCode) {
    const phone = prompt('Ingiza namba ya simu ya rafiki uliyemwalika (mfano: 0712345678):');
    if (!phone || phone.trim() === '') return;

    const cleanPhone = phone.trim().replace(/[^0-9]/g, '');
    // Normalise to 255xxxxxxxxx to match Firestore format
    const normalizedPhone = cleanPhone.startsWith('255') ? cleanPhone
        : cleanPhone.startsWith('0') ? '255' + cleanPhone.slice(1)
        : cleanPhone;

    const btn = document.getElementById('add-referred-btn');

    try {
        if (btn) {
            btn.innerHTML = '<ion-icon name="sync" class="spin"></ion-icon> Inahifadhi...';
            btn.disabled = true;
        }

        // 1. Find the friend in Firestore by phone
        const allUsers = await api.getUsers();
        const friend = allUsers.find(u => {
            const uPhone = (u.phone || '').replace(/[^0-9]/g, '');
            const uNorm = uPhone.startsWith('255') ? uPhone
                : uPhone.startsWith('0') ? '255' + uPhone.slice(1)
                : uPhone;
            return uNorm === normalizedPhone || uPhone === cleanPhone;
        });

        if (!friend) {
            alert(`❌ Mtumiaji mwenye namba ${phone} hajapatikana kwenye mfumo.\n\nHakikisha:\n1. Namba ni sahihi\n2. Rafiki amekwisha jisajili kwenye app`);
            if (btn) {
                btn.innerHTML = '<ion-icon name="person-add-outline"></ion-icon> Ongeza Rafiki Mwenyewe';
                btn.disabled = false;
            }
            return;
        }

        if (friend.referredBy) {
            alert(`⚠️ ${friend.username || 'Mtumiaji huyu'} tayari amehusishwa na referral nyingine.`);
            if (btn) {
                btn.innerHTML = '<ion-icon name="person-add-outline"></ion-icon> Ongeza Rafiki Mwenyewe';
                btn.disabled = false;
            }
            return;
        }

        // 2. Update referredBy directly in Firestore
        const result = await api.updateUserReferral(friend.uid || friend.id, referralCode);

        if (result.success) {
            alert(`✅ Imefanikiwa! ${friend.username || 'Rafiki'} amehusishwa na referral yako sasa.`);
            // Reload referral page to show updated list
            window.app.router.showReferral();
        } else {
            alert('❌ Imeshindwa: ' + (result.message || 'Jaribu tena'));
            if (btn) {
                btn.innerHTML = '<ion-icon name="person-add-outline"></ion-icon> Ongeza Rafiki Mwenyewe';
                btn.disabled = false;
            }
        }
    } catch (e) {
        console.error('addReferredUser error:', e);
        alert('❌ Tatizo la mtandao. Jaribu tena.');
        if (btn) {
            btn.innerHTML = '<ion-icon name="person-add-outline"></ion-icon> Ongeza Rafiki Mwenyewe';
            btn.disabled = false;
        }
    }
};

const app = {
    router: new Router(),
    init: function () {
        console.log("App Initialized with API");
        // Save referral code from URL (?ref=...) so we can attach it during registration
        const urlParams = new URLSearchParams(window.location.search);
        const refCode = urlParams.get('ref');
        if (refCode) {
            localStorage.setItem('pendingReferralCode', refCode);
            console.log('Referral code saved:', refCode);
        }

        // 🟢 REAL-TIME CONTENT LISTENER
        api.listenToContent((content) => {
            this.router.cachedContent = content;
            // Re-render UI dynamically based on the current view
            if (this.router.currentRoute === 'home') {
                this.router.renderSections();
                this.router.renderSlider();
            } else if (this.router.currentRoute === 'details' && this.router.currentDetailsId) {
                this.router.showDetails(this.router.currentDetailsId);
            } else if (this.router.currentRoute === 'category' && this.router.currentCategoryId) {
                this.router.showCategory(this.router.currentCategoryId);
            }
        });

        // Always show home (Browse-Only Mode)
        this.router.showHome();

        // Start activity ping (track online users)
        this._startActivityPing();
    },

    _startActivityPing: function () {
        const ping = () => {
            const user = JSON.parse(localStorage.getItem('user') || '{}');
            if (!user.uid && !user.phone) return; // only ping if logged in
            fetch('/api/user-ping', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    userId: user.uid || user.id || '',
                    username: user.username || '',
                    phone: user.phone || ''
                })
            }).catch(() => {}); // silent fail
        };

        // Ping immediately
        ping();
        // Then every 2 minutes
        setInterval(ping, 2 * 60 * 1000);
    },
    enterAdult: function () { this.router.enterAdult(); },

    // --- PAYMENT METHODS ---
    currentPaymentData: null,

    openPaymentModal: async function (contentId, contentTitle, price, fullPrice) {
        // Check if user is logged in
        const user = JSON.parse(localStorage.getItem('user') || '{}');
        if (!user.uid) {
            // Silently redirect to login, then return to the content details
            this.router.pendingRedirect = { route: 'details', param: contentId };
            this.router.showAccount();
            return;
        }

        // Check if user already has access
        const subscription = await api.checkSubscription(user.uid, contentId);
        if (subscription.hasAccess) {
            alert('You already have access to this content!');
            return;
        }

        // Store payment data
        this.currentPaymentData = {
            contentId,
            contentTitle,
            price,
            fullPrice: fullPrice !== undefined ? fullPrice : price,
            userId: user.uid,
            username: user.username || user.email
        };

        // Populate modal
        document.getElementById('payment-content-title').value = contentTitle;
        document.getElementById('payment-amount-display').value = `Tsh ${price.toLocaleString()}`;

        // Clear phone input so they have to type the payment number
        document.getElementById('payment-phone').value = '';

        // Show modal
        document.getElementById('payment-modal').style.display = 'flex';
        this.showPaymentSection('form');
    },

    closePaymentModal: function (reload = false) {
        const lastContentId = this.currentPaymentData?.contentId;
        document.getElementById('payment-modal').style.display = 'none';
        paymentService.stopPolling();
        if (this._accessWatcher) { clearInterval(this._accessWatcher); this._accessWatcher = null; }
        this.currentPaymentData = null;

        if (reload && lastContentId) {
            // Reload the content details to now show download links
            this.router.navigate('details', lastContentId);
        }
    },

    showPaymentSection: function (section) {
        const sections = ['form', 'processing', 'success', 'failed'];
        sections.forEach(s => {
            const el = document.getElementById(`payment-${s}-section`);
            if (el) el.style.display = s === section ? 'block' : 'none';
        });
    },

    submitPayment: async function () {
        const phone = document.getElementById('payment-phone').value.trim();

        if (!phone) {
            alert('Tafadhali ingiza namba yako ya simu');
            return;
        }

        try {
            console.log('🔄 Starting payment submission...');
            
            // Validate phone number
            const cleanedPhone = paymentService.validatePhone(phone);
            console.log('✅ Phone validated:', cleanedPhone);

            // Show processing state
            this.showPaymentSection('processing');

            // Initiate payment
            const _buyer = JSON.parse(localStorage.getItem('user') || '{}');
            const paymentData = {
                phone: cleanedPhone,
                amount: this.currentPaymentData.price,
                fullPrice: this.currentPaymentData.fullPrice,
                description: `Purchase: ${this.currentPaymentData.contentTitle}`,
                userId: this.currentPaymentData.userId,
                contentId: this.currentPaymentData.contentId,
                contentTitle: this.currentPaymentData.contentTitle,
                username: this.currentPaymentData.username,
                // Referral: who referred this buyer (their referrer's code). The
                // server credits 35% to that code when the payment completes.
                referredBy: _buyer.referredBy || null
            };

            console.log('📤 Sending payment request...', paymentData);
            const response = await paymentService.initiatePayment(paymentData);
            console.log('✅ Payment initiated successfully:', response);

            if (!response.success) {
                throw new Error(response.error || 'Payment initiation failed');
            }

            console.log('Payment initiated via PressoPay:', response);
            this.currentPaymentData.orderId = response.order_id;
            this.currentPaymentData.gateway = 'PressoPay';

            // Hide test mode banner — PressoPay is always LIVE
            const testBanner = document.getElementById('test-mode-banner');
            if (testBanner) testBanner.style.display = 'none';

            // Update status text
            const statusEl = document.getElementById('payment-status-text');
            if (statusEl) {
                statusEl.textContent = 'Inasubiri uthibitisho wa malipo...';
            }

            // Start polling for payment status. Completion auto-redirects the
            // user — they never need to press a "verify" button.
            try {
                await paymentService.pollPaymentStatus(
                    response.order_id,
                    (status, payment) => {
                        if (statusEl) {
                            statusEl.textContent = status === 'pending'
                                ? 'Inasubiri uthibitisho... Ingiza PIN kwenye simu yako.'
                                : `Hali: ${status}`;
                        }
                    }
                );

                // Payment completed successfully
                await this.handlePaymentSuccess(response.order_id);

            } catch (pollError) {
                // A real decline/cancel shows the failure screen.
                if (pollError.reason === 'failed') {
                    this.handlePaymentFailure('Malipo yameshindwa au yameghairiwa. Jaribu tena.');
                    return;
                }
                // Timeout or network hiccup: DON'T ask the user to click anything.
                // Keep watching in the background and unlock automatically the
                // moment the payment is confirmed (via webhook/status).
                console.warn('⏳ Poll ended without completion, switching to silent auto-watch:', pollError.message);
                if (statusEl) {
                    statusEl.textContent = 'Bado tunasubiri malipo... utaingizwa moja kwa moja yatakapokamilika.';
                }
                this.startAutoAccessWatch(response.order_id);
            }

        } catch (error) {
            console.error('❌ Payment submission error:', error);
            
            // Show user-friendly error message
            let errorMessage = error.message || 'Tatizo limetokea. Jaribu tena.';
            
            // Add helpful context for common errors
            if (errorMessage.includes('Failed to fetch') || errorMessage.includes('Network')) {
                errorMessage += '\n\n💡 Vidokezo:\n' +
                              '• Angalia connection yako ya internet\n' +
                              '• Jaribu tena';
            }
            
            this.handlePaymentFailure(errorMessage);
        }
    },

    // Background safety-net: keeps checking server-confirmed access and unlocks
    // automatically, so the user never has to tap a verify button. Runs only
    // while the payment modal is open; stops itself once access is granted.
    startAutoAccessWatch: function (orderId) {
        if (this._accessWatcher) { 
            this._accessWatcher(); // unsubscribe previous
            this._accessWatcher = null; 
        }
        const data = this.currentPaymentData;
        if (!data || !data.userId || !data.contentId) return;

        // 🟢 REAL-TIME SUBSCRIPTION LISTENER
        this._accessWatcher = api.listenToSubscription(data.userId, data.contentId, async (sub) => {
            const modal = document.getElementById('payment-modal');
            
            // Stop if the modal was closed or payment context cleared
            if (!this.currentPaymentData || (modal && modal.style.display === 'none')) {
                if (this._accessWatcher) {
                    this._accessWatcher();
                    this._accessWatcher = null;
                }
                return;
            }
            
            if (sub.hasAccess) {
                if (this._accessWatcher) {
                    this._accessWatcher();
                    this._accessWatcher = null;
                }
                await this.handlePaymentSuccess(orderId);
            }
        });
    },

    handlePaymentSuccess: async function (orderId) {
        console.log('🎉 Payment Success! Processing...');
        
        try {
            const contentId = this.currentPaymentData?.contentId;
            const contentTitle = this.currentPaymentData?.contentTitle;
            
            // STEP 1: IMMEDIATELY grant local access (don't wait for server)
            if (contentId) {
                const paidItems = JSON.parse(localStorage.getItem('paid_items') || '[]');
                if (!paidItems.includes(contentId)) {
                    paidItems.push(contentId);
                    localStorage.setItem('paid_items', JSON.stringify(paidItems));
                    console.log('✅ Local access granted immediately');
                }
            }

            // STEP 2: Calculate subscription expiry
            let durationDays = 14;
            try {
                if (contentId === 'adult-section-access') {
                    const settings = await api.getSettings();
                    durationDays = settings?.adultSubscription?.durationDays || 5;
                } else if (contentId === 'live-tv-access') {
                    const settings = await api.getSettings();
                    durationDays = settings?.liveSubscription?.durationDays || 30;
                }
            } catch (err) {
                console.warn('Could not fetch settings, using defaults');
            }

            // Save subscription details locally with expiry
            if (contentId) {
                const expiryDate = new Date();
                expiryDate.setDate(expiryDate.getDate() + durationDays);
                
                const subscriptions = JSON.parse(localStorage.getItem('subscriptions') || '{}');
                subscriptions[contentId] = {
                    orderId,
                    grantedAt: new Date().toISOString(),
                    expiresAt: expiryDate.toISOString(),
                    durationDays,
                    contentTitle
                };
                localStorage.setItem('subscriptions', JSON.stringify(subscriptions));
                console.log(`✅ Subscription saved: ${contentId} expires ${expiryDate.toLocaleDateString()}`);
            }

            // STEP 3: Try to sync with server (but don't block on failure)
            // (REMOVED: The server webhook already records the payment and creates the subscription automatically. 
            // Doing it here caused duplicate database entries.)
        } catch (fatalError) {
            console.error("Non-fatal error in handlePaymentSuccess setup:", fatalError);
        }

        // STEP 4: Close modal and navigate to content IMMEDIATELY
        console.log('🚀 Redirecting to content...');
        const modal = document.getElementById('payment-modal');
        if (modal) modal.style.display = 'none';
        
        if (paymentService && typeof paymentService.stopPolling === 'function') {
            paymentService.stopPolling();
        }
        
        const contentId = this.currentPaymentData?.contentId;
        const contentTitle = this.currentPaymentData?.contentTitle || 'Huduma';
        this.currentPaymentData = null;

        // Show success message
        const successMsg = document.createElement('div');
        successMsg.className = 'success-toast';
        successMsg.innerHTML = `
            <ion-icon name="checkmark-circle" style="color:#00ff00;font-size:2rem;"></ion-icon>
            <div style="margin-left:10px;">
                <strong>Malipo Yamekamilika! 🎉</strong><br>
                <small>Karibu kwenye ${contentTitle}</small>
            </div>
        `;
        successMsg.style.cssText = `
            position: fixed;
            top: 20px;
            left: 50%;
            transform: translateX(-50%);
            background: #1a1a1a;
            color: white;
            padding: 15px 25px;
            border-radius: 10px;
            box-shadow: 0 4px 15px rgba(0,255,0,0.3);
            z-index: 10000;
            display: flex;
            align-items: center;
            animation: slideDown 0.3s ease;
        `;
        document.body.appendChild(successMsg);
        
        setTimeout(() => {
            successMsg.style.animation = 'slideUp 0.3s ease';
            setTimeout(() => successMsg.remove(), 300);
        }, 3000);

        // Navigate to content
        if (contentId === 'adult-section-access') {
            await this.router.enterAdult();
        } else if (contentId === 'live-tv-access') {
            this.router.navigate('live');
        } else if (contentId) {
            this.router.navigate('details', contentId);
        }

        console.log('✅ Payment process completed successfully');
    },

    handlePaymentFailure: function (errorMessage) {
        document.getElementById('payment-error-text').textContent = errorMessage;
        this.showPaymentSection('failed');
    },

    cancelPayment: function () {
        if (confirm('Je, una uhakika unataka kughairi malipo haya?')) {
            paymentService.stopPolling();
            this.closePaymentModal();
        }
    },

    retryPayment: function () {
        this.showPaymentSection('form');
    },

    // === initiatePayment - called from Pay Gate button ===
    initiatePayment: function (contentId) {
        const item = window.app.router?.contentManager?.cachedContent?.find(i => i.id === contentId);
        if (!item) {
            // Fallback: use openPaymentModal with stored data
            console.warn('Item not found in cache for', contentId);
            return;
        }
        this.openPaymentModal(item.id, item.title, item.price);
    },

    // New verification helper
    verifyPaymentStatus: async function (contentId, btnElement = null) {
        const user = JSON.parse(localStorage.getItem('user') || '{}');
        if (!user.uid) {
            alert('Tafadhali login kwanza ili upate huduma hii.');
            this.router.navigate('account');
            return;
        }

        const btn = btnElement || document.querySelector(`#verify-btn-${contentId}`);
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<ion-icon name="refresh" class="spin"></ion-icon> Inahakiki...';
        }

        try {
            const sub = await api.checkSubscription(user.uid, contentId);
            if (sub.hasAccess) {
                // Save to localStorage as backup
                const paidItems = JSON.parse(localStorage.getItem('paid_items') || '[]');
                if (!paidItems.includes(contentId)) {
                    paidItems.push(contentId);
                    localStorage.setItem('paid_items', JSON.stringify(paidItems));
                }

                alert('✅ Malipo Yamethibitishwa! Karibu!');

                // Route appropriately
                if (contentId === 'adult-section-access') {
                    await this.enterAdult();
                } else {
                    this.router.navigate('details', contentId);
                }
            } else {
                let expectedPriceStr = '';
                if (contentId === 'adult-section-access') {
                    const settings = await api.getSettings();
                    const p = settings?.adultSubscription?.price || 5000;
                    expectedPriceStr = p.toLocaleString();
                } else {
                    const item = window.app.router?.contentManager?.cachedContent?.find(i => i.id === contentId);
                    if (item && item.price) expectedPriceStr = item.price.toLocaleString();
                }
                alert(`⚠️ Malipo bado hayajaonekana.\n\nHakikisha:\n1. Umekamilisha transaction kwenye simu\n2. Umeweka namba sahihi: 5982361\n3. Kiasi sahihi: TSH ${expectedPriceStr}\n\nJaribu tena baada ya dakika 2.`);
            }
        } catch (e) {
            console.error(e);
            alert('Hitilafu imetokea. Jaribu tena baadae.');
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = '<ion-icon name="refresh-circle" style="font-size:1.4rem;"></ion-icon> HAKIKI MALIPO (VERIFY)';
            }
        }
    },

    // Show payment instructions popup when PAY TO ACCESS is clicked
    showPaymentInstructions: function (contentId, title, price, fullPrice) {
        this.openPaymentModal(contentId, title, price, fullPrice);
    },

    openInstallmentModal: async function(contentId, contentTitle, fullPrice, totalPaid) {
        const balance = fullPrice - (totalPaid || 0);
        const { value: amount } = await Swal.fire({
            title: 'Weka Kiasi',
            html: `Kiasi cha chini ni <b>Tsh 1,000</b>.<br><br>Bei halisi: <b>Tsh ${fullPrice.toLocaleString()}</b><br>Kiasi ulichobakiza: <b>Tsh ${balance.toLocaleString()}</b>`,
            input: 'number',
            inputPlaceholder: 'Mfano: 2000',
            showCancelButton: true,
            confirmButtonText: 'Endelea',
            cancelButtonText: 'Ghairi',
            confirmButtonColor: '#f59e0b',
            cancelButtonColor: '#4b5563',
            background: '#1f2937',
            color: '#fff',
            inputValidator: (value) => {
                const num = Number(value);
                if (!value || isNaN(num) || num < 1000) {
                    return 'Tafadhali weka kiasi kisichopungua Tsh 1,000';
                }
                if (num > balance) {
                    return `Kiasi hakipaswi kuzidi salio (Tsh ${balance.toLocaleString()})`;
                }
            }
        });

        if (amount) {
            this.showPaymentInstructions(contentId, contentTitle, Number(amount), fullPrice);
        }
    }
};

window.app = app;
app.init();
