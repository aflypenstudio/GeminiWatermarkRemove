/**
 * Gemini Watermark Remover - Batch Processing
 */

const STATE = {
    masks: {
        small: null, // { width: 48, height: 48, alphas: Float32Array }
        large: null  // { width: 96, height: 96, alphas: Float32Array }
    },
    worker: new Worker('worker.js'),
    processors: [], // Store active ImageProcessor instances
    customLogo: {
        image: null,     // HTMLImageElement - 使用者上傳的 Logo 圖片
        opacity: 0.8,    // 0.0 ~ 1.0 - Logo 透明度
        scale: 1.0       // 0.1 ~ 3.0 - Logo 縮放比例 (預設 1.0)
    },
    downloadFormat: 'png', // 'png' or 'jpeg' - 全域下載格式設定
    resizePreset: '1280x720', // '' | '1280x720' | '1920x1080' - 自動縮小預設尺寸
    keepExif: true, // 保留 EXIF
    enableSharpen: false, // 銳化
    filenamePrefix: 'R_', // 檔名前綴
    sortBy: 'name', // 'name' | 'date'
    sortOrder: 'asc', // 'asc' | 'desc'
    exifData: new Map() // 儲存每張圖片的 EXIF 資料
};

// Global DOM Elements
const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const resultsContainer = document.getElementById('resultsContainer');
const globalActions = document.getElementById('globalActions');
const downloadAllBtn = document.getElementById('downloadAllBtn');
const downloadCleanBtn = document.getElementById('downloadCleanBtn');
const batchProgress = document.getElementById('batchProgress');
const progressFill = document.getElementById('progressFill');
const progressText = document.getElementById('progressText');

// New Option Elements
const keepExifCheckbox = document.getElementById('keepExif');
const enableSharpenCheckbox = document.getElementById('enableSharpen');
const filenamePrefixInput = document.getElementById('filenamePrefix');
const sortBySelect = document.getElementById('sortBy');
const sortOrderSelect = document.getElementById('sortOrder');
const applySortBtn = document.getElementById('applySortBtn');

// =============================================================================
// EXIF Handler
// =============================================================================

/**
 * 從 ArrayBuffer 中提取 JPEG EXIF 資料
 */
function extractExifFromBuffer(buffer) {
    const view = new DataView(buffer);
    if (view.getUint16(0) !== 0xFFD8) return null; // 不是 JPEG

    let offset = 2;
    while (offset < view.byteLength) {
        const marker = view.getUint16(offset);
        if (marker === 0xFFE1) { // APP1 (EXIF)
            const length = view.getUint16(offset + 2);
            const exifData = buffer.slice(offset, offset + 2 + length);
            return new Uint8Array(exifData);
        }
        if (marker === 0xFFD9) break; // EOI
        const length = view.getUint16(offset + 2);
        offset += 2 + length;
    }
    return null;
}

/**
 * 將 EXIF 資料寫入 Blob
 */
function writeExifToBlob(canvas, exifData, mimeType) {
    return new Promise((resolve) => {
        if (!exifData) {
            canvas.toBlob(resolve, mimeType);
            return;
        }

        canvas.toBlob((blob) => {
            if (!blob || mimeType !== 'image/jpeg') {
                resolve(blob);
                return;
            }

            // 讀取 canvas blob 和 exif data，合併
            Promise.all([
                blob.arrayBuffer(),
                Promise.resolve(exifData.buffer.slice(exifData.byteOffset, exifData.byteOffset + exifData.byteLength))
            ]).then(([imgBuf, exifBuf]) => {
                // 構建新的 JPEG：SOI + EXIF + 圖像數據 + EOI
                const imgView = new DataView(imgBuf);
                const exifView = new DataView(exifBuf);

                // 找到原圖的 SOF0 (0xFFC0) 和之後的數據，提取壓縮數據
                let sosStart = -1, sosEnd = -1;
                let i = 0;
                while (i < imgView.byteLength - 1) {
                    if (imgView.getUint8(i) === 0xFF && imgView.getUint8(i + 1) === 0xDA) {
                        sosStart = i;
                        i += 2;
                        // 跳過 SOS 參數
                        let len = imgView.getUint16(i);
                        i += 2 + len;
                        // 找到 SOS 結尾 (0xFF 0xD9)
                        while (i < imgView.byteLength - 1) {
                            if (imgView.getUint8(i) === 0xFF && imgView.getUint8(i + 1) === 0xD9) {
                                sosEnd = i + 2;
                                break;
                            }
                            i++;
                        }
                        break;
                    }
                    i++;
                }

                if (sosStart === -1 || sosEnd === -1) {
                    resolve(blob);
                    return;
                }

                // 新 JPEG：SOI(2) + EXIF + SOS前數據 + SOS數據 + EOI(2)
                const result = new ArrayBuffer(2 + exifData.byteLength + sosStart + (sosEnd - sosStart - 2) + 2);
                const resultView = new Uint8Array(result);

                // 寫入 SOI
                resultView[0] = 0xFF; resultView[1] = 0xD8;
                // 寫入 EXIF
                resultView.set(exifData, 2);
                // 寫入 SOS 前數據（到 SOS 標記前）
                const imgBytes = new Uint8Array(imgBuf);
                resultView.set(imgBytes.subarray(2, sosStart), 2 + exifData.byteLength);
                // 寫入 SOS 數據（從 SOS 参数长度後開始到 EOI 前）
                const sosDataStart = sosStart + 4 + imgView.getUint16(sosStart + 2);
                resultView.set(imgBytes.subarray(sosDataStart, sosEnd), 2 + exifData.byteLength + sosStart);
                // 寫入 EOI
                const eoiPos = 2 + exifData.byteLength + sosStart + (sosEnd - sosDataStart);
                resultView[eoiPos] = 0xFF; resultView[eoiPos + 1] = 0xD9;

                resolve(new Blob([result], { type: 'image/jpeg' }));
            });
        }, mimeType);
    });
}

/**
 * 銳化滤镜 (Unsharp Mask)
 */
