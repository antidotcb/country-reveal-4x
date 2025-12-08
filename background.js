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

const DEBUG = false;
const CONFIG = {
    TIMING: {
        REQUEST_DELAY: 500,
        VARIANCE: 100,
        BACKOFF_429: 700000,
        FETCH_TIMEOUT: 10000
    },

    CACHE: {
        TTL: 30 * 24 * 60 * 60 * 1000,
        STALE: 7 * 24 * 60 * 60 * 1000,
    },

    CONDITIONS: {
        QUEUE_IDLE_THRESHOLD: 60 * 1000,
        RATE_LIMIT_SAFE_WINDOW: 2 * 60 * 60 * 1000
    }
};
let state = {
    queryId: null, bearerToken: null, csrfToken: null
};
let sessionStats = {
    fetched: 0,
    maxQueue: 0
};
let lastQuota = "Unknown";
const activeRequests = new Map();
const requestQueue = [];
let isProcessingQueue = false;
let isRateLimited = false;
let currentProcessingUser = null;
let lastActivityTime = Date.now();
let lastRateLimitTime = 0;
let rateLimitUntil = 0;

function logger(type, ...args) {
    if (!DEBUG) return;
    const prefix = `[BG-${type}]`;
    console.log(prefix, ...args);
    chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
        if (!tabs?.[0]?.id) return;
        chrome.tabs.sendMessage(tabs[0].id, {
            action: "LOG_FORWARD", source: "BACKGROUND", type: type, data: args
        }).catch((/*err*/) => {
        });
    });
}

const StorageManager = {
    /**
     * @param {string} username
     * @returns {Promise<{value: any, timestamp: number}|null>}
     */
    async get(username) {
        try {
            const key = `u_${username}`;
            const result = await chrome.storage.local.get(key);
            return result[key] || null;
        } catch (e) {
            logger("STORAGE", "Read Error", e);
            return null;
        }
    },

    /**
     * @param {string} username
     * @param {any} value
     */
    async set(username, value) {
        try {
            const key = `u_${username}`;
            const data = {value: value, timestamp: Date.now()};
            await chrome.storage.local.set({[key]: data});
        } catch (e) {
            logger("STORAGE", "Write Error", e);
        }
    }
};
chrome.storage.local.get(['queryId', 'bearerToken', 'rateLimitUntil', 'lastRateLimitTime']).then((result) => {
    if (result.queryId) state.queryId = result.queryId;
    if (result.bearerToken) state.bearerToken = result.bearerToken;
    if (result.lastRateLimitTime) lastRateLimitTime = result.lastRateLimitTime;
    if (result.rateLimitUntil) {
        rateLimitUntil = result.rateLimitUntil;
        const now = Date.now();
        if (result.rateLimitUntil > now) {
            const remainingMs = result.rateLimitUntil - now;
            logger("INIT", `⚠️ SYSTEM RESTORED IN LOCKED STATE. Remaining time {${remainingMs}ms}`);
            triggerRateLimit(remainingMs);
        } else {
            chrome.storage.local.remove('rateLimitUntil').catch((err) => {
                logger("STORAGE", "⚠️ Failed to store rate limit until:", err);
            });
            logger("INIT", "✅ Previous ban expired.");
        }
    } else {
        logger("INIT", "✅ System Ready.");
    }

    startQueueMonitor();
});

/** @type {string[]} */
const extraInfoSpec = ["requestHeaders", "extraHeaders"];
// noinspection JSCheckFunctionSignatures
chrome.webRequest.onBeforeSendHeaders.addListener((details) => {
    const authHeader = details.requestHeaders.find(h => h.name.toLowerCase() === 'authorization');
    if (authHeader && authHeader.value !== state.bearerToken) {
        state.bearerToken = authHeader.value;
        chrome.storage.local.set({bearerToken: state.bearerToken}).catch((err) => {
            logger("STORAGE", "⚠️ Failed to store bearer token:", err);
        });
        logger("SNIFF", "✅ Captured NEW Bearer Token");
    }
}, {urls: ["*://x.com/*", "*://twitter.com/*"]}, extraInfoSpec);

