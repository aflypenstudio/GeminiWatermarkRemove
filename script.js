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
        opacity: 0.2,    // 0.0 ~ 1.0 - Logo 透明度
        scale: 2.0       // 0.1 ~ 3.0 - Logo 縮放比例 (預設 2.0)
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
const clearAllBtn = document.getElementById('clearAllBtn');
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
                processor.handleWorkerResult(payload.imageData, payload.watermarkRegion, payload.appliedGain);
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

    fetch('https://api.github.com/repos/aflypenstudio/BananaWatermarkRemover')
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

                <div class="actions">
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
                    <div class="download-buttons" style="display: flex; flex: 1; gap: 2px;">
                        <button class="btn btn-secondary download-normal-btn" title="${Localization.get('downloadNormal') || '一般下載'}">
                            <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path>
                            </svg>
                            <span>${Localization.get('downloadNormal') || '一般'}</span>
                        </button>
                        <button class="btn btn-secondary download-mirror-btn" title="${Localization.get('downloadMirror') || '鏡射下載'}">
                            <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4"></path>
                            </svg>
                            <span>${Localization.get('downloadMirror') || '鏡射'}</span>
                        </button>
                        <button class="btn btn-secondary download-clean-btn" title="${Localization.get('downloadClean') || '純淨下載'}">
                            <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path>
                            </svg>
                            <span>${Localization.get('downloadClean') || '純淨'}</span>
                        </button>
                    </div>
                </div>
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
        this.elements.downloadNormalBtn = card.querySelector('.download-normal-btn');
        this.elements.downloadMirrorBtn = card.querySelector('.download-mirror-btn');
        this.elements.downloadCleanBtn = card.querySelector('.download-clean-btn');
        this.elements.removeBtn = card.querySelector('.remove-btn');
        this.elements.compareBtn = card.querySelector('.compare-btn');
        this.elements.wrapper = card.querySelector('.image-wrapper');
        this.elements.compareOverlay = card.querySelector('.comparison-overlay'); // Added ref

        // Initially disable download buttons until processing is done
        this.elements.downloadNormalBtn.disabled = true;
        this.elements.downloadMirrorBtn.disabled = true;
        this.elements.downloadCleanBtn.disabled = true;

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

        // Download button event listeners
        this.elements.downloadNormalBtn.addEventListener('click', () => {
            this.download('normal');
        });
        this.elements.downloadMirrorBtn.addEventListener('click', () => {
            this.download('mirror');
        });
        this.elements.downloadCleanBtn.addEventListener('click', () => {
            this.download('clean');
        });

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

    updateTypeCheckboxStyles() {
        const checkedColor = 'rgba(124, 58, 237, 0.3)';
        const uncheckedColor = 'rgba(255,255,255,0.05)';
        const textUncheckedColor = 'rgba(255,255,255,0.5)';
        const textCheckedColor = 'rgba(255,255,255,1)';

        [this.elements.typeN, this.elements.typeR, this.elements.typeM].forEach((cb, idx) => {
            const parent = cb.parentElement;
            if (cb.checked) {
                parent.style.background = checkedColor;
                parent.querySelector('span').style.color = '#fff';
            } else {
                parent.style.background = uncheckedColor;
                parent.querySelector('span').style.color = textUncheckedColor;
            }
        });
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
        this.elements.downloadNormalBtn.disabled = false;
        this.elements.downloadMirrorBtn.disabled = false;
        this.elements.downloadCleanBtn.disabled = false;
    }

    /**
     * 疊加自訂 Logo 到指定 canvas 的水印位置
     * Logo 會自動縮放以配合 canvas 比例，並套用透明度
     * 大小基於 canvas 較短邊的 3%~15%（scale 10%~300% 對應此範圍）
     * 使用較短邊計算，確保橫式/直式輸出時 LOGO 大小一致
     * 位置跟随水印区域（用于掩盖去水印后的痕迹）
     */
    applyCustomLogoToCanvas(targetCanvas) {
        if (!STATE.customLogo.image) return;

        const ctx = targetCanvas.getContext('2d');
        const logo = STATE.customLogo.image;
        const opacity = STATE.customLogo.opacity;

        const w = targetCanvas.width;
        const h = targetCanvas.height;
        const userScale = STATE.customLogo.scale; // 0.1 ~ 3.0

        // 基於較短邊計算 Logo 大小，確保橫式/直式輸出時 LOGO 大小一致
        const minPercent = 0.03;
        const maxPercent = 0.15;
        const percentRange = maxPercent - minPercent;
        const logoPercent = minPercent + percentRange * ((userScale - 0.1) / 2.9);
        const shortSide = Math.min(w, h);  // 使用較短邊
        const targetSize = shortSide * logoPercent;

        // 計算縮放比例（保持寬高比，以 targetSize 為最大邊）
        const scale = Math.min(targetSize / logo.width, targetSize / logo.height);
        const scaledWidth = logo.width * scale;
        const scaledHeight = logo.height * scale;

        // 計算位置：LOGO 中心點對齐水印中心點
        let posX, posY;
        const watermarkRegion = this.state.watermarkRegion;

        if (watermarkRegion && watermarkRegion.x !== undefined) {
            // 使用水印位置，並考慮縮放比例
            const originalW = this.state.originalImage ? this.state.originalImage.width : this.state.cleanImageData.width;
            const originalH = this.state.originalImage ? this.state.originalImage.height : this.state.cleanImageData.height;
            const scaleX = w / originalW;
            const scaleY = h / originalH;

            // LOGO 中心點對齐水印中心點
            const watermarkCenterX = (watermarkRegion.x + watermarkRegion.width / 2) * scaleX;
            const watermarkCenterY = (watermarkRegion.y + watermarkRegion.height / 2) * scaleY;
            posX = watermarkCenterX - scaledWidth / 2;
            posY = watermarkCenterY - scaledHeight / 2;
        } else {
            // 備用：放在右下角
            const margin = shortSide * 0.02;
            posX = w - margin - scaledWidth;
            posY = h - margin - scaledHeight;
        }

        if (posX < 0 || posY < 0 || posX + scaledWidth > w || posY + scaledHeight > h) return;

        // 繪製 Logo
        ctx.save();
        ctx.globalAlpha = opacity;
        ctx.drawImage(logo, posX, posY, scaledWidth, scaledHeight);
        ctx.restore();
    }

    /**
     * 疊加自訂 Logo 到圖片的水印位置（用於 UI 預覽）
     * Logo 會自動縮放以配合圖片比例，並套用透明度
     * 大小基於圖片較短邊的 3%~15%（scale 10%~300% 對應此範圍）
     * 使用較短邊計算，確保橫式/直式輸出時 LOGO 大小一致
     * 位置跟随水印区域（用于掩盖去水印后的痕迹）
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

        // 基於較短邊計算 Logo 大小，確保橫式/直式輸出時 LOGO 大小一致
        const minPercent = 0.03;
        const maxPercent = 0.15;
        const percentRange = maxPercent - minPercent;
        const logoPercent = minPercent + percentRange * ((userScale - 0.1) / 2.9);
        const shortSide = Math.min(w, h);  // 使用較短邊
        const targetSize = shortSide * logoPercent;

        // 計算縮放比例（保持寬高比，以 targetSize 為最大邊）
        const scale = Math.min(targetSize / logo.width, targetSize / logo.height);
        const scaledWidth = logo.width * scale;
        const scaledHeight = logo.height * scale;

        // 計算位置：LOGO 中心點對齐水印中心點
        let posX, posY;
        const watermarkRegion = this.state.watermarkRegion;

        if (watermarkRegion && watermarkRegion.x !== undefined) {
            // LOGO 中心點對齐水印中心點
            const watermarkCenterX = watermarkRegion.x + watermarkRegion.width / 2;
            const watermarkCenterY = watermarkRegion.y + watermarkRegion.height / 2;
            posX = watermarkCenterX - scaledWidth / 2;
            posY = watermarkCenterY - scaledHeight / 2;
        } else {
            // 備用：放在右下角
            const margin = shortSide * 0.02;
            posX = w - margin - scaledWidth;
            posY = h - margin - scaledHeight;
        }

        if (posX < 0 || posY < 0 || posX + scaledWidth > w || posY + scaledHeight > h) return;

        // 繪製 Logo
        ctx.save();
        ctx.globalAlpha = opacity;
        ctx.drawImage(logo, posX, posY, scaledWidth, scaledHeight);
        ctx.restore();
    }

    /**
     * 取得要下載的圖像資料
     */
    getImageForDownload() {
        return this.state.processedImageData;
    }

    /**
     * 下載圖片
     * @param {string} downloadType - 'normal' = 去水印+縮小+有Logo / 'mirror' = 去水印+縮小+鏡射 / 'clean' = 去水印+縮小
     */
    download(downloadType = 'normal') {
        const imageData = this.getImageForDownload();
        if (!imageData) return;

        const format = STATE.downloadFormat;
        const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png';
        const ext = format === 'jpeg' ? '.jpg' : '.png';

        // 建立臨時 canvas 來處理圖片
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = imageData.width;
        tempCanvas.height = imageData.height;
        const tempCtx = tempCanvas.getContext('2d');

        // 決定使用哪個 ImageData 作為來源
        // 'normal' = imageData (有 Logo)
        // 'mirror' 或 'clean' = cleanImageData (無 Logo)
        let sourceImageData;
        if (downloadType === 'normal') {
            sourceImageData = imageData; // 有 Logo 版本
        } else {
            sourceImageData = this.state.cleanImageData || imageData; // 無 Logo
        }

        // 繪製 ImageData
        tempCtx.putImageData(sourceImageData, 0, 0);

        // 應用銳化（如果啟用）
        if (STATE.enableSharpen) {
            const sharpened = applySharpen(tempCanvas, tempCtx);
            tempCtx.putImageData(sharpened, 0, 0);
        }

        // 處理縮放
        let outputCanvas = tempCanvas;
        const preset = STATE.resizePreset;
        if (preset) {
            const isLandscape = imageData.width > imageData.height;
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
            ctx.drawImage(tempCanvas, 0, 0, targetW, targetH);
            outputCanvas = resizedCanvas;
        }

        // 如果需要且有自訂 LOGO，在縮放後的 canvas 上套用 LOGO（基於縮放後尺寸計算位置）
        // 只有 normal 版本需要套用 Logo
        if (downloadType === 'normal' && STATE.customLogo.image) {
            this.applyCustomLogoToCanvas(outputCanvas);
        }

        // 套用水平鏡像（只有 mirror 版本）
        if (downloadType === 'mirror') {
            this.applyHorizontalMirror(outputCanvas);
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
            const suffix = '_clean';
            // 優先從 DOM 讀取，確保獲取最新值
            const userPrefix = (filenamePrefixInput ? filenamePrefixInput.value : STATE.filenamePrefix) || '';

            // 下載類型前綴
            let typePrefix;
            if (downloadType === 'normal') {
                typePrefix = 'R_';
            } else if (downloadType === 'mirror') {
                typePrefix = 'M_';
            } else {
                typePrefix = 'N_';
            }
            link.download = `${userPrefix}${typePrefix}${nameParts.join('.')}${suffix}${ext}`;

            link.href = url;
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        });
    }

    /**
     * 水平鏡像翻轉 canvas
     */
    applyHorizontalMirror(canvas) {
        const ctx = canvas.getContext('2d');
        const width = canvas.width;
        const height = canvas.height;

        // 創建一個新的 ImageData
        const imageData = ctx.getImageData(0, 0, width, height);
        const mirroredData = ctx.createImageData(width, height);
        const data = imageData.data;
        const mirrored = mirroredData.data;

        // 水平鏡像：每個像素 x 映射到 width - 1 - x
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const srcX = width - 1 - x;
                const srcIdx = (y * width + srcX) * 4;
                const dstIdx = (y * width + x) * 4;
                mirrored[dstIdx] = data[srcIdx];
                mirrored[dstIdx + 1] = data[srcIdx + 1];
                mirrored[dstIdx + 2] = data[srcIdx + 2];
                mirrored[dstIdx + 3] = data[srcIdx + 3];
            }
        }

        ctx.putImageData(mirroredData, 0, 0);
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

    // 新檔案加入時自動套用排序
    applySort();

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
 * 批次下載所有圖片（一般版 + 純淨版）
 */