function applySharpen(canvas, ctx) {
    const width = canvas.width;
    const height = canvas.height;
    const imageData = ctx.getImageData(0, 0, width, height);
    const data = imageData.data;
    const strength = 0.5;

    // 創建輸出陣列
    const output = new Uint8ClampedArray(data.length);

    // 3x3 卷積核 (銳化)
    const kernel = [
        0, -1, 0,
        -1, 5, -1,
        0, -1, 0
    ];

    for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
            for (let c = 0; c < 3; c++) {
                let sum = 0;
                for (let ky = -1; ky <= 1; ky++) {
                    for (let kx = -1; kx <= 1; kx++) {
                        const idx = ((y + ky) * width + (x + kx)) * 4 + c;
                        sum += data[idx] * kernel[(ky + 1) * 3 + (kx + 1)];
                    }
                }
                const origIdx = (y * width + x) * 4 + c;
                const sharpened = data[origIdx] + (sum - data[origIdx]) * strength;
                output[origIdx] = Math.max(0, Math.min(255, sharpened));
            }
            output[(y * width + x) * 4 + 3] = data[(y * width + x) * 4 + 3]; // Alpha
        }
    }

    // 邊緣不處理
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (y === 0 || y === height - 1 || x === 0 || x === width - 1) {
                const idx = (y * width + x) * 4;
                output[idx] = data[idx];
                output[idx + 1] = data[idx + 1];
                output[idx + 2] = data[idx + 2];
                output[idx + 3] = data[idx + 3];
            }
        }
    }

    return new ImageData(output, width, height);
}

// Logo 相關 DOM 元素
const logoInput = document.getElementById('logoInput');
const logoPreview = document.getElementById('logoPreview');
const logoUploadArea = document.getElementById('logoUploadArea');
const logoOpacity = document.getElementById('logoOpacity');
const logoOpacityValue = document.getElementById('logoOpacityValue');
const logoScale = document.getElementById('logoScale');
const logoScaleValue = document.getElementById('logoScaleValue');
const logoControls = document.getElementById('logoControls');
const clearLogoBtn = document.getElementById('clearLogoBtn');

// =============================================================================
// Localization Manager
// =============================================================================

const Localization = {
    lang: 'zh-TW', // Default

    init() {
        // Auto-detect browser language
        let userLang = navigator.language || navigator.userLanguage;

        if (userLang) {
            userLang = userLang.toLowerCase();
            if (userLang.includes('zh')) {
                // Determine Traditional vs Simplified
                // zh-TW, zh-HK -> zh-TW
                // zh-CN, zh-SG -> zh-CN
                if (userLang.includes('cn') || userLang.includes('sg')) {
                    this.lang = 'zh-CN';
                } else {
                    this.lang = 'zh-TW';
                }
            } else if (userLang.startsWith('ja')) {
                this.lang = 'ja';
            } else if (userLang.startsWith('ko')) {
                this.lang = 'ko';
            } else {
                this.lang = 'en';
            }
        } else {
            this.lang = 'en';
        }

        // Validate existence, fallback to en if missing
        if (!translations[this.lang]) {
            this.lang = 'en';
        }

        // Bind Switcher
        const selector = document.getElementById('languageSelect');
        if (selector) {
            selector.value = this.lang;
            selector.addEventListener('change', (e) => {
                this.setLanguage(e.target.value);
            });
        }

        this.apply();
    },

    setLanguage(langCode) {
        if (!translations[langCode]) return;
        this.lang = langCode;
        this.apply();

        // Refresh dynamic UI (like file cards)
        reprocessAllUIStrings();
    },

    get(key) {
        return translations[this.lang][key] || key;
    },

    apply() {
        document.documentElement.lang = this.lang;
        const elements = document.querySelectorAll('[data-i18n]');
        elements.forEach(el => {
            const key = el.getAttribute('data-i18n');
            const str = this.get(key);
            if (el.getAttribute('data-i18n-html') === 'true') {
                el.innerHTML = str;
            } else {
                el.textContent = str;
            }
        });
    }
};

function reprocessAllUIStrings() {
    // Re-render strings inside existing ImageProcessor cards
    STATE.processors.forEach(p => p.updateStrings());
    // Update Logo Upload Text if empty
    updateLogoPreviewUI();
}


// =============================================================================
// Initialization & Asset Loading
// =============================================================================

async function init() {
    // Init Localization first
    Localization.init();

    // Setup Worker Listener
    STATE.worker.onmessage = (e) => {
        const { type, payload, id } = e.data;
        if (type === 'PROCESS_COMPLETE') {
            const processor = STATE.processors.find(p => p.id === id);
            if (processor) {
                processor.handleWorkerResult(payload.imageData);
            }
        } else if (type === 'PROCESS_ERROR') {
            console.error('Worker error:', payload);
            const processor = STATE.processors.find(p => p.id === id);
            if (processor) {
                processor.elements.loading.style.display = 'none';
                alert(Localization.get('processingError') + payload);
            }
        }
    };

    try {
        await Promise.all([
            loadMask('assets/mask_48.png', 'small'),
            loadMask('assets/mask_96.png', 'large')
        ]);
        console.log('Masks loaded successfully');

        // Send masks to worker
        STATE.worker.postMessage({
            type: 'INIT_MASKS',
            payload: STATE.masks
        });

        // Fetch GitHub Stars
        fetchGitHubStars();

        // Init Theme
        ThemeManager.init();

        // Init Runaway Banana Effect
        initRunawayBananaEffect();

    } catch (e) {
        console.error('Failed to load masks:', e);
        alert(Localization.get('loadAssetsError'));
    }
}

function initRunawayBananaEffect() {
    const banana = document.querySelector('.header-logo');
    if (!banana) return;

    banana.addEventListener('mouseover', () => {
        // Calculate random position (max +/- 100px from center)
        const maxX = 100;
        const maxY = 50;

        const randomX = (Math.random() - 0.5) * 2 * maxX;
        const randomY = (Math.random() - 0.5) * 2 * maxY;

        // Also add a random rotation (max +/- 45 deg)
        const randomRot = (Math.random() - 0.5) * 60;

        // Apply transform
        banana.style.transform = `translate(${randomX}px, ${randomY}px) rotate(${randomRot}deg) scale(1.1)`;
    });

    // Optional: Reset when mouse leaves header area or after timeout?
    // For now, let it stay "run away" to be playful, or reset after 1 second
    banana.addEventListener('mouseout', () => {
        setTimeout(() => {
            banana.style.transform = ''; // Reset to center
        }, 1000);
    });
}

function loadMask(url, type) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.src = url;
        img.onload = () => {
            const w = img.width;
            const h = img.height;
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = w;
            tempCanvas.height = h;
            const tCtx = tempCanvas.getContext('2d');
            tCtx.drawImage(img, 0, 0);

            const imageData = tCtx.getImageData(0, 0, w, h);
            const data = imageData.data;
            const alphas = new Float32Array(w * h);

            for (let i = 0; i < w * h; i++) {
                const r = data[i * 4];
                const g = data[i * 4 + 1];
                const b = data[i * 4 + 2];
                const maxVal = Math.max(r, Math.max(g, b));
                alphas[i] = maxVal / 255.0;
            }

            STATE.masks[type] = { width: w, height: h, alphas };
            resolve();
        };
        img.onerror = reject;
    });
}