chrome.webRequest.onBeforeRequest.addListener((details) => {
    if (details.url.includes("AboutAccountQuery")) {
        const match = details.url.match(/graphql\/([a-zA-Z0-9_-]+)\/AboutAccountQuery/);
        if (match && match[1] && match[1] !== state.queryId) {
            state.queryId = match[1];
            chrome.storage.local.set({queryId: state.queryId}).catch((err) => {
                logger("STORAGE", "⚠️ Failed to store query id:", err);
            });
            logger("SNIFF", "✅ Captured NEW Query ID");
        }
    }
}, {urls: ["*://x.com/i/api/graphql/*", "*://twitter.com/i/api/graphql/*"]});

function startQueueMonitor() {
    setInterval(() => {
        if (requestQueue.length > sessionStats.maxQueue) {
            sessionStats.maxQueue = requestQueue.length;
        }
        const timeSinceActivity = Date.now() - lastActivityTime;
        const isStuck = !isRateLimited && requestQueue.length > 0 && !currentProcessingUser && timeSinceActivity > 5000;

        if (isStuck) {
            logger("WATCHDOG", `⚠️ Queue stuck! (Idle for ${timeSinceActivity}ms). Forcing restart.`);
            isProcessingQueue = false;
            processQueue().catch(err => logger("ERROR", "Watchdog restart failed", err));
            lastActivityTime = Date.now();
            return;
        }

        if (!currentProcessingUser && requestQueue.length === 0) return;

        const nextUp = requestQueue.slice(0, 3).map(item => item.screenName).join(", ");
        let rateState = "";
        if (isRateLimited) {
            const now = Date.now();
            const remainingMs = rateLimitUntil ? Math.max(0, rateLimitUntil - now) : 0;
            const remainingSec = Math.ceil(remainingMs / 1000);
            const liftAt = rateLimitUntil ? new Date(rateLimitUntil).toLocaleTimeString() : "unknown";
            rateState = ` | RATE_LIMIT: locked for ${remainingSec}s (lifts at ${liftAt})`;
        }

        logger("MONITOR", `Active: ${currentProcessingUser || "Idle"} | Queue: ${requestQueue.length} [${nextUp}...]${rateState}`);
    }, 1000);
}

function isSystemSafeForBackgroundUpdates() {
    const now = Date.now();
    const isQueueIdle = (requestQueue.length === 0) && (!currentProcessingUser) && (now - lastActivityTime > CONFIG.CONDITIONS.QUEUE_IDLE_THRESHOLD);
    const isSafeFromBan = (now - lastRateLimitTime > CONFIG.CONDITIONS.RATE_LIMIT_SAFE_WINDOW);

    return isQueueIdle && isSafeFromBan;
}

function triggerRateLimit(durationMs) {
    if (isRateLimited) return;

    isRateLimited = true;
    isProcessingQueue = false;
    currentProcessingUser = null;
    lastQuota = "Locked";

    const unlockTime = Date.now() + durationMs;
    lastRateLimitTime = Date.now();
    rateLimitUntil = unlockTime;
    chrome.storage.local.set({
        rateLimitUntil: unlockTime, lastRateLimitTime: lastRateLimitTime
    }).catch((err) => {
        logger("STORAGE", "⚠️ Failed to store rate limit until & last rate limit time:", err);
    });

    logger("LIMIT", `🔒 LOCKDOWN for ${(durationMs / 1000).toFixed(0)}s`);

    setTimeout(() => {
        isRateLimited = false;
        rateLimitUntil = 0;
        chrome.storage.local.remove('rateLimitUntil').catch((err) => {
            logger("STORAGE", "⚠️ Failed to remove rate limit until from storage", err);
        });
        logger("LIMIT", "🟢 COOLDOWN EXPIRED. Resuming.");
        processQueue().catch(err => logger("ERROR", "Queue resume failed", err));
    }, durationMs);
}

