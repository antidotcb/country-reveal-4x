/** @type {HTMLButtonElement} */
const button = document.getElementById("init-btn");
/** @type {HTMLButtonElement} */
const close_btn = document.getElementById("close-btn");
const statusEl = document.getElementById("status");

function setStatus(text, mode) {
    statusEl.textContent = text;
    statusEl.classList.remove("ready", "error", "muted");
    if (mode) statusEl.classList.add(mode);
}

function checkReadyState() {
    // noinspection JSIgnoredPromiseFromCall
    chrome.runtime.sendMessage({action: "isReady"}, (response) => {
        if (chrome.runtime.lastError) {
            setStatus("Error communicating with the extension's background.", "error");
            button.disabled = true;
            return;
        }

        if (response && response.ready) {
            setStatus("Extension is ready! You can close this page.", "ready");
            close_btn.textContent = "OK";
            close_btn.style.display = "block";
            close_btn.disabled = false;
            // window.close();
        } else {
            setStatus("Waiting for initialization... Please browse https://x.com/x/about to capture necessary data.", "muted");
            button.disabled = true;
            button.style.display = "none";
            setTimeout(checkReadyState, 500); // Poll every 500ms
        }
    });
}

close_btn.addEventListener("click", () => window.close());

button.addEventListener("click", () => {
    button.disabled = true;
    setStatus("Opening X about page in a new tab...", "muted");

    const newWin = window.open("https://x.com/x/about", "_blank");
    if (!newWin) {
        setStatus("Could not open X. Please open https://x.com/x/about manually.", "error");
        button.disabled = false;
        return;
    }

    newWin.addEventListener("loadstart", () => {
        chrome.storage.local.set({initialized: true}, () => {
            setStatus("Initialization started. Once the X page finishes loading, the extension is ready.", "ready");
        });
    });
    checkReadyState();
});