function fetchGitHubStars() {
    const starCountElement = document.getElementById('githubStarCount');
    if (!starCountElement) return;

    fetch('https://api.github.com/repos/kevintsai1202/GeminiWatermarkRemove')
        .then(response => {
            if (!response.ok) throw new Error('Network response was not ok');
            return response.json();
        })
        .then(data => {
            starCountElement.textContent = data.stargazers_count;
        })
        .catch(error => {
            console.error('Failed to fetch GitHub stars:', error);
            starCountElement.textContent = '';
        });
}


// =============================================================================
// Image Processor Class (Per Image Logic)
// =============================================================================

class ImageProcessor {
    constructor(file) {
        this.file = file;
        this.id = Math.random().toString(36).substr(2, 9);
        this.config = {
            forceMode: 'auto',
            forcePosition: 'auto', // 浮水印位置設定，預設為 auto
            alphaGain: 0.5, // 浮水印強度增益，預設 0.5 適用最新 Gemini 浮水印
            autoStrength: true // 是否開啟自動強度偵測
        };
        this.state = {
            originalImage: null,
            processedImageData: null,
            watermarkRegion: null, // 儲存偵測到的浮水印位置與大小
            isProcessing: false
        };

        // UI Elements
        this.elements = {};

        this.init();
    }

    init() {
        this.createUI();
        this.loadImage();
    }

