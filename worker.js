// worker.js

/**
 * 系統常數設定
 */
const CONSTANTS = {
    LARGE_THRESHOLD: 1024,
    MARGIN_LARGE: 64,
    MARGIN_SMALL: 32,
    MARGIN_LARGE_NEW: 192,
    MARGIN_SMALL_NEW: 96,
    LOGO_VALUE: 255.0,
    ALPHA_THRESHOLD: 0.002,
    MAX_ALPHA: 0.99,
    POSITION_SCORE_TOLERANCE: 0.05,
    POSITION_SCORE_THRESHOLD: 0.2,
    GAIN_LIMIT_MIN: 0.1,
    GAIN_LIMIT_MAX: 1.5
};

let masks = {
    small: null,
    large: null
};

// 監聽主執行緒的訊息
self.onmessage = function(e) {
    const { type, payload } = e.data;

    if (type === 'INIT_MASKS') {
        masks = payload; // { small: { width, height, alphas }, large: ... }
    } else if (type === 'PROCESS_IMAGE') {
        const { imageData, config } = payload;
        try {
            const result = removeWatermark(imageData, config);
            const watermarkRegion = result ? result.region : null;
            const appliedGain = result ? result.appliedGain : config.alphaGain;
            self.postMessage({
                type: 'PROCESS_COMPLETE',
                payload: { imageData, watermarkRegion, appliedGain },
                id: payload.id
            }, [imageData.data.buffer]); // 轉移 buffer
        } catch (err) {
            self.postMessage({
                type: 'PROCESS_ERROR',
                payload: err.message,
                id: payload.id
            });
        }
    }
};

/**
 * 執行浮水印去除的核心函式
 * 包含：選擇大小模式、定位浮水印區域、自動估算強度、套用逆向 Alpha 混合演算法
 */
function removeWatermark(imageData, config) {
    const w = imageData.width;
    const h = imageData.height;

    // 1. 決定尺寸模式
    let mode = config.forceMode;
    if (mode === 'auto') {
        if (w > CONSTANTS.LARGE_THRESHOLD && h > CONSTANTS.LARGE_THRESHOLD) {
            mode = 'large';
        } else {
            mode = 'small';
        }
    }

    const mask = mode === 'large' ? masks.large : masks.small;
    if (!mask) {
        throw new Error('Masks not loaded yet');
    }

    // 2. 智慧偵測浮水印區域
    const region = selectWatermarkRegion(imageData, mask, mode, config.forcePosition);
    if (!region) return null;

    const posX = region.x;
    const posY = region.y;

    // 3. 處理強度增益值 (優先自動偵測)
    const data = imageData.data;
    let gain = config.alphaGain;

    // 檢查是否有全域強度偏移
    if (config.globalIntensityOffset !== undefined && config.globalIntensityOffset !== 0) {
        // 強制使用自動偵測，並套用偏移
        gain = estimateOptimalGain(imageData, mask, posX, posY);
        gain = clampGain(gain + config.globalIntensityOffset);
    } else if (config.autoStrength) {
        // 沒有全域偏移時，按原設定使用自動偵測
        gain = estimateOptimalGain(imageData, mask, posX, posY);
    }

    // 4. 執行逆向 Alpha 混合演算法消除浮水印
    for (let my = 0; my < mask.height; my++) {
        for (let mx = 0; mx < mask.width; mx++) {
            const iy = posY + my;
            const ix = posX + mx;

            if (ix >= w || iy >= h) continue;

            const mIdx = my * mask.width + mx;
            let alpha = mask.alphas[mIdx] * gain;

            if (alpha < CONSTANTS.ALPHA_THRESHOLD) continue;
            if (alpha > CONSTANTS.MAX_ALPHA) alpha = CONSTANTS.MAX_ALPHA;

            const oneMinusAlpha = 1.0 - alpha;
            const idx = (iy * w + ix) * 4;

            for (let c = 0; c < 3; c++) {
                const currentVal = data[idx + c];
                let original = (currentVal - alpha * CONSTANTS.LOGO_VALUE) / oneMinusAlpha;
                if (original < 0) original = 0;
                if (original > 255) original = 255;
                data[idx + c] = original;
            }
        }
    }

    return { region, appliedGain: gain };
}

