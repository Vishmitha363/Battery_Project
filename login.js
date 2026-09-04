// ==========================================
// LOGIN.JS — SINGLE SHARED PASSKEY
// ==========================================
//
// There is exactly ONE passkey for this system (see Passkey.txt in
// the project folder). Only someone who knows it can log in. The
// plaintext key is never stored anywhere in the browser — only a
// one-way SHA-256 hash is kept here, so the app can verify a typed
// passkey without ever being able to reveal the real one.

// SHA-256 hash of the passkey "BNC123" (see Passkey.txt)
const MASTER_PASSKEY_HASH = "cee1947fd9e1a6fd84733bb591e4db8afa9da42c5594a6cf8b53d934b58bceba";

let port = null;

// The baud rate must match the device exactly — at the wrong rate the port
// still opens, it just delivers unreadable bytes, which looks identical to
// "the device is sending nothing". Shared with the dashboard through
// localStorage so both pages open the port the same way.
const BAUD_KEY = "bmsBaudRate";

function selectedBaudRate() {

    const value = parseInt(document.getElementById("baudRate")?.value, 10);

    return !isNaN(value) && value > 0 ? value : 115200;

}

// Restore whatever was chosen last time, so the rate isn't silently reset
// to the default on every visit.
(function restoreBaudRate() {

    const saved = localStorage.getItem(BAUD_KEY);
    const select = document.getElementById("baudRate");

    if (saved && select) select.value = saved;

})();

// ==========================================
// BALANCING MODE — Active (cell-to-cell transfer) or Passive (resistor
// bleed). Remembered like Baud Rate above, and still changeable later
// from the dashboard's BALANCER CONTROL panel.
// ==========================================

const BALANCING_MODE_KEY = "bmsBalancingMode";

function setLoginBalancingMode(mode) {

    localStorage.setItem(BALANCING_MODE_KEY, mode);

    document.getElementById("modeActiveBtn").classList.toggle("selected", mode === "active");
    document.getElementById("modePassiveBtn").classList.toggle("selected", mode === "passive");

}

// Only needs to act when the saved choice differs from the HTML default
// (Active, already marked "selected" in the markup).
(function restoreBalancingMode() {

    if (localStorage.getItem(BALANCING_MODE_KEY) === "passive") setLoginBalancingMode("passive");

})();

// HTML Elements
const loginForm = document.getElementById("loginForm");
const loginBtn = document.getElementById("loginBtn");
const usbDot = document.getElementById("usbDot");
const usbStatusLabel = document.getElementById("usbStatusLabel");
const message = document.getElementById("message");
const keyPanel = document.getElementById("keyPanel");

// Initial Status
function setUsbStatus(connected) {

    usbDot.className = "status-dot " + (connected ? "connected" : "disconnected");
    usbStatusLabel.textContent = connected ? "Real Device Connected" : "Not Connected";

}

setUsbStatus(false);

loginBtn.disabled = true;

// Show a one-time "Logout successful" message if we just arrived here
// from a logout on the dashboard.
if (localStorage.getItem("logoutMessage")) {

    localStorage.removeItem("logoutMessage");

    const toast = document.getElementById("topToast");

    toast.textContent = "✅ Logout successful";
    toast.classList.add("show");

    setTimeout(() => {

        toast.classList.remove("show");

    }, 3000);

}

// Show a one-time warning if we just arrived here because the real
// device disconnected mid-session on the dashboard.
if (localStorage.getItem("deviceDisconnectedMessage")) {

    localStorage.removeItem("deviceDisconnectedMessage");

    const toast = document.getElementById("topToast");

    toast.textContent = "⚠ Device disconnected — reconnect or use Remote Monitor";
    toast.classList.add("show", "warning");

    setTimeout(() => {

        toast.classList.remove("show", "warning");

    }, 4000);

}

// Reflect whichever data source was chosen last time, so returning
// to this page (e.g. after a disconnect) shows the right state.
// sessionStorage, not localStorage — this choice belongs to the
// current browser tab session, not something that should silently
// carry over after the tab is closed and reopened later.
if (sessionStorage.getItem("useAutomaticData") === "true") {

    document.getElementById("automaticValuesBtn").classList.add("selected");

    loginBtn.disabled = false;

}

// ==========================================
// PASSKEY HASHING
// ==========================================

async function hashPasskey(text) {

    const normalized = text.trim().toUpperCase();

    const encoded = new TextEncoder().encode(normalized);

    const digest = await crypto.subtle.digest("SHA-256", encoded);

    return Array.from(new Uint8Array(digest))
        .map(b => b.toString(16).padStart(2, "0"))
        .join("");

}

// ==========================================
// RENDER LOGIN FORM
// ==========================================

keyPanel.innerHTML = `
    <h3>Enter Your Passkey</h3>
    <div class="field-wrap">
        <span class="field-icon">🔒</span>
        <input type="password" id="passkeyInput" placeholder="Enter your passkey" autocomplete="off">
        <button type="button" class="toggle-pass" id="togglePasskey">👁</button>
    </div>
`;

loginBtn.innerHTML = "LOGIN →";

document.getElementById("togglePasskey").addEventListener("click", () => {

    const input = document.getElementById("passkeyInput");
    const btn = document.getElementById("togglePasskey");

    const isHidden = input.type === "password";

    input.type = isHidden ? "text" : "password";
    btn.textContent = isHidden ? "🙈" : "👁";

});