    createUI() {
        const card = document.createElement('div');
        card.className = 'image-card';
        // Note: Using data-i18n attributes where possible or injecting strings
        card.innerHTML = `
            <div class="image-wrapper">
                <canvas></canvas>
                <div class="loading-overlay">
                    <div class="spinner"></div>
                </div>
                <div class="comparison-overlay" data-i18n="compareTitle">${Localization.get('compareTitle')}</div>
            </div>
            
            <div class="card-controls">
                <div class="card-options">
                    <div class="control-group">
                        <select class="size-select" aria-label="浮水印大小">
                            <option value="auto" data-i18n="sizeAuto">${Localization.get('sizeAuto')}</option>
                            <option value="small" data-i18n="sizeSmall">${Localization.get('sizeSmall')}</option>
                            <option value="large" data-i18n="sizeLarge">${Localization.get('sizeLarge')}</option>
                        </select>
                    </div>
                    <div class="control-group">
                        <select class="position-select" aria-label="浮水印位置">
                            <option value="auto" data-i18n="positionAuto">${Localization.get('positionAuto')}</option>
                            <option value="new" data-i18n="positionNew">${Localization.get('positionNew')}</option>
                            <option value="old" data-i18n="positionOld">${Localization.get('positionOld')}</option>
                        </select>
                    </div>
                    <div class="control-group slider-group">
                        <label style="display: flex; justify-content: space-between; align-items: center; width: 100%;">
                            <span data-i18n="strengthLabel">${Localization.get('strengthLabel')}</span>
                            <span style="display: flex; align-items: center; gap: 0.25rem;">
                                <input type="checkbox" class="auto-strength-check" checked style="margin: 0; cursor: pointer; width: auto; height: auto;">
                                <span data-i18n="autoLabel" style="font-size: 0.85rem; opacity: 0.9;">${Localization.get('autoLabel')}</span>
                                <span class="alpha-value" style="font-weight: 600; min-width: 2rem; text-align: right;">Auto</span>
                            </span>
                        </label>
                        <input type="range" min="0.1" max="3.0" step="0.1" value="0.5" disabled>
                    </div>
                </div>

                <div class="actions" style="display: flex; gap: 1rem;">
                    <button class="btn btn-secondary compare-btn" title="${Localization.get('compareTitle')}">
                        <svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path>
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"></path>
                        </svg>
                    </button>
                    <button class="btn btn-secondary remove-btn" title="${Localization.get('removeTitle')}">
                        <svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
                        </svg>
                    </button>
                    <button class="btn btn-primary download-btn" disabled>
                        <svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path>
                        </svg>
                        <span data-i18n="downloadBtn">${Localization.get('downloadBtn')}</span>
                    </button>
                </div>
            </div>
            <div class="filename-display" title="${this.file.name}" style="text-align: center; color: var(--text-secondary); font-size: 0.9rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%;">
                ${this.file.name}
            </div>
        `;

        // Store references
        this.elements.card = card;
        this.elements.canvas = card.querySelector('canvas');
        this.elements.ctx = this.elements.canvas.getContext('2d', { willReadFrequently: true });
        this.elements.loading = card.querySelector('.loading-overlay');
        this.elements.sizeSelect = card.querySelector('.size-select');
        this.elements.positionSelect = card.querySelector('.position-select');
        this.elements.alphaInput = card.querySelector('input[type="range"]');
        this.elements.alphaValue = card.querySelector('.alpha-value');
        this.elements.autoStrengthCheck = card.querySelector('.auto-strength-check');
        this.elements.downloadBtn = card.querySelector('.download-btn');
        this.elements.removeBtn = card.querySelector('.remove-btn');
        this.elements.compareBtn = card.querySelector('.compare-btn');
        this.elements.wrapper = card.querySelector('.image-wrapper');
        this.elements.compareOverlay = card.querySelector('.comparison-overlay'); // Added ref

        // Bind Events
        this.elements.sizeSelect.addEventListener('change', (e) => {
            this.config.forceMode = e.target.value;
            this.processAndRender();
        });

        this.elements.positionSelect.addEventListener('change', (e) => {
            this.config.forcePosition = e.target.value;
            this.processAndRender();
        });

        this.elements.autoStrengthCheck.addEventListener('change', (e) => {
            const checked = e.target.checked;
            this.config.autoStrength = checked;
            this.elements.alphaInput.disabled = checked;
            if (checked) {
                this.elements.alphaValue.textContent = 'Auto';
            } else {
                const val = parseFloat(this.elements.alphaInput.value);
                this.config.alphaGain = val;
                this.elements.alphaValue.textContent = val.toFixed(2);
            }
            this.processAndRender();
        });

        this.elements.alphaInput.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value);
            this.config.alphaGain = val;
            this.elements.alphaValue.textContent = val.toFixed(2);
            this.processAndRender();
        });

        this.elements.downloadBtn.addEventListener('click', () => this.download(false));
        this.elements.removeBtn.addEventListener('click', () => this.destroy());

        // Comparison interactions
        const startCompare = (e) => {
            if (e && e.cancelable) e.preventDefault();
            if (!this.state.originalImage) return;
            this.elements.ctx.drawImage(this.state.originalImage, 0, 0);

            // Add label
            const label = document.createElement('div');
            label.className = 'status-label';
            label.textContent = Localization.get('originalLabel');
            this.elements.wrapper.appendChild(label);
        };

        const endCompare = () => {
            if (!this.state.processedImageData) return;
            this.elements.ctx.putImageData(this.state.processedImageData, 0, 0);

            const label = this.elements.wrapper.querySelector('.status-label');
            if (label) label.remove();
        };

        // Manual Compare Button
        this.elements.compareBtn.addEventListener('mousedown', startCompare);
        this.elements.compareBtn.addEventListener('mouseup', endCompare);
        this.elements.compareBtn.addEventListener('mouseleave', endCompare);
        this.elements.compareBtn.addEventListener('touchstart', (e) => {
            e.preventDefault();
            startCompare(e);
        }, { passive: false });
        this.elements.compareBtn.addEventListener('touchend', endCompare);

        // Interaction Logic: Click vs Long Press
        let pressTimer;
        let isLongPress = false;
        const longPressDuration = 250; // ms

        const startPress = (e) => {
            // Only left click or touch
            if (e.type === 'mousedown' && e.button !== 0) return;

            isLongPress = false;
            pressTimer = setTimeout(() => {
                isLongPress = true;
                startCompare(e); // Trigger comparison
            }, longPressDuration);
        };

        const endPress = (e) => {
            clearTimeout(pressTimer);

            if (isLongPress) {
                // Was a long press -> End comparison
                endCompare();
            } else {
                // Was a short click -> Open Lightbox
                console.log(Localization.get('shortClick'));
                if (typeof Lightbox !== 'undefined') {
                    Lightbox.open(this.state.processedImageData, this.state.originalImage, this);
                } else {
                    console.error('Lightbox is undefined');
                }
            }
            isLongPress = false;
        };

        const cancelPress = () => {
            clearTimeout(pressTimer);
            if (isLongPress) endCompare();
            isLongPress = false;
        };

        // prevent context menu on mobile
        this.elements.wrapper.oncontextmenu = (e) => {
            e.preventDefault();
            e.stopPropagation();
            return false;
        };

        this.elements.wrapper.addEventListener('mousedown', startPress);
        this.elements.wrapper.addEventListener('touchstart', (e) => {
            // e.preventDefault(); // Might block scrolling? Test carefully.
            // Usually better not to preventDefault on start unless we handle scroll
            startPress(e);
        }, { passive: true });

        this.elements.wrapper.addEventListener('mouseup', endPress);
        this.elements.wrapper.addEventListener('touchend', endPress);

        this.elements.wrapper.addEventListener('mouseleave', cancelPress);
        // touchcancel?

        // Append to DOM
        resultsContainer.appendChild(card);

        // Update UI State
        updateUIState();
    }

    updateStrings() {
        // Method to refresh strings when language changes
        const l = Localization;
        // Text Content
        this.elements.compareOverlay.textContent = l.get('compareTitle');
        this.elements.card.querySelector('[data-i18n="sizeAuto"]').textContent = l.get('sizeAuto');
        this.elements.card.querySelector('[data-i18n="sizeSmall"]').textContent = l.get('sizeSmall');
        this.elements.card.querySelector('[data-i18n="sizeLarge"]').textContent = l.get('sizeLarge');
        this.elements.card.querySelector('[data-i18n="positionAuto"]').textContent = l.get('positionAuto');
        this.elements.card.querySelector('[data-i18n="positionNew"]').textContent = l.get('positionNew');
        this.elements.card.querySelector('[data-i18n="positionOld"]').textContent = l.get('positionOld');
        this.elements.card.querySelector('[data-i18n="strengthLabel"]').textContent = l.get('strengthLabel');
        this.elements.card.querySelector('[data-i18n="autoLabel"]').textContent = l.get('autoLabel');
        this.elements.card.querySelector('[data-i18n="downloadBtn"]').textContent = l.get('downloadBtn');

        // Titles
        this.elements.compareBtn.title = l.get('compareTitle');
        this.elements.removeBtn.title = l.get('removeTitle');
    }

    loadImage() {
        if (!this.file) return;

        // 保存原始文件以提取 EXIF
        this.file.arrayBuffer().then(buffer => {
            // 嘗試提取 EXIF（僅 JPEG）
            const exif = extractExifFromBuffer(buffer);
            if (exif) {
                STATE.exifData.set(this.id, exif);
            }

            const reader = new FileReader();
            reader.onload = (e) => {
                const img = new Image();
                img.onload = () => {
                    this.state.originalImage = img;
                    this.processAndRender();
                };
                img.src = e.target.result;
            };
            reader.readAsDataURL(this.file);
        });
    }

    processAndRender() {
        if (!this.state.originalImage) return;

        // Show Loading
        this.elements.loading.style.display = 'flex';

        setTimeout(() => {
            const img = this.state.originalImage;
            const canvas = this.elements.canvas;

            // Set canvas size
            canvas.width = img.width;
            canvas.height = img.height;

            // Draw original
            this.elements.ctx.drawImage(img, 0, 0);

            // Get Data
            const imageData = this.elements.ctx.getImageData(0, 0, canvas.width, canvas.height);

            // Send to Worker
            STATE.worker.postMessage({
                type: 'PROCESS_IMAGE',
                payload: {
                    imageData: imageData,
                    config: this.config,
                    id: this.id
                }
            }, [imageData.data.buffer]); // Transfer buffer

        }, 50);
    }

    handleWorkerResult(processedImageData, watermarkRegion, appliedGain) {
        const canvas = this.elements.canvas;
        this.state.watermarkRegion = watermarkRegion || null;

        // 如果是自動強度偵測，更新 UI 的 Label 和 Slider 值
        if (this.config.autoStrength && appliedGain !== undefined) {
            this.config.alphaGain = appliedGain;
            this.elements.alphaValue.textContent = `Auto (${appliedGain.toFixed(2)})`;
            this.elements.alphaInput.value = appliedGain;
        }

        // Put Back (after watermark removal)
        this.elements.ctx.putImageData(processedImageData, 0, 0);

        // 保存純淨版（不含 Logo）- 用於純淨版下載
        this.state.cleanImageData = this.elements.ctx.getImageData(0, 0, canvas.width, canvas.height);

        // 疊加自訂 Logo（如果有設定的話）
        this.applyCustomLogo();

        // 重新取得最終 ImageData（包含 Logo）
        const finalImageData = this.elements.ctx.getImageData(0, 0, canvas.width, canvas.height);

        // Update State
        this.state.processedImageData = finalImageData;
        this.elements.loading.style.display = 'none';
        this.elements.downloadBtn.disabled = false;
    }

    /**
     * 疊加自訂 Logo 到圖片右下角
     * Logo 會自動縮放以配合圖片比例，並套用透明度
     * 大小基於原圖寬度的 3%~15%（scale 10%~300% 對應此範圍）
     */
    applyCustomLogo() {
        if (!STATE.customLogo.image) return;

        const canvas = this.elements.canvas;
        const ctx = this.elements.ctx;
        const logo = STATE.customLogo.image;
        const opacity = STATE.customLogo.opacity;

        const w = canvas.width;
        const h = canvas.height;
        const userScale = STATE.customLogo.scale; // 0.1 ~ 3.0

        // 基於原圖寬度計算 Logo 大小
        // scale 10%  → 原圖寬度 3%
        // scale 100% → 原圖寬度 5%
        // scale 300% → 原圖寬度 15%
        const minPercent = 0.03;  // 最低 3% 圖寬
        const maxPercent = 0.15;  // 最高 15% 圖寬
        const percentRange = maxPercent - minPercent;

        // 將 scale 0.1~3.0 映射到 minPercent~maxPercent
        const logoPercent = minPercent + percentRange * ((userScale - 0.1) / 2.9);
        const targetSize = w * logoPercent;

        // 計算縮放比例（保持寬高比，以 targetSize 為最大邊）
        const scale = Math.min(targetSize / logo.width, targetSize / logo.height);
        const scaledWidth = logo.width * scale;
        const scaledHeight = logo.height * scale;

        // 計算位置（右下角，間距為圖寬的 2%）
        const margin = w * 0.02;
        const posX = w - margin - scaledWidth;
        const posY = h - margin - scaledHeight;

        if (posX < 0 || posY < 0) return;

        // 繪製 Logo
        ctx.save();
        ctx.globalAlpha = opacity;
        ctx.drawImage(logo, posX, posY, scaledWidth, scaledHeight);
        ctx.restore();
    }

    /**
     * 取得要下載的圖像資料
     * @param {boolean} isClean - 是否為純淨版（不含 Logo）
     */
    getImageForDownload(isClean) {
        if (isClean) {
            return this.state.cleanImageData || this.state.processedImageData;
        }
        return this.state.processedImageData;
    }

    /**
     * 下載圖片
     * @param {boolean} isClean - 是否為純淨版（不含 Logo）
     */
    download(isClean = false) {
        const imageData = this.getImageForDownload(isClean);
        if (!imageData) return;

        const format = STATE.downloadFormat;
        const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png';
        const ext = format === 'jpeg' ? '.jpg' : '.png';
        const quality = format === 'jpeg' ? 0.85 : undefined;

        // 建立臨時 canvas 來處理圖片
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = imageData.width;
        tempCanvas.height = imageData.height;
        const tempCtx = tempCanvas.getContext('2d');

        // 繪製 ImageData
        tempCtx.putImageData(imageData, 0, 0);

        // 應用銳化（如果啟用）
        if (STATE.enableSharpen && !isClean) {
            const sharpened = applySharpen(tempCanvas, tempCtx);
            tempCtx.putImageData(sharpened, 0, 0);
        }

        // 處理縮放
        let outputCanvas = tempCanvas;
        const preset = STATE.resizePreset;
        if (preset) {
            const isLandscape = outputCanvas.width > outputCanvas.height;
            let targetW, targetH;

            if (preset === '1920x1080') {
                targetW = isLandscape ? 1920 : 1080;
                targetH = isLandscape ? 1080 : 1920;
            } else {
                targetW = isLandscape ? 1280 : 720;
                targetH = isLandscape ? 720 : 1280;
            }

            const resizedCanvas = document.createElement('canvas');
            resizedCanvas.width = targetW;
            resizedCanvas.height = targetH;
            const ctx = resizedCanvas.getContext('2d');
            ctx.drawImage(outputCanvas, 0, 0, targetW, targetH);
            outputCanvas = resizedCanvas;
        }

        // 取得 EXIF 資料（僅 JPEG + 保留 EXIF 選項）
        const exif = (STATE.keepExif && format === 'jpeg')
            ? STATE.exifData.get(this.id)
            : null;

        // 下載
        writeExifToBlob(outputCanvas, exif, mimeType).then((blob) => {
            if (!blob) return;
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');

            // 構建檔名
            const nameParts = this.file.name.split('.');
            nameParts.pop();
            const suffix = isClean ? '' : (Localization.get('cleanSuffix') || '_clean');
            const w = outputCanvas.width;
            const h = outputCanvas.height;
            const dirPrefix = w > h ? 'R_' : 'S_';
            // 優先從 DOM 讀取，確保獲取最新值
            const userPrefix = (filenamePrefixInput ? filenamePrefixInput.value : STATE.filenamePrefix) || '';

            link.download = `${userPrefix}${dirPrefix}${nameParts.join('.')}${suffix}${ext}`;

            link.href = url;
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        });
    }

    destroy() {
        // Remove from UI
        this.elements.card.remove();

        // Remove from Global List
        STATE.processors = STATE.processors.filter(p => p !== this);

        // Update UI State
        updateUIState();
    }
}

