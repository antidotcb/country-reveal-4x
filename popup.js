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

function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function updateUI() {
    // noinspection JSIgnoredPromiseFromCall
    chrome.runtime.sendMessage({action: "getStats"}, (response) => {
        if (!response) {
            console.log("Failed to get stats");
            alert("Failed to get stats");
            return;
        }
        console.log("Update UI:", response);
        const statusEl = document.getElementById('status-text');
        statusEl.textContent = response.status;
        statusEl.className = response.status.includes("Rate Limit") ? "value status-lockdown" : "value status-active";

        document.getElementById('quota-text').textContent = response.quota;

        /** @type {HTMLDivElement} */
        const timerRow = document.getElementById('lockdown-timer-row');
        if (response.lockdownRemaining > 0) {
            timerRow.style.display = 'flex';
            document.getElementById('lockdown-timer').textContent = (response.lockdownRemaining / 1000).toFixed(0) + "s";
        } else {
            timerRow.style.display = 'none';
        }
        document.getElementById('q-len').textContent = response.queueLength;
        document.getElementById('q-max').textContent = response.maxQueue;
        document.getElementById('q-next').textContent = response.nextUp || "-";
        document.getElementById('stat-session').textContent = response.sessionFetched;
        document.getElementById('stat-total').textContent = response.totalFetched;
        document.getElementById('stat-size').textContent = formatBytes(response.cacheSize);
        const list = document.getElementById('top-countries');
        list.innerHTML = '';

        if (response.topCountries.length === 0) {
            list.innerHTML = '<li class="country-item"><span class="label">No data yet</span></li>';
        } else {
            response.topCountries.forEach(item => {
                const li = document.createElement('li');
                li.className = 'country-item';

                const flag = getFlagEmoji(item.name);

                li.innerHTML = `
                    <span>${flag} ${item.name}</span>
                    <span class="value">${item.count}</span>
                `;
                list.appendChild(li);
            });
        }
    });
}

document.addEventListener('DOMContentLoaded', () => {
    updateUI();
    document.getElementById('refresh-btn').addEventListener('click', updateUI);

    document.getElementById('clear-btn').addEventListener('click', () => {
        const confirmed = confirm("Are you sure? This will delete all cached account/country data.");
        if (confirmed) {
            // noinspection JSIgnoredPromiseFromCall
            chrome.runtime.sendMessage({action: "clearStorage"}, () => {
                updateUI();
            });
        }
    });

    setInterval(updateUI, 1000);
});
