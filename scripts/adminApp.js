        import api from '/scripts/api.js';
        import { auth, onAuthStateChanged } from '/scripts/firebase-config.js';

        const adminApp = {
            token: null,

            filterTable: function(tableId, query) {
                const lowerQuery = query.toLowerCase();
                document.querySelectorAll(`#${tableId} tr`).forEach(row => {
                    const text = row.innerText.toLowerCase();
                    row.style.display = text.includes(lowerQuery) ? '' : 'none';
                });
            },

            login: async function () {
                const email = document.getElementById('admin-user').value;
                const pass = document.getElementById('admin-pass').value;
                const res = await api.adminLogin({ email: email, password: pass });

                if (res.success) {
                    this.token = res.token;
                    sessionStorage.setItem('rajab_admin_token', res.token);
                    document.getElementById('login-overlay').style.display = 'none';
                    this.navigate('dashboard');
                } else {
                    document.getElementById('login-error').innerText = res.message;
                }
            },

            navigate: function (viewId) {
                // Sidebar Active State
                document.querySelectorAll('.menu-item').forEach(el => el.classList.remove('active'));

                // Map viewId to sidebar menu index (Manage Admins removed — admins
                // are managed only in Firebase). Order: Dashboard, Users, Games,
                // LiveTV, Adult, Payments, Settings, Withdrawals.
                const menuMap = {
                    'dashboard': 0, 'users': 1, 'games': 2, 'livetv': 3, 'payments': 4
                };

                const menuItems = document.querySelectorAll('.menu-item');
                if (menuItems[menuMap[viewId]]) {
                    menuItems[menuMap[viewId]].classList.add('active');
                }

                this.currentViewId = viewId;
                
                // View Switching
                document.querySelectorAll('.view-section').forEach(el => el.classList.remove('active'));
                const targetView = document.getElementById('view-' + viewId);
                if (targetView) targetView.classList.add('active');

                // Load Data
                if (viewId === 'dashboard') this.loadDashboard();
                if (viewId === 'users') this.loadUsers();

                if (viewId === 'movies') this.loadContent('movies');
                if (viewId === 'games') this.loadContent('games');
                if (viewId === 'adult') this.loadContent('adult');
                if (viewId === 'livetv') this.loadContent('live');
                if (viewId === 'payments') this.loadPayments();

                if (viewId === 'withdrawals') {
                    this.loadWithdrawals();
                }
                if (viewId === 'notifications') {
                    this.loadNotifHistory();
                    // Setup live preview listeners
                    setTimeout(() => {
                        const titleEl = document.getElementById('notif-title');
                        const bodyEl = document.getElementById('notif-body');
                        if (titleEl) titleEl.addEventListener('input', () => {
                            document.getElementById('preview-title').textContent = titleEl.value || 'Kichwa kitaonekana hapa';
                        });
                        if (bodyEl) bodyEl.addEventListener('input', () => {
                            document.getElementById('preview-body').textContent = bodyEl.value || 'Ujumbe wako utaonekana hapa...';
                        });
                    }, 100);
                }
            },

            // ─── REFRESH DASHBOARD ────────────────────────────────────────
            refreshDashboard: async function () {
                const btn  = document.getElementById('btn-refresh-dashboard');
                const icon = document.getElementById('refresh-icon');

                // Spin the icon + disable button while loading
                if (icon)  icon.style.transform  = 'rotate(360deg)';
                if (btn)   btn.disabled = true;

                await this.loadDashboard();

                // Reset after 800ms so animation completes
                setTimeout(() => {
                    if (icon) icon.style.transform = 'rotate(0deg)';
                    if (btn)  btn.disabled = false;
                }, 800);
            },

            loadDashboard: async function () {
                // Fetch payments ONCE and reuse across every dashboard widget
                // (previously this collection was fetched 4x per load).
                const payments = await api.getPayments();
                const completed = (payments || []).filter(p => ['completed','success','complete'].includes((p.status||'').toLowerCase()));

                const stats = await api.getDashboardStats(payments);
                document.getElementById('stat-games').innerText = stats.totalGames;
                document.getElementById('stat-users').innerText = stats.totalUsers;
                document.getElementById('stat-admins').innerText = stats.totalAdmins;

                // Reuse the single payments fetch for the chart
                this.loadRevenueChart('7days', payments);

                const txnEl = document.getElementById('stat-total-txns');
                if (txnEl) txnEl.textContent = `${completed.length} malipo yaliyokamilika`;
            },

            // --- CONTENT (Combined Logic) ---
            // --- CONTENT (Combined Logic) ---
            loadContent: async function (type) {
                const data = await api.getContent();
                window.allContent = data;

                let filtered = [];

                if (type === 'live') {
                    const tbody = document.getElementById('live-list');
                    filtered = data.filter(i => i.contentType === 'live');
                    tbody.innerHTML = filtered.map(i => `
                        <tr>
                            <td>
                                <div style="display:flex; align-items:center; gap: 10px;">
                                    <div style="width:40px; height:40px; border-radius:4px; background:#374151; display:flex; align-items:center; justify-content:center; overflow:hidden;">
                                        <img src="${i.image || 'https://placehold.co/40x40/111/fff?text=Live'}" style="width:100%; height:100%; object-fit:cover;" onerror="this.src='https://placehold.co/40x40/111/fff?text=Live'">
                                    </div>
                                    ${i.title}
                                </div>
                            </td>
                            <td>${(i.downloadLinks && Array.isArray(i.downloadLinks)) ? i.downloadLinks.join(', ') : 'None'}</td>
                            <td><span class="status-badge status-public">${i.status || 'public'}</span></td>
                            <td>
                                <div style="display:flex; gap:5px;">
                                    <button class="btn-sm btn-edit" onclick="adminApp.openLiveModal('${i.id}')"><ion-icon name="create"></ion-icon></button>
                                    <button class="btn-sm btn-del" onclick="deleteContent('${i.id}', 'live')"><ion-icon name="trash"></ion-icon></button>
                                </div>
                            </td>
                        </tr>
                    `).join('');
                    return;
                }

                // Filtering Logic: Prioritize 'contentType' (new field), fallback to 'category' (legacy)
                const isLive = (i) => i.contentType === 'live';
                const isGame = (i) => i.contentType === 'games' || (!i.contentType && ['tanzania-games', 'free-games', 'maleo-bus-mod', 'maleo-bus-skin', 'maleo-map-mod', 'program-and-app'].includes(i.category));
                const isAdult = (i) => i.contentType === 'adult' || i.isAdult;

                if (type === 'movies') {
                    // Show if explicitly movie, OR if NOT game/adult/live
                    filtered = data.filter(i => i.contentType === 'movies' || (!isGame(i) && !isAdult(i) && !isLive(i)));
                } else if (type === 'games') {
                    filtered = data.filter(i => isGame(i) && !isLive(i));
                } else if (type === 'adult') {
                    filtered = data.filter(i => isAdult(i) && !isLive(i));
                }

                // Sort by createdAt desc (newest first)
                filtered.sort((a, b) => {
                    const dateA = new Date(a.createdAt || 0);
                    const dateB = new Date(b.createdAt || 0);
                    return dateB - dateA;
                });

                const tbody = document.getElementById(type + '-list');
                tbody.innerHTML = filtered.map(item => `
                    <tr>
                        <td style="font-weight: 500; display: flex; align-items: center; gap: 10px;">
                            <img src="${item.image || 'https://placehold.co/40'}" style="width: 30px; height: 45px; object-fit: cover; border-radius: 4px;">
                            <div>
                                <div>${item.title} ${item.isTrending ? '🔥' : ''}</div>
                                <div style="font-size: 0.75rem; color: var(--text-muted);">${item.category}</div>
                            </div>
                        </td>
                         <td style="max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                            <a href="${item.movieLink || '#'}" target="_blank" style="color: var(--accent-color);">${item.movieLink ? 'Link' : '-'}</a>
                        </td>
                        <td>
                            <span style="padding: 4px 8px; border-radius: 4px; background: ${item.isFree ? 'rgba(0,255,0,0.2)' : 'rgba(255,0,0,0.2)'}; color: ${item.isFree ? '#00ff00' : '#ff4444'}; font-size: 0.75rem;">
                                ${item.isFree ? 'Free' : 'Paid'}
                            </span>
                            ${item.isAdult ? '<span style="padding: 4px 8px; border-radius: 4px; background: #991b1b; font-size: 0.75rem; margin-left: 5px;">18+</span>' : ''}
                        </td>
                        <td>
                            <div style="display:flex; gap: 8px;">
                                <button class="btn-sm btn-edit" onclick="window.editContent('${item.id}', '${type}')"><ion-icon name="create"></ion-icon></button>
                                <button class="btn-sm btn-del" onclick="window.deleteContent('${item.id}', '${type}')"><ion-icon name="trash"></ion-icon></button>
                            </div>
                        </td>
                    </tr>
                `).join('');
                window.allContent = data;
                window.currentContentType = type; // Track what view we are in
            },

            openContentModal: function (context, id = null) {
                document.getElementById('c-id').value = id || '';
                document.getElementById('c-context').value = context;

                let title = 'Add Content';
                if (context === 'movies') title = id ? 'Edit Movie' : 'Add Movie';
                if (context === 'games') title = id ? 'Edit Game' : 'Add Game';
                if (context === 'adult') title = id ? 'Edit Video' : 'Add Adult Video';
                document.getElementById('modal-title').innerText = title;
                document.getElementById('upload-status').innerText = '';

                // Populate Category Options based on context
                const catSelect = document.getElementById('c-category');
                const linkLabel = document.querySelector('#group-movie-link label');

                const gameplayLabel = document.querySelector('label[for="c-gameplay-video"]') || document.querySelector('#c-gameplay-video').previousElementSibling;

                const howtoSet = document.getElementById('group-howtoset');
                const gameMeta = document.getElementById('group-game-meta');
                const gameplayGroup = document.getElementById('group-gameplay');
                const specificLinks = document.getElementById('group-specific-links');
                const multiLinks = document.getElementById('group-movie-link');

                if (context === 'movies') {
                    howtoSet.style.display = 'none';
                    gameMeta.style.display = 'none';
                    gameplayGroup.style.display = 'none';
                    specificLinks.style.display = 'block';
                    multiLinks.style.display = 'none';
                    catSelect.innerHTML = `
                        <option value="Action">Action</option>
                        <option value="Comedy">Comedy</option>
                        <option value="Romance">Romance</option>
                        <option value="Horror">Horror</option>
                        <option value="Sci-Fi">Sci-Fi</option>
                        <option value="Drama">Drama</option>
                        <option value="Thriller">Thriller</option>
                        <option value="Animation">Animation</option>
                        <option value="Adventure">Adventure</option>
                        <option value="Crime">Crime</option>
                        <option value="Fantasy">Fantasy</option>
                    `;
                    linkLabel.innerText = 'Movie Link (Google Drive)';
                } else if (context === 'games') {
                    howtoSet.style.display = 'block';
                    gameMeta.style.display = 'block';
                    gameplayGroup.style.display = 'block';
                    specificLinks.style.display = 'none';
                    multiLinks.style.display = 'block';
                    catSelect.innerHTML = `
                        <option value="tanzania-games">Tanzania Games</option>
                        <option value="free-games">Games</option>
                        <option value="maleo-bus-mod">Maleo Bus Mod</option>
                        <option value="maleo-bus-skin">Maleo Bus Skin</option>
                        <option value="maleo-map-mod">Maleo Map Mod</option>
                        <option value="program-and-app">Program and App</option>
                    `;
                    linkLabel.innerText = 'Game Download Link';
                    gameplayLabel.innerText = 'Gameplay (Lilivyo Ndani) - YouTube/Link';
                } else if (context === 'adult') {
                    howtoSet.style.display = 'none';
                    gameMeta.style.display = 'none';
                    gameplayGroup.style.display = 'none';
                    specificLinks.style.display = 'block';
                    multiLinks.style.display = 'none';
                    catSelect.innerHTML = `
                        <option value="Connection">Connection</option>
                        <option value="X-Video">X-Video</option>
                    `;
                    linkLabel.innerText = 'Movie Link (Google Drive)';
                }

                if (id) {
                    const item = window.allContent.find(i => i.id === id);
                    if (item) {
                        document.getElementById('c-title').value = item.title;
                        document.getElementById('c-category').value = item.category;
                        document.getElementById('c-status').value = item.status || 'public';
                        document.getElementById('c-size').value = item.size || '';
                        document.getElementById('c-version').value = item.version || '';
                        document.getElementById('c-price').value = item.price || '';
                        document.getElementById('c-whatsapp').value = item.whatsapp || '';
                        document.getElementById('c-duration').value = item.duration || '5 Days';
                        document.getElementById('c-description').value = item.description || '';
                        document.getElementById('c-gameplay-video').value = item.gameplayVideoUrl || '';
                        document.getElementById('c-howtoset-text').value = item.howToSetText || item.howToSet || '';
                        document.getElementById('c-howtoset-video').value = item.howToSetVideo || '';
                        document.getElementById('c-howtoset-thumbnail').value = item.howToSetThumbnail || '';

                        document.getElementById('c-stream-url').value = item.streamUrl || '';
                        document.getElementById('c-download-url').value = item.downloadUrl || '';

                        // Handle Links
                        this.renderLinkRows(item.downloadLinks || (item.movieLink ? [item.movieLink] : []));

                        document.getElementById('c-image').value = item.image;
                    }
                } else {
                    document.getElementById('c-title').value = '';
                    document.getElementById('c-image').value = '';
                    document.getElementById('c-status').value = 'public';
                    document.getElementById('c-size').value = '';
                    document.getElementById('c-version').value = '';
                    document.getElementById('c-price').value = '';
                    document.getElementById('c-whatsapp').value = '';
                    document.getElementById('c-duration').value = '5 Days';
                    document.getElementById('c-description').value = '';
                    document.getElementById('c-gameplay-video').value = '';
                    document.getElementById('c-howtoset-text').value = '';
                    document.getElementById('c-howtoset-video').value = '';
                    document.getElementById('c-howtoset-thumbnail').value = '';

                    document.getElementById('c-stream-url').value = '';
                    document.getElementById('c-download-url').value = '';

                    this.renderLinkRows([]); // Empty links
                }
                document.getElementById('content-modal').classList.add('show');
            },

            addLinkRow: function (name = '', url = '') {
                const container = document.getElementById('links-container');
                const row = document.createElement('div');
                row.className = 'link-row';
                row.innerHTML = `
                    <input type="text" class="link-name" placeholder="Name (e.g. Server 1)" value="${name}">
                    <input type="text" class="link-url" placeholder="URL" value="${url}">
                    <button type="button" class="btn-remove" onclick="this.parentElement.remove()">
                        <ion-icon name="close"></ion-icon>
                    </button>
                `;
                container.appendChild(row);
            },

            renderLinkRows: function (links) {
                const container = document.getElementById('links-container');
                container.innerHTML = '';
                if (!links || links.length === 0) {
                    this.addLinkRow(); // Add one empty row by default
                    return;
                }
                links.forEach(link => {
                    if (typeof link === 'string') {
                        this.addLinkRow('', link);
                    } else {
                        this.addLinkRow(link.name, link.url);
                    }
                });
            },

            uploadImage: async function (input) {
                if (input.files && input.files[0]) {
                    const status = document.getElementById('upload-status');
                    status.innerText = 'Uploading... Please wait.';
                    status.style.color = '#fff';

                    // Alert to confirm function is running
                    // alert('Starting Image Upload...'); 

                    const formData = new FormData();
                    formData.append('image', input.files[0]);

                    try {
                        const res = await fetch('https://api.imgbb.com/1/upload?key=e4a54b1c8d8e2411273e5036b9f9bf12', {
                            method: 'POST',
                            body: formData
                        });
                        const data = await res.json();
                        if (data.success) {
                            document.getElementById('c-image').value = data.data.url;
                            status.innerText = 'Upload Complete!';
                            status.style.color = '#00ff00';
                            alert('Image Uploaded Successfully!');
                        } else {
                            status.innerText = 'Upload Failed: ' + (data.error ? data.error.message : 'Unknown error');
                            status.style.color = 'crimson';
                            alert('Upload Failed: ' + (data.error.message || 'Unknown Error'));
                        }
                    } catch (err) {
                        console.error(err);
                        status.innerText = 'Network Error during upload';
                        status.style.color = 'crimson';
                        alert('Network Error: Check internet connection');
                    }
                }
            },

            uploadThumbnailImage: async function (input) {
                if (input.files && input.files[0]) {
                    const status = document.getElementById('howtoset-thumbnail-upload-status');
                    status.innerText = 'Uploading... Please wait.';
                    status.style.color = '#fff';

                    const formData = new FormData();
                    formData.append('image', input.files[0]);

                    try {
                        const res = await fetch('https://api.imgbb.com/1/upload?key=e4a54b1c8d8e2411273e5036b9f9bf12', {
                            method: 'POST',
                            body: formData
                        });
                        const data = await res.json();
                        if (data.success) {
                            document.getElementById('c-howtoset-thumbnail').value = data.data.url;
                            status.innerText = 'Upload Complete!';
                            status.style.color = '#00ff00';
                            alert('Thumbnail Uploaded Successfully!');
                        } else {
                            status.innerText = 'Upload Failed: ' + (data.error ? data.error.message : 'Unknown error');
                            status.style.color = 'crimson';
                            alert('Upload Failed: ' + (data.error.message || 'Unknown Error'));
                        }
                    } catch (err) {
                        console.error(err);
                        status.innerText = 'Network Error during upload';
                        status.style.color = 'crimson';
                        alert('Network Error: Check internet connection');
                    }
                }
            },

            uploadLiveImage: async function (input) {
                if (input.files && input.files[0]) {
                    const status = document.getElementById('l-upload-status');
                    status.innerText = 'Uploading... Please wait.';
                    status.style.color = '#fff';

                    const formData = new FormData();
                    formData.append('image', input.files[0]);

                    try {
                        const res = await fetch('https://api.imgbb.com/1/upload?key=e4a54b1c8d8e2411273e5036b9f9bf12', {
                            method: 'POST',
                            body: formData
                        });
                        const data = await res.json();
                        if (data.success) {
                            document.getElementById('l-thumbnail').value = data.data.url;
                            status.innerText = 'Upload Complete!';
                            status.style.color = '#00ff00';
                            alert('Image Uploaded Successfully!');
                        } else {
                            status.innerText = 'Upload Failed: ' + (data.error ? data.error.message : 'Unknown error');
                            status.style.color = 'crimson';
                            alert('Upload Failed: ' + (data.error.message || 'Unknown Error'));
                        }
                    } catch (err) {
                        console.error(err);
                        status.innerText = 'Network Error during upload';
                        status.style.color = 'crimson';
                        alert('Network Error: Check internet connection');
                    }
                    input.value = '';
                }
            },

            openLiveModal: function (id = null) {
                document.getElementById('live-modal-title').innerText = id ? 'Edit Live Channel' : 'Add Live Channel';
                document.getElementById('l-id').value = id || '';
                document.getElementById('l-upload-status').innerText = '';
                document.getElementById('l-upload-status').style.color = 'inherit';

                // Clear active chips
                document.querySelectorAll('#l-categories .cat-chip').forEach(chip => chip.classList.remove('active'));

                if (id) {
                    const item = window.allContent.find(i => i.id === id);
                    if (item) {
                        document.getElementById('l-name').value = item.title;
                        document.getElementById('l-description').value = item.description || '';
                        document.getElementById('l-url').value = item.movieLink || '';
                        document.getElementById('l-encryption').value = item.encryption || 'none';
                        document.getElementById('l-thumbnail').value = item.image || '';
                        document.getElementById('l-price').value = item.price || '';

                        // Set active chips
                        if (item.downloadLinks && Array.isArray(item.downloadLinks)) {
                            item.downloadLinks.forEach(catName => {
                                const chip = Array.from(document.querySelectorAll('#l-categories .cat-chip')).find(c => c.innerText.trim() === catName.trim());
                                if (chip) chip.classList.add('active');
                            });
                        }
                    }
                } else {
                    document.getElementById('l-name').value = '';
                    document.getElementById('l-description').value = '';
                    document.getElementById('l-url').value = '';
                    document.getElementById('l-encryption').value = 'none';
                    document.getElementById('l-thumbnail').value = '';
                    document.getElementById('l-price').value = '';
                }
                document.getElementById('live-modal').classList.add('show');
            },

            saveLiveChannel: async function () {
                const name = document.getElementById('l-name').value;
                const url = document.getElementById('l-url').value;
                if (!name || !url) return alert('Fill required fields');

                const selectedCats = Array.from(document.querySelectorAll('#l-categories .cat-chip.active')).map(c => c.innerText);
                if (selectedCats.length === 0) return alert('Select at least one category');

                const item = {
                    id: document.getElementById('l-id').value,
                    title: name,
                    description: document.getElementById('l-description').value,
                    movieLink: url,
                    encryption: document.getElementById('l-encryption').value,
                    image: document.getElementById('l-thumbnail').value,
                    price: document.getElementById('l-price').value,
                    downloadLinks: selectedCats, // Using downloadLinks as category container for simplicity
                    contentType: 'live',
                    category: 'Live TV',
                    isFree: !document.getElementById('l-price').value.trim(),
                    status: 'public',
                    createdAt: new Date().toISOString()
                };
                if (!item.id) delete item.id;

                const res = await api.saveContent(item);
                if (res.success) {
                    alert('Channel Saved!');
                    document.getElementById('live-modal').classList.remove('show');
                    this.loadContent('live');
                } else {
                    alert('Error: ' + res.message);
                }
            },

            saveContent: async function () {
                try {
                    const item = {
                        id: document.getElementById('c-id').value,
                        title: document.getElementById('c-title').value,
                        category: document.getElementById('c-category').value,
                        contentType: document.getElementById('c-context').value,
                        status: 'public', // Always public as requested
                        size: document.getElementById('c-size').value,
                        version: document.getElementById('c-version').value,
                        price: document.getElementById('c-price').value,
                        whatsapp: document.getElementById('c-whatsapp').value,
                        duration: document.getElementById('c-duration').value,
                        description: document.getElementById('c-description').value,
                        gameplayVideoUrl: document.getElementById('c-gameplay-video').value,
                        howToSetText: document.getElementById('c-howtoset-text').value,
                        howToSetVideo: document.getElementById('c-howtoset-video').value,
                        howToSetThumbnail: document.getElementById('c-howtoset-thumbnail').value,
                        // Legacy field cleanup or keep for compatibility
                        howToSet: document.getElementById('c-howtoset-text').value,
                        image: document.getElementById('c-image').value,

                        streamUrl: document.getElementById('c-stream-url').value,
                        downloadUrl: document.getElementById('c-download-url').value,

                        // Parse Named Links
                        downloadLinks: Array.from(document.querySelectorAll('.link-row')).map(row => ({
                            name: row.querySelector('.link-name').value.trim(),
                            url: row.querySelector('.link-url').value.trim()
                        })).filter(l => l.url),

                        // Legacy support: Keep first link as main movieLink
                        movieLink: Array.from(document.querySelectorAll('.link-row')).map(row => row.querySelector('.link-url').value.trim()).filter(l => l)[0] || '',

                        isTrending: false, // Automated: defaulting to false if manual control removed
                        isFree: !document.getElementById('c-price').value.trim(),
                        isAdult: document.getElementById('c-context').value === 'adult',
                        createdAt: new Date().toISOString()
                    };
                    if (!item.id) delete item.id;

                    console.log("Saving item:", item); // Debug
                    const result = await api.saveContent(item);

                    if (result.success) {
                        alert('Content Saved Successfully!');
                        document.getElementById('content-modal').classList.remove('show');
                        const context = document.getElementById('c-context').value;
                        this.loadContent(context);
                    } else {
                        alert('Error saving content: ' + result.message);
                    }
                } catch (err) {
                    alert('System Error: ' + err.message);
                    console.error(err);
                }
            },

            deleteContent: async function (id, type) {
                if (confirm('Are you sure you want to delete this content?')) {
                    await api.deleteContent(id);
                    this.loadContent(type);
                }
            },

            debugConnection: async function () {
                try {
                    alert('Fetching all content from server...');
                    const data = await api.getContent();
                    const count = data.length;

                    if (count > 0) {
                        // Find the one with highest/latest timestamp if possible, or just the last in array
                        // Firestore returns in order usually, but let's check the last pushed.
                        const lastItem = data[data.length - 1];
                        alert(`Success! Found ${count} items.\n\nLast Item:\nTitle: ${lastItem.title}\nID: ${lastItem.id}\nCategory: ${lastItem.category}\nType: ${lastItem.contentType}\nAdult: ${lastItem.isAdult}`);
                    } else {
                        alert(`Connected to backend, but found 0 items.`);
                    }
                } catch (err) {
                    alert('Backend Error: ' + err.message);
                }
            },

            // --- USERS ---
            loadUsers: async function () {
                const tbody = document.getElementById('users-list');
                if (!tbody) return;

                // Show skeleton immediately
                tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:30px;color:#6b7280;">
                    <ion-icon name="sync" style="font-size:1.5rem;animation:spin 1s linear infinite;display:block;margin:0 auto 8px;"></ion-icon>
                    Inapakia watumiaji...
                </td></tr>`;

                // Fetch all users once, then paginate in memory. Rendering 9k+
                // rows at once freezes the browser, so we show one page at a time.
                const data = await api.getUsers();
                data.sort((a, b) => new Date(b.joinedAt || 0) - new Date(a.joinedAt || 0));
                this._allUsers = data;
                this._filteredUsers = data;
                this._userPage = 1;
                this._userPageSize = 50;
                this._userSpentMap = {};
                this._userAccessMap = {};
                const countEl = document.getElementById('users-count');
                if (countEl) countEl.textContent = data.length ? `(${data.length.toLocaleString()})` : '';

                if (data.length === 0) {
                    // Distinguish "genuinely empty" from "not authenticated" — Firestore
                    // denies the users read when the Firebase session isn't active.
                    const msg = auth.currentUser
                        ? 'No users found.'
                        : '⚠️ Session imekwisha. Tafadhali fanya logout kisha login tena ili kuona watumiaji.';
                    tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: #9ca3af; padding: 30px;">${msg}</td></tr>`;
                    this._renderUserPagination();
                    return;
                }

                // Render only the current page from this._filteredUsers.
                const renderRows = (spentMap, accessMap) => {
                    const size = this._userPageSize;
                    const totalPages = Math.max(1, Math.ceil(this._filteredUsers.length / size));
                    if (this._userPage > totalPages) this._userPage = totalPages;
                    const startIdx = (this._userPage - 1) * size;
                    const pageItems = this._filteredUsers.slice(startIdx, startIdx + size);
                    tbody.innerHTML = pageItems.map(u => {
                        const contact = u.email || u.phone || '';
                        const joined = new Date(u.joinedAt || Date.now()).toLocaleDateString('en-US');
                        const spent = spentMap[u.id] || 0;
                        const hasAccess = accessMap[u.id] || false;
                        return `
                        <tr style="border-bottom: 1px solid rgba(255,255,255,0.05);">
                            <td style="padding: 16px; color: #d1d5db;">${u.username || 'Unknown'}</td>
                            <td style="padding: 16px; color: #9ca3af;">${contact}</td>
                            <td style="padding: 16px; color: #d1d5db;">${joined}</td>
                            <td style="padding: 16px; color: #10b981; font-weight: 600;">${spent} TSH</td>
                            <td style="padding: 16px;">
                                <div style="display: flex; align-items: center; gap: 8px;">
                                    <div style="background: ${hasAccess ? '#065f46' : '#374151'}; color: ${hasAccess ? '#34d399' : '#9ca3af'}; padding: 4px 12px; border-radius: 20px; font-size: 0.75rem; font-weight: 500;">${hasAccess ? 'Access' : 'No Access'}</div>
                                    ${hasAccess ? `
                                    <button onclick="adminApp.revokeAccess('${u.id}')" style="background: #ef4444; border: none; color: white; width: 28px; height: 28px; border-radius: 4px; display: inline-flex; align-items: center; justify-content: center; cursor: pointer;" title="Revoke Premium Access">
                                        <ion-icon name="close-circle" style="font-size: 16px;"></ion-icon>
                                    </button>
                                    ` : `
                                    <button onclick="adminApp.openGrantAccessModal('${u.id}')" style="background: #10b981; border: none; color: white; width: 28px; height: 28px; border-radius: 4px; display: inline-flex; align-items: center; justify-content: center; cursor: pointer;" title="Grant Premium Access">
                                        <ion-icon name="checkmark-circle" style="font-size: 16px;"></ion-icon>
                                    </button>
                                    `}
                                </div>
                            </td>
                            <td style="padding: 16px; text-align: center;">
                                <button onclick="adminApp.deleteUser('${u.id}')" style="background: #ef4444; color: white; border: none; border-radius: 4px; width: 28px; height: 28px; display: inline-flex; align-items: center; justify-content: center; cursor: pointer;" title="Delete User">
                                    <ion-icon name="trash" style="font-size: 14px;"></ion-icon>
                                </button>
                            </td>
                        </tr>`;
                    }).join('');
                    this._renderUserPagination();
                };
                // Expose the renderer so search/pagination can re-render.
                this._renderUsers = renderRows;

                // First render: current page with 0 spend
                renderRows({}, {});

                // Then fetch payments in background and update spend/access
                try {
                    const payments = await api.getPayments();
                    const spentMap = {};
                    const accessMap = {};
                    payments.forEach(p => {
                        const uid = p.userId || p.uid;
                        if (p.status !== 'manual') {
                            spentMap[uid] = (spentMap[uid] || 0) + (parseFloat(p.amount) || 0);
                        }
                        if (p.itemId === 'adult-section-access' && p.status === 'COMPLETED') {
                            accessMap[uid] = true;
                        }
                    });
                    this._userSpentMap = spentMap;
                    this._userAccessMap = accessMap;
                    renderRows(spentMap, accessMap);
                } catch(e) {
                    // silently ignore — users already displayed
                }
            },

            // Live search across ALL loaded users (name / phone / email).
            searchUsers: function (q) {
                q = (q || '').toLowerCase().trim();
                const all = this._allUsers || [];
                this._filteredUsers = !q ? all : all.filter(u =>
                    (u.username || '').toLowerCase().includes(q) ||
                    (u.phone || '').toLowerCase().includes(q) ||
                    (u.email || '').toLowerCase().includes(q)
                );
                this._userPage = 1;
                if (this._renderUsers) this._renderUsers(this._userSpentMap || {}, this._userAccessMap || {});
            },

            changeUserPage: function (delta) {
                const size = this._userPageSize || 50;
                const totalPages = Math.max(1, Math.ceil((this._filteredUsers || []).length / size));
                this._userPage = Math.min(totalPages, Math.max(1, (this._userPage || 1) + delta));
                if (this._renderUsers) this._renderUsers(this._userSpentMap || {}, this._userAccessMap || {});
            },

            _renderUserPagination: function () {
                const list = this._filteredUsers || [];
                const size = this._userPageSize || 50;
                const totalPages = Math.max(1, Math.ceil(list.length / size));
                const startN = list.length ? (this._userPage - 1) * size + 1 : 0;
                const endN = Math.min(list.length, this._userPage * size);
                const info = document.getElementById('users-page-info');
                const label = document.getElementById('users-page-label');
                const prev = document.getElementById('users-prev');
                const next = document.getElementById('users-next');
                if (info) info.textContent = list.length ? `Showing ${startN}-${endN} of ${list.length.toLocaleString()} users` : '';
                if (label) label.textContent = `Page ${this._userPage} / ${totalPages}`;
                if (prev) prev.disabled = this._userPage <= 1;
                if (next) next.disabled = this._userPage >= totalPages;
            },

            deleteUser: async function (id) {
                if (confirm('Delete User?')) {
                    await api.deleteUser(id);
                    this.loadUsers();
                }
            },

            openGrantAccessModal: async function (userId) {
                document.getElementById('grant-user-id').value = userId;
                document.getElementById('grant-type').value = 'adult-section-access';
                document.getElementById('grant-item-selection').style.display = 'none';
                document.getElementById('grant-access-modal').classList.add('show');
                
                // Ensure content is loaded
                if (!window.allContent) {
                    window.allContent = await api.getContent();
                }
            },

            onGrantTypeChange: function () {
                const type = document.getElementById('grant-type').value;
                const selectionDiv = document.getElementById('grant-item-selection');
                const labelEl = document.getElementById('grant-item-label');
                document.getElementById('grant-item-search').value = '';
                
                if (type === 'adult-section-access' || type === 'livetv-all') {
                    selectionDiv.style.display = 'none';
                    return;
                }
                
                selectionDiv.style.display = 'block';
                const data = window.allContent || [];
                let items = [];
                
                if (type === 'livetv') {
                    labelEl.innerText = "Select Live TV Channel";
                    items = data.filter(i => i.contentType === 'live');
                } else if (type === 'games') {
                    labelEl.innerText = "Select Game";
                    const isGame = (i) => i.contentType === 'games' || (!i.contentType && ['tanzania-games', 'free-games', 'maleo-bus-mod', 'maleo-bus-skin', 'maleo-map-mod', 'program-and-app'].includes(i.category));
                    items = data.filter(i => isGame(i) && i.contentType !== 'live');
                } else if (type === 'adult') {
                    labelEl.innerText = "Select Adult Content";
                    const isAdult = (i) => i.contentType === 'adult' || i.isAdult;
                    items = data.filter(i => isAdult(i) && i.contentType !== 'live');
                }
                
                // Sort alphabetically
                items.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
                window.currentGrantItems = items;
                this.renderGrantItems(items);
            },
            
            filterGrantItems: function () {
                const query = document.getElementById('grant-item-search').value.toLowerCase();
                const items = (window.currentGrantItems || []).filter(i => (i.title || '').toLowerCase().includes(query));
                this.renderGrantItems(items);
            },
            
            renderGrantItems: function (items) {
                const selectEl = document.getElementById('grant-item-select');
                if (items.length === 0) {
                    selectEl.innerHTML = '<option disabled>No items found</option>';
                    return;
                }
                selectEl.innerHTML = items.map(i => `<option value="${i.id}">${i.title || 'Untitled'}</option>`).join('');
            },

            confirmGrantAccess: async function () {
                const userId = document.getElementById('grant-user-id').value;
                const type = document.getElementById('grant-type').value;
                let itemId = 'adult-section-access';
                let itemTitle = '18+ Premium Access';
                
                if (type === 'livetv-all') {
                    if (confirm(`Una uhakika unataka kumpatia huyu mtumiaji access ya ALL Live TV Channels?`)) {
                        const liveItems = (window.allContent || []).filter(i => i.contentType === 'live');
                        if (liveItems.length === 0) {
                            alert('No Live TV channels found.');
                            return;
                        }
                        
                        document.getElementById('grant-access-modal').classList.remove('show');
                        alert(`Inampatia access ya channels ${liveItems.length}... tafadhali subiri.`);
                        
                        let successCount = 0;
                        await Promise.all(liveItems.map(async (item) => {
                            const res = await api.grantUserAccess(userId, item.id);
                            if (res.success) successCount++;
                        }));
                        
                        alert(`Mtumiaji amepewa access kikamilifu kwa channels ${successCount} zote!`);
                        this.loadUsers();
                    }
                    return;
                }
                
                if (type !== 'adult-section-access') {
                    const selectEl = document.getElementById('grant-item-select');
                    if (!selectEl.value || selectEl.value === 'Loading...' || selectEl.value === 'No items found') {
                        alert('Tafadhali chagua item kwanza.');
                        return;
                    }
                    itemId = selectEl.value;
                    itemTitle = selectEl.options[selectEl.selectedIndex].text;
                }
                
                if (confirm(`Una uhakika unataka kumpatia huyu mtumiaji access ya: ${itemTitle}?`)) {
                    const res = await api.grantUserAccess(userId, itemId);
                    if (res.success) {
                        alert('Mtumiaji amepewa access kikamilifu!');
                        document.getElementById('grant-access-modal').classList.remove('show');
                        this.loadUsers();
                    } else {
                        alert('Imeshindwa kumpatia access: ' + res.message);
                    }
                }
            },

            revokeAccess: async function (userId) {
                if (confirm('Una uhakika unataka kumuondolea huyu mtumiaji access ya 18+ Premium?')) {
                    const res = await api.revokeUserAccess(userId);
                    if (res.success) {
                        alert('Access imeondolewa!');
                        this.loadUsers();
                    } else {
                        alert('Imeshindwa kumuondolea access: ' + res.message);
                    }
                }
            },

            // Admins are managed ONLY in Firebase (via scripts/fb-admin.js).
            // The in-app admin management UI has been intentionally removed.

            // =============================================
            // SETTINGS
            // =============================================
            // All payments cache for filtering
            _allPayments: [],

            loadPayments: async function () {
                const tbody = document.getElementById('payments-tbody');
                tbody.innerHTML = '<tr><td colspan="8" style="text-align: center;">Loading payments...</td></tr>';
                try {
                    const payments = await api.getAllPayments();
                    this._allPayments = payments || [];
                    let completedCount = 0, pendingCount = 0, failedCount = 0;
                    let todayRev = 0, todayCount = 0, yesterdayRev = 0, yesterdayCount = 0, totalRev = 0, totalCount = 0;
                    let last7DaysRev = 0, thisMonthRev = 0, thisYearRev = 0;
                    
                    let todayGateways = {};
                    let yesterdayGateways = {};

                    const now = new Date();
                    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
                    
                    const yesterdayStart = new Date(todayStart); 
                    yesterdayStart.setDate(yesterdayStart.getDate() - 1);
                    const yesterdayEnd = new Date(todayStart);

                    const last7DaysStart = new Date(todayStart);
                    last7DaysStart.setDate(last7DaysStart.getDate() - 6);

                    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
                    const thisYearStart = new Date(now.getFullYear(), 0, 1);
                    
                    if (!payments || payments.length === 0) {
                        tbody.innerHTML = '<tr><td colspan="8" style="text-align: center; color: #6b7280;">No payment records found.</td></tr>';
                        this._updatePaymentStats(0,0,0,0,0,0,0,0,0,0,0,0, {}, {});
                        return;
                    }

                    // Sort payments by date descending
                    payments.sort((a, b) => {
                        const da = new Date(a.timestamp || a.createdAt || a.created_at || 0);
                        const db = new Date(b.timestamp || b.createdAt || b.created_at || 0);
                        return db - da;
                    });

                    payments.forEach(p => {
                        const status = (p.status || 'pending').toLowerCase();
                        const isCompleted = status === 'completed' || status === 'success' || status === 'complete';
                        const isFailed = status === 'failed' || status === 'error' || status === 'cancelled';
                        let gateway = (p.gateway || '').toLowerCase();
                        const oidForDetect = (p.orderId || p.reference || p.order_id || p.id || '').toLowerCase();
                        if (gateway.includes('presso')) gateway = 'PressoPay';
                        else if (gateway.includes('haraka')) gateway = 'HarakaPay';
                        else if (gateway.includes('tigo')) gateway = 'Tigo Pesa';
                        else if (gateway.includes('mpesa') || gateway.includes('m-pesa')) gateway = 'M-Pesa';
                        else if (gateway.includes('airtel')) gateway = 'Airtel';
                        else if (gateway.includes('test')) gateway = 'Test';
                        else if (p.method === 'manual_admin_grant' || (p.status || '').toLowerCase() === 'manual') gateway = 'Bure (Admin)';
                        else gateway = 'PressoPay'; // Default — all new payments via PressoPay
                        
                        if (isCompleted) completedCount++;
                        else if (isFailed) failedCount++;
                        else pendingCount++;
                        
                        const amt = parseFloat(p.amount) || 0;
                        const ts = p.timestamp || p.createdAt || p.created_at || '';
                        const d = ts ? new Date(ts) : null;
                        
                        if (isCompleted) {
                            totalRev += amt; totalCount++;
                        }
                        
                        if (d) {
                            if (d >= todayStart) { 
                                if(!todayGateways[gateway]) todayGateways[gateway] = {total: 0, count: 0, completed: 0, pending: 0, failed: 0, pendingAmt: 0, failedAmt: 0};
                                todayGateways[gateway].count++;
                                
                                if (isCompleted) {
                                    todayRev += amt; 
                                    todayCount++; 
                                    todayGateways[gateway].total += amt;
                                    todayGateways[gateway].completed++;
                                } else if (isFailed) {
                                    todayGateways[gateway].failedAmt += amt;
                                    todayGateways[gateway].failed++;
                                } else {
                                    todayGateways[gateway].pendingAmt += amt;
                                    todayGateways[gateway].pending++;
                                }
                            }
                            else if (d >= yesterdayStart && d < yesterdayEnd) { 
                                if(!yesterdayGateways[gateway]) yesterdayGateways[gateway] = {total: 0, count: 0, completed: 0, pending: 0, failed: 0, pendingAmt: 0, failedAmt: 0};
                                yesterdayGateways[gateway].count++;
                                
                                if (isCompleted) {
                                    yesterdayRev += amt; 
                                    yesterdayCount++; 
                                    yesterdayGateways[gateway].total += amt;
                                    yesterdayGateways[gateway].completed++;
                                } else if (isFailed) {
                                    yesterdayGateways[gateway].failedAmt += amt;
                                    yesterdayGateways[gateway].failed++;
                                } else {
                                    yesterdayGateways[gateway].pendingAmt += amt;
                                    yesterdayGateways[gateway].pending++;
                                }
                            }

                            if (isCompleted) {
                                if (d >= last7DaysStart) last7DaysRev += amt;
                                if (d >= thisMonthStart) thisMonthRev += amt;
                                if (d >= thisYearStart) thisYearRev += amt;
                            }
                        }
                    });
                    this._updatePaymentStats(completedCount, pendingCount, failedCount, todayRev, todayCount, yesterdayRev, yesterdayCount, totalRev, totalCount, last7DaysRev, thisMonthRev, thisYearRev, todayGateways, yesterdayGateways);
                    this._renderPaymentsTable(payments);
                } catch (err) {
                    console.error('Error loading payments:', err);
                    document.getElementById('payments-tbody').innerHTML = '<tr><td colspan="8" style="text-align: center; color: crimson;">Error loading payments.</td></tr>';
                }
            },

            _updatePaymentStats: function(completed, pending, failed, todayRev, todayCount, yesterdayRev, yesterdayCount, totalRev, totalCount, last7DaysRev, thisMonthRev, thisYearRev, todayGateways, yesterdayGateways) {
                const fmt = v => 'Tzs ' + Math.round(v).toLocaleString();
                const set = (id, val) => { const el = document.getElementById(id); if(el) el.textContent = val; };
                
                // Keep old variables in case
                set('payments-completed', completed);
                set('payments-pending', pending);
                set('payments-failed', failed);
                
                // Advanced Dashboard variables
                set('rev-today', fmt(todayRev));
                set('today-txns-count', todayCount + ' txns');
                set('today-total-breakdown', fmt(todayRev));

                set('rev-yesterday', fmt(yesterdayRev));
                set('yesterday-txns-count', yesterdayCount + ' txns');
                set('yesterday-total-breakdown', fmt(yesterdayRev));

                set('rev-7days', fmt(last7DaysRev));
                set('rev-month', fmt(thisMonthRev));
                set('rev-year', fmt(thisYearRev));
                set('rev-alltime', fmt(totalRev));

                const renderGatewayList = (gatewaysObj, containerId) => {
                    const container = document.getElementById(containerId);
                    if(!container) return;
                    if(Object.keys(gatewaysObj).length === 0) {
                        container.innerHTML = '<div style="color:#6b7280; font-size:0.85rem; text-align:center; padding:10px;">Hakuna malipo bado.</div>';
                        return;
                    }
                    
                    const GATEWAY_META = {
                        'pressopay': { label: 'PressoPay', color: '#00ff80', icon: 'P' },
                        'harakapay': { label: 'HarakaPay', color: '#3b82f6', icon: 'H' },
                        'tigopesa':  { label: 'Tigo Pesa', color: '#ef4444', icon: 'T' },
                        'mpesa':     { label: 'M-Pesa',    color: '#22c55e', icon: 'M' },
                        'airtel':    { label: 'Airtel',    color: '#f97316', icon: 'A' },
                        'test':      { label: 'Test',      color: '#eab308', icon: 'T' },
                        'unknown':   { label: 'Nyingine',  color: '#6b7280', icon: '?' }
                    };

                    const totalCount = Object.values(gatewaysObj).reduce((sum, item) => sum + item.count, 0);
                    const sorted = Object.entries(gatewaysObj).sort((a,b) => b[1].total - a[1].total);

                    container.style.display = 'grid';
                    container.style.gridTemplateColumns = 'repeat(auto-fill, minmax(200px, 1fr))';
                    container.style.gap = '12px';

                    container.innerHTML = sorted.map(([gw, data]) => {
                        let matchedKey = 'unknown';
                        const lowerGw = gw.toLowerCase();
                        if(lowerGw.includes('presso')) matchedKey = 'pressopay';
                        else if(lowerGw.includes('haraka')) matchedKey = 'harakapay';
                        else if(lowerGw.includes('tigo')) matchedKey = 'tigopesa';
                        else if(lowerGw.includes('mpesa') || lowerGw.includes('m-pesa')) matchedKey = 'mpesa';
                        else if(lowerGw.includes('airtel')) matchedKey = 'airtel';
                        else if(lowerGw.includes('test')) matchedKey = 'test';
                        else matchedKey = 'pressopay'; // All new payments via PressoPay
                        
                        const m = GATEWAY_META[matchedKey];
                        const pct = totalCount > 0 ? Math.round((data.count / totalCount) * 100) : 0;
                        
                        return '<div style="background:#111217;border:1px solid ' + m.color + '44;border-radius:12px;padding:16px;position:relative;overflow:hidden;">' +
                            '<div style="position:absolute;top:0;left:0;right:0;height:3px;background:' + m.color + ';border-radius:12px 12px 0 0;"></div>' +
                            '<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;">' +
                                '<div style="width:36px;height:36px;background:' + m.color + '22;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:1.1rem;font-weight:900;color:' + m.color + ';">' + m.icon + '</div>' +
                                '<div><div style="font-weight:700;font-size:0.9rem;color:#fff;">' + m.label + '</div><div style="font-size:0.7rem;color:#6b7280;">' + data.count + ' malipo</div></div>' +
                            '</div>' +
                            '<div style="font-size:1.3rem;font-weight:900;color:' + m.color + ';margin-bottom:8px;">' + fmt(data.total) + '</div>' +
                            '<div style="background:#1f2937;border-radius:99px;height:4px;">' +
                                '<div style="background:' + m.color + ';width:' + pct + '%;height:4px;border-radius:99px;"></div>' +
                            '</div>' +
                            '<div style="display:flex; justify-content:space-between; margin-top:8px;">' +
                                '<div style="font-size:0.7rem;color:#6b7280;">' + pct + '% ya yote</div>' +
                                '<div style="display:flex; flex-direction:column; gap:4px; font-size:0.75rem; align-items:flex-end;">' +
                                    '<span style="color:#10b981;" title="Imekamilika">' + (data.completed||0) + ' <ion-icon name="checkmark-circle" style="vertical-align:text-bottom;"></ion-icon></span>' +
                                    '<span style="color:#f59e0b;" title="Inasubiri">' + (data.pending||0) + ' (' + fmt(data.pendingAmt||0) + ') <ion-icon name="time" style="vertical-align:text-bottom;"></ion-icon></span>' +
                                    '<span style="color:#ef4444;" title="Imefeli">' + (data.failed||0) + ' (' + fmt(data.failedAmt||0) + ') <ion-icon name="close-circle" style="vertical-align:text-bottom;"></ion-icon></span>' +
                                '</div>' +
                            '</div>' +
                        '</div>';
                    }).join('');
                };

                renderGatewayList(todayGateways || {}, 'today-gateways-list');
                renderGatewayList(yesterdayGateways || {}, 'yesterday-gateways-list');
            },

            _renderPaymentsTable: function(payments) {
                const tbody = document.getElementById('payments-tbody');
                if (!payments || payments.length === 0) {
                    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#6b7280;">No payment records found.</td></tr>';
                    return;
                }
                let html = '';
                payments.forEach(p => {
                    const status = (p.status || 'pending').toLowerCase();
                    const isCompleted = status === 'completed' || status === 'success' || status === 'complete';
                    const isFailed = status === 'failed' || status === 'error' || status === 'cancelled';
                    let statusColor = '#f59e0b'; let statusIcon = '<ion-icon name="time-outline" style="vertical-align: text-bottom;"></ion-icon>';
                    if (isCompleted) { statusColor = '#10b981'; statusIcon = '<ion-icon name="checkmark-circle-outline" style="vertical-align: text-bottom;"></ion-icon>'; }
                    if (isFailed) { statusColor = '#ef4444'; statusIcon = '<ion-icon name="close-circle-outline" style="vertical-align: text-bottom;"></ion-icon>'; }
                    const tsRaw = p.timestamp || p.createdAt || p.created_at || '';
                    const dateObj = tsRaw ? new Date(tsRaw) : new Date();
                    const dateStr = dateObj.toLocaleDateString() + ' ' + dateObj.toLocaleTimeString();
                    
                    const orderId = p.orderId || p.reference || p.order_id || p.id || '-';
                    let gateway = (p.gateway || '').toLowerCase();
                    const oid = String(orderId).toLowerCase();
                    if (gateway.includes('presso')) gateway = 'PressoPay';
                    else if (gateway.includes('haraka')) gateway = 'HarakaPay';
                    else if (gateway.includes('tigo')) gateway = 'Tigo Pesa';
                    else if (gateway.includes('mpesa') || gateway.includes('m-pesa')) gateway = 'M-Pesa';
                    else if (gateway.includes('airtel')) gateway = 'Airtel';
                    else if (gateway.includes('test')) gateway = 'Test';
                    else if (p.method === 'manual_admin_grant' || (p.status || '').toLowerCase() === 'manual') gateway = 'Bure (Admin)';
                    else gateway = 'PressoPay'; // Default — all new payments via PressoPay
                    
                    html += '<tr data-status="' + status + '">' +
                            '<td style="font-family: monospace; color: #9ca3af; font-size: 0.85rem;">' + orderId + '</td>' +
                            '<td>' + (p.username || p.userId || 'Unknown') + '</td>' +
                            '<td>' + (p.phone || '-') + '</td>' +
                            '<td><span style="background: rgba(255,255,255,0.05); padding: 4px 8px; border-radius: 4px; font-size: 0.8rem;">' + gateway + '</span></td>' +
                            '<td>' + (p.contentTitle || p.contentId || '-') + '</td>' +
                            '<td>' + (p.amount ? parseInt(p.amount).toLocaleString() : '0') + '</td>' +
                            '<td><span style="color:' + statusColor + ';font-weight:600;display:inline-flex;align-items:center;gap:4px;">' + statusIcon + ' ' + status + '</span></td>' +
                            '<td>' + dateStr + '</td>' +
                            '</tr>';
                });
                tbody.innerHTML = html;
                if (typeof this.filterPaymentsTable === 'function') {
                    this.filterPaymentsTable();
                }
            },

            filterPaymentsTable: function() {
                const searchInput = document.getElementById('payments-search');
                const filterSelect = document.getElementById('payments-status-filter');
                const searchVal = searchInput ? searchInput.value.toLowerCase().trim() : '';
                const filter = filterSelect ? filterSelect.value : 'all';

                const rows = document.querySelectorAll('#payments-tbody tr[data-status]');
                let visibleCount = 0;
                rows.forEach(row => {
                    const st = row.getAttribute('data-status') || '';
                    const isComp = st === 'completed' || st === 'success' || st === 'complete';
                    const isFail = st === 'failed' || st === 'error' || st === 'cancelled';
                    
                    let matchStatus = false;
                    if (filter === 'all') matchStatus = true;
                    else if (filter === 'completed') matchStatus = isComp;
                    else if (filter === 'failed') matchStatus = isFail;
                    else if (filter === 'pending') matchStatus = (!isComp && !isFail);
                    
                    const textContent = row.textContent.toLowerCase();
                    const matchSearch = textContent.includes(searchVal);
                    
                    if (matchStatus && matchSearch) {
                        row.style.display = '';
                        visibleCount++;
                    } else {
                        row.style.display = 'none';
                    }
                });

                let noResultsRow = document.getElementById('no-results-row');
                if (!noResultsRow) {
                    noResultsRow = document.createElement('tr');
                    noResultsRow.id = 'no-results-row';
                    noResultsRow.innerHTML = '<td colspan="8" style="text-align:center;color:#6b7280;padding:20px;">Hakuna malipo yaliyopatikana kwa vigezo hivi.</td>';
                    const tbody = document.getElementById('payments-tbody');
                    if (tbody) tbody.appendChild(noResultsRow);
                }
                if (noResultsRow) {
                    noResultsRow.style.display = (visibleCount === 0 && rows.length > 0) ? '' : 'none';
                }
            },

            openExportModal: function() {
                const radios = document.querySelectorAll('input[name="export-range"]');
                if(radios.length) radios[0].checked = true;
                const cr = document.getElementById('custom-range-inputs');
                if(cr) cr.style.display = 'none';
                const st = document.getElementById('export-start');
                if(st) st.value = '';
                const en = document.getElementById('export-end');
                if(en) en.value = '';
                document.getElementById('export-modal').classList.add('show');
            },

            doExport: function() {
                const rangeElem = document.querySelector('input[name="export-range"]:checked');
                const range = rangeElem ? rangeElem.value : 'alltime';
                const startDate = document.getElementById('export-start').value;
                const endDate = document.getElementById('export-end').value;

                let payments = this._allPayments || [];
                if (!payments.length) { alert('No payments loaded. Click Refresh first.'); return; }
                
                const now = new Date();
                const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
                const last7Start = new Date(todayStart);
                last7Start.setDate(last7Start.getDate() - 6);

                let customStart = null, customEnd = null;
                if (range === 'custom') {
                    if(!startDate || !endDate) { alert('Please select both start and end dates.'); return; }
                    customStart = new Date(startDate);
                    customEnd = new Date(endDate);
                    customEnd.setHours(23, 59, 59, 999);
                }

                // Filter for completed/success
                let filtered = payments.filter(p => {
                    const status = (p.status || 'pending').toLowerCase();
                    const isComp = status === 'completed' || status === 'success' || status === 'complete';
                    if (!isComp) return false;
                    
                    const ts = p.timestamp || p.createdAt || p.created_at || '';
                    if (!ts) return false;
                    const d = new Date(ts);
                    
                    if (range === 'today') {
                        return d >= todayStart;
                    } else if (range === 'last7') {
                        return d >= last7Start;
                    } else if (range === 'custom') {
                        return d >= customStart && d <= customEnd;
                    }
                    return true;
                });

                if (!filtered.length) { alert('No completed payments found in the selected date range.'); return; }

                let totalAmt = 0;
                let gatewayTotals = {};

                const header = 'Order ID,User,Phone,Gateway,Content,Amount (Tsh),Status,Date';
                const rows = filtered.map(p => {
                    const ts = p.timestamp || p.createdAt || p.created_at || '';
                    const d = ts ? new Date(ts).toLocaleString('en-US') : '';
                    const orderId = p.orderId || p.reference || p.order_id || p.id || '-';
                    
                    let gateway = (p.gateway || '').toLowerCase();
                    const oid = String(orderId).toLowerCase();
                    if (gateway.includes('presso')) gateway = 'PressoPay';
                    else if (gateway.includes('haraka')) gateway = 'HarakaPay';
                    else if (gateway.includes('tigo')) gateway = 'Tigo Pesa';
                    else if (gateway.includes('mpesa') || gateway.includes('m-pesa')) gateway = 'M-Pesa';
                    else if (gateway.includes('airtel')) gateway = 'Airtel';
                    else if (gateway.includes('test')) gateway = 'Test';
                    else if (p.method === 'manual_admin_grant' || (p.status || '').toLowerCase() === 'manual') gateway = 'Bure (Admin)';
                    else gateway = 'PressoPay'; // Default — all new payments via PressoPay

                    const amt = p.amount ? parseInt(p.amount) : 0;
                    totalAmt += amt;
                    gatewayTotals[gateway] = (gatewayTotals[gateway] || 0) + amt;
                    
                    return [orderId, p.username||p.userId||'Unknown', p.phone||'', gateway, p.contentTitle||p.contentId||'', amt, 'completed', d].map(v=>'"'+String(v).replace(/"/g,'""')+'"').join(',');
                });

                rows.push('""');
                rows.push('"","","","","TOTAL INCOME",'+totalAmt+',"",""');
                for (let gw in gatewayTotals) {
                    rows.push('"","","","'+gw+' Total","",' + gatewayTotals[gw] + ',"",""');
                }

                const csv = [header, ...rows].join('\n');
                const blob = new Blob([csv], {type:'text/csv'});
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url; a.download = `payments_export_${range}.csv`;
                document.body.appendChild(a); a.click(); document.body.removeChild(a);
                URL.revokeObjectURL(url);
                
                document.getElementById('export-modal').classList.remove('show');
            },

            // =============================================
            // WITHDRAWALS — Toa Pesa
            // =============================================

            loadWithdrawals: async function () {
                const container = document.getElementById('withdrawals-list');
                if (!container) return;

                try {
                    const res = await fetch('/api/withdrawals', { headers: { 'Authorization': 'Bearer ' + sessionStorage.getItem('rajab_admin_token') } });
                    const withdrawals = await res.json();

                    // Update stats
                    const pending   = withdrawals.filter(w => w.status === 'pending').length;
                    const approved  = withdrawals.filter(w => w.status === 'approved').length;
                    const totalPaid = withdrawals.filter(w => w.status === 'approved').reduce((s, w) => s + (w.amount || 0), 0);

                    const setPending  = document.getElementById('wd-stat-pending');
                    const setApproved = document.getElementById('wd-stat-approved');
                    const setTotal    = document.getElementById('wd-stat-total');
                    if (setPending)  setPending.textContent  = pending;
                    if (setApproved) setApproved.textContent = approved;
                    if (setTotal)    setTotal.textContent    = 'Tsh ' + totalPaid.toLocaleString();

                    // Update sidebar badge
                    const badge = document.getElementById('withdrawal-badge');
                    if (badge) {
                        badge.textContent = pending || '';
                        badge.style.display = pending > 0 ? 'inline-block' : 'none';
                    }

                    if (!withdrawals || withdrawals.length === 0) {
                        container.innerHTML = '<div style="text-align:center;padding:40px;color:#6b7280;"><ion-icon name="receipt-outline" style="font-size:3rem;display:block;margin:0 auto 12px;"></ion-icon><p>Hakuna maombi bado.</p></div>';
                        return;
                    }

                    // Render table
                    const rows = withdrawals.map(w => {
                        const statusColor = w.status === 'pending' ? '#f59e0b' : w.status === 'approved' ? '#4ade80' : '#ef4444';
                        const statusIcon  = w.status === 'pending' ? 'time-outline' : w.status === 'approved' ? 'checkmark-circle-outline' : 'close-circle-outline';
                        const date = w.createdAt ? new Date(w.createdAt).toLocaleString('sw-TZ') : '-';

                        const actionBtns = w.status === 'pending' ? `
                            <div style="display:flex;gap:6px;">
                                <button onclick="adminApp.approveWithdrawal('${w.id}')"
                                    style="background:rgba(74,222,128,0.15);border:1px solid #4ade80;color:#4ade80;border-radius:8px;padding:6px 14px;font-size:0.8rem;font-weight:700;cursor:pointer;">✅ Kubali</button>
                                <button onclick="adminApp.rejectWithdrawal('${w.id}')"
                                    style="background:rgba(239,68,68,0.15);border:1px solid #ef4444;color:#ef4444;border-radius:8px;padding:6px 14px;font-size:0.8rem;font-weight:700;cursor:pointer;">❌ Kataa</button>
                            </div>
                        ` : `<span style="color:${statusColor};font-size:0.82rem;font-weight:700;">${w.status === 'approved' ? '✅ Imekubaliwa' : '❌ Imekataliwa'}</span>`;

                        return `
                            <tr style="border-bottom:1px solid #1f2937;">
                                <td style="padding:14px 16px;">
                                    <div style="font-weight:700;color:#fff;font-size:0.9rem;">${w.username || '-'}</div>
                                    <div style="color:#6b7280;font-size:0.75rem;">${w.phone || '-'}</div>
                                </td>
                                <td style="padding:14px 16px;color:#9ca3af;font-size:0.85rem;">${w.receivingNumber || '-'}<br><span style="color:#6b7280;font-size:0.75rem;">${w.receivingName || ''}</span></td>
                                <td style="padding:14px 16px;color:#4ade80;font-weight:800;font-size:1rem;">Tsh ${(w.amount || 0).toLocaleString()}</td>
                                <td style="padding:14px 16px;">
                                    <span style="color:${statusColor};display:inline-flex;align-items:center;gap:4px;font-size:0.85rem;font-weight:600;">
                                        <ion-icon name="${statusIcon}" style="font-size:1rem;"></ion-icon>
                                        ${w.status}
                                    </span>
                                </td>
                                <td style="padding:14px 16px;color:#6b7280;font-size:0.8rem;">${date}</td>
                                <td style="padding:14px 16px;">${actionBtns}</td>
                            </tr>`;
                    }).join('');

                    container.innerHTML = `
                        <table style="width:100%;border-collapse:collapse;">
                            <thead>
                                <tr style="border-bottom:1px solid #1f2937;">
                                    <th style="padding:12px 16px;color:#6b7280;font-size:0.75rem;text-transform:uppercase;font-weight:600;text-align:left;">Mtumiaji</th>
                                    <th style="padding:12px 16px;color:#6b7280;font-size:0.75rem;text-transform:uppercase;font-weight:600;text-align:left;">Namba ya Kupokea</th>
                                    <th style="padding:12px 16px;color:#6b7280;font-size:0.75rem;text-transform:uppercase;font-weight:600;text-align:left;">Kiasi</th>
                                    <th style="padding:12px 16px;color:#6b7280;font-size:0.75rem;text-transform:uppercase;font-weight:600;text-align:left;">Hali</th>
                                    <th style="padding:12px 16px;color:#6b7280;font-size:0.75rem;text-transform:uppercase;font-weight:600;text-align:left;">Tarehe</th>
                                    <th style="padding:12px 16px;color:#6b7280;font-size:0.75rem;text-transform:uppercase;font-weight:600;text-align:left;">Vitendo</th>
                                </tr>
                            </thead>
                            <tbody>${rows}</tbody>
                        </table>`;

                } catch (err) {
                    console.error('Error loading withdrawals:', err);
                    if (container) container.innerHTML = '<p style="color:#ef4444;text-align:center;padding:30px;">Hitilafu ya kupakia. Jaribu tena.</p>';
                }
            },

            approveWithdrawal: async function (id) {
                if (!confirm('Una uhakika unataka KUKUBALI ombi hili? Salio la mtumiaji litakuwa 0 moja kwa moja.')) return;
                try {
                    const res = await fetch('/api/withdrawals/' + id + '/approve', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + sessionStorage.getItem('rajab_admin_token') },
                        body: JSON.stringify({ note: 'Imekubaliwa na admin' })
                    });
                    const data = await res.json();
                    if (data.success) {
                        // Reload withdrawals to reflect changes
                        this.loadWithdrawals();
                    } else {
                        alert('Imeshindwa: ' + (data.error || 'Jaribu tena'));
                    }
                } catch (err) {
                    alert('Hitilafu ya mtandao: ' + err.message);
                }
            },

            rejectWithdrawal: async function (id) {
                const reason = prompt('Sababu ya kukataa (optional):') || '';
                try {
                    const res = await fetch('/api/withdrawals/' + id + '/reject', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + sessionStorage.getItem('rajab_admin_token') },
                        body: JSON.stringify({ reason })
                    });
                    const data = await res.json();
                    if (data.success) {
                        this.loadWithdrawals();
                    } else {
                        alert('Imeshindwa: ' + (data.error || 'Jaribu tena'));
                    }
                } catch (err) {
                    alert('Hitilafu ya mtandao: ' + err.message);
                }
            },


            // =============================================
            // PUSH NOTIFICATIONS
            // =============================================
            sendPushNotification: async function () {
                const title = document.getElementById('notif-title').value.trim();
                const body = document.getElementById('notif-body').value.trim();
                const image = document.getElementById('notif-image').value.trim();
                const target = document.getElementById('notif-target').value;

                if (!title || !body) {
                    adminApp.showNotifStatus('error', '<ion-icon name="warning-outline" style="vertical-align: text-bottom;"></ion-icon> Jaza Kichwa na Ujumbe kwanza!');
                    return;
                }

                const sendBtn = document.querySelector('#view-notifications button[onclick]');
                if (sendBtn) {
                    sendBtn.disabled = true;
                    sendBtn.innerHTML = '<ion-icon name="refresh" class="spin"></ion-icon> Inatuma...';
                }

                try {
                    // Save notification to Firestore — frontend listens in real-time
                    const result = await api.sendNotification({
                        title,
                        body,
                        image: image || null,
                        target
                    });

                    if (result.success) {
                        adminApp.showNotifStatus('success', '<ion-icon name="checkmark-circle-outline" style="vertical-align: text-bottom;"></ion-icon> Notification imetumwa kwa mafanikio!');
                        adminApp.addNotifHistory(title, body, target);
                        // Clear form
                        document.getElementById('notif-title').value = '';
                        document.getElementById('notif-body').value = '';
                        document.getElementById('notif-image').value = '';
                        adminApp.clearNotifImage();
                    } else {
                        throw new Error(result.message || 'Imeshindwa kutuma');
                    }
                } catch (err) {
                    console.error('Notification error:', err);
                    adminApp.showNotifStatus('error', '<ion-icon name="close-circle-outline" style="vertical-align: text-bottom;"></ion-icon> Hitilafu: ' + err.message);
                } finally {
                    if (sendBtn) {
                        sendBtn.disabled = false;
                        sendBtn.innerHTML = '<ion-icon name="send" style="font-size:1.2rem;"></ion-icon> TUMA NOTIFICATION';
                    }
                }
            },

            showNotifStatus: function (type, msg) {
                const el = document.getElementById('notif-status');
                el.style.display = 'block';
                el.style.background = type === 'success' ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)';
                el.style.border = type === 'success' ? '1px solid #22c55e' : '1px solid #ef4444';
                el.style.color = type === 'success' ? '#22c55e' : '#ef4444';
                el.style.borderRadius = '10px';
                el.style.padding = '12px 15px';
                el.style.fontSize = '0.9rem';
                el.style.fontWeight = '600';
                el.textContent = msg;
                setTimeout(() => { el.style.display = 'none'; }, 5000);
            },

            addNotifHistory: function (title, body, target) {
                const history = document.getElementById('notif-history');
                const targetLabels = {
                    'all': '👥 Wote',
                    'topic-games': '🎮 Games',
                    'topic-movies': '🎬 Movies',
                    'topic-live': '📡 Live TV'
                };
                const now = new Date().toLocaleString('sw-TZ');
                const item = document.createElement('div');
                item.style.cssText = 'background:#111; border:1px solid #222; border-radius:10px; padding:12px; font-size:0.85rem;';
                item.innerHTML = `
                    <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:4px;">
                        <span style="color:#fff; font-weight:700;">${title}</span>
                        <span style="background:#22c55e22; color:#22c55e; padding:2px 8px; border-radius:20px; font-size:0.75rem;">${targetLabels[target] || target}</span>
                    </div>
                    <div style="color:#9ca3af;">${body}</div>
                    <div style="color:#6b7280; font-size:0.75rem; margin-top:6px;">${now}</div>
                `;
                // Remove empty state
                const empty = history.querySelector('p');
                if (empty) empty.remove();
                history.insertBefore(item, history.firstChild);

                // Save to localStorage
                const stored = JSON.parse(localStorage.getItem('notif_history') || '[]');
                stored.unshift({ title, body, target, time: now });
                localStorage.setItem('notif_history', JSON.stringify(stored.slice(0, 20)));
            },

            loadNotifHistory: function () {
                const stored = JSON.parse(localStorage.getItem('notif_history') || '[]');
                stored.forEach(n => adminApp.addNotifHistory(n.title, n.body, n.target));
            },

            // Image tab switcher
            switchImageTab: function (tab) {
                const linkBtn = document.getElementById('img-tab-link');
                const uploadBtn = document.getElementById('img-tab-upload');
                const linkPanel = document.getElementById('img-panel-link');
                const uploadPanel = document.getElementById('img-panel-upload');

                const activeStyle = 'background:#22c55e; color:#000;';
                const inactiveStyle = 'background:transparent; color:#9ca3af;';

                if (tab === 'link') {
                    linkBtn.style.cssText = linkBtn.style.cssText.replace(/background:[^;]+; color:[^;]+;/, '') + activeStyle;
                    uploadBtn.style.cssText = uploadBtn.style.cssText.replace(/background:[^;]+; color:[^;]+;/, '') + inactiveStyle;
                    linkPanel.style.display = 'block';
                    uploadPanel.style.display = 'none';
                } else {
                    linkBtn.style.cssText = linkBtn.style.cssText.replace(/background:[^;]+; color:[^;]+;/, '') + inactiveStyle;
                    uploadBtn.style.cssText = uploadBtn.style.cssText.replace(/background:[^;]+; color:[^;]+;/, '') + activeStyle;
                    linkPanel.style.display = 'none';
                    uploadPanel.style.display = 'block';
                }
            },

            // Upload image to ImgBB and set the URL
            handleNotifImageUpload: async function (input) {
                const file = input.files[0];
                if (!file) return;

                const statusEl = document.getElementById('notif-upload-status');
                statusEl.style.display = 'block';
                statusEl.style.color = '#9ca3af';
                statusEl.textContent = '<ion-icon name="time-outline" style="vertical-align: text-bottom;"></ion-icon> Inapakia picha...';

                try {
                    const formData = new FormData();
                    formData.append('image', file);

                    const res = await fetch('https://api.imgbb.com/1/upload?key=e4a54b1c8d8e2411273e5036b9f9bf12', {
                        method: 'POST',
                        body: formData
                    });
                    const data = await res.json();

                    if (data.success) {
                        const url = data.data.url;
                        // Set the hidden URL field value
                        document.getElementById('notif-image').value = url;
                        statusEl.style.color = '#22c55e';
                        statusEl.textContent = '<ion-icon name="checkmark-circle-outline" style="vertical-align: text-bottom;"></ion-icon> Picha imepakiwa!';
                        adminApp.previewNotifImage(url);
                        setTimeout(() => { statusEl.style.display = 'none'; }, 3000);
                    } else {
                        throw new Error('ImgBB upload failed');
                    }
                } catch (err) {
                    statusEl.style.color = '#ef4444';
                    statusEl.textContent = '<ion-icon name="close-circle-outline" style="vertical-align: text-bottom;"></ion-icon> Imeshindwa kupakia: ' + err.message;
                }
            },

            // Preview image
            previewNotifImage: function (url) {
                const previewBox = document.getElementById('notif-img-preview');
                const previewImg = document.getElementById('notif-img-preview-img');
                if (url && url.startsWith('http')) {
                    previewImg.src = url;
                    previewBox.style.display = 'block';
                } else {
                    previewBox.style.display = 'none';
                }
            },

            // Clear image
            clearNotifImage: function () {
                document.getElementById('notif-image').value = '';
                document.getElementById('notif-img-file').value = '';
                document.getElementById('notif-img-preview').style.display = 'none';
                document.getElementById('notif-img-preview-img').src = '';
            },

            // ─── REVENUE CHART ────────────────────────────────────────────

            _revenueChart: null,

            loadRevenueChart: async function (period, preloadedPayments) {
                period = period || '7days';

                // Update tab active styles
                document.querySelectorAll('.rev-tab').forEach(btn => {
                    btn.style.background = 'transparent';
                    btn.style.color = '#9ca3af';
                });
                const activeBtn = document.getElementById('rev-tab-' + period);
                if (activeBtn) { activeBtn.style.background = '#00ff80'; activeBtn.style.color = '#000'; }

                // Show loading state
                document.getElementById('rev-period-amount').textContent = 'Inapakia...';
                document.getElementById('rev-total-amount').textContent = 'Inapakia...';

                try {
                    // Reuse preloaded payments (from loadDashboard) when available,
                    // otherwise fetch (e.g. when a period tab is clicked directly).
                    const allPayments = preloadedPayments || await api.getPayments();

                    // Only count completed/success payments
                    const completed = allPayments.filter(p => {
                        const s = (p.status || '').toLowerCase();
                        return s === 'completed' || s === 'success' || s === 'complete';
                    });

                    const fmt = n => 'Tsh ' + Number(n).toLocaleString();

                    // Lifetime total
                    const totalRevenue = completed.reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0);

                    // Update stat card
                    document.getElementById('stat-total-revenue').textContent = fmt(totalRevenue);
                    document.getElementById('stat-total-txns').textContent =
                        `${completed.length} malipo yaliyokamilika`;

                    // ── Build period buckets ──────────────────────────────────
                    const now = new Date();
                    let buckets = {}; // key → total amount
                    let filteredPayments = [];
                    let labelFn; // key → display label

                    if (period === '7days') {
                        // Last 7 days: one bucket per day
                        for (let i = 6; i >= 0; i--) {
                            const d = new Date(now);
                            d.setDate(d.getDate() - i);
                            const key = d.toISOString().slice(0, 10); // YYYY-MM-DD
                            buckets[key] = 0;
                        }
                        const cutoff = new Date(now); cutoff.setDate(now.getDate() - 6); cutoff.setHours(0,0,0,0);
                        filteredPayments = completed.filter(p => {
                            const ts = p.timestamp || p.createdAt || '';
                            return ts && new Date(ts) >= cutoff;
                        });
                        labelFn = key => {
                            const d = new Date(key + 'T00:00:00');
                            return d.toLocaleDateString('sw-TZ', { weekday: 'short', day: 'numeric' });
                        };

                    } else if (period === 'month') {
                        // Current month: one bucket per day (1 → today)
                        const year = now.getFullYear();
                        const month = now.getMonth();
                        const daysInMonth = now.getDate();
                        for (let i = 1; i <= daysInMonth; i++) {
                            const key = `${year}-${String(month + 1).padStart(2, '0')}-${String(i).padStart(2, '0')}`;
                            buckets[key] = 0;
                        }
                        filteredPayments = completed.filter(p => {
                            const ts = p.timestamp || p.createdAt || '';
                            if (!ts) return false;
                            const d = new Date(ts);
                            return d.getFullYear() === year && d.getMonth() === month;
                        });
                        labelFn = key => {
                            const d = new Date(key + 'T00:00:00');
                            return d.toLocaleDateString('sw-TZ', { day: 'numeric', month: 'short' });
                        };

                    } else if (period === 'year') {
                        // Current year: one bucket per month (Jan → now)
                        const year = now.getFullYear();
                        for (let m = 0; m <= now.getMonth(); m++) {
                            const key = `${year}-${String(m + 1).padStart(2, '0')}`;
                            buckets[key] = 0;
                        }
                        filteredPayments = completed.filter(p => {
                            const ts = p.timestamp || p.createdAt || '';
                            if (!ts) return false;
                            return new Date(ts).getFullYear() === year;
                        });
                        labelFn = key => {
                            const [y, m] = key.split('-');
                            return new Date(y, m - 1, 1).toLocaleDateString('sw-TZ', { month: 'long' });
                        };

                    } else { // lifetime — group by month across all time
                        filteredPayments = completed;
                        filteredPayments.forEach(p => {
                            const ts = p.timestamp || p.createdAt || '';
                            if (!ts) return;
                            const d = new Date(ts);
                            const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
                            if (!buckets[key]) buckets[key] = 0;
                        });
                        // Sort keys chronologically
                        buckets = Object.fromEntries(Object.keys(buckets).sort().map(k => [k, 0]));
                        labelFn = key => {
                            const [y, m] = key.split('-');
                            return new Date(y, m - 1, 1).toLocaleDateString('sw-TZ', { month: 'short', year: '2-digit' });
                        };
                    }

                    // Fill buckets with amounts from filtered payments
                    filteredPayments.forEach(p => {
                        const ts = p.timestamp || p.createdAt || '';
                        if (!ts) return;
                        const d = new Date(ts);
                        let key;
                        if (period === '7days' || period === 'month') {
                            key = d.toISOString().slice(0, 10);
                        } else {
                            key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
                        }
                        if (key in buckets) buckets[key] += parseFloat(p.amount) || 0;
                    });

                    const keys = Object.keys(buckets);
                    const chartLabels = keys.map(labelFn);
                    const chartData = keys.map(k => buckets[k]);
                    const periodRevenue = chartData.reduce((a, b) => a + b, 0);

                    // Update header mini-stats
                    document.getElementById('rev-period-amount').textContent = fmt(periodRevenue);
                    document.getElementById('rev-total-amount').textContent = fmt(totalRevenue);

                    // ── Render Chart ──────────────────────────────────────────
                    const ctx = document.getElementById('revenueChart').getContext('2d');
                    if (this._revenueChart) this._revenueChart.destroy();

                    // No data → show friendly message
                    if (keys.length === 0 || chartData.every(v => v === 0)) {
                        ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
                        ctx.fillStyle = '#6b7280';
                        ctx.font = '14px Inter, sans-serif';
                        ctx.textAlign = 'center';
                        ctx.fillText('Hakuna malipo yaliyopatikana kwa kipindi hiki.', ctx.canvas.width / 2, 120);
                        return;
                    }

                    this._revenueChart = new Chart(ctx, {
                        type: 'line',
                        data: {
                            labels: chartLabels,
                            datasets: [{
                                label: 'Mapato (Tsh)',
                                data: chartData,
                                borderColor: '#00ff80',
                                backgroundColor: function(context) {
                                    const chart = context.chart;
                                    const {ctx: c, chartArea} = chart;
                                    if (!chartArea) return 'rgba(0,255,128,0.08)';
                                    const gradient = c.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
                                    gradient.addColorStop(0, 'rgba(0,255,128,0.25)');
                                    gradient.addColorStop(1, 'rgba(0,255,128,0.0)');
                                    return gradient;
                                },
                                borderWidth: 2.5,
                                pointBackgroundColor: '#00ff80',
                                pointBorderColor: '#0b0c10',
                                pointBorderWidth: 2,
                                pointRadius: 5,
                                pointHoverRadius: 8,
                                fill: true,
                                tension: 0.45
                            }]
                        },
                        options: {
                            responsive: true,
                            maintainAspectRatio: false,
                            interaction: { mode: 'index', intersect: false },
                            plugins: {
                                legend: { display: false },
                                tooltip: {
                                    backgroundColor: '#1f2937',
                                    titleColor: '#9ca3af',
                                    bodyColor: '#00ff80',
                                    borderColor: '#374151',
                                    borderWidth: 1,
                                    padding: 12,
                                    callbacks: {
                                        label: ctx => ' Tsh ' + Number(ctx.parsed.y).toLocaleString()
                                    }
                                }
                            },
                            scales: {
                                x: {
                                    grid: { color: 'rgba(255,255,255,0.04)' },
                                    ticks: { color: '#6b7280', font: { size: 11 } }
                                },
                                y: {
                                    grid: { color: 'rgba(255,255,255,0.04)' },
                                    ticks: {
                                        color: '#6b7280',
                                        font: { size: 11 },
                                        callback: v => 'Tsh ' + (v >= 1000 ? (v/1000).toFixed(0) + 'k' : v)
                                    },
                                    beginAtZero: true
                                }
                            }
                        }
                    });

                } catch (err) {
                    console.error('Revenue chart error:', err);
                    document.getElementById('rev-period-amount').textContent = 'Hitilafu';
                    document.getElementById('rev-total-amount').textContent = 'Hitilafu';
                }
            },

        // ─── WITHDRAWALS (Toa Pesa) ───────────────────────────────────────────────


        loadWithdrawals: async function () {
            const listEl = document.getElementById('withdrawals-list');
            if (!listEl) return;

            listEl.innerHTML = '<div style="color:#9ca3af;padding:30px;text-align:center;">Inapakia...</div>';

            try {
                const res = await fetch('/api/withdrawals', { headers: { 'Authorization': 'Bearer ' + sessionStorage.getItem('rajab_admin_token') } });
                const withdrawals = await res.json();

                // Update stats
                const pending  = withdrawals.filter(w => w.status === 'pending');
                const approved = withdrawals.filter(w => w.status === 'approved');
                const totalPaid = approved.reduce((s, w) => s + (w.amount || 0), 0);

                const pendEl = document.getElementById('wd-stat-pending');
                const appEl  = document.getElementById('wd-stat-approved');
                const totEl  = document.getElementById('wd-stat-total');
                if (pendEl) pendEl.textContent = pending.length;
                if (appEl)  appEl.textContent  = approved.length;
                if (totEl)  totEl.textContent  = 'Tsh ' + totalPaid.toLocaleString();

                // Update sidebar badge
                const badge = document.getElementById('withdrawal-badge');
                if (badge) {
                    badge.textContent = pending.length || '';
                    badge.style.display = pending.length > 0 ? 'inline-block' : 'none';
                }

                if (withdrawals.length === 0) {
                    listEl.innerHTML = '<div style="color:#6b7280;padding:40px;text-align:center;">Hakuna maombi bado.</div>';
                    return;
                }

                const statusBadge = (status) => {
                    const map = {
                        pending:  { bg: 'rgba(245,158,11,0.15)', color: '#f59e0b', label: '⏳ Inasubiri' },
                        approved: { bg: 'rgba(74,222,128,0.15)', color: '#4ade80', label: '✅ Imekubaliwa' },
                        rejected: { bg: 'rgba(239,68,68,0.15)',  color: '#ef4444', label: '❌ Imekataliwa' }
                    };
                    const s = map[status] || { bg: '#1f2937', color: '#9ca3af', label: status };
                    return `<span style="background:${s.bg};color:${s.color};border-radius:20px;padding:3px 10px;font-size:0.75rem;font-weight:700;">${s.label}</span>`;
                };

                const fmt = (iso) => {
                    if (!iso) return '—';
                    return new Date(iso).toLocaleString('sw-TZ', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
                };

                const rows = withdrawals.map(w => `
                    <tr>
                        <td style="padding:14px 20px;">
                            <div style="font-weight:600;color:#fff;">${w.username || '—'}</div>
                            <div style="font-size:0.78rem;color:#6b7280;">${w.phone || '—'}</div>
                        </td>
                        <td style="padding:14px 20px;">
                            <div style="font-weight:700;color:#4ade80;font-size:1.05rem;">Tsh ${(w.amount||0).toLocaleString()}</div>
                        </td>
                        <td style="padding:14px 20px;">
                            <div style="font-weight:600;">${w.receivingName || '—'}</div>
                            <div style="font-size:0.78rem;color:#9ca3af;font-family:monospace;">${w.receivingNumber || '—'}</div>
                        </td>
                        <td style="padding:14px 20px;">${statusBadge(w.status)}</td>
                        <td style="padding:14px 20px;font-size:0.8rem;color:#6b7280;">${fmt(w.createdAt)}</td>
                        <td style="padding:14px 20px;">
                            ${w.status === 'pending' ? `
                            <div style="display:flex;gap:8px;">
                                <button onclick="adminApp.approveWithdrawal('${w.id}')" style="background:rgba(74,222,128,0.15);color:#4ade80;border:1px solid rgba(74,222,128,0.3);border-radius:8px;padding:7px 14px;font-size:0.8rem;font-weight:700;cursor:pointer;transition:all 0.2s;" onmouseover="this.style.background='rgba(74,222,128,0.3)'" onmouseout="this.style.background='rgba(74,222,128,0.15)'">✅ Kubali</button>
                                <button onclick="adminApp.rejectWithdrawal('${w.id}')"  style="background:rgba(239,68,68,0.15);color:#ef4444;border:1px solid rgba(239,68,68,0.3);border-radius:8px;padding:7px 14px;font-size:0.8rem;font-weight:700;cursor:pointer;transition:all 0.2s;" onmouseover="this.style.background='rgba(239,68,68,0.3)'" onmouseout="this.style.background='rgba(239,68,68,0.15)'">❌ Kataa</button>
                            </div>` : `<span style="color:#6b7280;font-size:0.82rem;">—</span>`}
                        </td>
                    </tr>
                `).join('');

                listEl.innerHTML = `
                    <table style="width:100%;border-collapse:collapse;">
                        <thead>
                            <tr style="background:rgba(255,255,255,0.02);">
                                <th style="padding:12px 20px;text-align:left;color:#9ca3af;font-size:0.75rem;text-transform:uppercase;letter-spacing:0.5px;">Mtumiaji</th>
                                <th style="padding:12px 20px;text-align:left;color:#9ca3af;font-size:0.75rem;text-transform:uppercase;letter-spacing:0.5px;">Kiasi</th>
                                <th style="padding:12px 20px;text-align:left;color:#9ca3af;font-size:0.75rem;text-transform:uppercase;letter-spacing:0.5px;">Namba ya Kulipwa</th>
                                <th style="padding:12px 20px;text-align:left;color:#9ca3af;font-size:0.75rem;text-transform:uppercase;letter-spacing:0.5px;">Hali</th>
                                <th style="padding:12px 20px;text-align:left;color:#9ca3af;font-size:0.75rem;text-transform:uppercase;letter-spacing:0.5px;">Tarehe</th>
                                <th style="padding:12px 20px;text-align:left;color:#9ca3af;font-size:0.75rem;text-transform:uppercase;letter-spacing:0.5px;">Vitendo</th>
                            </tr>
                        </thead>
                        <tbody>${rows}</tbody>
                    </table>
                `;

            } catch (err) {
                console.error('loadWithdrawals error:', err);
                listEl.innerHTML = '<div style="color:#ef4444;padding:30px;text-align:center;">Hitilafu ya kupakia maombi. Jaribu tena.</div>';
            }
        },

        approveWithdrawal: async function (id) {
            if (!confirm('Una uhakika kutaka KUBALI ombi hili la kutoa pesa?')) return;
            try {
                const res = await fetch(`/api/withdrawals/${id}/approve`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + sessionStorage.getItem('rajab_admin_token') },
                    body: JSON.stringify({ note: 'Imekubaliwa na admin' })
                });
                const data = await res.json();
                if (data.success) {
                    // Flash green toast
                    this._toast('✅ Ombi limekubaliwa! Balance imekuwa 0.', '#4ade80');
                    this.loadWithdrawals();
                } else {
                    this._toast('❌ ' + (data.error || 'Hitilafu'), '#ef4444');
                }
            } catch (err) {
                console.error('approveWithdrawal error:', err);
                this._toast('❌ Tatizo la mtandao', '#ef4444');
            }
        },

        rejectWithdrawal: async function (id) {
            const reason = prompt('Sababu ya kukataa (optional):') || '';
            if (reason === null) return; // user cancelled
            try {
                const res = await fetch(`/api/withdrawals/${id}/reject`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + sessionStorage.getItem('rajab_admin_token') },
                    body: JSON.stringify({ reason })
                });
                const data = await res.json();
                if (data.success) {
                    this._toast('Ombi limekataliwa.', '#f59e0b');
                    this.loadWithdrawals();
                } else {
                    this._toast('❌ ' + (data.error || 'Hitilafu'), '#ef4444');
                }
            } catch (err) {
                console.error('rejectWithdrawal error:', err);
                this._toast('❌ Tatizo la mtandao', '#ef4444');
            }
        },

        _toast: function (message, color = '#4ade80') {
            const existing = document.getElementById('wd-toast');
            if (existing) existing.remove();
            const t = document.createElement('div');
            t.id = 'wd-toast';
            t.style.cssText = `position:fixed;bottom:30px;right:30px;background:#111217;border:1px solid ${color};color:${color};padding:14px 22px;border-radius:12px;font-weight:700;font-size:0.9rem;z-index:9999;box-shadow:0 8px 30px rgba(0,0,0,0.5);animation:fadeIn 0.3s ease;`;
            t.textContent = message;
            document.body.appendChild(t);
            setTimeout(() => t.remove(), 3500);
        }

        };

        // Restore session based on the ACTUAL Firebase Auth state — not just a
        // saved token. Firestore reads (users, admins, etc.) require an active
        // Firebase session, so if it's gone we must show the login again.
        onAuthStateChanged(auth, (user) => {
            const overlay = document.getElementById('login-overlay');
            const tok = sessionStorage.getItem('rajab_admin_token');
            if (user && tok) {
                if (overlay) overlay.style.display = 'none';
                adminApp.token = tok;
                adminApp.navigate('dashboard');

                // 🟢 START REAL-TIME ADMIN LISTENERS
                if (!adminApp._realtimeStarted) {
                    adminApp._realtimeStarted = true;
                    adminApp._unsubs = adminApp._unsubs || [];

                    const unsubPayments = api.listenToPayments((payments) => {
                        // Optionally sort/cache globally if needed, then trigger re-render
                        if (adminApp.currentViewId === 'dashboard') adminApp.loadDashboard();
                        else if (adminApp.currentViewId === 'payments') adminApp.loadPayments();
                    });
                    
                    const unsubWithdrawals = api.listenToWithdrawals((withdrawals) => {
                        if (adminApp.currentViewId === 'withdrawals') adminApp.loadWithdrawals();
                    });

                    adminApp._unsubs.push(unsubPayments, unsubWithdrawals);
                }
            } else {
                // No active Firebase session — clear stale token and prompt login.
                if (!user) sessionStorage.removeItem('rajab_admin_token');
                if (overlay) overlay.style.display = 'flex';
                adminApp._realtimeStarted = false;
            }
        });

        // Clear session on logout
        const _origLogout = adminApp.logout ? adminApp.logout.bind(adminApp) : null;
        adminApp.logout = function() {
            sessionStorage.removeItem('rajab_admin_token');
            
            // 🟢 STOP REAL-TIME LISTENERS TO PREVENT BANDWIDTH LEAKS
            if (adminApp._unsubs) {
                adminApp._unsubs.forEach(unsub => { if (typeof unsub === 'function') unsub(); });
                adminApp._unsubs = [];
            }
            adminApp._realtimeStarted = false;

            if (_origLogout) _origLogout();
            else {
                adminApp.token = null;
                document.getElementById('login-overlay').style.display = 'flex';
            }
        };

        window.adminApp = adminApp;
        window.editContent = (id, type) => adminApp.openContentModal(type || 'games', id);
        window.deleteContent = (id, type) => adminApp.deleteContent(id, type);
        window.deleteUser = (id) => adminApp.deleteUser(id);