/**
 * 依照新舊 Gemini 浮水印邊距候選值，選出最可能的浮水印區域。
 * 目前保留舊版 64/32px 邊距，同時支援新版 192/96px 邊距。
 */
function selectWatermarkRegion(imageData, mask, mode, forcePosition) {
    const w = imageData.width;
    const h = imageData.height;
    
    let margins = [];
    if (forcePosition === 'new') {
        margins = [mode === 'large' ? CONSTANTS.MARGIN_LARGE_NEW : CONSTANTS.MARGIN_SMALL_NEW];
    } else if (forcePosition === 'old') {
        margins = [mode === 'large' ? CONSTANTS.MARGIN_LARGE : CONSTANTS.MARGIN_SMALL];
    } else {
        margins = mode === 'large'
            ? [CONSTANTS.MARGIN_LARGE, CONSTANTS.MARGIN_LARGE_NEW]
            : [CONSTANTS.MARGIN_SMALL, CONSTANTS.MARGIN_SMALL_NEW];
    }

    const candidates = margins
        .map(margin => ({
            margin,
            x: w - margin - mask.width,
            y: h - margin - mask.height,
            width: mask.width,
            height: mask.height,
            score: Number.NEGATIVE_INFINITY
        }))
        .filter(region => region.x >= 0 && region.y >= 0);

    if (candidates.length === 0) return null;

    if (forcePosition && forcePosition !== 'auto') {
        return candidates[0];
    }

    for (const candidate of candidates) {
        candidate.score = scoreWatermarkCandidate(imageData, mask, candidate);
    }

    const best = candidates.reduce((currentBest, candidate) => (
        candidate.score > currentBest.score ? candidate : currentBest
    ));
    const newerCandidate = candidates.find(candidate => (
        candidate.margin === CONSTANTS.MARGIN_LARGE_NEW ||
        candidate.margin === CONSTANTS.MARGIN_SMALL_NEW
    ));

    // 新版 Gemini 樣本會落在 192/96px 邊距；分數接近時優先使用新版位置。
    if (
        newerCandidate &&
        newerCandidate.score >= CONSTANTS.POSITION_SCORE_THRESHOLD &&
        newerCandidate.score >= best.score - CONSTANTS.POSITION_SCORE_TOLERANCE
    ) {
        return newerCandidate;
    }

    return best;
}

/**
 * 使用遮罩與影像灰階值的相關性評分，估計候選區域是否像 Gemini 星形浮水印。
 * 計算皮爾森相關係數 (Pearson Correlation Coefficient) 作為相關度指標。
 */
function scoreWatermarkCandidate(imageData, mask, region) {
    const data = imageData.data;
    const stride = imageData.width * 4;
    const sampleStep = 1;
    let sumMask = 0;
    let sumGray = 0;
    let count = 0;

    for (let my = 0; my < mask.height; my += sampleStep) {
        for (let mx = 0; mx < mask.width; mx += sampleStep) {
            const maskValue = mask.alphas[my * mask.width + mx];
            const idx = ((region.y + my) * stride) + ((region.x + mx) * 4);
            const gray = data[idx] * 0.299 + data[idx + 1] * 0.587 + data[idx + 2] * 0.114;

            sumMask += maskValue;
            sumGray += gray;
            count++;
        }
    }

    const meanMask = sumMask / count;
    const meanGray = sumGray / count;
    let covariance = 0;
    let maskVariance = 0;
    let grayVariance = 0;

    for (let my = 0; my < mask.height; my += sampleStep) {
        for (let mx = 0; mx < mask.width; mx += sampleStep) {
            const maskDiff = mask.alphas[my * mask.width + mx] - meanMask;
            const idx = ((region.y + my) * stride) + ((region.x + mx) * 4);
            const gray = data[idx] * 0.299 + data[idx + 1] * 0.587 + data[idx + 2] * 0.114;
            const grayDiff = gray - meanGray;

            covariance += maskDiff * grayDiff;
            maskVariance += maskDiff * maskDiff;
            grayVariance += grayDiff * grayDiff;
        }
    }

    if (maskVariance <= 0 || grayVariance <= 0) return 0;
    return covariance / Math.sqrt(maskVariance * grayVariance);
}

