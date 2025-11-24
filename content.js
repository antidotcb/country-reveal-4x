/* MIT License

Copyright (c) 2025 antidotcb

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE. */

function log(type, ...args) {
    if (!DEBUG) return;
    console.log(`%c[Content-${type}]`, "color: #00ccff; font-weight: bold;", ...args);
}

/* global chrome */
chrome.runtime.onMessage.addListener((msg) => {
    if (!DEBUG) return;
    if (msg.action === "LOG_FORWARD") {
        console.log(`%c[Background-${msg.type}]`, "color: #d633ff; font-weight: bold;", ...msg.data);
    }
});


const processedElements = new WeakSet();
const localCountryCache = new Map();

function insertTempIndicator(element, emoji = '⏳', tooltip = 'Pending') {
    if (!element || !element.isConnected) return;
    if (element.querySelector('.x-country-temp')) return;

    const temp = document.createElement('span');
    temp.className = 'x-country-flag x-country-temp';
    temp.textContent = emoji;
    temp.setAttribute('title', tooltip);
    temp.setAttribute('data-tooltip', tooltip);
    temp.setAttribute('tabindex', '0');
    temp.setAttribute('role', 'button');

    temp.addEventListener('mouseenter', () => showTooltipFor(temp));
    temp.addEventListener('mouseleave', () => hideTooltip());
    temp.addEventListener('focus', () => showTooltipFor(temp));
    temp.addEventListener('blur', () => hideTooltip());

    const textContainer = element.querySelector('div[dir="ltr"] > span') || element;
    if (textContainer) {
        textContainer.prepend(temp);
    } else {
        element.prepend(temp);
    }
}

function clearTempIndicator(element) {
    if (!element) return;
    const temp = element.querySelector('.x-country-temp');
    if (temp && temp.parentNode) {
        try {
            temp.parentNode.removeChild(temp);
        } catch (e) {
        }
    }
}

/**
 * @typedef {object} UsernameChanges
 * @property {number|null} count
 */

/**
 * @typedef {object} AboutProfile
 * @property {string|null} account_based_in
 * @property {bool|null} location_accurate
 * @property {UsernameChanges|null} username_changes
 */

function processLink(element) {
    if (processedElements.has(element)) {
        return;
    }

    const href = element.getAttribute('href');
    if (!href) return;

    const username = href.substring(1);

    if (!username || username.includes('/') || ["home", "explore", "notifications", "messages", "bookmarks", "settings"].includes(username)) {
        return;
    }

    const hasAtSymbol = element.textContent.includes("@") || (element.firstChild && element.firstChild.textContent && element.firstChild.textContent.includes("@"));

    if (!hasAtSymbol) {
        return;
    }

    processedElements.add(element);
    log("DOM", `🔎 Found valid link: @${username}`);

    if (localCountryCache.has(username)) {
        let cached = localCountryCache.get(username);
        if (typeof cached === 'string') cached = {country: cached, locationAccurate: true, usernameChanges: 0};
        log("CACHE", `⚡ Instant Paint for @${username}: ${JSON.stringify(cached)}`);
        insertFlag(element, cached);
        return;
    }

    chrome.runtime.sendMessage({action: "getCountry", screenName: username})
        .then((response) => {
            if (response && response.error) {
                log("WARN", `Background returned error for @${username}:`, response.error);

                insertTempIndicator(element, '⏳', String(response.error || 'Pending'));

                const RETRY_DELAY_MS = 15000;
                setTimeout(() => {
                    clearTempIndicator(element);
                    processedElements.delete(element);
                    if (element.isConnected) {
                        processLink(element);
                    }
                }, RETRY_DELAY_MS);
                return;
            }

            if (response) {
                const info = {country: null, locationAccurate: true, usernameChanges: 0};

                if (response.country && typeof response.country === 'string') {
                    info.country = response.country;
                }

                const about = response.about_profile;
                if (about) {
                    if (about.account_based_in) info.country = about.account_based_in;
                    if (typeof about.location_accurate !== 'undefined') {
                        info.locationAccurate = (about.location_accurate === true || about.location_accurate === 'true');
                    }
                    if (about.username_changes && about.username_changes.count) {
                        const parsed = parseInt(about.username_changes.count, 10);
                        if (!isNaN(parsed)) info.usernameChanges = parsed;
                    }
                }

                if (!info.country && typeof response === 'string') {
                    console.log("DEBUG", "Response country detection failed", response);
                }

                localCountryCache.set(username, info);

                if (!element.isConnected) {
                    log("DEBUG", `⚠️ Element for @${username} was removed from DOM while fetching. Saved to cache.`);
                    return;
                }

                log("UI", `🎨 Painting flag for @${username}: ${JSON.stringify(info)}`);
                insertFlag(element, info);
            }
        })
        .catch((error) => {
            log("ERR", `Message failed for @${username}:`, error);
            insertTempIndicator(element, '⏳', String(error));
            const RETRY_DELAY_MS = 15000;
            setTimeout(() => {
                clearTempIndicator(element);
                processedElements.delete(element);
                if (element.isConnected) processLink(element);
            }, RETRY_DELAY_MS);

            processedElements.delete(element);
        });
}