// =============================================================================
// Global Event Handlers
// =============================================================================

function handleFiles(fileList) {
    if (!fileList || fileList.length === 0) return;

    Array.from(fileList).forEach(file => {
        if (file.type.startsWith('image/')) {
            const processor = new ImageProcessor(file);
            STATE.processors.push(processor);
        }
    });

    // Reset file input so same file can be selected again if needed
    fileInput.value = '';

    updateUIState();
}

function updateUIState() {
    if (STATE.processors.length > 0) {
        document.body.classList.add('has-files');
        globalActions.style.display = 'flex';
    } else {
        document.body.classList.remove('has-files');
        globalActions.style.display = 'none';
    }
}

// Drag & Drop
dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
    // Optional: update text to "Released to Upload"
});

dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('drag-over');
});

dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    if (e.dataTransfer.files.length > 0) {
        handleFiles(e.dataTransfer.files);
    }
});



dropZone.addEventListener('click', (e) => {
    // 點擊圖片卡片時不觸發上傳（保留卡片內的操作功能）
    // 但點擊 results-container 的空白區域時仍可上傳新圖片
    if (e.target.closest('.image-card')) return;
    fileInput.click();
});

fileInput.addEventListener('change', (e) => {
    handleFiles(e.target.files);
});

// =============================================================================
// Clipboard Paste Support
// =============================================================================

window.addEventListener('paste', (e) => {
    if (!e.clipboardData || !e.clipboardData.items) return;

    const items = e.clipboardData.items;
    const files = [];

    for (let i = 0; i < items.length; i++) {
        if (items[i].type.indexOf('image') !== -1) {
            const blob = items[i].getAsFile();
            // Assign a default name for pasted images
            // You can enhance this by timestamp or count based names
            if (!blob.name || blob.name === 'image.png') {
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                blob.name = `pasted-image-${timestamp}.png`;
            }
            files.push(blob);
        }
    }

    if (files.length > 0) {
        handleFiles(files);
    }
});