/**
 * 估算最佳的浮水印強度增益值 (alphaGain)
 * 使用改良的直方圖分析 + 參考比對演算法
 *
 * 原理：
 * 1. 分析水印區域的亮度分佈
 * 2. 分析相鄰背景的亮度分佈
 * 3. 找出水印的實際亮度值（白或黑）
 * 4. 計算需要的增益值
 */
function estimateOptimalGain(imageData, mask, posX, posY) {
    const data = imageData.data;
    const w = imageData.width;
    const h = imageData.height;
    const stride = w * 4;

    // 收集水印區域的有效像素（包含座標）
    const watermarkPixels = [];
    const watermarkBrightness = [];

    for (let my = 0; my < mask.height; my++) {
        for (let mx = 0; mx < mask.width; mx++) {
            const alpha = mask.alphas[my * mask.width + mx];
            if (alpha > 0.1) {
                const ix = posX + mx;
                const iy = posY + my;
                if (ix >= 0 && ix < w && iy >= 0 && iy < h) {
                    const idx = iy * stride + ix * 4;
                    const r = data[idx];
                    const g = data[idx + 1];
                    const b = data[idx + 2];
                    const brightness = r * 0.299 + g * 0.587 + b * 0.114;
                    watermarkPixels.push({ x: ix, y: iy, r, g, b, brightness, alpha });
                    watermarkBrightness.push(brightness);
                }
            }
        }
    }

    if (watermarkBrightness.length < 10) {
        return 0.5;
    }

    // 收集背景像素
    const backgroundPixels = [];
    const sampleRange = 15;
    const margin = 5;

    for (const px of watermarkPixels) {
        const directions = [
            { dx: -1, dy: 0 },
            { dx: 1, dy: 0 },
            { dx: 0, dy: -1 },
            { dx: 0, dy: 1 }
        ];

        for (const dir of directions) {
            for (let dist = margin; dist <= sampleRange; dist++) {
                const bx = px.x + dir.dx * dist;
                const by = px.y + dir.dy * dist;

                // 確認在 image 範圍內且不在 mask 內
                const inMask = bx >= posX && bx < posX + mask.width &&
                               by >= posY && by < posY + mask.height;
                if (inMask) {
                    const mIdx = Math.round(by - posY) * mask.width + Math.round(bx - posX);
                    if (mIdx >= 0 && mIdx < mask.alphas.length && mask.alphas[mIdx] > 0.1) {
                        continue; // 仍在水印區域
                    }
                }

                if (bx >= 0 && bx < w && by >= 0 && by < h) {
                    const idx = Math.round(by) * stride + Math.round(bx) * 4;
                    const br = data[idx] * 0.299 + data[idx + 1] * 0.587 + data[idx + 2] * 0.114;
                    backgroundPixels.push(br);
                    break;
                }
            }
        }
    }

    // 也從水印區域外的大範圍取樣背景
    const outerMargin = Math.max(mask.width, mask.height) + 10;
    for (let sy = Math.max(0, posY - outerMargin); sy < Math.min(h, posY + mask.height + outerMargin); sy += 20) {
        for (let sx = Math.max(0, posX - outerMargin); sx < Math.min(w, posX + mask.width + outerMargin); sx += 20) {
            const inMask = sx >= posX && sx < posX + mask.width && sy >= posY && sy < posY + mask.height;
            if (!inMask) {
                const idx = sy * stride + sx * 4;
                backgroundPixels.push(data[idx] * 0.299 + data[idx + 1] * 0.587 + data[idx + 2] * 0.114);
            }
        }
    }

    if (backgroundPixels.length < 10) {
        return 0.5;
    }

    const wmStats = calculateStats(watermarkBrightness);
    const bgStats = calculateStats(backgroundPixels);

    // 決定水印類型
    const brightnessDiff = wmStats.median - bgStats.median;
    const isLightWatermark = brightnessDiff > 0;

    // 根據水印類型和亮度差異估算初步增益
    let estimatedGain = 0.5;
    const p95 = percentile([...watermarkBrightness].sort((a, b) => a - b), 0.95);

    if (isLightWatermark) {
        const brightnessExcess = wmStats.median - bgStats.median;
        if (brightnessExcess > 60 || p95 > bgStats.median + 80) {
            estimatedGain = 0.25; // 水印很明顯亮
        } else if (brightnessExcess > 40 || p95 > bgStats.median + 60) {
            estimatedGain = 0.35;
        } else if (brightnessExcess > 20 || p95 > bgStats.median + 40) {
            estimatedGain = 0.5;
        } else if (brightnessExcess > 10) {
            estimatedGain = 0.65;
        }
    } else {
        const brightnessDeficit = bgStats.median - wmStats.median;
        if (brightnessDeficit > 60) {
            estimatedGain = 0.2;
        } else if (brightnessDeficit > 40) {
            estimatedGain = 0.3;
        } else if (brightnessDeficit > 20) {
            estimatedGain = 0.45;
        } else if (brightnessDeficit > 10) {
            estimatedGain = 0.55;
        }
    }

    // 細調：在估計值附近搜尋
    const adjustedGain = fineTuneGain(imageData, mask, posX, posY, estimatedGain, watermarkPixels, backgroundPixels);

    // 返回未四捨五入的值，允許外層套用偏移
    return Math.max(CONSTANTS.GAIN_LIMIT_MIN, Math.min(CONSTANTS.GAIN_LIMIT_MAX, adjustedGain));
}