// ==========================================
// CONNECT BMS — branded pre-prompt, then the
// real (unstylable) browser device picker
// ==========================================

const connectOverlay = document.getElementById("connectOverlay");

function showConnectOverlay() {

    if (!("serial" in navigator)) {

        alert("Please use Google Chrome or Microsoft Edge.");

        return;

    }

    connectOverlay.classList.add("open");

}

function hideConnectOverlay() {

    connectOverlay.classList.remove("open");

}

document.getElementById("cancelConnectBtn").addEventListener("click", hideConnectOverlay);

document.getElementById("proceedConnectBtn").addEventListener("click", () => {

    hideConnectOverlay();

    openSerialPicker();

});

async function openSerialPicker() {

    if (!("serial" in navigator)) {

        alert("Please use Google Chrome or Microsoft Edge.");

        return;

    }

    try {

        // Ask user to select a USB Serial Device
        port = await navigator.serial.requestPort();

        // Open selected COM Port at the chosen rate, and remember it so the
        // dashboard reopens the port exactly the same way.
        const baud = selectedBaudRate();

        localStorage.setItem(BAUD_KEY, String(baud));

        await port.open({

            baudRate: baud

        });

        setUsbStatus(true);

        loginBtn.disabled = false;

        // A real device takes priority over a previously chosen
        // Automatic Values selection.
        sessionStorage.removeItem("useAutomaticData");
        document.getElementById("automaticValuesBtn").classList.remove("selected");

        console.log("Connected:", port.getInfo());

    }

    catch (error) {

        port = null;

        setUsbStatus(false);

        loginBtn.disabled = true;

        console.log(error);

        // Surface WHY it failed instead of only turning the dot red. The most
        // common cause is the port already being open in another program
        // (Docklight, another browser tab) — one program owns a COM port at a
        // time. With a com0com virtual pair, Docklight holds one port and the
        // dashboard must open its PARTNER port, not the same one.
        const name = error && error.name ? error.name : "";
        const msg = (error && error.message ? error.message : "").toLowerCase();

        let hint;

        if (name === "NotFoundError") {

            // The picker was cancelled — not really an error.
            hint = "";

        }

        else if (msg.includes("open") || msg.includes("access") || msg.includes("busy") || name === "InvalidStateError" || name === "NetworkError") {

            hint = "⚠ Could not open that port — it's already in use. Close Docklight on that port, or pick the com0com PARTNER port (not the one Docklight uses).";

        }

        else {

            hint = "⚠ Could not open the port: " + (error && error.message ? error.message : name || "unknown error");

        }

        if (hint) {

            message.style.color = "#dc2626";
            message.innerHTML = hint;

        }

    }

}

// ==========================================
// AUTOMATIC VALUES — no device on hand, proceed
// straight to the dashboard on simulated data
// ==========================================

document.getElementById("automaticValuesBtn").addEventListener("click", () => {

    port = null;

    setUsbStatus(false);

    sessionStorage.setItem("useAutomaticData", "true");

    document.getElementById("automaticValuesBtn").classList.add("selected");

    loginBtn.disabled = false;

});

// ==========================================
// USB Disconnect Detection
// ==========================================

if ("serial" in navigator) {

    navigator.serial.addEventListener("disconnect", () => {

        port = null;

        setUsbStatus(false);

        loginBtn.disabled = true;

        alert("USB Disconnected.\nPlease reconnect.");

    });

}

// ==========================================
// LOGIN
// ==========================================

loginForm.addEventListener("submit", async function (e) {

    e.preventDefault();

    // Either a real device or an explicit Automatic Values choice is required
    if (port == null && sessionStorage.getItem("useAutomaticData") !== "true") {

        alert("Please connect the BMS USB or choose Remote Monitor before continuing.");

        return;

    }

    const name = document.getElementById("ownerName").value.trim();

    if (!name) {

        message.style.color = "#dc2626";
        message.innerHTML = "❌ Please enter your name.";

        return;

    }

    const typed = document.getElementById("passkeyInput").value;

    if (!typed) {

        message.style.color = "#dc2626";
        message.innerHTML = "❌ Please enter the passkey.";

        return;

    }

    const typedHash = await hashPasskey(typed);

    if (typedHash !== MASTER_PASSKEY_HASH) {

        message.style.color = "#dc2626";
        message.innerHTML = "❌ Incorrect passkey.";

        return;

    }

    // Hand the port over cleanly: this page opened it to prove the device
    // is there, but a COM port can only be held by one owner. Leaving it
    // open here means the dashboard's open() fails and it shows no data at
    // all. Closing releases it while keeping the permission, so
    // navigator.serial.getPorts() on the dashboard can reopen it.
    if (port) {

        try { await port.close(); }
        catch (error) { console.log("Could not close port before handoff:", error); }

    }

    // sessionStorage, not localStorage — closing the tab fully should
    // always require logging in again, not silently stay signed in.
    sessionStorage.setItem("loggedIn", "true");

    sessionStorage.setItem("currentUser", JSON.stringify({

        fullname: name

    }));

    // Show the branded splash screen for a moment before opening the dashboard
    document.getElementById("splashOverlay").classList.add("show");

    setTimeout(() => {

        window.location.replace("index.html");

    }, 2200);

});