// =============================================================================
// Download Functions
// =============================================================================

/**
 * 批次下載所有圖片
 * @param {boolean} isClean - 是否為純淨版（不含 Logo）
 */
async function downloadAll(isClean = false) {
    if (STATE.processors.length === 0) return;

    // 禁用按鈕並顯示進度條
    const btn = isClean ? downloadCleanBtn : downloadAllBtn;
    const folderName = isClean ? 'gemini_clean_only' : 'gemini_with_logo';

    if (btn) {
        btn.disabled = true;
        btn.innerHTML = `<span>${Localization.get('progressLabel') || '處理中...'}</span>`;
    }
    if (batchProgress) batchProgress.style.display = 'flex';

    // 無 JSZip 時降級到依序下載
    if (typeof JSZip === 'undefined') {
        let delay = 0;
        STATE.processors.forEach((p, i) => {
            setTimeout(() => {
                p.download(isClean);
                updateProgress(i + 1, STATE.processors.length);
            }, delay);
            delay += 500;
        });
        setTimeout(() => {
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = isClean
                    ? '<span data-i18n="downloadClean">純淨版</span>'
                    : '<span data-i18n="downloadAll">含 Logo 版</span>';
            }
            if (batchProgress) batchProgress.style.display = 'none';
            Localization.apply();
        }, STATE.processors.length * 500 + 1000);
        return;
    }

    const zip = new JSZip();
    const folder = zip.folder(folderName);
    const usedNames = new Set();

    try {
        const total = STATE.processors.length;
        const completed = { count: 0 };

        const promises = STATE.processors.map(p => new Promise(async (resolve) => {
            const imageData = p.getImageForDownload(isClean);
            if (!imageData) {
                updateProgress(++completed.count, total);
                resolve(false);
                return;
            }

            const format = STATE.downloadFormat;
            const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png';
            const ext = format === 'jpeg' ? '.jpg' : '.png';
            const quality = format === 'jpeg' ? 0.85 : undefined;

            // 建立臨時 canvas
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = imageData.width;
            tempCanvas.height = imageData.height;
            const tempCtx = tempCanvas.getContext('2d');
            tempCtx.putImageData(imageData, 0, 0);

            // 銳化（如果啟用）
            if (STATE.enableSharpen && !isClean) {
                const sharpened = applySharpen(tempCanvas, tempCtx);
                tempCtx.putImageData(sharpened, 0, 0);
            }

            // 縮放
            let outputCanvas = tempCanvas;
            const preset = STATE.resizePreset;
            if (preset) {
                const isLandscape = outputCanvas.width > outputCanvas.height;
                let targetW = isLandscape ? 1920 : 1080;
                let targetH = isLandscape ? 1080 : 1920;
                if (preset === '1280x720') {
                    targetW = isLandscape ? 1280 : 720;
                    targetH = isLandscape ? 720 : 1280;
                }
                const resized = document.createElement('canvas');
                resized.width = targetW;
                resized.height = targetH;
                resized.getContext('2d').drawImage(outputCanvas, 0, 0, targetW, targetH);
                outputCanvas = resized;
            }

            // EXIF
            const exif = (STATE.keepExif && format === 'jpeg') ? STATE.exifData.get(p.id) : null;

            // 構建檔名
            const nameParts = p.file.name.split('.');
            nameParts.pop();
            const suffix = isClean ? '' : (Localization.get('cleanSuffix') || '_clean');
            let filename = `${nameParts.join('.')}${suffix}${ext}`;

            if (usedNames.has(filename)) {
                let counter = 1;
                const basePart = filename.substring(0, filename.lastIndexOf(suffix));
                const extStart = filename.lastIndexOf(ext);
                while (usedNames.has(filename)) {
                    filename = `${basePart}_${counter}${suffix}${ext}`;
                    counter++;
                }
            }
            usedNames.add(filename);

            const fw = outputCanvas.width;
            const fh = outputCanvas.height;
            const dirPrefix = fw > fh ? 'R_' : 'S_';
            // 優先從 DOM 讀取，確保獲取最新值
            const userPrefix = (filenamePrefixInput ? filenamePrefixInput.value : STATE.filenamePrefix) || '';
            filename = `${userPrefix}${dirPrefix}${filename}`;

            const blob = await writeExifToBlob(outputCanvas, exif, mimeType);
            if (blob) folder.file(filename, blob);

            updateProgress(++completed.count, total);
            resolve(true);
        }));

        await Promise.all(promises);

        const content = await zip.generateAsync({ type: 'blob' });
        const url = URL.createObjectURL(content);
        const link = document.createElement('a');
        link.download = `gemini_${folderName}_${Date.now()}.zip`;
        link.href = url;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);

    } catch (err) {
        console.error('ZIP generation failed:', err);
        alert('建立 ZIP 失敗，已改為個別下載。');
        // 降級到依序下載
        STATE.processors.forEach(p => p.download(isClean));
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = isClean
                ? `<svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path></svg><span data-i18n="downloadClean">純淨版</span>`
                : `<svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path></svg><span data-i18n="downloadAll">含 Logo 版</span>`;
            Localization.apply();
        }
        if (batchProgress) batchProgress.style.display = 'none';
        updateProgress(0, 0);
    }
}

/**
 * 更新批次下載進度條
 */
function updateProgress(current, total) {
    if (!progressFill || !progressText) return;
    if (total === 0) {
        progressFill.style.width = '0%';
        progressText.textContent = '';
        return;
    }
    const pct = Math.round((current / total) * 100);
    progressFill.style.width = pct + '%';
    progressText.textContent = `${current}/${total} (${pct}%)`;
}

// 按鈕事件：含 Logo 版下載（點擊卡片下載按鈕也走這條）
downloadAllBtn.addEventListener('click', () => downloadAll(false));

// 按鈕事件：純淨版下載（需要確保元素存在）
if (downloadCleanBtn) {
    downloadCleanBtn.addEventListener('click', () => downloadAll(true));
}

function reprocessAllImages() {
    STATE.processors.forEach(p => {
        p.processAndRender();
    });
}

// Download Format Selector
const downloadFormatSelect = document.getElementById('downloadFormat');
if (downloadFormatSelect) {
    downloadFormatSelect.addEventListener('change', (e) => {
        STATE.downloadFormat = e.target.value;
    });
}

const resizePresetSelect = document.getElementById('resizePreset');
if (resizePresetSelect) {
    resizePresetSelect.addEventListener('change', (e) => {
        STATE.resizePreset = e.target.value;
    });
}