/**
 * 計算一組數值的統計資料
 */
function calculateStats(values) {
    if (values.length === 0) return { mean: 0, median: 0, stdDev: 0, p25: 0, p75: 0 };

    const sorted = [...values].sort((a, b) => a - b);
    const n = sorted.length;
    const sum = sorted.reduce((a, b) => a + b, 0);
    const mean = sum / n;

    // 中位數
    const median = n % 2 === 0
        ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2
        : sorted[Math.floor(n / 2)];

    // 標準差
    const variance = sorted.reduce((acc, val) => acc + (val - mean) ** 2, 0) / n;
    const stdDev = Math.sqrt(variance);

    // 四分位數
    const p25 = percentile(sorted, 0.25);
    const p75 = percentile(sorted, 0.75);

    return { mean, median, stdDev, p25, p75 };
}

/**
 * 計算百分位數
 */
function percentile(sortedValues, p) {
    if (sortedValues.length === 0) return 0;
    const index = (sortedValues.length - 1) * p;
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    if (lower === upper) return sortedValues[lower];
    return sortedValues[lower] + (sortedValues[upper] - sortedValues[lower]) * (index - lower);
}

/**
 * 在估計值附近進行細調
 * 返回最佳增益值
 */
function fineTuneGain(imageData, mask, posX, posY, baseGain, watermarkPixels, backgroundPixels) {
    const data = imageData.data;
    const w = imageData.width;
    const h = imageData.height;
    const stride = w * 4;

    // 搜尋範圍：baseGain ± 0.25
    const searchStart = Math.max(0.1, baseGain - 0.25);
    const searchEnd = Math.min(1.5, baseGain + 0.25);
    const step = 0.05;

    let bestGain = baseGain;
    let bestScore = Number.NEGATIVE_INFINITY;

    // 計算背景的平均亮度
    const bgMean = backgroundPixels.reduce((a, b) => a + b, 0) / backgroundPixels.length;

    for (let g = searchStart; g <= searchEnd; g += step) {
        // 評估 gain 的效果：
        // 理論上，處理後的水印區域亮度應該與背景接近
        // 計算處理後所有水印像素與背景平均亮度的差異

        let totalAbsDiff = 0;
        let count = 0;

        for (const px of watermarkPixels) {
            if (px.alpha < 0.15) continue;

            // 逆向 Alpha 混合（假設水印是亮的，LOGO_VALUE = 255）
            const effectiveAlpha = Math.min(0.95, px.alpha * g);
            const oneMinusAlpha = 1.0 - effectiveAlpha;
            const idx = px.y * stride + px.x * 4;

            const r = data[idx];
            const gv = data[idx + 1];
            const bv = data[idx + 2];

            // 逆混合：original = (current - alpha * 255) / (1 - alpha)
            const originalR = oneMinusAlpha > 0.01 ? (r - effectiveAlpha * 255) / oneMinusAlpha : r;
            const originalG = oneMinusAlpha > 0.01 ? (gv - effectiveAlpha * 255) / oneMinusAlpha : gv;
            const originalB = oneMinusAlpha > 0.01 ? (bv - effectiveAlpha * 255) / oneMinusAlpha : bv;
            const originalBrightness = originalR * 0.299 + originalG * 0.587 + originalB * 0.114;

            totalAbsDiff += Math.abs(originalBrightness - bgMean);
            count++;
        }

        if (count === 0) continue;

        const avgDiff = totalAbsDiff / count;

        // 分數越高越好（處理後與背景越接近越好）
        // 理想情況：avgDiff = 0，但考慮到 JPEG 壓縮等因素，5-15 的差異是可接受的
        // 用高斯衰減：差異越小分數越高
        const diffScore = Math.exp(-avgDiff / 20);

        // 額外評估：處理後內部是否一致（標準差）
        const correctedBrightnesses = [];
        for (const px of watermarkPixels) {
            if (px.alpha < 0.15) continue;
            const effectiveAlpha = Math.min(0.95, px.alpha * g);
            const oneMinusAlpha = 1.0 - effectiveAlpha;
            const idx = px.y * stride + px.x * 4;
            const br = data[idx] * 0.299 + data[idx + 1] * 0.587 + data[idx + 2] * 0.114;
            const corrBr = oneMinusAlpha > 0.01 ? (br - effectiveAlpha * 255) / oneMinusAlpha : br;
            correctedBrightnesses.push(corrBr);
        }

        let uniformityScore = 0.5;
        if (correctedBrightnesses.length > 1) {
            const mean = correctedBrightnesses.reduce((a, b) => a + b, 0) / correctedBrightnesses.length;
            const variance = correctedBrightnesses.reduce((acc, val) => acc + (val - mean) ** 2, 0) / correctedBrightnesses.length;
            const stdDev = Math.sqrt(variance);
            // 標準差越小越好（< 10 為理想）
            uniformityScore = Math.max(0, 1 - stdDev / 30);
        }

        const totalScore = diffScore * 0.6 + uniformityScore * 0.4;

        if (totalScore > bestScore) {
            bestScore = totalScore;
            bestGain = g;
        }
    }

    return bestGain;
}

/**
 * 評估某個 gain 值的效果
 * 返回多維度評分
 */

/**
 * 將浮點數限制在 0-255 範圍內
 */
function clamp8(val) {
    if (val < 0) return 0;
    if (val > 255) return 255;
    return val;
}

/**
 * 將增益值限制在允許範圍內，並四捨五入到小數點後兩位
 * @param {number} gain - 增益值
 * @returns {number} - 限制並四捨五入後的增益值
 */
function clampGain(gain) {
    const clamped = Math.max(CONSTANTS.GAIN_LIMIT_MIN, Math.min(CONSTANTS.GAIN_LIMIT_MAX, gain));
    return parseFloat(clamped.toFixed(2));
}