async function processQueue() {
    if (isRateLimited) {
        logger("QUEUE", "⛔ Blocked: Rate Limit active.");
        return;
    }
    if (isProcessingQueue) return;

    if (requestQueue.length === 0) {
        logger("QUEUE", "✅ Queue empty. Idle.");
        return;
    }

    isProcessingQueue = true;
    lastActivityTime = Date.now();

    const {screenName, resolve, reject} = requestQueue.shift();

    currentProcessingUser = screenName;
    logger("QUEUE", `▶️ Processing: @${screenName}. Remaining in queue: ${requestQueue.length}`);

    try {
        const result = await executeFetch(screenName);
        if (result && !result.error) {
            sessionStats.fetched++;
            logger("QUEUE", `📦 Result from executeFetch for @${screenName}:`, result);
            resolve(result);
        } else {
            let err = result.error || "Unknown Error";
            logger("ERROR", `❌ Error processing @${screenName}:`, err);
            reject(err);
        }
    } catch (err) {
        logger("QUEUE", `❌ Unhandled Error processing @${screenName}:`, err, err?.stack || "");
        reject(err);
    }

    currentProcessingUser = null;
    lastActivityTime = Date.now();

    const randomJitter = (Math.random() * (CONFIG.TIMING.VARIANCE * 2)) - CONFIG.TIMING.VARIANCE;
    const nextDelay = Math.floor(CONFIG.TIMING.REQUEST_DELAY + randomJitter);

    logger("QUEUE", `💤 Sleeping for ${nextDelay}ms before next request...`);

    setTimeout(() => {
        isProcessingQueue = false;
        processQueue().catch((err) => {
            logger("ERROR", "Queue restart failed", err);
        });
    }, nextDelay);
}

/**
 * @typedef {object} AboutProfile
 * @property {string|null} account_based_in
 * @property {bool|null} location_accurate
 */

/**
 * @typedef {object} UserResult
 * @property {AboutProfile} [about_profile]
 */

/**
 * @typedef {object} UserResultByScreenName
 * @property {UserResult} [result]
 */

/**
 * @typedef {object} GraphQLData
 * @property {UserResultByScreenName} [user_result_by_screen_name]
 */

/**
 * @typedef {object} GraphQLResponse
 * @property {GraphQLData} [data]
 */
async function executeFetch(screenName) {
    logger("API", `▶️ enter executeFetch(@${screenName})`, {
        hasQueryId: !!state.queryId, hasBearer: !!state.bearerToken
    });

    if (!state.queryId || !state.bearerToken) {
        logger("API", `⏭ NOT_READY for @${screenName}`, {
            queryId: state.queryId, hasBearer: !!state.bearerToken
        });
        return {error: "NOT_READY"};
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CONFIG.TIMING.FETCH_TIMEOUT);

    try {
        const cookies = await chrome.cookies.get({url: "https://x.com", name: "ct0"});
        if (!cookies) {
            logger("API", `⏭ LOGIN_REQUIRED for @${screenName}`);
            return {error: "LOGIN_REQUIRED"};
        }

        const variables = {screenName: screenName};
        const url = `https://x.com/i/api/graphql/${state.queryId}/AboutAccountQuery?variables=${encodeURIComponent(JSON.stringify(variables))}`;

        logger("NET", `🚀 Sending HTTP Request for @${screenName}...`, {url});
        const startTime = Date.now();

        const response = await fetch(url, {
            method: "GET", headers: {
                "authorization": state.bearerToken, "x-csrf-token": cookies.value, "content-type": "application/json"
            }, signal: controller.signal
        });

        const duration = Date.now() - startTime;
        logger("API", `📡 Response received for @${screenName}`, {
            status: response.status, duration
        });

        if (response.status === 429) {
            lastQuota = "0";
            const resetHeader = response.headers.get('x-rate-limit-reset');
            const remainingHeader = response.headers.get('x-rate-limit-remaining');

            let waitTime = CONFIG.TIMING.BACKOFF_429;
            let debugMsg = "No headers found, using fallback 10m.";

            if (resetHeader) {
                const resetTimeMs = parseInt(resetHeader) * 1000;
                const nowMs = Date.now();
                const diff = resetTimeMs - nowMs;

                if (diff > 0) {
                    waitTime = diff + 2000;
                    debugMsg = `Header says reset at ${new Date(resetTimeMs).toLocaleTimeString()}`;
                }
            }

            logger("API", `⚠️ RATE LIMIT HIT! [Quota: ${remainingHeader}] [${debugMsg}]`);
            triggerRateLimit(waitTime);
            return {error: "RATE_LIMIT"};
        }

        if (!response.ok) {
            const body = await response.text().catch(() => '"body read failed"');
            logger("API", `❌ Network Error: ${response.status}`, body);
            return null;
        }

        const quotaLeft = response.headers.get('x-rate-limit-remaining');
        if (quotaLeft) lastQuota = quotaLeft;

        const quotaInfo = quotaLeft ? `(Quota Left: ${quotaLeft})` : "";

        let data;
        try {
            data = await response.json();
        } catch (jsonErr) {
            logger("API", `❌ JSON parse error for @${screenName}:`, jsonErr.toString());
            return null;
        }

        const result = data?.data?.user_result_by_screen_name?.result;
        const about = result?.about_profile || null;
        const country = about?.account_based_in || null;

        logger("API", `✅ Success (${duration}ms): @${screenName} -> ${country || "Unknown"} ${quotaInfo}`, {
            hasResult: !!result, hasAboutProfile: !!about
        });
        return {
            country: country,
            about_profile: about
        };

    } catch (error) {
        if (error.name === 'AbortError') {
            logger("API", `❌ Timeout: @${screenName} took too long.`, error.toString());
        } else {
            logger("API", `❌ Fetch Error for @${screenName}:`, error.toString(), error.stack || "");
        }
        return null;
    } finally {
        clearTimeout(timeoutId);
        logger("API", `⏹ exit executeFetch(@${screenName})`);
    }
}