// EXIF 保留設定
if (keepExifCheckbox) {
    keepExifCheckbox.addEventListener('change', (e) => {
        STATE.keepExif = e.target.checked;
    });
    keepExifCheckbox.checked = STATE.keepExif;
}

// 銳化設定
if (enableSharpenCheckbox) {
    enableSharpenCheckbox.addEventListener('change', (e) => {
        STATE.enableSharpen = e.target.checked;
    });
}

// 檔名前綴設定
if (filenamePrefixInput) {
    filenamePrefixInput.addEventListener('input', (e) => {
        STATE.filenamePrefix = e.target.value;
    });
}

// =============================================================================
// 圖片排序功能
// =============================================================================

function applySort() {
    const sortBy = STATE.sortBy;
    const sortOrder = STATE.sortOrder;

    STATE.processors.sort((a, b) => {
        let valA, valB;
        if (sortBy === 'name') {
            valA = a.file.name.toLowerCase();
            valB = b.file.name.toLowerCase();
        } else {
            // 依時間：使用 lastModified 或 Date.now()
            valA = a.file.lastModified || 0;
            valB = b.file.lastModified || 0;
        }

        if (sortOrder === 'asc') {
            return valA < valB ? -1 : (valA > valB ? 1 : 0);
        } else {
            return valA > valB ? -1 : (valA < valB ? 1 : 0);
        }
    });

    // 重新渲染順序（移除並重新加入 DOM）
    resultsContainer.innerHTML = '';
    STATE.processors.forEach(p => {
        resultsContainer.appendChild(p.elements.card);
    });
}

// 排序設定事件
if (sortBySelect) {
    sortBySelect.addEventListener('change', (e) => {
        STATE.sortBy = e.target.value;
    });
}

if (sortOrderSelect) {
    sortOrderSelect.addEventListener('change', (e) => {
        STATE.sortOrder = e.target.value;
    });
}

if (applySortBtn) {
    applySortBtn.addEventListener('click', applySort);
}

// =============================================================================
// Logo 上傳與處理邏輯
// =============================================================================

/**
 * 更新 Logo 預覽 UI
 * 根據 STATE.customLogo.image 是否存在來切換顯示狀態
 */
function updateLogoPreviewUI() {
    const logoThumbnail = document.getElementById('logoThumbnail');
    const logoThumbnailImg = document.getElementById('logoThumbnailImg');

    if (STATE.customLogo.image) {
        // 顯示 Logo 預覽圖片（套用透明度效果）
        const opacity = STATE.customLogo.opacity;
        logoPreview.innerHTML = `<img src="${STATE.customLogo.image.src}" alt="Logo Preview" style="opacity: ${opacity}">`;
        logoPreview.classList.add('has-logo');
        logoControls.style.display = 'block';
        clearLogoBtn.style.display = 'flex';

        // 更新縮圖指示器
        if (logoThumbnail && logoThumbnailImg) {
            logoThumbnailImg.src = STATE.customLogo.image.src;
            logoThumbnail.style.display = 'block';
        }
    } else {
        // 恢復上傳提示
        logoPreview.innerHTML = `
            <svg class="upload-icon" width="32" height="32" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" 
                    d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"></path>
            </svg>
            <span class="upload-text" data-i18n="uploadLogo">${Localization.get('uploadLogo')}</span>
        `;
        logoPreview.classList.remove('has-logo');
        logoControls.style.display = 'none';
        clearLogoBtn.style.display = 'none';

        // 隱藏縮圖指示器
        if (logoThumbnail) {
            logoThumbnail.style.display = 'none';
        }
    }
}

/**
 * 重新處理所有已上傳的圖片
 * 當 Logo 或透明度變更時呼叫
 */
function reprocessAllImages() {
    STATE.processors.forEach(p => {
        p.processAndRender();
    });
}

// =============================================================================
// Logo 設定區塊展開/收合邏輯
// =============================================================================

const logoSettings = document.getElementById('logoSettings');
const logoToggleHeader = document.getElementById('logoToggleHeader');

if (logoToggleHeader) {
    logoToggleHeader.addEventListener('click', (e) => {
        // 如果點擊的是清除按鈕，不觸發展開/收合
        if (e.target.closest('#clearLogoBtn')) return;

        logoSettings.classList.toggle('collapsed');
    });
}

// Output Settings 折疊/展開
const outputSettings = document.getElementById('outputSettings');
const outputToggleHeader = document.getElementById('outputToggleHeader');

if (outputToggleHeader) {
    outputToggleHeader.addEventListener('click', (e) => {
        outputSettings.classList.toggle('collapsed');
    });
}

// Logo 上傳區域點擊事件
logoUploadArea.addEventListener('click', () => {
    logoInput.click();
});

// Logo 檔案選擇事件
logoInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file || !file.type.startsWith('image/')) return;

    const reader = new FileReader();
    reader.onload = (event) => {
        const img = new Image();
        img.onload = () => {
            STATE.customLogo.image = img;
            updateLogoPreviewUI();
            reprocessAllImages();
        };
        img.src = event.target.result;
    };
    reader.readAsDataURL(file);

    // 重置 input 以便重複選擇同一檔案
    logoInput.value = '';
});

// Logo 透明度滑桿變更事件
logoOpacity.addEventListener('input', (e) => {
    const value = parseInt(e.target.value);
    STATE.customLogo.opacity = value / 100;
    logoOpacityValue.textContent = `${value}%`;

    // 即時更新 Logo 預覽的透明度
    const previewImg = logoPreview.querySelector('img');
    if (previewImg) {
        previewImg.style.opacity = STATE.customLogo.opacity;
    }

    reprocessAllImages();
});

// Logo 大小滑桿變更事件
logoScale.addEventListener('input', (e) => {
    const value = parseInt(e.target.value);
    STATE.customLogo.scale = value / 100;
    logoScaleValue.textContent = `${value}%`;
    reprocessAllImages();
});

// 清除 Logo 按鈕事件
clearLogoBtn.addEventListener('click', () => {
    STATE.customLogo.image = null;
    STATE.customLogo.opacity = 0.8;
    STATE.customLogo.scale = 1.0;
    logoOpacity.value = 80;
    logoOpacityValue.textContent = '80%';
    logoScale.value = 100;
    logoScaleValue.textContent = '100%';
    updateLogoPreviewUI();
    reprocessAllImages();
});