async function downloadAll() {
    if (STATE.processors.length === 0) return;

    // 禁用按鈕並顯示進度條
    const btn = downloadAllBtn;
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = `<span>${Localization.get('progressLabel') || '處理中...'}</span>`;
    }
    if (batchProgress) batchProgress.style.display = 'flex';

    const totalItems = STATE.processors.length * 2; // 2 types each

    // 無 JSZip 時降級到依序下載
    if (typeof JSZip === 'undefined') {
        let delay = 0;
        let itemIndex = 0;
        STATE.processors.forEach((p) => {
            setTimeout(() => { p.download('normal'); updateProgress(++itemIndex, totalItems); }, delay); delay += 200;
            setTimeout(() => { p.download('clean'); updateProgress(++itemIndex, totalItems); }, delay); delay += 200;
        });
        setTimeout(() => {
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = `<svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path></svg><span data-i18n="downloadAll">下載全部</span>`;
                Localization.apply();
            }
            if (batchProgress) batchProgress.style.display = 'none';
        }, delay + 1000);
        return;
    }

    const zip = new JSZip();
    const folder = zip.folder('banana_clean');
    const usedNames = new Set();
    const completed = { count: 0 };

    try {
        const promises = STATE.processors.map(p => new Promise(async (resolve) => {
            const imageData = p.getImageForDownload();
            const cleanImageData = p.state.cleanImageData;
            if (!imageData) {
                updateProgress(completed.count += 2, totalItems);
                resolve(false);
                return;
            }

            const format = STATE.downloadFormat;
            const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png';
            const ext = format === 'jpeg' ? '.jpg' : '.png';
            const preset = STATE.resizePreset;
            const isLandscape = imageData.width > imageData.height;
            const userPrefix = (filenamePrefixInput ? filenamePrefixInput.value : STATE.filenamePrefix) || '';
            const nameParts = p.file.name.split('.');
            nameParts.pop();
            const suffix = '_clean';

            // 處理一般版本 (R_)
            {
                const tempCanvas = document.createElement('canvas');
                tempCanvas.width = imageData.width;
                tempCanvas.height = imageData.height;
                const tempCtx = tempCanvas.getContext('2d');
                tempCtx.putImageData(imageData, 0, 0);

                if (STATE.enableSharpen) {
                    const sharpened = applySharpen(tempCanvas, tempCtx);
                    tempCtx.putImageData(sharpened, 0, 0);
                }

                let outputCanvas = tempCanvas;
                if (preset) {
                    let targetW = isLandscape ? 1920 : 1080;
                    let targetH = isLandscape ? 1080 : 1920;
                    if (preset === '1280x720') { targetW = isLandscape ? 1280 : 720; targetH = isLandscape ? 720 : 1280; }
                    const resized = document.createElement('canvas');
                    resized.width = targetW; resized.height = targetH;
                    resized.getContext('2d').drawImage(tempCanvas, 0, 0, targetW, targetH);
                    outputCanvas = resized;
                }

                if (STATE.customLogo.image) p.applyCustomLogoToCanvas(outputCanvas);

                let filename = `${nameParts.join('.')}${suffix}${ext}`;
                let fullName = `${userPrefix}R_${filename}`;
                if (usedNames.has(fullName)) {
                    let counter = 1;
                    while (usedNames.has(`${userPrefix}R_${nameParts.join('.')}_${counter}${suffix}${ext}`)) counter++;
                    filename = `${nameParts.join('.')}_${counter}${suffix}${ext}`;
                }
                usedNames.add(`${userPrefix}R_${filename}`);

                const exif = (STATE.keepExif && format === 'jpeg') ? STATE.exifData.get(p.id) : null;
                const blob = await writeExifToBlob(outputCanvas, exif, mimeType);
                if (blob) folder.file(`${userPrefix}R_${filename}`, blob);
                updateProgress(++completed.count, totalItems);
            }

            // 處理純淨版本 (N_)
            if (cleanImageData) {
                const tempCanvas = document.createElement('canvas');
                tempCanvas.width = cleanImageData.width;
                tempCanvas.height = cleanImageData.height;
                const tempCtx = tempCanvas.getContext('2d');
                tempCtx.putImageData(cleanImageData, 0, 0);

                if (STATE.enableSharpen) {
                    const sharpened = applySharpen(tempCanvas, tempCtx);
                    tempCtx.putImageData(sharpened, 0, 0);
                }

                let outputCanvas = tempCanvas;
                if (preset) {
                    let targetW = isLandscape ? 1920 : 1080;
                    let targetH = isLandscape ? 1080 : 1920;
                    if (preset === '1280x720') { targetW = isLandscape ? 1280 : 720; targetH = isLandscape ? 720 : 1280; }
                    const resized = document.createElement('canvas');
                    resized.width = targetW; resized.height = targetH;
                    resized.getContext('2d').drawImage(tempCanvas, 0, 0, targetW, targetH);
                    outputCanvas = resized;
                }

                let filename = `${nameParts.join('.')}${suffix}${ext}`;
                let fullName = `${userPrefix}N_${filename}`;
                if (usedNames.has(fullName)) {
                    let counter = 1;
                    while (usedNames.has(`${userPrefix}N_${nameParts.join('.')}_${counter}${suffix}${ext}`)) counter++;
                    filename = `${nameParts.join('.')}_${counter}${suffix}${ext}`;
                }
                usedNames.add(`${userPrefix}N_${filename}`);

                const exif = (STATE.keepExif && format === 'jpeg') ? STATE.exifData.get(p.id) : null;
                const blob = await writeExifToBlob(outputCanvas, exif, mimeType);
                if (blob) folder.file(`${userPrefix}N_${filename}`, blob);
                updateProgress(++completed.count, totalItems);
            }

            resolve(true);
        }));

        await Promise.all(promises);

        const content = await zip.generateAsync({ type: 'blob' });
        const url = URL.createObjectURL(content);
        const link = document.createElement('a');
        link.download = `banana_watermark_remover.zip`;
        link.href = url;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);

    } catch (err) {
        console.error('ZIP generation failed:', err);
        alert('建立 ZIP 失敗，已改為個別下載。');
        STATE.processors.forEach((p, i) => {
            let delay = i * 400;
            setTimeout(() => p.download('normal'), delay);
            setTimeout(() => p.download('clean'), delay + 200);
        });
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = `<svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path></svg><span data-i18n="downloadAll">下載全部</span>`;
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

// 按鈕事件：下載全部
downloadAllBtn.addEventListener('click', () => downloadAll());

// 按鈕事件：清除全部
if (clearAllBtn) {
    clearAllBtn.addEventListener('click', () => {
        if (STATE.processors.length === 0) return;

        // 簡單的確認對話框
        const confirmMsg = Localization.get('confirmClearAll') || '確定要清除所有圖片？';
        if (!confirm(confirmMsg)) return;

        // 清除所有圖片處理器
        while (STATE.processors.length > 0) {
            const p = STATE.processors[0];
            p.elements.card.remove();
            STATE.processors.shift();
        }

        // 清除 EXIF 資料
        STATE.exifData.clear();

        // 更新 UI 狀態
        updateUIState();
    });
}

/**
 * 清除所有已上傳的圖片（無需確認）
 */
function clearAllNoConfirm() {
    // 清除所有圖片處理器
    while (STATE.processors.length > 0) {
        const p = STATE.processors[0];
        p.elements.card.remove();
        STATE.processors.shift();
    }

    // 清除 EXIF 資料
    STATE.exifData.clear();

    // 更新 UI 狀態
    updateUIState();
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

function applySort(andReorder = true) {
    // 直接從 DOM 讀取最新值
    const sortByField = sortBySelect ? sortBySelect.value : STATE.sortBy;
    const sortOrderField = sortOrderSelect ? sortOrderSelect.value : STATE.sortOrder;

    STATE.processors.sort((a, b) => {
        let valA, valB;
        if (sortByField === 'name') {
            valA = a.file.name.toLowerCase();
            valB = b.file.name.toLowerCase();
        } else {
            // 依時間：使用 lastModified
            valA = a.file.lastModified || 0;
            valB = b.file.lastModified || 0;
        }

        if (sortOrderField === 'asc') {
            return valA < valB ? -1 : (valA > valB ? 1 : 0);
        } else {
            return valA > valB ? -1 : (valA < valB ? 1 : 0);
        }
    });

    // 重新渲染順序
    if (andReorder) {
        resultsContainer.innerHTML = '';
        STATE.processors.forEach(p => {
            resultsContainer.appendChild(p.elements.card);
        });
    }
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
    STATE.customLogo.opacity = 0.2;
    STATE.customLogo.scale = 2.0;
    logoOpacity.value = 20;
    logoOpacityValue.textContent = '20%';
    logoScale.value = 200;
    logoScaleValue.textContent = '200%';
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
        container: document.getElementById('lightboxImageContainer'),
        close: document.querySelector('.lightbox-close'),
        prev: document.getElementById('lightboxPrev'),
        next: document.getElementById('lightboxNext')
    },
    activeOriginal: null,
    activeProcessed: null,
    currentIndex: -1,

    // 縮放/鏡射/旋轉狀態
    state: {
        scale: 1,
        flipH: false,
        flipV: false,
        rotation: 0 // 0, 90, 180, 270
    },

    // 平移相關
    isDragging: false,
    dragStartX: 0,
    dragStartY: 0,
    panX: 0,
    panY: 0,

    /**
     * 初始化 Lightbox 控制器
     */
    init() {
        if (!this.elements.modal) return;

        this.elements.close.onclick = () => this.close();
        this.elements.modal.onclick = (e) => {
            // 點擊空白處關閉（但不包括圖片容器和工具列）
            if (e.target === this.elements.modal || e.target === this.elements.container) {
                this.close();
            }
        };

        // 導航箭頭
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

        // 滾輪縮放
        this.elements.container.addEventListener('wheel', (e) => {
            e.preventDefault();
            const delta = e.deltaY > 0 ? -0.1 : 0.1;
            this.zoom(delta, e.clientX, e.clientY);
        }, { passive: false });

        // 拖曳平移
        this.elements.container.addEventListener('mousedown', (e) => {
            if (e.target.closest('.lightbox-nav')) return;
            if (this.state.scale > 1) {
                this.startDrag(e.clientX, e.clientY);
            }
        });

        this.elements.container.addEventListener('mousemove', (e) => {
            if (this.isDragging) {
                this.drag(e.clientX, e.clientY);
            }
        });

        this.elements.container.addEventListener('mouseup', () => this.endDrag());
        this.elements.container.addEventListener('mouseleave', () => this.endDrag());

        // 觸控平移
        let lastTouchDist = 0;
        let lastTouchX = 0;
        let lastTouchY = 0;

        this.elements.container.addEventListener('touchstart', (e) => {
            if (e.touches.length === 1 && this.state.scale > 1) {
                this.startDrag(e.touches[0].clientX, e.touches[0].clientY);
            } else if (e.touches.length === 2) {
                lastTouchDist = Math.hypot(
                    e.touches[0].clientX - e.touches[1].clientX,
                    e.touches[0].clientY - e.touches[1].clientY
                );
            }
            lastTouchX = e.touches[0].clientX;
            lastTouchY = e.touches[0].clientY;
        }, { passive: true });

        this.elements.container.addEventListener('touchmove', (e) => {
            if (e.touches.length === 2) {
                e.preventDefault();
                const dist = Math.hypot(
                    e.touches[0].clientX - e.touches[1].clientX,
                    e.touches[0].clientY - e.touches[1].clientY
                );
                const scaleDelta = (dist - lastTouchDist) / 200;
                this.zoom(scaleDelta, window.innerWidth / 2, window.innerHeight / 2);
                lastTouchDist = dist;
            }
        }, { passive: false });

        this.elements.container.addEventListener('touchend', () => this.endDrag());

        // 鍵盤快捷鍵
        document.addEventListener('keydown', (e) => {
            if (this.elements.modal.style.display !== 'flex') return;

            switch (e.key) {
                case 'Escape':
                    this.close();
                    break;
                case 'ArrowLeft':
                    this.navigate(-1);
                    break;
                case 'ArrowRight':
                    this.navigate(1);
                    break;
                case '+':
                case '=':
                    this.zoomIn();
                    break;
                case '-':
                    this.zoomOut();
                    break;
                case '0':
                    this.zoomReset();
                    break;
                case 'h':
                case 'H':
                    this.flipHorizontal();
                    break;
                case 'v':
                case 'V':
                    this.flipVertical();
                    break;
                case 'q':
                case 'Q':
                    this.rotateLeft();
                    break;
                case 'e':
                case 'E':
                    this.rotateRight();
                    break;
                case 'p':
                case 'P':
                    this.toggleSettingsPanel();
                    break;
            }
        });

        // 长按显示原图
        let pressTimer;
        const startCompare = (e) => {
            if (e.type === 'mousedown' && e.button !== 0) return;
            pressTimer = setTimeout(() => {
                if (this.activeOriginal && !e.target.closest('.lightbox-toolbar') && !e.target.closest('.lightbox-nav')) {
                    this.elements.img.src = this.activeOriginal.src;
                }
            }, 300);
        };
        const endCompare = () => {
            clearTimeout(pressTimer);
            if (this.activeProcessed) {
                this.elements.img.src = this.activeProcessed;
            }
        };

        this.elements.container.addEventListener('mousedown', startCompare);
        this.elements.container.addEventListener('touchstart', startCompare);
        this.elements.container.addEventListener('mouseup', endCompare);
        this.elements.container.addEventListener('touchend', endCompare);
        this.elements.container.addEventListener('mouseleave', endCompare);

        // 工具列按鈕
        document.getElementById('lightboxZoomIn')?.addEventListener('click', () => this.zoomIn());
        document.getElementById('lightboxZoomOut')?.addEventListener('click', () => this.zoomOut());
        document.getElementById('lightboxZoomReset')?.addEventListener('click', () => this.zoomReset());
        document.getElementById('lightboxFlipH')?.addEventListener('click', () => this.flipHorizontal());
        document.getElementById('lightboxFlipV')?.addEventListener('click', () => this.flipVertical());
        document.getElementById('lightboxRotateL')?.addEventListener('click', () => this.rotateLeft());
        document.getElementById('lightboxRotateR')?.addEventListener('click', () => this.rotateRight());

        // 設定面板
        document.getElementById('lightboxSettings')?.addEventListener('click', () => this.openSettingsPanel());
        document.getElementById('lightboxSettingsClose')?.addEventListener('click', () => this.closeSettingsPanel());
        document.getElementById('settingsCancel')?.addEventListener('click', () => this.cancelSettings());
        document.getElementById('settingsApply')?.addEventListener('click', () => this.applySettings());

        // 強度滑桿即時更新顯示
        document.getElementById('settingsStrength')?.addEventListener('input', (e) => {
            document.getElementById('settingsStrengthValue').textContent = parseFloat(e.target.value).toFixed(2);
        });
    },

    // ===== 設定面板控制 =====

    openSettingsPanel() {
        const panel = document.getElementById('lightboxSettingsPanel');
        if (!panel) return;

        // 套用翻譯
        const i18nElements = panel.querySelectorAll('[data-i18n]');
        i18nElements.forEach(el => {
            const key = el.getAttribute('data-i18n');
            el.textContent = Localization.get(key);
        });

        // 取得當前 processor 的設定
        let processor = null;
        if (this.currentIndex >= 0 && this.currentIndex < STATE.processors.length) {
            processor = STATE.processors[this.currentIndex];
        }

        // 填入當前設定值
        if (processor) {
            const strength = processor.config.alphaGain || 1;
            document.getElementById('settingsStrength').value = strength;
            document.getElementById('settingsStrengthValue').textContent = strength.toFixed(2);

            // 讀取自動強度狀態
            const manualStrength = !processor.config.autoStrength;
            document.getElementById('settingsManualStrength').checked = manualStrength;

            const position = processor.config.forcePosition || 'auto';
            document.querySelector(`input[name="settingsPosition"][value="${position}"]`).checked = true;

            const size = processor.config.forceMode || 'auto';
            document.querySelector(`input[name="settingsSize"][value="${size}"]`).checked = true;
        } else {
            document.getElementById('settingsStrength').value = 1;
            document.getElementById('settingsStrengthValue').textContent = '1.00';
            document.querySelector('input[name="settingsPosition"][value="auto"]').checked = true;
            document.querySelector('input[name="settingsSize"][value="auto"]').checked = true;
        }

        // 儲存原始設定用於取消
        this._settingsBackup = {
            alphaGain: processor.config.alphaGain,
            autoStrength: processor.config.autoStrength,
            forcePosition: processor.config.forcePosition,
            forceMode: processor.config.forceMode
        };

        panel.classList.add('visible');
    },

    closeSettingsPanel() {
        // 如果有未儲存的變更，恢復原設定
        const processor = this.currentIndex >= 0 ? STATE.processors[this.currentIndex] : null;
        if (this._settingsBackup && processor) {
            processor.config.alphaGain = this._settingsBackup.alphaGain;
            processor.config.autoStrength = this._settingsBackup.autoStrength;
            processor.config.forcePosition = this._settingsBackup.forcePosition;
            processor.config.forceMode = this._settingsBackup.forceMode;
            this.updateMainUIControls(processor);
        }

        const panel = document.getElementById('lightboxSettingsPanel');
        panel?.classList.remove('visible');
    },

    toggleSettingsPanel() {
        const panel = document.getElementById('lightboxSettingsPanel');
        if (!panel) return;

        if (panel.classList.contains('visible')) {
            this.closeSettingsPanel();
        } else {
            this.openSettingsPanel();
        }
    },

    cancelSettings() {
        const processor = this.currentIndex >= 0 ? STATE.processors[this.currentIndex] : null;

        // 恢復原設定
        if (this._settingsBackup && processor) {
            processor.config.alphaGain = this._settingsBackup.alphaGain;
            processor.config.autoStrength = this._settingsBackup.autoStrength;
            processor.config.forcePosition = this._settingsBackup.forcePosition;
            processor.config.forceMode = this._settingsBackup.forceMode;

            // 更新主畫面控制項
            this.updateMainUIControls(processor);
        }

        this.closeSettingsPanel();
    },

    updateMainUIControls(processor) {
        if (!processor || !processor.elements.card) return;

        // 更新大小選擇
        if (processor.elements.sizeSelect) {
            processor.elements.sizeSelect.value = processor.config.forceMode || 'auto';
        }

        // 更新位置選擇
        if (processor.elements.positionSelect) {
            processor.elements.positionSelect.value = processor.config.forcePosition || 'auto';
        }

        // 更新自動強度檢查框
        if (processor.elements.autoStrengthCheck) {
            processor.elements.autoStrengthCheck.checked = processor.config.autoStrength;
        }
    },

    applySettings() {
        const processor = this.currentIndex >= 0 ? STATE.processors[this.currentIndex] : null;
        if (!processor) {
            this.closeSettingsPanel();
            return;
        }

        // 取得新設定
        const strength = parseFloat(document.getElementById('settingsStrength').value);
        const manualStrength = document.getElementById('settingsManualStrength').checked;
        const position = document.querySelector('input[name="settingsPosition"]:checked').value;
        const size = document.querySelector('input[name="settingsSize"]:checked').value;

        // 更新 processor config（Worker 使用這些值）
        processor.config.alphaGain = strength;
        processor.config.autoStrength = !manualStrength; // 取消勾選 = 停用自動
        processor.config.forcePosition = position;
        processor.config.forceMode = size;

        // 重新處理
        processor.processAndRender();

        // 關閉面板
        this.closeSettingsPanel();

        // 更新 Lightbox 顯示
        this.elements.img.src = processor.elements.canvas.toDataURL();
        this.applyTransform();

        // 顯示 Toast
        this.showToast(Localization.get('apply') + ': ' + strength.toFixed(2));
    },

    /**
     * 開啟 Lightbox
     */
    open(processedImageData, originalImage, processor) {
        if (!processedImageData || !originalImage) return;

        if (processor) {
            this.currentIndex = STATE.processors.indexOf(processor);
        } else {
            this.currentIndex = -1;
        }

        this.activeOriginal = originalImage;

        const canvas = document.createElement('canvas');
        canvas.width = processedImageData.width;
        canvas.height = processedImageData.height;
        const ctx = canvas.getContext('2d');
        ctx.putImageData(processedImageData, 0, 0);
        this.activeProcessed = canvas.toDataURL();

        // 重置狀態
        this.resetState();

        this.elements.img.src = this.activeProcessed;
        this.elements.modal.style.display = 'flex';

        this.updateNavVisibility();
        this.updateToolbarState();
        this.applyTransform();
    },

    /**
     * 導航
     */
    navigate(direction) {
        const total = STATE.processors.length;
        if (total <= 1) return;

        const newIndex = this.currentIndex + direction;
        if (newIndex < 0 || newIndex >= total) return;

        const targetProcessor = STATE.processors[newIndex];
        if (!targetProcessor || !targetProcessor.state.processedImageData) return;

        this.currentIndex = newIndex;

        const canvas = document.createElement('canvas');
        canvas.width = targetProcessor.state.processedImageData.width;
        canvas.height = targetProcessor.state.processedImageData.height;
        const ctx = canvas.getContext('2d');
        ctx.putImageData(targetProcessor.state.processedImageData, 0, 0);

        this.activeOriginal = targetProcessor.state.originalImage;
        this.activeProcessed = canvas.toDataURL();

        // 重置狀態
        this.resetState();

        this.elements.img.src = this.activeProcessed;

        this.updateNavVisibility();
        this.updateToolbarState();
        this.applyTransform();
    },

    /**
     * 關閉
     */
    close() {
        this.elements.modal.style.display = 'none';
        this.elements.img.src = '';
        this.activeOriginal = null;
        this.activeProcessed = null;
        this.currentIndex = -1;
        this.resetState();
    },

    // ===== 縮放控制 =====

    zoom(delta, clientX, clientY) {
        const newScale = Math.max(0.5, Math.min(5, this.state.scale + delta));
        if (newScale !== this.state.scale) {
            this.state.scale = newScale;
            this.applyTransform();
            this.updateZoomIndicator();
        }
    },

    zoomIn() {
        this.zoom(0.25, window.innerWidth / 2, window.innerHeight / 2);
    },

    zoomOut() {
        this.zoom(-0.25, window.innerWidth / 2, window.innerHeight / 2);
    },

    zoomReset() {
        this.state.scale = 1;
        this.panX = 0;
        this.panY = 0;
        this.applyTransform();
        this.updateZoomIndicator();
        this.showToast(Localization.get('zoomReset') || '重置');
    },

    // ===== 鏡射控制 =====

    flipHorizontal() {
        this.state.flipH = !this.state.flipH;
        this.applyTransform();
        this.updateToolbarState();
        this.updateNavVisibility();
        this.showToast(Localization.get('flipHHint') + (this.state.flipH ? ': ON' : ': OFF'));
    },

    flipVertical() {
        this.state.flipV = !this.state.flipV;
        this.applyTransform();
        this.updateToolbarState();
        this.updateNavVisibility();
        this.showToast(Localization.get('flipVHint') + (this.state.flipV ? ': ON' : ': OFF'));
    },

    // ===== 旋轉控制 =====

    rotateLeft() {
        this.state.rotation = (this.state.rotation - 90 + 360) % 360;
        this.applyTransform();
        this.updateNavVisibility();
        this.showToast(Localization.get('rotateHint') + ': -90°');
    },

    rotateRight() {
        this.state.rotation = (this.state.rotation + 90) % 360;
        this.applyTransform();
        this.updateNavVisibility();
        this.showToast(Localization.get('rotateHint') + ': +90°');
    },

    // ===== 輔助方法 =====

    applyTransform() {
        const { scale, flipH, flipV, rotation } = this.state;
        const img = this.elements.img;
        const { panX, panY } = this;

        let transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
        // 使用 rotateY 實現水平翻轉（scaleX 有時在某些瀏覽器不生效）
        if (flipH) {
            transform += ` rotateY(180deg)`;
        }
        if (flipV) {
            transform += ` rotateX(180deg)`;
        }
        transform += ` rotate(${rotation}deg)`;

        img.style.transform = transform;
    },

    resetState() {
        this.state = {
            scale: 1,
            flipH: false,
            flipV: false,
            rotation: 0
        };
        this.panX = 0;
        this.panY = 0;
        this.isDragging = false;
    },

    startDrag(x, y) {
        this.isDragging = true;
        this.dragStartX = x - this.panX;
        this.dragStartY = y - this.panY;
        this.elements.img.classList.add('panning');
    },

    drag(x, y) {
        if (!this.isDragging) return;
        this.panX = x - this.dragStartX;
        this.panY = y - this.dragStartY;
        this.applyTransform();
    },

    endDrag() {
        this.isDragging = false;
        this.elements.img.classList.remove('panning');
    },

    updateNavVisibility() {
        const total = STATE.processors.length;
        if (!this.elements.prev || !this.elements.next) return;

        if (total <= 1) {
            this.elements.prev.classList.add('hidden');
            this.elements.next.classList.add('hidden');
            return;
        }

        if (this.currentIndex <= 0) {
            this.elements.prev.classList.add('hidden');
        } else {
            this.elements.prev.classList.remove('hidden');
        }

        if (this.currentIndex >= total - 1) {
            this.elements.next.classList.add('hidden');
        } else {
            this.elements.next.classList.remove('hidden');
        }

        // 根據旋轉角度和縮放調整箭頭位置
        const container = this.elements.container;
        const isRotated = this.state.rotation === 90 || this.state.rotation === 270;

        this.elements.prev.style.top = '50%';
        this.elements.next.style.top = '50%';
    },

    updateToolbarState() {
        document.getElementById('lightboxFlipH')?.classList.toggle('active', this.state.flipH);
        document.getElementById('lightboxFlipV')?.classList.toggle('active', this.state.flipV);

        // 更新縮放顯示
        const zoomBtn = document.getElementById('lightboxZoomReset');
        if (zoomBtn) {
            zoomBtn.querySelector('span').textContent = Math.round(this.state.scale * 100) + '%';
        }
    },

    updateZoomIndicator() {
        this.updateToolbarState();
    },

    showToast(message) {
        let toast = document.querySelector('.lightbox-toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.className = 'lightbox-toast';
            this.elements.modal.appendChild(toast);
        }

        toast.textContent = message;
        toast.classList.add('show');

        clearTimeout(this.toastTimeout);
        this.toastTimeout = setTimeout(() => {
            toast.classList.remove('show');
        }, 1500);
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