function getCountrySmart(screenName) {
    if (activeRequests.has(screenName)) {
        logger("DEDUP", `🔗 Piggybacking @${screenName}`);
        return activeRequests.get(screenName);
    }
    const task = async () => {
        const cachedEntry = await StorageManager.get(screenName);

        if (cachedEntry) {
            const age = Date.now() - cachedEntry.timestamp;
            const ageDays = (age / (1000 * 60 * 60 * 24)).toFixed(1);
            let cachedValue = null;
            if (cachedEntry.hasOwnProperty('value')) {
                cachedValue = cachedEntry.value;
            } else if (cachedEntry.hasOwnProperty('country')) {
                cachedValue = cachedEntry.country;
            }
            let cachedCountry = null;
            if (typeof cachedValue === 'string') {
                cachedCountry = cachedValue;
            } else if (cachedValue && typeof cachedValue === 'object') {
                cachedCountry = cachedValue.country || null;
            }
            if (age < CONFIG.CACHE.STALE) {
                logger("CACHE", `⚡ Fresh (${ageDays}d): @${screenName}`);
                return {
                    country: cachedCountry,
                    about_profile: cachedValue && cachedValue.about_profile ? cachedValue.about_profile : null
                };
            }
            if (age < CONFIG.CACHE.TTL) {
                logger("CACHE", `🍂 Stale (${ageDays}d): @${screenName} - Returning cached val.`);
                if (isSystemSafeForBackgroundUpdates()) {
                    logger("UPDATE", `🔄 Scheduling background update for @${screenName}`);
                    enqueueBackgroundUpdate(screenName);
                } else {
                    logger("UPDATE", `zzz Skipped update for @${screenName} (System busy/unsafe)`);
                }

                return {
                    country: cachedCountry,
                    about_profile: cachedValue && cachedValue.about_profile ? cachedValue.about_profile : null
                };
            }
            logger("CACHE", `💀 Expired (${ageDays}d): @${screenName} - Fetching new.`);
        }
        return enqueueNewRequest(screenName);
    };
    return task();
}

function enqueueNewRequest(screenName) {
    if (activeRequests.has(screenName)) return activeRequests.get(screenName);

    logger("QUEUE", `📥 Enqueueing @${screenName}. Queue Position: ${requestQueue.length + 1}`);

    const promise = new Promise((resolve, reject) => {
        requestQueue.push({screenName, resolve, reject});
        processQueue().catch(err => logger("ERROR", "Queue kickstart failed", err));
    }).then(result => {
        logger("QUEUE", `🎯 Final result for @${screenName}:`, result);
        if (result) {
            StorageManager.set(screenName, result).catch(err => {
                logger("ERROR", "Storage write failed", err);
            });
        }
        activeRequests.delete(screenName);
        return result;
    }).catch(err => {
        logger("QUEUE", `🔥 Promise chain error for @${screenName}:`, err, err?.stack || "");
        activeRequests.delete(screenName);
        throw err;
    });

    activeRequests.set(screenName, promise);
    return promise;
}