function insertFlag(element, info) {
    if (element.querySelector('.x-country-flag')) {
        log("UI", "Ignored: Flag already exists.");
        return;
    }

    const country = info && info.country ? info.country : null;
    const locationAccurate = typeof (info && info.locationAccurate) === 'boolean' ? info.locationAccurate : true;
    const usernameChanges = info && typeof info.usernameChanges === 'number' ? info.usernameChanges : 0;

    /** @type {HTMLSpanElement} */
    const flagSpan = document.createElement("span");
    flagSpan.className = "x-country-flag";

    const shield = locationAccurate === false ? '🛡' : '';
    const flagEmoji = getFlagEmoji(country);
    const changeSymbol = usernameChanges > 2 ? getCircledNumber(usernameChanges) : '';

    flagSpan.textContent = `${shield}${flagEmoji}${changeSymbol ? ' ' + changeSymbol : ''}`;

    const parts = [];
    if (country) parts.push(country);
    if (locationAccurate === false) parts.push('[VPN]');
    if (usernameChanges) parts.push(`${usernameChanges} username changes`);
    const tooltipText = parts.join(' • ') || 'Unknown location';
    flagSpan.setAttribute('title', tooltipText);
    flagSpan.setAttribute('label', tooltipText);
    flagSpan.setAttribute('data-tooltip', tooltipText);

    flagSpan.setAttribute('tabindex', '0');
    flagSpan.setAttribute('role', 'button');
    flagSpan.addEventListener('mouseenter', () => showTooltipFor(flagSpan));
    flagSpan.addEventListener('mouseleave', () => hideTooltip());
    flagSpan.addEventListener('focus', () => showTooltipFor(flagSpan));
    flagSpan.addEventListener('blur', () => hideTooltip());
    flagSpan.addEventListener('touchstart', (ev) => {
        ev.stopPropagation();
        showTooltipFor(flagSpan);
    }, {passive: true});

    const textContainer = element.querySelector('div[dir="ltr"] > span') || element;

    if (textContainer) {
        textContainer.prepend(flagSpan);
    } else {
        element.prepend(flagSpan);
    }
}

let flag_tooltip = null;
let tooltip_hide_timer = null;

function createTooltip() {
    if (flag_tooltip) return flag_tooltip;
    /** @type {HTMLDivElement} */
    const el = document.createElement('div');
    el.className = 'x-country-flag-tooltip';
    el.setAttribute('role', 'tooltip');
    el.style.left = '-9999px';
    el.style.top = '-9999px';
    document.body.appendChild(el);
    flag_tooltip = el;
    log('[x-country-flag] Tooltip element created and appended to document.body');
    return el;
}

function showTooltipFor(span) {
    if (!span || !span.getAttribute) return;
    const text = span.getAttribute('data-tooltip');
    if (!text) return;
    log('[x-country-flag] showTooltipFor:', text, span);
    const tip = createTooltip();
    tip.textContent = text;

    if (tooltip_hide_timer) {
        clearTimeout(tooltip_hide_timer);
        tooltip_hide_timer = null;
    }

    const rect = span.getBoundingClientRect();
    const computedTip = tip.getBoundingClientRect();
    const tipW = computedTip.width || 160;
    const tipH = computedTip.height || 28;
    let left = rect.left + (rect.width / 2) - (tipW / 2);
    let top = rect.top - tipH - 8;
    if (top < 6) {
        top = rect.bottom + 8;
    }

    const margin = 6;
    const maxLeft = window.innerWidth - tipW - margin;
    if (left < margin) left = margin;
    if (left > maxLeft) left = maxLeft;

    tip.style.left = Math.round(left) + 'px';
    tip.style.top = Math.round(top) + 'px';

    tip.classList.add('visible');

    const cleanup = () => hideTooltip(true);
    window.addEventListener('scroll', cleanup, {passive: true});
    window.addEventListener('resize', cleanup);
    tip.cleanup = cleanup;
}

function hideTooltip(immediate = false) {
    const tip = flag_tooltip;
    if (!tip) return;
    if (tip.cleanup) {
        window.removeEventListener('scroll', tip.cleanup);
        window.removeEventListener('resize', tip.cleanup);
        tip.cleanup = null;
    }

    tip.classList.remove('visible');

    if (immediate) {
        tip.style.left = '-9999px';
        tip.style.top = '-9999px';
        tip.style.pointerEvents = 'none';
        return;
    }

    tooltip_hide_timer = setTimeout(() => {
        if (!flag_tooltip) return;
        flag_tooltip.style.left = '-9999px';
        flag_tooltip.style.top = '-9999px';
        flag_tooltip.style.pointerEvents = 'none';
        tooltip_hide_timer = null;
    }, 160);
}

const observer = new MutationObserver((mutations) => {
    let nodesScanned = 0;
    for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
            if (node.nodeType === 1) {
                nodesScanned++;
                if (node.matches('a[href^="/"]')) {
                    processLink(node);
                }
                const links = node.querySelectorAll('a[href^="/"]');
                links.forEach(processLink);
            }
        }
    }
    if (nodesScanned > 0) {
    }
});

function init() {
    log("INIT", "🚀 Extension Loaded. scanning existing links...");
    const initialLinks = document.querySelectorAll('a[href^="/"]');
    initialLinks.forEach(processLink);

    log("INIT", "Starting MutationObserver...");
    observer.observe(document.body, {
        childList: true,
        subtree: true
    });

    try {
        createTooltip();
    } catch (e) {
        console.warn('[x-country-flag] Could not create tooltip early:', e);
    }
}

init();