// =============================================================================
// Lightbox Controller
// =============================================================================
const Lightbox = {
    elements: {
        modal: document.getElementById('lightbox'),
        img: document.getElementById('lightboxImage'),
        close: document.querySelector('.lightbox-close'),
        prev: document.getElementById('lightboxPrev'),
        next: document.getElementById('lightboxNext')
    },
    activeOriginal: null,
    activeProcessed: null,
    currentIndex: -1,  // 當前顯示圖片的索引

    /**
     * 初始化 Lightbox 控制器
     * 綁定關閉、導航箭頭與鍵盤事件
     */
    init() {
        console.log('Lightbox initializing, modal found:', !!this.elements.modal);
        if (!this.elements.modal) return;

        this.elements.close.onclick = () => this.close();
        this.elements.modal.onclick = (e) => {
            if (e.target === this.elements.modal) this.close();
        };

        // 導航箭頭點擊事件
        if (this.elements.prev) {
            this.elements.prev.onclick = (e) => {
                e.stopPropagation();
                this.navigate(-1);
            };
        }
        if (this.elements.next) {
            this.elements.next.onclick = (e) => {
                e.stopPropagation();
                this.navigate(1);
            };
        }

        // 鍵盤事件：Escape 關閉, 左右方向鍵導航
        document.addEventListener('keydown', (e) => {
            if (this.elements.modal.style.display !== 'flex') return;

            if (e.key === 'Escape') {
                this.close();
            } else if (e.key === 'ArrowLeft') {
                this.navigate(-1);
            } else if (e.key === 'ArrowRight') {
                this.navigate(1);
            }
        });

        // Long Press comparison in Lightbox
        const start = (e) => {
            if (e.type === 'mousedown' && e.button !== 0) return;
            if (this.activeOriginal) {
                this.elements.img.src = this.activeOriginal.src;
            }
        };
        const end = (e) => {
            if (this.activeProcessed) {
                this.elements.img.src = this.activeProcessed;
            }
        };

        this.elements.img.addEventListener('mousedown', start);
        this.elements.img.addEventListener('touchstart', start);
        this.elements.img.addEventListener('mouseup', end);
        this.elements.img.addEventListener('touchend', end);
        this.elements.img.addEventListener('mouseleave', end);
    },

    /**
     * 開啟 Lightbox 顯示圖片
     * @param {ImageData} processedImageData - 處理後的圖片資料
     * @param {HTMLImageElement} originalImage - 原始圖片
     * @param {ImageProcessor} processor - 圖片處理器實例（用於確定索引）
     */
    open(processedImageData, originalImage, processor) {
        if (!processedImageData || !originalImage) return;

        // 找到當前圖片在 processors 陣列中的索引
        if (processor) {
            this.currentIndex = STATE.processors.indexOf(processor);
        } else {
            this.currentIndex = -1;
        }

        // Clone/Store original
        this.activeOriginal = originalImage;

        // Convert Processed ImageData to DataURL for <img>
        const canvas = document.createElement('canvas');
        canvas.width = processedImageData.width;
        canvas.height = processedImageData.height;
        const ctx = canvas.getContext('2d');
        ctx.putImageData(processedImageData, 0, 0);
        this.activeProcessed = canvas.toDataURL();

        // Set content
        this.elements.img.src = this.activeProcessed;
        this.elements.modal.style.display = 'flex';

        // 更新導航箭頭顯示狀態
        this.updateNavVisibility();
    },

    /**
     * 導航到上一張或下一張圖片
     * @param {number} direction - -1 表示上一張，1 表示下一張
     */
    navigate(direction) {
        const total = STATE.processors.length;
        if (total <= 1) return;

        const newIndex = this.currentIndex + direction;

        // 邊界檢查
        if (newIndex < 0 || newIndex >= total) return;

        const targetProcessor = STATE.processors[newIndex];
        if (!targetProcessor || !targetProcessor.state.processedImageData) return;

        // 更新當前索引
        this.currentIndex = newIndex;

        // 更新顯示的圖片
        this.activeOriginal = targetProcessor.state.originalImage;

        const canvas = document.createElement('canvas');
        canvas.width = targetProcessor.state.processedImageData.width;
        canvas.height = targetProcessor.state.processedImageData.height;
        const ctx = canvas.getContext('2d');
        ctx.putImageData(targetProcessor.state.processedImageData, 0, 0);
        this.activeProcessed = canvas.toDataURL();

        this.elements.img.src = this.activeProcessed;

        // 更新導航箭頭顯示狀態
        this.updateNavVisibility();
    },

    /**
     * 更新導航箭頭的顯示狀態
     * 第一張只顯示右箭頭，最後一張只顯示左箭頭
     */
    updateNavVisibility() {
        const total = STATE.processors.length;

        if (!this.elements.prev || !this.elements.next) return;

        // 只有一張或沒有圖片時，隱藏所有箭頭
        if (total <= 1) {
            this.elements.prev.classList.add('hidden');
            this.elements.next.classList.add('hidden');
            return;
        }

        // 第一張：隱藏左箭頭
        if (this.currentIndex <= 0) {
            this.elements.prev.classList.add('hidden');
        } else {
            this.elements.prev.classList.remove('hidden');
        }

        // 最後一張：隱藏右箭頭
        if (this.currentIndex >= total - 1) {
            this.elements.next.classList.add('hidden');
        } else {
            this.elements.next.classList.remove('hidden');
        }
    },

    /**
     * 關閉 Lightbox
     */
    close() {
        this.elements.modal.style.display = 'none';
        this.elements.img.src = '';
        this.activeOriginal = null;
        this.activeProcessed = null;
        this.currentIndex = -1;
    }
};

// =============================================================================
// Theme Manager
// =============================================================================

const ThemeManager = {
    theme: 'dark', // 'dark' | 'light'

    init() {
        // Load preference
        const savedTheme = localStorage.getItem('theme');
        if (savedTheme) {
            this.theme = savedTheme;
        } else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
            this.theme = 'light';
        }

        // Apply
        this.apply();

        // Bind Button
        const toggleBtn = document.getElementById('themeToggle');
        if (toggleBtn) {
            toggleBtn.addEventListener('click', () => {
                this.toggle();
            });
        }
    },

    toggle() {
        this.theme = this.theme === 'dark' ? 'light' : 'dark';
        localStorage.setItem('theme', this.theme);
        this.apply();
    },

    apply() {
        const toggleBtn = document.getElementById('themeToggle');
        const sunIcon = toggleBtn?.querySelector('.sun-icon');
        const moonIcon = toggleBtn?.querySelector('.moon-icon');

        if (this.theme === 'light') {
            document.documentElement.setAttribute('data-theme', 'light');
            if (sunIcon) sunIcon.style.display = 'none';
            if (moonIcon) moonIcon.style.display = 'block';
        } else {
            document.documentElement.removeAttribute('data-theme');
            if (sunIcon) sunIcon.style.display = 'block';
            if (moonIcon) moonIcon.style.display = 'none';
        }
    }
};

// Init
init();
// Initialize Lightbox
Lightbox.init();