function enqueueBackgroundUpdate(screenName) {
    if (activeRequests.has(screenName)) return;

    const promise = new Promise((resolve, reject) => {
        requestQueue.push({screenName, resolve, reject});
        processQueue().catch(err => {
            logger("ERROR", `Queue restart failed for background @${screenName}`, err);
            reject(err);
        });
    }).then(result => {
        logger("UPDATE", `🎯 Background result for @${screenName}:`, result);
        if (result) {
            StorageManager.set(screenName, result).catch(err => {
                logger("ERROR", "Storage write failed", err);
            });
            if (result.country) logger("UPDATE", `✅ Updated storage for @${screenName}`);
        }
        activeRequests.delete(screenName);
    }).catch(err => {
        logger("UPDATE", `🔥 Background update failed for @${screenName}:`, err, err?.stack || "");
        activeRequests.delete(screenName);
    });

    activeRequests.set(screenName, promise);
}

function getStats(sendResponse) {
    (async () => {
        const allData = await chrome.storage.local.get(null);
        const keys = Object.keys(allData).filter(k => k.startsWith('u_'));
        const countryCounts = {};
        keys.forEach(k => {
            const item = allData[k];
            let val = item.value || item.country;
            let c = (typeof val === 'string') ? val : (val?.country || null);

            if (c) {
                countryCounts[c] = (countryCounts[c] || 0) + 1;
            }
        });
        const top5 = Object.entries(countryCounts)
            .sort(([, a], [, b]) => b - a)
            .slice(0, 5)
            .map(([name, count]) => ({name, count}));
        const bytes = await chrome.storage.local.getBytesInUse(null);
        const nextUp = requestQueue.length > 0 ? requestQueue[0].screenName : "None";
        let timeLeft = 0;
        if (isRateLimited && rateLimitUntil) {
            timeLeft = Math.max(0, rateLimitUntil - Date.now());
        }

        sendResponse({
            status: isRateLimited ? "🔒 Rate Limit reached" : "Active",
            lockdownRemaining: timeLeft,
            quota: isRateLimited ? "(Locked)" : lastQuota,
            queueLength: requestQueue.length,
            maxQueue: sessionStats.maxQueue,
            nextUp: nextUp,
            sessionFetched: sessionStats.fetched,
            totalFetched: keys.length,
            cacheSize: bytes,
            topCountries: top5
        });
    })();
}

function performWipe(sendResponse) {
    logger("STORAGE", "🧹 Clearing database and purging queue...");
    requestQueue.forEach(task => {
        try {
            task.reject(new Error("Database cleared"));
        } catch (e) { /* ignore */
        }
    });
    requestQueue.length = 0;
    activeRequests.clear();
    sessionStats = {fetched: 0, maxQueue: 0};
    const keysToKeep = ['queryId', 'bearerToken', 'rateLimitUntil', 'lastRateLimitTime'];

    chrome.storage.local.get(keysToKeep, (preservedData) => {
        chrome.storage.local.clear(() => {
            // noinspection JSCheckFunctionSignatures
            chrome.storage.local.set(preservedData, () => {
                logger("STORAGE", "✅ System Reset Complete. Safety config restored.");
                sendResponse({status: "CLEARED"});
            });
        });
    });
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "getCountry") {
        getCountrySmart(request.screenName || request.username)
            .then(sendResponse)
            .catch(err => {
                logger("QUEUE", "⚠️ getCountry failed:", err);
                sendResponse({error: String(err)});
            });
    }

    if (request.action === "getStats") {
        getStats(sendResponse);
    }

    if (request.action === "clearStorage") {
        performWipe(sendResponse);
    }

    if (request.action === "isReady") {
        const isReady = !!(state.queryId && state.bearerToken);
        sendResponse({ready: isReady});
    }

    return true;
});

chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === "install") {
        // noinspection JSIgnoredPromiseFromCall
        chrome.tabs.create({
            url: chrome.runtime.getURL("setup.html")
        });
    }
});
